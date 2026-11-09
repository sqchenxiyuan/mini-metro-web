import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions({ ...process.env,
  METRO_BROWSER_EXECUTABLE_PATH: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? '/opt/hermes/tools/chromium-1208/chrome-linux64/chrome' }));
const route = (page, stops, mode = 'normal') => page.evaluate(({ stops, mode }) => {
  window.metro.restart({ seed: 420, mode }); window.metro.pause();
  return window.metro.submit({ action: { type: 'route', line: 0, stops, loop: false } });
}, { stops, mode });
const line = page => page.evaluate(() => window.metro.getState().lines[0]);
const hash = page => page.evaluate(() => window.metro.hash());
const point = (page, id) => page.evaluate(id => window.metro.projectStation(id), id);
const handle = (page, side) => page.locator(`[data-route-handle="0-${side}"]`).evaluate(el => {
  const rect = document.querySelector('#stage').getBoundingClientRect();
  return { x: rect.left + Number(el.getAttribute('cx')), y: rect.top + Number(el.getAttribute('cy')) };
});
async function pointer(page, touch) {
  if (!touch) return {
    down: p => page.mouse.move(p.x, p.y).then(() => page.mouse.down()),
    move: p => page.mouse.move(p.x, p.y, { steps: 1 }),
    up: () => page.mouse.up(),
    cancel: () => page.evaluate(() => document.querySelector('#stage').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))),
    close: async () => {},
  };
  const cdp = await page.context().newCDPSession(page);
  let last;
  const send = (type, p) => cdp.send('Input.dispatchTouchEvent', { type,
    touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ id: 1, x: p.x, y: p.y, radiusX: 4, radiusY: 4, force: 1 }] });
  return {
    down: async p => { last = p; await send('touchStart', p); },
    move: async p => { last = p; await send('touchMove', p); await page.waitForFunction(({ x, y }) =>
      window.__lastTouchMove && Math.hypot(window.__lastTouchMove.x - x, window.__lastTouchMove.y - y) < .05, p); },
    up: () => send('touchEnd', last),
    cancel: () => send('touchCancel', last),
    close: () => cdp.detach(),
  };
}
async function step(page, gesture, id, expected, label, before) {
  await gesture.move(await point(page, id));
  assert.equal(await hash(page), before, `${label}: hover must not mutate authority`);
  const preview = await page.evaluate(() => window.__routePreview);
  assert.deepEqual(preview?.stops, expected.length ? expected : [id], `${label}: transient preview reflects backtracking`);
  assert.equal(preview?.valid, true, `${label}: preview valid`);
  if (expected.length < 3) {
    const withdrawn = await page.locator('[data-route-retract]').count();
    assert.equal(withdrawn, expected.length === 2 ? 1 : 2, `${label}: every removed rail visibly marked`);
    assert.equal(await page.locator('[data-route-retract]').first().getAttribute('stroke'), '#e75c58');
  }
}
async function blankNear(page, stationId) {
  return page.evaluate(id => {
    const a = window.metro.projectStation(id), box = document.querySelector('#stage').getBoundingClientRect();
    const others = window.metro.getState().stations.map(s => window.metro.projectStation(s.id));
    for (const dx of [65, -65, 85, -85]) for (const dy of [0, 45, -45]) {
      const p = { x: a.x + dx, y: a.y + dy };
      if (p.x > box.left + 28 && p.x < box.right - 28 && p.y > box.top + 28 && p.y < box.bottom - 28 &&
          others.every(s => Math.hypot(p.x - s.x, p.y - s.y) > 48)) return p;
    }
    throw new Error(`no blank point near station ${id}`);
  }, stationId);
}
async function setup(page, touch, stops = [1, 2, 3], mode = 'normal') {
  assert.equal((await route(page, stops, mode)).ok, true);
  if (touch) {
    for (let i = 0; i < 6; i++) await page.locator('#zoom-out').click();
    const box = await page.locator('#stage').boundingBox();
    const drag = await pointer(page, true);
    await drag.down({ x: box.x + box.width - 20, y: box.y + box.height * .72 });
    await drag.move({ x: box.x + box.width - 120, y: box.y + box.height * .72 });
    await drag.up(); await drag.close();
  }
  const box = await page.locator('#stage').boundingBox();
  for (const id of stops) {
    const p = await point(page, id);
    assert.ok(p.x > box.x + 20 && p.x < box.x + box.width - 20 && p.y > box.y + 20 && p.y < box.y + box.height - 20,
      `${box.width}x${box.height} station ${id} visible ${JSON.stringify(p)}`);
  }
}
try {
  for (const [width, height, touch] of [[1280, 800, false], [390, 844, true], [568, 320, true]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    await page.evaluate(async () => {
      const { MetroRenderer } = await import('/src/renderer.ts');
      const original = MetroRenderer.prototype.showPreview;
      const originalDrawLane = MetroRenderer.prototype.drawLane;
      MetroRenderer.prototype.drawLane = function(...args) {
        window.__paintedScene = this; return originalDrawLane.apply(this, args);
      };
      MetroRenderer.prototype.showPreview = function(state, stops, line, valid) {
        window.__routePreview = { stops, line, valid }; return original.call(this, state, stops, line, valid);
      };
      const { Mobile3DRenderer } = await import('/src/mobile-3d.ts');
      const mobileOriginal = Mobile3DRenderer.prototype.showPreview;
      Mobile3DRenderer.prototype.showPreview = function(state, stops, line, valid) {
        window.__routePreview = { stops, line, valid }; return mobileOriginal.call(this, state, stops, line, valid);
      };
      document.querySelector('#stage').addEventListener('pointermove', e => {
        window.__lastTouchMove = { x: e.clientX, y: e.clientY };
      });
    });
    for (const side of ['end', 'start']) {
      await setup(page, touch);
      const before = await hash(page), drag = await pointer(page, touch);
      await drag.down(await handle(page, side));
      if (side === 'end') {
        await step(page, drag, 2, [1, 2], `${width} end retract`, before);
        await step(page, drag, 1, [], `${width} end last segment clears`, before);
      } else {
        await step(page, drag, 2, [2, 3], `${width} start retract`, before);
        await step(page, drag, 3, [], `${width} start last segment clears`, before);
      }
      await drag.up(); await drag.close();
      assert.deepEqual((await line(page)).stops, [], `${width} ${side}: last segment clears line`);
      assert.equal(await page.locator('[data-route-tip], [data-route-retract]').count(), 0, `${width} ${side}: gesture marks clear`);
    }
    await setup(page, touch);
    const before = await hash(page), drag = await pointer(page, touch);
    await drag.down(await handle(page, 'end'));
    await step(page, drag, 2, [1, 2], `${width} retract`, before);
    await step(page, drag, 3, [1, 2, 3], `${width} re-extend`, before);
    assert.equal(await page.locator('[data-route-retract]').count(), 0, 're-extension removes withdrawal marks');
    await drag.up(); await drag.close();
    assert.equal(await hash(page), before, `${width} re-extension to original is no-op`);
    await setup(page, touch);
    const reversed = await pointer(page, touch), reverseBefore = await hash(page);
    await reversed.down(await handle(page, 'end'));
    await step(page, reversed, 2, [1, 2], `${width} reverse first`, reverseBefore);
    await step(page, reversed, 1, [], `${width} reverse last`, reverseBefore);
    await step(page, reversed, 2, [1, 2], `${width} reverse restores last rail`, reverseBefore);
    await reversed.up(); await reversed.close();
    assert.deepEqual((await line(page)).stops, [1, 2], `${width} released reversal keeps restored rail`);
    await setup(page, touch);
    const beforeCancel = await hash(page), canceled = await pointer(page, touch);
    await canceled.down(await handle(page, 'end'));
    await step(page, canceled, 2, [1, 2], `${width} cancel preview`, beforeCancel);
    await canceled.cancel(); await canceled.close();
    assert.equal(await hash(page), beforeCancel, `${width} cancel keeps route`);
    assert.equal(await page.locator('[data-route-retract]').count(), 0, 'cancel removes withdrawal marks');
    // The settled station ID remains latched through intervening blank space;
    // returning to it without another station visit cannot undo twice.
    await setup(page, touch);
    const repeatBefore = await hash(page), repeated = await pointer(page, touch);
    await repeated.down(await handle(page, 'end'));
    await step(page, repeated, 2, [1, 2], `${width} first visit`, repeatBefore);
    const p2 = await point(page, 2), p3 = await point(page, 3);
    await repeated.move({ x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 - 40 });
    await repeated.move(p2);
    assert.deepEqual((await page.evaluate(() => window.__routePreview))?.stops, [1, 2], `${width} repeated station no second retract`);
    await repeated.up(); await repeated.close();
    assert.deepEqual((await line(page)).stops, [1, 2]);
    // Re-entering either opposite endpoint after leaving it must re-arm closure.
    // A repeat visit to an adjacent station through blank space above must not double retract.
    for (const side of ['end', 'start']) {
      await setup(page, touch);
      const oppositeId = side === 'end' ? 1 : 3;
      const reentryBefore = await hash(page), reentry = await pointer(page, touch);
      await reentry.down(await handle(page, side));
      await reentry.move(await point(page, oppositeId));
      const closingStops = [1, 2, 3, 1];
      assert.deepEqual((await page.evaluate(() => window.__routePreview))?.stops, closingStops);
      await reentry.move(await blankNear(page, oppositeId));
      assert.equal((await page.evaluate(() => window.__routePreview))?.stops?.length, 3, `${width} ${side} closure disarmed off station`);
      await reentry.move(await point(page, oppositeId));
      assert.deepEqual((await page.evaluate(() => window.__routePreview))?.stops, closingStops, `${width} ${side} closure re-armed`);
      assert.equal(await hash(page), reentryBefore, `${width} ${side} closure preview remains transient`);
      await reentry.up(); await reentry.close();
      assert.equal((await line(page)).loop, true, `${width} ${side} closure commits after re-entry`);
    }
    await setup(page, touch, [1, 2, 3], 'creative');
    assert.equal((await page.evaluate(() => window.metro.submit({ action: {
      type: 'station', x: 5, y: -5, shape: 'star' } }))).ok, true, `${width} fourth replacement station seeded`);
    const fourthId = await page.evaluate(() => window.metro.getState().stations.at(-1).id);
    const replacementBefore = await hash(page), replacement = await pointer(page, touch);
    const fourth = await point(page, fourthId);
    const stageBox = await page.locator('#stage').boundingBox();
    assert.ok(fourth.x > stageBox.x + 20 && fourth.x < stageBox.x + stageBox.width - 20 &&
      fourth.y > stageBox.y + 20 && fourth.y < stageBox.y + stageBox.height - 20, `${width} replacement station 4 visible`);
    await replacement.down(await handle(page, 'end'));
    await replacement.move(await point(page, 2));
    await replacement.move(await point(page, fourthId));
    assert.deepEqual((await page.evaluate(() => window.__routePreview))?.stops, [1, 2, fourthId], `${width} equal-length replacement preview`);
    assert.equal(await hash(page), replacementBefore, `${width} equal-length preview does not edit authority`);
    assert.equal(await page.locator('[data-route-retract]').count(), 1, `${width} removed 2–3 rail marked despite equal stop count`);
    assert.ok(await page.evaluate(() => {
      const scene = window.__paintedScene, layout = scene?.getPaintedTrackLayout();
      if (!layout) return false;
      const edge = layout.segments.find(s => s.from === 2 && s.to === 3);
      const marked = document.querySelector('[data-route-retract]');
      const points = marked?.getAttribute('points')?.trim().split(/\s+/).map(s => s.split(',').map(Number));
      if (!edge || !points || points.length !== edge.points.length) return false;
      return edge.points.every((p, i) => {
        const q = scene.project(p.x, p.y, .6);
        return Math.hypot(q.x - points[i][0], q.y - points[i][1]) < 1;
      });
    }), `${width} removal mark follows each painted 2–3 bend, not station chord`);
    await replacement.up(); await replacement.close();
    assert.deepEqual((await line(page)).stops, [1, 2, fourthId], `${width} replacement committed`);
    assert.equal(await page.locator('[data-route-retract]').count(), 0, 'replacement mark clears on release');
    // Restart must discard a live draft, its retract marks, and any later pointerup.
    await setup(page, touch);
    const interrupted = await pointer(page, touch);
    await interrupted.down(await handle(page, 'end'));
    await step(page, interrupted, 2, [1, 2], `${width} restart withdrawal`, await hash(page));
    assert.equal(await page.locator('[data-route-retract]').count(), 1, 'withdrawal visible before restart');
    await page.evaluate(() => { window.metro.restart({ seed: 420, mode: 'normal' }); window.metro.pause(); });
    assert.deepEqual((await line(page)).stops, [], `${width} new game has no route`);
    assert.equal(await page.locator('[data-route-retract], [data-route-tip]').count(), 0, `${width} restart clears transient marks`);
    const restartedHash = await hash(page);
    await interrupted.up(); await interrupted.close();
    assert.equal(await hash(page), restartedHash, `${width} interrupted pointerup cannot edit new game`);
    assert.equal(await page.locator('[data-route-retract]').count(), 0, `${width} interrupted pointerup cannot restore stale overlay`);
    // Directly jumping to the opposite endpoint is still the existing loop
    // gesture; it must never be interpreted as a multi-stop deletion.
    await setup(page, touch);
    const skipBefore = await hash(page), skipped = await pointer(page, touch);
    await skipped.down(await handle(page, 'end'));
    await skipped.move(await point(page, 1));
    assert.equal(await hash(page), skipBefore);
    assert.deepEqual((await page.evaluate(() => window.__routePreview))?.stops, [1, 2, 3, 1], `${width} nonadjacent opposite endpoint remains loop closure`);
    await skipped.up(); await skipped.close();
    assert.deepEqual(await line(page), { id: 0, stops: [1, 2, 3], loop: true }, `${width} loop closure preserved`);
    await setup(page, touch, [1, 2, 3], 'extreme');
    const beforeExtreme = await hash(page), restricted = await pointer(page, touch);
    await restricted.down(await handle(page, 'end'));
    await restricted.move(await point(page, 2));
    assert.equal(await hash(page), beforeExtreme);
    assert.equal((await page.evaluate(() => window.__routePreview))?.valid, false, 'extreme retraction visibly invalid');
    await restricted.up(); await restricted.close();
    assert.equal(await hash(page), beforeExtreme, 'extreme retraction rejected');
    assert.deepEqual(errors, [], `${width} browser errors`);
    console.log(`${width}x${height} ${touch ? 'native touch' : 'mouse'}: both ends, clear, re-extend, loop re-entry, equal-length bent-rail replacement, restart cancellation, extreme passed`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
