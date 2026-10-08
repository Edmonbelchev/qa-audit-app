'use strict';

// Runs inside the rendered page (page.evaluate). Must be self-contained.
async function analyzeRendered({ brand, ignore, width, mobile }) {
  const W = window, D = document;
  const out = { width, fonts: {}, offFonts: [], headingFonts: [], colors: {}, offColors: [], contrast: [], overflow: 0, overflowEls: [], smallTargets: [], upscaled: [], brokenImgs: [], lazyLcpCandidates: [], mouseOnly: [], focus: { tested: 0, invisible: [], weak: [] }, tels: [], loadedFamilies: [], fontFaces: [] };
  const ignored = (e) => ignore.some((s) => { try { return e.closest(s); } catch { return false; } });
  const path = (e) => {
    if (!e || e.nodeType !== 1) return '';
    const parts = [];
    let x = e;
    while (x && x.nodeType === 1 && x !== D.body && parts.length < 8) {
      if (x.id && /^[A-Za-z][\w-]*$/.test(x.id) && D.querySelectorAll('#' + x.id).length === 1) { parts.unshift('#' + x.id); break; }
      let s = x.tagName.toLowerCase();
      const p = x.parentElement;
      if (p) {
        const sib = [...p.children].filter((c) => c.tagName === x.tagName);
        if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(x) + 1})`;
      }
      parts.unshift(s);
      x = p;
    }
    if (x === D.body) parts.unshift('body');
    return parts.join(' > ');
  };
  const short = (e) => e.tagName.toLowerCase() + ([...e.classList].filter((c) => !/^wp-(elements|container)-|^is-layout|^has-(text|link)-color$/.test(c)).slice(0, 3).map((c) => '.' + c).join(''));
  const rgb = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const hex = (o) => [o.r, o.g, o.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const lum = (o) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(o.r) + 0.7152 * f(o.g) + 0.0722 * f(o.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const palette = (brand.colors || []).map((h) => ({ r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), h }));
  const nearest = (o) => { let best = null; for (const p of palette) { const d = Math.hypot(p.r - o.r, p.g - o.g, p.b - o.b); if (!best || d < best.d) best = { h: p.h, d }; } return best; };
  const famOf = (cs) => cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
  const inList = (f, list) => list.some((x) => x.toLowerCase() === f.toLowerCase());
  const visible = (e) => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = W.getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0; };

  try { await D.fonts.ready; } catch {}
  out.loadedFamilies = [...new Set([...D.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')))];
  out.fontFaces = [...new Set([...D.fonts].map((f) => f.family.replace(/["']/g, '')))];

  const bgOf = (el) => {
    let x = el;
    while (x && x.nodeType === 1) {
      const cs = W.getComputedStyle(x);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      for (const c of x.children) {
        if (/^(IMG|VIDEO|PICTURE|CANVAS|IFRAME)$/.test(c.tagName)) { const p = W.getComputedStyle(c).position; if (p === 'absolute' || p === 'fixed') return null; }
      }
      const b = rgb(cs.backgroundColor);
      if (b && b.a >= 0.5) return b;
      x = x.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  // ---- Text nodes: fonts, colours, contrast
  const textEls = [...D.body.querySelectorAll('*')].filter((e) => {
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|TITLE|OPTION)$/.test(e.tagName) || e.closest('svg')) return false;
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)) return false;
    return visible(e) && !ignored(e) && !e.closest('.screen-reader-text,.sr-only,.visually-hidden');
  });
  const offSeen = new Map();
  const contrastSeen = new Map();
  const allowedFonts = [...(brand.headingFonts || []), ...(brand.bodyFonts || [])];
  for (const e of textEls) {
    const cs = W.getComputedStyle(e);
    const fam = famOf(cs);
    const wt = cs.fontWeight;
    out.fonts[fam + ' ' + wt] = (out.fonts[fam + ' ' + wt] || 0) + 1;
    const isHeading = /^H[1-6]$/.test(e.tagName) || !!e.closest('h1,h2,h3,h4,h5,h6');
    const tag = (e.closest('h1,h2,h3,h4,h5,h6') || e).tagName;
    if (allowedFonts.length && !inList(fam, allowedFonts)) {
      const k = fam + '|' + wt + '|' + tag;
      if (!offSeen.has(k)) offSeen.set(k, { fam, wt, tag, heading: isHeading, loaded: out.loadedFamilies.some((f) => f.toLowerCase() === fam.toLowerCase()), sel: path(e), cls: short(e), text: e.textContent.trim().slice(0, 60), count: 0 });
      offSeen.get(k).count++;
    } else if (isHeading && (brand.headingFonts || []).length && (brand.bodyFonts || []).length && /^H[1-3]$/.test(tag) && !inList(fam, brand.headingFonts) && inList(fam, brand.bodyFonts)) {
      const k = fam + '|' + tag;
      if (!offSeen.has('H:' + k)) { offSeen.set('H:' + k, null); out.headingFonts.push({ fam, tag, sel: path(e), text: e.textContent.trim().slice(0, 60) }); }
    }
    const fg = rgb(cs.color);
    if (fg && fg.a > 0.2) {
      const h = hex(fg);
      out.colors[h] = (out.colors[h] || 0) + 1;
      const bg = bgOf(e);
      if (bg) {
        const r = ratio(fg, bg);
        const fs = parseFloat(cs.fontSize);
        const large = fs >= 24 || (fs >= 18.66 && +wt >= 700);
        const need = large ? 3 : 4.5;
        if (r < need) {
          const k = h + '/' + hex(bg);
          if (!contrastSeen.has(k)) contrastSeen.set(k, { fg: h, bg: hex(bg), ratio: +r.toFixed(2), need, fontSize: fs, sel: path(e), cls: short(e), text: e.textContent.trim().slice(0, 50), count: 0 });
          contrastSeen.get(k).count++;
        }
      }
    }
  }
  out.offFonts = [...offSeen.values()].filter(Boolean);
  out.contrast = [...contrastSeen.values()].sort((a, b) => a.ratio - b.ratio).slice(0, 20);

  // ---- Off-palette colours (text + large backgrounds)
  if (palette.length) {
    const bgCount = {};
    for (const e of D.body.querySelectorAll('*')) {
      if (ignored(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width * r.height < 2500) continue;
      const b = rgb(W.getComputedStyle(e).backgroundColor);
      if (b && b.a > 0.5) { const h = hex(b); bgCount[h] = (bgCount[h] || 0) + 1; }
    }
    const seen = {};
    const consider = (h, n, kind) => {
      const o = { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
      const nb = nearest(o);
      if (nb && nb.d <= brand.colorTolerance) return;
      const key = kind + h;
      if (seen[key]) return;
      seen[key] = 1;
      let ex = null;
      if (kind === 'text') { const e = textEls.find((x) => hex(rgb(W.getComputedStyle(x).color) || { r: 0, g: 0, b: 0 }) === h); if (e) ex = { sel: path(e), cls: short(e), text: e.textContent.trim().slice(0, 40), region: (e.closest('header,footer,nav,main,aside') || {}).tagName || '' }; }
      out.offColors.push({ hex: h, kind, count: n, nearest: nb ? nb.h : null, dist: nb ? Math.round(nb.d) : null, ex });
    };
    Object.entries(out.colors).forEach(([h, n]) => consider(h, n, 'text'));
    Object.entries(bgCount).forEach(([h, n]) => consider(h, n, 'background'));
  }

  // ---- Overflow
  const vw = D.documentElement.clientWidth;
  out.overflow = Math.max(0, D.documentElement.scrollWidth - vw);
  if (out.overflow > 0) {
    out.overflowEls = [...D.body.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.right > vw + 1 && r.width > 0 && W.getComputedStyle(e).position !== 'fixed'; })
      .filter((e, i, arr) => !arr.some((p) => p !== e && p.contains(e))).slice(0, 5).map((e) => ({ sel: path(e), cls: short(e), right: Math.round(e.getBoundingClientRect().right) }));
  }

  // ---- Touch targets (mobile only): standalone controls under 24px
  if (mobile) {
    out.smallTargets = [...D.querySelectorAll('a,button,input:not([type=hidden]),select,[role=button]')].filter((e) => {
      if (!visible(e) || ignored(e) || e.closest('p,li p,td') || e.classList.contains('skip-link') || e.closest('.screen-reader-text')) return false;
      const r = e.getBoundingClientRect();
      return r.height < 24 || r.width < 24;
    }).slice(0, 12).map((e) => { const r = e.getBoundingClientRect(); return { sel: path(e), cls: short(e), w: Math.round(r.width), h: Math.round(r.height), label: (e.textContent.trim() || e.getAttribute('aria-label') || '').slice(0, 30) }; });
  }

  // ---- Images
  for (const i of D.querySelectorAll('img')) {
    if (ignored(i)) continue;
    const r = i.getBoundingClientRect();
    if (i.complete && i.naturalWidth === 0 && (i.currentSrc || i.getAttribute('src')) && !/^data:/.test(i.getAttribute('src') || '')) out.brokenImgs.push(i.currentSrc || i.src);
    const dpr = 1;
    if (i.complete && i.naturalWidth > 0 && r.width > 120 && r.width > i.naturalWidth * dpr * 1.15 && !/\.svg(\?|$)/i.test(i.currentSrc)) out.upscaled.push({ src: (i.currentSrc || i.src).split('/').pop().slice(0, 80), natural: i.naturalWidth, rendered: Math.round(r.width), sel: path(i) });
  }
  out.upscaled = out.upscaled.slice(0, 10);
  out.brokenImgs = out.brokenImgs.slice(0, 10);

  // ---- Mouse-only controls: pointer cursor, not focusable, no role
  const focusableTags = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL|OPTION|VIDEO|AUDIO|IFRAME)$/;
  const mo = new Map();
  for (const e of D.body.querySelectorAll('div,span,li,h1,h2,h3,h4,h5,h6,p,img,svg,section,article,figure,i')) {
    if (ignored(e) || !visible(e)) continue;
    const cn = typeof e.className === 'string' ? e.className : '';
    const patterned = /(faq|accordion)[-_]?(question|title|header|heading|toggle|trigger|button|q)\b/i.test(cn);
    if (W.getComputedStyle(e).cursor !== 'pointer' && !patterned) continue;
    if (e.parentElement && W.getComputedStyle(e.parentElement).cursor === 'pointer' && !focusableTags.test(e.parentElement.tagName)) continue; // report outermost only
    if (e.closest('a,button,summary,label,[role=button],[role=tab],[role=link],[role=menuitem],[tabindex]')) continue;
    if (e.querySelector('a,button,[tabindex],[role=button],input,select,summary')) continue;
    if (e.hasAttribute('tabindex') || e.getAttribute('role')) continue;
    const key = short(e);
    if (!mo.has(key)) mo.set(key, { cls: key, sel: path(e), text: e.textContent.trim().slice(0, 60), count: 0 });
    mo.get(key).count++;
  }
  out.mouseOnly = [...mo.values()].slice(0, 10);

  // ---- Focus visibility on a sample of focusables
  const style = (e) => { const s = W.getComputedStyle(e); return [s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 ? s.outlineStyle + s.outlineWidth + s.outlineColor : '', s.boxShadow, s.backgroundColor, s.borderColor, s.textDecorationLine, s.color].join('|'); };
  const focusables = [...D.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])')].filter((e) => visible(e) && !ignored(e));
  const sample = [];
  const sig = new Set();
  for (const e of focusables) { const k = short(e); if (sig.has(k)) continue; sig.add(k); sample.push(e); if (sample.length >= 25) break; }
  for (const e of sample) {
    const before = style(e);
    try { e.focus({ preventScroll: true, focusVisible: true }); } catch { e.focus(); }
    if (D.activeElement !== e) continue;
    out.focus.tested++;
    const s = W.getComputedStyle(e);
    const after = style(e);
    if (before === after) out.focus.invisible.push({ sel: path(e), cls: short(e), text: (e.textContent.trim() || e.getAttribute('aria-label') || '').slice(0, 30) });
    else if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) {
      const oc = rgb(s.outlineColor);
      const pb = bgOf(e.parentElement || e);
      if (oc && pb && oc.a > 0.5 && ratio(oc, pb) < 3 && (s.boxShadow === 'none' || /0px 0px 0px 0px|rgba\(0, 0, 0, 0\)/.test(s.boxShadow))) out.focus.weak.push({ sel: path(e), cls: short(e), outline: hex(oc), bg: hex(pb), ratio: +ratio(oc, pb).toFixed(2), text: (e.textContent.trim() || '').slice(0, 30) });
    }
    e.blur();
  }
  out.focus.invisible = out.focus.invisible.slice(0, 10);
  out.focus.weak = out.focus.weak.slice(0, 10);

  // ---- Phone links after scripts ran (e.g. call-tracking swaps)
  const phoneRe = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  out.tels = [...D.querySelectorAll('a[href^="tel:" i]')].map((a) => { const m = a.textContent.match(phoneRe); return { hrefDigits: a.getAttribute('href').replace(/\D/g, '').slice(-10), textDigits: m ? m[0].replace(/\D/g, '').slice(-10) : null, text: a.textContent.trim().slice(0, 40), visible: visible(a), sel: path(a) }; });

  return out;
}

// Mobile navigation test (runs in page). Returns the toggle selector so Playwright can click it for real.
function findMenuToggle() {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const cands = [...document.querySelectorAll('button,[role=button],a')].filter(vis).filter((b) => {
    const s = ((b.getAttribute('aria-label') || '') + ' ' + b.className + ' ' + b.id + ' ' + b.textContent).toLowerCase();
    return b.hasAttribute('aria-controls') && /menu|nav/.test(s) || /menu-toggle|nav-toggle|hamburger|burger|navbar-toggler|mobile-menu|menu-button|toggle menu|open menu/.test(s);
  });
  const b = cands[0];
  if (!b) return null;
  b.setAttribute('data-qa-menu', '1');
  const links = [...document.querySelectorAll('nav a, [role=navigation] a, header a')].filter(vis).length;
  const r = b.getBoundingClientRect();
  return { label: b.getAttribute('aria-label') || b.textContent.trim().slice(0, 30), expanded: b.getAttribute('aria-expanded'), controls: b.getAttribute('aria-controls'), tag: b.tagName, links, w: Math.round(r.width), h: Math.round(r.height) };
}
function menuState() {
  const b = document.querySelector('[data-qa-menu]');
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0; };
  const ctl = b && b.getAttribute('aria-controls') ? document.getElementById(b.getAttribute('aria-controls')) : null;
  return { expanded: b ? b.getAttribute('aria-expanded') : null, links: [...document.querySelectorAll('nav a, [role=navigation] a, header a')].filter(vis).length, controlsVisible: ctl ? vis(ctl) && ctl.getBoundingClientRect().height > 20 : null };
}

module.exports = { analyzeRendered, findMenuToggle, menuState };
