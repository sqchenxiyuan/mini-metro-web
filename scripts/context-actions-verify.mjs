import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  await page.evaluate(() => { window.metro.restart({ mode: 'creative', seed: 77 }); window.metro.pause(); });
  // Seed 77 contains initial locomotives; line actions are real authoritative decisions.
  const stations = await page.evaluate(() => [1,2].map(id => window.metro.projectStation(id)));
  await page.mouse.move(stations[0].x, stations[0].y);await page.mouse.down();
  await page.mouse.move(stations[1].x, stations[1].y, { steps: 18 });await page.mouse.up();
  await page.waitForFunction(() => window.metro.getState().lines.some(l=>l.stops.length >= 2));
  const state = await page.evaluate(() => window.metro.getState());
  const line = state.lines.find(l => l.stops.length >= 2);
  const train = state.trains.find(t => t.line === line.id);
  assert.ok(train, 'line creation auto-dispatched a train');
  const prevResources = state.resources;
  const previousCount = state.trains.filter(t => t.line === line.id).length;
  const selected = page.locator(`[data-line="${line.id}"]`);
  await selected.click();
  const addTrain = page.locator('#context-actions [data-action="addTrain"]');
  await addTrain.waitFor({ state: 'visible' });
  await addTrain.click();
  const afterDispatch = await page.evaluate((id) => ({ count:window.metro.getState().trains.filter(t=>t.line===id).length,resources:window.metro.getState().resources,toast:document.querySelector('#toast')?.textContent }),line.id);
  assert.equal(afterDispatch.count, previousCount + 1, 'dispatch action reaches authoritative game');
  assert.equal(await page.locator('#inspector:visible').count(), 0);
  // A train tap offers carriage/return actions without a destination-statistics card.
  const badge = page.locator(`[data-train-id="${train.id}"]`);
  await badge.waitFor({ state: 'visible' });
  await badge.click({ force: true });
  await page.locator('#context-actions [data-action="carriage"]').waitFor({ state: 'visible' });
  const car = page.locator('#context-actions [data-action="carriage"]');
  await car.click();
  assert.equal(await page.evaluate((id) => window.metro.getState().trains.find(t => t.id === id).carriages, train.id),
    train.carriages + 1, 'carriage action reaches authoritative game');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed:true, line:line.id, train:train.id, previousResources:prevResources, tests:['dispatch','carriage','normal UI no inspector']}));
} finally { await browser.close();await server.close(); }
