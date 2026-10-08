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

async function captureEvidence(browser, cfg, issues, log) {
  const shots = {};
  const want = issues.filter((i) => i.evidence && i.evidence.url && i.sev !== 'INFO').sort((a, b) => ['P0', 'P1', 'P2', 'P3'].indexOf(a.sev) - ['P0', 'P1', 'P2', 'P3'].indexOf(b.sev)).slice(0, 10);
  const ctxs = {};
  for (const i of want) {
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

async function runAudit(cfg, { log = () => {}, stage = () => {} } = {}) {
  const startedAt = Date.now();
  const browser = await launchBrowser();
  try {
    stage('discover', 0, 1);
    log(`Discovering URLs on ${cfg.url}`);
    const disc = await discover(cfg, log);
    log(`${disc.urls.length} URLs to audit (${disc.method})`);

    stage('static', 0, disc.urls.length);
    const { pages, homeHeaders } = await staticAudit(cfg, disc.urls, browser, log, (d, t) => stage('static', d, t));
    log(`Fetched and parsed ${Object.keys(pages).length} pages`);

    stage('links', 0, 1);
    const links = await linkAudit(cfg, pages, log, (d, t) => stage('links', d, t));
    const legacy = await legacyAudit(cfg, log);

    const sample = pickRenderSample(cfg, disc.urls.filter((u) => pages[u] && pages[u].status === 200));
    log(`Rendering ${sample.length} pages at ${cfg.viewports.desktop}px and ${cfg.viewports.mobile}px`);
    stage('render', 0, sample.length);
    const render = await renderAudit(cfg, browser, sample, log, (d, t) => stage('render', d, t));
    const menu = await menuTest(cfg, browser);
    log(`Mobile menu: ${menu.result}`);

    stage('perf', 0, 1);
    const perfUrls = [cfg.url, ...sample.filter((u) => u !== cfg.url && groupOf(u, cfg) !== groupOf(cfg.url, cfg))].filter((u, i, a) => a.indexOf(u) === i);
    const byGroup = []; const seenG = new Set();
    for (const u of perfUrls) { const g = groupOf(u, cfg); if (!seenG.has(g) || u === cfg.url) { seenG.add(g); byGroup.push(u); } }
    const perf = await perfAudit(cfg, browser, byGroup.slice(0, Math.max(1, cfg.perfPages)), log);

    const ctx = { cfg, disc, pages, homeHeaders: homeHeaders || {}, links, legacy, render, menu, perf, startedAt };
    ctx.stack = detectStack(pages[cfg.url], ctx.homeHeaders, disc);
    stage('report', 0, 1);
    const result = rules.run(ctx);
    log(`${result.issues.length} issues, ${result.passes.length} passes`);
    const shots = await captureEvidence(browser, cfg, result.issues, log);
    const built = report.build(ctx, result, shots);
    const json = report.resultsJson(built.org, ctx, result);
    const md = report.asanaMarkdown(built.org, ctx);
    stage('done', 1, 1);
    return { issueKeys: result.issues.map((i) => i.key), html: built.standalone, fragment: built.fragment, json, md, summary: { verdict: built.org.verdict, counts: built.org.cnt, pages: disc.urls.length, rendered: sample.length, durationMs: Date.now() - startedAt } };
  } finally {
    await browser.close();
  }
}

module.exports = { runAudit, pickRenderSample, detectStack };
