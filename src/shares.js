'use strict';
// Share links: unguessable tokens that open one report without logging in.
// Stored as shares/<token>.json; the audit's meta.json keeps a list of its tokens for the UI.
const crypto = require('crypto');

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const DAY = 86400000;

function newToken() { return crypto.randomBytes(18).toString('base64url'); } // 144 bits

async function create(store, auditId, { days = 30, includeFiles = false, label = '' } = {}) {
  const meta = await store.readJSON(`audits/${auditId}/meta.json`);
  if (!meta) throw Object.assign(new Error('Audit not found.'), { code: 404 });
  if (meta.status !== 'done') throw Object.assign(new Error('Only finished audits can be shared.'), { code: 409 });
  const d = Number(days);
  const share = {
    token: newToken(),
    auditId,
    label: String(label || '').slice(0, 80),
    includeFiles: !!includeFiles,
    createdAt: Date.now(),
    expiresAt: d > 0 ? Date.now() + Math.min(d, 3650) * DAY : null,
    revokedAt: null,
    views: 0,
    lastViewedAt: null,
  };
  await store.writeJSON(`shares/${share.token}.json`, share);
  meta.shares = [...(meta.shares || []), share.token];
  await store.writeJSON(`audits/${auditId}/meta.json`, meta);
  return share;
}

async function get(store, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  return store.readJSON(`shares/${token}.json`);
}

function state(share) {
  if (!share) return 'missing';
  if (share.revokedAt) return 'revoked';
  if (share.expiresAt && share.expiresAt < Date.now()) return 'expired';
  return 'active';
}

async function listForAudit(store, auditId) {
  const meta = await store.readJSON(`audits/${auditId}/meta.json`);
  if (!meta) return null;
  const out = [];
  for (const t of meta.shares || []) { const s = await get(store, t); if (s) out.push({ ...s, state: state(s) }); }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function revoke(store, token) {
  const s = await get(store, token);
  if (!s) return false;
  s.revokedAt = Date.now();
  await store.writeJSON(`shares/${token}.json`, s);
  return true;
}

async function removeAllForAudit(store, auditId, meta) {
  for (const t of (meta && meta.shares) || []) { try { await store.remove(`shares/${t}.json`); } catch {} }
}

// Best-effort view counter (not awaited by the request).
function touch(store, share) {
  share.views = (share.views || 0) + 1;
  share.lastViewedAt = Date.now();
  return store.writeJSON(`shares/${share.token}.json`, share).catch(() => {});
}

module.exports = { create, get, state, listForAudit, revoke, removeAllForAudit, touch, TOKEN_RE };
