'use strict';

// Runs inside Chromium (page.evaluate). Parses fetched HTML with DOMParser — no scripts run, so this
// is the server-rendered page exactly as crawlers and CallRail-free visitors receive it.
function extractStatic({ html, url }) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  const q = (s) => d.querySelector(s);
  const qa = (s) => [...d.querySelectorAll(s)];
  const txt = (e) => (e && e.textContent ? e.textContent.replace(/\s+/g, ' ').trim() : '');
  const abs = (h) => { try { return new URL(h, url).href; } catch { return null; } };
  // Unique CSS path (nth-of-type), so evidence screenshots can find the exact element later.
  const sel = (e) => {
    if (!e || e.nodeType !== 1) return '';
    const parts = [];
    let x = e;
    while (x && x.nodeType === 1 && x !== d.body && parts.length < 10) {
      if (x.id && /^[A-Za-z][\w-]*$/.test(x.id) && d.querySelectorAll('#' + x.id).length === 1) { parts.unshift('#' + x.id); break; }
      let s = x.tagName.toLowerCase();
      const p = x.parentElement;
      if (p) { const sib = [...p.children].filter((c) => c.tagName === x.tagName); if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(x) + 1})`; }
      parts.unshift(s);
      x = p;
    }
    if (x === d.body) parts.unshift('body');
    return parts.join(' > ');
  };

  const ld = qa('script[type="application/ld+json"]').map((s) => {
    try {
      const j = JSON.parse(s.textContent);
      const g = Array.isArray(j) ? j : j['@graph'] || [j];
      return { ok: true, types: g.map((x) => x && x['@type']).flat().filter(Boolean) };
    } catch (e) { return { ok: false, error: String(e.message).slice(0, 120) }; }
  });

  const links = qa('a').map((a) => {
    const h = a.getAttribute('href');
    const label = txt(a) || a.getAttribute('aria-label') || a.getAttribute('title') || (a.querySelector('img[alt]:not([alt=""])') ? a.querySelector('img').getAttribute('alt') : '') || (a.querySelector('svg title') ? txt(a.querySelector('svg title')) : '');
    return { href: h, abs: h ? abs(h) : null, text: txt(a).slice(0, 80), label: label.slice(0, 80), sel: sel(a), target: a.getAttribute('target'), rel: a.getAttribute('rel') };
  });

  const phoneRe = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  const tels = links.filter((l) => l.href && /^tel:/i.test(l.href)).map((l) => {
    const hrefDigits = l.href.replace(/\D/g, '').slice(-10);
    const m = (l.text || '').match(phoneRe);
    const textDigits = m ? m[0].replace(/\D/g, '').slice(-10) : null;
    return { href: l.href, hrefDigits, text: l.text, textDigits, sel: l.sel, empty: !l.label };
  });
  // Phone numbers printed as plain text (not links) — for the inventory
  const bodyText = d.body ? d.body.textContent : '';
  const printed = [...new Set((bodyText.match(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g) || []).map((p) => p.replace(/\D/g, '').slice(-10)))];

  const ids = qa('[id]').map((e) => e.id);
  const dupIds = [...new Set(ids.filter((x, i) => x && ids.indexOf(x) !== i))];

  const fields = qa('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]),select,textarea').filter((i) => {
    if (i.closest('[aria-hidden="true"]')) return false;
    if (i.getAttribute('aria-label') || i.getAttribute('aria-labelledby') || i.getAttribute('title')) return false;
    if (i.closest('label')) return false;
    if (i.id && d.querySelector(`label[for="${CSS.escape(i.id)}"]`)) return false;
    return true;
  }).map((i) => ({ name: i.name || i.type || i.tagName.toLowerCase(), sel: sel(i) }));

  const headings = qa('h1,h2,h3,h4,h5,h6').map((h) => ({ l: +h.tagName[1], t: txt(h).slice(0, 90) }));
  const skips = [];
  headings.forEach((h, i) => { if (i > 0 && h.l - headings[i - 1].l > 1) skips.push(`H${headings[i - 1].l} → H${h.l} ("${h.t.slice(0, 40)}")`); });

  const big = qa('style,script:not([src])').map((s) => ({ tag: s.tagName.toLowerCase(), id: s.id || '', kb: Math.round(s.textContent.length / 1024) }));
  const main = q('main') || q('[role=main]') || d.body;

  const fontClasses = {};
  qa('[class*="-font-family"]').forEach((e) => [...e.classList].filter((c) => /^has-.+-font-family$/.test(c)).forEach((c) => { fontClasses[c] = (fontClasses[c] || 0) + 1; }));
  const inlineFonts = {};
  qa('[style*="font-family"]').forEach((e) => {
    const m = e.getAttribute('style').match(/font-family\s*:\s*([^;]+)/i);
    if (m) { const f = m[1].split(',')[0].replace(/["']/g, '').replace(/var\(--wp--preset--font-family--([\w-]+)\)/, '$1').trim(); inlineFonts[f] = (inlineFonts[f] || 0) + 1; }
  });

  const imgs = qa('img');
  const insecure = qa('img[src^="http:"],script[src^="http:"],link[href^="http:"][rel=stylesheet],iframe[src^="http:"],source[src^="http:"]').map((e) => e.getAttribute('src') || e.getAttribute('href'));

  return {
    title: txt(q('title')),
    desc: (q('meta[name="description"]') || {}).content || '',
    canonical: q('link[rel="canonical"]') ? abs(q('link[rel="canonical"]').getAttribute('href')) : '',
    robots: ((q('meta[name="robots"]') || {}).content || '').toLowerCase(),
    ogTitle: (q('meta[property="og:title"]') || {}).content || '',
    ogImage: (q('meta[property="og:image"]') || {}).content || '',
    lang: d.documentElement.getAttribute('lang') || '',
    viewportMeta: !!q('meta[name="viewport"]'),
    generator: (q('meta[name="generator"]') || {}).content || '',
    bodyClass: d.body ? d.body.className : '',
    ld,
    h1: qa('h1').map((h) => txt(h).slice(0, 100)),
    headingSkips: skips.slice(0, 5),
    imgNoAlt: imgs.filter((i) => !i.hasAttribute('alt')).map((i) => (i.getAttribute('src') || i.getAttribute('data-src') || '').split('/').pop().slice(0, 80)).slice(0, 20),
    imgCount: imgs.length,
    imgNoDims: imgs.filter((i) => !i.getAttribute('width') || !i.getAttribute('height')).length,
    links: links.map((l) => ({ abs: l.abs, href: l.href, text: l.text, label: l.label, sel: l.sel, target: l.target, rel: l.rel })),
    emptyLinks: links.filter((l) => l.href && !l.label && !/^tel:/i.test(l.href)).map((l) => ({ href: l.href, sel: l.sel })).slice(0, 20),
    badHrefs: links.filter((l) => !l.href || l.href === '#' || /^javascript:/i.test(l.href)).map((l) => ({ href: l.href, text: l.text, sel: l.sel })).slice(0, 20),
    tels,
    printedPhones: printed,
    mailtos: links.filter((l) => l.href && /^mailto:/i.test(l.href)).map((l) => l.href.replace(/^mailto:/i, '').split('?')[0].toLowerCase()),
    dupIds: dupIds.slice(0, 20),
    unlabeledFields: fields.slice(0, 20),
    forms: qa('form').map((f) => ({ id: f.id, action: f.getAttribute('action') || '', fields: f.querySelectorAll('input,select,textarea').length })),
    buttonsNoName: qa('button').filter((b) => !txt(b) && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby') && !b.getAttribute('title')).map(sel).slice(0, 10),
    inlineBlocks: big.filter((b) => b.kb > 0),
    inlineCssKB: big.filter((b) => b.tag === 'style').reduce((a, b) => a + b.kb, 0),
    inlineJsKB: big.filter((b) => b.tag === 'script').reduce((a, b) => a + b.kb, 0),
    stylesheets: qa('link[rel="stylesheet"]').map((l) => abs(l.getAttribute('href'))),
    scripts: qa('script[src]').map((s) => abs(s.getAttribute('src'))),
    mainTextLen: txt(main).length,
    placeholder: (/lorem ipsum|dolor sit amet|consectetur adipiscing/i.exec(bodyText) || [null])[0],
    defaultContent: /Hello world!|This is an example page|Sample Page/i.test(txt(q('h1')) + ' ' + txt(q('title'))),
    fontClasses,
    inlineFonts,
    insecure: insecure.slice(0, 10),
    skipLink: !!qa('a[href^="#"]').find((a) => /skip/i.test(txt(a))),
    hasMainLandmark: !!(q('main') || q('[role=main]')),
    hasNav: !!(q('nav') || q('[role=navigation]')),
    uploadsSites: [...new Set((html.match(/\/wp-content\/uploads\/sites\/(\d+)\//g) || []).map((m) => m.match(/sites\/(\d+)/)[1]))],
  };
}

module.exports = { extractStatic };
