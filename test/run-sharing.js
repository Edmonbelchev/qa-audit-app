'use strict';
// Tests storage drivers and share links end to end against the fixture site.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FsStorage, BlobStorage, wrap } = require('../src/storage');

let fail = 0;
const check = (ok, name) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory stand-in for @vercel/blob with the same call shapes (put/get/list/del).
function fakeBlobSdk() {
  const m = new Map();
  return {
    m,
    async put(pathname, body, o) { if (!o.allowOverwrite && m.has(pathname)) throw new Error('exists'); m.set(pathname, { body: Buffer.from(body), contentType: o.contentType, access: o.access }); return { url: 'https://blob/' + pathname, pathname }; },
    async get(pathname, o) { const b = m.get(pathname); if (!b) return null; if (b.access !== o.access) throw new Error('access mismatch'); return { statusCode: 200, stream: new Blob([b.body]).stream(), blob: { pathname } }; },
    async list({ prefix, cursor, limit }) { const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort(); const start = cursor ? +cursor : 0; const page = keys.slice(start, start + Math.min(limit, 2)); return { blobs: page.map((pathname) => ({ pathname, url: 'https://blob/' + pathname })), hasMore: start + page.length < keys.length, cursor: String(start + page.length) }; },
    async del(urls) { for (const u of [].concat(urls)) m.delete(u); },
  };
}

async function storageContract(name, store) {
  await store.writeJSON('audits/a1/meta.json', { id: 'a1' });
  await store.write('audits/a1/report.html', '<h1>hi</h1>', 'text/html');
  await store.writeJSON('audits/a2/meta.json', { id: 'a2' });
  await store.writeJSON('shares/tok.json', { token: 'tok' });
  const keys = (await store.list('audits/')).sort();
  check(JSON.stringify(keys) === JSON.stringify(['audits/a1/meta.json', 'audits/a1/report.html', 'audits/a2/meta.json']), `${name}: list across pages`);
  check((await store.readJSON('audits/a1/meta.json')).id === 'a1', `${name}: read JSON`);
  check((await store.readText('audits/a1/report.html')) === '<h1>hi</h1>', `${name}: read text`);
  check((await store.read('missing.json')) === null, `${name}: missing → null`);
  await store.remove('audits/a1/');
  check((await store.list('audits/')).length === 1, `${name}: remove prefix`);
  let threw = false; try { await store.read('../etc/passwd'); } catch { threw = true; }
  check(threw, `${name}: rejects path traversal`);
}

function startServer(env) {
  const p = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((ok) => { p.stdout.on('data', (d) => { if (/running at/.test(String(d))) ok(p); }); p.stderr.on('data', (d) => process.stderr.write(d)); });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-store-'));
  await storageContract('disk', wrap(new FsStorage(tmp)));
  const sdk = fakeBlobSdk();
  await storageContract('blob', wrap(new BlobStorage({ sdk, token: 'x', access: 'private', prefix: 'qa-audit' })));
  check([...sdk.m.keys()].every((k) => k.startsWith('qa-audit/')), 'blob: keys namespaced under prefix');

  // ── End to end
  process.env.FIXTURE_PORT = '4598';
  const fixture = require('./fixture/server');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-data-'));
  const base = 'http://127.0.0.1:4318';
  let srv = await startServer({ PORT: '4318', QA_DATA_DIR: data });
  const j = async (u, o = {}) => { const r = await fetch(base + u, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) }; };
  const { json: created } = await j('/api/audits', { method: 'POST', body: { url: 'http://localhost:4598', siteName: 'Fixture Co', renderSample: 3, perfRuns: 1, perfPages: 1 } });
  let meta;
  for (let i = 0; i < 120; i++) { meta = (await j('/api/audits/' + created.id)).json; if (meta.status === 'done' || meta.status === 'error') break; await sleep(1000); }
  check(meta.status === 'done', 'audit finished');
  const early = await j(`/api/audits/${created.id}/shares`, { method: 'POST', body: { days: 7 } });
  check(early.status === 201 && /\/s\/[A-Za-z0-9_-]{24}$/.test(early.json.url), 'create share link (7 days)');
  const tok = early.json.token;
  const r1 = await fetch(`${base}/s/${tok}`);
  const html = await r1.text();
  check(r1.status === 200 && /QA Audit/.test(html), 'share link opens report without auth');
  check(/noindex/.test(r1.headers.get('x-robots-tag') || '') && r1.headers.get('referrer-policy') === 'no-referrer', 'share link sends noindex + no-referrer');
  check((await fetch(`${base}/s/${tok}/tickets.md`)).status === 404, 'tickets hidden unless included');
  const withFiles = await j(`/api/audits/${created.id}/shares`, { method: 'POST', body: { days: 0, includeFiles: true, label: 'Client' } });
  check(withFiles.json.expiresAt === null, 'never-expiring link');
  const t2 = await fetch(`${base}/s/${withFiles.json.token}/tickets.md`);
  check(t2.status === 200 && /attachment/.test(t2.headers.get('content-disposition') || ''), 'included tickets download');
  await sleep(300);
  const listed = (await j(`/api/audits/${created.id}/shares`)).json;
  check(listed.length === 2 && listed.find((s) => s.token === tok).views >= 1, 'list shares with view count');
  check((await j('/api/shares/' + tok, { method: 'DELETE' })).status === 200 && (await fetch(`${base}/s/${tok}`)).status === 410, 'revoked link returns 410');
  const sf = path.join(data, 'shares', withFiles.json.token + '.json');
  const s = JSON.parse(fs.readFileSync(sf, 'utf8')); s.expiresAt = Date.now() - 1000; fs.writeFileSync(sf, JSON.stringify(s));
  check((await fetch(`${base}/s/${withFiles.json.token}`)).status === 410, 'expired link returns 410');
  check((await fetch(`${base}/s/AAAAAAAAAAAAAAAAAAAAAAAA`)).status === 404, 'unknown token returns 404');
  check((await fetch(`${base}/s/../../data/profiles.json`)).status !== 200, 'no traversal via share path');
  srv.kill();

  // ── Exposed without password: admin locked, shares still work
  srv = await startServer({ PORT: '4318', QA_DATA_DIR: data, HOST: '0.0.0.0' });
  check((await fetch(`${base}/api/audits`)).status === 503, 'exposed + no password → admin locked');
  const fresh = JSON.parse(fs.readFileSync(path.join(data, 'audits', created.id, 'meta.json'), 'utf8'));
  check(fresh.shares.length === 2, 'share tokens recorded on audit');
  srv.kill();

  // ── Password protection
  srv = await startServer({ PORT: '4318', QA_DATA_DIR: data, HOST: '0.0.0.0', QA_ADMIN_PASSWORD: 's3cret' });
  check((await fetch(`${base}/api/audits`)).status === 401, 'admin requires login');
  const auth = { authorization: 'Basic ' + Buffer.from('admin:s3cret').toString('base64') };
  check((await fetch(`${base}/api/audits`, { headers: auth })).status === 200, 'admin login works');
  const viaLogin = await fetch(`${base}/api/audits/${created.id}/shares`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"days":30}' }).then((r) => r.json());
  check((await fetch(`${base}/s/${viaLogin.token}`)).status === 200, 'share link works without login');
  // deleting the audit kills its links
  await fetch(`${base}/api/audits/${created.id}`, { method: 'DELETE', headers: auth });
  check((await fetch(`${base}/s/${viaLogin.token}`)).status === 404, 'deleting audit removes its links');
  srv.kill();
  fixture.close();
  console.log(fail ? `\n${fail} failed` : '\nAll sharing tests passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
