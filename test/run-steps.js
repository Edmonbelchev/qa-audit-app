'use strict';
// Serverless mode test: forces short steps (QA_STEP_SECONDS) so one audit is split across many
// checkpointed steps that chain through /api/audits/<id>/continue, like on Vercel.
// Set QA_USE_SPARTICUZ=1 to run with @sparticuz/chromium (the Vercel browser) where it is installed.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.FIXTURE_PORT = '4596';
const fixture = require('./fixture/server');
const PORT = 4320;
const base = `http://127.0.0.1:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-steps-'));
let fail = 0;
const check = (ok, name) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fail++; };

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), QA_DATA_DIR: data, QA_STEP_SECONDS: process.env.QA_STEP_SECONDS || '8' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => srv.stdout.on('data', (d) => /running at/.test(String(d)) && ok()));
  const body = { url: 'http://localhost:4596', siteName: 'Fixture Co', renderSample: 14, perfRuns: 2, perfPages: 2, brand: { headingFonts: 'Fixture Serif', bodyFonts: 'Poppins', colors: '#A6263F,#4D4C4C,#0D0D0D,#FFFFFF,#FFC800,#EFEFEF' }, phones: { expected: '800-555-0100, 608-555-0199, 414-555-0177' } };
  const { id } = await fetch(base + '/api/audits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  let meta; let seen = new Set();
  for (let i = 0; i < 300; i++) {
    meta = await fetch(`${base}/api/audits/${id}`).then((r) => r.json());
    if (meta.stage) seen.add(meta.stage);
    if (meta.status === 'done' || meta.status === 'error') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check(meta.status === 'done', `audit finished (${meta.status}${meta.error ? ': ' + meta.error : ''})`);
  check(meta.steps > 2, `split into ${meta.steps} steps`);
  check(!fs.existsSync(path.join(data, 'audits', id, 'state.json')), 'checkpoint removed after finishing');
  const json = await fetch(`${base}/reports/${id}/qa-results.json`).then((r) => r.json());
  if (!json.issues) throw new Error('No results: ' + JSON.stringify(json).slice(0, 200));
  const rules = new Set(json.issues.map((i) => i.rule));
  for (const k of ['tel-mismatch', 'broken-internal', 'font-headings', 'mouse-only', 'overflow-mobile', 'contrast', 'headers']) check(rules.has(k), `found ${k} across steps`);
  check(json.summary.pagesRendered === 14, 'all sampled pages rendered once');
  const log = await fetch(`${base}/api/audits/${id}`).then((r) => r.json()).then((m) => m.log || []);
  check(log.some((l) => /Continuing \(step/.test(l)), 'log carries over between steps');
  console.log(`\nVerdict ${json.audit.status} ${JSON.stringify(json.summary.bySeverity)} in ${meta.steps} steps`);
  srv.kill();

  // ── Killed mid-audit: a new server picks it up automatically when the app is polled
  const start = () => { const p = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), QA_DATA_DIR: data, QA_STEP_SECONDS: '8', QA_LEASE_GRACE_SECONDS: '2' }, stdio: ['ignore', 'pipe', 'inherit'] }); return new Promise((ok) => p.stdout.on('data', (d) => /running at/.test(String(d)) && ok(p))); };
  let s1 = await start();
  const { id: id2 } = await fetch(base + '/api/audits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, renderSample: 8 }) }).then((r) => r.json());
  for (let i = 0; i < 60; i++) { const m = await fetch(`${base}/api/audits/${id2}`).then((r) => r.json()); if (m.stage === 'render') break; await new Promise((r) => setTimeout(r, 500)); }
  s1.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 12000)); // lease runs out
  const s2 = await start();
  let m2;
  for (let i = 0; i < 300; i++) { m2 = await fetch(`${base}/api/audits/${id2}`).then((r) => r.json()); if (m2.status === 'done' || m2.status === 'error') break; await fetch(base + '/api/audits'); await new Promise((r) => setTimeout(r, 1000)); }
  check(m2.status === 'done', `killed audit resumed automatically and finished (${m2.status}${m2.error ? ': ' + m2.error : ''})`);
  s2.kill(); fixture.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
