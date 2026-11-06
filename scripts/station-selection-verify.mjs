import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH,
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const host = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:4175/';
try {
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 650 });
    await page.goto(host, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    const station = page.locator('[data-station="1"]');
    await station.click();
    assert.match(await station.getAttribute('aria-label'), /号.*车站/);
    const marker = await station.evaluate((node) => ({ selected: node.classList.contains('selected'),
      content: getComputedStyle(node, '::before').content }));
    assert.equal(marker.content, 'none', 'tapping a station must not paint a persistent selection halo');
    if (width < 650) assert.equal(await page.locator('#station-peek').isVisible(), true,
      'mobile tap retains passenger details for omitted piles');
    else {
      await page.locator('#station-detail').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#station-detail').isVisible(), true,
        'desktop tap retains station actions and details');
      assert.equal(await page.locator('#upgrade-station').count(), 1);
    }
    await page.evaluate(() => window.metro.restart({ seed: 420 }));
    const points = await page.evaluate(() => [1, 2, 3].map((id) => window.metro.projectStation(id)));
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 12 });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => window.metro.getState().lines[0].stops), [1, 2, 3],
      'dragging remains the primary line-building action');
    assert.equal(await station.evaluate((node) => getComputedStyle(node, '::before').content), 'none',
      'route drawing must not leave a station selection halo');
    await page.close();
  }
  console.log(JSON.stringify({ passed: true, variants: ['mobile', 'desktop'], interaction: 'tap detail without halo, drag route' }));
} finally { await browser.close(); }
