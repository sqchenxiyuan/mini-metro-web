import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './browser-launch.mjs';

const base = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:4175/integration.html';
const output = '/opt/data/cache/scratch/mini-metro-inspector-hit';
await mkdir(output, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const [width, height] of [[390, 844], [568, 320], [320, 480]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true, acceptDownloads: true });
    try {
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.metro && document.fonts.status === 'loaded');
      for (const state of (height <= 600 ? ['map-first', 'normal'] : ['normal'])) {
      if (state === 'normal' && height <= 600) await page.locator('#map-first-toggle').click();
      await page.evaluate(() => window.scrollTo(0, window.scrollY +
        document.querySelector('#stage').getBoundingClientRect().top - 140));
      await page.locator('#tools-toggle').click();
      assert.equal(await page.locator('#inspector').isVisible(), true);
      await page.locator('#inspector-close').scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(() => {
        const position = selector => {
          const node = document.querySelector(selector), rect = node.getBoundingClientRect();
          const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
          const hit = document.elementFromPoint(x, y);
          return { rect: rect.toJSON(), x, y, hit: hit?.id || hit?.className,
            hittable: node.contains(hit) };
        };
        return { viewport: [innerWidth, innerHeight], scrollY, mapFirst: document.body.classList.contains('map-first'),
          panel: position('#inspector'), tools: position('.map-tools'),
          screenshot: position('#screenshot'), close: position('#inspector-close') };
      });
      await page.screenshot({ path: `${output}/${width}x${height}-${state}-open.png` });
      console.log(JSON.stringify({ state, geometry }));
      for (const [name, target] of [['screenshot', geometry.screenshot], ['close', geometry.close]]) {
        assert.ok(target.rect.width >= 44 && target.rect.height >= 44,
          `${width}x${height} ${name} needs a 44px touch target: ${JSON.stringify(geometry)}`);
        assert.ok(target.hittable, `${width}x${height} ${name} center must hit itself: ${JSON.stringify(geometry)}`);
      }
      const [shot, close] = [geometry.screenshot.rect, geometry.close.rect];
      assert.ok(shot.right <= close.left || close.right <= shot.left || shot.bottom <= close.top || close.bottom <= shot.top,
        `${width}x${height} screenshot and close targets must not overlap: ${JSON.stringify(geometry)}`);
      const download = page.waitForEvent('download');
      await page.touchscreen.tap(geometry.screenshot.x, geometry.screenshot.y);
      assert.match((await download).suggestedFilename(), /^orchard-metro-.*\.png$/);
      assert.equal(await page.locator('#inspector').isVisible(), true, 'screenshot does not close inspector');
      await page.touchscreen.tap(geometry.close.x, geometry.close.y);
      assert.equal(await page.locator('#inspector').isVisible(), false, 'close hides inspector via native touch');
      }
    } finally { await page.close(); }
  }
  console.log('Integration screenshot and inspector close are separately touch-hittable.');
} finally { await browser.close(); }
