'use strict';
// Storage for profiles, audits, reports and share links.
// - Local disk (default): ./data, or QA_DATA_DIR.
// - Vercel Blob: used automatically when BLOB_READ_WRITE_TOKEN is set (persists across serverless instances).
// Keys are POSIX-style paths, e.g. "audits/<id>/meta.json", "shares/<token>.json", "profiles.json".
const fs = require('fs');
const path = require('path');

const safeKey = (k) => {
  const s = String(k).replace(/^\/+/, '');
  if (!s || s.split('/').some((p) => p === '..' || p === '' || p === '.')) throw new Error('Invalid storage key: ' + k);
  return s;
};

class FsStorage {
  constructor(root) { this.root = root; this.kind = 'local disk'; fs.mkdirSync(root, { recursive: true }); }
  file(k) { return path.join(this.root, ...safeKey(k).split('/')); }
  async read(k) { try { return await fs.promises.readFile(this.file(k)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async write(k, data) { const f = this.file(k); await fs.promises.mkdir(path.dirname(f), { recursive: true }); const tmp = f + '.' + process.pid + '.tmp'; await fs.promises.writeFile(tmp, data); await fs.promises.rename(tmp, f); }
  async remove(prefix) { const f = this.file(prefix.replace(/\/$/, '')); await fs.promises.rm(f, { recursive: true, force: true }); }
  async list(prefix) {
    // Returns keys of files under prefix (recursive).
    const base = this.file(prefix.replace(/\/$/, ''));
    const out = [];
    const walk = async (dir, rel) => {
      let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.endsWith('.tmp')) continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r); else out.push(prefix.replace(/\/$/, '') + '/' + r);
      }
    };
    await walk(base, '');
    return out;
  }
}

class BlobStorage {
  constructor(opts = {}) {
    this.sdk = opts.sdk || require('@vercel/blob');
    this.token = opts.token || process.env.BLOB_READ_WRITE_TOKEN;
    this.access = opts.access || process.env.QA_BLOB_ACCESS || 'private';
    this.prefix = (opts.prefix || process.env.QA_BLOB_PREFIX || 'qa-audit').replace(/\/$/, '') + '/';
    this.kind = `Vercel Blob (${this.access})`;
  }
  key(k) { return this.prefix + safeKey(k); }
  async read(k) {
    const r = await this.sdk.get(this.key(k), { access: this.access, useCache: false, token: this.token });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  }
  async write(k, data, contentType) {
    await this.sdk.put(this.key(k), data, { access: this.access, token: this.token, addRandomSuffix: false, allowOverwrite: true, contentType: contentType || guessType(k), cacheControlMaxAge: 60 });
  }
  async list(prefix) {
    const p = this.key(prefix.replace(/\/$/, '')) + '/';
    const out = [];
    let cursor;
    do {
      const r = await this.sdk.list({ prefix: p, cursor, limit: 1000, token: this.token });
      for (const b of r.blobs) out.push(b.pathname.slice(this.prefix.length));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out;
  }
  async remove(prefix) {
    const keys = prefix.endsWith('/') ? await this.list(prefix) : [prefix];
    const extra = prefix.endsWith('/') ? [] : await this.list(prefix + '/');
    const all = [...keys, ...extra].map((k) => this.key(k));
    for (let i = 0; i < all.length; i += 100) await this.sdk.del(all.slice(i, i + 100), { token: this.token });
  }
}

function guessType(k) {
  const ext = String(k).split('.').pop();
  return { html: 'text/html; charset=utf-8', json: 'application/json', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8' }[ext] || 'application/octet-stream';
}

// Helpers shared by both drivers
function wrap(driver) {
  return {
    kind: driver.kind,
    driver,
    read: (k) => driver.read(k),
    async readText(k) { const b = await driver.read(k); return b === null ? null : b.toString('utf8'); },
    async readJSON(k, dflt = null) { const t = await this.readText(k); if (t === null) return dflt; try { return JSON.parse(t); } catch { return dflt; } },
    write: (k, data, type) => driver.write(k, typeof data === 'string' ? Buffer.from(data) : data, type),
    writeJSON: (k, v) => driver.write(k, Buffer.from(JSON.stringify(v, null, 2)), 'application/json'),
    list: (p) => driver.list(p),
    remove: (p) => driver.remove(p),
  };
}

function createStorage(env = process.env, defaults = {}) {
  if (env.BLOB_READ_WRITE_TOKEN && env.QA_STORAGE !== 'disk') return wrap(new BlobStorage());
  const root = env.QA_DATA_DIR || defaults.root || path.join(__dirname, '..', 'data');
  return wrap(new FsStorage(root));
}

module.exports = { createStorage, FsStorage, BlobStorage, wrap };
