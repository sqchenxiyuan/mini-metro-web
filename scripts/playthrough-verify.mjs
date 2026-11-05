// Production-build browser playthrough. UI actions and white-box acceleration are logged separately.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';
import { RULES } from '../dist-sdk/index.mjs';

const out = 'test-results/playthrough';
await mkdir(out, { recursive: true });
const events = [];
const record = (kind, data) => { const item = { kind, ...data }; events.push(item); console.log(JSON.stringify(item)); };
const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch(browserLaunchOptions());
const failures = [];
const watch = (page, label) => {
  page.on('pageerror', e => { failures.push({ label, type: 'pageerror', message: String(e) }); record('browser-error', failures.at(-1)); });
  page.on('console', msg => { if (msg.type() === 'error') { failures.push({ label, type: 'console', message: msg.text() }); record('browser-error', failures.at(-1)); } });
  page.on('requestfailed', req => { failures.push({ label, type: 'requestfailed', url: req.url(), message: req.failure()?.errorText }); record('browser-error', failures.at(-1)); });
};
const state = page => page.evaluate(() => {
  const s = window.metro.getState();
  return { tick: s.tick, elapsed: s.elapsed, week: s.week, phase: s.phase, score: s.score,
    stations: s.stations.length, lines: s.lines.map(l => ({ id: l.id, stops: l.stops, loop: l.loop })),
    trains: s.trains.length, upgrades: s.upgrades, lostStation: s.lostStation, resources: s.resources,
    paused: window.metro.controller.paused, speed: window.metro.controller.speed,
    mode: window.metro.controller.mode };
});
const shot = async (page, name) => {
  const path = `${out}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  record('screenshot', { path });
};
const point = async (page, id) => {
  const box = await page.locator(`[data-station="${id}"]`).boundingBox();
  assert.ok(box, `station ${id} must be on-screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const drawMouse = async (page, a, b) => {
  const start = await point(page, a), end = await point(page, b);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 28 });
  await page.mouse.up();
  await page.waitForTimeout(180);
  record('UI-mouse-drag', { from: a, to: b, start, end, after: await state(page), toast: await page.locator('#toast').innerText() });
};
const drawTouch = async (page, a, b) => {
  const start = await point(page, a), end = await point(page, b), cdp = await page.context().newCDPSession(page);
  const contact = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 6, radiusY: 6, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: contact(start.x, start.y) });
  for (let i = 1; i <= 24; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: contact(start.x + (end.x - start.x) * i / 24, start.y + (end.y - start.y) * i / 24) });
    await page.waitForTimeout(12);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(220);
  record('UI-touch-drag', { from: a, to: b, start, end, after: await state(page), toast: await page.locator('#toast').innerText() });
};
const layout = page => page.evaluate(() => {
  const ids = ['#stage', '#upgrade-panel', '#game-over', '#play-pause', '#resources', '#line-list'];
  return { viewport: [innerWidth, innerHeight], scrollWidth: document.documentElement.scrollWidth,
    boxes: Object.fromEntries(ids.map(id => { const e = document.querySelector(id), r = e.getBoundingClientRect(); return [id, { x: r.x, y: r.y, width: r.width, height: r.height, hidden: e.hidden }]; })) };
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  watch(page, 'desktop');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.metro);
  await page.click('#new-game');
  await page.selectOption('#city-select', 'orchard');
  await page.selectOption('#mode-select', 'normal');
  await page.fill('#seed-input', '420');
  await page.click('#settings-form button[type="submit"]');
  record('UI-new-game', { url, state: await state(page), stationLabels: await page.locator('[data-station]').evaluateAll(ns => ns.map(n => ({ id: n.dataset.station, box: n.getBoundingClientRect().toJSON() }))) });
  await shot(page, 'desktop-start');
  await drawMouse(page, 1, 2);
  assert.deepEqual((await state(page)).lines[0].stops, [1, 2], 'mouse drag should establish first line');
  await drawMouse(page, 2, 3);
  record('UI-extend', { state: await state(page) });
  await page.click('#line-tools-toggle');
  await page.click('#add-train');
  record('UI-add-train', { state: await state(page), toast: await page.locator('#toast').innerText() });
  await page.click('#line-tools-close');
  await page.click('#play-pause');
  assert.equal((await state(page)).paused, true, 'pause button');
  const pauseTick = (await state(page)).tick;
  await page.waitForTimeout(650);
  assert.equal((await state(page)).tick, pauseTick, 'clock remains frozen while paused');
  await page.click('[data-speed="4"]');
  assert.equal(await page.locator('[data-speed="4"]').getAttribute('aria-pressed'), 'true');
  await page.click('#play-pause');
  await page.waitForTimeout(1050);
  record('UI-pause-speed-play', { pausedTick: pauseTick, after: await state(page) });
  await shot(page, 'desktop-early-playing');
  await page.waitForFunction(() => ['upgrade', 'over'].includes(window.metro.getState().phase), { timeout: 70000 });
  if ((await state(page)).phase === 'upgrade') await page.locator('#upgrade-panel').waitFor({ state: 'visible' });
  record('UI-real-time-milestone', { state: await state(page), layout: await layout(page) });
  await shot(page, 'desktop-first-milestone');
  if ((await state(page)).phase === 'upgrade') {
    const option = page.locator('#upgrade-panel [data-upgrade]').first();
    const selected = await option.getAttribute('data-upgrade');
    await option.click();
    record('UI-weekly-choice', { choice: selected, after: await state(page), toast: await page.locator('#toast').innerText() });
    assert.equal((await state(page)).phase, 'playing', 'UI upgrade resumes phase');
    await shot(page, 'desktop-after-reward');
    // New line after weekly reward, drawn via browser mouse rather than an injected action.
    if ((await state(page)).lines.length > 1) {
      await page.locator('[data-line="1"]').click();
      await drawMouse(page, 1, 3);
      record('UI-second-line', { state: await state(page) });
    }
  }
  // White-box time acceleration only: no routes, upgrades or train actions are injected.
  // Session.step pauses playback, so each upgrade is still selected through the visible UI.
  for (let i = 0; i < 80 && (await state(page)).phase !== 'over'; i++) {
    const before = await state(page);
    if (before.phase === 'upgrade') {
      const option = page.locator('#upgrade-panel [data-upgrade]').first();
      const choice = await option.getAttribute('data-upgrade');
      await option.click();
      record('UI-weekly-choice', { choice, after: await state(page) });
      continue;
    }
    const after = await page.evaluate((ticks) => {
      window.metro.step(ticks);
      const s = window.metro.getState();
      return { tick: s.tick, week: s.week, phase: s.phase, score: s.score, stations: s.stations.length };
    }, RULES.dayTicks);
    if (i % 4 === 0 || after.phase !== 'playing') record('API-step-one-game-day', { iteration: i, after });
    if (i === 20 || i === 40) await shot(page, `desktop-api-progress-${i}`);
  }
  record('API-accelerated-final', { state: await state(page), layout: await layout(page), overlay: await page.locator('#game-over').innerText() });
  await shot(page, 'desktop-final');
  if ((await state(page)).phase === 'over') {
    assert.equal(await page.locator('#game-over').isVisible(), true);
    await page.click('#over-replay');
    record('UI-replay-from-ending', { state: await state(page), replayMax: await page.locator('#timeline').getAttribute('max') });
    await shot(page, 'desktop-replay');
  }
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  watch(mobile, 'touch-mobile');
  await mobile.goto(url, { waitUntil: 'networkidle' });
  await mobile.waitForFunction(() => !!window.metro);
  await mobile.click('#new-game');
  await mobile.selectOption('#city-select', 'harbor');
  await mobile.fill('#seed-input', '42');
  await mobile.click('#settings-form button[type="submit"]');
  record('UI-mobile-start', { state: await state(mobile), layout: await layout(mobile) });
  await shot(mobile, 'mobile-start');
  await drawTouch(mobile, 1, 2);
  await shot(mobile, 'mobile-touch-route');
  await mobile.click('[data-speed="2"]');
  await mobile.click('#play-pause');
  record('UI-mobile-pause-speed', { state: await state(mobile), layout: await layout(mobile) });
  assert.ok((await state(mobile)).lines[0].stops.length >= 2, 'touch drag should establish a line');
  const textMetrics = await mobile.evaluate(() => Object.fromEntries(['#resources', '#resources span', '#week-label', '.line-choice'].map(sel => {
    const el = document.querySelector(sel), cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return [sel, { fontSize: cs.fontSize, color: cs.color, width: r.width, height: r.height }];
  })));
  record('UI-mobile-text-metrics', { textMetrics });
  // White-box mobile time fixture; reward is still accepted by a real touch/click on its visible option.
  const advanced = await mobile.evaluate((ticks) => { window.metro.step(ticks); const s = window.metro.getState(); return { phase: s.phase, tick: s.tick, week: s.week, score: s.score }; }, RULES.weekTicks);
  await mobile.waitForTimeout(200);
  record('API-mobile-step-to-reward', { advanced, layout: await layout(mobile) });
  if (advanced.phase === 'upgrade') {
    await shot(mobile, 'mobile-weekly-reward');
    const choice = await mobile.locator('#upgrade-panel [data-upgrade]').first().getAttribute('data-upgrade');
    await mobile.locator('#upgrade-panel [data-upgrade]').first().click();
    record('UI-mobile-weekly-choice', { choice, state: await state(mobile) });
  }
  await mobile.close();
} catch (error) {
  record('verification-failure', { error: String(error), stack: error.stack });
  process.exitCode = 1;
} finally {
  await writeFile(`${out}/events.json`, JSON.stringify({ url, events, failures }, null, 2));
  await browser.close();
  await new Promise((resolve, reject) => server.httpServer.close(err => err ? reject(err) : resolve()));
  console.log(JSON.stringify({ log: `${out}/events.json`, events: events.length, browserErrors: failures.length, status: process.exitCode ? 'failed' : 'completed' }));
}
