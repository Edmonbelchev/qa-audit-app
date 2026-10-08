'use strict';
// Web app: audit form, job queue with live progress, report history and share links.
// Storage is local disk by default, or Vercel Blob when BLOB_READ_WRITE_TOKEN is set (see src/storage.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { build } = require('./src/config');
const { runAudit } = require('./src/audit');
const { createStorage } = require('./src/storage');
const shares = require('./src/shares');
const { loadProfile } = require('./src/wp-profile');

const PORT = +process.env.PORT || 4317;
const ON_VERCEL = !!process.env.VERCEL;
const HOST = process.env.HOST || (ON_VERCEL ? '0.0.0.0' : '127.0.0.1');
const store = createStorage(process.env, { root: ON_VERCEL ? path.join('/tmp', 'qa-audit-data') : path.join(__dirname, 'data') });

// ───────────── Jobs
// Local server: one audit at a time, start to finish.
// Serverless (Vercel, or QA_STEP_SECONDS set): each invocation runs one time-boxed step, saves a checkpoint
// (audits/<id>/state.json) and calls /api/audits/<id>/continue to start the next step in a fresh invocation.
const STEP_MS = process.env.QA_STEP_SECONDS ? +process.env.QA_STEP_SECONDS * 1000 : ON_VERCEL ? 240000 : 0;
const LEASE_MS = STEP_MS + (+process.env.QA_LEASE_GRACE_SECONDS || 60) * 1000;
const jobs = new Map(); // id -> live state in this instance
const queue = [];
let running = null;

function background(promise) {
  const p = Promise.resolve(promise).catch((e) => console.error('Audit error:', e));
  if (ON_VERCEL) { try { require('@vercel/functions').waitUntil(p); } catch { /* local */ } }
  return p;
}
function scheduleNext() { background(next()); }

const metaKey = (id) => `audits/${id}/meta.json`;
const stateKey = (id) => `audits/${id}/state.json`;
const send = (res, code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }); res.end(type === 'application/json' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body); };
const readBody = (req) => new Promise((ok, no) => {
  if (req.body !== undefined) return ok(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}); // pre-parsed by a host runtime
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
});
const publicJob = (j) => ({ id: j.id, status: j.status, stage: j.stage, progress: j.progress, log: j.log.slice(-60), error: j.error, summary: j.summary, position: queue.indexOf(j.id) });
// Stalled = should be running but no step holds its lease (a hand-off failed or a step was killed).
const isStalled = (m) => (m.status === 'running' || m.status === 'queued') && !jobs.has(m.id) && !queue.includes(m.id) && (m.leaseUntil || 0) < Date.now();
const MAX_RESTARTS = 4;
const kicked = new Map(); // id -> last kick time (this instance)
// Restart stalled audits automatically. Called whenever the app is polled, and by the optional cron route.
function kickStalled(metas) {
  for (const m of metas) {
    if (!isStalled(m)) continue;
    if (Date.now() - (kicked.get(m.id) || 0) < 20000) continue;
    kicked.set(m.id, Date.now());
    if (STEP_MS) background(runStep(m.id, { restart: true }));
    else { queue.push(m.id); scheduleNext(); }
  }
}

async function listAudits(limit = 200) {
  const keys = (await store.list('audits/')).filter((k) => k.endsWith('/meta.json')).sort().reverse().slice(0, limit);
  const metas = await Promise.all(keys.map((k) => store.readJSON(k)));
  return metas.filter(Boolean).map((m) => {
    const out = jobs.has(m.id) ? { ...m, ...publicJob(jobs.get(m.id)) } : { ...m };
    out.stalled = isStalled(m);
    delete out.input; delete out.log; delete out.runToken;
    out.shareCount = (m.shares || []).length;
    return out;
  }).sort((a, b) => b.createdAt - a.createdAt);
}

// Local queue
async function next() {
  if (running || !queue.length) return;
  const id = queue.shift();
  running = id;
  try { await runStep(id); } finally { running = null; scheduleNext(); }
}

function selfBase() {
  if (process.env.QA_SELF_URL) return process.env.QA_SELF_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  return `http://127.0.0.1:${PORT}`;
}

async function chain(id, token) {
  const headers = { 'x-qa-run-token': token };
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${selfBase()}/api/audits/${id}/continue`, { method: 'POST', headers });
      if (r.status === 202) return true;
      console.error(`Continue ${id}: HTTP ${r.status}`);
    } catch (e) { console.error(`Continue ${id}:`, e.message); }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return false;
}

// Runs one step (serverless) or the whole audit (local). Safe to call again for a stalled audit.
async function runStep(id, { restart = false } = {}) {
  let meta = await store.readJSON(metaKey(id));
  if (!meta || meta.status === 'done' || meta.status === 'error') return;
  if (STEP_MS && (meta.leaseUntil || 0) > Date.now() && meta.leaseOwner !== 'create') return; // another invocation is on it
  if (restart) {
    meta.restarts = (meta.restarts || 0) + 1;
    if (meta.restarts > MAX_RESTARTS) {
      await store.writeJSON(metaKey(id), { ...meta, status: 'error', error: `Stopped after ${MAX_RESTARTS} automatic restarts during “${meta.stage || 'start'}”. A step keeps getting killed, usually from running out of memory. Lower “Pages to render” or raise the function memory, then run it again.`, finishedAt: Date.now(), leaseUntil: undefined });
      return;
    }
  }
  // Claim the lease, then confirm nobody else claimed it at the same moment.
  const leaseOwner = crypto.randomBytes(6).toString('hex');
  if (STEP_MS) {
    await store.writeJSON(metaKey(id), { ...meta, leaseUntil: Date.now() + LEASE_MS, leaseOwner });
    await new Promise((r) => setTimeout(r, 800));
    const check = await store.readJSON(metaKey(id));
    if (!check || check.leaseOwner !== leaseOwner) return;
    meta = check;
  }
  const saved = (await store.readJSON(stateKey(id))) || {};
  const logArr = saved.log || [];
  const j = { id, status: 'running', stage: (saved.audit && saved.audit.phase) || 'discover', progress: { done: 0, total: 1 }, log: logArr, summary: null };
  jobs.set(id, j);
  meta = { ...meta, status: 'running', error: undefined, steps: (meta.steps || 0) + 1, leaseUntil: STEP_MS ? Date.now() + LEASE_MS : 0, leaseOwner };
  await store.writeJSON(metaKey(id), meta);
  const { config } = build(meta.input || {});
  if (STEP_MS) config.renderConcurrency = 1; // one page at a time keeps Chromium within serverless memory
  let lastSave = 0;
  let saving = null;
  const persist = (force) => {
    if (saving || (!force && Date.now() - lastSave < 3000)) return;
    lastSave = Date.now();
    saving = store.readJSON(metaKey(id)).then((latest) => store.writeJSON(metaKey(id), { ...meta, shares: (latest && latest.shares) || meta.shares || [], stage: j.stage, progress: j.progress, log: j.log.slice(-30) })).catch(() => {}).finally(() => { saving = null; });
  };
  const log = (m) => { j.log.push(`${new Date().toISOString().slice(11, 19)}  ${m}`); persist(); };
  const stage = (s, d, t) => { j.stage = s; j.progress = { done: d, total: t }; persist(); };
  if (meta.steps > 1) log(`Continuing (step ${meta.steps})`);
  let paused = false;
  try {
    const checkpoint = STEP_MS ? (S) => store.writeJSON(stateKey(id), { audit: S, log: j.log.slice(-300) }).then(() => store.readJSON(metaKey(id))).then((mm) => mm && mm.leaseOwner === leaseOwner && store.writeJSON(metaKey(id), { ...mm, checkpoint: true, restarts: 0 })).catch(() => {}) : null;
    const out = await runAudit(config, { log, stage, state: saved.audit || null, deadline: STEP_MS ? Date.now() + STEP_MS : null, checkpoint });
    await store.write(`audits/${id}/report.html`, out.html, 'text/html; charset=utf-8');
    await store.write(`audits/${id}/artifact.html`, out.fragment, 'text/plain; charset=utf-8');
    await store.writeJSON(`audits/${id}/qa-results.json`, out.json);
    await store.write(`audits/${id}/asana-tickets.md`, out.md, 'text/markdown; charset=utf-8');
    j.status = 'done';
    j.summary = out.summary;
    Object.assign(meta, { status: 'done', summary: out.summary, finishedAt: Date.now(), checkpoint: false, restarts: undefined, leaseOwner: undefined });
    log(`Done: ${out.summary.verdict}`);
  } catch (e) {
    if (e && e.paused) {
      paused = true;
      log(`Time budget reached. Saving progress and continuing in a new step…`);
      await store.writeJSON(stateKey(id), { audit: e.state, log: j.log.slice(-300) });
      Object.assign(meta, { status: 'running', checkpoint: true, leaseUntil: 0, leaseOwner: undefined, restarts: 0, stage: j.stage, progress: j.progress });
    } else {
      j.status = 'error';
      j.error = String((e && e.message) || e).split('\n')[0];
      Object.assign(meta, { status: 'error', error: j.error, finishedAt: Date.now(), checkpoint: false });
      log('Failed: ' + j.error);
    }
  }
  if (saving) await saving;
  const latest = (await store.readJSON(metaKey(id))) || {};
  const final = { ...meta, shares: latest.shares || meta.shares || [], log: paused ? j.log.slice(-30) : undefined };
  if (!paused) { final.stage = undefined; final.progress = undefined; final.leaseUntil = undefined; await store.write(`audits/${id}/log.txt`, j.log.join('\n'), 'text/plain; charset=utf-8'); await store.remove(stateKey(id)).catch(() => {}); }
  await store.writeJSON(metaKey(id), final);
  jobs.delete(id);
  if (paused) {
    const ok = await chain(id, meta.runToken);
    if (!ok) console.error(`Could not start the next step for ${id}. It restarts automatically the next time the app is opened or polled.`);
  }
}

// ───────────── Pages
const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css' };
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', md: 'text/markdown; charset=utf-8' };
const FILES = ['report.html', 'artifact.html', 'qa-results.json', 'asana-tickets.md'];
const SHARE_FILES = { 'tickets.md': 'asana-tickets.md', 'results.json': 'qa-results.json' };

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http')).split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function sharePage(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>:root{--bg:#f3f5f8;--ink:#152033;--muted:#566275;--line:#dde3ec;--card:#fff}@media(prefers-color-scheme:dark){:root{--bg:#0f1520;--ink:#e6ebf3;--muted:#9aa6b8;--line:#2a3548;--card:#172030}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif;padding:16px}main{max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:28px}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:var(--muted)}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

const SHARE_HEADERS = { 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer', 'cache-control': 'private, no-store', 'x-frame-options': 'SAMEORIGIN' };

async function handle(req, res) {
  const u = new URL(req.url, 'http://local');
  const p = u.pathname;
  let m;
  try {
    // ── Public share links
    if ((m = p.match(/^\/s\/([A-Za-z0-9_-]+)(?:\/(tickets\.md|results\.json))?\/?$/)) && req.method === 'GET') {
      const share = await shares.get(store, m[1]);
      const st = shares.state(share);
      if (st === 'missing') return send(res, 404, sharePage('Link not found', 'This report link doesn’t exist. Check that you copied the whole link.'), TYPES.html, SHARE_HEADERS);
      if (st === 'revoked') return send(res, 410, sharePage('Link turned off', 'The owner turned off this report link. Ask them for a new one.'), TYPES.html, SHARE_HEADERS);
      if (st === 'expired') return send(res, 410, sharePage('Link expired', `This report link expired on ${new Date(share.expiresAt).toDateString()}. Ask the owner for a new one.`), TYPES.html, SHARE_HEADERS);
      const file = m[2] ? SHARE_FILES[m[2]] : 'report.html';
      if (m[2] && !share.includeFiles) return send(res, 404, sharePage('Not shared', 'Only the report was shared through this link.'), TYPES.html, SHARE_HEADERS);
      const buf = await store.read(`audits/${share.auditId}/${file}`);
      if (!buf) return send(res, 404, sharePage('Report unavailable', 'The report behind this link was deleted.'), TYPES.html, SHARE_HEADERS);
      if (!m[2]) shares.touch(store, share);
      const extra = m[2] ? { 'content-disposition': `attachment; filename="${share.auditId}-${file}"` } : {};
      return send(res, 200, buf, TYPES[file.split('.').pop()], { ...SHARE_HEADERS, ...extra });
    }

    if (req.method === 'GET' && STATIC[p]) { const f = STATIC[p]; return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', f)), TYPES[f.split('.').pop()]); }

    if (p === '/api/info' && req.method === 'GET') return send(res, 200, { storage: store.kind, durable: !(ON_VERCEL && store.kind === 'local disk'), publicUrl: process.env.PUBLIC_URL || null });

    if (p === '/api/profiles' && req.method === 'GET') {
      let all = await store.readJSON('profiles.json');
      if (!all) { all = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'default-profiles.json'), 'utf8')); await store.writeJSON('profiles.json', all); }
      return send(res, 200, all);
    }
    if (p === '/api/profiles' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return send(res, 400, { error: 'Give the profile a name.' });
      const all = (await store.readJSON('profiles.json')) || {}; all[name] = b.config || {}; await store.writeJSON('profiles.json', all);
      return send(res, 200, { ok: true, name });
    }
    if ((m = p.match(/^\/api\/profiles\/(.+)$/)) && req.method === 'DELETE') { const all = (await store.readJSON('profiles.json')) || {}; delete all[decodeURIComponent(m[1])]; await store.writeJSON('profiles.json', all); return send(res, 200, { ok: true }); }

    if (p === '/api/audits' && req.method === 'GET') { const list = await listAudits(); kickStalled(list); return send(res, 200, list); }
    if (p === '/api/cron/resume' && req.method === 'GET') { const list = await listAudits(); const n = list.filter(isStalled).length; kickStalled(list); return send(res, 200, { restarted: n }); }
    if (p === '/api/audits' && req.method === 'POST') {
      const b = await readBody(req);
      const { config, errors } = build(b);
      if (errors.length) return send(res, 400, { error: errors.join(' ') });
      const id = new Date().toISOString().slice(0, 10) + '-' + config.host.replace(/[^a-z0-9]+/gi, '-') + '-' + crypto.randomBytes(3).toString('hex');
      await store.writeJSON(metaKey(id), { id, site: config.url, siteName: config.siteName, environment: config.environment, createdAt: Date.now(), status: 'queued', input: b, shares: [], runToken: crypto.randomBytes(18).toString('base64url'), leaseUntil: Date.now() + 30000, leaseOwner: 'create' });
      if (STEP_MS) background(runStep(id));
      else { jobs.set(id, { id, status: 'queued', stage: 'queued', progress: { done: 0, total: 1 }, log: [], summary: null }); queue.push(id); scheduleNext(); }
      return send(res, 202, { id });
    }

    // Brand rules from a WordPress site (Application Password; not stored)
    if (p === '/api/wp/profile' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await loadProfile(b)); }
      catch (e) { return send(res, e.code && e.code < 600 ? e.code : 500, { error: e.message }); }
    }

    // Next step of a serverless audit (called by the previous step)
    if ((m = p.match(/^\/api\/audits\/([\w-]+)\/continue$/)) && req.method === 'POST') {
      const meta = await store.readJSON(metaKey(m[1]));
      if (!meta || !meta.runToken || req.headers['x-qa-run-token'] !== meta.runToken) return send(res, 403, { error: 'Invalid run token.' });
      background(runStep(m[1]));
      return send(res, 202, { ok: true });
    }
    // Resume a stalled audit from its checkpoint (UI button)
    if ((m = p.match(/^\/api\/audits\/([\w-]+)\/resume$/)) && req.method === 'POST') {
      const meta = await store.readJSON(metaKey(m[1]));
      if (!meta) return send(res, 404, { error: 'Audit not found.' });
      if (!isStalled(meta)) return send(res, 409, { error: 'This audit is not stalled.' });
      background(runStep(m[1]));
      return send(res, 202, { ok: true });
    }

    // Shares for an audit
    if ((m = p.match(/^\/api\/audits\/([\w-]+)\/shares$/))) {
      if (req.method === 'GET') { const list = await shares.listForAudit(store, m[1]); return list ? send(res, 200, list.map((s) => ({ ...s, url: `${baseUrl(req)}/s/${s.token}` }))) : send(res, 404, { error: 'Audit not found.' }); }
      if (req.method === 'POST') {
        const b = await readBody(req);
        try { const s = await shares.create(store, m[1], b); return send(res, 201, { ...s, state: 'active', url: `${baseUrl(req)}/s/${s.token}` }); }
        catch (e) { return send(res, e.code || 500, { error: e.message }); }
      }
    }
    if ((m = p.match(/^\/api\/shares\/([A-Za-z0-9_-]+)$/)) && req.method === 'DELETE') {
      return (await shares.revoke(store, m[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Link not found.' });
    }

    if ((m = p.match(/^\/api\/audits\/([\w-]+)$/))) {
      const id = m[1];
      const meta = await store.readJSON(metaKey(id));
      if (!meta) return send(res, 404, { error: 'Audit not found.' });
      if (req.method === 'DELETE') {
        if (running === id || jobs.has(id) || (meta.status === 'running' && !isStalled(meta))) return send(res, 409, { error: 'This audit is running. Wait for it to finish.' });
        const qi = queue.indexOf(id); if (qi >= 0) queue.splice(qi, 1);
        jobs.delete(id);
        await shares.removeAllForAudit(store, id, meta);
        await store.remove(`audits/${id}/`);
        return send(res, 200, { ok: true });
      }
      const live = jobs.get(id);
      delete meta.runToken;
      meta.stalled = isStalled(meta);
      if (meta.stalled) kickStalled([meta]);
      if (live) return send(res, 200, { ...meta, ...publicJob(live) });
      if (!meta.log) { const t = await store.readText(`audits/${id}/log.txt`); meta.log = t ? t.split('\n').slice(-60) : []; }
      return send(res, 200, meta);
    }
    if ((m = p.match(/^\/reports\/([\w-]+)\/([\w.-]+)$/)) && FILES.includes(m[2])) {
      const buf = await store.read(`audits/${m[1]}/${m[2]}`);
      if (!buf) return send(res, 404, 'Not found', 'text/plain');
      const ext = m[2].split('.').pop();
      const extra = u.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${m[1]}-${m[2]}"` } : {};
      return send(res, 200, buf, m[2] === 'artifact.html' ? 'text/plain; charset=utf-8' : TYPES[ext], extra);
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message || e) });
  }
}

const server = http.createServer(handle);

// Mark audits interrupted by a restart (long-running server only)
async function recover() {
  for (const m of await listAudits(1000)) if (m.status === 'running' || m.status === 'queued') {
    const full = await store.readJSON(metaKey(m.id));
    // Interrupted by a restart: continue from the checkpoint, or start again if there is none.
    await store.writeJSON(metaKey(m.id), { ...full, leaseUntil: 0, leaseOwner: undefined });
    if (!STEP_MS) { queue.push(m.id); }
  }
}

module.exports = handle; // Vercel: api/server.js re-exports this handler
module.exports.server = server;
module.exports.store = store;

if (require.main === module) {
  recover().catch(() => {}).finally(() => { scheduleNext(); server.listen(PORT, HOST, () => console.log(`QA Audit running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  ·  storage: ${store.kind}`)); });
}
