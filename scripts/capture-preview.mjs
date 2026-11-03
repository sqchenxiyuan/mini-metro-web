import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
const replay = JSON.parse(await readFile('test-results/production/node-agent.json', 'utf8'));
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  await page.evaluate((replay) => {
    window.metro.loadReplay(replay);
    window.metro.seek(4900);
  }, replay);
  await page.click('#tab-dispatch');
  await page.click('#inspector-close');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/production/orchard-town.png', fullPage: true });
  await page.screenshot({ path: 'artifacts/orchard-metro.png', fullPage: true });
} finally {
  await browser.close();
}
