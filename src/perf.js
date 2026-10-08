'use strict';

const INIT = () => {
  window.__qa = { lcp: null, lcpEl: null, cls: 0, long: 0 };
  try {
    new PerformanceObserver((l) => { const e = l.getEntries(); const x = e[e.length - 1]; window.__qa.lcp = x.startTime; const el = x.element; window.__qa.lcpEl = el ? { tag: el.tagName, src: (x.url || '').split('/').pop().slice(0, 80), lazy: el.getAttribute && el.getAttribute('loading'), fetchpriority: el.getAttribute && el.getAttribute('fetchpriority') } : null; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__qa.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { window.__qa.long += l.getEntries().length; }).observe({ type: 'longtask', buffered: true });
  } catch {}
};

async function measure(browser, url, cfg) {
  const ctx = await browser.newContext({ viewport: { width: cfg.viewports.desktop, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  const res = [];
  page.on('requestfinished', async (req) => {
    try {
      const s = await req.sizes();
      const r = await req.response();
      res.push({ url: req.url(), type: req.resourceType(), status: r ? r.status() : 0, body: s.responseBodySize, tx: s.responseBodySize + s.responseHeadersSize });
    } catch {}
  });
  const out = { url };
  try {
    await page.goto(url, { waitUntil: 'load', timeout: cfg.timeoutMs });
    try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {}
    Object.assign(out, await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return { ttfb: Math.round(n.responseStart - n.startTime), dcl: Math.round(n.domContentLoadedEventEnd - n.startTime), load: Math.round(n.loadEventEnd - n.startTime), htmlKB: Math.round(n.decodedBodySize / 1024), htmlTxKB: Math.round(n.transferSize / 1024), lcp: window.__qa.lcp ? Math.round(window.__qa.lcp) : null, lcpEl: window.__qa.lcpEl, cls: +window.__qa.cls.toFixed(3), longTasks: window.__qa.long };
    }));
  } catch (e) { out.error = String(e.message || e).split('\n')[0]; }
  out.resources = res;
  await ctx.close();
  return out;
}

const median = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

async function perfAudit(cfg, browser, urls, log, opts = {}) {
  const out = opts.existing || [];
  for (const u of urls) {
    if (out.some((x) => x.url === u)) continue;
    if ((opts.stop && opts.stop()) || !browser.isConnected()) break;
    const runs = [];
    for (let i = 0; i < Math.max(1, cfg.perfRuns); i++) runs.push(await measure(browser, u, cfg));
    const ok = runs.filter((r) => !r.error);
    const last = ok[ok.length - 1] || runs[0];
    const res = last.resources || [];
    const own = (r) => { try { return new URL(r.url).host.replace(/^www\./, '') === cfg.host.replace(/^www\./, ''); } catch { return false; } };
    const summary = {
      url: u,
      runs: runs.map((r) => ({ ttfb: r.ttfb, dcl: r.dcl, load: r.load, lcp: r.lcp, cls: r.cls, error: r.error })),
      median: { ttfb: median(ok.map((r) => r.ttfb)), dcl: median(ok.map((r) => r.dcl)), load: median(ok.map((r) => r.load)), lcp: median(ok.map((r) => r.lcp)), cls: ok.length ? Math.max(...ok.map((r) => r.cls || 0)) : null },
      htmlKB: last.htmlKB, htmlTxKB: last.htmlTxKB, lcpEl: last.lcpEl, longTasks: last.longTasks,
      requests: res.length,
      totalKB: Math.round(res.reduce((a, r) => a + (r.body || 0), 0) / 1024),
      thirdPartyRequests: res.filter((r) => !own(r)).length,
      thirdPartyKB: Math.round(res.filter((r) => !own(r)).reduce((a, r) => a + (r.body || 0), 0) / 1024),
      bigAssets: res.filter((r) => /^(stylesheet|script)$/.test(r.type) && r.body > cfg.budgets.assetKB * 1024).map((r) => ({ url: r.url.slice(0, 200), type: r.type, kb: Math.round(r.body / 1024), own: own(r) })).sort((a, b) => b.kb - a.kb).slice(0, 15),
      bigImages: res.filter((r) => r.type === 'image' && r.body > 300 * 1024).map((r) => ({ url: r.url.slice(0, 200), kb: Math.round(r.body / 1024) })).slice(0, 10),
      failed: res.filter((r) => r.status >= 400).map((r) => ({ url: r.url.slice(0, 200), status: r.status })).slice(0, 10),
    };
    out.push(summary);
    log && log(`Performance ${new URL(u).pathname}: TTFB median ${summary.median.ttfb} ms, LCP ${summary.median.lcp} ms`);
  }
  return { perf: out, complete: urls.every((u) => out.some((x) => x.url === u)) };
}

module.exports = { perfAudit };
