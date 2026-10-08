'use strict';
// Local: Playwright-installed Chromium. Vercel: @sparticuz/chromium (fits serverless size limits).
const { chromium } = require('playwright-core');

async function launchBrowser() {
  if (process.env.VERCEL) {
    const sparticuz = require('@sparticuz/chromium');
    return chromium.launch({
      args: sparticuz.args,
      executablePath: await sparticuz.executablePath(),
      headless: true,
    });
  }
  return chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
}

module.exports = { launchBrowser };
