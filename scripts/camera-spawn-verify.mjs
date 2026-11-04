import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.metro);
    const frames = await page.evaluate(() => {
      const metro = window.metro;
      metro.restart({ seed: 420 });
      const initial = metro.getState();
      const originalStation = initial.stations[0].id;
      const sample = () => ({
        state: metro.getState(),
        original: metro.projectStation(originalStation),
        stage: document.querySelector('#stage').getBoundingClientRect().toJSON(),
      });
      const spawns = [];
      for (let i = 0; i < 3; i++) {
        const now = metro.getState();
        const deadline = now.nextStation;
        metro.step(deadline - 240 - now.elapsed);
        const early = sample();
        metro.step(120);
        const middle = sample();
        metro.step(119);
        const before = sample();
        metro.step(1);
        const after = sample();
        const latest = after.state.stations.at(-1);
        spawns.push({ early, middle, before, after, newStation: metro.projectStation(latest.id) });
      }
      return spawns;
    });
    const summaries = [];
    for (const sample of frames) {
      assert.equal(sample.after.state.stations.length, sample.before.state.stations.length + 1);
      const stage = sample.after.stage;
      assert.ok(sample.newStation.x > stage.left && sample.newStation.x < stage.right &&
        sample.newStation.y > stage.top && sample.newStation.y < stage.bottom,
      `new station should appear within ${viewport.width}px map`);
      const separation = (a) => {
        const rect = a.stage;
        return Math.hypot(a.original.x - rect.left - rect.width / 2, a.original.y - rect.top - rect.height / 2);
      };
      if (viewport.width < 500 && separation(sample.middle) < separation(sample.early)) {
        assert.ok(separation(sample.before) < separation(sample.middle), 'mobile expansion continues during lead-in');
      }
      const jump = Math.hypot(sample.after.original.x - sample.before.original.x,
        sample.after.original.y - sample.before.original.y);
      assert.ok(jump < 12, `spawn-time camera movement too large: ${jump}px`);
      summaries.push({ before: sample.before.state.stations.length, after: sample.after.state.stations.length,
        jump, newStation: sample.newStation });
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, spawns: summaries, passed: true }));
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
