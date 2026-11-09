import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './browser-launch.mjs';
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:4175/index.html';
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const [width, height] of [[320, 480], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true });
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.metro);
      for (const state of (height <= 600 ? ['map-first', 'normal'] : ['normal'])) {
        if (state === 'normal' && height <= 600) await page.locator('#map-first-toggle').click();
        const geometry = await page.evaluate(() => {
          const target = selector => {
            const node = document.querySelector(selector), rect = node.getBoundingClientRect();
            const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
            return { rect: rect.toJSON(), display: getComputedStyle(node).display,
              hit: node.contains(document.elementFromPoint(x, y)), text: node.textContent.trim() };
          };
          return { score: target('.score-block'), label: target('.score-block div > span'),
            number: target('#score'), actions: ['#map-first-toggle', '#new-game', '#help'].map(target) };
        });
        console.log(JSON.stringify({ width, height, state, geometry }));
        if (width === 320) await page.screenshot({ path: `/opt/data/cache/scratch/mini-metro-inspector-hit/320x480-score-${state}.png` });
        const { score, label, actions } = geometry;
        assert.notEqual(label.display, 'none', 'delivered passenger metric must be named');
        assert.ok(label.rect.width > 0 && label.rect.height > 0 && label.hit,
          'score label must be visibly hit-testable');
        for (const action of actions.filter(item => item.display !== 'none')) {
          assert.ok(action.rect.width >= 44 && action.rect.height >= 44 && action.hit,
            'header actions remain native 44px targets');
          assert.ok(score.rect.right <= action.rect.left || score.rect.left >= action.rect.right,
            'score and header controls must not overlap');
        }
      }
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
