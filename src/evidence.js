'use strict';
// Evidence screenshots: one per affected element/page (up to a cap), captured page by page.
// Each target is { url, viewport, sel?, selAll?, href?, note } and becomes one slide in the report.
const { normalize } = require('./discover');

const NO_SHOTS = /^(sitemap-|redirect-chains|broken-external|legacy-|no-title|dup-title|long-title|no-desc|dup-desc|canonical|noindex|robots-block|no-sitemap|h1-none|jsonld|og|headers|version-leak|design-unverifiable|inline|ttfb|lcp|cls|load|big-assets|js-errors|failed-requests|mixed|dup-ids|landmarks|heading-skips|tel-inventory|menu|multisite-assets)/;

function targetsFor(issue, ctx, perIssue) {
  if (NO_SHOTS.test(issue.key)) return [];
  const { pages, render, cfg } = ctx;
  const T = [];
  const seen = new Set();
  const add = (t) => { const k = [t.url, t.viewport, t.sel, t.selAll, t.href].join('|'); if (!seen.has(k) && T.length < perIssue) { seen.add(k); T.push(t); } };
  const affects = new Set(issue.affects || []);
  const R = (u, vp) => (((render[u] || {})[vp] || {}).analysis);
  const each = (fn) => { for (const u of issue.affects || []) { fn(u); if (T.length >= perIssue) break; } };
  const k = issue.key;
  if (k === 'tel-mismatch') each((u) => {
    for (const t of (pages[u] || {}).tels || []) if (t.textDigits && t.hrefDigits && t.textDigits !== t.hrefDigits) add({ url: u, viewport: 'desktop', sel: t.sel, note: `shows ${t.textDigits}, dials ${t.hrefDigits}` });
    for (const t of (R(u, 'desktop') || {}).tels || []) if (t.textDigits && t.hrefDigits && t.textDigits !== t.hrefDigits) add({ url: u, viewport: 'desktop', href: 'tel:', telDigits: t.hrefDigits, note: `dials ${t.hrefDigits}` });
  });
  else if (k === 'tel-unexpected') {
    const ok = cfg.phones.expected;
    each((u) => { for (const t of (pages[u] || {}).tels || []) if (t.hrefDigits && !ok.some((e) => e.endsWith(t.hrefDigits) || t.hrefDigits.endsWith(e))) add({ url: u, viewport: 'desktop', href: 'tel:', telDigits: t.hrefDigits, note: `${t.hrefDigits}` }); });
  } else if (k === 'broken-internal') {
    const dead = new Set(Object.values(ctx.links.internal).filter((l) => l.status >= 400 || l.status === 0).map((l) => l.url));
    each((u) => { for (const l of (pages[u] || {}).links || []) { const n = l.abs && normalize(l.abs); if (n && dead.has(n)) { add({ url: u, viewport: 'desktop', href: n, note: `links to ${new URL(n).pathname}` }); break; } } });
  } else if (k === 'font-headings' || k === 'font-body') {
    const heading = k === 'font-headings';
    const allowed = [...cfg.brand.headingFonts, ...cfg.brand.bodyFonts].map((f) => f.toLowerCase());
    each((u) => { for (const vp of ['desktop', 'mobile']) { const a = R(u, vp); const f = a && a.offFonts.find((x) => !!x.heading === heading && !allowed.includes(x.fam.toLowerCase())); if (f) { add({ url: u, viewport: vp, sel: f.sel, note: `${f.fam} ${f.wt} on ${f.tag}` }); break; } } });
  } else if (k === 'font-heading-body') each((u) => { const h = ((R(u, 'desktop') || {}).headingFonts || [])[0]; if (h) add({ url: u, viewport: 'desktop', sel: h.sel, note: `${h.tag} in ${h.fam}` }); });
  else if (k === 'colors') each((u) => { const c = ((R(u, 'desktop') || {}).offColors || []).find((x) => x.ex); if (c) add({ url: u, viewport: 'desktop', sel: c.ex.sel, note: `#${c.hex} ${c.kind}` }); });
  else if (k === 'contrast') each((u) => { for (const vp of ['desktop', 'mobile']) { const c = ((R(u, vp) || {}).contrast || [])[0]; if (c) { add({ url: u, viewport: vp, sel: c.sel, note: `#${c.fg} on #${c.bg} = ${c.ratio}:1` }); break; } } });
  else if (k === 'mouse-only') each((u) => { const m = ((R(u, 'desktop') || {}).mouseOnly || [])[0]; if (m) add({ url: u, viewport: 'desktop', sel: m.sel, note: `${m.cls} ×${m.count}` }); });
  else if (k === 'focus-invisible' || k === 'focus-weak') each((u) => { const f = ((R(u, 'desktop') || {}).focus || {})[k === 'focus-invisible' ? 'invisible' : 'weak'] || []; if (f[0]) add({ url: u, viewport: 'desktop', sel: f[0].sel, focus: true, note: f[0].cls }); });
  else if (k === 'touch') each((u) => { const s = ((R(u, 'mobile') || {}).smallTargets || [])[0]; if (s) add({ url: u, viewport: 'mobile', sel: s.sel, note: `${s.w}×${s.h}px` }); });
  else if (k === 'overflow-mobile' || k === 'overflow-desktop') { const vp = k.endsWith('mobile') ? 'mobile' : 'desktop'; each((u) => { const a = R(u, vp); if (a && a.overflow) add({ url: u, viewport: vp, sel: (a.overflowEls[0] || {}).sel, note: `+${a.overflow}px wider than the screen` }); }); }
  else if (k === 'img-upscaled') each((u) => { for (const i of ((R(u, 'desktop') || {}).upscaled || []).slice(0, 2)) add({ url: u, viewport: 'desktop', sel: i.sel, note: `${i.natural}px shown at ${i.rendered}px` }); });
  else if (k === 'empty-links') each((u) => { const l = ((pages[u] || {}).emptyLinks || [])[0]; if (l) add({ url: u, viewport: 'desktop', sel: l.sel, note: 'link without a name' }); });
  else if (k === 'labels') each((u) => { const f = ((pages[u] || {}).unlabeledFields || [])[0]; if (f) add({ url: u, viewport: 'desktop', sel: f.sel, note: `field “${f.name}”` }); });
  else if (k === 'h1-multi') each((u) => add({ url: u, viewport: 'desktop', selAll: 'h1', note: `${((pages[u] || {}).h1 || []).length} H1s` }));
  else if (k === 'img-alt') each((u) => add({ url: u, viewport: 'desktop', selAll: 'img:not([alt])', note: `${((pages[u] || {}).imgNoAlt || []).length} images without alt` }));
  // Fallback: the issue's primary evidence, then whole-page shots of affected pages
  if (issue.evidence && issue.evidence.url && !T.length) add({ ...issue.evidence, note: '' });
  if (!T.length && /^(empty-pages|placeholder|img-broken|tel-empty)$/.test(k)) each((u) => add({ url: u, viewport: 'desktop', note: '' }));
  void affects;
  return T;
}

const tid = (t) => [t.url, t.viewport, t.sel || '', t.selAll || '', t.href || '', t.telDigits || ''].join('|');

// Mark the target element(s) in the page, scroll to the first, return its box (viewport coords).
function markInPage(t) {
  document.querySelectorAll('[data-qa-mark]').forEach((e) => { e.style.removeProperty('outline'); e.style.removeProperty('outline-offset'); e.removeAttribute('data-qa-mark'); });
  let els = [];
  try {
    if (t.sel) { const e = document.querySelector(t.sel); if (e) els = [e]; }
    if (!els.length && t.selAll) els = [...document.querySelectorAll(t.selAll)];
    if (!els.length && t.href) {
      els = [...document.querySelectorAll('a[href]')].filter((a) => {
        if (t.telDigits) return /^tel:/i.test(a.getAttribute('href')) && a.getAttribute('href').replace(/\D/g, '').slice(-10) === t.telDigits;
        try { const h = new URL(a.getAttribute('href'), location.href); h.hash = ''; return h.href === t.href; } catch { return false; }
      });
    }
  } catch { els = []; }
  const vis = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const list = vis.length ? vis : els;
  list.slice(0, 20).forEach((e) => { e.setAttribute('data-qa-mark', '1'); e.style.setProperty('outline', '3px solid #ff2d95', 'important'); e.style.setProperty('outline-offset', '3px', 'important'); });
  if (!vis.length) { window.scrollTo(0, 0); return { found: !!els.length, visible: false }; }
  vis[0].scrollIntoView({ block: 'center' });
  if (t.focus) { try { vis[0].focus({ focusVisible: true }); } catch {} }
  const r = vis[0].getBoundingClientRect();
  return { found: true, visible: true, top: r.top, height: r.height, count: vis.length };
}

// existing: shots already captured (resume). stop(): time budget. Returns { shots, complete }.
async function capture(browser, cfg, plan, existing, settle, log, stop) {
  const shots = existing || {};
  const groups = new Map();
  for (const t of plan) { const id = tid(t); if (shots[id]) continue; const g = t.url + '|' + t.viewport; if (!groups.has(g)) groups.set(g, []); groups.get(g).push({ ...t, id }); }
  const ctxs = {};
  let stopped = false;
  for (const [, list] of groups) {
    if ((stop && stop()) || !browser.isConnected()) { stopped = true; break; }
    const vp = list[0].viewport === 'mobile' ? 'mobile' : 'desktop';
    const W = vp === 'mobile' ? cfg.viewports.mobile : cfg.viewports.desktop;
    const H = vp === 'mobile' ? 812 : 760;
    if (!ctxs[vp]) ctxs[vp] = await browser.newContext(vp === 'mobile' ? { viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { viewport: { width: W, height: H } });
    const page = await ctxs[vp].newPage();
    try {
      await page.goto(list[0].url, { waitUntil: 'load', timeout: cfg.timeoutMs });
      await settle(page);
      for (const t of list) {
        const box = await page.evaluate(markInPage, t);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250))));
        let clip;
        if (box.visible) {
          const h = Math.min(H, Math.max(380, box.height + 260));
          const y = Math.max(0, Math.min(H - h, box.top - (h - Math.min(box.height, h - 40)) / 2));
          clip = { x: 0, y, width: W, height: h };
        }
        const buf = await page.screenshot({ type: 'jpeg', quality: 55, clip });
        shots[t.id] = { data: 'data:image/jpeg;base64,' + buf.toString('base64'), url: t.url, viewport: vp, width: W, note: t.note || '', found: box.found, visible: box.visible, count: box.count || 0 };
      }
    } catch (e) { log && log(`Screenshot failed on ${list[0].url}: ${String(e.message).split('\n')[0]}`); for (const t of list) shots[t.id] = shots[t.id] || { failed: true }; }
    await page.close().catch(() => {});
  }
  for (const c of Object.values(ctxs)) await c.close().catch(() => {});
  return { shots, complete: !stopped && plan.every((t) => shots[tid(t)]) };
}

function buildPlan(issues, ctx, cfg) {
  const ORD = ['P0', 'P1', 'P2', 'P3'];
  const per = cfg.shotsPerIssue || 8;
  let budget = cfg.maxScreenshots == null ? 48 : cfg.maxScreenshots;
  const byIssue = {};
  for (const i of [...issues].filter((x) => x.sev !== 'INFO').sort((a, b) => ORD.indexOf(a.sev) - ORD.indexOf(b.sev))) {
    if (budget <= 0) break;
    const t = targetsFor(i, ctx, Math.min(per, budget));
    if (t.length) { byIssue[i.key] = t; budget -= t.length; }
  }
  return byIssue;
}

module.exports = { buildPlan, capture, tid, targetsFor };
