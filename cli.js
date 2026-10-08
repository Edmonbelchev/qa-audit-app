#!/usr/bin/env node
'use strict';
// CLI: node cli.js https://example.com [--profile "Name"] [--config file.json] [--out dir]
// Exit code 1 when P0/P1 issues are found (useful in CI).
const fs = require('fs');
const path = require('path');
const { build } = require('./src/config');
const { runAudit } = require('./src/audit');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const url = args.find((a) => !a.startsWith('--') && !/^--/.test(args[args.indexOf(a) - 1] || ''));
if (!url && !opt('profile') && !opt('config')) {
  console.log('Usage: node cli.js <url> [--profile "Saved profile name"] [--config profile.json] [--out ./qa-reports]');
  process.exit(2);
}
let input = {};
if (opt('profile')) {
  const pf = path.join(process.env.QA_DATA_DIR || path.join(__dirname, 'data'), 'profiles.json');
  const all = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'default-profiles.json'), 'utf8'));
  input = all[opt('profile')];
  if (!input) { console.error(`No profile named "${opt('profile')}". Available: ${Object.keys(all).join(', ')}`); process.exit(2); }
}
if (opt('config')) input = { ...input, ...JSON.parse(fs.readFileSync(opt('config'), 'utf8')) };
if (url) input.url = url;
const { config, errors } = build(input);
if (errors.length) { console.error(errors.join('\n')); process.exit(2); }
const out = opt('out') || path.join(process.cwd(), 'qa-reports');

runAudit(config, { log: (m) => console.log('·', m) }).then((r) => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'qa-report.html'), r.html);
  fs.writeFileSync(path.join(out, 'qa-report.artifact.html'), r.fragment);
  fs.writeFileSync(path.join(out, 'qa-results.json'), JSON.stringify(r.json, null, 1));
  fs.writeFileSync(path.join(out, 'asana-tickets.md'), r.md);
  console.log(`\n${r.summary.verdict}  ${JSON.stringify(r.summary.counts)}\nReport: ${path.join(out, 'qa-report.html')}`);
  process.exit(r.summary.counts.P0 || r.summary.counts.P1 ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(3); });
