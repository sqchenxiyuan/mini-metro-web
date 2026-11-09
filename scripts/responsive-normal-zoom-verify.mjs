import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'],
});
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/';
const sample = () => {
  const stage = document.querySelector('#stage').getBoundingClientRect();
  return {
    zoom: window.metro.mobileMapStats()?.zoom,
    hash: window.metro.hash(),
    pressed: document.querySelector('#map-first-toggle').getAttribute('aria-pressed'),
    stage: { x: stage.x, y: stage.y, right: stage.right, bottom: stage.bottom },
    stations: [1, 2].map(id => {
      const point = window.metro.projectStation(id);
      const node = document.querySelector(`[data-station="${id}"]`);
      const box = node?.getBoundingClientRect();
      return { id, ...point, visible: Boolean(node && !node.hidden && box?.width && box?.height) };
    }),
  };
};
function assertVisibleStations(view, label) {
  for (const station of view.stations) {
    assert.ok(station.visible, `${label}: station ${station.id} has a visible hit target`);
    assert.ok(station.x >= view.stage.x + 20 && station.x <= view.stage.right - 20 &&
      station.y >= view.stage.y + 20 && station.y <= view.stage.bottom - 20,
    `${label}: station ${station.id} ${JSON.stringify(station)} stays within stage ${JSON.stringify(view.stage)}`);
  }
}
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 480 }, hasTouch: true });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro?.mobileMapStats());
  const initialHash = await page.evaluate(() => window.metro.hash());
  await page.locator('#map-first-toggle').click();
  await page.waitForFunction(() => [1, 2].every(id => !document.querySelector(`[data-station="${id}"]`).hidden));
  const initialNormal = await page.evaluate(sample);
  assert.equal(initialNormal.zoom, .55, 'initial short-phone normal zoom');
  assertVisibleStations(initialNormal, 'initial short-phone normal');

  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForFunction(() => window.metro?.mobileMapStats() === null);
  assert.equal(await page.evaluate(() => window.metro.hash()), initialHash, 'desktop resize preserves simulation');
  await page.setViewportSize({ width: 320, height: 480 });
  await page.waitForFunction(() => window.metro?.mobileMapStats() && document.querySelector('#map-first-toggle').getAttribute('aria-pressed') === 'true');
  await page.waitForFunction(() => [1, 2].every(id => !document.querySelector(`[data-station="${id}"]`).hidden));
  const returnedMapFirst = await page.evaluate(sample);
  assert.ok(returnedMapFirst.zoom >= .55, 'returning to short phone keeps usable map-first zoom');
  assertVisibleStations(returnedMapFirst, 'returned map-first');
  await page.locator('#map-first-toggle').click();
  await page.waitForFunction(() => [1, 2].every(id => !document.querySelector(`[data-station="${id}"]`).hidden));
  const returnedNormal = await page.evaluate(sample);
  assert.equal(returnedNormal.pressed, 'false', 'short-phone normal view is selectable');
  assert.equal(returnedNormal.zoom, .55, 'desktop→320x480→normal restores the normal mobile zoom');
  assertVisibleStations(returnedNormal, 'returned short-phone normal');
  assert.equal(returnedNormal.hash, initialHash, 'resize and view changes preserve simulation');

  const shortCamera = await page.evaluate(() => window.metro.mobileMapStats());
  await page.setViewportSize({ width: 320, height: 500 });
  await page.setViewportSize({ width: 320, height: 480 });
  const shortCameraAfterResize = await page.evaluate(() => window.metro.mobileMapStats());
  assert.deepEqual({ zoom: shortCameraAfterResize.zoom, center: shortCameraAfterResize.center },
    { zoom: shortCamera.zoom, center: shortCamera.center }, 'resizing within short-phone breakpoint retains the camera');
  assert.equal(await page.evaluate(() => window.metro.hash()), initialHash, 'short-phone resize preserves simulation');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.metro?.mobileMapStats());
  const tall = await page.evaluate(sample);
  assert.equal(tall.pressed, 'false', '390x844 remains in normal layout');
  assert.equal(tall.zoom, .55, '390x844 retains existing mobile camera on height-only resize');
  assert.equal(tall.hash, initialHash, '390x844 resize preserves simulation');
  console.log(JSON.stringify({ ok: true, initialNormal, returnedMapFirst, returnedNormal, tall }));
  await page.close();

  // Start in the tall layout: crossing only the height breakpoint must not
  // capture the map-first renderer's zoom as the normal-view zoom.
  const tallPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await tallPage.goto(url, { waitUntil: 'networkidle' });
  await tallPage.waitForFunction(() => window.metro?.mobileMapStats());
  const tallInitial = await tallPage.evaluate(sample);
  assert.ok(tallInitial.zoom >= .55, 'fresh tall phone starts at usable map zoom');
  const tallHash = tallInitial.hash;
  await tallPage.setViewportSize({ width: 320, height: 480 });
  await tallPage.waitForFunction(() => document.querySelector('#map-first-toggle').getAttribute('aria-pressed') === 'true');
  await tallPage.waitForFunction(() => [1, 2].every(id => !document.querySelector(`[data-station="${id}"]`).hidden));
  const tallToShortMapFirst = await tallPage.evaluate(sample);
  assert.ok(tallToShortMapFirst.zoom >= .55, 'tall→short enters usable map-first');
  assertVisibleStations(tallToShortMapFirst, 'tall→short map-first');
  await tallPage.locator('#map-first-toggle').click();
  await tallPage.waitForFunction(() => document.querySelector('#map-first-toggle').getAttribute('aria-pressed') === 'false');
  await tallPage.waitForFunction(() => [1, 2].every(id => !document.querySelector(`[data-station="${id}"]`).hidden));
  const tallToShortNormal = await tallPage.evaluate(sample);
  assert.equal(tallToShortNormal.zoom, .55, 'tall→short→normal restores compact zoom');
  assertVisibleStations(tallToShortNormal, 'tall→short normal');
  assert.equal(tallToShortNormal.hash, tallHash, 'tall→short toggle preserves simulation');
  await tallPage.setViewportSize({ width: 390, height: 844 });
  await tallPage.waitForFunction(() => document.querySelector('#map-first-toggle').getAttribute('aria-pressed') === 'false' &&
    window.metro.mobileMapStats()?.zoom === .55);
  const returnedTall = await tallPage.evaluate(sample);
  assert.equal(returnedTall.zoom, tallInitial.zoom, 'tall→short normal→tall restores prior tall zoom');
  assert.equal(returnedTall.hash, tallHash, 'height round trip preserves simulation');
  await tallPage.locator('#zoom-in').click();
  const userZoom = await tallPage.evaluate(sample);
  assert.ok(Math.abs(userZoom.zoom - .7)<1e-8, 'user can adjust tall camera');
  await tallPage.locator('#stage').focus();
  await tallPage.keyboard.press('ArrowRight');
  const tallCamera = await tallPage.evaluate(() => window.metro.mobileMapStats());
  await tallPage.setViewportSize({ width: 320, height: 480 });
  await tallPage.waitForFunction(() => document.querySelector('#map-first-toggle').getAttribute('aria-pressed') === 'true');
  await tallPage.locator('#map-first-toggle').click();
  const compactNormal = await tallPage.evaluate(sample);
  assert.equal(compactNormal.zoom, .55, 'returning to short normal uses compact zoom rather than tall zoom');
  await tallPage.locator('#zoom-in').click();
  assert.ok(Math.abs((await tallPage.evaluate(sample)).zoom - .7) < 1e-8, 'short normal zoom can be adjusted separately');
  await tallPage.setViewportSize({ width: 390, height: 844 });
  await tallPage.waitForFunction(() => document.querySelector('#map-first-toggle').getAttribute('aria-pressed') === 'false' &&
    Math.abs(window.metro.mobileMapStats()?.zoom - .7)<1e-8);
  const restoredCamera = await tallPage.evaluate(() => window.metro.mobileMapStats());
  assert.equal(restoredCamera.zoom, tallCamera.zoom, 'user-adjusted tall zoom survives short normal adjustment');
  assert.deepEqual(restoredCamera.center, tallCamera.center, 'camera pan remains unchanged across height-only breakpoint');
  await tallPage.setViewportSize({ width: 320, height: 480 });
  await tallPage.waitForFunction(() => document.querySelector('#map-first-toggle').getAttribute('aria-pressed') === 'true');
  await tallPage.locator('#map-first-toggle').click();
  const returnedShortNormal = await tallPage.evaluate(sample);
  assert.ok(returnedShortNormal.zoom >= .55, 'returning to 320 normal keeps usable zoom');
  assert.equal(returnedShortNormal.hash, tallHash, 'all camera transitions preserve simulation');
  console.log(JSON.stringify({ tallInitial, tallToShortMapFirst, tallToShortNormal, returnedTall, compactNormal, restoredCamera: { zoom: restoredCamera.zoom, center: restoredCamera.center }, returnedShortNormal }));
  await tallPage.close();
} finally {
  await browser.close();
}
