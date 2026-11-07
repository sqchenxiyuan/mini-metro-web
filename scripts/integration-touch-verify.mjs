import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './browser-launch.mjs';

const base = (process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175').replace(/\/$/, '');
const output = `/opt/data/cache/scratch/metro-integration-touch-${new URL(base).port}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const results = [];
const errors = [];

// Touch the screen, not Playwright's locator.click() (which can scroll targets into view).
async function tapVisible(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} has a visible box`);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  assert.ok(x >= 0 && x <= page.viewportSize().width && y >= 0 && y <= page.viewportSize().height,
    `${selector} touch target is on screen: ${JSON.stringify(box)}`);
  await page.touchscreen.tap(x, y);
}
async function drag(page, from, to) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x, y, radiusX: 5, radiusY: 5, force: 1 }],
  });
  await send('touchStart', from.x, from.y);
  for (let i = 1; i <= 12; i++) {
    await send('touchMove', from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12);
    await page.waitForTimeout(20);
  }
  await send('touchEnd', to.x, to.y);
  await cdp.detach();
}
try {
  for (const [width, height] of [[320, 480], [320, 600], [390, 844]]) {
    const label = `${width}x${height}`;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page.on('pageerror', e => errors.push(`${label}: ${e}`));
    await page.goto(`${base}/integration.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro?.mobileMapStats());
    assert.equal(await page.locator('#integration-tools-jump').count(), 1, `${label}: visible navigation must be provided`);
    assert.equal(await page.locator('#integration-tools-jump').getAttribute('href'), '#integration-controls');
    assert.equal(await page.locator('#integration-tools-jump').getAttribute('role'), null, `${label}: jump remains a native link`);
    assert.match(await page.locator('#integration-tools-jump').getAttribute('class'), /integration-jump/);
    await tapVisible(page, '#integration-pause');
    assert.equal(await page.evaluate(() => window.metro.controller.paused), true, `${label}: runtime controls accept a native tap`);
    await tapVisible(page, '#integration-tools-jump');
    await page.waitForFunction(() => location.hash === '#integration-controls');
    await tapVisible(page, '#integration-observe');
    const observation = JSON.parse(await page.locator('#integration-observation').textContent());
    assert.equal(observation.protocol, 'orchard-metro.agent.v1', `${label}: native observation tap works`);
    await tapVisible(page, '#integration-capture');
    assert.equal(await page.locator('#integration-image').evaluate(img => img.src.startsWith('data:image/png') && img.naturalWidth > 0), true,
      `${label}: native capture tap produces an image`);
    await page.screenshot({ path: `${output}/${label}-ai-controls.png` });
    assert.equal(await page.locator('#integration-game-return').getAttribute('href'), '#game-shell');
    await tapVisible(page, '#integration-game-return');
    await page.waitForFunction(() => location.hash === '#game-shell');
    const stage = await page.locator('#stage').boundingBox();
    assert.ok(stage && stage.y < height && stage.y + stage.height > 0, `${label}: game returns to viewport`);
    let points = await page.evaluate(() => [2, 1].map(id => window.metro.projectStation(id)));
    // At 320x480 the shell is taller than the viewport; use the game's own
    // visible zoom control before drawing between the opening stations.
    for (let i = 0; i < 3 && points.some(({ x, y }) => x <= 20 || x >= width - 20 || y <= 60 || y >= height - 24); i++) {
      await tapVisible(page, '#zoom-out');
      points = await page.evaluate(() => [2, 1].map(id => window.metro.projectStation(id)));
    }
    assert.ok(points.every(({ x, y }) => x > 20 && x < width - 20 && y > 40 && y < height - 20),
      `${label}: route endpoints visible after return: ${JSON.stringify(points)}`);
    await drag(page, points[0], points[1]);
    assert.deepEqual(await page.evaluate(() => window.metro.getState().lines[0].stops), [2, 1],
      `${label}: native touch route drawing remains functional`);
    const beforePan = await page.evaluate(() => window.metro.mobileMapStats().center);
    const blank = { x: width - 48, y: Math.min(height - 70, stage.y + stage.height / 2) };
    await drag(page, blank, { x: blank.x - 70, y: blank.y });
    assert.notDeepEqual(await page.evaluate(() => window.metro.mobileMapStats().center), beforePan,
      `${label}: native touch map pan remains functional`);
    await page.screenshot({ path: `${output}/${label}-returned-game.png` });
    results.push({ label, observationTick: observation.tick, image: true, route: [2, 1], pan: true, stage: { y: stage.y, height: stage.height } });
    await page.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ passed: true, base, results, screenshots: output }, null, 2));
} finally { await browser.close(); }
