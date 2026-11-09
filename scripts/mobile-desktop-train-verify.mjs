import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/integration.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro?.mobileMapStats());
  const setup = await page.evaluate(() => {
    const metro = window.metro;
    metro.restart({ mode: 'creative', seed: 420 });
    metro.pause();
    const route = metro.submit({ action: { type: 'route', line: 0, stops: [1, 2] } }, 'test-fixture');
    const train = metro.submit({ action: { type: 'addTrain', line: 0, station: 1 } }, 'test-fixture');
    return { route, train, parked: metro.getState().trains.filter(t => t.from === 1 && t.to === null).length };
  });
  assert.ok(setup.route.ok && setup.train.ok && setup.parked >= 2, `two parked trains: ${JSON.stringify(setup)}`);
  const group = page.locator('[data-train-group="1"]');
  await group.waitFor();
  assert.equal(await group.evaluate(node => node.hidden), false, 'group starts unhidden on mobile');
  const map = page.locator('#stage');
  const initialGroup = await page.evaluate(() => ({
    x: Number.parseFloat(document.querySelector('[data-train-group="1"]').style.left),
    station: window.metro.projectStation(1).x,
  }));
  assert.ok(Math.abs(initialGroup.x - initialGroup.station) <= 1, 'group starts at its station within pixel rounding');
  // At the right edge the station center can still be inside while the
  // parked badge's translated 44px hit box is wholly outside the stage.
  const lonePage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  lonePage.on('pageerror', error => errors.push(String(error)));
  await lonePage.goto(process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/integration.html', { waitUntil: 'networkidle' });
  await lonePage.waitForFunction(() => window.metro?.mobileMapStats());
  const edgeSetup = await lonePage.evaluate(() => {
    window.metro.restart({ mode: 'creative', seed: 420 });
    window.metro.pause();
    return window.metro.submit({ action: { type: 'route', line: 0, stops: [1, 2] } }, 'test-fixture');
  });
  assert.ok(edgeSetup.ok, `edge train setup: ${JSON.stringify(edgeSetup)}`);
  await lonePage.locator('#stage').focus();
  let rightEdge;
  for (let i = 0; i < 12; i++) {
    await lonePage.keyboard.press('ArrowLeft');
    rightEdge = await lonePage.evaluate(() => {
    const stage = document.querySelector('#stage').getBoundingClientRect();
    const badge = document.querySelector('[data-train-id]');
    const hidden = badge.hidden;
    badge.hidden = false; // Hidden elements have a zero-size bounding rect.
    const rect = badge.getBoundingClientRect();
    badge.hidden = hidden;
    return { station: window.metro.projectStation(1).x, stage: stage.toJSON(),
      badge: rect.toJSON(), hidden };
  });
    if (rightEdge.hidden && rightEdge.badge.left >= rightEdge.stage.right) break;
  }
  assert.ok(rightEdge.station < rightEdge.stage.right + 22 && rightEdge.badge.left >= rightEdge.stage.right,
    `parked badge box, not station point, exits right: ${JSON.stringify(rightEdge)}`);
  assert.equal(rightEdge.hidden, true, 'camera pan immediately hides fully offstage parked hit box');
  const edgeUpdate = await lonePage.evaluate(() => {
    const train = window.metro.getState().trains[0];
    const result = window.metro.submit({ action: { type: 'carriage', train: train.id, delta: 1 } }, 'test-fixture');
    return { result, hidden: document.querySelector('[data-train-id]').hidden };
  });
  assert.ok(edgeUpdate.result.ok, `edge carriage: ${JSON.stringify(edgeUpdate)}`);
  assert.equal(edgeUpdate.hidden, true, 'state update cannot restore offstage parked hit box');
  // Vertical clipping must use the parked badge's -42px offset as well.
  for (let i = 0; i < 12; i++) await lonePage.keyboard.press('ArrowRight');
  let topEdge;
  for (let i = 0; i < 14; i++) {
    await lonePage.keyboard.press('ArrowDown');
    topEdge = await lonePage.evaluate(() => {
    const stage = document.querySelector('#stage').getBoundingClientRect();
    const badge = document.querySelector('[data-train-id]');
    const hidden = badge.hidden;
    badge.hidden = false;
    const rect = badge.getBoundingClientRect();
    badge.hidden = hidden;
    return { stage: stage.toJSON(), badge: rect.toJSON(), hidden };
  });
    if (topEdge.hidden && topEdge.badge.bottom <= topEdge.stage.top) break;
  }
  assert.ok(topEdge.badge.bottom <= topEdge.stage.top,
    `parked badge box is wholly beyond stage top: ${JSON.stringify(topEdge)}`);
  assert.equal(topEdge.hidden, true, 'vertical camera pan hides parked hit box');
  for (let i = 0; i < 14; i++) await lonePage.keyboard.press('ArrowUp');
  assert.equal(await lonePage.locator('[data-train-id]').evaluate(node => node.hidden), false,
    'parked badge returns when its box re-enters the stage');
  // A moving train has no parked offset, but its actual box follows the same rule.
  const moving = await lonePage.evaluate(() => {
    window.metro.step(40);
    const train = window.metro.getState().trains[0];
    return { to: train.to, hidden: document.querySelector('[data-train-id]').hidden };
  });
  assert.notEqual(moving.to, null, `fixture train moves: ${JSON.stringify(moving)}`);
  assert.equal(moving.hidden, false, 'moving train begins onstage');
  let movingEdge;
  for (let i = 0; i < 18; i++) {
    await lonePage.keyboard.press('ArrowLeft');
    movingEdge = await lonePage.evaluate(() => {
    const stage = document.querySelector('#stage').getBoundingClientRect();
    const badge = document.querySelector('[data-train-id]');
    const hidden = badge.hidden;
    badge.hidden = false;
    const rect = badge.getBoundingClientRect();
    badge.hidden = hidden;
    return { stage: stage.toJSON(), badge: rect.toJSON(), hidden };
  });
    if (movingEdge.hidden && movingEdge.badge.left >= movingEdge.stage.right) break;
  }
  assert.ok(movingEdge.badge.left >= movingEdge.stage.right,
    `moving badge is wholly beyond stage right: ${JSON.stringify(movingEdge)}`);
  assert.equal(movingEdge.hidden, true, 'camera pan hides fully offstage moving hit box');
  await lonePage.close();
  await map.focus();
  await page.keyboard.press('ArrowRight'); // camera-only move, no simulation tick
  const afterArrow = await page.evaluate(() => ({
    x: Number.parseFloat(document.querySelector('[data-train-group="1"]').style.left),
    station: window.metro.projectStation(1).x,
    hash: window.metro.hash(),
  }));
  assert.ok(Math.abs(afterArrow.x - afterArrow.station) <= 1.01, 'keyboard pan reprojects group with its station without a state tick');
  assert.ok(afterArrow.x < initialGroup.x, 'keyboard pan shifts the group left');
  for (let i = 0; i < 12 && !(await group.evaluate(node => node.hidden)); i++)
    await page.keyboard.press('ArrowRight');
  assert.equal(await group.evaluate(node => node.hidden), true, 'camera-only pan offscreen hides grouped badge');
  await page.locator('#zoom-reset').click();
  await map.focus();
  assert.equal(await group.evaluate(node => node.hidden), false, 'camera reset restores grouped badge');
  assert.equal(await page.evaluate(() => window.metro.hash()), afterArrow.hash, 'camera-only moves do not tick the simulation');
  await group.click();
  assert.equal(await page.locator('#train-detail').isVisible(), true, 'reprojected group remains clickable');
  await page.locator('#train-detail-close').click();
  const stage = page.locator('#stage');
  const firstBounds = await stage.boundingBox();
  await page.mouse.move(firstBounds.x + firstBounds.width / 2, firstBounds.y + firstBounds.height - 70);
  await page.mouse.wheel(0, -120);
  const zoomed = await page.evaluate(() => ({
    x: Number.parseFloat(document.querySelector('[data-train-group="1"]').style.left),
    station: window.metro.projectStation(1).x,
  }));
  assert.ok(Math.abs(zoomed.x - zoomed.station) <= 1, 'wheel zoom reprojects parked group without a tick');
  await page.locator('#zoom-reset').click();
  const recentered = await page.evaluate(() => ({
    x: Number.parseFloat(document.querySelector('[data-train-group="1"]').style.left),
    station: window.metro.projectStation(1).x,
  }));
  assert.ok(Math.abs(recentered.x - recentered.station) <= 1.01, `zoom reset reprojects parked group within CSS pixel rounding without a tick: ${JSON.stringify(recentered)}`);
  for (let i = 0; i < 4 && !(await group.evaluate(node => node.hidden)); i++) {
    const bounds = await stage.boundingBox();
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height - 70;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 175, y, { steps: 3 });
    await page.mouse.up();
    const projected = await page.evaluate(() => ({
      x: Number.parseFloat(document.querySelector('[data-train-group="1"]').style.left),
      station: window.metro.projectStation(1).x,
    }));
    assert.ok(Math.abs(projected.x - projected.station) <= 1, 'drag pan reprojects parked group without a state tick');
  }
  assert.equal(await group.evaluate(node => node.hidden), true, 'panning station offscreen hides its mobile group without a state tick');
  // An existing group must stay hidden after a state update, not only a camera pan.
  const hiddenAfterUpdate = await page.evaluate(() => {
    const train = window.metro.getState().trains.find(t => t.from === 1 && t.to === null);
    const result = window.metro.submit({ action: { type: 'carriage', train: train.id, delta: 1 } }, 'test-fixture');
    return { result, hidden: document.querySelector('[data-train-group="1"]')?.hidden };
  });
  assert.ok(hiddenAfterUpdate.result.ok, `offscreen state update: ${JSON.stringify(hiddenAfterUpdate)}`);
  assert.equal(hiddenAfterUpdate.hidden, true, 'state update keeps offscreen group hidden immediately');
  for (const badge of await page.locator('[data-train-id]').all()) {
    assert.equal(await badge.evaluate(node => node.hidden), true, 'state update keeps offscreen parked train hidden');
  }
  const before = await page.evaluate(() => window.metro.hash());
  await page.setViewportSize({ width: 900, height: 844 });
  await page.waitForFunction(() => !window.metro.mobileMapStats());
  assert.equal(await group.count(), 1, 'group survives renderer replacement');
  assert.equal(await group.evaluate(node => node.hidden), false, 'desktop update unhides the group');
  assert.equal(await group.isVisible(), true, 'parked trains can be selected on desktop');
  const badgeBounds = await group.boundingBox(), desktopStage = await stage.boundingBox();
  assert.ok(badgeBounds && desktopStage && badgeBounds.x >= desktopStage.x &&
    badgeBounds.x + badgeBounds.width <= desktopStage.x + desktopStage.width &&
    badgeBounds.y >= desktopStage.y && badgeBounds.y + badgeBounds.height <= desktopStage.y + desktopStage.height,
  'group returns inside the desktop stage');
  await group.click();
  assert.equal(await page.locator('#train-detail').isVisible(), true, 'restored group opens its train chooser');
  assert.equal(await page.evaluate(() => window.metro.hash()), before, 'responsive resize does not change game state');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('mobile→desktop: offscreen parked-train group becomes visible again; state unchanged');
  const offscreenPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  offscreenPage.on('pageerror', error => errors.push(String(error)));
  await offscreenPage.goto(process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/integration.html', { waitUntil: 'networkidle' });
  await offscreenPage.waitForFunction(() => window.metro?.mobileMapStats());
  for (const width of [390, 320]) {
    if (width === 320) {
      await offscreenPage.setViewportSize({ width, height: 480 });
      await offscreenPage.waitForFunction(() => window.metro?.mobileMapStats() &&
        document.querySelector('#map-first-toggle').getAttribute('aria-pressed') === 'true');
    }
    const loneSetup = await offscreenPage.evaluate(() => {
      window.metro.restart({ mode: 'creative', seed: 420 });
      window.metro.pause();
      return window.metro.submit({ action: { type: 'route', line: 0, stops: [1, 2] } }, 'test-fixture');
    });
    assert.ok(loneSetup.ok, `one parked train: ${JSON.stringify(loneSetup)}`);
    const lone = offscreenPage.locator('[data-train-id]');
    assert.equal(await lone.count(), 1, 'route creates one parked train');
    await offscreenPage.locator('#stage').focus();
    let offscreenPoint;
    for (let i = 0; i < 25; i++) {
      offscreenPoint = await offscreenPage.evaluate(() => {
        const station = window.metro.projectStation(1);
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const badge = document.querySelector('[data-train-id]');
        const wasHidden = badge.hidden;
        badge.hidden = false;
        const box = badge.getBoundingClientRect();
        badge.hidden = wasHidden;
        return { x: station.x - stage.x, width: stage.width,
          badgeOffstage: box.right <= stage.left || box.left >= stage.right ||
            box.bottom <= stage.top || box.top >= stage.bottom };
      });
      if (offscreenPoint.badgeOffstage && (offscreenPoint.x < -22 || offscreenPoint.x > offscreenPoint.width + 22)) break;
      await offscreenPage.keyboard.press('ArrowRight');
    }
    assert.ok(offscreenPoint.badgeOffstage && (offscreenPoint.x < -22 || offscreenPoint.x > offscreenPoint.width + 22),
      `station 1 and its translated hit box really are offscreen: ${JSON.stringify(offscreenPoint)}`);
    const updateLone = await offscreenPage.evaluate(() => {
      const train = window.metro.getState().trains[0];
      return window.metro.submit({ action: { type: 'carriage', train: train.id, delta: 1 } }, 'test-fixture');
    });
    assert.ok(updateLone.ok, `single train update: ${JSON.stringify(updateLone)}`);
    assert.equal(await lone.evaluate(node => node.hidden), true, 'state update keeps offscreen single parked badge hidden');
    const addOffscreen = await offscreenPage.evaluate(() => {
      const result = window.metro.submit({ action: { type: 'addTrain', line: 0, station: 1 } }, 'test-fixture');
      const badge = document.querySelector('[data-train-group="1"]');
      return { result, hidden: badge?.hidden, left: badge?.style.left };
    });
    assert.ok(addOffscreen.result.ok, `offscreen second train: ${JSON.stringify(addOffscreen)}`);
    assert.equal(addOffscreen.hidden, true, `group created offscreen is hidden immediately: ${JSON.stringify(addOffscreen)}`);
    const newGroup = offscreenPage.locator('[data-train-group="1"]');
    for (let i = 0; i < 24 && await newGroup.evaluate(node => node.hidden); i++)
      await offscreenPage.keyboard.press('ArrowLeft');
    assert.equal(await newGroup.evaluate(node => node.hidden), false, 'offscreen-created group returns on camera pan');
    await newGroup.click();
    assert.equal(await offscreenPage.locator('#train-detail').isVisible(), true, 'returned group remains clickable');
    await offscreenPage.locator('#train-detail-close').click();
    console.log(`${width}x${width === 320 ? 480 : 844}: offscreen single/group hidden on state updates; returned group clickable`);
  }
  assert.deepEqual(errors, [], 'no page errors');
  await offscreenPage.close();
} finally {
  await browser.close();
}
