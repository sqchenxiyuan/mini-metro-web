import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const output = '/opt/data/cache/scratch/metro-weekly-short-landscape';
await mkdir(output, { recursive: true });
const server = process.env.METRO_TEST_URL ? null : await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server?.listen();
const origin = process.env.METRO_TEST_URL ?? server.resolvedUrls.local[0];
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const [width, height] of [[568, 320], [390, 844], [1440, 900]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1,
      isMobile: width < 650, hasTouch: true });
    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.metro && document.fonts.status === 'loaded');
      for (let selectedIndex = 0; selectedIndex < 2; selectedIndex++) {
        await page.evaluate(() => {
          const metro = window.metro;
          metro.restart({ mode: 'endless', seed: 420 });
          metro.pause();
          metro.step(4200);
        });
        await page.waitForFunction(() => window.metro.getState().phase === 'upgrade' &&
          document.querySelectorAll('#upgrade-panel [data-upgrade]').length === 2);
        const observed = await page.evaluate(() => {
          const panel = document.querySelector('#upgrade-panel');
          const footer = document.querySelector('.transport-bar');
          const rect = el => el.getBoundingClientRect().toJSON();
          return {
            viewport: [innerWidth, innerHeight], documentHeight: document.documentElement.scrollHeight,
            panel: rect(panel), footer: rect(footer),
            options: Array.from(panel.querySelectorAll('[data-upgrade]'), button => {
              const label = button.querySelector('strong');
              const labelRect = rect(label), buttonRect = rect(button);
              const glyphs = Array.from(label.firstChild.textContent, (_, index) => {
                const range = document.createRange();
                range.setStart(label.firstChild, index); range.setEnd(label.firstChild, index + 1);
                const box = rect(range);
                const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
                return { char: label.firstChild.textContent[index], box,
                  painted: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight &&
                    y < footer.getBoundingClientRect().top && button.contains(document.elementFromPoint(x, y)) };
              });
              const x = (labelRect.left + labelRect.right) / 2;
              const y = (labelRect.top + labelRect.bottom) / 2;
              return { choice: button.dataset.upgrade, text: label.textContent,
                button: buttonRect, label: labelRect, glyphs,
                labelHit: button.contains(document.elementFromPoint(x, y)), tap: [x, y],
                buttonCenterHit: button.contains(document.elementFromPoint(
                  (buttonRect.left + buttonRect.right) / 2, (buttonRect.top + buttonRect.bottom) / 2)),
                fontSize: getComputedStyle(label).fontSize };
            }),
          };
        });
        console.log(JSON.stringify({ width, height, selectedIndex, observed }));
        assert.deepEqual(observed.viewport, [width, height], 'native viewport must not expand');
        assert.equal(observed.documentHeight, height, 'choice must not require document scrolling');
        assert.ok(observed.panel.top >= 0 && observed.panel.bottom <= height,
          `weekly panel must fit without scrolling: ${JSON.stringify(observed.panel)}`);
        for (const option of observed.options) {
          assert.ok(option.button.width >= 44 && option.button.height >= 44 && option.buttonCenterHit,
            `${option.choice}: native touch target must be at least 44px`);
          assert.ok(option.button.top >= 0 && option.button.bottom <= height && option.button.bottom <= observed.footer.top,
            `${option.choice}: whole button must remain above fixed footer: ${JSON.stringify(option)}`);
          assert.ok(option.label.top >= 0 && option.label.bottom <= observed.footer.top && option.labelHit &&
            option.glyphs.every(g => g.painted), `${option.choice}: all label glyphs must be painted and touch-hittable: ${JSON.stringify(option)}`);
          assert.ok(parseFloat(option.fontSize) >= 12 && option.text.length > 0,
            `${option.choice}: label must be readable`);
        }
        if (selectedIndex === 0) await page.screenshot({ path: `${output}/${width}x${height}-weekly.png` });
        const choice = observed.options[selectedIndex].choice;
        const before = await page.evaluate(() => {
          const s = window.metro.getState();
          return { phase: s.phase, week: s.week, resources: structuredClone(s.resources), lines: s.lines.length };
        });
        await page.touchscreen.tap(...observed.options[selectedIndex].tap);
        const after = await page.evaluate(() => {
          const s = window.metro.getState();
          return { phase: s.phase, week: s.week, resources: structuredClone(s.resources), lines: s.lines.length };
        });
        assert.equal(after.phase, 'playing', `${choice}: real touch on the label accepts choice`);
        assert.equal(after.resources.locomotives, before.resources.locomotives,
          `${choice}: choosing a supply does not grant another free locomotive`);
        assert.equal(after.week, before.week);
        if (choice === 'line') assert.equal(after.lines, before.lines + 1);
        else if (choice === 'carriage') assert.equal(after.resources.carriages, before.resources.carriages + 1);
        else if (choice === 'tunnels') assert.equal(after.resources.tunnels, before.resources.tunnels + 2);
        else if (choice === 'interchange') assert.equal(after.resources.interchanges, before.resources.interchanges + 1);
        else assert.fail(`unknown choice ${choice}`);
        console.log(JSON.stringify({ width, height, choice, before, after, touch: observed.options[selectedIndex].tap }));
      }
    } finally { await page.close(); }
  }
} finally { await browser.close(); await server?.close(); }
