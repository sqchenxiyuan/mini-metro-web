import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

// CSS contract fixture: controls are injected independently of unfinished main.ts wiring.
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? '/opt/hermes/tools/chromium-1208/chrome-linux64/chrome',
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/';
const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
try {
  for (const viewport of [{ width: 1200, height: 800 }, { width: 568, height: 320 }, { width: 390, height: 844 }, { width: 320, height: 480 }]) {
    const page = await browser.newPage({ viewport, hasTouch: viewport.width < 651 });
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.metro?.projectStation(1));
      const initial = await page.locator('#stage').boundingBox();
      const route = await page.evaluate(() => {
        const metro = window.metro;
        metro.restart({ mode: 'creative', seed: 77 });
        metro.pause();
        return metro.submit({ action: { type: 'route', line: 0, stops: [1, 2] } });
      });
      assert.ok(route.ok, 'real route fixture can render endpoints');
      if (viewport.width !== 320)
        await page.waitForFunction(() => document.querySelectorAll('[data-route-handle]').length >= 1);
      const realHandle = await page.evaluate(() => {
        const el = document.querySelector('[data-route-handle]');
        if (!el) return null;
        const style = getComputedStyle(el);
        return { color: style.fill, stroke: style.strokeWidth, radius: style.r, shadow: style.filter };
      });
      if (viewport.width !== 320) {
        assert.ok(realHandle, 'real route endpoint is rendered');
        assert.ok(parseFloat(realHandle.stroke) >= 3, `actual SVG endpoint has a contrasting edge ${JSON.stringify(realHandle)}`);
        assert.ok(parseFloat(realHandle.radius) >= 10, `actual SVG endpoint has a discernible visual mark ${JSON.stringify(realHandle)}`);
        assert.notEqual(realHandle.shadow, 'none', 'actual SVG endpoint has a distinct map silhouette');
      }
      if (viewport.width < 651) {
        await page.locator('#line-chooser').click();
      }
      await page.locator('[data-line="0"]').first().click();
      assert.equal(await page.locator('#context-actions').isVisible(), true, 'real line selection opens contextual actions');
      assert.equal(await page.locator('#context-actions [data-action="addTrain"]').count(), 1, 'actual add-train action is exposed');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#context-actions').isVisible(), false, 'Escape closes real context bar');
      assert.equal(await page.locator('#inspector').isVisible(), false, 'normal play has no permanent dispatch sidebar');
      await page.evaluate(() => {
        const actions = document.querySelector('#context-actions');
        actions.setAttribute('aria-label', '地图操作');
        actions.hidden = true;
        actions.innerHTML = '<button type="button" data-action="addTrain">添加列车</button><button type="button" data-action="interchange">换乘</button><button type="button" data-action="carriage">加挂</button><button type="button" data-action="uncar">卸挂</button><button type="button" data-action="retire">回收</button><button type="button" data-action="move">调往</button><button type="button" data-action="redraw">重画</button><button type="button" data-action="loop">闭环</button><button type="button" data-action="clear">撤销</button>';
        const station = document.querySelector('[data-station="1"]');
        const handle = document.createElement('button');
        handle.className = 'endpoint-handle';
        handle.type = 'button';
        handle.setAttribute('aria-label', '拖动线路端点');
        handle.style.setProperty('--line', 'rgb(214, 52, 70)');
        document.querySelector('#station-layer').append(handle);
        const preview = document.createElement('div');
        preview.className = 'loop-pull-preview';
        preview.style.setProperty('--line', 'rgb(214, 52, 70)');
        preview.style.left = '52%';
        preview.style.top = '53%';
        preview.style.width = '36px';
        preview.style.height = '36px';
        document.querySelector('#stage').append(preview);
        const sync = () => {
          const station = document.querySelector('[data-station="1"]').getBoundingClientRect();
          const stage = document.querySelector('#stage').getBoundingClientRect();
          handle.style.left = `${station.right - stage.left + 28}px`;
          handle.style.top = `${Math.max(22, Math.min(stage.height - 22, station.top - stage.top + station.height / 2))}px`;
        };
        window.syncCssHandle = sync;
        sync();
      });
      assert.equal(await page.locator('.context-actions').isVisible(), false, 'hidden contextual menu does not reserve stage');
      await page.locator('.context-actions').evaluate(el => { el.hidden = false; });
      await page.waitForTimeout(100);
      const result = await page.evaluate(() => {
        window.syncCssHandle();
        const rect = el => el.getBoundingClientRect().toJSON();
        const stage = rect(document.querySelector('#stage'));
        const bar = rect(document.querySelector('.context-actions'));
        const station = rect(document.querySelector('[data-station="1"]'));
        const handleEl = document.querySelector('.endpoint-handle');
        const handle = rect(handleEl);
        const mark = getComputedStyle(handleEl, '::before');
        const style = getComputedStyle(handleEl);
        const preview = getComputedStyle(document.querySelector('.loop-pull-preview'));
        const buttons = [...document.querySelectorAll('.context-actions button')].map(el => rect(el));
        return { stage, bar, station, handle, mark: { width: mark.width, height: mark.height, background: mark.backgroundColor }, buttons, color: style.color, background: style.backgroundColor,
          touchAction: style.touchAction, outline: style.outlineStyle, preview: { border: preview.borderTopStyle, color: preview.borderTopColor, pointerEvents: preview.pointerEvents },
          viewport: [innerWidth, innerHeight], document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
      });
      assert.ok(result.bar.width > 0 && result.bar.height >= 44, `context bar visible ${JSON.stringify(result)}`);
      assert.ok(!overlap(result.bar, result.stage), `context bar cannot cover station passenger queues ${JSON.stringify(result)}`);
      assert.ok(result.bar.bottom <= result.viewport[1], `context bar is entirely on screen ${JSON.stringify(result)}`);
      assert.ok(result.stage.height >= (viewport.height <= 320 ? 120 : 230), `usable drawable stage ${JSON.stringify(result)}`);
      assert.ok(initial.height - result.stage.height <= 56, `context menu takes at most one slim row ${JSON.stringify(result)}`);
      for (const button of result.buttons) assert.ok(button.width >= 44 && button.height >= 44, `button touch target ${JSON.stringify(button)}`);
      assert.ok(result.handle.width >= 44 && result.handle.height >= 44, `endpoint touch target ${JSON.stringify(result)}`);
      assert.ok(!overlap(result.handle, result.station), `endpoint hit area distinct from station hit area ${JSON.stringify(result)}`);
      assert.ok(!overlap(result.handle, result.bar), `endpoint cannot intercept contextual actions ${JSON.stringify(result)}`);
      assert.ok(parseFloat(result.mark.width) >= 12 && parseFloat(result.mark.width) < result.handle.width, 'colored visible mark distinct from transparent hit area');
      assert.equal(result.mark.background, 'rgb(214, 52, 70)', 'visible marker inherits route color');
      assert.equal(result.preview.border, 'dashed', 'loop pull preview is distinguishable from committed track');
      assert.equal(result.preview.color, 'rgb(214, 52, 70)', 'loop preview inherits route color');
      assert.equal(result.preview.pointerEvents, 'none', 'loop preview cannot steal map gestures');
      assert.equal(result.background, 'rgba(0, 0, 0, 0)', 'endpoint hit area transparent, not a second station body');
      assert.equal(result.color, 'rgb(214, 52, 70)', 'endpoint inherits route color');
      assert.equal(result.touchAction, 'none', 'endpoint dragging should not scroll the page');
      assert.deepEqual(result.document, result.viewport, 'no document overflow');
      await page.locator('.endpoint-handle[aria-label="拖动线路端点"]').focus();
      const focus = await page.locator('.endpoint-handle[aria-label="拖动线路端点"]').evaluate(el => getComputedStyle(el).outlineStyle);
      assert.notEqual(focus, 'none', 'keyboard endpoint has visible focus indication');
      await page.locator('#context-actions [data-action="addTrain"]').focus();
      const buttonFocus = await page.locator('#context-actions [data-action="addTrain"]').evaluate(el => getComputedStyle(el).outlineStyle);
      assert.notEqual(buttonFocus, 'none', 'keyboard contextual action has visible focus indication');
      await page.locator('#context-actions [data-action="addTrain"]').evaluate(el => { el.disabled = true; });
      const disabled = await page.locator('#context-actions [data-action="addTrain"]').evaluate(el => ({ cursor: getComputedStyle(el).cursor, opacity: getComputedStyle(el).opacity }));
      assert.equal(disabled.cursor, 'not-allowed', 'unavailable resource action visibly disabled');
      assert.ok(Number(disabled.opacity) < 1, 'disabled state clearly differentiated');
      console.log(JSON.stringify({ viewport, stage: result.stage, bar: result.bar, endpoint: result.handle, ok: true }));
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
