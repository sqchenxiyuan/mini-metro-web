import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { runAgent, ReplayPlayer } from '../dist-sdk/index.mjs';
import { browserLaunchOptions } from './browser-launch.mjs';

const output = 'test-results/full-train-ui';
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
const checked = [];
try {
  for (const [city, seed] of [['orchard', 42], ['islands', 420]]) {
    const run = await runAgent({ city, seed, maxTicks: 16000 });
    assert.equal(run.reason, 'over');
    assert.equal(run.errors, 0);
    const player = new ReplayPlayer(run.replay);
    let full = null;
    for (let tick = 0; tick <= run.replay.duration && !full; tick += 5) {
      const state = player.seek(tick);
      const train = state.trains.find((t) => t.passengers.length === 6 * (1 + t.carriages));
      if (train) full = { tick, id: train.id, count: train.passengers.length, capacity: 6 * (1 + train.carriages) };
    }
    assert.ok(full, `no full train in ${city} seed ${seed}`);
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500 });
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.metro);
      await page.evaluate(({ replay, tick }) => { window.metro.loadReplay(replay); window.metro.seek(tick); }, { replay: run.replay, tick: full.tick });
      await page.click('#inspector-close');
      assert.equal(await page.locator('#inspector').isVisible(), false);
      const badge = page.locator(`[data-train-id="${full.id}"]`);
      const rect = await badge.boundingBox();
      assert.ok(rect, 'full train has an on-map badge');
      assert.ok(rect.width <= 86, `${city} ${width}px full badge stretched to ${rect.width}px`);
      assert.ok(rect.height <= 50, `${city} ${width}px full badge too tall: ${rect.height}px`);
      assert.match(await badge.innerText(), new RegExp(`^${full.count}/${full.capacity}$`));
      assert.deepEqual(errors, [], 'no page errors');
      const screenshot = `${output}/${city}-${seed}-${width}-full.png`;
      await page.screenshot({ path: screenshot, fullPage: true });
      checked.push({ city, seed, width, tick: full.tick, badge: rect, screenshot });
      await page.close();
    }
  }
  console.log(JSON.stringify({ passed: true, games: 2, checked }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
