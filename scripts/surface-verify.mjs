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
  assert.equal(await page.locator('#game-shell #app').count(), 1);
  assert.equal(await page.locator('#agent-toggle').count(), 1);
  assert.equal(await page.locator('#integration-controls').isVisible(), true);
  const family = await page.locator('#app').evaluate((node) => getComputedStyle(node).fontFamily);
  assert.match(family, /Noto Sans SC Metro/, 'integration game must use the same bundled Chinese font');
  assert.equal(await page.evaluate(() => document.fonts.check('14px "Noto Sans SC Metro"', '地铁乘客')), true);
  await page.locator('#integration-capture').click();
  assert.equal(await page.locator('#integration-image').isVisible(), true);
  await page.locator('#integration-observe').click();
  assert.match(await page.locator('#integration-observation').textContent(), /orchard-metro\.agent\.v1/);
  console.log(JSON.stringify({ passed: true, variants: ['human', 'integration'] }));
} finally { await browser.close(); if (server) await new Promise((resolve) => server.close(resolve)); }
