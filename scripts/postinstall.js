'use strict';
const { execSync } = require('child_process');

if (process.env.VERCEL) {
  console.log('Vercel build: skipping Playwright browser download (@sparticuz/chromium at runtime).');
  process.exit(0);
}

try {
  execSync('npx playwright install chromium', { stdio: 'inherit' });
} catch {
  console.log('Could not install Chromium. Run: npx playwright install chromium');
  process.exit(0);
}
