import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  await page.evaluate(() => {
    const m = window.metro;
    m.restart({ mode: 'endless', seed: 420 }); m.pause();
    for (let i = 0; i < 9; i++) {
      const s = m.getState();
      if (s.phase === 'upgrade') m.submit({ action: { type: 'upgrade', choice: s.upgrades[0] } });
      m.step(4200);
    }
    const s = m.getState();
    if (s.phase === 'upgrade') m.submit({ action: { type: 'upgrade', choice: s.upgrades[0] } });
  });
  await page.waitForFunction(() => window.metro.getState().stations.length === 36);
  const before = await page.evaluate(() => {
    const m = window.metro, state = m.getState(), drawn = new Set(m.sceneCues().bounds.filter(b => b.kind === 'queue').map(b => b.id));
    return { hash: m.hash(), stations: state.stations.filter(s => s.queue.length).map(s => ({ id: s.id, queue: s.queue })),
      omitted: state.stations.filter(s => s.queue.length && !drawn.has(s.id)).map(s => s.id), drawn: drawn.size };
  });
  assert.equal(before.stations.length, 36, 'dense fixture has a queue at all 36 stations');
  assert.ok(before.omitted.length >= 30, `dense fixture should omit most queues; actual ${before.omitted.length}`);
  console.log(JSON.stringify({ total: before.stations.length, drawn: before.drawn, omitted: before.omitted.length }));

  const alert = page.locator('#map-alerts');
  assert.equal(await alert.isVisible(), true, 'ordinary player must see an explicit warning about omitted queue details');
  assert.match(await alert.textContent(), new RegExp(`${before.omitted.length} 站候车详情`), 'alert count must match actual omitted queues');
  assert.deepEqual((await alert.getAttribute('data-omitted')).split(',').map(Number).sort((a,b) => a-b),
    before.omitted.slice().sort((a,b) => a-b), 'alert navigation includes exactly the omitted stations');
  await alert.click();
  const selected = await page.locator('.station-label.selected').getAttribute('data-station');
  assert.ok(before.omitted.includes(Number(selected)), 'alert reaches a missing queue');
  assert.equal(await page.locator('#station-peek').isVisible(), true, 'ordinary alert exposes queue detail');
  const station = before.stations.find(s => s.id === Number(selected));
  const peek = await page.locator('#station-peek').textContent();
  assert.ok(peek.includes(`车站 ${selected} · 候车 ${station.queue.length} 人`));
  for (const shape of [...new Set(station.queue.map(q => q.shape))]) {
    const count = station.queue.filter(q => q.shape === shape).length;
    assert.ok(peek.includes(`×${count}`), `alert detail has destination ${shape} count ${count}`);
  }

  const open = page.locator('#queue-browser-toggle');
  assert.equal(await open.isVisible(), true, 'ordinary player can open complete queue browser without map hit targets');
  await open.click();
  const dialog = page.locator('#queue-browser');
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.locator('[data-queue-station]').count(), before.stations.length,
    'every queued station, including omitted ones, is in the browser');
  const geometry = await page.evaluate(() => {
    const button = document.querySelector('#queue-browser-toggle').getBoundingClientRect();
    const map = document.querySelector('#stage').getBoundingClientRect();
    const alert = document.querySelector('#map-alerts').getBoundingClientRect();
    return { button: button.toJSON(), map: map.toJSON(), alert: alert.toJSON() };
  });

  assert.ok(geometry.button.width >= 44 && geometry.button.height >= 44 &&
    geometry.button.x >= geometry.map.x && geometry.button.right <= geometry.map.right,
    'ordinary queue browser control is usable in map panel');
  assert.ok(geometry.button.right <= geometry.alert.left || geometry.button.left >= geometry.alert.right ||
    geometry.button.bottom <= geometry.alert.top || geometry.button.top >= geometry.alert.bottom,
    'queue browser entry does not overlap fallback alert');
  for (const id of before.omitted) {
    await dialog.locator(`[data-queue-station="${id}"]`).click();
    const actual = await dialog.locator('[data-queue-shape]').evaluateAll(nodes => nodes.map(n =>
      ({ shape: n.dataset.queueShape, count: Number(n.dataset.queueCount) })).sort((a,b) => a.shape.localeCompare(b.shape)));
    const queue = before.stations.find(s => s.id === id).queue;
    const expected = [...new Set(queue.map(q => q.shape))].sort().map(shape =>
      ({ shape, count: queue.filter(q => q.shape === shape).length }));
    assert.deepEqual(actual, expected, `station ${id}: complete live destination shapes/counts`);
    assert.equal(actual.reduce((sum, group) => sum + group.count, 0), queue.length);
  }
  for (const selector of ['#queue-focus-station', '#queue-focus-pile']) {
    const control = dialog.locator(selector);
    assert.equal(await control.isDisabled(), true, `${selector}: desktop must not advertise a nonfunctional focus action`);
    assert.equal(await control.isHidden(), true, `${selector}: unavailable desktop action is not shown`);
  }
  await dialog.locator('#queue-browser-close').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.metro.mobileMapStats() !== null);
  await open.click();
  await dialog.locator(`[data-queue-station="${before.omitted[0]}"]`).click();
  for (const selector of ['#queue-focus-station', '#queue-focus-pile']) {
    const control = dialog.locator(selector);
    assert.equal(await control.isVisible(), true, `${selector}: mobile focus action available`);
    assert.equal(await control.isEnabled(), true);
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForFunction(() => window.metro.mobileMapStats() === null);
  for (const selector of ['#queue-focus-station', '#queue-focus-pile']) {
    const control = dialog.locator(selector);
    assert.equal(await control.isDisabled(), true, `${selector}: desktop resize disables nonfunctional action`);
    assert.equal(await control.isHidden(), true, `${selector}: desktop resize hides nonfunctional action`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.metro.mobileMapStats() !== null);
  assert.equal(await dialog.locator('#queue-focus-pile').isEnabled(), true, 'mobile focus restored after resize');
  await dialog.locator('#queue-browser-close').click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForFunction(() => window.metro.mobileMapStats() === null);
  const clickTarget = await page.evaluate(ids => {
    const stage = document.querySelector('#stage').getBoundingClientRect();
    return ids.find(id => {
      const node = document.querySelector(`[data-station="${id}"]`), r = node?.getBoundingClientRect();
      if (!r) return false;
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return x >= stage.left && x <= stage.right && y >= stage.top && y <= stage.bottom &&
        document.elementFromPoint(x, y)?.closest(`[data-station="${id}"]`);
    });
  }, before.omitted);
  assert.ok(clickTarget !== undefined, 'an omitted queue has a reachable map station');
  const stationNode = page.locator(`[data-station="${clickTarget}"]`);
  await stationNode.click();
  assert.equal(await page.locator('#station-peek').isVisible(), true, 'ordinary station click reveals local queue');
  assert.ok((await page.locator('#station-peek').textContent()).includes(`车站 ${clickTarget} · 候车 ${before.stations.find(s => s.id === clickTarget).queue.length} 人`));
  assert.equal(await page.evaluate(() => window.metro.hash()), before.hash, 'inspecting queues cannot mutate simulation');
  console.log(`1024x768 ordinary: ${before.omitted.length} omitted queues alert + exact browser details, state unchanged`);
} finally { await browser.close(); await server.close(); }
