'use strict';
// Local: Playwright-installed Chromium. Vercel: @sparticuz/chromium (fits serverless size limits).
const { chromium } = require('playwright-core');

// @sparticuz/chromium ships flags tuned for Puppeteer. Two of them break Playwright audits:
// --single-process: closing a page or context tears down the whole browser, so the next
//   browser.newContext() fails with "Target page, context or browser has been closed".
// --headless='shell': Playwright sets headless mode itself.
const DROP = new Set(['--single-process', "--headless='shell'", '--headless=shell']);

async function launchBrowser() {
  if (process.env.VERCEL || process.env.QA_USE_SPARTICUZ) {
    const sparticuz = require('@sparticuz/chromium');
    return chromium.launch({
      args: [...sparticuz.args.filter((a) => !DROP.has(a)), '--disable-dev-shm-usage'],
      executablePath: await sparticuz.executablePath(),
      headless: true,
    });
  }
  return chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
}

module.exports = { launchBrowser, DROP };
