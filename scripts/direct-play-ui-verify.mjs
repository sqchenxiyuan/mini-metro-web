import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const [width, height] of [[1440, 900], [390, 844], [568, 320]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width <= 650 });
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    assert.equal(await page.locator('#replay-toggle:visible, #tools-toggle:visible').count(), 0,
      'normal-play HUD does not expose live replay or inspector');
    assert.equal(await page.locator('#inspector:visible, #station-peek:visible, #station-detail:visible').count(), 0);
    assert.equal(await page.locator('[data-speed="1"]:visible').count(), 1);
    const station = await page.evaluate(() => window.metro.projectStation(1));
    if (station.x > 0 && station.x < width && station.y > 0 && station.y < height) {
      await page.mouse.click(station.x, station.y);
      assert.equal(await page.locator('#station-peek:visible').count(), 1,
        'ordinary station tap shows its waiting passengers');
      assert.match(await page.locator('#station-peek').textContent(), /车站 1 · 候车/);
      assert.equal(await page.locator('#station-detail:visible').count(), 0,
        'ordinary page does not expose the AI inspector station card');
      assert.equal(await page.locator('#context-actions:visible [data-action="interchange"]').count() <= 1, true);
    }
    const line = page.locator('[data-line="0"]');
    if (await line.isVisible()) {
      await line.click();
      assert.equal(await page.locator('#context-actions:visible [data-action="addTrain"]').count(), 1,
        'line context exposes dispatch without an inspector');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#context-actions:visible').count(), 0);
    }
    await page.close();
  }
  const integration = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await integration.goto(new URL('integration.html', server.resolvedUrls.local[0]).href, { waitUntil: 'networkidle' });
  await integration.waitForFunction(() => window.metro);
  assert.equal(await integration.locator('#agent-toggle').count(), 1, 'AI entry retains control tools');
  assert.equal(await integration.locator('#agent-observation').count(), 1);
  await integration.close();
  console.log(JSON.stringify({ passed: true, viewports: ['1440x900', '390x844', '568x320'], integration: true }));
} finally {
  await browser.close();
  await server.close();
}
