import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  const result = await page.evaluate(() => {
    const g = window.metro;
    g.submit({ action: { type: 'route', line: 0, stops: [1, 2, 3] } }, 'feedback-test');
    for (let i = 0; i < 1200; i++) {
      const s = g.getState();
      if (s.trains.some(t => t.passengers.length)) break;
      g.step(1);
    }
    g.step(0);
    const s = g.getState();
    const t = s.trains.find(t => t.passengers.length);
    return t && { id: t.id, count: t.passengers.length, capacity: 6 * (1 + t.carriages), shapes: t.passengers.map(p => p.shape), tick: s.tick };
  });
  assert.ok(result, 'fixture must board at least one passenger');
  assert.ok(result.count <= result.capacity);
  const badge = page.locator(`[data-train-id="${result.id}"]`);
  // The fixture advances simulation in one browser task; wait for the next animation frame to paint its badge.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await badge.waitFor({ state: 'visible' });
  assert.match(await badge.getAttribute('aria-label'), new RegExp(`${result.count}/${result.capacity}`));
  await badge.click();
  const detail = page.locator('#train-detail');
  await detail.waitFor({ state: 'visible' });
  assert.match(await detail.innerText(), new RegExp(`${result.count}/${result.capacity}`));
  for (const shape of new Set(result.shapes)) assert.ok((await detail.getAttribute('data-shapes')).includes(shape));
  await page.evaluate(() => window.metro.controller.setPaused(false));
  await page.locator('#train-detail-close').focus();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#train-detail-close').evaluate((e) => document.activeElement === e), true,
    'close control keeps keyboard focus across live render frames');
  await page.locator('#train-detail-close').click();
  assert.equal(await detail.isVisible(), false, 'train detail closes during live playback');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, train: result, badge: await badge.innerText(), detail: await detail.innerText() }));
} finally {
  await browser.close();
  await server.close();
}
