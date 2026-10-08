'use strict';
const fs = require('fs');
const pathMod = require('path');
const { groupOf } = require('./discover');
const { path } = require('./rules');

const HEAD = fs.readFileSync(pathMod.join(__dirname, 'template-head.html'), 'utf8');
const SCRIPT = fs.readFileSync(pathMod.join(__dirname, 'template-script.js'), 'utf8');
const ORD = ['P0', 'P1', 'P2', 'P3', 'INFO'];
const SEVL = { P0: 'P0 Critical', P1: 'P1 High', P2: 'P2 Medium', P3: 'P3 Low', INFO: 'Info' };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GROUP_NAMES = { home: 'Homepage', page: 'Pages' };

function nameGroup(g, n) {
  if (GROUP_NAMES[g]) return GROUP_NAMES[g];
  const arch = g.endsWith('-archive');
  const base = g.replace(/-archive$/, '').replace(/[-_]/g, ' ');
  const cap = base.charAt(0).toUpperCase() + base.slice(1);
  return arch ? `${cap} archives (${n})` : /^(blog|news|articles?)$/.test(base) ? `${cap} posts (${n})` : `${cap} (${n})`;
}

function pageName(u, pages) {
  const p = pages[u] || {};
  const t = ((p.h1 || [])[0] || (p.title || '').split(/\s[|–—-]\s/)[0] || path(u)).trim();
  return t.length > 48 ? t.slice(0, 46) + '…' : t;
}

// Assign each issue to a report section, number issues, pick verdict.
function organize(result, ctx) {
  const { cfg, pages, disc } = ctx;
  const allGroups = {};
  for (const u of disc.urls) { const g = groupOf(u, cfg); allGroups[g] = (allGroups[g] || 0) + 1; }
  const issues = result.issues.map((i) => ({ ...i, affects: [...new Set(i.affects || [])] }));
  for (const i of issues) {
    const gs = [...new Set(i.affects.map((u) => groupOf(u, cfg)))];
    if (!i.affects.length || gs.length >= 3 || (i.affects.length >= 3 && i.affects.length >= disc.urls.length * 0.5)) i.section = 'site-wide';
    else if (i.affects.length === 1) i.section = 'u:' + i.affects[0];
    else if (gs.length === 1) i.section = 'g:' + gs[0];
    else i.section = 'site-wide';
  }
  issues.sort((a, b) => ORD.indexOf(a.sev) - ORD.indexOf(b.sev));
  issues.forEach((i, n) => { i.id = 'QA-' + String(n + 1).padStart(2, '0'); });
  const secMap = new Map();
  for (const i of issues) {
    if (!secMap.has(i.section)) {
      let name, href = null, urlText, note = null;
      if (i.section === 'site-wide') { name = 'Site-wide'; urlText = 'All templates'; note = 'Issues that repeat on many templates. Fix once in the theme, shared patterns or global settings.'; }
      else if (i.section.startsWith('u:')) { const u = i.section.slice(2); name = u === cfg.url ? 'Homepage' : pageName(u, pages); href = u; urlText = cfg.host + path(u); }
      else { const g = i.section.slice(2); name = nameGroup(g, allGroups[g] || 0); const sample = disc.urls.find((u) => groupOf(u, cfg) === g); href = sample; urlText = `${cfg.host}/${g.replace(/-archive$/, '')}/…`; note = `${allGroups[g] || 0} URLs share this template. Findings repeat across them.`; }
      secMap.set(i.section, { key: i.section, slug: i.section === 'site-wide' ? 'site-wide' : (i.section.slice(2).replace(/^https?:\/\/[^/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'), name, href, urlText, note, issues: [] });
    }
    secMap.get(i.section).issues.push(i);
  }
  const rank = (s) => (s.key === 'site-wide' ? -2 : s.key === 'u:' + cfg.url ? -1 : Math.min(...s.issues.map((i) => ORD.indexOf(i.sev))));
  const sections = [...secMap.values()].sort((a, b) => rank(a) - rank(b));
  const cnt = Object.fromEntries(ORD.map((k) => [k, issues.filter((i) => i.sev === k).length]));
  let verdict, vcls;
  if (cnt.P0) { verdict = 'CRITICAL BLOCKER'; vcls = 'v-blocker'; }
  else if (cnt.P1 >= 5) { verdict = 'NOT READY'; vcls = 'v-notready'; }
  else if (cnt.P1 || cnt.P2) { verdict = 'READY WITH RISKS'; vcls = 'v-risks'; }
  else { verdict = 'READY'; vcls = 'v-ready'; }
  const reason = cnt.P0 ? `${cnt.P0} critical blocker${cnt.P0 > 1 ? 's' : ''}` : cnt.P1 ? `${cnt.P1} high-priority issue${cnt.P1 > 1 ? 's' : ''}` : cnt.P2 ? `${cnt.P2} medium issue${cnt.P2 > 1 ? 's' : ''}, nothing blocking` : 'No blocking issues';
  return { issues, sections, cnt, verdict, vcls, reason };
}

function lede(org, ctx) {
  const { cfg, disc, render } = ctx;
  const top = org.issues.filter((i) => i.sev === 'P0' || i.sev === 'P1').slice(0, 2);
  const next = org.issues.filter((i) => i.sev === 'P2').slice(0, 2);
  const s = [`${disc.urls.length} pages were crawled and ${Object.keys(render).length} were rendered on desktop and mobile.`];
  const lc = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  if (top.length) s.push(`Fix first: ${top.map((i) => lc(i.title.replace(/`/g, ''))).join('; and ')}.`);
  else s.push('Nothing blocks the site right now.');
  if (next.length) s.push(`Next: ${next.map((i) => lc(i.title.replace(/`/g, ''))).join('; and ')}.`);
  return s.join(' ');
}

function build(ctx, result, shots) {
  const { cfg, disc, render } = ctx;
  const org = organize(result, ctx);
  const d = new Date(ctx.startedAt);
  const dateStr = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const used = {};
  const card = (i) => {
    const sh = shots[i.key];
    let shotHtml = '';
    if (sh) { used[sh.key] = sh.data; shotHtml = `<div class="shots"><figure><button class="zoom" type="button" data-src="${sh.key}" aria-label="Enlarge screenshot: ${esc(sh.caption)}"><img alt="${esc(sh.caption)}" data-k="${sh.key}" loading="lazy"></button><figcaption>${esc(sh.caption)}</figcaption></figure></div>`; }
    const affects = i.affects.length ? (i.affects.length > 8 ? `${i.affects.length} URLs, e.g. ${i.affects.slice(0, 6).map(path).join(', ')}` : i.affects.map(path).join(', ')) : 'All pages';
    const fig = i.design && cfg.brand.designUrl ? `<a class="fig" href="${esc(cfg.brand.designUrl)}" target="_blank" rel="noopener">Design reference ↗</a>` : '';
    return `<article class="issue sev-${i.sev}" data-sev="${i.sev}" id="${i.id}">
<header class="ih"><span class="badge b-${i.sev}">${SEVL[i.sev]}</span><span class="cat">${esc(i.cat)}</span><span class="iid">${i.id}</span></header>
<h3>${rich(i.title)}</h3>
<p class="where"><span>Affects</span> ${esc(affects)}</p>
<div class="ea"><div><h4>Expected</h4><p>${rich(i.expected)}</p></div><div><h4>Actual</h4><p>${rich(i.actual)}</p></div></div>
${shotHtml}<div class="fix"><h4>Suggested fix</h4><p>${rich(i.fix)}${i.confidence !== 'HIGH' ? ` <em>(Confidence: ${i.confidence.toLowerCase()}.)</em>` : ''}</p>${fig}</div>
</article>`;
  };
  const secHtml = org.sections.map((s) => `<section class="page" id="p-${s.slug}"><div class="ph"><h2>${esc(s.name)}</h2>${s.href ? `<a href="${esc(s.href)}" target="_blank" rel="noopener" class="url">${esc(s.urlText)}</a>` : `<span class="url">${esc(s.urlText)}</span>`}<span class="src">Design source: ${esc(cfg.brand.designLabel || (cfg.brand.headingFonts.length || cfg.brand.colors.length ? 'Brand profile (fonts and colours)' : 'None configured'))}</span>${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}</div>
${s.issues.map(card).join('\n')}
</section>`).join('\n');
  const idx = org.sections.map((s) => `<a class="pi" href="#p-${s.slug}"><span class="pn">${esc(s.name)}</span><span class="pills">${ORD.filter((k) => s.issues.some((i) => i.sev === k)).map((k) => `<span class="mini b-${k}">${s.issues.filter((i) => i.sev === k).length}</span>`).join('')}</span></a>`).join('');
  const groups = {};
  disc.urls.forEach((u) => { const g = groupOf(u, cfg); groups[g] = (groups[g] || 0) + 1; });
  const scope = `${disc.urls.length} URLs${disc.truncated ? ` (capped; ${disc.totalFound} found)` : ''}; ${Object.keys(render).length} rendered`;
  const design = cfg.brand.designUrl ? `<a href="${esc(cfg.brand.designUrl)}" target="_blank" rel="noopener">${esc(cfg.brand.designLabel || 'Design file')}</a>` : esc(cfg.brand.headingFonts.length || cfg.brand.colors.length ? 'Brand profile' : 'None');
  const method = [
    `Design source: ${cfg.brand.headingFonts.length || cfg.brand.bodyFonts.length ? `brand fonts ${[...cfg.brand.headingFonts, ...cfg.brand.bodyFonts].join(', ')}` : 'no brand fonts configured'}${cfg.brand.colors.length ? `; palette ${cfg.brand.colors.map((h) => '#' + h).join(', ')}` : ''}. Computed fonts and colours were measured on every rendered page. Page layouts weren't compared with a design, because this app checks rules, not mockups. Layout fidelity is UNVERIFIABLE.`,
    `Scope: URLs came from ${disc.method === 'sitemap' ? `the XML sitemap (${disc.sitemaps.filter((s) => s.ok && !s.index).length} files)` : 'a link crawl from the homepage'}. Each was fetched and its HTML checked for status, SEO, headings, alt text, links and phone links. ${Object.keys(ctx.links.internal).length} extra internal link targets were requested${cfg.checkExternalLinks ? `, plus ${Object.keys(ctx.links.external).length} external links` : ''}. ${Object.keys(render).length} pages (every template plus a sample of posts) were rendered in Chromium at ${cfg.viewports.desktop}px and ${cfg.viewports.mobile}px to measure fonts, colours, contrast, overflow, focus, keyboard reach and images. The mobile menu was tapped. Performance used ${cfg.perfRuns} cold-cache runs per page on ${(ctx.perf || []).length} pages. All checks were passive: no forms submitted and no security probing.`,
    `Detected stack: ${ctx.stack.join('; ') || 'not identified'}.`,
  ];
  const body = `<div class="wrap">
<header class="top">
  <span class="eyebrow">QA audit · ${esc(cfg.environment)} · ${dateStr}</span>
  <h1>${esc(cfg.siteName)}</h1>
  <div class="meta">
    <span><b>Site</b> ${esc(cfg.host)}</span>
    <span><b>Scope</b> ${esc(scope)}</span>
    <span><b>Viewports</b> ${cfg.viewports.desktop}px desktop, ${cfg.viewports.mobile}px mobile</span>
    <span><b>Design</b> ${design}</span>
  </div>
  <div class="status">
    <div class="verdict ${org.vcls}"><strong>${org.verdict}</strong><span>${esc(org.reason)}</span></div>
    <div class="sevbar">${ORD.map((k) => `<div class="sc b-${k}"><span class="n">${org.cnt[k]}</span><span class="l">${SEVL[k]}</span></div>`).join('')}</div>
  </div>
  <p class="lede">${esc(lede(org, ctx))}</p>
</header>

<nav class="toolbar" aria-label="Filter issues by severity"><button type="button" class="chip on" data-f="all" aria-pressed="true">All <span>${org.issues.length}</span></button>${ORD.map((k) => `<button type="button" class="chip" data-f="${k}" aria-pressed="false">${SEVL[k]} <span>${org.cnt[k]}</span></button>`).join('')}</nav>

<nav class="index" aria-label="Pages">${idx}</nav>
${secHtml}
<section class="page" id="passes"><div class="ph"><h2>What passed</h2></div><ul class="passes">${result.passes.map((p) => `<li>${rich(p)}</li>`).join('')}</ul></section>
<section class="page" id="method"><div class="ph"><h2>How this was checked</h2></div><div class="method">${method.map((p) => `<p>${rich(p)}</p>`).join('')}</div></section>
</div>
<dialog id="lb" aria-label="Screenshot"><button type="button" id="lbx">Close</button><img id="lbi" alt=""></dialog>
<script>
${SCRIPT.replace('__IMGS__', JSON.stringify(used)).replace(/\{\{site-slug\}\}/g, cfg.host.replace(/[^a-z0-9]/gi, '-'))}
</script>`;
  const head = HEAD.replace('{{TITLE}}', esc(cfg.siteName) + ' QA Audit');
  // Artifact-ready fragment (claude.ai adds the skeleton) and a standalone document for local viewing.
  const fragment = head + '\n' + body;
  const standalone = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}<style>body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style></head><body>\n${body}\n</body></html>`;
  return { org, fragment, standalone };
}

function asanaMarkdown(org, ctx) {
  const { cfg } = ctx;
  const plain = (s) => String(s || '').replace(/`/g, '`');
  return org.issues.filter((i) => i.sev !== 'INFO').map((i) => `# 🚨 ${i.id}: ${plain(i.title)}

**Priority:** ${i.sev}
**Category:** ${i.cat}
**Implementation:** ${ctx.stack.slice(0, 2).join(' / ') || 'Unknown'}
**Environment:** ${cfg.environment}
**URL:** ${i.affects[0] || cfg.url}
**Design:** ${i.design && cfg.brand.designUrl ? cfg.brand.designUrl : 'n/a'}
**Report:** ${cfg.siteName} QA Audit#${i.id}
**Detected:** ${new Date(ctx.startedAt).toISOString()}

## 📋 Issue Description

${plain(i.title)}.

**Affects:** ${i.affects.length ? i.affects.slice(0, 20).join(', ') + (i.affects.length > 20 ? ` (+${i.affects.length - 20} more)` : '') : 'All pages'}

## 🔍 Steps to Reproduce

1. Open \`${i.evidence ? i.evidence.url : i.affects[0] || cfg.url}\`${i.evidence ? ` at ${i.evidence.viewport === 'mobile' ? cfg.viewports.mobile : cfg.viewports.desktop}px` : ''}
${i.evidence && i.evidence.sel ? `2. Inspect \`${i.evidence.sel}\`\n3. Compare with the expected result below` : '2. Compare with the expected result below'}

## 💻 Expected

${plain(i.expected)}

## ❌ Actual

${plain(i.actual)}

## 🧩 Likely Source

${i.design ? 'Theme / block settings' : i.cat === 'SEO' ? 'SEO plugin / content' : i.cat === 'Security' ? 'Server / CDN' : 'Theme / content'}

**Confidence:** ${i.confidence}

## 🛠️ Suggested Developer Fix

${plain(i.fix)}

## ✅ Acceptance Criteria

- [ ] Expected behaviour restored on all affected URLs
- [ ] Re-running the QA audit no longer reports ${i.id}
- [ ] No regression introduced
`).join('\n---\n\n');
}

function resultsJson(org, ctx, result) {
  return {
    audit: { status: org.verdict.replace(/ /g, '_'), environment: ctx.cfg.environment, site: ctx.cfg.url, startedAt: new Date(ctx.startedAt).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - ctx.startedAt },
    design: { source: ctx.cfg.brand.designUrl || 'profile', headingFonts: ctx.cfg.brand.headingFonts, bodyFonts: ctx.cfg.brand.bodyFonts, colors: ctx.cfg.brand.colors, layoutCompliance: 'UNVERIFIABLE' },
    implementation: { stack: ctx.stack },
    summary: { pagesTested: ctx.disc.urls.length, pagesRendered: Object.keys(ctx.render).length, bySeverity: org.cnt, passes: result.passes.length },
    issues: org.issues.map((i) => ({ id: i.id, rule: i.key, severity: i.sev, category: i.cat, title: i.title, section: i.section, affects: i.affects, expected: i.expected, actual: i.actual, recommendation: i.fix, confidence: i.confidence, evidence: i.evidence })),
    passes: result.passes,
    perf: ctx.perf,
    menu: ctx.menu,
  };
}

module.exports = { build, asanaMarkdown, resultsJson, esc };
