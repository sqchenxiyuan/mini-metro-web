import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const iterations = Number(process.env.FALLBACK_ITERATIONS || 8);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
const outcomes = [];
try {
  const page = await browser.newPage({ viewport: { width: 568, height: 320 }, hasTouch: true, isMobile: true });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  const fallback = page.getByRole('button', { name: /3号线终点.*延长.*地图空间不足/ });
  for (let i = 0; i < iterations; i++) {
    const routes = await page.evaluate(() => {
      const m = window.metro;
      m.restart({ mode: 'creative', seed: 77 }); m.pause();
      return [[1, 2], [1, 3], [2, 1]].map((stops, line) => m.submit({ action: { type: 'route', line, stops } }).ok);
    });
    assert.deepEqual(routes, [true, true, true], 'shared-endpoint fixture');
    await page.evaluate(() => { const stage = document.querySelector('#stage'); stage.style.width = '40px'; stage.style.height = '40px'; });
    await page.locator('#zoom-in').click();
    assert.equal(await fallback.count(), 1, 'third route has exactly one accessible keyboard fallback');
    await fallback.focus();
    await page.evaluate(() => {
      const selector = '[role="group"][aria-label*="地图空间不足"] button';
      const button = [...document.querySelectorAll(selector)].find(b => b.getAttribute('aria-label')?.startsWith('3号线终点'));
      window.__fallbackTrace = { button, events: [], mutations: [] };
      const trace = window.__fallbackTrace;
      const identify = node => node === button ? 'original' : node?.getAttribute?.('aria-label') || node?.tagName || null;
      trace.snapshot = phase => {
        const current = [...document.querySelectorAll(selector)].find(b => b.getAttribute('aria-label')?.startsWith('3号线终点'));
        return { phase, originalConnected: button.isConnected, originalActive: document.activeElement === button,
          currentIsOriginal: current === button, currentActive: document.activeElement === current,
          currentPressed: current?.getAttribute('aria-pressed'), active: identify(document.activeElement) };
      };
      trace.events.push(trace.snapshot('focused'));
      for (const type of ['focusin', 'focusout', 'keydown', 'click']) {
        const listener = e => trace.events.push({ type, key: e.key, target: identify(e.target), active: identify(document.activeElement) });
        document.addEventListener(type, listener, true);
        (trace.listeners ??= []).push([type, listener]);
      }
      trace.observer = new MutationObserver(records => trace.mutations.push(...records.flatMap(r =>
        [...r.removedNodes].filter(n => n.nodeType === 1).map(n => ({ removed: identify(n), parent: identify(r.target) })))));
      trace.observer.observe(document.querySelector('[role="group"][aria-label*="地图空间不足"]'), { childList: true });
    });
    // Force a real stage resize and ResizeObserver frame before a simulation repaint.
    await page.evaluate(() => {
      const stage = document.querySelector('#stage');
      stage.style.width = '41px'; stage.style.height = '41px';
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const afterResize = await page.evaluate(() => window.__fallbackTrace.snapshot('resize'));
    await page.evaluate(() => window.metro.step(1));
    const afterPaint = await page.evaluate(() => window.__fallbackTrace.snapshot('repaint'));
    await page.keyboard.press('Enter');
    const afterEnter = await page.evaluate(() => window.__fallbackTrace.snapshot('enter'));
    await page.evaluate(() => window.metro.step(1));
    const afterArmedPaint = await page.evaluate(() => window.__fallbackTrace.snapshot('armed repaint'));
    const trace = await page.evaluate(() => {
      const t = window.__fallbackTrace;
      t.observer.disconnect();
      for (const [type, listener] of t.listeners) document.removeEventListener(type, listener, true);
      return { events: t.events, mutations: t.mutations };
    });
    await page.evaluate(() => { const stage = document.querySelector('#stage'); stage.style.removeProperty('width'); stage.style.removeProperty('height'); });
    await page.locator('#zoom-reset').click();
    const onMap = page.getByRole('button', { name: /3号线终点延长：激活后选目标车站/ });
    assert.equal(await onMap.count(), 1, 'restored map exposes the armed endpoint as an on-map handle');
    assert.equal(await onMap.getAttribute('aria-pressed'), 'true',
      'armed fallback keeps its pressed state when it becomes an on-map handle');
    const target = await page.locator('[data-station="3"]').boundingBox();
    assert.ok(target, 'target visible after restoring the stage');
    await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
    const stops = await page.evaluate(() => window.metro.getState().lines.slice(0, 3).map(line => line.stops));
    outcomes.push({ iteration: i + 1, afterResize, afterPaint, afterEnter, afterArmedPaint, stops, trace });
  }
  console.log(JSON.stringify({ iterations, outcomes, errors }));
  assert.deepEqual(errors, [], 'browser must have no errors');
  assert.equal(outcomes.filter(o => o.afterResize.originalConnected && o.afterResize.originalActive &&
    o.afterPaint.originalConnected && o.afterPaint.originalActive &&
    o.afterPaint.currentIsOriginal && o.afterEnter.currentPressed === 'true' &&
    o.afterArmedPaint.originalActive && o.afterArmedPaint.currentIsOriginal &&
    o.afterArmedPaint.currentPressed === 'true' &&
    JSON.stringify(o.stops) === JSON.stringify([[1, 2], [1, 3], [2, 1, 3]])).length,
  iterations, 'focused fallback keeps identity/focus through resize and repaints, then extends exact endpoint');
} finally { await browser.close(); await server.close(); }
