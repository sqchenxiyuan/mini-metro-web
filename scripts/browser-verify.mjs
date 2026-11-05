import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './browser-launch.mjs';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { runAgent, ReplayPlayer, dispatcherPolicy, createHttpAgent, decide, createSession, hash, trackPoints, RULES } from '../dist-sdk/index.mjs';

const output = 'test-results/production';
await mkdir(output, { recursive: true });
const host = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:4175';
const complete = await runAgent({ seed: 420, maxTicks: RULES.hz * 1200 });
assert.equal(complete.reason, 'over');
assert.equal(complete.errors, 0);
await writeFile(`${output}/node-agent.json`, JSON.stringify(complete.replay));
const nodePlayer = new ReplayPlayer(complete.replay);
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const observation = JSON.parse(Buffer.concat(chunks).toString());
  if (req.url === '/error') {
    res.writeHead(503);
    res.end('unavailable');
    return;
  }
  if (req.url === '/large') {
    res.end('x'.repeat(66000));
    return;
  }
  if (req.url === '/stall') return;
  const result = {
    protocol: observation.protocol,
    tick: observation.tick,
    ...dispatcherPolicy(observation),
  };
  if (req.url === '/wrong') result.tick++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(result));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const agentUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(browserLaunchOptions());
const errors = [],
  external = [];
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (req) => {
  if (
    !req.url().startsWith(host) &&
    !req.url().startsWith(agentUrl) &&
    !req.url().startsWith('data:')
  )
    external.push(req.url());
});
try {
  await page.goto(host, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  assert.equal(await page.locator('#inspector').isVisible(), false);
  assert.equal(await page.locator('#line-tools').isVisible(), false);
  assert.ok((await page.locator('#stage').boundingBox()).width >= 1580);
  const brand = await page.locator('.brand').boundingBox(),
    city = await page.locator('.city-heading').boundingBox();
  assert.ok(brand.x + brand.width < city.x, 'header labels must not overlap');
  await page.screenshot({ path: `${output}/initial.png`, fullPage: true });
  // Actual pointer dragging, with no direct action API for this interaction.
  const points = await page.evaluate(() => [1, 2, 3].map((id) => window.metro.projectStation(id)));
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => window.metro.getState().lines[0].stops.length === 3);
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => window.metro.controller.paused), true);
  assert.deepEqual(await page.evaluate(() => window.metro.getState().lines[0].stops), [1, 2, 3]);
  await page.click('#line-tools-toggle');
  await page.click('#loop-line');
  assert.equal(await page.evaluate(() => window.metro.getState().lines[0].loop), true);
  await page.click('#loop-line');
  assert.equal(await page.evaluate(() => window.metro.getState().lines[0].loop), false);
  await page.click('#add-train');
  assert.equal(await page.evaluate(() => window.metro.getState().trains.length), 2);
  await page.click('#line-tools-close');
  await page.evaluate((ticks) => window.metro.step(ticks), RULES.weekTicks);
  assert.equal(await page.evaluate(() => window.metro.getState().phase), 'upgrade');
  await page.locator('[data-upgrade]').first().click();
  assert.equal(await page.evaluate(() => window.metro.getState().phase), 'playing');
  await page.evaluate((ticks) => window.metro.step(ticks), 3 * RULES.hz);
  const browserReplay = await page.evaluate(() => window.metro.exportReplay());
  await writeFile(`${output}/browser-recording.json`, JSON.stringify(browserReplay));
  const browserInNode = new ReplayPlayer(browserReplay);
  assert.equal(hash(browserInNode.getState()), browserReplay.finalHash);
  await page.click('#replay-toggle');
  await page.click('#save-local');
  assert.ok((await page.locator('.history-row').count()) > 0);
  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-replay');
  const download = await downloadPromise;
  await download.saveAs(`${output}/downloaded.json`);
  assert.equal(
    new ReplayPlayer(await readFile(`${output}/downloaded.json`, 'utf8')).replay.finalHash,
    browserReplay.finalHash,
  );
  await page.locator('#import-file').setInputFiles(`${output}/browser-recording.json`);
  await page.waitForFunction(() => window.metro.controller.mode === 'replay');
  await page.waitForFunction((tick) => Number(document.querySelector('#timeline')?.max) >= tick, 30 * RULES.hz);
  await page.locator('#timeline').fill(String(30 * RULES.hz));
  await page.waitForFunction((tick) => window.metro.getState().tick === tick, 30 * RULES.hz);
  await page.click('#step-forward');
  assert.equal(await page.evaluate(() => window.metro.getState().tick), 35 * RULES.hz);
  await page.click('#step-back');
  assert.equal(await page.evaluate(() => window.metro.getState().tick), 30 * RULES.hz);
  assert.equal(await page.locator('#timeline').inputValue(), String(30 * RULES.hz));
  assert.equal(await page.evaluate(() => window.metro.getState().tick), 30 * RULES.hz);
  await page.locator('#decision-list [data-decision="0"]').click();
  await page.locator('#jump-decision').click();
  assert.equal(
    await page.evaluate(() => window.metro.hash()),
    browserReplay.decisions[0].observationHash,
  );
  assert.equal(await page.evaluate(() => window.metro.controller.focusedDecision), 0);
  await page.screenshot({ path: `${output}/decision-before.png`, fullPage: true });
  // Node -> Chrome exact replay, independent of Three.js or frame rate.
  const final = await page.evaluate((replay) => {
    window.metro.loadReplay(replay);
    return window.metro.seek(replay.duration);
  }, complete.replay);
  assert.equal(hash(final), complete.replay.finalHash);
  await page.click('#decisions-earlier');
  await page.waitForFunction(() => !!document.querySelector('#decision-list [data-decision="0"]'), null, { timeout: 2000 });
  assert.equal(await page.locator('#decision-list [data-decision="0"]').count(), 1);
  await page.click('#decisions-later');
  const snapshots = await page.evaluate(() => {
    const g = window.metro;
    g.seek(150 * 50);
    const first = g.hash();
    g.seek(50 * 50);
    g.seek(150 * 50);
    return [first, g.hash()];
  });
  assert.equal(snapshots[0], snapshots[1]);
  await page.evaluate((tick) => window.metro.seek(tick), 245 * RULES.hz);
  await page.click('#tab-dispatch');
  await page.click('#agent-observation');
  const wire = JSON.parse(await page.locator('#observation-json').textContent());
  assert.equal(wire.protocol, 'orchard-metro.agent.v1');
  assert.equal(hash(wire.state), await page.evaluate(() => window.metro.hash()));
  assert.equal(typeof wire.state.rng, 'number');
  assert.equal(typeof wire.state.stations[0].nextPassenger, 'number');
  await page.click('#observation-close');
  await page.screenshot({ path: `${output}/inspector.png`, fullPage: true });
  await page.click('#inspector-close');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${output}/orchard-town.png`, fullPage: true });
  const mid = Math.floor(complete.replay.decisions.length / 2);
  const obs = await page.evaluate((i) => window.metro.observationAtDecision(i), mid);
  assert.equal(hash(obs.state), complete.replay.decisions[mid].observationHash);
  await page.evaluate((i) => window.metro.focusDecision(i), mid);
  assert.equal(await page.evaluate(() => window.metro.hash()), hash(obs.state));
  // A late result must never mutate a restarted game.
  await page.evaluate(() => {
    window.metro.restart({ seed: 5 });
    window.metro.startAgent(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ action: { type: 'route', line: 0, stops: [1, 2, 3] } }), 250),
        ),
    );
  });
  await page.waitForFunction(() => window.metro.controller.waiting);
  await page.evaluate(() => window.metro.restart({ seed: 99 }));
  await page.waitForTimeout(400);
  assert.equal(
    await page.evaluate(() => window.metro.hash()),
    hash(createSession({ seed: 99 }).getState()),
  );
  // Real HTTP round trip in both Node and Chrome.
  const http = await runAgent({
    seed: 420,
    maxTicks: 30 * RULES.hz,
    policy: createHttpAgent(`${agentUrl}/ok`),
  });
  assert.equal(http.errors, 0);
  const observation = createSession().observe();
  await assert.rejects(() => decide(createHttpAgent(`${agentUrl}/error`), observation, 500), /503/);
  await assert.rejects(
    () => decide(createHttpAgent(`${agentUrl}/wrong`), observation, 500),
    /tick/,
  );
  await assert.rejects(
    () => decide(createHttpAgent(`${agentUrl}/large`), observation, 500),
    /64 KiB/,
  );
  await assert.rejects(() => decide(createHttpAgent(`${agentUrl}/stall`), observation, 30), /超时/);
  await page.evaluate((url) => {
    window.metro.restart();
    window.metro.connectHttp(url);
  }, `${agentUrl}/ok`);
  await page.waitForFunction(() => window.metro.getState().lines[0].stops.length === 3);
  await page.evaluate(() => {
    window.metro.stopAgent();
    window.metro.pause();
  });
  assert.equal(
    await page.evaluate(() => window.metro.exportReplay().decisions[0].source),
    'http-agent',
  );
  // A bad JSON file is rejected while preserving the current game.
  const preserved = await page.evaluate(() => window.metro.hash());
  await page.locator('#import-file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.metro.hash()), preserved);
  // UI creative placement and segment insertion by a real drag.
  await page.click('#new-game');
  await page.selectOption('#mode-select', 'creative');
  await page.selectOption('#city-select', 'harbor');
  await page.click('#settings-form button[type="submit"]');
  assert.equal(await page.evaluate(() => window.metro.getState().mode), 'creative');
  assert.equal(await page.locator('#inspector').isVisible(), false);
  await page.click('#sample-route');
  await page.evaluate(() => window.metro.pause());
  const inserted = await page.evaluate(() => {
    const g = window.metro;
    g.submit({ action: { type: 'station', x: -5, y: 4, shape: 'star' } }, 'test-fixture');
    return g.getState().stations.at(-1).id;
  });
  const end = await page.evaluate((id) => window.metro.projectStation(id), inserted);
  // First segment 1->2 has a single diagonal; midpoint is invariant under projection.
  const ends = await page.evaluate(() => [1, 2].map((id) => window.metro.projectStation(id)));
  const start = { x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2 + 3 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 15 });
  await page.mouse.up();
  assert.ok((await page.evaluate(() => window.metro.getState().lines[0].stops)).includes(inserted));
  await page.screenshot({ path: `${output}/creative.png`, fullPage: true });
  // Touch-only pointer path and viewport overflow check.
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  mobile.on('pageerror', (e) => errors.push(String(e)));
  await mobile.goto(host, { waitUntil: 'networkidle' });
  await mobile.waitForFunction(() => window.metro);
  assert.equal(await mobile.locator('#inspector').isVisible(), false);
  assert.equal(await mobile.locator('#line-tools').isVisible(), false);
  const touchPoints = await mobile.evaluate(() =>
    [1, 2, 3].map((id) => window.metro.projectStation(id)),
  );
  const cdp = await mobile.context().newCDPSession(mobile);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...touchPoints[0], id: 0 }],
  });
  for (const p of touchPoints.slice(1))
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...p, id: 0 }],
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.deepEqual(await mobile.evaluate(() => window.metro.getState().lines[0].stops), [1, 2, 3]);
  await mobile.evaluate(() => window.metro.pause());
  await mobile.waitForTimeout(180);
  await mobile.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  await mobile.click('#tools-toggle');
  assert.equal(await mobile.locator('#agent-toggle').isVisible(), true);
  await mobile.click('#inspector-close');
  assert.equal(await mobile.locator('#inspector').isVisible(), false);
  await mobile.click('#line-tools-toggle');
  assert.equal(await mobile.locator('#add-train').isVisible(), true);
  await mobile.click('#line-tools-close');
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await mobile.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const report = {
    passed: true,
    manual: [
      'pointer drawing',
      'loop open/close',
      'train allocation',
      'weekly supplies',
      'save/import/export',
      'timeline',
      'pre-decision map',
      'creative placement',
      'segment insertion',
      'touch drawing',
      'mobile layout',
      'collapsed tools and full-width map',
      'live Agent observation JSON',
      'mobile panel controls',
    ],
    nodeToBrowser: {
      tick: final.tick,
      score: final.score,
      hash: hash(final),
      decisions: complete.replay.decisions.length,
    },
    browserToNode: { tick: browserInNode.getState().tick, hash: browserReplay.finalHash },
    http: {
      decisions: http.replay.decisions.length,
      errors: http.errors,
      failureCases: [
        'HTTP 503',
        'wrong tick',
        'oversized response',
        'timeout',
        'stale result after restart',
      ],
    },
    errors,
    externalRequests: external,
  };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
