'use strict';
// "Load from WordPress": reads brand rules (colours, heading/body fonts, phone numbers) from a WordPress
// site over its REST API, authenticated with an Application Password. Credentials are used for these
// requests only and never stored.
//
// Sources, best first:
//  1. devrix-qa/v1/profile — theme endpoint (american-restoration: Theme Global Settings in ACF).
//  2. Core REST: active theme + global styles (theme.json palette, font families, body/heading fonts).
//  3. Public homepage HTML: tel: links (always, as suggestions).
const { request } = require('./http');

const UA = 'DevriX-QA-Audit/1.0 (+profile import)';
const hex6 = (c) => {
  if (typeof c !== 'string') return null;
  let m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map((x) => x + x).join(''); return '#' + h.slice(0, 6).toUpperCase(); }
  m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  return m ? '#' + [m[1], m[2], m[3]].map((v) => Math.min(255, +v).toString(16).padStart(2, '0')).join('').toUpperCase() : null;
};
const firstFamily = (stack) => String(stack || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
const digits = (v) => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length >= 7 ? d : ''; };
const fmt = (d) => (d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d);

class WpError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }

async function getJSON(url, auth, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA, ...(auth ? { authorization: auth } : {}) }, signal: ctrl.signal, redirect: 'follow' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, url: r.url };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

async function findApiRoot(site) {
  // Pretty permalinks first, then the ?rest_route= fallback.
  for (const root of [site + '/wp-json/', site + '/?rest_route=/']) {
    const r = await getJSON(root);
    if (r.status === 200 && r.json && Array.isArray(r.json.namespaces)) {
      const base = root.endsWith('?rest_route=/') ? (p) => site + '/?rest_route=/' + p.replace(/\?/, '&') : (p) => site + '/wp-json/' + p;
      return { info: r.json, api: base };
    }
  }
  return null;
}

function resolveFontRef(v, families) {
  if (!v) return null;
  const m = String(v).match(/var(?::preset\|font-family\||\(--wp--preset--font-family--)([\w-]+)/);
  if (m) { const f = families.find((x) => x.slug === m[1]); return f ? firstFamily(f.fontFamily) : m[1]; }
  return firstFamily(v);
}

async function fromCore(api, auth, notes) {
  const out = { colors: [], fonts: {}, theme: null };
  const th = await getJSON(api('wp/v2/themes?status=active&context=edit'), auth);
  if (th.status !== 200 || !Array.isArray(th.json) || !th.json[0]) { notes.push('Could not read the active theme (needs the “Edit theme options” capability).'); return out; }
  const theme = th.json[0];
  out.theme = theme.stylesheet;
  const gs = await getJSON(api(`wp/v2/global-styles/themes/${encodeURIComponent(theme.stylesheet)}?context=edit`), auth);
  const data = gs.status === 200 && gs.json ? gs.json : {};
  const settings = data.settings || {};
  const pal = (settings.color && settings.color.palette) || {};
  const palette = Array.isArray(pal) ? pal : [...(pal.theme || []), ...(pal.custom || [])];
  out.colors = palette.map((p) => ({ slug: p.slug, name: p.name, color: hex6(p.color) })).filter((p) => p.color);
  const ff = (settings.typography && settings.typography.fontFamilies) || {};
  const families = Array.isArray(ff) ? ff : [...(ff.theme || []), ...(ff.custom || [])];
  let styles = data.styles || {};
  // User customisations from the Site Editor override theme.json.
  const userLink = theme._links && theme._links['wp:user-global-styles'] && theme._links['wp:user-global-styles'][0];
  if (userLink && userLink.href) {
    const us = await getJSON(userLink.href + (userLink.href.includes('?') ? '&' : '?') + 'context=edit', auth);
    if (us.status === 200 && us.json && us.json.styles) styles = deepMerge(styles, us.json.styles);
  }
  const body = resolveFontRef(styles.typography && styles.typography.fontFamily, families);
  const heading = resolveFontRef((styles.elements && ((styles.elements.heading && styles.elements.heading.typography) || (styles.elements.h1 && styles.elements.h1.typography)) || {}).fontFamily, families);
  if (heading) out.fonts.headings = { family: heading };
  if (body) out.fonts.body = { family: body };
  if (!heading && !body && families.length) notes.push(`theme.json defines ${families.length} font families but doesn’t say which is for headings and body. Pick them below.`);
  out.families = families.map((f) => firstFamily(f.fontFamily));
  return out;
}

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const o = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) o[k] = deepMerge(o[k], v);
  return o;
}

async function phonesOnHomepage(site, cfg) {
  const r = await request(site + '/', cfg);
  const counts = new Map();
  for (const m of (r.text || '').matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) { const d = digits(m[1]); if (d) counts.set(d, (counts.get(d) || 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([d, n]) => ({ digits: d, label: fmt(d), where: [`Homepage (${n} link${n > 1 ? 's' : ''})`] }));
}

async function loadProfile({ siteUrl, username, appPassword }) {
  let site;
  try { const u = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : 'https://' + siteUrl); site = u.origin + u.pathname.replace(/\/+$/, ''); } catch { throw new WpError('Enter the WordPress site URL, e.g. https://example.com'); }
  if (!username || !appPassword) throw new WpError('Enter the WordPress username and an application password.');
  const notes = [];
  const root = await findApiRoot(site);
  if (!root) throw new WpError(`Couldn’t reach the WordPress REST API at ${site}/wp-json/. Check the URL, and that a security plugin isn’t blocking the API.`, 502);
  const auth = 'Basic ' + Buffer.from(`${username}:${String(appPassword).replace(/\s+/g, '')}`).toString('base64');
  const me = await getJSON(root.api('wp/v2/users/me?context=edit'), auth);
  if (me.status === 401 || me.status === 403) throw new WpError('WordPress rejected the username or application password. Create one under Users → Profile → Application Passwords, and use the username (not the email) it belongs to.', 401);
  if (me.status !== 200) throw new WpError(`WordPress answered ${me.status || me.error} when checking the login.`, 502);

  const profile = { site: { name: root.info.name || '', url: root.info.home || root.info.url || site }, user: me.json && (me.json.name || me.json.slug), source: '', colors: [], palette: [], fonts: {}, phones: [], families: [], notes };
  const homepagePhones = phonesOnHomepage(profile.site.url.replace(/\/$/, ''), { userAgent: UA, timeoutMs: 20000 }).catch(() => []);

  if (root.info.namespaces.includes('devrix-qa/v1')) {
    const r = await getJSON(root.api('devrix-qa/v1/profile'), auth);
    if (r.status === 200 && r.json) {
      const p = r.json;
      profile.source = p.source || 'devrix-qa/v1/profile';
      profile.colors = (p.colors || []).map((c) => ({ ...c, color: hex6(c.color) })).filter((c) => c.color);
      profile.palette = (p.palette || []).map((c) => ({ ...c, color: hex6(c.color) })).filter((c) => c.color);
      profile.fonts = p.fonts || {};
      profile.phones = (p.phones || []).map((x) => ({ digits: digits(x.digits || x.label), label: x.label || fmt(digits(x.digits)), where: x.where || [] })).filter((x) => x.digits);
      if (p.site && p.site.name) profile.site.name = p.site.name;
    } else notes.push(`The theme profile endpoint answered ${r.status}. Falling back to theme.json.`);
  }
  if (!profile.source || !profile.colors.length) {
    const core = await fromCore(root.api, auth, notes);
    if (!profile.source) profile.source = `theme.json${core.theme ? ` (${core.theme})` : ''}`;
    if (!profile.colors.length) profile.colors = core.colors;
    if (!profile.fonts.headings && core.fonts.headings) profile.fonts.headings = core.fonts.headings;
    if (!profile.fonts.body && core.fonts.body) profile.fonts.body = core.fonts.body;
    profile.families = core.families || [];
  }
  if (!profile.phones.length) notes.push('No phone numbers are set in the theme options. Numbers found on the homepage are listed as suggestions.');
  profile.suggestedPhones = (await homepagePhones).filter((h) => !profile.phones.some((p) => p.digits === h.digits));

  // Values ready for the audit form
  const allColors = [...profile.colors, ...profile.palette].map((c) => c.color);
  profile.form = {
    siteName: profile.site.name,
    url: profile.site.url,
    brand: {
      headingFonts: profile.fonts.headings ? profile.fonts.headings.family : '',
      bodyFonts: profile.fonts.body ? profile.fonts.body.family : '',
      colors: [...new Set(allColors)].join(', '),
    },
    phones: { expected: profile.phones.map((p) => fmt(p.digits)).join('\n') },
  };
  return profile;
}

module.exports = { loadProfile, WpError, hex6, resolveFontRef };
