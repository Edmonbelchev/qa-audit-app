'use strict';
// Local web app: audit form, job queue with live progress, report history. No external deps besides Playwright.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { build } = require('./src/config');
const { runAudit } = require('./src/audit');

const PORT = +process.env.PORT || 4317;
const HOST = process.env.HOST || (process.env.VERCEL ? '0.0.0.0' : '127.0.0.1');
const DATA = process.env.QA_DATA_DIR || (process.env.VERCEL ? path.join('/tmp', 'qa-audit-data') : path.join(__dirname, 'data'));
const AUDITS = path.join(DATA, 'audits');
const PROFILES = path.join(DATA, 'profiles.json');
fs.mkdirSync(AUDITS, { recursive: true });
if (!fs.existsSync(PROFILES)) fs.copyFileSync(path.join(__dirname, 'src', 'default-profiles.json'), PROFILES);

const jobs = new Map(); // id -> live state
const queue = [];
let running = null;

function scheduleNext() {
  const run = () => next().catch((e) => console.error('Audit queue error:', e));
  if (process.env.VERCEL) {
    try {
      const { waitUntil } = require('@vercel/functions');
      waitUntil(run());
      return;
    } catch { /* @vercel/functions unavailable locally */ }
  }
  setImmediate(run);
}

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const body = (req) => new Promise((ok, no) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); });

function listAudits() {
  return fs.readdirSync(AUDITS).map((id) => readJSON(path.join(AUDITS, id, 'meta.json'), null)).filter(Boolean)
    .map((m) => (jobs.has(m.id) ? { ...m, ...publicJob(jobs.get(m.id)) } : m))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function publicJob(j) { return { id: j.id, status: j.status, stage: j.stage, progress: j.progress, log: j.log.slice(-60), error: j.error, summary: j.summary, position: queue.indexOf(j.id) }; }

async function next() {
  if (running || !queue.length) return;
  const id = queue.shift();
  const j = jobs.get(id);
  running = id;
  j.status = 'running';
  const dir = path.join(AUDITS, id);
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  meta.status = 'running';
  writeJSON(path.join(dir, 'meta.json'), meta);
  const log = (m) => { j.log.push(`${new Date().toISOString().slice(11, 19)}  ${m}`); };
  const stage = (s, d, t) => { j.stage = s; j.progress = { done: d, total: t }; };
  try {
    const out = await runAudit(j.config, { log, stage });
    fs.writeFileSync(path.join(dir, 'report.html'), out.html);
    fs.writeFileSync(path.join(dir, 'artifact.html'), out.fragment);
    writeJSON(path.join(dir, 'qa-results.json'), out.json);
    fs.writeFileSync(path.join(dir, 'asana-tickets.md'), out.md);
    j.status = 'done';
    j.summary = out.summary;
    Object.assign(meta, { status: 'done', summary: out.summary, finishedAt: Date.now() });
    log(`Done: ${out.summary.verdict}`);
  } catch (e) {
    j.status = 'error';
    j.error = String(e && e.message || e).split('\n')[0];
    Object.assign(meta, { status: 'error', error: j.error, finishedAt: Date.now() });
    log('Failed: ' + j.error);
  }
  fs.writeFileSync(path.join(dir, 'log.txt'), j.log.join('\n'));
  writeJSON(path.join(dir, 'meta.json'), meta);
  running = null;
  scheduleNext();
}

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css' };
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', md: 'text/markdown; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && STATIC[p]) { const f = STATIC[p]; return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', f)), TYPES[f.split('.').pop()]); }

    if (p === '/api/profiles' && req.method === 'GET') return send(res, 200, readJSON(PROFILES, {}));
    if (p === '/api/profiles' && req.method === 'POST') {
      const b = await body(req);
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return send(res, 400, { error: 'Give the profile a name.' });
      const all = readJSON(PROFILES, {}); all[name] = b.config || {}; writeJSON(PROFILES, all);
      return send(res, 200, { ok: true, name });
    }
    let m;
    if ((m = p.match(/^\/api\/profiles\/(.+)$/)) && req.method === 'DELETE') { const all = readJSON(PROFILES, {}); delete all[decodeURIComponent(m[1])]; writeJSON(PROFILES, all); return send(res, 200, { ok: true }); }

    if (p === '/api/audits' && req.method === 'GET') return send(res, 200, listAudits());
    if (p === '/api/audits' && req.method === 'POST') {
      const b = await body(req);
      const { config, errors } = build(b);
      if (errors.length) return send(res, 400, { error: errors.join(' ') });
      const id = new Date().toISOString().slice(0, 10) + '-' + config.host.replace(/[^a-z0-9]+/gi, '-') + '-' + crypto.randomBytes(3).toString('hex');
      fs.mkdirSync(path.join(AUDITS, id), { recursive: true });
      writeJSON(path.join(AUDITS, id, 'meta.json'), { id, site: config.url, siteName: config.siteName, environment: config.environment, createdAt: Date.now(), status: 'queued', input: b });
      jobs.set(id, { id, config, status: 'queued', stage: 'queued', progress: { done: 0, total: 1 }, log: [], summary: null });
      queue.push(id);
      scheduleNext();
      return send(res, 202, { id });
    }
    if ((m = p.match(/^\/api\/audits\/([\w-]+)$/))) {
      const id = m[1];
      const dir = path.join(AUDITS, id);
      if (!fs.existsSync(dir)) return send(res, 404, { error: 'Audit not found.' });
      if (req.method === 'DELETE') {
        if (running === id) return send(res, 409, { error: 'This audit is running. Wait for it to finish.' });
        const qi = queue.indexOf(id); if (qi >= 0) queue.splice(qi, 1);
        jobs.delete(id); fs.rmSync(dir, { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
      const meta = readJSON(path.join(dir, 'meta.json'), {});
      const live = jobs.get(id);
      return send(res, 200, live ? { ...meta, ...publicJob(live) } : { ...meta, log: (fs.existsSync(path.join(dir, 'log.txt')) ? fs.readFileSync(path.join(dir, 'log.txt'), 'utf8').split('\n') : []).slice(-60) });
    }
    if ((m = p.match(/^\/reports\/([\w-]+)\/(report\.html|artifact\.html|qa-results\.json|asana-tickets\.md)$/))) {
      const f = path.join(AUDITS, m[1], m[2]);
      if (!fs.existsSync(f)) return send(res, 404, 'Not found', 'text/plain');
      const ext = m[2].split('.').pop();
      const headers = { 'content-type': m[2] === 'artifact.html' ? 'text/plain; charset=utf-8' : TYPES[ext], 'cache-control': 'no-store' };
      if (u.searchParams.has('download')) headers['content-disposition'] = `attachment; filename="${m[1]}-${m[2]}"`;
      res.writeHead(200, headers);
      return fs.createReadStream(f).pipe(res);
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

// Mark audits interrupted by a restart (local long-running server only)
if (!process.env.VERCEL) {
  for (const m of listAudits()) if (m.status === 'running' || m.status === 'queued') writeJSON(path.join(AUDITS, m.id, 'meta.json'), { ...m, status: 'error', error: 'Interrupted (server restarted)' });
}

module.exports = server;

if (!process.env.VERCEL) {
  server.listen(PORT, HOST, () => console.log(`QA Audit running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}
