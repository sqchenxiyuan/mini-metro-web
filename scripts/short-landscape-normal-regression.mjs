import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const output = '/opt/data/cache/scratch/mini-metro-short-normal-regression';
await mkdir(output, { recursive: true });
const server = process.env.METRO_TEST_URL ? null : await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server?.listen();
const origin = process.env.METRO_TEST_URL ?? server.resolvedUrls.local[0];
const browser = await chromium.launch(browserLaunchOptions());

const geometry = page => page.evaluate(() => {
  const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
  const target = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`missing element ${selector}`);
    const rect = element.getBoundingClientRect();
    const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
    return { rect: rect.toJSON(), hit: element.contains(document.elementFromPoint(x, y)), x, y };
  };
  return {
    viewport: [innerWidth, innerHeight], bodyScroll: document.body.scrollHeight,
    docScroll: document.documentElement.scrollHeight, bodyOverflow: getComputedStyle(document.body).overflow,
    stage: box('#stage'), footer: box('.transport-bar'), score: box('.score-block'),
    resources: target('#resources'), resourceItems: [...document.querySelectorAll('#resources > div')].map(el => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent, rect: r.toJSON(), hit: el.contains(document.elementFromPoint((r.left+r.right)/2, (r.top+r.bottom)/2)) };
    }),
    controls: ['#play-pause', '[data-speed="1"]', '[data-speed="2"]', '[data-speed="4"]', '#sound'].map(target),
    zoom: ['#zoom-out', '#zoom-reset', '#zoom-in', '#screenshot'].map(target),
    toggle: target('#map-first-toggle'), queue: target('#queue-browser-toggle'),
    toggleShown: getComputedStyle(document.querySelector('#map-first-toggle')).display !== 'none',
  };
});
const fits = (r, w, h) => r.left >= 0 && r.top >= 0 && r.right <= w && r.bottom <= h;
function assertNoOverlap(a, b, message) {
  assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
    `${message}: ${JSON.stringify({ a, b })}`);
}
function assertLayout(g, mapFirst) {
  const [w, h] = g.viewport;
  assert.equal(g.docScroll, h, 'document must not need scrolling to expose controls');
  assert.ok(fits(g.footer, w, h), `footer visible without scroll: ${JSON.stringify(g)}`);
  assert.ok(fits(g.stage, w, h) && g.stage.height >= 140, `map remains drawable: ${JSON.stringify(g.stage)}`);
  if (h <= 600) assert.ok(g.toggleShown && g.toggle.hit && fits(g.toggle.rect, w, h), 'view toggle stays touch-hittable');
  else assert.ok(!g.toggleShown, 'map-first toggle hidden in portrait');
  for (const [index, item] of g.zoom.entries()) {
    assert.ok(item.rect.width >= 44 && item.rect.height >= 44 && fits(item.rect, w, h) && item.hit,
      `zoom/tool ${index} needs an unobstructed 44x44 native target: ${JSON.stringify(item)}`);
  }
  for (let i = 1; i < g.zoom.length; i++)
    assertNoOverlap(g.zoom[i - 1].rect, g.zoom[i].rect, 'map tools must not overlap');
  assertNoOverlap(g.zoom[0].rect, g.queue.rect, 'map tools must not cover queue button');
  for (const item of g.zoom) assertNoOverlap(item.rect, g.toggle.rect, 'map tools must not cover toggle');
  if (!mapFirst) {
    assert.ok(g.resources.hit && fits(g.resources.rect, w, h) && g.resourceItems.length === 4,
      `normal view exposes all four resources: ${JSON.stringify(g.resources)}`);
    for (const item of g.resourceItems)
      assert.ok(fits(item.rect, w, h) && item.hit && (h > 600 || w > 440 || item.rect.width >= 44),
        `resource label/value must not be squeezed: ${JSON.stringify(item)}`);
    for (const [index, item] of g.controls.entries())
      assert.ok(fits(item.rect, w, h) && item.hit && item.rect.width >= 44 && item.rect.height >= 44,
        `footer control ${index} touch-hittable: ${JSON.stringify(item)}`);
    assert.ok(g.stage.bottom <= g.footer.top, 'map does not render underneath footer');
  } else {
    for (const item of g.controls.slice(0, 4))
      assert.ok(fits(item.rect, w, h) && item.hit, 'map-first playback stays operable');
  }
}
try {
  for (const [width, height] of [[568, 320], [390, 844], [320, 480], [390, 568]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.metro?.mobileMapStats() && document.fonts.status === 'loaded');
      if (height <= 600) {
        assert.equal(await page.locator('#map-first-toggle').innerText(), '常规');
        const first = await geometry(page);
        await page.screenshot({ path: `${output}/${width}x${height}-map-first.png` });
        assertLayout(first, true);
        await page.touchscreen.tap(first.toggle.x, first.toggle.y);
        await page.waitForFunction(() => !document.body.classList.contains('map-first'));
      }
      const normal = await geometry(page);
      await page.screenshot({ path: `${output}/${width}x${height}-normal.png` });
      console.log(JSON.stringify({ width, height, view: 'normal', geometry: normal }));
      assertLayout(normal, false);
      const before = await page.locator('#play-pause').innerText();
      await page.touchscreen.tap(normal.controls[0].x, normal.controls[0].y);
      await page.waitForFunction(previous => document.querySelector('#play-pause').textContent !== previous, before);
      await page.touchscreen.tap(normal.controls[0].x, normal.controls[0].y);
      await page.waitForFunction(previous => document.querySelector('#play-pause').textContent === previous, before);
      await page.touchscreen.tap(normal.zoom[2].x, normal.zoom[2].y);
      await page.touchscreen.tap(normal.zoom[1].x, normal.zoom[1].y);
      await page.evaluate(() => scrollTo(0, 1000));
      assert.equal(await page.evaluate(() => scrollY), 0, 'no unreachable document below viewport');
      if (height <= 600) {
        await page.touchscreen.tap(normal.toggle.x, normal.toggle.y);
        await page.waitForFunction(() => document.body.classList.contains('map-first'));
        assertLayout(await geometry(page), true);
      }
      await page.locator('#help').click();
      assert.equal(await page.locator('#help-dialog').evaluate(el => el.open), true, 'help navigation opens');
      await page.locator('#help-close').click();
      assert.equal(await page.locator('#help-dialog').evaluate(el => el.open), false, 'help navigation closes');
      await page.locator('#queue-browser-toggle').click();
      assert.equal(await page.locator('#queue-browser').evaluate(el => el.open), true, 'queue navigation opens');
      await page.locator('#queue-browser-close').click();
      assert.equal(await page.locator('#queue-browser').evaluate(el => el.open), false, 'queue navigation closes');
      if (width === 320) {
        await page.evaluate(() => {
          window.metro.restart({ mode: 'endless', seed: 420 });
          window.metro.pause();
          window.metro.step(4200);
        });
        await page.waitForFunction(() => window.metro.getState().phase === 'upgrade');
        const options = await page.locator('#upgrade-panel [data-upgrade]').evaluateAll(nodes => nodes.map(node => {
          const r = node.getBoundingClientRect();
          return { rect: r.toJSON(), x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2,
            hit: node.contains(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)) };
        }));
        assert.equal(options.length, 2, 'weekly choices exist');
        await page.screenshot({ path: `${output}/${width}x${height}-weekly.png` });
        for (const option of options)
          assert.ok(fits(option.rect, width, height) && option.hit && option.rect.height >= 44,
            `weekly choice fits and is hittable in narrow portrait: ${JSON.stringify(option)}`);
        await page.touchscreen.tap(options[0].x, options[0].y);
        assert.equal(await page.evaluate(() => window.metro.getState().phase), 'playing', 'weekly touch chooses a supply');
      }
    } finally { await page.close(); }
  }
} finally { await browser.close(); await server?.close(); }
