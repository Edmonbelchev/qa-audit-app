'use strict';
const { launchBrowser } = require('./browser');
const { discover, groupOf } = require('./discover');
const { staticAudit, linkAudit, legacyAudit } = require('./static-audit');
const { renderAudit, menuTest, settle } = require('./render-audit');
const { perfAudit } = require('./perf');
const rules = require('./rules');
const report = require('./report');

function detectStack(home, headers, disc) {
  const s = [];
  if (!home) return s;
  const assets = [...(home.scripts || []), ...(home.stylesheets || [])].join(' ');
  const bc = home.bodyClass || '';
  const wp = /wp-content|wp-includes/.test(assets) || /wp-/.test(bc);
  if (wp) s.push('WordPress' + ((home.uploadsSites || []).length ? ` multisite (site ${home.uploadsSites[0]})` : ''));
  const host = [];
  if (/WP Engine/i.test(headers['x-powered-by'] || '')) host.push('WP Engine');
  if (headers['x-kinsta-cache']) host.push('Kinsta');
  if (/flywheel/i.test(headers['x-fw-server'] || '')) host.push('Flywheel');
  if (headers['x-pantheon-styx-hostname']) host.push('Pantheon');
  if (headers['cf-ray']) host.push('Cloudflare');
  if (/cloudfront/i.test(headers['via'] || '') || headers['x-amz-cf-id']) host.push('CloudFront');
  if (host.length) s.push(host.join(' + '));
  const theme = (bc.match(/wp-theme-([\w-]+)/) || assets.match(/\/themes\/([\w-]+)\//) || [])[1];
  if (theme) s.push(`theme “${theme}”`);
  const builders = [];
  if (/elementor/.test(assets + bc)) builders.push('Elementor');
  if (/et_divi|divi/i.test(assets + bc)) builders.push('Divi');
  if (/js_composer|wpb_/.test(assets + bc)) builders.push('WPBakery');
  if (/bricks/.test(assets + bc)) builders.push('Bricks');
  if (/oxygen/.test(assets + bc)) builders.push('Oxygen');
  if (/fl-builder/.test(assets + bc)) builders.push('Beaver Builder');
  if (/wp-block|block-library|wp-embed-responsive/.test(assets + bc)) builders.push('Gutenberg blocks');
  if (builders.length) s.push(builders.join(' + '));
  const plugins = [];
  const P = [[/woocommerce/, 'WooCommerce'], [/gravityforms|gform/, 'Gravity Forms'], [/contact-form-7/, 'Contact Form 7'], [/wpforms/, 'WPForms'], [/fluentform/, 'Fluent Forms'], [/yoast|wordpress-seo/, 'Yoast SEO'], [/rank-math|rankmath/, 'Rank Math'], [/all-in-one-seo|aioseo/, 'AIOSEO'], [/wpml/, 'WPML'], [/polylang/, 'Polylang'], [/acf|advanced-custom-fields/, 'ACF'], [/cookiebot|cookieyes|complianz|cookie-law/, 'cookie consent'], [/googletagmanager/, 'Google Tag Manager'], [/clarity\.ms/, 'Microsoft Clarity'], [/callrail/, 'CallRail'], [/hotjar/, 'Hotjar'], [/crazyegg/, 'CrazyEgg'], [/trustindex/, 'Trustindex'], [/bat\.bing/, 'Bing UET'], [/facebook\.net/, 'Meta Pixel'], [/wp-rocket|rocket-/, 'WP Rocket'], [/litespeed/, 'LiteSpeed Cache'], [/autoptimize/, 'Autoptimize']];
  const hay = assets + ' ' + JSON.stringify(home.ld || []) + ' ' + (home.generator || '');
  for (const [re, n] of P) if (re.test(hay)) plugins.push(n);
  if (disc && disc.sitemaps.some((x) => /sitemap_index/.test(x.url)) && !plugins.some((p) => /SEO|Rank/.test(p))) plugins.push('Yoast or Rank Math (sitemap_index.xml)');
  if (home.generator) plugins.push(home.generator);
  if (plugins.length) s.push(plugins.join(', '));
  return s;
}

function pickRenderSample(cfg, urls) {
  const groups = new Map();
  for (const u of urls) { const g = groupOf(u, cfg); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(u); }
  const pick = [cfg.url];
  const small = [...groups].filter(([, v]) => v.length <= 25);
  const big = [...groups].filter(([, v]) => v.length > 25);
  for (const [, v] of small) for (const u of v) if (!pick.includes(u)) pick.push(u);
  // 1 representative per big group first, then fill evenly
  for (const [, v] of big) if (!pick.includes(v[0])) pick.push(v[0]);
  const budget = Math.max(cfg.renderSample, 1);
  let i = 1;
  while (pick.length < budget && big.length) {
    let added = false;
    for (const [, v] of big) {
      const idx = Math.floor((i * v.length) / 6) % v.length;
      if (v[idx] && !pick.includes(v[idx]) && pick.length < budget) { pick.push(v[idx]); added = true; }
    }
    i++;
    if (!added && i > 12) break;
  }
  return pick.slice(0, Math.max(budget, Math.min(pick.length, budget)));
}

async function captureEvidence(browser, cfg, issues, log, stop) {
  const shots = {};
  const want = issues.filter((i) => i.evidence && i.evidence.url && i.sev !== 'INFO').sort((a, b) => ['P0', 'P1', 'P2', 'P3'].indexOf(a.sev) - ['P0', 'P1', 'P2', 'P3'].indexOf(b.sev)).slice(0, 10);
  const ctxs = {};
  for (const i of want) {
    if ((stop && stop()) || !browser.isConnected()) { log && log('Skipped remaining screenshots (time budget)'); break; }
    const vp = i.evidence.viewport === 'mobile' ? 'mobile' : 'desktop';
    if (!ctxs[vp]) ctxs[vp] = await browser.newContext(vp === 'mobile' ? { viewport: { width: cfg.viewports.mobile, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { viewport: { width: cfg.viewports.desktop, height: 760 } });
    const page = await ctxs[vp].newPage();
    try {
      await page.goto(i.evidence.url, { waitUntil: 'load', timeout: cfg.timeoutMs });
      await settle(page);
      let found = false;
      if (i.evidence.sel) {
        found = await page.evaluate((sel) => {
          let el; try { el = document.querySelector(sel); } catch { return false; }
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.style.setProperty('outline', '3px solid #ff2d95', 'important');
          el.style.setProperty('outline-offset', '3px', 'important');
          return true;
        }, i.evidence.sel);
      }
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 350))));
      const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
      const key = i.key.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '-' + vp;
      shots[i.key] = { key, data: 'data:image/jpeg;base64,' + buf.toString('base64'), caption: `${vp === 'mobile' ? cfg.viewports.mobile + 'px mobile' : cfg.viewports.desktop + 'px desktop'}, ${rules.path(i.evidence.url)}${found ? ' (highlighted in pink)' : ''}` };
    } catch (e) { log && log(`Screenshot failed for ${i.key}: ${String(e.message).split('\n')[0]}`); }
    await page.close();
  }
  for (const c of Object.values(ctxs)) await c.close();
  return shots;
}

class Paused extends Error { constructor(state) { super('paused'); this.paused = true; this.state = state; } }

// Runs an audit. Resumable: pass `state` from a previous Paused error to continue where it stopped.
// `deadline` (ms timestamp) makes it stop between pages and throw Paused, so serverless hosts can
// split one audit across several function invocations. Without a deadline it runs to the end.
async function runAudit(cfg, { log = () => {}, stage = () => {}, state = null, deadline = null } = {}) {
  const S = state || { startedAt: Date.now(), phase: 'discover' };
  const out = (ms) => deadline && Date.now() > deadline - (ms || 0);
  const stop = () => out();
  const pause = () => { throw new Paused(S); };
  let browser = null;
  const getBrowser = async () => {
    if (browser && browser.isConnected()) return browser;
    if (browser) { log('Browser restarted'); try { await browser.close(); } catch {} }
    browser = await launchBrowser();
    return browser;
  };
  // Re-run a resumable step until complete; restarts the browser if it crashed, gives up after 3 tries without progress.
  const loop = async (name, run, count) => {
    let stuck = 0;
    for (;;) {
      const before = count();
      const r = await run(await getBrowser());
      if (r.complete) return r;
      if (out()) pause();
      if (count() === before && ++stuck >= 3) throw new Error(`${name} made no progress (browser keeps crashing). Try a lower "Pages to render" or more function memory.`);
    }
  };
  try {
    if (S.phase === 'discover') {
      stage('discover', 0, 1);
      log(`Discovering URLs on ${cfg.url}`);
      S.disc = await discover(cfg, log);
      log(`${S.disc.urls.length} URLs to audit (${S.disc.method})`);
      S.pages = {};
      S.phase = 'static';
    }
    if (S.phase === 'static') {
      stage('static', Object.keys(S.pages).length, S.disc.urls.length);
      const r = await loop('Crawl', (b) => staticAudit(cfg, S.disc.urls, b, log, (d, t) => stage('static', d, t), { existing: S.pages, homeHeaders: S.homeHeaders, stop }), () => Object.keys(S.pages).length);
      S.homeHeaders = r.homeHeaders || {};
      log(`Fetched and parsed ${Object.keys(S.pages).length} pages`);
      S.phase = 'links';
      if (out(60000)) pause();
    }
    if (S.phase === 'links') {
      stage('links', 0, 1);
      S.links = await linkAudit(cfg, S.pages, log, (d, t) => stage('links', d, t));
      S.legacy = await legacyAudit(cfg, log);
      S.sample = pickRenderSample(cfg, S.disc.urls.filter((u) => S.pages[u] && S.pages[u].status === 200));
      S.render = {};
      log(`Rendering ${S.sample.length} pages at ${cfg.viewports.desktop}px and ${cfg.viewports.mobile}px`);
      S.phase = 'render';
      if (out(60000)) pause();
    }
    if (S.phase === 'render') {
      stage('render', Object.keys(S.render).length, S.sample.length);
      await loop('Rendering', (b) => renderAudit(cfg, b, S.sample, log, (d, t) => stage('render', d, t), { existing: S.render, stop }), () => Object.keys(S.render).length);
      S.menu = await menuTest(cfg, await getBrowser());
      log(`Mobile menu: ${S.menu.result}`);
      const perfUrls = [cfg.url, ...S.sample.filter((u) => u !== cfg.url && groupOf(u, cfg) !== groupOf(cfg.url, cfg))].filter((u, i, a) => a.indexOf(u) === i);
      const byGroup = []; const seenG = new Set();
      for (const u of perfUrls) { const g = groupOf(u, cfg); if (!seenG.has(g) || u === cfg.url) { seenG.add(g); byGroup.push(u); } }
      S.perfUrls = byGroup.slice(0, Math.max(1, cfg.perfPages));
      S.perf = [];
      S.phase = 'perf';
      if (out(60000)) pause();
    }
    if (S.phase === 'perf') {
      stage('perf', S.perf.length, S.perfUrls.length);
      await loop('Speed test', (b) => perfAudit(cfg, b, S.perfUrls, log, { existing: S.perf, stop }), () => S.perf.length);
      S.phase = 'report';
      if (out(90000)) pause(); // evidence screenshots need a fresh time budget
    }
    // report
    const ctx = { cfg, disc: S.disc, pages: S.pages, homeHeaders: S.homeHeaders || {}, links: S.links, legacy: S.legacy, render: S.render, menu: S.menu, perf: S.perf, startedAt: S.startedAt };
    ctx.stack = detectStack(S.pages[cfg.url], ctx.homeHeaders, S.disc);
    stage('report', 0, 1);
    const result = rules.run(ctx);
    log(`${result.issues.length} issues, ${result.passes.length} passes`);
    const shots = await captureEvidence(await getBrowser(), cfg, result.issues, log, stop);
    const built = report.build(ctx, result, shots);
    const json = report.resultsJson(built.org, ctx, result);
    const md = report.asanaMarkdown(built.org, ctx);
    stage('done', 1, 1);
    return { issueKeys: result.issues.map((i) => i.key), html: built.standalone, fragment: built.fragment, json, md, summary: { verdict: built.org.verdict, counts: built.org.cnt, pages: S.disc.urls.length, rendered: S.sample.length, durationMs: Date.now() - S.startedAt } };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runAudit, Paused, pickRenderSample, detectStack };
