import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.metro);
  const result = await page.evaluate(() => {
    const metro = window.metro;
    metro.restart({ mode: 'creative', seed: 77 });
    const [a, b] = metro.getState().stations;
    return Array.from({ length: 7 }, (_, line) => metro.submit({ action: { type: 'route', line, stops: [a.id, b.id] } }).ok);
  });
  assert.ok(result.every(Boolean));
  await page.waitForFunction(() => document.querySelector('[data-train-group]'));
  assert.equal(await page.locator('.train-badge:visible').count(), 1, 'stationary trains use one visible map badge');
  const group = page.locator('[data-train-group]');
  assert.match(await group.getAttribute('aria-label'), /7 辆停靠列车/);
  assert.doesNotMatch(await group.innerText(), /\d/);
  await group.tap();
  await page.waitForFunction(() => document.querySelectorAll('[data-train-choice]').length === 7);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#train-detail').isVisible(), false);
  assert.equal(await page.locator('#train-detail').getAttribute('data-group-station'), null);
  await group.tap();
  await page.waitForFunction(() => document.querySelectorAll('[data-train-choice]').length === 7);
  const choices = page.locator('[data-train-choice]');
  assert.equal(await choices.count(), 7);
  const selectedId = await choices.nth(1).getAttribute('data-train-choice');
  await choices.nth(1).click();
  const detail = page.locator('#train-detail');
  await detail.waitFor({ state: 'visible' });
  assert.match(await detail.innerText(), new RegExp(`${selectedId} 号列车`));
  // Rebuild a six-train group; adding a seventh route must update an open chooser.
  await page.evaluate(() => {
    const metro = window.metro;
    metro.restart({ mode: 'creative', seed: 77 });
    const [a, b] = metro.getState().stations;
    for (let line = 0; line < 6; line++) {
      if (!metro.submit({ action: { type: 'route', line, stops: [a.id, b.id] } }).ok)
        throw new Error(`cannot create line ${line}`);
    }
  });
  await page.waitForFunction(() => document.querySelector('[data-train-group]')?.getAttribute('aria-label')?.includes('6 辆'));
  await page.locator('[data-train-group]').tap();
  await page.waitForFunction(() => document.querySelectorAll('[data-train-choice]').length === 6);
  await page.evaluate(() => {
    const metro = window.metro;
    const [a, b] = metro.getState().stations;
    if (!metro.submit({ action: { type: 'route', line: 6, stops: [a.id, b.id] } }).ok)
      throw new Error('cannot add seventh line');
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-train-choice]').length === 7);
  assert.match(await page.locator('[data-train-group]').getAttribute('aria-label'), /7 辆停靠列车/);
  const transition = await page.evaluate(() => {
    const metro = window.metro;
    for (let line = 1; line < 7; line++) {
      const result = metro.submit({ action: { type: 'route', line, stops: [] } });
      if (!result.ok) throw new Error(`cannot retire line ${line}: ${result.message}`);
    }
    metro.step(1);
    return metro.getState().trains.map((t) => ({ id: t.id, to: t.to }));
  });
  await page.waitForFunction(() => !document.querySelector('[data-train-group]'));
  assert.equal(await detail.isVisible(), false, 'the open group list closes when the group dissolves');
  assert.equal(await detail.getAttribute('data-group-station'), null);
  assert.equal(await page.locator('.train-badge:visible').count(), 1, 'one remaining train keeps its individual map target');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, groupCount: 7, selectedId, transition, errors }));
} finally {
  await browser.close();
  await server.close();
}
