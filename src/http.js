'use strict';

// Thin HTTP layer: manual redirect following (so chains are visible), timeouts, bounded concurrency.

async function request(url, cfg, { method = 'GET', body = true, maxHops = 6 } = {}) {
  const hops = [];
  let current = url;
  const t0 = Date.now();
  for (let i = 0; i <= maxHops; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        method,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': cfg.userAgent, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
    } catch (e) {
      clearTimeout(timer);
      return { url, finalUrl: current, status: 0, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e), hops, ms: Date.now() - t0 };
    }
    const ttfb = Date.now() - t0;
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      const next = new URL(res.headers.get('location'), current).href;
      hops.push({ from: current, to: next, status: res.status });
      try { await res.body?.cancel(); } catch {}
      if (hops.filter((h) => h.from === next).length) {
        return { url, finalUrl: next, status: res.status, error: 'redirect loop', hops, ms: Date.now() - t0 };
      }
      current = next;
      continue;
    }
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    let text = '';
    if (body && method !== 'HEAD') {
      try { text = await res.text(); } catch (e) { text = ''; }
    } else {
      try { await res.body?.cancel(); } catch {}
    }
    clearTimeout(timer);
    return { url, finalUrl: current, status: res.status, headers, text, hops, ttfb, ms: Date.now() - t0 };
  }
  return { url, finalUrl: current, status: 0, error: 'too many redirects', hops, ms: Date.now() - t0 };
}

async function pool(items, n, fn, onEach) {
  const out = new Array(items.length);
  let i = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: String(e && e.message || e) }; }
        done++;
        if (onEach) onEach(done, items.length);
      }
    }),
  );
  return out;
}

module.exports = { request, pool };
