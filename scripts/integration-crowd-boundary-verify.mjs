import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './browser-launch.mjs';

const base = (process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175').replace(/\/$/, '');
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 320, height: 480 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));

// Never let Playwright auto-scroll the element: these must be physical taps in the viewport.
async function touchAtCenter(selector) {
  const rect = await page.locator(selector).boundingBox();
  assert.ok(rect, `${selector} has a box`);
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  assert.ok(x > 0 && x < 320 && y > 0 && y < 480, `${selector} is in viewport: ${JSON.stringify(rect)}`);
  assert.equal(await page.evaluate(({ x, y, selector }) => {
    const hit = document.elementFromPoint(x, y), target = document.querySelector(selector);
    return hit === target || target.contains(hit);
  }, { x, y, selector }), true, `${selector} is topmost at touch point`);
  await page.touchscreen.tap(x, y);
}
async function swipePage(fromY, toY) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const send = (type, y) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x: 302, y, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await send('touchStart', fromY);
    for (let step = 1; step <= 12; step++) {
      await send('touchMove', fromY + (toY - fromY) * step / 12);
      await page.waitForTimeout(16);
    }
    await send('touchEnd', toY);
  } finally { await cdp.detach(); }
}

try {
  await page.goto(`${base}/integration.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro?.mobileMapStats());
  const fixture = await page.evaluate(() => {
    const game = window.metro;
    game.restart({ mode: 'endless', seed: 420 });
    game.pause(true);
    const route = game.submit({ action: { type: 'route', line: 0, stops: [1, 2] } }, 'crowd-boundary-test');
    for (let i = 0; i < 9; i++) {
      const state = game.getState();
      if (state.phase === 'upgrade') game.submit({ action: { type: 'upgrade', choice: state.upgrades[0] } }, 'crowd-boundary-test');
      game.step(4200);
    }
    return { route, crowded: game.getState().stations.filter(station => station.crowd > 0).length };
  });
  assert.ok(fixture.route.ok && fixture.crowded > 0, `crowd fixture initialized: ${JSON.stringify(fixture)}`);
  assert.equal(await page.locator('#mobile-crowd-alert').isVisible(), true, 'warning is not hidden');
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'test starts at initial scroll');

  const initial = await page.evaluate(() => {
    const alert = document.querySelector('#mobile-crowd-alert').getBoundingClientRect();
    const frame = document.querySelector('#game-shell').getBoundingClientRect();
    const runtime = document.querySelector('#integration-runtime').getBoundingClientRect();
    const x = alert.left + alert.width / 2, y = alert.top + alert.height / 2;
    return { alert: { top: alert.top, bottom: alert.bottom }, frame: { top: frame.top, bottom: frame.bottom },
      runtime: { top: runtime.top, bottom: runtime.bottom },
      hit: document.elementFromPoint(x, y)?.id,
      warningOutsideFrame: alert.top < frame.top || alert.bottom > frame.bottom };
  });
  // A visible fixed warning may not float over runtime tools before the game frame enters view.
  assert.equal(initial.warningOutsideFrame, false, `warning stays inside game frame at initial scroll: ${JSON.stringify(initial)}`);
  assert.notEqual(initial.hit, 'mobile-crowd-alert', `initial runtime text receives touches: ${JSON.stringify(initial)}`);
  await touchAtCenter('#integration-pause');
  assert.equal(await page.evaluate(() => window.metro.controller.paused), true, 'runtime pause remains touchable');
  // Native finger swipe on the runtime itself must scroll the document, not trap it.
  await swipePage(330, 130);
  const swipedToGame = await page.evaluate(() => scrollY);
  assert.ok(swipedToGame > 0, `native touch swipe scrolls from runtime to game: ${swipedToGame}`);

  // Use normal document scrolling; the integration surface must not inherit the game's scroll lock.
  await page.evaluate(() => window.scrollTo(0, document.querySelector('#game-shell').offsetTop));
  await page.waitForTimeout(150);
  const frameScroll = await page.evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
  assert.ok(frameScroll.y > 0 && frameScroll.max > frameScroll.y, `native page can scroll to game and beyond: ${JSON.stringify(frameScroll)}`);
  await touchAtCenter('#mobile-crowd-alert');
  assert.equal(await page.locator('#station-peek').isVisible(), true, 'native warning tap opens station peek');
  await swipePage(355, 155);
  const swipedPastGame = await page.evaluate(() => scrollY);
  assert.ok(swipedPastGame > frameScroll.y, `native touch swipe can leave game frame: ${swipedPastGame}`);

  await page.evaluate(() => window.scrollTo(0, document.querySelector('#integration-controls').offsetTop));
  await page.waitForTimeout(150);
  const tools = await page.locator('#integration-controls').boundingBox();
  assert.ok(tools && tools.y < 480 && tools.y + tools.height > 0, 'AI tools reachable by normal scrolling');
  assert.notEqual(await page.evaluate(() => {
    const alert = document.querySelector('#mobile-crowd-alert').getBoundingClientRect();
    return document.elementFromPoint(alert.left + alert.width / 2, alert.top + alert.height / 2)?.id;
  }), 'mobile-crowd-alert', 'offscreen game warning cannot cover AI tools');
  await touchAtCenter('#integration-observe');
  assert.match(await page.locator('#integration-observation').textContent(), /orchard-metro.agent.v1/, 'AI tools remain touchable');
  assert.deepEqual(errors, [], 'no browser errors');
  console.log(JSON.stringify({ passed: true, viewport: '320x480', fixture, initial, frameScroll, tools: { y: tools.y } }));
} finally {
  await page.close();
  await browser.close();
}
