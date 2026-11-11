import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const output = process.env.METRO_REVISIT_OUTPUT ?? '/opt/data/cache/scratch/metro-new-node-revisit';
const evidence = [];
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions({ ...process.env,
  METRO_BROWSER_EXECUTABLE_PATH: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? '/opt/hermes/tools/chromium-1208/chrome-linux64/chrome' }));
const authority = page => page.evaluate(() => ({ hash: metro.hash(), decisions: metro.controller.decisions.length,
  mode: metro.controller.mode, source: metro.controller.activeAgentSource,
  resources: metro.getState().resources, lines: metro.getState().lines }));
const point = (page, id) => page.evaluate(id => metro.projectStation(id), id);
async function fixture(page, stops = []) {
  const ids = await page.evaluate(stops => {
    metro.restart({ seed: 420, mode: 'creative' }); metro.pause();
    // Publicly create the extra stations; only their geometry is deterministic fixture data.
    for (const [x, y] of [[-10, -6], [10, -6], [-10, 6], [10, 6], [-5, -6], [5, 6]]) {
      if (metro.getState().stations.length >= 5) break;
      metro.submit({ action: { type: 'station', x, y, shape: 'star' } });
    }
    if (metro.getState().stations.length < 5) throw new Error('public creative station setup failed');
    const s = metro.controller.session.state;
    const extent = innerWidth < 450 ? 5 : 8, row = innerHeight < 400 ? 1 : 2;
    const geometry = [[-extent, -row], [0, -row], [extent, -row], [-extent, row], [extent, row]];
    s.stations.forEach((station, i) => { [station.x, station.y] = geometry[i]; });
    const ids = s.stations.map(station => station.id);
    if (stops.length) {
      const result = metro.submit({ action: { type: 'route', line: 0, stops: stops.map(i => ids[i]), loop: false } });
      if (!result.ok) throw new Error(result.message);
    }
    metro.controller.onChange();
    window.__preview = null;
    return ids;
  }, stops);
  await page.evaluate(() => {
    const renderer = window.__revisitRenderer;
    renderer.setZoom(metro.mobileMapStats() ? .55 : .8);
    const box = document.querySelector('#stage').getBoundingClientRect();
    const points = metro.getState().stations.map(s => metro.projectStation(s.id));
    renderer.pan(box.left + box.width / 2 - (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2,
      box.top + box.height / 2 - (Math.min(...points.map(p => p.y)) + Math.max(...points.map(p => p.y))) / 2);
    metro.controller.onChange();
    metro.startAgent(() => undefined, 'new-node-revisit-policy'); metro.pause();
  });
  const box = await page.locator('#stage').boundingBox();
  for (const id of ids) {
    const p = await point(page, id);
    assert.ok(p.x > box.x + 30 && p.x < box.x + box.width - 30 && p.y > box.y + 30 && p.y < box.y + box.height - 30,
      `fixture station ${id} inside stage ${JSON.stringify({ p, box })}`);
  }
  return ids;
}
async function native(page, touch) {
  if (!touch) return {
    down: async p => { await page.mouse.move(p.x, p.y); await page.mouse.down(); },
    move: p => page.mouse.move(p.x, p.y), up: () => page.mouse.up(), close: async () => {},
  };
  const cdp = await page.context().newCDPSession(page);
  const send = (type, p) => cdp.send('Input.dispatchTouchEvent', { type,
    touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x: p.x, y: p.y, radiusX: 4, radiusY: 4, force: 1 }] });
  return {
    down: p => send('touchStart', p),
    move: async p => { await send('touchMove', p); await page.waitForFunction(p => window.__move &&
      Math.hypot(window.__move.x - p.x, window.__move.y - p.y) < .1, p); },
    up: () => send('touchEnd'), close: () => cdp.detach(),
  };
}
async function blank(page, id) {
  return page.evaluate(id => {
    const p = metro.projectStation(id), box = document.querySelector('#stage').getBoundingClientRect();
    const points = metro.getState().stations.map(s => metro.projectStation(s.id));
    for (const radius of [65, 85, 110]) for (let i = 0; i < 24; i++) {
      const q = { x: p.x + radius * Math.cos(i * Math.PI / 12), y: p.y + radius * Math.sin(i * Math.PI / 12) };
      if (q.x > box.left + 30 && q.x < box.right - 30 && q.y > box.top + 30 && q.y < box.bottom - 30 &&
        points.every(s => Math.hypot(q.x - s.x, q.y - s.y) > 48)) return q;
    }
    throw new Error('safe blank point unavailable');
  }, id);
}
async function check(page, stops, before, label) {
  const preview = await page.evaluate(() => window.__preview), current = await authority(page);
  assert.deepEqual(preview?.stops, stops, label);
  assert.deepEqual(current, before, `${label}: draft cannot edit authority, consume resources, record, or take control`);
  evidence.push({ label, preview, authority: current });
}
async function tip(page, id, paint = false) {
  const anchor = await point(page, id), box = await page.locator('#stage').boundingBox();
  const line = await page.locator('[data-route-tip]').evaluate(el => ({ x: +el.getAttribute('x1'), y: +el.getAttribute('y1'),
    x2: +el.getAttribute('x2'), y2: +el.getAttribute('y2'), color: el.getAttribute('stroke') }));
  assert.ok(Math.hypot(line.x - anchor.x + box.x, line.y - anchor.y + box.y) < 3, 'actual SVG tip follows current draft endpoint');
  if (paint) {
    const screenshot = await page.screenshot();
    assert.ok(await page.evaluate(async ({ bytes, line, box }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
      const rgb = line.color.match(/[a-f\d]{2}/gi).map(hex => parseInt(hex, 16)), ratio = bitmap.width / innerWidth;
      return [.35, .5, .65, .8].some(t => {
        const x = Math.round((box.x + line.x + (line.x2 - line.x) * t) * ratio);
        const y = Math.round((box.y + line.y + (line.y2 - line.y) * t) * ratio);
        const pixels = ctx.getImageData(x - 4, y - 4, 9, 9).data;
        return Array.from({ length: 81 }, (_, i) => i * 4).some(i => rgb.every((c, j) => Math.abs(pixels[i + j] - c) < 30));
      });
    }, { bytes: [...screenshot], line, box }), 'draft tip is painted in actual browser pixels, not merely recorded');
  }
}
try {
  for (const [width, height, touch] of [[1280, 800, false], [390, 844, true], [568, 320, true]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    await page.evaluate(async () => {
      const { MetroRenderer } = await import('/src/renderer.ts');
      const { Mobile3DRenderer } = await import('/src/mobile-3d.ts');
      for (const Renderer of [MetroRenderer, Mobile3DRenderer]) {
        const render = Renderer.prototype.render, preview = Renderer.prototype.showPreview;
        Renderer.prototype.render = function(...args) { const result = render.apply(this, args); window.__revisitRenderer = this; return result; };
        Renderer.prototype.showPreview = function(s, stops, line, valid) {
          window.__preview = { stops: [...stops], line, valid }; return preview.call(this, s, stops, line, valid);
        };
      }
      document.querySelector('#stage').addEventListener('pointermove', e => { window.__move = { x: e.clientX, y: e.clientY }; });
    });
    const [a, b, c] = await fixture(page), before = await authority(page), drag = await native(page, touch);
    await drag.down(await point(page, a));
    await drag.move(await point(page, b)); await drag.move(await point(page, c));
    await check(page, [a, b, c], before, `${width} body A-B-C`);
    await drag.move(await blank(page, c));
    await tip(page, c, true);
    await page.screenshot({ path: `${output}/${width}-body-before-revisit.png` });
    await drag.move(await point(page, c));
    await check(page, [a, b], before, `${width} body second crossing removes newly added C`);
    await tip(page, b, true);
    await page.screenshot({ path: `${output}/${width}-body-after-revisit.png` });
    const cp = await point(page, c);
    await drag.move({ x: cp.x + 4, y: cp.y + 4 });
    await check(page, [a, b], before, `${width} body jitter cannot immediately add C back`);
    await drag.move(await blank(page, c)); await drag.move(cp);
    await check(page, [a, b, c], before, `${width} body third entry adds C again`);
    await drag.move(await blank(page, c)); await drag.move(cp);
    await check(page, [a, b], before, `${width} body fourth entry removes C again`);
    await drag.up(); await drag.close();
    const after = await authority(page);
    assert.deepEqual(after.lines[0].stops, [a, b], `${width} body release commits reduced ordered route`);
    assert.equal(after.decisions, before.decisions + 1, 'body completed gesture records exactly one action');
    assert.equal(after.mode, 'human', 'only completed route takes control');
    assert.equal(await page.evaluate(() => metro.controller.decisions.at(-1).result.ok), true);
    await page.evaluate(() => metro.pause());
    assert.deepEqual(errors, []);
    console.log(`${width}x${height} ${touch ? 'CDP touch' : 'mouse'}: body revisit/jitter/re-add/one-action passed`);
    for (const side of ['end', 'start']) {
      const ids = await fixture(page, [0, 1]), [a, b, c, d] = ids;
      const before = await authority(page), drag = await native(page, touch);
      const handle = await page.locator(`[data-route-handle="0-${side}"]`).evaluate(el => {
        const r = document.querySelector('#stage').getBoundingClientRect();
        return { x: r.left + +el.getAttribute('cx'), y: r.top + +el.getAttribute('cy') };
      });
      const expected = extra => side === 'start' ? [...extra].reverse().concat([a, b]) : [a, b, ...extra];
      await drag.down(handle); await drag.move(await point(page, c));
      await check(page, expected([c]), before, `${width} ${side} adds new C`);
      await drag.move(await blank(page, c)); await drag.move(await point(page, c));
      await check(page, [a, b], before, `${width} ${side} second crossing removes new C`);
      await tip(page, side === 'start' ? a : b, true);
      await page.screenshot({ path: `${output}/${width}-${side}-after-revisit.png` });
      const cp = await point(page, c);
      await drag.move({ x: cp.x + 4, y: cp.y + 4 });
      await check(page, [a, b], before, `${width} ${side} jitter cannot restore C`);
      await drag.move(await blank(page, c)); await drag.move(cp);
      await check(page, expected([c]), before, `${width} ${side} third entry restores C`);
      await drag.move(await point(page, d));
      await check(page, expected([c, d]), before, `${width} ${side} adds D after C`);
      await drag.move(await blank(page, d)); await drag.move(await point(page, d));
      await check(page, expected([c]), before, `${width} ${side} reverse-cross D removes only D`);
      await drag.move(await blank(page, c)); await drag.move(cp);
      await check(page, [a, b], before, `${width} ${side} reverse-cross C restores original`);
      await drag.up(); await drag.close();
      assert.deepEqual(await authority(page), before, `${width} ${side} release of original topology is a strict no-op`);
      assert.equal(await page.locator('[data-route-tip], [data-route-retract], [data-route-snap]').count(), 0);
    }
    // Original stations keep their established blank-space latch, unlike new ones.
    for (const side of ['end', 'start']) {
      const [a, b, c] = await fixture(page, [0, 1, 2]);
      const before = await authority(page), drag = await native(page, touch);

      const handle = await page.locator(`[data-route-handle="0-${side}"]`).evaluate(el => {
        const r = document.querySelector('#stage').getBoundingClientRect();
        return { x: r.left + +el.getAttribute('cx'), y: r.top + +el.getAttribute('cy') };
      });
      const own = side === 'end' ? c : a, expected = side === 'end' ? [a, b] : [b, c];
      await drag.down(handle); await drag.move(await point(page, own));
      await check(page, expected, before, `${width} ${side} original own endpoint retracts`);
      await drag.move(await blank(page, own)); await drag.move(await point(page, own));
      await check(page, expected, before, `${width} ${side} original endpoint remains latched after blank`);
      await page.keyboard.press('Escape'); await drag.up(); await drag.close();
      assert.deepEqual(await authority(page), before, 'Escape discards visit state and authority');
    }
    // Cancellation and restart discard new-station re-entry state as well.
    for (const kind of ['body', 'endpoint']) for (const cancel of ['Escape', 'restart']) {
      const [a, b, c] = await fixture(page, kind === 'endpoint' ? [0, 1] : []);
      const drag = await native(page, touch), before = await authority(page);
      const start = kind === 'body' ? await point(page, a) : await page.locator('[data-route-handle="0-end"]').evaluate(el => {
        const r = document.querySelector('#stage').getBoundingClientRect();
        return { x: r.left + +el.getAttribute('cx'), y: r.top + +el.getAttribute('cy') };
      });
      await drag.down(start);
      if (kind === 'body') await drag.move(await point(page, b));
      await drag.move(await point(page, c)); await drag.move(await blank(page, c)); await drag.move(await point(page, c));
      await check(page, [a, b], before, `${width} ${kind} canceled reduced draft`);
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else await page.evaluate(() => { metro.restart({ seed: 420, mode: 'creative' }); metro.pause(); });
      const canceled = await authority(page);
      await drag.up(); await drag.close();
      assert.deepEqual(await authority(page), canceled, `${cancel}: stale release cannot submit`);
      if (cancel === 'Escape') assert.deepEqual(canceled, before);
      assert.equal(await page.locator('[data-route-tip], [data-route-retract], [data-route-snap]').count(), 0);
    }
    // A body's initial anchor still closes a loop; leaving disarms and re-entry re-arms.
    {
      const [a, b, c] = await fixture(page), before = await authority(page), drag = await native(page, touch);
      await drag.down(await point(page, a)); await drag.move(await point(page, b)); await drag.move(await point(page, c));
      await drag.move(await point(page, a));
      await check(page, [a, b, c, a], before, `${width} initial anchor closes loop`);
      await drag.move(await blank(page, a));
      await check(page, [a, b, c], before, `${width} loop disarms in blank`);
      await drag.move(await point(page, a));
      await check(page, [a, b, c, a], before, `${width} loop re-arms on anchor re-entry`);
      await page.keyboard.press('Escape'); await drag.up(); await drag.close();
      assert.deepEqual(await authority(page), before);
    }
    assert.deepEqual(errors, []);
    console.log(`${width}x${height}: mirrored endpoint revisit/re-add/multiple-new-stops/no-op, original latch, loop and cleanup passed`);
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(evidence, null, 2));
} finally { await browser.close(); await server.close(); }
