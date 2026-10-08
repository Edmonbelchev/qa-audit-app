'use strict';

const DEFAULTS = {
  url: '',
  siteName: '',
  environment: 'production', // production | staging
  maxPages: 500, // hard cap on URLs fetched in the static pass
  maxDepth: 4, // only used when no sitemap exists (link crawl)
  concurrency: 4, // parallel HTTP requests in the static pass
  renderSample: 30, // pages rendered in Chromium (all non-post pages first, then a sample of posts)
  viewports: { desktop: 1280, mobile: 375 },
  perfRuns: 3,
  perfPages: 3, // homepage + N-1 other key pages
  checkExternalLinks: false,
  externalLinkCap: 300,
  brand: {
    headingFonts: [], // e.g. ["Bitter"]
    bodyFonts: [], // e.g. ["Poppins"]
    colors: [], // e.g. ["#A6263F", "#4D4C4C"]
    colorTolerance: 8, // max RGB euclidean distance treated as "same colour"
    designUrl: '', // optional link shown in the report (Figma, PDF…)
    designLabel: '',
  },
  phones: {
    expected: [], // digits, e.g. ["8007278990"]; empty = inventory only
  },
  legacyRedirects: [], // [{ from: "/old/", to: "/new/" }]
  budgets: { ttfbMs: 400, dclMs: 1500, loadMs: 3000, assetKB: 100, inlineKB: 100, lcpMs: 2500, cls: 0.1 },
  ignoreSelectors: [
    // third-party widgets that bring their own fonts/colours
    '.ti-widget', '[class*="trustindex"]', '#CybotCookiebotDialog', '.grecaptcha-badge', 'iframe',
  ],
  userAgent: 'DevriX-QA-Audit/1.0 (+passive crawl)',
  timeoutMs: 30000,
};

function normHex(c) {
  let h = String(c).trim().replace(/^#/, '').toUpperCase();
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return /^[0-9A-F]{6}$/.test(h) ? h : null;
}

function splitList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}

function build(input = {}) {
  const c = JSON.parse(JSON.stringify(DEFAULTS));
  const errors = [];
  let url = String(input.url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    c.url = u.origin + '/';
    c.origin = u.origin;
    c.host = u.host;
  } catch {
    errors.push('Enter a valid site URL, e.g. https://example.com');
  }
  c.siteName = String(input.siteName || '').trim() || (c.host || '').replace(/^www\./, '');
  if (input.environment) c.environment = input.environment === 'staging' ? 'staging' : 'production';
  for (const k of ['maxPages', 'maxDepth', 'concurrency', 'renderSample', 'perfRuns', 'perfPages', 'externalLinkCap']) {
    if (input[k] !== undefined && input[k] !== '') {
      const n = parseInt(input[k], 10);
      if (Number.isFinite(n) && n >= 0) c[k] = n;
    }
  }
  c.concurrency = Math.min(Math.max(c.concurrency, 1), 12);
  c.checkExternalLinks = !!input.checkExternalLinks;
  const b = input.brand || {};
  c.brand.headingFonts = splitList(b.headingFonts);
  c.brand.bodyFonts = splitList(b.bodyFonts);
  const rawColors = splitList(b.colors);
  c.brand.colors = rawColors.map(normHex).filter(Boolean);
  rawColors.filter((x) => !normHex(x)).forEach((x) => errors.push(`"${x}" is not a hex colour (use #RRGGBB)`));
  if (b.colorTolerance !== undefined && b.colorTolerance !== '') c.brand.colorTolerance = Number(b.colorTolerance) || 0;
  c.brand.designUrl = String(b.designUrl || '').trim();
  c.brand.designLabel = String(b.designLabel || '').trim();
  c.phones.expected = splitList((input.phones || {}).expected).map((p) => p.replace(/\D/g, '').slice(-10)).filter((p) => p.length >= 7);
  c.legacyRedirects = splitList(input.legacyRedirects)
    .map((line) => line.split(/\s*(?:->|=>|\s)\s*/).filter(Boolean))
    .filter((p) => p.length >= 1)
    .map(([from, to]) => ({ from, to: to || null }));
  if (input.budgets) for (const [k, v] of Object.entries(input.budgets)) if (v !== '' && Number.isFinite(Number(v))) c.budgets[k] = Number(v);
  if (input.ignoreSelectors) c.ignoreSelectors = c.ignoreSelectors.concat(splitList(input.ignoreSelectors));
  return { config: c, errors };
}

module.exports = { DEFAULTS, build, normHex, splitList };
