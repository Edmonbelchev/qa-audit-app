'use strict';
// End-to-end test: start the fixture site, audit it, and check that every planted defect is reported.
process.env.FIXTURE_PORT = process.env.FIXTURE_PORT || '4599';
const fs = require('fs');
const path = require('path');
const server = require('./fixture/server');
const { build } = require('../src/config');
const { runAudit } = require('../src/audit');

const EXPECT = {
  'sitemap-errors': '/gone/ in sitemap returns 404',
  'tel-mismatch': 'button shows 800-555-0100 but dials 678',
  'tel-unexpected': '404-620-6848 not in approved list',
  'tel-empty': 'empty tel link on /services/fire/',
  'broken-internal': 'posts link to /services/old/fire-damage/',
  'font-headings': 'Barlow Condensed H1 not loaded',
  'font-body': 'Archivo body text',
  colors: 'off-palette #222222 / #C9C8C8',
  contrast: '#BBBBBB on white',
  'mouse-only': 'FAQ div toggles',
  labels: 'unlabeled name field on contact',
  'overflow-mobile': '620px box on /about/',
  inline: '170 KB inline CSS on home',
  'no-desc': 'blog + category without description',
  'long-title': 'post titles repeat brand',
  'h1-multi': 'posts with two H1s',
  jsonld: 'invalid JSON-LD on post 4',
  og: 'contact without og:image',
  headers: 'missing HSTS/CSP etc.',
  'version-leak': 'X-Powered-By PHP/7.4.33',
  'img-alt': 'team.svg without alt',
};

(async () => {
  const { config, errors } = build({
    url: `http://localhost:${process.env.FIXTURE_PORT}`,
    siteName: 'Fixture Co',
    renderSample: 14,
    perfRuns: 2,
    perfPages: 2,
    brand: { headingFonts: 'Fixture Serif', bodyFonts: 'Poppins', colors: '#A6263F, #4D4C4C, #0D0D0D, #FFFFFF, #FFC800, #EFEFEF', designUrl: 'https://www.figma.com/design/example', designLabel: 'Brand 1-Pager' },
    phones: { expected: '800-555-0100, 608-555-0199, 414-555-0177' },
    legacyRedirects: '/old-services/ -> /services/',
  });
  if (errors.length) throw new Error(errors.join('; '));
  const t0 = Date.now();
  const out = await runAudit(config, { log: (m) => console.log('  ·', m) });
  const dir = path.join(__dirname, 'output');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.html'), out.html);
  fs.writeFileSync(path.join(dir, 'qa-results.json'), JSON.stringify(out.json, null, 1));
  fs.writeFileSync(path.join(dir, 'asana-tickets.md'), out.md);
  const found = new Set(out.issueKeys);
  let fail = 0;
  for (const [k, why] of Object.entries(EXPECT)) {
    const ok = found.has(k);
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${k.padEnd(18)} ${why}`);
  }
  const legacyPass = out.json.passes.some((p) => /legacy/i.test(p));
  console.log(`${legacyPass ? 'PASS' : 'FAIL'}  legacy-redirect    /old-services/ 301 → /services/`);
  if (!legacyPass) fail++;
  const menuPass = out.json.menu && out.json.menu.result === 'PASS';
  console.log(`${menuPass ? 'PASS' : 'FAIL'}  mobile-menu        drawer opens and closes`);
  if (!menuPass) fail++;
  console.log(`\nVerdict ${out.summary.verdict} ${JSON.stringify(out.summary.counts)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`Report: ${path.join(dir, 'report.html')}`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
