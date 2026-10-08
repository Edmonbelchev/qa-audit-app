'use strict';
const { request } = require('./http');

const NON_PAGE = /\.(jpe?g|png|gif|webp|avif|svg|pdf|zip|mp4|mp3|docx?|xlsx?|css|js|xml|txt)(\?|$)/i;

function locs(xml) {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
}

function normalize(u, base) {
  try {
    const x = new URL(u, base);
    x.hash = '';
    if (!x.pathname) x.pathname = '/';
    return x.href;
  } catch { return null; }
}

function sameSite(u, cfg) {
  try { const h = new URL(u).host.replace(/^www\./, ''); return h === cfg.host.replace(/^www\./, ''); } catch { return false; }
}

async function readSitemaps(cfg, log) {
  const robots = await request(cfg.origin + '/robots.txt', cfg);
  const robotsTxt = robots.status === 200 ? robots.text : '';
  let roots = [...robotsTxt.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (!roots.length) roots = ['/sitemap_index.xml', '/sitemap.xml', '/wp-sitemap.xml'].map((p) => cfg.origin + p);
  const seenMaps = new Set();
  const sitemaps = [];
  const urls = new Map(); // url -> sitemap file
  const queue = [...roots];
  while (queue.length && seenMaps.size < 200) {
    const sm = queue.shift();
    if (seenMaps.has(sm)) continue;
    seenMaps.add(sm);
    const r = await request(sm, cfg);
    if (r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.text || '')) {
      sitemaps.push({ url: sm, status: r.status, ok: false, count: 0 });
      continue;
    }
    if (/<sitemapindex/i.test(r.text)) {
      const kids = locs(r.text);
      sitemaps.push({ url: sm, status: 200, ok: true, index: true, count: kids.length });
      queue.push(...kids);
    } else {
      const list = locs(r.text).filter((u) => !NON_PAGE.test(u));
      sitemaps.push({ url: sm, status: 200, ok: true, count: list.length });
      for (const u of list) {
        const n = normalize(u, cfg.origin);
        if (n && !urls.has(n)) urls.set(n, sm.split('/').pop());
      }
    }
    log && log(`Sitemap ${sm.split('/').pop()}: ${sitemaps[sitemaps.length - 1].count} entries`);
  }
  return { robotsTxt, robotsStatus: robots.status, sitemaps, urls };
}

async function linkCrawl(cfg, log) {
  const seen = new Map([[cfg.url, 0]]);
  const queue = [cfg.url];
  while (queue.length && seen.size < cfg.maxPages) {
    const u = queue.shift();
    const depth = seen.get(u);
    if (depth >= cfg.maxDepth) continue;
    const r = await request(u, cfg);
    if (r.status !== 200 || !/text\/html/.test((r.headers || {})['content-type'] || '')) continue;
    const hrefs = [...(r.text || '').matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => normalize(m[1], r.finalUrl));
    for (const h of hrefs) {
      if (!h || !sameSite(h, cfg) || NON_PAGE.test(h) || /\/wp-(admin|login|json)|\?(s|replytocom)=|\/feed\/?$/.test(h)) continue;
      if (!seen.has(h) && seen.size < cfg.maxPages) { seen.set(h, depth + 1); queue.push(h); }
    }
    if (seen.size % 25 === 0) log && log(`Link crawl: ${seen.size} URLs found`);
  }
  return new Map([...seen.keys()].map((u) => [u, 'link-crawl']));
}

async function discover(cfg, log) {
  const sm = await readSitemaps(cfg, log);
  let urls = sm.urls;
  let method = 'sitemap';
  if (!urls.size) {
    log && log('No usable sitemap. Falling back to a link crawl from the homepage.');
    urls = await linkCrawl(cfg, log);
    method = 'link-crawl';
  }
  if (!urls.has(cfg.url)) urls = new Map([[cfg.url, 'homepage'], ...urls]);
  const list = [...urls.keys()].slice(0, cfg.maxPages);
  return { method, urls: list, source: Object.fromEntries([...urls].slice(0, cfg.maxPages)), sitemaps: sm.sitemaps, robotsTxt: sm.robotsTxt, robotsStatus: sm.robotsStatus, truncated: urls.size > cfg.maxPages, totalFound: urls.size };
}

// Template group for a URL: "/services/mold/" -> "services"; posts under /blog/<slug>/ -> "blog"
function groupOf(u, cfg) {
  try {
    const p = new URL(u).pathname.replace(/\/+$/, '');
    if (!p) return 'home';
    const seg = p.split('/').filter(Boolean);
    if (seg.length === 1) return 'page';
    if (seg.includes('category') || seg.includes('tag') || seg.includes('author') || seg.includes('page')) return seg[0] + '-archive';
    return seg[0];
  } catch { return 'other'; }
}

module.exports = { discover, normalize, sameSite, groupOf, NON_PAGE };
