import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const output = '/opt/data/cache/scratch/metro-ai-pinch-ownership';
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
let browser;
try {
  browser = await chromium.launch(browserLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro?.mobileMapStats()?.stationCount >= 3);
  const cdp = await page.context().newCDPSession(page);
  const point = (id, p) => ({ id, x: p.x, y: p.y, radiusX: 3, radiusY: 3, force: .6 });
  const send = (type, touches) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: touches });
  const snapshot = () => page.evaluate(() => ({
    mode: window.metro.controller.mode,
    source: window.metro.controller.activeAgentSource,
    hash: window.metro.hash(),
    zoom: window.metro.mobileMapStats().zoom,
    stops: window.metro.getState().lines[0].stops,
  }));
  async function startPausedAI(withRoute) {
    await page.evaluate(withRoute => {
      const m = window.metro;
      m.restart({ mode: 'endless', seed: 420 });
      if (withRoute) m.submit({ action: { type: 'route', line: 0, stops: [1, 2] }, reason: 'pinch fixture' });
      m.startAgent(() => undefined, 'pinch-regression-policy');
      m.pause();
    }, withRoute);
    await page.waitForFunction(() => window.metro.controller.mode === 'agent' && window.metro.controller.paused);
    return snapshot();
  }
  async function pinch(anchor, name) {
    const stage = await page.locator('#stage').boundingBox();
    assert.ok(stage && anchor.x >= stage.x + 18 && anchor.x <= stage.x + stage.width - 18 &&
      anchor.y >= stage.y + 18 && anchor.y <= stage.y + stage.height - 18, `${name}: anchor is inside stage`);
    // The second contact is in the map, away from the first; spread it while
    // retaining the original station/endpoint finger, as a real pinch does.
    const direction = anchor.x < stage.x + stage.width / 2 ? 1 : -1;
    const second = { x: anchor.x + direction * 65, y: anchor.y };
    const first = point(1, anchor), other = point(2, second);
    const before = await snapshot();
    await send('touchStart', [first]);
    assert.equal((await snapshot()).mode, 'agent', `${name}: touching a route target is not a takeover`);
    await send('touchStart', [first, other]);
    for (let i = 1; i <= 5; i++) {
      await send('touchMove', [first, point(2, { x: second.x + direction * i * 8, y: second.y })]);
    }
    await send('touchEnd', []);
    await page.waitForTimeout(80);
    const after = await snapshot();
    assert.equal(after.mode, 'agent', `${name}: pinch must retain AI control`);
    assert.equal(after.source, before.source, `${name}: AI policy source unchanged`);
    assert.equal(after.hash, before.hash, `${name}: pinch must not change authoritative state`);
    assert.deepEqual(after.stops, before.stops, `${name}: no route edit on pinch`);
    assert.ok(after.zoom > before.zoom + .04, `${name}: pinch zoom changes (${before.zoom} -> ${after.zoom})`);
    await page.screenshot({ path: `${output}/${name}-pinch.png` });
    return { before, after };
  }
  const stationBefore = await startPausedAI(false);
  await page.screenshot({ path: `${output}/station-before.png` });
  const station = await page.evaluate(() => window.metro.projectStation(1));
  const stationPinch = await pinch(station, 'station');

  await startPausedAI(true);
  await page.waitForFunction(() => document.querySelectorAll('.endpoint-handle').length > 0);
  const endpoint = await page.locator('.endpoint-handle').first().boundingBox();
  assert.ok(endpoint, 'endpoint drag handle exists');
  const endpointPinch = await pinch({ x: endpoint.x + endpoint.width / 2, y: endpoint.y + endpoint.height / 2 }, 'endpoint');

  await startPausedAI(false);
  const [from, to] = await page.evaluate(() => [1, 2].map(id => window.metro.projectStation(id)));
  const beforeDrag = await snapshot();
  await send('touchStart', [point(3, from)]);
  assert.equal((await snapshot()).mode, 'agent', 'route touch remains AI-owned until valid commit');
  for (let i = 1; i <= 12; i++) {
    const p = { x: from.x + (to.x - from.x) * i / 12, y: from.y + (to.y - from.y) * i / 12 };
    await send('touchMove', [point(3, p)]);
    await page.waitForTimeout(18);
  }
  assert.equal((await snapshot()).mode, 'agent', 'route preview remains AI-owned before release');
  assert.equal((await snapshot()).hash, beforeDrag.hash, 'route preview never edits authoritative state');
  await send('touchEnd', []);
  const afterDrag = await snapshot();
  assert.deepEqual(afterDrag.stops, [1, 2], 'native one-finger drag commits a route');
  assert.equal(afterDrag.mode, 'human', 'valid route commit explicitly takes control');
  assert.notEqual(afterDrag.hash, beforeDrag.hash, 'route edit changes authoritative state');
  await page.screenshot({ path: `${output}/route-commit.png` });
  assert.deepEqual(errors, [], 'no browser errors');
  console.log(JSON.stringify({ passed: true, stationPinch, endpointPinch, routeCommit: { before: beforeDrag, after: afterDrag }, screenshots: output }, null, 2));
  await cdp.detach();
} finally {
  if (browser) await browser.close();
  await server.close();
}
