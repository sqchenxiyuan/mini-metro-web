import { chromium } from '@playwright/test';
import { runAgent, RULES } from '../dist-sdk/index.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:4175/';
const browser = await chromium.launch({ headless: true,
  ...(process.env.METRO_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH } : {}),
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const generated = await runAgent({ seed: 420, maxTicks: RULES.hz * 1200 });
assert.equal(generated.reason, 'over', 'deterministic replay fixture must reach game over');
const replay = JSON.stringify(generated.replay);
const samples = [];
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
try {
  for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    for (const zoom of ['default', 'in', 'out']) {
      // Restore the same replay independently before changing camera zoom.
      await page.evaluate((data) => { window.metro.loadReplay(data); window.metro.seek(21000); }, replay);
      await page.waitForTimeout(200);
      await page.locator('#inspector-close').click();
      if (zoom === 'in') for (let i = 0; i < 3; i++) await page.locator('#zoom-in').click();
      if (zoom === 'out') for (let i = 0; i < 2; i++) await page.locator('#zoom-out').click();
      // Closing the inspector changes stage width; wait until a draw has used
      // that width and the new camera, rather than sampling stale cue bounds.
      await page.waitForFunction(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const bounds = window.metro.sceneCues().bounds;
        return bounds.length > 0 && bounds.every((box) => {
          const anchor = window.metro.projectStation(box.id);
          return Math.hypot(stage.left + box.x + box.width / 2 - anchor.x,
            stage.top + box.y + box.height / 2 - anchor.y) <= 36.01;
        });
      }, null, { timeout: 5000 });
      const measured = await page.evaluate(() => {
        const state = window.metro.getState(), cues = window.metro.sceneCues();
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const stations = [...document.querySelectorAll('[data-station]')].map((node) => {
          const rect = node.getBoundingClientRect();
          return { id: Number(node.dataset.station), left: rect.left, right: rect.right,
            top: rect.top, bottom: rect.bottom };
        });
        const bounds = cues.bounds.map((box) => ({ ...box,
          left: stage.left + box.x, right: stage.left + box.x + box.width,
          top: stage.top + box.y, bottom: stage.top + box.y + box.height }));
        const anchors = new Map(state.stations.map((station) => [station.id, window.metro.projectStation(station.id)]));
        return { tick: state.tick, queued: state.stations.filter((p) => p.queue.length).length,
          warned: state.stations.filter((p) => p.crowd).length, cues, stations, bounds,
          anchors: Object.fromEntries(anchors), stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height },
          alert: document.querySelector('#map-alerts')?.textContent ?? '' };
      });
      assert.equal(measured.tick, 21000);
      assert.equal(measured.bounds.length, measured.cues.queueCount + measured.cues.warningCount);
      assert.equal(measured.cues.ringCount, measured.warned);
      assert.equal(measured.queued, measured.cues.queueCount + Number(measured.alert.match(/(\d+) 站候车详情/)?.[1] ?? 0));
      assert.equal(measured.warned, measured.cues.warningCount + Number(measured.alert.match(/(\d+) 站拥挤/)?.[1] ?? 0));
      for (const [i, box] of measured.bounds.entries()) {
        const anchor = measured.anchors[box.id];
        assert.ok(Math.hypot((box.left + box.right) / 2 - anchor.x,
          (box.top + box.bottom) / 2 - anchor.y) <= 36.01, `detached ${size.width} ${zoom} ${box.kind} ${box.id}`);
        for (const target of measured.stations) if (target.id !== box.id)
          assert.equal(intersects(box, target), false, `cue intersects another station ${size.width} ${zoom} ${box.id} ${target.id}`);
        for (const other of measured.bounds.slice(i + 1))
          assert.equal(intersects(box, other), false, `cues intersect ${size.width} ${zoom} ${box.id} ${other.id}`);
      }
      if (size.width === 390 && zoom === 'default') {
        await mkdir('test-results/scene-cues', { recursive: true });
        await page.screenshot({ path: 'test-results/scene-cues/mobile-390x844-tick21000.png', fullPage: true });
        const omitted = (await page.locator('#map-alerts').getAttribute('data-omitted')).split(',').map(Number);
        assert.ok(omitted.length > 0);
        await page.locator('#map-alerts').click();
        assert.equal(await page.locator('#station-peek').isVisible(), true);
        assert.ok(omitted.includes(Number(await page.locator('.station-label.selected').getAttribute('data-station'))));
      }
      if (size.width === 1280 && zoom === 'default') {
        await mkdir('test-results/scene-cues', { recursive: true });
        await page.screenshot({ path: 'test-results/scene-cues/desktop-1280x900-tick21000.png', fullPage: true });
      }
      samples.push({ viewport: `${size.width}x${size.height}`, zoom,
        queues: measured.cues.queueCount, queueFallback: measured.queued - measured.cues.queueCount,
        warnings: measured.cues.warningCount, warningFallback: measured.warned - measured.cues.warningCount,
        rings: measured.cues.ringCount, cueStationCollisions: 0, cueCollisions: 0, detached: 0 });
    }
    if (size.width === 390) {
      await page.evaluate(() => {
        window.metro.restart({ seed: 420, mode: 'endless' }); window.metro.pause();
        for (let i = 0; i < 9; i++) {
          const s = window.metro.getState();
          if (s.phase === 'upgrade') window.metro.submit({ action: { type: 'upgrade', choice: s.upgrades[0] }, reason: 'scene cue geometry' });
          window.metro.step(4200);
        }
        const s = window.metro.getState();
        if (s.phase === 'upgrade') window.metro.submit({ action: { type: 'upgrade', choice: s.upgrades[0] }, reason: 'scene cue geometry' });
      });
      await page.waitForTimeout(250);
      const dense = await page.evaluate(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect();
        return { cues: window.metro.sceneCues(), stations: [...document.querySelectorAll('[data-station]')].map((el) =>
          ({ id: Number(el.dataset.station), ...Object.fromEntries(['left', 'right', 'top', 'bottom'].map((k) => [k, el.getBoundingClientRect()[k]])) })),
        stage: { left: stage.left, top: stage.top },
        anchors: Object.fromEntries(window.metro.getState().stations.map((p) => [p.id, window.metro.projectStation(p.id)])) };
      });
      for (const [i, box] of dense.cues.bounds.entries()) {
        const absolute = { left: dense.stage.left + box.x, right: dense.stage.left + box.x + box.width,
          top: dense.stage.top + box.y, bottom: dense.stage.top + box.y + box.height };
        const anchor = dense.anchors[box.id];
        assert.ok(Math.hypot((absolute.left + absolute.right) / 2 - anchor.x,
          (absolute.top + absolute.bottom) / 2 - anchor.y) <= 36.01, `dense detached ${box.kind} ${box.id}`);
        for (const target of dense.stations) if (target.id !== box.id)
          assert.equal(intersects(absolute, target), false, `dense cue / station ${box.id} ${target.id}`);
        for (const other of dense.cues.bounds.slice(i + 1)) {
          const next = { left: dense.stage.left + other.x, right: dense.stage.left + other.x + other.width,
            top: dense.stage.top + other.y, bottom: dense.stage.top + other.y + other.height };
          assert.equal(intersects(absolute, next), false, `dense cue / cue ${box.id} ${other.id}`);
        }
      }
      await page.screenshot({ path: 'test-results/scene-cues/mobile-390x844-tick37800.png', fullPage: true });
      samples.push({ viewport: '390x844', zoom: 'default', fixture: 'seed420-tick37800',
        queues: dense.cues.queueCount, warnings: dense.cues.warningCount, rings: dense.cues.ringCount,
        cueStationCollisions: 0, cueCollisions: 0, detached: 0 });
    }
    assert.deepEqual(errors, [], `browser errors at ${size.width}`);
    await page.close();
  }
  console.log(JSON.stringify({ passed: true, samples }, null, 2));
} finally { await browser.close(); }
