import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';
import { runAgent } from '../dist-sdk/index.mjs';

const output = 'test-results/ui';
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  assert.equal(await page.locator('.topbar .brand-mark, .topbar h1').count(), 0, 'in-game header should have no logo or large brand');
  const map = await page.locator('#stage').boundingBox();
  assert.ok(map.width >= 1400 && map.height >= 700, `map should dominate viewport: ${JSON.stringify(map)}`);
  assert.equal(await page.locator('#inspector').isVisible(), false);
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  const station = await page.evaluate(() => window.metro.projectStation(1));
  await page.mouse.click(station.x, station.y);
  await page.locator('#station-detail').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#station-detail').isVisible(), true, 'station information opens contextually');
  assert.match(await page.locator('#station-detail').innerText(), /人候车/);
  await page.click('#inspector-close');
  assert.equal(await page.locator('#inspector').isVisible(), false);
  await page.click('#line-tools-toggle');
  await page.click('#add-train');
  assert.match(await page.locator('#toast').innerText(), /线路|列车|机车|资源/);
  assert.equal(await page.locator('#toast').getAttribute('role'), 'alert', 'invalid actions need announced feedback');
  await page.click('#line-tools-close');
  await page.click('#play-pause');
  assert.equal(await page.evaluate(() => window.metro.controller.paused), false);
  await page.click('[data-speed="2"]');
  assert.equal(await page.locator('[data-speed="2"]').getAttribute('aria-pressed'), 'true');
  const completed = await runAgent({ seed: 420, maxTicks: 24000 });
  assert.equal(completed.reason, 'over');
  await page.evaluate((replay) => {
    window.metro.loadReplay(replay);
    window.metro.seek(replay.duration);
  }, completed.replay);
  assert.equal(await page.evaluate(() => window.metro.getState().phase), 'over');
  assert.match(await page.locator('#over-restart').innerText(), /相同种子|同一种子/);
  await page.screenshot({ path: `${output}/game-over.png`, fullPage: true });
  await page.click('#over-restart');
  assert.equal(await page.evaluate(() => window.metro.getState().seed), completed.replay.options.seed, 'retry preserves seed');
  assert.equal(await page.evaluate(() => window.metro.getState().phase), 'playing');
  await page.evaluate((replay) => { window.metro.loadReplay(replay); window.metro.seek(replay.duration); }, completed.replay);
  await page.click('#over-new-seed');
  assert.notEqual(await page.evaluate(() => window.metro.getState().seed), completed.replay.options.seed, 'new-seed action changes seed');
  await page.locator('#import-file').setInputFiles({ name: 'finished.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(completed.replay)) });
  await page.waitForFunction(() => window.metro.controller.mode === 'replay');
  assert.equal(await page.evaluate(() => window.metro.controller.mode), 'replay');
  assert.ok(Number(await page.locator('#timeline').getAttribute('max')) >= completed.replay.duration, 'imported replay exposes its full timeline');
  await page.locator('#timeline').fill('600');
  await page.locator('#timeline').dispatchEvent('input');
  assert.equal(await page.evaluate(() => window.metro.getState().tick), 600);

  // A Creative station selection must not remove the only way to choose the next shape.
  await page.click('#new-game');
  await page.selectOption('#mode-select', 'creative');
  await page.click('#settings-form button[type="submit"]');
  const selectedPoint = await page.evaluate(() => window.metro.projectStation(1));
  await page.mouse.click(selectedPoint.x, selectedPoint.y);
  await page.locator('#station-detail').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#station-detail h3')?.textContent?.includes('车站'));
  assert.equal(await page.locator('#station-detail [data-station-shape]').count(), 10,
    'Creative shape picker remains available after selecting a station');
  await page.locator('#station-detail [data-station-shape="pentagon"]').click();
  const beforeStations = await page.evaluate(() => window.metro.getState().stations.length);
  const openGround = await page.evaluate(() => window.metro.projectStation(2));
  await page.mouse.click(openGround.x - 75, openGround.y - 100);
  assert.equal(await page.evaluate(() => window.metro.getState().stations.length), beforeStations + 1,
    'Creative can place a selected shape after inspecting a station');
  assert.equal(await page.evaluate(() => window.metro.getState().stations.at(-1).shape), 'pentagon');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on('pageerror', (error) => errors.push(String(error)));
  await mobile.goto(url, { waitUntil: 'networkidle' });
  await mobile.waitForFunction(() => window.metro);
  const layout = await mobile.evaluate(() => ({
    viewport: innerWidth,
    overflow: document.documentElement.scrollWidth - innerWidth,
    map: document.querySelector('#stage').getBoundingClientRect().toJSON(),
    controls: ['#play-pause', '[data-speed="1"]', '[data-speed="2"]', '[data-speed="4"]', '#line-tools-toggle', '.line-choice', '#tools-toggle', '#replay-toggle', '#new-game'].map((selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { selector, width: box.width, height: box.height, left: box.left, right: box.right };
    }),
  }));
  assert.ok(layout.map.width >= 380 && layout.map.height >= 550, `mobile map dominates: ${JSON.stringify(layout.map)}`);
  assert.ok(layout.overflow <= 0, `mobile document overflows by ${layout.overflow}px`);
  const undersized = layout.controls.filter((c) => c.width < 44 || c.height < 44);
  const offscreen = layout.controls.filter((c) => c.left < 0 || c.right > layout.viewport);
  assert.deepEqual(undersized, [], `touch targets too small: ${JSON.stringify(undersized)}`);
  assert.deepEqual(offscreen, [], `touch targets off-screen: ${JSON.stringify(offscreen)}`);
  await mobile.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  const mobileStation = await mobile.evaluate(() => window.metro.projectStation(1));
  await mobile.touchscreen.tap(mobileStation.x, mobileStation.y);
  await mobile.locator('#station-detail').waitFor({ state: 'visible' });
  assert.match(await mobile.locator('#station-detail').innerText(), /人候车/);
  await mobile.click('#inspector-close');
  await mobile.click('#tools-toggle');
  assert.equal(await mobile.locator('#inspector').isVisible(), true);
  await mobile.click('#inspector-close');
  await mobile.click('#line-tools-toggle');
  assert.equal(await mobile.locator('#add-train').isVisible(), true);
  await mobile.click('#line-tools-close');
  await mobile.setViewportSize({ width: 320, height: 640 });
  const narrow = await mobile.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    controls: ['#play-pause', '[data-speed="4"]', '#new-game', '#tools-toggle', '#replay-toggle'].map((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { selector, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    }),
  }));
  assert.ok(narrow.overflow <= 0, `narrow viewport overflows: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.controls.every((c) => c.left >= 0 && c.right <= 320 && c.width >= 44 && c.height >= 44), `narrow controls clipped: ${JSON.stringify(narrow)}`);
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, desktopMap: map, mobile: layout, screenshots: [`${output}/desktop.png`, `${output}/mobile.png`, `${output}/game-over.png`] }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
