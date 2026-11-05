import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { RULES } from '../dist-sdk/index.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
});
page.on('pageerror', (e) => console.log('PAGE ERROR', String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE', m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) console.log('HTTP ERROR', r.status(), r.url());
});
await page.goto('http://127.0.0.1:5175');
await page.waitForFunction(() => window.metro);
await page.waitForTimeout(700);
await mkdir('test-results', { recursive: true });
await page.screenshot({ path: 'test-results/initial.png', fullPage: true });
const coords = await page.evaluate(() => [1, 2, 3].map((id) => window.metro.projectStation(id)));
await page.mouse.move(coords[0].x, coords[0].y);
await page.mouse.down();
for (const p of coords.slice(1)) await page.mouse.move(p.x, p.y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(1200);
console.log(
  'DRAG',
  await page.evaluate(() => ({
    line: window.metro.getState().lines[0],
    tick: window.metro.getState().tick,
  })),
);
await page.evaluate(async (hz) => {
  const { dispatcherPolicy } = await import('/src/agent.ts');
  window.metro.pause();
  for (let i = 0; i < 36; i++) {
    window.metro.submit(dispatcherPolicy(window.metro.observe()), 'screenshot-demo');
    window.metro.step(4 * hz);
  }
}, RULES.hz);
await page.waitForTimeout(500);
await page.screenshot({ path: 'test-results/town.png', fullPage: true });
console.log(
  'TOWN',
  await page.evaluate(() => ({
    tick: window.metro.getState().tick,
    score: window.metro.getState().score,
    phase: window.metro.getState().phase,
  })),
);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
console.log(
  'MOBILE',
  await page.evaluate(() => ({ body: document.body.scrollWidth, width: innerWidth })),
);
await browser.close();
