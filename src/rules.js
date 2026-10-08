'use strict';
// Rules engine: turns raw crawl/render/perf data into grouped, severity-ranked issues.
// Text fields use `backticks` for code; the report escapes HTML and renders backticks as <code>.

const { groupOf } = require('./discover');

const path = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
const fmtPhone = (d) => (d && d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d || '');
const list = (arr, n = 6) => arr.slice(0, n).join(', ') + (arr.length > n ? ` and ${arr.length - n} more` : '');
const plist = (urls, n = 6) => list([...new Set(urls)].map(path), n);

function run(ctx) {
  const { cfg, disc, pages, homeHeaders, links, legacy, render, menu, perf } = ctx;
  const issues = [];
  const passes = [];
  const add = (o) => issues.push(Object.assign({ confidence: 'HIGH', affects: [], evidence: null, design: false }, o));
  const P = Object.values(pages);
  const ok = P.filter((p) => p.status === 200 && p.title !== undefined);
  const R = Object.entries(render || {});
  const isPost = (u) => /\/(blog|news|articles?)\/[^/]+\/?$/.test(path(u)) && !/\/(category|tag|page)\//.test(path(u));
  const prod = cfg.environment === 'production';
  const brandFonts = [...cfg.brand.headingFonts, ...cfg.brand.bodyFonts];
  const designRef = cfg.brand.designUrl || null;

  // ───────────── Crawl health
  const bad = P.filter((p) => p.status !== 200 || p.error);
  const redirected = P.filter((p) => p.status === 200 && (p.hops || []).length);
  if (bad.length) add({ key: 'sitemap-errors', sev: bad.some((p) => p.status >= 500 || p.status === 0) ? 'P1' : 'P2', cat: 'SEO', title: `${plural(bad.length, 'URL')} listed in the sitemap ${bad.length === 1 ? 'does' : 'do'} not return 200`, affects: bad.map((p) => p.url), expected: 'Every URL in the XML sitemap returns 200 directly.', actual: bad.slice(0, 8).map((p) => `${path(p.url)} → ${p.status || p.error}`).join('; '), fix: 'Fix or remove these URLs, then regenerate the sitemap so it only lists live, canonical pages.' });
  else passes.push(`All ${P.length} sitemap URLs return 200.`);
  if (redirected.length) add({ key: 'sitemap-redirects', sev: 'P3', cat: 'SEO', title: `${plural(redirected.length, 'sitemap URL')} redirect${redirected.length === 1 ? 's' : ''} instead of returning 200`, affects: redirected.map((p) => p.url), expected: 'Sitemaps list final URLs only.', actual: redirected.slice(0, 6).map((p) => `${path(p.url)} → ${path(p.finalUrl)} (${p.hops.map((h) => h.status).join(', ')})`).join('; '), fix: 'Update internal references and regenerate the sitemap with the destination URLs.' });

  const empty = ok.filter((p) => p.mainTextLen < 200 && !/\/(category|tag|page)\//.test(p.url));
  if (empty.length) add({ key: 'empty-pages', sev: 'P1', cat: 'Content', title: `${plural(empty.length, 'page')} ${empty.length === 1 ? 'has' : 'have'} almost no content`, affects: empty.map((p) => p.url), expected: 'Every published page has a heading and real body content.', actual: empty.slice(0, 8).map((p) => `${path(p.url)} (${p.mainTextLen} characters of text)`).join('; '), fix: 'Add the missing content, or unpublish the page and remove it from menus and the sitemap.' });
  const placeholder = ok.filter((p) => p.placeholder || p.defaultContent);
  if (placeholder.length) add({ key: 'placeholder', sev: 'P1', cat: 'Content', title: `Placeholder or default WordPress content is live on ${plural(placeholder.length, 'page')}`, affects: placeholder.map((p) => p.url), expected: 'No lorem ipsum, “Hello world!” or “Sample Page” content on the live site.', actual: placeholder.slice(0, 6).map((p) => `${path(p.url)}: “${p.placeholder || p.title}”`).join('; '), fix: 'Replace or delete the placeholder content.' });

  // ───────────── Phone numbers
  const telMismatch = new Map();
  for (const p of ok) for (const t of p.tels || []) if (t.textDigits && t.hrefDigits && t.textDigits !== t.hrefDigits) {
    const k = t.hrefDigits + '|' + t.textDigits;
    if (!telMismatch.has(k)) telMismatch.set(k, { href: t.hrefDigits, text: t.textDigits, pages: [], sel: t.sel });
    telMismatch.get(k).pages.push(p.url);
  }
  // rendered (after call-tracking scripts): link text swapped but href not
  for (const [u, r] of R) for (const t of ((r.desktop || {}).analysis || {}).tels || []) if (t.textDigits && t.hrefDigits && t.textDigits !== t.hrefDigits) {
    const staticSame = (pages[u].tels || []).some((s) => s.hrefDigits === t.hrefDigits && s.textDigits === t.hrefDigits);
    if (staticSame) continue; // call-tracking swapped the text of a link whose href it also manages
    const k = t.hrefDigits + '|' + t.textDigits;
    if ([...telMismatch.values()].some((m) => m.href === t.hrefDigits && m.pages.includes(u))) { const m = [...telMismatch.values()].find((m) => m.href === t.hrefDigits && m.pages.includes(u)); m.evidence = { url: u, sel: t.sel, viewport: 'desktop' }; m.renderedText = t.textDigits; continue; }
    if (!telMismatch.has(k)) telMismatch.set(k, { href: t.hrefDigits, text: t.textDigits, pages: [], sel: t.sel, evidence: { url: u, sel: t.sel, viewport: 'desktop' } });
    if (!telMismatch.get(k).pages.includes(u)) telMismatch.get(k).pages.push(u);
  }
  if (telMismatch.size) {
    const ms = [...telMismatch.values()];
    add({ key: 'tel-mismatch', sev: 'P1', cat: 'Content', title: `${plural(ms.length, 'phone link')} dial${ms.length === 1 ? 's' : ''} a different number than ${ms.length === 1 ? 'it shows' : 'they show'}`, affects: ms.flatMap((m) => m.pages),
      expected: 'Each phone link dials the number printed on it.',
      actual: ms.slice(0, 6).map((m) => `“${fmtPhone(m.text)}”${m.renderedText && m.renderedText !== m.text ? ` (shown as ${fmtPhone(m.renderedText)} after scripts)` : ''} links to \`tel:${m.href}\` on ${plist(m.pages, 3)}`).join('; '),
      fix: 'Correct the `href` of these links to match the displayed number. If a call-tracking script swaps numbers, link to the base number it is configured to replace.', evidence: ms.find((m) => m.evidence)?.evidence || { url: ms[0].pages[0], sel: ms[0].sel, viewport: 'desktop' } });
  }
  const emptyTel = [];
  for (const p of ok) for (const t of p.tels || []) if (t.empty) emptyTel.push({ u: p.url, d: t.hrefDigits });
  if (emptyTel.length) add({ key: 'tel-empty', sev: 'P3', cat: 'Content', title: `${plural(emptyTel.length, 'empty phone link')} with no visible text`, affects: emptyTel.map((x) => x.u), expected: 'No empty `<a href="tel:…">` elements.', actual: `${[...new Set(emptyTel.map((x) => fmtPhone(x.d)))].slice(0, 5).join(', ')} on ${plist(emptyTel.map((x) => x.u), 4)}. Screen readers announce them as unnamed links.`, fix: 'Delete the empty links. They are usually left behind when a block is edited.' });

  const telPages = new Map(); // digits -> Set(pages)
  for (const p of ok) for (const t of p.tels || []) { if (!t.hrefDigits) continue; if (!telPages.has(t.hrefDigits)) telPages.set(t.hrefDigits, new Set()); telPages.get(t.hrefDigits).add(p.url); }
  for (const p of ok) for (const d of p.printedPhones || []) { if (!telPages.has(d)) telPages.set(d, new Set()); telPages.get(d).add(p.url); }
  if (cfg.phones.expected.length) {
    const unexpected = [...telPages].filter(([d]) => !cfg.phones.expected.some((e) => e.endsWith(d) || d.endsWith(e)));
    if (unexpected.length) {
      const onMain = unexpected.some(([, s]) => [...s].some((u) => !isPost(u)));
      const ev = (() => { for (const [d, s] of unexpected) for (const u of s) { const t = (pages[u].tels || []).find((t) => t.hrefDigits === d && !t.empty); if (t) return { url: u, sel: t.sel, viewport: 'desktop' }; } return null; })();
      add({ key: 'tel-unexpected', sev: onMain ? 'P1' : 'P2', cat: 'Content', title: `${plural(unexpected.length, 'phone number')} on the site ${unexpected.length === 1 ? "isn't" : "aren't"} in the approved list`, affects: unexpected.flatMap(([, s]) => [...s]),
        expected: `Only these numbers appear: ${cfg.phones.expected.map(fmtPhone).join(', ')}.`,
        actual: unexpected.slice(0, 8).map(([d, s]) => `${fmtPhone(d)} on ${plist([...s], 3)}`).join('; ') + '. Checked in the server HTML, before any call-tracking script swaps numbers.',
        fix: 'Confirm with the client which number each location should show, then correct these. Leave tracking to the call-tracking script.', evidence: ev });
    } else passes.push(`Every phone number in the HTML is on the approved list (${cfg.phones.expected.map(fmtPhone).join(', ')}).`);
  } else if (telPages.size) {
    const rows = [...telPages].sort((a, b) => b[1].size - a[1].size);
    const top = rows[0][1].size;
    const rare = rows.filter(([, s]) => s.size <= 2 && top >= 10);
    add({ key: 'tel-inventory', sev: rare.length ? 'P2' : 'INFO', cat: 'Content', title: rare.length ? `${plural(rare.length, 'phone number')} ${rare.length === 1 ? 'appears' : 'appear'} on only one or two pages` : `The site uses ${plural(rows.length, 'phone number')}`, affects: rare.flatMap(([, s]) => [...s]),
      expected: 'Contact numbers are consistent across pages. Add the approved numbers to the audit profile to check them strictly.',
      actual: rows.slice(0, 10).map(([d, s]) => `${fmtPhone(d)}: ${plural(s.size, 'page')}${s.size <= 2 ? ` (${plist([...s], 2)})` : ''}`).join('; '),
      fix: rare.length ? 'Check that the rarely used numbers are intentional (location or tracking numbers). Fix any that were copied from another site.' : 'No action needed unless a number is unexpected.' });
  }

  // ───────────── Links
  const broken = Object.values(links.internal).filter((l) => l.status >= 400 || l.status === 0);
  if (broken.length) {
    const srcs = [...new Set(broken.flatMap((l) => l.sources))];
    const wide = srcs.includes(cfg.url) || srcs.length >= Math.max(10, ok.length * 0.5);
    add({ key: 'broken-internal', sev: wide ? 'P1' : 'P2', cat: 'Content', title: `${plural(srcs.length, 'page')} link to ${plural(broken.length, 'internal URL')} that ${broken.length === 1 ? 'returns' : 'return'} an error`, affects: srcs,
      expected: 'Internal links resolve with 200, or one 301 to the current page.',
      actual: broken.sort((a, b) => b.sources.length - a.sources.length).slice(0, 10).map((l) => `${path(l.url)} → ${l.status || l.error} (linked from ${plural(l.sources.length, 'page')})`).join('; '),
      fix: 'Add 301 redirects from each dead URL to its current equivalent, then update the links in content.' });
  } else passes.push(`All ${Object.keys(links.internal).length + ok.length} internal link targets resolve (no 404s).`);
  const chains = Object.values(links.internal).filter((l) => (l.hops || []).length > 1 || (l.hops || []).some((h) => h.status === 302 || h.status === 307));
  if (chains.length) add({ key: 'redirect-chains', sev: 'P3', cat: 'SEO', title: `${plural(chains.length, 'internal link')} go through redirect chains or temporary redirects`, affects: chains.flatMap((l) => l.sources), expected: 'One permanent (301) hop at most.', actual: chains.slice(0, 6).map((l) => `${path(l.url)}: ${l.hops.map((h) => h.status).join(' → ')} → ${path(l.finalUrl)}`).join('; '), fix: 'Point links straight at the final URL and make redirects permanent.' });
  const extBroken = Object.values(links.external || {}).filter((l) => l.status === 404 || l.status === 410 || (l.status === 0 && l.error && !/timeout/.test(l.error)));
  if (extBroken.length) add({ key: 'broken-external', sev: 'P3', cat: 'Content', title: `${plural(extBroken.length, 'external link')} point to missing pages`, affects: extBroken.flatMap((l) => l.sources), expected: 'Outbound links resolve.', actual: extBroken.slice(0, 8).map((l) => `${l.url} → ${l.status || l.error}`).join('; '), fix: 'Update or remove these links.', confidence: 'MEDIUM' });
  const badHref = ok.filter((p) => (p.badHrefs || []).length);
  if (badHref.length) add({ key: 'bad-href', sev: 'P3', cat: 'Functional', title: `Links without a real destination on ${plural(badHref.length, 'page')}`, affects: badHref.map((p) => p.url), expected: 'Links have an `href`. Controls that run script are `<button>` elements.', actual: badHref.slice(0, 5).map((p) => `${path(p.url)}: ${p.badHrefs.slice(0, 2).map((b) => `“${b.text || '(no text)'}” href=${b.href === null ? 'none' : b.href}`).join(', ')}`).join('; '), fix: 'Give each link its destination, or change script-driven controls to buttons.', confidence: 'MEDIUM' });
  for (const l of legacy || []) if (!l.ok) add({ key: 'legacy-' + l.from, sev: l.status >= 400 ? 'P1' : 'P2', cat: 'SEO', title: `Legacy URL ${path(l.from)} doesn't redirect as configured`, affects: [l.from], expected: `301 → ${l.expected ? path(l.expected) : 'a live page'} in one hop.`, actual: `First response ${l.first}, ${plural(l.hops, 'hop')}, ends at ${path(l.final)} (${l.status}).`, fix: 'Add or correct the 301 redirect.' });
  if ((legacy || []).length && legacy.every((l) => l.ok)) passes.push(`All ${legacy.length} configured legacy URLs 301 to the right pages.`);

  // ───────────── Design: fonts & colours
  const rendered = R.filter(([, r]) => r.desktop && r.desktop.analysis);
  if (brandFonts.length && rendered.length) {
    const fontAgg = new Map();
    const loadedAll = new Set();
    const facesAll = new Set();
    for (const [u, r] of rendered) for (const vp of ['desktop', 'mobile']) {
      const a = (r[vp] || {}).analysis; if (!a) continue;
      a.loadedFamilies.forEach((f) => loadedAll.add(f)); a.fontFaces.forEach((f) => facesAll.add(f));
      for (const f of a.offFonts) {
        const k = f.fam + '|' + (f.heading ? 'h' : 'b');
        if (!fontAgg.has(k)) fontAgg.set(k, { fam: f.fam, heading: f.heading, loaded: f.loaded, pages: new Set(), tags: new Set(), weights: new Set(), ex: { url: u, sel: f.sel, viewport: vp, text: f.text } });
        const g = fontAgg.get(k); g.pages.add(u); g.tags.add(f.tag); g.weights.add(f.wt); if (f.loaded) g.loaded = true;
      }
    }
    const heads = [...fontAgg.values()].filter((g) => g.heading);
    const bodies = [...fontAgg.values()].filter((g) => !g.heading);
    const notLoadedHead = heads.filter((g) => !g.loaded && !/^(serif|sans-serif|system-ui|-apple-system|monospace)$/i.test(g.fam));
    if (heads.length) {
      const pagesH = [...new Set(heads.flatMap((g) => [...g.pages]))];
      add({ key: 'font-headings', sev: notLoadedHead.length ? 'P1' : 'P2', cat: 'Design', design: true, title: notLoadedHead.length ? `Headings on ${plural(pagesH.length, 'page')} use ${list(notLoadedHead.map((g) => g.fam), 3)}, which never loads, so a system font shows instead` : `Headings on ${plural(pagesH.length, 'page')} use off-brand fonts`, affects: pagesH,
        expected: `Headings use ${list(cfg.brand.headingFonts.length ? cfg.brand.headingFonts : brandFonts)}.`,
        actual: heads.map((g) => `${g.fam} ${[...g.weights].join('/')} on ${[...g.tags].join(', ')} (${plural(g.pages.size, 'page')}${g.loaded ? '' : ', not loaded'})`).join('; '),
        fix: 'Remove the font-family override (`has-…-font-family` class, inline style or pattern setting) from these heading blocks so they inherit the brand heading font. Fix the shared pattern first.', evidence: heads[0].ex });
    }
    if (bodies.length) {
      const pagesB = [...new Set(bodies.flatMap((g) => [...g.pages]))];
      const extraFaces = [...facesAll].filter((f) => !brandFonts.some((b) => b.toLowerCase() === f.toLowerCase()) && !/icon|awesome|dashicons|swiper|slick|star|ti-|trustindex|eicons/i.test(f));
      add({ key: 'font-body', sev: 'P2', cat: 'Design', design: true, title: `Body text, labels or buttons on ${plural(pagesB.length, 'page')} use ${list(bodies.map((g) => g.fam), 4)}`, affects: pagesB,
        expected: `Text uses ${list(cfg.brand.bodyFonts.length ? cfg.brand.bodyFonts : brandFonts)}.`,
        actual: bodies.map((g) => `${g.fam} ${[...g.weights].join('/')} on ${[...g.tags].join(', ')} (${plural(g.pages.size, 'page')}${g.loaded ? '' : ', not loaded'})`).join('; ') + (extraFaces.length ? `. The site also registers ${list(extraFaces, 5)}.` : ''),
        fix: 'Remove the off-brand font classes and inline styles so the text inherits the brand font. Limit `theme.json` font families to the brand fonts so editors can’t pick others.', evidence: bodies[0].ex });
    }
    if (!heads.length && !bodies.length) passes.push(`All visible text on ${plural(rendered.length, 'rendered page')} uses the brand fonts (${brandFonts.join(', ')}).`);
    const hb = new Map();
    for (const [u, r] of rendered) for (const h of r.desktop.analysis.headingFonts || []) { const k = h.fam + h.tag; if (!hb.has(k)) hb.set(k, { ...h, pages: new Set(), ex: { url: u, sel: h.sel, viewport: 'desktop' } }); hb.get(k).pages.add(u); }
    if (hb.size) { const v = [...hb.values()]; add({ key: 'font-heading-body', sev: 'P3', cat: 'Design', design: true, title: 'Some headings use the body font instead of the heading font', affects: v.flatMap((x) => [...x.pages]), expected: `H1–H3 use ${cfg.brand.headingFonts.join(', ')}.`, actual: v.map((x) => `${x.tag} in ${x.fam} on ${plural(x.pages.size, 'page')} (e.g. “${x.text}”)`).join('; '), fix: 'Switch these to the heading font, or change the tag if they are not real headings. Confirm with design.', confidence: 'MEDIUM', evidence: v[0].ex }); }
  }
  if (cfg.brand.colors.length && rendered.length) {
    const cAgg = new Map();
    for (const [u, r] of rendered) for (const c of r.desktop.analysis.offColors || []) { if (c.count < 2 && c.kind === 'text') continue; const k = c.kind + c.hex; if (!cAgg.has(k)) cAgg.set(k, { ...c, pages: new Set(), total: 0 }); const g = cAgg.get(k); g.pages.add(u); g.total += c.count; if (!g.ex && c.ex) g.ex = c.ex; }
    const cs = [...cAgg.values()].filter((g) => g.pages.size >= 1).sort((a, b) => b.total - a.total);
    if (cs.length) add({ key: 'colors', sev: 'P3', cat: 'Design', design: true, title: `${plural(cs.length, 'colour')} on the site ${cs.length === 1 ? "isn't" : "aren't"} in the brand palette`, affects: cs.flatMap((g) => [...g.pages]),
      expected: `Palette: ${cfg.brand.colors.map((h) => '#' + h).join(', ')} (tolerance ${cfg.brand.colorTolerance}).`,
      actual: cs.slice(0, 8).map((g) => `#${g.hex} ${g.kind} on ${plural(g.pages.size, 'page')}${g.ex ? ` (e.g. ${g.ex.region ? g.ex.region.toLowerCase() + ' ' : ''}“${g.ex.text}”)` : ''}, nearest brand #${g.nearest}`).join('; '),
      fix: 'Map these to the nearest palette tokens in `theme.json`, or ask design to add them to the palette if they are intentional.', evidence: cs[0].ex ? { url: [...cs[0].pages][0], sel: cs[0].ex.sel, viewport: 'desktop' } : null });
    else passes.push('Every text and section colour matches the brand palette.');
  }

  // ───────────── Accessibility
  const cAgg = new Map();
  for (const [u, r] of rendered) for (const vp of ['desktop', 'mobile']) for (const c of ((r[vp] || {}).analysis || {}).contrast || []) { const k = c.fg + c.bg; if (!cAgg.has(k)) cAgg.set(k, { ...c, pages: new Set(), ex: { url: u, sel: c.sel, viewport: vp } }); cAgg.get(k).pages.add(u); }
  const con = [...cAgg.values()].sort((a, b) => a.ratio - b.ratio);
  if (con.length) add({ key: 'contrast', sev: con.some((c) => c.ratio < 3) ? 'P2' : 'P3', cat: 'Accessibility', title: `Text contrast is below WCAG AA for ${plural(con.length, 'colour pair')}`, affects: con.flatMap((c) => [...c.pages]), expected: 'WCAG 1.4.3: at least 4.5:1 for normal text and 3:1 for large text.', actual: con.slice(0, 6).map((c) => `#${c.fg} on #${c.bg} = ${c.ratio}:1 (needs ${c.need}:1; “${c.text}”, ${plural(c.pages.size, 'page')})`).join('; ') + '. Text over images was skipped.', fix: 'Darken the text or lighten the background until each pair passes. If a palette colour fails, report it to design.', evidence: con[0].ex });
  else if (rendered.length) passes.push('No text contrast failures on solid backgrounds.');
  const mo = new Map();
  for (const [u, r] of rendered) for (const m of r.desktop.analysis.mouseOnly || []) { if (!mo.has(m.cls)) mo.set(m.cls, { ...m, pages: new Set(), n: 0, ex: { url: u, sel: m.sel, viewport: 'desktop' } }); const g = mo.get(m.cls); g.pages.add(u); g.n += m.count; }
  if (mo.size) { const v = [...mo.values()].sort((a, b) => b.n - a.n); add({ key: 'mouse-only', sev: 'P2', cat: 'Accessibility', title: `${plural(v.reduce((a, b) => a + b.n, 0), 'clickable element')} can't be reached with a keyboard`, affects: v.flatMap((x) => [...x.pages]), expected: 'WCAG 2.1.1 and 4.1.2: interactive controls are focusable buttons or links with a role and state (e.g. `aria-expanded`).', actual: v.slice(0, 5).map((x) => `\`${x.cls}\` ×${x.n} on ${plural(x.pages.size, 'page')} (e.g. “${x.text}”)`).join('; ') + '. These have a pointer cursor or accordion class but no button, link, tabindex or role.', fix: 'Use a `<button aria-expanded aria-controls>` (or `<details>/<summary>`) for each toggle and handle Enter and Space. Fix it once in the shared pattern.', evidence: v[0].ex }); }
  const fi = new Map(), fw = new Map();
  for (const [u, r] of rendered) { const f = r.desktop.analysis.focus; for (const x of f.invisible) if (!fi.has(x.cls)) fi.set(x.cls, { ...x, u }); for (const x of f.weak) if (!fw.has(x.cls)) fw.set(x.cls, { ...x, u }); }
  if (fi.size) add({ key: 'focus-invisible', sev: 'P2', cat: 'Accessibility', title: `${plural(fi.size, 'type')} of control show no visible focus state`, affects: [...fi.values()].map((x) => x.u), expected: 'WCAG 2.4.7: keyboard focus is always visible.', actual: [...fi.values()].slice(0, 6).map((x) => `\`${x.cls}\` (“${x.text}”)`).join('; ') + '. Nothing about the element changes when it receives focus.', fix: 'Add a `:focus-visible` outline (2px, at least 3:1 against the background) to these components.', evidence: { url: [...fi.values()][0].u, sel: [...fi.values()][0].sel, viewport: 'desktop' } });
  else if (rendered.length) passes.push('Every sampled link and button shows a visible focus state.');
  if (fw.size) add({ key: 'focus-weak', sev: 'P3', cat: 'Accessibility', title: 'The focus ring is hard to see on some controls', affects: [...fw.values()].map((x) => x.u), expected: 'Focus indicators reach 3:1 against the surrounding background (WCAG 1.4.11).', actual: [...fw.values()].slice(0, 5).map((x) => `\`${x.cls}\`: #${x.outline} ring on #${x.bg} = ${x.ratio}:1`).join('; '), fix: 'Use a darker focus colour (or add an offset ring) for these components.', confidence: 'MEDIUM' });
  const noAlt = ok.filter((p) => (p.imgNoAlt || []).length);
  if (noAlt.length) add({ key: 'img-alt', sev: 'P2', cat: 'Accessibility', title: `Images without an alt attribute on ${plural(noAlt.length, 'page')}`, affects: noAlt.map((p) => p.url), expected: 'WCAG 1.1.1: every `<img>` has alt text, or `alt=""` if it is decorative.', actual: `${noAlt.reduce((a, p) => a + p.imgNoAlt.length, 0)} images, e.g. ${noAlt.slice(0, 4).map((p) => `${p.imgNoAlt[0]} on ${path(p.url)}`).join('; ')}`, fix: 'Add alt text in the media library or block settings. Use `alt=""` for decorative images.' });
  else passes.push('Every image has an alt attribute.');
  const emptyL = ok.filter((p) => (p.emptyLinks || []).length || (p.buttonsNoName || []).length);
  if (emptyL.length) add({ key: 'empty-links', sev: 'P2', cat: 'Accessibility', title: `Links or buttons with no accessible name on ${plural(emptyL.length, 'page')}`, affects: emptyL.map((p) => p.url), expected: 'WCAG 2.4.4 and 4.1.2: every link and button has text or an `aria-label`.', actual: emptyL.slice(0, 5).map((p) => `${path(p.url)}: ${[...(p.emptyLinks || []).map((l) => l.href), ...(p.buttonsNoName || [])].slice(0, 2).join(', ')}`).join('; '), fix: 'Add visible text or an `aria-label` (for example to icon-only social links).' });
  const unl = ok.filter((p) => (p.unlabeledFields || []).length);
  if (unl.length) add({ key: 'labels', sev: 'P2', cat: 'Accessibility', title: `Form fields without labels on ${plural(unl.length, 'page')}`, affects: unl.map((p) => p.url), expected: 'WCAG 1.3.1 and 3.3.2: every field has a `<label>` or `aria-label`.', actual: unl.slice(0, 5).map((p) => `${path(p.url)}: ${p.unlabeledFields.slice(0, 3).map((f) => f.name).join(', ')}`).join('; '), fix: 'Turn on field labels in the form plugin, or add `aria-label`s.' });
  const dup = ok.filter((p) => (p.dupIds || []).length);
  if (dup.length) add({ key: 'dup-ids', sev: 'P3', cat: 'Accessibility', title: `Duplicate element IDs on ${plural(dup.length, 'page')}`, affects: dup.map((p) => p.url), expected: 'IDs are unique on each page.', actual: dup.slice(0, 4).map((p) => `${path(p.url)}: ${p.dupIds.slice(0, 3).map((x) => '`#' + x + '`').join(', ')}`).join('; '), fix: 'Remove the duplicate enqueue or rename the IDs. Duplicates often come from stylesheets printed twice.' });
  const lm = [];
  const home = pages[cfg.url] || ok[0];
  if (home) { if (!home.skipLink) lm.push('no skip link'); if (!home.hasMainLandmark) lm.push('no `<main>` landmark'); if (!home.lang) lm.push('no `lang` attribute'); }
  if (lm.length) add({ key: 'landmarks', sev: 'P3', cat: 'Accessibility', title: 'Page structure is missing accessibility basics', affects: [cfg.url], expected: 'Skip link, `<main>` landmark and `lang` attribute on every template.', actual: `Homepage: ${lm.join(', ')}.`, fix: 'Add them in the theme header template.' });
  const skipsP = ok.filter((p) => (p.headingSkips || []).length && (p.h1 || []).length);
  if (skipsP.length >= 3) add({ key: 'heading-skips', sev: 'P3', cat: 'Accessibility', title: `Heading levels skip on ${plural(skipsP.length, 'page')}`, affects: skipsP.map((p) => p.url), expected: 'Headings go down one level at a time (H2 → H3).', actual: skipsP.slice(0, 4).map((p) => `${path(p.url)}: ${p.headingSkips[0]}`).join('; '), fix: 'Pick heading levels by structure, and style them with classes instead.', confidence: 'MEDIUM' });
  const small = new Map();
  for (const [u, r] of R) for (const s of ((r.mobile || {}).analysis || {}).smallTargets || []) { if (!small.has(s.cls)) small.set(s.cls, { ...s, pages: new Set(), u }); small.get(s.cls).pages.add(u); }
  if (small.size) add({ key: 'touch', sev: 'P3', cat: 'Accessibility', title: `${plural(small.size, 'control type')} are smaller than 24×24 px on mobile`, affects: [...small.values()].flatMap((x) => [...x.pages]), expected: 'WCAG 2.5.8: touch targets at least 24×24 px.', actual: [...small.values()].slice(0, 6).map((x) => `\`${x.cls}\` ${x.w}×${x.h}px${x.label ? ` (“${x.label}”)` : ''}`).join('; '), fix: 'Increase padding or hit area (for example slider dots and icon links).', evidence: { url: [...small.values()][0].u, sel: [...small.values()][0].sel, viewport: 'mobile' } });

  // ───────────── Responsive & functional
  const ovM = R.filter(([, r]) => ((r.mobile || {}).analysis || {}).overflow > 0);
  const ovD = R.filter(([, r]) => ((r.desktop || {}).analysis || {}).overflow > 0);
  if (ovM.length) add({ key: 'overflow-mobile', sev: 'P1', cat: 'Design', title: `${plural(ovM.length, 'page')} scroll sideways on a ${cfg.viewports.mobile}px phone`, affects: ovM.map(([u]) => u), expected: 'No horizontal scrolling at mobile width.', actual: ovM.slice(0, 5).map(([u, r]) => `${path(u)} +${r.mobile.analysis.overflow}px (${(r.mobile.analysis.overflowEls[0] || {}).cls || '?'})`).join('; '), fix: 'Constrain the overflowing element with `max-width: 100%` or wrap it in an `overflow-x: auto` container.', evidence: { url: ovM[0][0], sel: (ovM[0][1].mobile.analysis.overflowEls[0] || {}).sel, viewport: 'mobile' } });
  if (ovD.length) add({ key: 'overflow-desktop', sev: 'P2', cat: 'Design', title: `${plural(ovD.length, 'page')} scroll sideways on desktop`, affects: ovD.map(([u]) => u), expected: 'No horizontal scrolling.', actual: ovD.slice(0, 5).map(([u, r]) => `${path(u)} +${r.desktop.analysis.overflow}px`).join('; '), fix: 'Find the overflowing element and constrain its width.' });
  if (!ovM.length && !ovD.length && R.length) passes.push(`No horizontal overflow at ${cfg.viewports.desktop}px or ${cfg.viewports.mobile}px on ${plural(R.length, 'rendered page')}.`);
  if (menu) {
    if (menu.result === 'FAIL') add({ key: 'menu', sev: 'P1', cat: 'Functional', title: "The mobile menu doesn't open", affects: [cfg.url], expected: 'Tapping the menu button shows the navigation.', actual: `Tapped “${menu.toggle.label}”; visible nav links ${menu.toggle.links} → ${menu.open.links}, aria-expanded ${menu.toggle.expanded} → ${menu.open.expanded}.`, fix: 'Check the menu script for errors and that the toggle targets the right element.' });
    else if (menu.result === 'PASS') {
      passes.push(`Mobile menu opens on tap (${menu.open.links} links visible)${menu.escapeCloses ? ' and closes with Escape' : ''}.`);
      const probs = [];
      if (!menu.ariaUpdates) probs.push('does not set `aria-expanded="true"` when open');
      if (!menu.escapeCloses) probs.push("doesn't close with Escape");
      if (menu.toggle.tag !== 'BUTTON') probs.push(`is a \`<${menu.toggle.tag.toLowerCase()}>\`, not a \`<button>\``);
      if (probs.length) add({ key: 'menu-a11y', sev: 'P3', cat: 'Accessibility', title: 'The mobile menu button has accessibility gaps', affects: [cfg.url], expected: 'A `<button>` with `aria-expanded` that closes with Escape.', actual: `The menu toggle ${probs.join(', ')}.`, fix: 'Update the toggle script and markup.' });
    } else if (menu.result === 'NOT_FOUND') add({ key: 'menu-none', sev: 'INFO', cat: 'Functional', title: 'No mobile menu button was detected', affects: [cfg.url], expected: 'A recognisable menu toggle at mobile width.', actual: 'No visible button with `aria-controls` or a menu/hamburger label was found at mobile width. If the navigation stays visible on phones, this is fine.', fix: 'Check manually.', confidence: 'LOW' });
  }
  const broke = R.filter(([, r]) => ((r.desktop || {}).analysis || {}).brokenImgs?.length);
  if (broke.length) add({ key: 'img-broken', sev: 'P2', cat: 'Content', title: `Broken images on ${plural(broke.length, 'page')}`, affects: broke.map(([u]) => u), expected: 'All images load.', actual: broke.slice(0, 4).map(([u, r]) => `${path(u)}: ${r.desktop.analysis.brokenImgs[0].split('/').pop()}`).join('; '), fix: 'Re-upload or replace the missing files.' });
  const up = new Map();
  for (const [u, r] of R) for (const i of ((r.desktop || {}).analysis || {}).upscaled || []) { if (!up.has(i.src)) up.set(i.src, { ...i, pages: new Set() }); up.get(i.src).pages.add(u); }
  if (up.size) add({ key: 'img-upscaled', sev: 'P3', cat: 'Performance', title: `${plural(up.size, 'image')} ${up.size === 1 ? 'is' : 'are'} shown larger than ${up.size === 1 ? 'its' : 'their'} file size`, affects: [...up.values()].flatMap((x) => [...x.pages]), expected: 'Images are at least as wide as they display, so they stay sharp.', actual: [...up.values()].slice(0, 5).map((x) => `${x.src} ${x.natural}px shown at ${x.rendered}px`).join('; '), fix: 'Pick a larger image size in the block, or add a `srcset` with a larger candidate.' });

  // ───────────── Runtime / network
  const cons = R.filter(([, r]) => (r.desktop.consoleErrors || []).some((e) => /^Uncaught/.test(e)));
  if (cons.length) add({ key: 'js-errors', sev: 'P2', cat: 'Functional', title: `Uncaught JavaScript errors on ${plural(cons.length, 'page')}`, affects: cons.map(([u]) => u), expected: 'No uncaught exceptions.', actual: [...new Set(cons.flatMap(([, r]) => r.desktop.consoleErrors.filter((e) => /^Uncaught/.test(e))))].slice(0, 4).join(' | '), fix: 'Reproduce in the browser console and fix the failing script. Check plugin conflicts first.', confidence: 'MEDIUM' });
  const fails = new Map();
  for (const [u, r] of R) for (const f of r.desktop.failed || []) { try { if (new URL(f.url).host.replace(/^www\./, '') !== cfg.host.replace(/^www\./, '')) continue; } catch { continue; } if (!fails.has(f.url)) fails.set(f.url, { ...f, pages: new Set() }); fails.get(f.url).pages.add(u); }
  if (fails.size) add({ key: 'failed-requests', sev: 'P2', cat: 'Infrastructure', title: `${plural(fails.size, 'site resource')} failed to load`, affects: [...fails.values()].flatMap((x) => [...x.pages]), expected: 'All same-site scripts, styles, fonts and images load (no 4xx/5xx).', actual: [...fails.values()].slice(0, 6).map((x) => `${path(x.url)} → ${x.status || x.error}`).join('; '), fix: 'Restore the missing files or remove the references.' });
  if (!cons.length && !fails.size && R.length) passes.push('No uncaught JavaScript errors or failed same-site requests on rendered pages.');
  const insecure = ok.filter((p) => (p.insecure || []).length);
  if (insecure.length && cfg.url.startsWith('https')) add({ key: 'mixed', sev: 'P1', cat: 'Security', title: `Mixed content (http://) on ${plural(insecure.length, 'page')}`, affects: insecure.map((p) => p.url), expected: 'All resources load over HTTPS.', actual: insecure.slice(0, 4).map((p) => `${path(p.url)}: ${p.insecure[0]}`).join('; '), fix: 'Search-replace http:// asset URLs with https://.' });
  else passes.push('No mixed content.');
  const thisSite = (() => { const c = {}; ok.forEach((p) => (p.uploadsSites || []).forEach((s) => { c[s] = (c[s] || 0) + 1; })); return Object.entries(c).sort((a, b) => b[1] - a[1]); })();
  if (thisSite.length > 1) { const main = thisSite[0][0]; const foreign = ok.filter((p) => (p.uploadsSites || []).some((s) => s !== main)); add({ key: 'multisite-assets', sev: 'P3', cat: 'Integration', title: `${plural(foreign.length, 'page')} use media from another network site`, affects: foreign.map((p) => p.url), expected: `Each site uses its own media library (\`/uploads/sites/${main}/\`).`, actual: `Files from \`/uploads/sites/${thisSite.slice(1).map((x) => x[0]).join(', ')}/\` on ${plist(foreign.map((p) => p.url), 4)}. They break if the other site deletes them.`, fix: "Re-upload these files to this site's media library and update the blocks.", confidence: 'MEDIUM' }); }

  // ───────────── Performance
  const inl = ok.filter((p) => p.inlineCssKB + p.inlineJsKB > cfg.budgets.inlineKB);
  if (inl.length) { const mx = inl.reduce((a, p) => Math.max(a, p.inlineCssKB + p.inlineJsKB), 0); const blk = (inl[0].inlineBlocks || []).sort((a, b) => b.kb - a.kb)[0]; add({ key: 'inline', sev: mx > 500 ? 'P2' : 'P3', cat: 'Performance', title: `${plural(inl.length, 'page')} inline up to ${mx} KB of CSS/JS that the browser can't cache`, affects: inl.map((p) => p.url), expected: `Inline CSS+JS under ${cfg.budgets.inlineKB} KB per page. Shared code loads from cacheable files.`, actual: `Largest block: \`<${blk.tag}${blk.id ? ` id="${blk.id}"` : ''}>\` at ${blk.kb} KB. HTML documents are up to ${Math.round(inl.reduce((a, p) => Math.max(a, p.bytes), 0) / 1024)} KB.`, fix: 'Enqueue the stylesheet or script as an external, versioned file and keep only critical CSS inline.' }); }
  for (const pf of perf || []) {
    const m = pf.median; const where = path(pf.url) === '/' ? 'Homepage' : path(pf.url);
    const runs = (k) => pf.runs.map((r) => r[k]).filter((x) => x != null).join(', ');
    if (m.ttfb > cfg.budgets.ttfbMs) add({ key: 'ttfb' + pf.url, sev: m.ttfb > cfg.budgets.ttfbMs * 2 ? 'P2' : 'P3', cat: 'Performance', title: `${where}: server response time is ${m.ttfb} ms (budget ${cfg.budgets.ttfbMs} ms)`, affects: [pf.url], expected: `TTFB under ${cfg.budgets.ttfbMs} ms (median of ${pf.runs.length}).`, actual: `Runs: ${runs('ttfb')} ms; median ${m.ttfb} ms. Measured from the audit machine, so network distance adds to it.`, fix: 'Check page caching (is HTML served from cache?), slow plugins (Query Monitor) and hosting tier.', confidence: 'MEDIUM' });
    if (m.lcp && m.lcp > cfg.budgets.lcpMs) add({ key: 'lcp' + pf.url, sev: 'P2', cat: 'Performance', title: `${where}: largest content paints at ${(m.lcp / 1000).toFixed(1)} s (budget ${(cfg.budgets.lcpMs / 1000).toFixed(1)} s)`, affects: [pf.url], expected: `LCP under ${cfg.budgets.lcpMs} ms in the lab.`, actual: `Runs: ${runs('lcp')} ms. LCP element: ${pf.lcpEl ? `${pf.lcpEl.tag} ${pf.lcpEl.src || ''}${pf.lcpEl.lazy === 'lazy' ? ' (lazy-loaded!)' : ''}` : 'unknown'}. Lab data, not field data.`, fix: `${pf.lcpEl && pf.lcpEl.lazy === 'lazy' ? 'Remove `loading="lazy"` from the hero image and add `fetchpriority="high"`. ' : ''}Preload the hero image and cut render-blocking CSS/JS.`, confidence: 'MEDIUM' });
    else if (pf.lcpEl && pf.lcpEl.lazy === 'lazy') add({ key: 'lcp-lazy' + pf.url, sev: 'P2', cat: 'Performance', title: `${where}: the main hero image is lazy-loaded`, affects: [pf.url], expected: 'The LCP image loads eagerly with high priority.', actual: `${pf.lcpEl.src} has \`loading="lazy"\`.`, fix: 'Remove `loading="lazy"` and add `fetchpriority="high"`.' });
    if (m.cls > cfg.budgets.cls) add({ key: 'cls' + pf.url, sev: 'P2', cat: 'Performance', title: `${where}: the layout shifts while loading (CLS ${m.cls})`, affects: [pf.url], expected: `CLS under ${cfg.budgets.cls}.`, actual: `Worst run CLS ${m.cls}.`, fix: 'Set width and height on images and embeds, and reserve space for banners and late-loading widgets.' });
    if (m.load > cfg.budgets.loadMs) add({ key: 'load' + pf.url, sev: 'P3', cat: 'Performance', title: `${where}: full load takes ${(m.load / 1000).toFixed(1)} s (budget ${(cfg.budgets.loadMs / 1000).toFixed(1)} s)`, affects: [pf.url], expected: `Load event under ${cfg.budgets.loadMs} ms.`, actual: `Runs: ${runs('load')} ms; ${pf.requests} requests, ${pf.totalKB} KB (${pf.thirdPartyRequests} third-party requests, ${pf.thirdPartyKB} KB).`, fix: 'Defer non-critical third-party tags and lazy-load below-the-fold media.', confidence: 'MEDIUM' });
    const ownBig = pf.bigAssets.filter((a) => a.own);
    if (ownBig.length) add({ key: 'big-assets' + pf.url, sev: 'P3', cat: 'Performance', title: `${where}: ${plural(ownBig.length, 'own CSS/JS file')} over ${cfg.budgets.assetKB} KB`, affects: [pf.url], expected: `Individual CSS/JS files under ${cfg.budgets.assetKB} KB.`, actual: ownBig.slice(0, 5).map((a) => `${path(a.url)} ${a.kb} KB`).join('; '), fix: 'Split per template or remove unused code. Load plugin assets only where they are used.' });
  }
  const perfOK = (perf || []).filter((pf) => pf.median.ttfb <= cfg.budgets.ttfbMs && (!pf.median.lcp || pf.median.lcp <= cfg.budgets.lcpMs));
  if (perfOK.length) passes.push(`Within performance budgets: ${perfOK.map((pf) => `${path(pf.url)} (TTFB ${pf.median.ttfb} ms, LCP ${pf.median.lcp ?? '—'} ms)`).join('; ')}.`);

  // ───────────── SEO
  const noTitle = ok.filter((p) => !p.title);
  if (noTitle.length) add({ key: 'no-title', sev: 'P2', cat: 'SEO', title: `${plural(noTitle.length, 'page')} ${noTitle.length === 1 ? 'has' : 'have'} no title`, affects: noTitle.map((p) => p.url), expected: 'Every page has a unique `<title>`.', actual: plist(noTitle.map((p) => p.url)), fix: 'Set titles in the SEO plugin.' });
  const tmap = {}; ok.forEach((p) => { if (p.title) (tmap[p.title] = tmap[p.title] || []).push(p.url); });
  const dupT = Object.entries(tmap).filter(([, v]) => v.length > 1);
  if (dupT.length) add({ key: 'dup-title', sev: 'P3', cat: 'SEO', title: `${plural(dupT.length, 'title')} ${dupT.length === 1 ? 'is' : 'are'} used on more than one page`, affects: dupT.flatMap(([, v]) => v), expected: 'Unique titles.', actual: dupT.slice(0, 4).map(([t, v]) => `“${t.slice(0, 60)}” on ${plist(v, 3)}`).join('; '), fix: 'Write distinct titles. For paginated archives, add “Page N”.' });
  const brandWord = cfg.siteName;
  const longT = ok.filter((p) => p.title && p.title.length > 60);
  const twice = ok.filter((p) => { const t = (p.title || '').toLowerCase(); const parts = t.split(/\s[|–—-]\s/).map((s) => s.trim()); const last = parts[parts.length - 1]; return parts.length > 2 && last.length > 3 && t.split(last).length - 1 > 1; });
  if (longT.length || twice.length) add({ key: 'long-title', sev: 'P3', cat: 'SEO', title: [longT.length ? `${plural(longT.length, 'title')} over 60 characters` : '', twice.length ? `${plural(twice.length, 'title')} repeat the site name` : ''].filter(Boolean).join('; '), affects: [...longT, ...twice].map((p) => p.url), expected: 'Titles of about 60 characters or fewer, with the brand once.', actual: (twice[0] || longT[0]) ? `e.g. “${(twice[0] || longT[0]).title}” (${(twice[0] || longT[0]).title.length} chars)` : '', fix: 'Shorten the custom titles, and remove a brand suffix that the title template already adds.' });
  const noDesc = ok.filter((p) => !p.desc);
  if (noDesc.length) add({ key: 'no-desc', sev: 'P3', cat: 'SEO', title: `${plural(noDesc.length, 'page')} without a meta description`, affects: noDesc.map((p) => p.url), expected: 'Every indexable page has a meta description.', actual: plist(noDesc.map((p) => p.url), 8), fix: 'Add descriptions, or a template for archives, in the SEO plugin.' });
  const dmap = {}; ok.forEach((p) => { if (p.desc) (dmap[p.desc] = dmap[p.desc] || []).push(p.url); });
  const dupD = Object.entries(dmap).filter(([, v]) => v.length > 1);
  if (dupD.length) add({ key: 'dup-desc', sev: 'P3', cat: 'SEO', title: `${plural(dupD.length, 'meta description')} ${dupD.length === 1 ? 'is' : 'are'} duplicated`, affects: dupD.flatMap(([, v]) => v), expected: 'Unique descriptions.', actual: dupD.slice(0, 3).map(([d, v]) => `“${d.slice(0, 50)}…” on ${plist(v, 3)}`).join('; '), fix: 'Write distinct descriptions.' });
  const canonOff = ok.filter((p) => p.canonical && p.canonical.replace(/\/$/, '') !== p.finalUrl.replace(/\/$/, ''));
  const canonMissing = ok.filter((p) => !p.canonical);
  if (canonOff.length) add({ key: 'canonical', sev: canonOff.some((p) => !p.canonical.includes(cfg.host.replace(/^www\./, ''))) ? 'P1' : 'P2', cat: 'SEO', title: `${plural(canonOff.length, 'page')} declare a different canonical URL`, affects: canonOff.map((p) => p.url), expected: 'Pages that are in the sitemap point their canonical at themselves.', actual: canonOff.slice(0, 5).map((p) => `${path(p.url)} → ${p.canonical}`).join('; '), fix: 'Fix the canonical in the SEO plugin, or remove the page from the sitemap if it is a duplicate.' });
  if (canonMissing.length) add({ key: 'canonical-missing', sev: 'P3', cat: 'SEO', title: `${plural(canonMissing.length, 'page')} without a canonical tag`, affects: canonMissing.map((p) => p.url), expected: 'Self-referencing canonical on every page.', actual: plist(canonMissing.map((p) => p.url)), fix: 'Enable canonicals in the SEO plugin.' });
  const noindex = ok.filter((p) => /noindex/.test(p.robots));
  if (noindex.length) add({ key: 'noindex', sev: prod ? 'P1' : 'INFO', cat: 'SEO', title: prod ? `${plural(noindex.length, 'sitemap page')} ${noindex.length === 1 ? 'is' : 'are'} set to noindex` : `Staging is set to noindex (${plural(noindex.length, 'page')})`, affects: noindex.map((p) => p.url), expected: prod ? 'Sitemap pages are indexable.' : 'Expected on staging. Remove it at launch.', actual: plist(noindex.map((p) => p.url)), fix: prod ? 'Remove noindex, or take the pages out of the sitemap.' : 'Add “turn off noindex” to the launch checklist.' });
  if (prod && /^\s*disallow:\s*\/\s*$/im.test(disc.robotsTxt || '')) add({ key: 'robots-block', sev: 'P0', cat: 'SEO', title: 'robots.txt blocks the whole site', affects: [cfg.origin + '/robots.txt'], expected: 'Production allows crawling.', actual: '`Disallow: /` found in robots.txt.', fix: 'Remove the rule (WordPress → Settings → Reading → “Discourage search engines” is often the cause).' });
  if (!disc.sitemaps.some((s) => s.ok)) add({ key: 'no-sitemap', sev: 'P2', cat: 'SEO', title: 'No XML sitemap found', affects: [cfg.url], expected: 'An XML sitemap is linked from robots.txt.', actual: `Tried ${disc.sitemaps.map((s) => path(s.url)).join(', ') || 'standard locations'}; the audit fell back to following links.`, fix: 'Enable the sitemap in the SEO plugin and reference it in robots.txt.' });
  const h1none = ok.filter((p) => !(p.h1 || []).length);
  const h1multi = ok.filter((p) => (p.h1 || []).length > 1);
  if (h1none.length) add({ key: 'h1-none', sev: 'P2', cat: 'SEO', title: `${plural(h1none.length, 'page')} ${h1none.length === 1 ? 'has' : 'have'} no H1`, affects: h1none.map((p) => p.url), expected: 'One H1 per page.', actual: plist(h1none.map((p) => p.url), 8), fix: 'Make the page title or hero heading an H1.' });
  if (h1multi.length) add({ key: 'h1-multi', sev: 'P3', cat: 'SEO', title: `${plural(h1multi.length, 'page')} ${h1multi.length === 1 ? 'has' : 'have'} more than one H1`, affects: h1multi.map((p) => p.url), expected: 'One H1 per page.', actual: h1multi.slice(0, 3).map((p) => `${path(p.url)}: ${p.h1.slice(0, 2).map((h) => `“${h.slice(0, 50)}”`).join(' + ')}`).join('; '), fix: 'Demote the H1 inside the content to H2 (often an old editor habit), or fix the template.' });
  const ldBad = ok.filter((p) => (p.ld || []).some((x) => !x.ok));
  if (ldBad.length) add({ key: 'jsonld', sev: 'P2', cat: 'SEO', title: `Invalid structured data (JSON-LD) on ${plural(ldBad.length, 'page')}`, affects: ldBad.map((p) => p.url), expected: 'All JSON-LD blocks parse.', actual: ldBad.slice(0, 3).map((p) => `${path(p.url)}: ${(p.ld.find((x) => !x.ok) || {}).error}`).join('; '), fix: 'Fix the JSON syntax in the plugin or custom schema output.' });
  const ldNone = ok.filter((p) => !(p.ld || []).length);
  const noOg = ok.filter((p) => !p.ogImage);
  if (noOg.length) add({ key: 'og', sev: 'P3', cat: 'SEO', title: `${plural(noOg.length, 'page')} without an og:image`, affects: noOg.map((p) => p.url), expected: 'Every page has a share image.', actual: plist(noOg.map((p) => p.url), 8), fix: 'Set a default share image in the SEO plugin.' });
  if (!noTitle.length && !dupT.length) passes.push('Every page has a unique title.');
  if (!canonOff.length && !canonMissing.length) passes.push('Every page has a self-referencing canonical.');
  if (!noindex.length && prod) passes.push('No sitemap page is set to noindex.');
  if (!ldBad.length && ok.length - ldNone.length > 0) passes.push(`JSON-LD parses on all ${ok.length - ldNone.length} pages that have it (${[...new Set(ok.flatMap((p) => (p.ld || []).flatMap((x) => x.types || [])))].slice(0, 6).join(', ')}).`);

  // ───────────── Security headers
  const h = homeHeaders || {};
  const missingReq = [], missingRec = [];
  if (!h['strict-transport-security'] && cfg.url.startsWith('https')) missingReq.push('Strict-Transport-Security');
  if (!/nosniff/i.test(h['x-content-type-options'] || '')) missingReq.push('X-Content-Type-Options');
  if (!h['content-security-policy'] && !h['content-security-policy-report-only']) missingRec.push('Content-Security-Policy');
  if (!h['referrer-policy']) missingRec.push('Referrer-Policy');
  if (!h['permissions-policy']) missingRec.push('Permissions-Policy');
  if (!h['x-frame-options'] && !/frame-ancestors/.test(h['content-security-policy'] || '')) missingRec.push('X-Frame-Options (or CSP frame-ancestors)');
  const present = ['strict-transport-security', 'x-content-type-options', 'x-frame-options', 'content-security-policy', 'referrer-policy', 'permissions-policy'].filter((k) => h[k]);
  if (missingReq.length || missingRec.length) add({ key: 'headers', sev: missingReq.length ? 'P2' : 'P3', cat: 'Security', title: `${plural(missingReq.length + missingRec.length, 'security header')} ${missingReq.length + missingRec.length === 1 ? 'is' : 'are'} missing`, affects: [cfg.url], expected: 'HSTS and nosniff are required. CSP, Referrer-Policy, Permissions-Policy and frame protection are recommended.', actual: `Missing: ${[...missingReq, ...missingRec].join(', ')}. Present: ${present.join(', ') || 'none'}.`, fix: 'Add them at the CDN or server (for example a Cloudflare Transform Rule). Start CSP in Report-Only mode if the site loads many third-party tags.' });
  else passes.push('All recommended security headers are present.');
  const leak = [h['x-powered-by'], h['server']].filter((v) => v && /\d+\.\d+/.test(v));
  if (leak.length) add({ key: 'version-leak', sev: 'P3', cat: 'Security', title: 'Response headers reveal software versions', affects: [cfg.url], expected: 'No version numbers in `Server` or `X-Powered-By`.', actual: leak.join('; '), fix: 'Turn off version exposure at the server.' });

  // ───────────── Design source info
  if (!brandFonts.length && !cfg.brand.colors.length) {
    const fams = {};
    for (const [, r] of rendered) for (const [k, n] of Object.entries(r.desktop.analysis.fonts)) { const f = k.replace(/ \d+$/, ''); fams[f] = (fams[f] || 0) + n; }
    add({ key: 'design-unverifiable', sev: 'INFO', cat: 'Design source', title: 'No brand fonts or colours were configured, so design compliance is UNVERIFIABLE', affects: [], expected: 'Brand fonts and palette in the audit profile.', actual: `Fonts in use: ${Object.entries(fams).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f} (${n})`).join(', ')}.`, fix: 'Add the brand fonts and hex colours to the profile and run the audit again.' });
  }

  return { issues, passes };
}

module.exports = { run, path, plural };
