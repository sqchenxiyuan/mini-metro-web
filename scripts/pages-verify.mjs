import { chromium } from '@playwright/test';
import { browserLaunchOptions } from '../scripts/browser-launch.mjs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';

const base = '/mini-metro-web/';
const dist = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith(base)) throw new Error('path outside Pages base');
    const rest = url.pathname.slice(base.length) || 'index.html';
    if (!/^[A-Za-z0-9_./-]+$/.test(rest) || rest.split('/').includes('..')) throw new Error('invalid path');
    const file = path.join(dist, rest);
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    response.end(data);
  } catch {
    response.writeHead(404); response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${port}${base}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  await page.evaluate(() => document.fonts.ready);
  const data = await page.evaluate(() => ({ loaded: document.fonts.check('13px "Noto Sans SC Metro"', '地铁乘客'), stationCount: window.metro.getState().stations.length, base: location.pathname }));
  assert.deepEqual(errors, []);
  assert.equal(data.loaded, true);
  assert.equal(data.stationCount, 3);
  console.log(JSON.stringify({ passed: true, ...data, requests: 'no errors' }));
} finally { await browser.close(); server.close(); }
