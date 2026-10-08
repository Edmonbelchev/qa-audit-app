'use strict';
const { analyzeRendered, findMenuToggle, menuState } = require('./render-checks');
const { pool } = require('./http');

async function settle(page) {
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
  // Scroll through the page so lazy images and scroll-reveal sections reach their final state.
  await page.evaluate(async () => {
    const step = Math.max(400, innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight && y < 40000; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
    scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
    try { await document.fonts.ready; } catch {}
  });
}

async function renderOne(ctx, url, cfg, vpName, collectNet) {
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failed = [];
  const responses = [];
  if (collectNet) {
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push('Uncaught: ' + String(e.message).slice(0, 200)));
    page.on('requestfailed', (r) => failed.push({ url: r.url().slice(0, 200), error: (r.failure() || {}).errorText || 'failed' }));
    page.on('response', (r) => { if (r.status() >= 400) failed.push({ url: r.url().slice(0, 200), status: r.status() }); else responses.push(r); });
  }
  let result = { url, viewport: vpName };
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: cfg.timeoutMs });
    result.status = resp ? resp.status() : 0;
    await settle(page);
    result.analysis = await page.evaluate(analyzeRendered, { brand: cfg.brand, ignore: cfg.ignoreSelectors, width: cfg.viewports[vpName], mobile: vpName === 'mobile' });
    if (collectNet) {
      result.consoleErrors = consoleErrors.slice(0, 20);
      result.failed = failed.filter((f) => !/google|doubleclick|bing|clarity|facebook|hotjar|crazyegg/.test(f.url) || f.status >= 500).slice(0, 20);
      result.thirdPartyFailed = failed.filter((f) => /google|doubleclick|bing|clarity|facebook|hotjar|crazyegg/.test(f.url)).length;
      const hosts = {};
      for (const r of responses) { try { const h = new URL(r.url()).host; hosts[h] = (hosts[h] || 0) + 1; } catch {} }
      result.hosts = hosts;
      // cross-site multisite uploads actually requested
      result.foreignUploads = [...new Set(responses.map((r) => r.url()).filter((u) => /\/wp-content\/uploads\/sites\/\d+\//.test(u)).map((u) => u.match(/sites\/(\d+)\//)[1] + '|' + u.split('/').pop().slice(0, 60)))];
    }
  } catch (e) {
    result.error = String(e.message || e).split('\n')[0].slice(0, 200);
  }
  await page.close();
  return result;
}

async function renderAudit(cfg, browser, urls, log, progress) {
  const out = {};
  const ctxs = {
    desktop: await browser.newContext({ viewport: { width: cfg.viewports.desktop, height: 900 }, userAgent: undefined }),
    mobile: await browser.newContext({ viewport: { width: cfg.viewports.mobile, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }),
  };
  let done = 0;
  await pool(urls, 2, async (u) => {
    const d = await renderOne(ctxs.desktop, u, cfg, 'desktop', true);
    const m = await renderOne(ctxs.mobile, u, cfg, 'mobile', false);
    out[u] = { desktop: d, mobile: m };
    done++;
    progress && progress(done, urls.length);
  });
  await ctxs.desktop.close();
  await ctxs.mobile.close();
  return out;
}

async function menuTest(cfg, browser) {
  const ctx = await browser.newContext({ viewport: { width: cfg.viewports.mobile, height: 812 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const r = { url: cfg.url };
  try {
    await page.goto(cfg.url, { waitUntil: 'load', timeout: cfg.timeoutMs });
    await settle(page);
    r.toggle = await page.evaluate(findMenuToggle);
    if (!r.toggle) { r.result = 'NOT_FOUND'; }
    else {
      await page.locator('[data-qa-menu]').first().tap({ timeout: 5000 }).catch(() => page.locator('[data-qa-menu]').first().click({ timeout: 5000 }));
      await page.waitForFunction((before) => { const b = document.querySelector('[data-qa-menu]'); return (b && b.getAttribute('aria-expanded') === 'true') || [...document.querySelectorAll('nav a, header a')].filter((a) => a.getBoundingClientRect().height > 0).length > before; }, r.toggle.links, { timeout: 2500 }).catch(() => {});
      r.open = await page.evaluate(menuState);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => { const b = document.querySelector('[data-qa-menu]'); return !b || b.getAttribute('aria-expanded') !== 'true'; }, null, { timeout: 1500 }).catch(() => {});
      r.afterEscape = await page.evaluate(menuState);
      const opened = r.open.links > r.toggle.links || r.open.controlsVisible === true || r.open.expanded === 'true';
      r.result = opened ? 'PASS' : 'FAIL';
      r.ariaUpdates = r.toggle.expanded !== null && r.open.expanded === 'true';
      r.escapeCloses = r.afterEscape.expanded === 'false' || r.afterEscape.links < r.open.links;
    }
  } catch (e) { r.result = 'ERROR'; r.error = String(e.message || e).split('\n')[0]; }
  await ctx.close();
  return r;
}

module.exports = { renderAudit, menuTest, settle };
