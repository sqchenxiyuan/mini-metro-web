import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions({ ...process.env,
  METRO_BROWSER_EXECUTABLE_PATH: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? '/opt/hermes/tools/chromium-1208/chrome-linux64/chrome' }));
const state = page => page.evaluate(() => window.metro.getState());
const stations = page => page.evaluate(() => [1, 2, 3].map(id => window.metro.projectStation(id)));
const hash = page => page.evaluate(() => window.metro.hash());
const route = (page, stops) => page.evaluate(stops => window.metro.submit({ action: { type: 'route', line: 0, stops, loop: false } }), stops);
async function reset(page, mode) {
  await page.evaluate(mode => {
    const m = window.metro;
    m.restart({ seed: 420, mode }); m.pause();
    if (m.getState().phase === 'upgrade') m.submit({ action: { type: 'upgrade', choice: m.getState().upgrades[0] } });
  }, mode);
  await page.waitForFunction(() => window.metro.getState().stations.length >= 3);
  await page.waitForTimeout(120);
}
async function handle(page, side) {
  return page.locator(`[data-route-handle="0-${side}"]`).evaluate(el => {
    const rect = document.querySelector('#stage').getBoundingClientRect();
    return { x: rect.left + Number(el.getAttribute('cx')), y: rect.top + Number(el.getAttribute('cy')) };
  });
}
async function gesture(page, touch) {
  if (!touch) return {
    async down(p) { await page.mouse.move(p.x, p.y); await page.mouse.down(); },
    async move(p) { await page.mouse.move(p.x, p.y, { steps: 12 }); },
    async moveDirect(p) { await page.mouse.move(p.x, p.y, { steps: 1 }); },
    async up() { await page.mouse.up(); },
    async cancel() { await page.evaluate(() => document.querySelector('#stage').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))); },
    async close() {},
  };
  const cdp = await page.context().newCDPSession(page);
  let last = null;
  const send = (type, p) => cdp.send('Input.dispatchTouchEvent', { type,
    touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ id: 1, x: p.x, y: p.y, radiusX: 4, radiusY: 4, force: 1 }] });
  const settled = async p => page.waitForFunction(({ x, y }) =>
    window.__lastTouchMove && Math.hypot(window.__lastTouchMove.x - x, window.__lastTouchMove.y - y) < .05,
  p);
  return {
    async down(p) { last = p; await send('touchStart', p); },
    async move(p) { const from = last; for (let i = 1; i <= 12; i++)
      await send('touchMove', { x: from.x + (p.x - from.x) * i / 12, y: from.y + (p.y - from.y) * i / 12 }); last = p;
      await settled(p); },
    async moveDirect(p) { await send('touchMove', p); last = p; await settled(p); },
    async up() { await send('touchEnd', last); },
    async cancel() { await send('touchCancel', last); },
    async close() { await cdp.detach(); },
  };
}
async function checkTip(page, anchor, pointer, label) {
  const geometry = await page.locator('[data-route-tip]').evaluateAll(nodes => nodes.map(el => ({
    x1: Number(el.getAttribute('x1')), y1: Number(el.getAttribute('y1')),
    x2: Number(el.getAttribute('x2')), y2: Number(el.getAttribute('y2')),
    dash: el.getAttribute('stroke-dasharray'), stroke: el.getAttribute('stroke'),
  })));
  assert.equal(geometry.length, 1, `${label}: one transient rendered route segment`);
  const rect = await page.locator('#stage').boundingBox();
  const tip = geometry[0];
  assert.ok(Math.hypot(tip.x1 - (anchor.x - rect.x), tip.y1 - (anchor.y - rect.y)) < 3, `${label}: tip starts at last station`);
  assert.ok(Math.hypot(tip.x2 - (pointer.x - rect.x), tip.y2 - (pointer.y - rect.y)) < 3, `${label}: tip follows the actual pointer between stations ${JSON.stringify({ tip, pointer, rect })}`);
  assert.ok(tip.stroke && tip.dash, `${label}: tip is a visibly painted dashed route`);
  return tip;
}
async function afterGesture(page, beforeHash, label, expected, stops = [1, 2, 3]) {
  assert.equal(await page.locator('[data-route-tip]').count(), 0, `${label}: transient tip clears`);
  if (expected) assert.deepEqual((await state(page)).lines[0], { id: 0, stops, loop: true }, `${label}: gesture closes loop`);
  else {
    const current = await state(page);
    assert.deepEqual(current.lines[0], { id: 0, stops, loop: false }, `${label}: original route remains`);
    assert.equal(await hash(page), beforeHash, `${label}: canceled/rejected gesture does not mutate authority`);
  }
}
// Chromium 1208's CDP screenshots are an independent painted-pixel assertion:
// the SVG tip can exist in the DOM but be hidden under the mobile canvas.
async function paintedAt(page, point, color) {
  const screenshot = await page.locator('#stage').screenshot();
  return page.evaluate(async ({ bytes, point, color }) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
    const image = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const rect = document.querySelector('#stage').getBoundingClientRect();
    const ratio = image.width / rect.width;
    const x = Math.round((point.x - rect.left) * ratio), y = Math.round((point.y - rect.top) * ratio);
    const expected = color.match(/[a-f0-9]{2}/gi).map(hex => parseInt(hex, 16));
    const pixels = ctx.getImageData(x - 4, y - 4, 9, 9).data;
    return Array.from({ length: 81 }, (_, i) => i * 4).some(i =>
      expected.every((channel, index) => Math.abs(pixels[i + index] - channel) < 28));
  }, { bytes: [...screenshot], point, color });
}
try {
  for (const [width, height, touch] of [[1280, 800, false], [390, 844, true]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    // CDP acknowledges dispatch before Chromium necessarily delivers pointermove.
    // Wait for the event itself, not a timer, then assert the independently read SVG.
    await page.evaluate(()=>document.querySelector('#stage').addEventListener('pointermove',e=>{
      window.__lastTouchMove={x:e.clientX,y:e.clientY};}));
    for (const [mode, kind, side] of [['normal', 'body', null], ['normal', 'endpoint', 'end'],
      ['normal', 'endpoint', 'start'], ['extreme', 'endpoint', 'end'], ['extreme', 'endpoint', 'start']]) {
      await reset(page, mode);
      if (touch) {
        for (let i = 0; i < 6; i++) await page.locator('#zoom-out').click();
        const box = await page.locator('#stage').boundingBox();
        const prep = await gesture(page, true);
        await prep.down({ x: box.x + box.width - 20, y: box.y + box.height * .72 });
        await prep.move({ x: box.x + box.width - 120, y: box.y + box.height * .72 });
        await prep.up(); await prep.close();
      }
      let [a, b, c] = await stations(page);
      const box = await page.locator('#stage').boundingBox();
      for (const [n, p] of [[1, a], [2, b], [3, c]])
        assert.ok(p && p.x > box.x + 22 && p.x < box.x + box.width - 22 && p.y > box.y + 22 && p.y < box.y + box.height - 22,
          `${width} ${kind} ${mode}: station ${n} visible at ${JSON.stringify(p)}`);
      if (kind === 'endpoint') assert.equal((await route(page, [1, 2, 3])).ok, true, 'seed open line through public route action');
      const start = kind === 'body' ? a : await handle(page, side);
      const anchor = side === 'start' ? a : c;
      const target = side === 'start' ? c : a;
      if (mode === 'extreme') assert.equal((await state(page)).lines[0].loop, false, 'extreme begins with open route');
      const before = await hash(page);
      const drag = await gesture(page, touch);
      await drag.down(start);
      if (kind === 'body') { await drag.move(b); await drag.move(c); }
      // An off-station point: inspect the actual painted preview BEFORE release.
      const midway = { x: anchor.x + (target.x - anchor.x) * .35,
        y: anchor.y + (target.y - anchor.y) * .35 };
      await drag.move(midway);
      const tip = await checkTip(page, anchor, midway, `${width} ${mode} ${kind} ${side} first mid-route`);
      if (touch && mode === 'normal' && kind === 'endpoint' && side === 'end')
        await page.screenshot({path:'/opt/data/cache/scratch/metro-acceptance/390x844-native-route-tip.png'});
      if (kind === 'body' && mode === 'normal') {
        const onRoute = { x: anchor.x + (midway.x - anchor.x) * .6,
          y: anchor.y + (midway.y - anchor.y) * .6 };
        assert.ok(await paintedAt(page, onRoute, tip.stroke), `${width}: transient route visible in rendered pixels`);
      }
      assert.equal(await hash(page), before, 'preview never mutates authoritative state');
      const next = { x: anchor.x + (target.x - anchor.x) * .65,
        y: anchor.y + (target.y - anchor.y) * .65 };
      await drag.move(next);
      await checkTip(page, anchor, next, `${width} ${mode} ${kind} ${side} second mid-route`);
      await drag.move(target);
      assert.equal(await hash(page), before, 'closing preview remains transient');
      await drag.up(); await drag.close();
      await afterGesture(page, before, `${width} ${mode} ${kind} ${side ?? ''}`, mode === 'normal');
      console.log(`${width} ${touch ? 'CDP touch' : 'mouse'} ${mode} ${kind} ${side ?? ''}: loop/authority/continuous preview verified`);
    }
    // Hovering the closing station must not latch a loop after moving away,
    // including blank space, the last stop, and an interior station.
    for (const kind of ['body', 'endpoint']) for (const destination of ['blank', 'current', 'interior']) {
      await reset(page, 'normal');
      if (touch) {
        for (let i = 0; i < 6; i++) await page.locator('#zoom-out').click();
        const box = await page.locator('#stage').boundingBox(), prep = await gesture(page, true);
        await prep.down({ x: box.x + box.width - 20, y: box.y + box.height * .72 });
        await prep.move({ x: box.x + box.width - 120, y: box.y + box.height * .72 });
        await prep.up(); await prep.close();
      }
      const [a, b, c] = await stations(page);
      if (kind === 'endpoint') assert.equal((await route(page, [1, 2, 3])).ok, true);
      const before = await hash(page), drag = await gesture(page, touch);
      await drag.down(kind === 'body' ? a : await handle(page, 'end'));
      if (kind === 'body') { await drag.move(b); await drag.move(c); }
      await drag.move(a);
      const away = await page.evaluate(({ a, b, c }) => {
        const box = document.querySelector('#stage').getBoundingClientRect();
        for (const dx of [65, -65, 85, -85]) for (const dy of [0, 45, -45]) {
          const p = { x: a.x + dx, y: a.y + dy };
          if (p.x > box.left + 28 && p.x < box.right - 28 && p.y > box.top + 28 && p.y < box.bottom - 28 &&
              [a, b, c].every(s => Math.hypot(p.x - s.x, p.y - s.y) > 48)) return p;
        }
        throw new Error('no safely blank release point');
      }, { a, b, c });
      const release = destination === 'current' ? c : destination === 'interior' ? b : away;
      if (destination === 'blank') await drag.move(release);
      else await drag.moveDirect(release);
      if (destination !== 'interior') await checkTip(page, c, release,
        `${width} ${kind} leaves closing station for ${destination}`);
      else assert.equal(await page.locator('[data-route-tip]').count(), 1,
        'interior hover still has a visual route tip');
      await drag.up(); await drag.close();
      const line = (await state(page)).lines[0];
      assert.equal(line.loop, false, `${width} ${kind}: leaving closing station for ${destination} must not commit a loop`);
      assert.deepEqual(line.stops, destination === 'interior' ? [1, 2] : [1, 2, 3]);
      if (kind === 'endpoint' && destination !== 'interior')
        assert.equal(await hash(page), before, 'rejected endpoint hover cannot mutate state');
      assert.equal(await page.locator('[data-route-tip]').count(), 0);
    }
    // Pointer cancel must remove the same visual, without submitting a route.
    await reset(page, 'normal');
    if (touch) {
      for (let i = 0; i < 6; i++) await page.locator('#zoom-out').click();
      const box = await page.locator('#stage').boundingBox(), prep = await gesture(page, true);
      await prep.down({ x: box.x + box.width - 20, y: box.y + box.height * .72 });
      await prep.move({ x: box.x + box.width - 100, y: box.y + box.height * .72 });
      await prep.up(); await prep.close();
    }
    const [a, b] = await stations(page), before = await hash(page), drag = await gesture(page, touch);
    await drag.down(a);
    const mid = { x: a.x + (b.x - a.x) * .45, y: a.y + (b.y - a.y) * .45 };
    await drag.move(mid);
    await checkTip(page, a, mid, `${width} cancel before station`);
    await drag.cancel(); await drag.close();
    await afterGesture(page, before, `${width} cancel`, false, []);
    assert.deepEqual(errors, [], `${width} browser errors`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
