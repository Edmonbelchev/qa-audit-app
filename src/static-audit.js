'use strict';
const { request, pool } = require('./http');
const { extractStatic } = require('./extract');
const { normalize, sameSite, NON_PAGE } = require('./discover');

// opts.existing: pages already done (resume); opts.stop(): return true to stop taking new URLs (time budget).
async function staticAudit(cfg, urls, browser, log, progress, opts = {}) {
  const pages = opts.existing || {};
  const todo = urls.filter((u) => !pages[u]);
  let homeHeaders = opts.homeHeaders || null;
  if (!todo.length) return { pages, homeHeaders, complete: true };
  const page = await browser.newPage();
  const base = urls.length - todo.length;
  let stopped = false;
  await pool(todo, cfg.concurrency, async (u) => {
    if (stopped || (opts.stop && opts.stop())) { stopped = true; return; }
    const r = await request(u, cfg);
    const rec = { url: u, status: r.status, finalUrl: r.finalUrl, hops: r.hops, ms: r.ms, ttfb: r.ttfb, error: r.error || null, bytes: (r.text || '').length, contentType: (r.headers || {})['content-type'] || '' };
    if (u === cfg.url) homeHeaders = r.headers || {};
    if (r.status === 200 && /html/.test(rec.contentType)) {
      try { Object.assign(rec, await page.evaluate(extractStatic, { html: r.text, url: r.finalUrl })); }
      catch (e) { if (!browser.isConnected()) { stopped = true; return; } rec.parseError = String(e.message || e).slice(0, 200); }
    }
    pages[u] = rec;
  }, (done) => progress && progress(base + done, urls.length));
  await page.close().catch(() => {});
  return { pages, homeHeaders, complete: urls.every((u) => pages[u]) };
}

async function linkAudit(cfg, pages, log, progress) {
  const crawled = new Set(Object.keys(pages));
  const internal = new Map(); // target -> Set(sources)
  const external = new Map();
  for (const [u, p] of Object.entries(pages)) {
    for (const l of p.links || []) {
      if (!l.abs || !/^https?:/i.test(l.abs)) continue;
      const n = normalize(l.abs);
      if (!n) continue;
      if (sameSite(n, cfg)) {
        if (/\/wp-(admin|login)|\/cdn-cgi\/|\/feed\/?$|[?&](replytocom|share)=/.test(n)) continue;
        if (crawled.has(n) && pages[n].status === 200 && !(pages[n].hops || []).length) continue;
        if (!internal.has(n)) internal.set(n, new Set());
        internal.get(n).add(u);
      } else if (cfg.checkExternalLinks) {
        if (!external.has(n)) external.set(n, new Set());
        external.get(n).add(u);
      }
    }
  }
  const targets = [...internal.keys()];
  log && log(`Checking ${targets.length} internal link targets outside the sitemap`);
  const results = {};
  await pool(targets, cfg.concurrency, async (t) => {
    const known = pages[t];
    const r = known ? { status: known.status, hops: known.hops, finalUrl: known.finalUrl } : await request(t, cfg, { body: false });
    results[t] = { url: t, status: r.status, hops: r.hops || [], finalUrl: r.finalUrl, error: r.error || null, sources: [...internal.get(t)], nonPage: NON_PAGE.test(t) };
  }, progress);
  const ext = {};
  if (cfg.checkExternalLinks) {
    const list = [...external.keys()].slice(0, cfg.externalLinkCap);
    log && log(`Checking ${list.length} external links`);
    await pool(list, cfg.concurrency, async (t) => {
      let r = await request(t, cfg, { method: 'HEAD', body: false });
      if (r.status === 405 || r.status === 403 || r.status === 0) r = await request(t, cfg, { body: false });
      ext[t] = { url: t, status: r.status, error: r.error || null, sources: [...external.get(t)] };
    });
  }
  return { internal: results, external: ext };
}

async function legacyAudit(cfg, log) {
  const out = [];
  for (const { from, to } of cfg.legacyRedirects) {
    const u = normalize(from, cfg.origin);
    if (!u) continue;
    const r = await request(u, cfg, { body: false });
    const expected = to ? normalize(to, cfg.origin) : null;
    out.push({ from: u, expected, status: r.status, first: (r.hops[0] || {}).status || r.status, hops: r.hops.length, final: r.finalUrl, ok: (r.hops[0] || {}).status === 301 && r.status === 200 && (!expected || r.finalUrl === expected) && r.hops.length <= 1 });
  }
  if (out.length) log && log(`Checked ${out.length} legacy redirects`);
  return out;
}

module.exports = { staticAudit, linkAudit, legacyAudit };
