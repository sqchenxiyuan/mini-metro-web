import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 320, height: 480 }, isMobile: true, hasTouch: true });
const state = () => page.evaluate(() => window.metro.getState());
const route = () => page.evaluate(() => {
  window.metro.restart({ mode: 'creative', seed: 77 });
  window.metro.pause();
  const result = window.metro.submit({ action: { type: 'route', line: 0, stops: [1, 2] } });
  if (!result.ok) throw Error(JSON.stringify(result));
});
const handle = side => page.getByRole('button', { name: new RegExp(`1号线${side}.*延长`) });
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
  a.y < b.y + b.height && a.y + a.height > b.y;
async function assertReachable() {
  const stage = await page.locator('#stage').boundingBox();
  assert.ok(stage, 'stage is measurable');
  for (const side of ['起点', '终点']) {
    const button = handle(side);
    assert.equal(await button.count(), 1, `320x480 ${side}: real accessible endpoint button exists`);
    const box = await button.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= stage.x && box.y >= stage.y &&
      box.x + box.width <= stage.x + stage.width && box.y + box.height <= stage.y + stage.height,
      `320x480 ${side}: entire 44px touch target stays inside stage`);
    for (const stationId of [1, 2]) {
      const station = await page.locator(`[data-station="${stationId}"]`).boundingBox();
      assert.ok(station && !overlaps(box, station), `${side} does not cover station ${stationId}`);
    }
    const queueBounds = await page.evaluate(() => window.metro.sceneCues().bounds.filter(b => b.kind === 'queue'));
    for (const queue of queueBounds) {
      if (queue.x + queue.width <= 0 || queue.x >= stage.width || queue.y + queue.height <= 0 || queue.y >= stage.height) continue;
      assert.ok(!overlaps(box, {x: stage.x + queue.x, y: stage.y + queue.y,
        width: queue.width, height: queue.height}), `${side} does not cover visible passenger queue ${queue.id}`);
    }
    assert.equal(await button.evaluate(node => document.elementFromPoint(
      (node.getBoundingClientRect().left + node.getBoundingClientRect().right) / 2,
      (node.getBoundingClientRect().top + node.getBoundingClientRect().bottom) / 2) === node), true,
    `${side} center receives actual pointer input`);
  }
  const [start, end] = await Promise.all([handle('起点').boundingBox(), handle('终点').boundingBox()]);
  assert.ok(!overlaps(start, end), 'independent 44px endpoint controls do not overlap');
}
async function targetVisible(side) {
  // Built-in camera control, never hidden DOM dispatch or programmatic route mutation.
  await page.locator('#map-overview').focus();
  for (let i = 0; i < 10; i++) {
    const stage = await page.locator('#stage').boundingBox();
    const target = await page.locator('[data-station="3"]').boundingBox();
    if (target && target.x >= stage.x && target.y >= stage.y &&
        target.x + target.width <= stage.x + stage.width && target.y + target.height <= stage.y + stage.height) break;
    await page.keyboard.press('ArrowRight');
  }
  const stage = await page.locator('#stage').boundingBox();
  const button = await handle(side).count() ? await handle(side).boundingBox() : null;
  const target = await page.locator('[data-station="3"]').boundingBox();
  assert.ok(target && target.x >= stage.x && target.y >= stage.y &&
    target.x + target.width <= stage.x + stage.width && target.y + target.height <= stage.y + stage.height,
    'target station 3 has its entire 44px target inside the stage');
  if (side === '终点') assert.ok(button && button.x >= stage.x && button.y >= stage.y &&
    button.x + button.width <= stage.x + stage.width && button.y + button.height <= stage.y + stage.height,
    'end handle remains fully reachable while station 3 is visible');
}
try {
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  await route();
  const diagnostic = await page.evaluate(() => ({stage: document.querySelector('#stage').getBoundingClientRect().toJSON(),
    stations: [1,2].map(id => ({id, point: window.metro.projectStation(id), box: document.querySelector(`[data-station="${id}"]`).getBoundingClientRect().toJSON()})),
    zoom: window.metro.mobileMapStats().zoom, handles: document.querySelectorAll('.endpoint-handle').length}));
  console.log('320x480 geometry:', JSON.stringify(diagnostic));
  await assertReachable();
  await page.locator('#zoom-reset').click();
  await assertReachable();
  await page.locator('#map-first-toggle').click();
  await page.locator('#map-first-toggle').click();
  await assertReachable();
  const station = page.locator('[data-station="3"]');
  await handle('起点').focus();
  await page.keyboard.press('Enter');
  assert.equal(await handle('起点').getAttribute('aria-pressed'), 'true', 'keyboard arms start');
  await targetVisible('起点');
  await station.focus();
  await page.keyboard.press('Enter');
  assert.deepEqual((await state()).lines[0].stops, [3, 1, 2], 'keyboard prepends to original route');
  assert.deepEqual((await state()).lines[1].stops, [], 'does not create another line');
  await route();
  await targetVisible('终点');
  const button = await handle('终点').boundingBox(), destination = await station.boundingBox();
  const a = {x: button.x + button.width / 2, y: button.y + button.height / 2};
  const b = {x: destination.x + destination.width / 2, y: destination.y + destination.height / 2};
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{id: 1, x, y, radiusX: 4, radiusY: 4, force: 1}],
  });
  await touch('touchStart', a.x, a.y);
  for (let i = 1; i <= 14; i++) await touch('touchMove', a.x + (b.x - a.x) * i / 14, a.y + (b.y - a.y) * i / 14);
  await touch('touchEnd', b.x, b.y);
  assert.deepEqual((await state()).lines[0].stops, [1, 2, 3], 'real touch drag appends to original route');
  assert.deepEqual((await state()).lines[1].stops, [], 'touch does not create another line');
  console.log('320x480 endpoint buttons, keyboard prepend, touch append passed');
} finally {
  await page.close(); await browser.close(); await server.close();
}
