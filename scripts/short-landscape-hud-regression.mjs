import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const output = '/opt/data/cache/scratch/metro-short-landscape-hud';
await mkdir(output, { recursive: true });
const server = process.env.METRO_TEST_URL ? null : await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server?.listen();
const origin = process.env.METRO_TEST_URL ?? server.resolvedUrls.local[0];
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({
    viewport: { width: 568, height: 320 },
    deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro?.mobileMapStats() && document.body.classList.contains('map-first'));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${output}/${process.env.HUD_SHOT ?? 'before'}.png` });
  const hud = await page.evaluate(() => {
    const score = document.querySelector('.score-block');
    const label = score.querySelector(':scope > div > span');
    const queue = document.querySelector('#queue-browser-toggle');
    const value = document.querySelector('#score');
    const viewport = { width: innerWidth, height: innerHeight };
    const rect = el => el.getBoundingClientRect().toJSON();
    const text = label.firstChild;
    const glyphs = Array.from(text.textContent, (_, index) => {
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const bounds = range.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { char: text.textContent[index], rect: bounds.toJSON(), x, y,
        visible: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= 44 && score.contains(hit),
        coveringElement: hit?.id || hit?.className || hit?.tagName };
    });
    return { viewport, score: rect(score), value: rect(value), label: rect(label), queue: rect(queue), glyphs };
  });
  console.log(JSON.stringify(hud, null, 2));
  assert.ok(hud.score.top >= 0 && hud.score.bottom <= 44,
    `score number and label must fit in the 44px header: ${JSON.stringify(hud.score)}`);
  assert.ok(hud.score.right <= hud.queue.left && hud.queue.top >= 0 && hud.queue.bottom <= 44,
    `score must not cover the 44px queue button: ${JSON.stringify({ score: hud.score, queue: hud.queue })}`);
  assert.ok(hud.glyphs.every(g => g.visible),
    `every score-label glyph must be visible and unobscured at native 568x320: ${JSON.stringify(hud.glyphs)}`);
  await page.close();
} finally {
  await browser.close();
  await server?.close();
}
