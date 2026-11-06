import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const base = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/';
const pagesBuild = process.env.METRO_PAGES_BUILD === '1';
let server;
if (pagesBuild) {
  const { createServer } = await import('node:http');
  const { resolve, extname, sep } = await import('node:path');
  const root = resolve('dist');
  server = createServer(async (req, res) => {
    try {
      const name = new URL(req.url, 'http://localhost').pathname.replace(/^\/mini-metro-web\//, '/');
      const file = resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + sep)) throw Error('invalid path');
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream' });
      res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}
const host = pagesBuild ? `http://127.0.0.1:${server.address().port}/mini-metro-web/` : base;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await page.goto(host, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  assert.equal(await page.locator('.agent-controls').isVisible(), false, 'normal game must not display automatic agents');
  assert.equal(await page.locator('#sample-route').isVisible(), false, 'normal game must not offer an automatic route');
  assert.equal(await page.locator('#decision-list').isVisible(), false, 'normal game must not show agent decisions');
  await page.locator('#tools-toggle').click();
  assert.equal(await page.locator('#station-detail').count(), 1);
  assert.equal(await page.locator('#agent-toggle').count(), 0, 'human bundle must not expose agent UI');
  await page.goto(new URL('integration.html', host).href, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  const runtime = page.locator('#integration-runtime');
  assert.equal(await runtime.isVisible(), true);
  const visibility = await runtime.boundingBox();
  assert.ok(visibility.y < 500, 'runtime controls must be discoverable near the first viewport');
  await page.locator('#integration-city').selectOption('harbor');
  await page.locator('#integration-mode').selectOption('endless');
  await page.locator('#integration-seed').fill('421');
  await page.locator('#integration-restart').click();
  assert.deepEqual(await page.evaluate(() => { const s = window.metro.getState(); return [s.city, s.mode, s.seed, s.tick]; }), ['harbor','endless',421,0]);
  await page.locator('#integration-ticks').fill('50');
  await page.locator('#integration-step').click();
  assert.equal(await page.evaluate(() => window.metro.getState().tick), 50);
  assert.equal(await page.evaluate(() => window.metro.controller.paused), true);
  await page.locator('#integration-speed').selectOption('2');
  assert.equal(await page.evaluate(() => window.metro.controller.speed), 2);
  assert.equal(await page.locator('[data-speed="2"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-speed="1"]').getAttribute('aria-pressed'), 'false');
  await page.locator('#integration-play').click();
  assert.equal(await page.evaluate(() => window.metro.controller.paused), false);
  await page.locator('#integration-pause').click();
  assert.equal(await page.evaluate(() => window.metro.controller.paused), true);
  await page.locator('#integration-seed').fill('-1');
  await page.locator('#integration-restart').click();
  assert.match(await page.locator('#integration-runtime-error').textContent(), /种子必须/);
  await page.waitForTimeout(650);
  assert.match(await page.locator('#integration-runtime-error').textContent(), /种子必须/,
    'invalid settings must remain visible after periodic refresh');
  assert.equal(await page.evaluate(() => window.metro.getState().seed), 421);
  assert.equal(await page.locator('#game-shell #app').count(), 1);
  assert.equal(await page.locator('#agent-toggle').count(), 1);
  assert.equal(await page.locator('#integration-controls').isVisible(), true);
  const scrollability = await page.evaluate(() => ({
    overflow: getComputedStyle(document.body).overflowY,
    controlsTop: document.querySelector('#integration-controls').getBoundingClientRect().top,
    viewport: innerHeight,
  }));
  assert.notEqual(scrollability.overflow, 'hidden', 'operator panel must be scrollable');
  await page.mouse.move(1100, 20);
  await page.mouse.wheel(0, 1200);
  await page.waitForFunction(() => scrollY > 50, null, { timeout: 3000 });
  assert.ok(await page.evaluate(() => document.querySelector('#integration-controls').getBoundingClientRect().top < innerHeight),
    'wheel must reach the lower AI controls');
  await page.locator('#integration-controls').scrollIntoViewIfNeeded();
  const family = await page.locator('#app').evaluate((node) => getComputedStyle(node).fontFamily);
  assert.match(family, /Noto Sans SC Metro/, 'integration game must use the same bundled Chinese font');
  assert.equal(await page.evaluate(() => document.fonts.check('14px "Noto Sans SC Metro"', '地铁乘客')), true);
  await page.locator('#integration-capture').click();
  assert.equal(await page.locator('#integration-image').isVisible(), true);
  await page.locator('#integration-observe').click();
  assert.match(await page.locator('#integration-observation').textContent(), /orchard-metro\.agent\.v1/);
  await page.locator('#integration-seed').fill('421');
  await page.locator('#integration-restart').click();
  await page.locator('#integration-preset-start').click();
  await page.waitForFunction(() => window.metro.controller.mode === 'agent' &&
    window.metro.controller.decisions.some((d) => d.source === 'preset-dispatcher'), null, { timeout: 5000 });
  const preset = await page.evaluate(() => ({ mode: window.metro.controller.mode,
    decisions: window.metro.controller.decisions.filter((d) => d.source === 'preset-dispatcher').length,
    lines: window.metro.getState().lines.filter((l) => l.stops.length).length }));
  assert.ok(preset.decisions > 0 && preset.lines > 0, 'preset must plan a route, not only change a status label');
  assert.equal(await page.locator('#integration-preset-stop').isEnabled(), true);
  await page.locator('#integration-preset-stop').click();
  assert.equal(await page.evaluate(() => window.metro.controller.mode), 'human');
  assert.equal(await page.evaluate(() => window.metro.controller.paused), true);
  const stopped = await page.evaluate(() => window.metro.getState().tick);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.metro.getState().tick), stopped, 'stopped preset must not advance the game');
  await page.locator('#integration-restart').click();
  assert.equal(await page.locator('#integration-preset-stop').isDisabled(), true);
  await page.locator('#integration-preset-start').click();
  await page.waitForFunction(() => window.metro.controller.mode === 'agent');
  await page.locator('#integration-pause').click();
  assert.equal(await page.evaluate(() => window.metro.controller.paused), true);
  assert.equal(await page.evaluate(() => window.metro.controller.mode), 'agent', 'pause should retain preset control');
  await page.locator('#integration-play').click();
  assert.equal(await page.evaluate(() => window.metro.controller.paused), false);
  await page.locator('#integration-preset-stop').click();
  await page.locator('#integration-preset-start').click();
  await page.waitForFunction(() => window.metro.controller.mode === 'agent');
  await page.locator('#integration-agent-url').fill('http://127.0.0.1:1/decide');
  await page.locator('#integration-connect').click();
  assert.equal(await page.locator('#integration-preset-stop').isDisabled(), true,
    'switching to HTTP Agent must release preset stop control');
  assert.equal(await page.locator('#integration-preset-start').isEnabled(), true);
  assert.match(await page.locator('#integration-runtime-state').textContent(), /http-agent/);
  await page.locator('#integration-stop').click();
  await page.locator('#integration-restart').click();
  await page.locator('#integration-preset-start').click();
  await page.waitForFunction(() => window.metro.controller.mode === 'agent');
  await page.locator('#tools-toggle').click();
  await page.locator('#agent-toggle').click();
  await page.waitForFunction(() => document.querySelector('#integration-preset-stop').disabled);
  assert.equal(await page.evaluate(() => window.metro.controller.mode), 'human');
  assert.equal(await page.locator('#integration-preset-start').isEnabled(), true);
  await page.locator('#integration-preset-start').click();
  await page.waitForFunction(() => window.metro.controller.mode === 'agent');
  await page.locator('#replay-toggle').click();
  await page.locator('#replay-current').click();
  await page.waitForFunction(() => document.querySelector('#integration-preset-stop').disabled &&
    document.querySelector('#integration-preset-start').disabled, null, { timeout: 2000 });
  assert.equal(await page.locator('#integration-preset-stop').isDisabled(), true);
  assert.equal(await page.locator('#integration-preset-start').isDisabled(), true);
  console.log(JSON.stringify({ passed: true, variants: ['human', 'integration'], preset }));
} finally { await browser.close(); if (server) await new Promise((resolve) => server.close(resolve)); }
