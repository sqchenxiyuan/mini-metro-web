import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/integration.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro?.mobileMapStats());
  const setup = await page.evaluate(() => {
    window.metro.restart({ seed: 77, mode: 'creative' });
    window.metro.pause();
    return window.metro.submit({ action: { type: 'route', line: 0, stops: [1, 2] } }, 'train-hit-regression');
  });
  assert.ok(setup.ok, `route fixture: ${JSON.stringify(setup)}`);

  let overlap = null;
  for (let tick = 0; tick < 160 && !overlap; tick++) {
    if (tick) await page.evaluate(() => window.metro.step(1));
    await page.waitForTimeout(25);
    overlap = await page.evaluate(() => {
      const badge = document.querySelector('[data-train-id]:not([hidden])');
      if (!badge) return null;
      const box = badge.getBoundingClientRect();
      for (const station of window.metro.getState().stations) {
        const point = window.metro.projectStation(station.id);
        const node = document.querySelector(`[data-station="${station.id}"]`);
        if (point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom &&
            !node.hidden && document.elementFromPoint(point.x, point.y) === badge)
          return { id: station.id, x: point.x, y: point.y, badgeId: badge.dataset.trainId,
            tick: window.metro.getState().tick };
      }
      return null;
    });
  }
  assert.ok(overlap, 'moving train badge actually covers the rendered station core');
  const stateBefore = await page.evaluate(() => window.metro.hash());
  await page.mouse.click(overlap.x, overlap.y);
  assert.equal(await page.locator('#station-peek').isVisible(), true,
    'clicking the overlapped station core opens its mobile peek');
  assert.match(await page.locator('#station-peek').innerText(), new RegExp(`车站 ${overlap.id} · 候车`));
  assert.equal(await page.locator('#train-detail').isVisible(), false,
    'overlap click must not open train detail after pointerup or the synthesized click');
  assert.equal(await page.evaluate(() => window.metro.hash()), stateBefore,
    'inspecting the station does not change the simulation');
  const halo = await page.locator(`[data-station="${overlap.id}"]`).evaluate(node =>
    getComputedStyle(node, '::before').content);
  assert.equal(halo, 'none', 'station inspection does not leave a selection halo');

  // Moving-badge area outside any rendered station core must still open the train.
  await page.locator('#game-shell').scrollIntoViewIfNeeded();
  const badgePoint = await page.evaluate((id) => {
    const badge = document.querySelector(`[data-train-id="${id}"]`);
    const box = badge.getBoundingClientRect();
    for (let y = box.top + 3; y < box.bottom - 2; y += 3) for (let x = box.left + 3; x < box.right - 2; x += 3) {
      if (document.elementFromPoint(x, y) !== badge) continue;
      const overCore = window.metro.getState().stations.some(station => {
        const point = window.metro.projectStation(station.id);
        return Math.hypot(x - point.x, y - point.y) < 12;
      });
      if (!overCore) return { x, y };
    }
    return null;
  }, overlap.badgeId);
  assert.ok(badgePoint, 'moving train has a clickable area outside station cores');
  await page.touchscreen.tap(badgePoint.x, badgePoint.y);
  assert.equal(await page.locator('#train-detail').isVisible(), true,
    'tapping the moving badge outside station core still opens train detail');
  assert.equal(await page.locator('#station-peek').isVisible(), false,
    'moving train selection replaces the station peek instead of stacking panels');
  assert.equal(await page.locator(`[data-station="${overlap.id}"]`).evaluate(node =>
    getComputedStyle(node, '::before').content), 'none', 'train selection leaves no station halo');
  await page.waitForTimeout(100); // Let the mobile map settle after the detail strip changes size.
  const stationAgain = await page.evaluate(id => window.metro.projectStation(id), overlap.id);
  await page.mouse.click(stationAgain.x, stationAgain.y);
  assert.equal(await page.locator('#station-peek').isVisible(), true,
    'station inspection remains available after opening train detail');
  assert.equal(await page.locator('#train-detail').isVisible(), false,
    'station peek replaces, rather than stacks under, the open train detail');
  const badgeAgain = await page.evaluate((id) => {
    const badge = document.querySelector(`[data-train-id="${id}"]`);
    const box = badge.getBoundingClientRect();
    for (let y = box.top + 3; y < box.bottom - 2; y += 3) for (let x = box.left + 3; x < box.right - 2; x += 3) {
      if (document.elementFromPoint(x, y) !== badge) continue;
      if (!window.metro.getState().stations.some(station => {
        const point = window.metro.projectStation(station.id);
        return Math.hypot(x - point.x, y - point.y) < 12;
      })) return { x, y };
    }
    return null;
  }, overlap.badgeId);
  assert.ok(badgeAgain, 'train badge remains reachable after station inspection');
  await page.mouse.click(badgeAgain.x, badgeAgain.y);
  assert.equal(await page.locator('#train-detail').isVisible(), true,
    'train detail can reopen after station inspection');
  // The same overlapped core must remain a route-drag origin, not just a tap target.
  await page.evaluate(() => {
    window.metro.restart({ seed: 77, mode: 'creative' });
    window.metro.pause();
    window.metro.submit({ action: { type: 'route', line: 0, stops: [1, 2] } }, 'train-hit-regression');
    window.metro.step(21);
  });
  await page.keyboard.press('2');
  const destination = await page.evaluate(() => window.metro.projectStation(2));
  const dragOrigin = await page.evaluate(() => window.metro.projectStation(1));
  await page.waitForFunction(id => {
    const point = window.metro.projectStation(1);
    return document.elementFromPoint(point.x, point.y)?.dataset.trainId === id;
  }, overlap.badgeId);
  assert.equal(await page.evaluate(() =>
    document.elementFromPoint(window.metro.projectStation(1).x, window.metro.projectStation(1).y)?.dataset.trainId),
    overlap.badgeId, 'the route drag begins through the same overlapping train badge');
  await page.mouse.move(dragOrigin.x, dragOrigin.y);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 12 });
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.metro.getState().lines[1].stops), [1, 2],
    'dragging from the overlapped core still builds a line');

  // Park two trains at station 1 and exercise the grouped badge with real taps.
  const groupedSetup = await page.evaluate(() => {
    window.metro.restart({ seed: 77, mode: 'creative' });
    window.metro.pause();
    const route = window.metro.submit({ action: { type: 'route', line: 0, stops: [1, 2] } }, 'train-hit-regression');
    const train = window.metro.submit({ action: { type: 'addTrain', line: 0, station: 1 } }, 'train-hit-regression');
    return { route, train, parked: window.metro.getState().trains.filter(t => t.from === 1 && t.to === null).length };
  });
  assert.ok(groupedSetup.route.ok && groupedSetup.train.ok && groupedSetup.parked >= 2,
    `group fixture: ${JSON.stringify(groupedSetup)}`);
  const group = page.locator('[data-train-group="1"]');
  assert.equal(await group.isVisible(), true, 'grouped badge is visible');
  const parkedStation = await page.evaluate(() => window.metro.projectStation(1));
  await page.mouse.click(parkedStation.x, parkedStation.y);
  assert.equal(await page.locator('#station-peek').isVisible(), true,
    'tapping the grouped station core opens its peek');
  assert.equal(await page.locator('#train-detail').isVisible(), false,
    'the grouped station core must not open train detail');
  const groupPoint = await page.evaluate(() => {
    const badge = document.querySelector('[data-train-group="1"]');
    const box = badge.getBoundingClientRect();
    for (let y = box.top + 3; y < box.bottom - 2; y += 3)
      for (let x = box.left + 3; x < box.right - 2; x += 3) {
        if (document.elementFromPoint(x, y) !== badge) continue;
        if (window.metro.getState().stations.some(station => {
          const point = window.metro.projectStation(station.id);
          return Math.hypot(x - point.x, y - point.y) < 12;
        })) continue;
        return { x, y };
      }
    return null;
  });
  assert.ok(groupPoint, 'grouped badge has a reachable target outside station cores');
  await page.touchscreen.tap(groupPoint.x, groupPoint.y);
  assert.equal(await page.locator('#train-detail').isVisible(), true,
    'tapping the grouped badge opens its train chooser');
  assert.equal(await page.locator('#station-peek').isVisible(), false,
    'grouped badge selection replaces the station peek instead of stacking panels');
  assert.equal(await page.locator('[data-station="1"]').evaluate(node =>
    getComputedStyle(node, '::before').content), 'none', 'group selection leaves no station halo');
  const stationFromGroup = await page.evaluate(() => window.metro.projectStation(1));
  await page.mouse.click(stationFromGroup.x, stationFromGroup.y);
  assert.equal(await page.locator('#station-peek').isVisible(), true,
    'station peek reopens after group inspection');
  assert.equal(await page.locator('#train-detail').isVisible(), false,
    'reopened station peek replaces the grouped chooser');
  await group.focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#train-detail').isVisible(), true,
    'keyboard activation of grouped badge opens its chooser');
  assert.equal(await page.locator('#station-peek').isVisible(), false,
    'keyboard activation also replaces the station peek');
  const choice = page.locator('[data-train-choice]').first();
  const choiceId = await choice.getAttribute('data-train-choice');
  await choice.click();
  assert.match(await page.locator('#train-detail').innerText(), new RegExp(`${choiceId} 号列车`),
    'grouped train choice remains clickable');
  const stationAfterChoice = await page.evaluate(() => window.metro.projectStation(1));
  await page.mouse.click(stationAfterChoice.x, stationAfterChoice.y);
  assert.equal(await page.locator('#station-peek').isVisible(), true,
    'station peek reopens after choosing a grouped train');
  assert.equal(await page.locator('#train-detail').isVisible(), false,
    'station replaces chosen train detail');
  assert.deepEqual(errors, [], 'no browser errors');
  console.log(JSON.stringify({ passed: true, overlap, badgePoint, groupPoint }));
} finally {
  await browser.close();
}
