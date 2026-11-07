import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const [width, height, touch] of [[568, 320, true], [1024, 768, false]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    const reset = async () => {
      const result = await page.evaluate(() => {
        const m = window.metro;
        m.restart({ mode: 'creative', seed: 77 }); m.pause();
        return m.submit({ action: { type: 'route', line: 0, stops: [1, 2] } });
      });
      assert.equal(result.ok, true, JSON.stringify(result));
    };
    const stops = () => page.evaluate(() => window.metro.getState().lines.slice(0, 2).map(line => line.stops));
    const goal = page.locator('[data-station="3"]');
    const select = async () => {
      if (touch) {
        const box = await goal.boundingBox();
        assert.ok(box && !await goal.isHidden(), 'target station must be visible');
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      } else await goal.click();
    };
    await reset();
    const handle = page.getByRole('button', { name: /1号线终点.*延长/ });
    await handle.focus(); await page.keyboard.press('Enter');
    assert.equal(await handle.getAttribute('aria-pressed'), 'true', 'keyboard arms endpoint');
    await select();
    assert.deepEqual(await stops(), [[1, 2, 3], []], `${width}: real ${touch ? 'touch' : 'mouse'} station press must extend armed line`);
    console.log(`${width}: armed handle + station pointer passed`);

    if (touch) {
      await reset();
      const fixture = await page.evaluate(() => {
        const m = window.metro;
        return [[1, 3], [2, 1]].map((stops, index) => m.submit({ action: { type: 'route', line: index + 1, stops } }));
      });
      assert.ok(fixture.every(result => result.ok), JSON.stringify(fixture));
      const third = page.getByRole('button', { name: /3号线终点.*延长/ });
      await third.focus(); await page.keyboard.press('Enter');
      await select();
      assert.deepEqual(await page.evaluate(() => window.metro.getState().lines.slice(0, 3).map(line => line.stops)),
        [[1, 2], [1, 3], [2, 1, 3]], 'overlapping route endpoints preserve exact armed line identity');
    }

    await reset();
    await handle.focus(); await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await select();
    assert.deepEqual((await stops())[0], [1, 2], 'Escape cancels the arm before station selection');

    if (touch) {
      await reset();
      await page.evaluate(() => { const stage = document.querySelector('#stage'); stage.style.width = '40px'; stage.style.height = '40px'; });
      await page.locator('#zoom-in').click();
      const fallback = page.getByRole('button', { name: /1号线终点.*延长.*地图空间不足/ });
      assert.equal(await fallback.count(), 1, 'fallback endpoint exists when map cannot fit handle');
      await fallback.focus(); await page.keyboard.press('Enter');
      assert.equal(await fallback.getAttribute('aria-pressed'), 'true', JSON.stringify(await page.locator('[aria-label*="地图空间不足"]').evaluateAll(nodes => nodes.map(n => ({ label: n.getAttribute('aria-label'), pressed: n.getAttribute('aria-pressed'), active: n === document.activeElement })))));
      await page.evaluate(() => { const stage = document.querySelector('#stage'); stage.style.removeProperty('width'); stage.style.removeProperty('height'); });
      await page.locator('#zoom-reset').click();
      await select();
      assert.deepEqual(await stops(), [[1, 2, 3], []], 'fallback arm survives real touch on target');
      console.log('568: fallback arm + native touch passed');
    } else {
      await reset();
      const from = await handle.boundingBox(), to = await goal.boundingBox();
      assert.ok(from && to);
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 14 });
      await page.mouse.up();
      assert.deepEqual(await stops(), [[1, 2, 3], []], 'ordinary desktop drag still extends route');
      console.log('1024: desktop drag and Escape passed');
    }
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
