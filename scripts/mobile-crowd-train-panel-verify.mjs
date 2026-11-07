import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/integration.html';

// A real touch must reach a train badge outside station cores, not a DOM click.
async function touchTrain(page, label) {
  const point = await page.evaluate(() => {
    const stage = document.querySelector('#stage').getBoundingClientRect();
    for (const badge of document.querySelectorAll('[data-train-id]:not([hidden])')) {
      const box = badge.getBoundingClientRect();
      for (let y = Math.max(box.top + 3, stage.top + 3); y < Math.min(box.bottom - 2, stage.bottom - 2); y += 3)
        for (let x = Math.max(box.left + 3, stage.left + 3); x < Math.min(box.right - 2, stage.right - 2); x += 3) {
          if (document.elementFromPoint(x, y) !== badge) continue;
          if (window.metro.getState().stations.some(station => {
            const core = window.metro.projectStation(station.id);
            return Math.hypot(x - core.x, y - core.y) < 12;
          })) continue;
          return { x, y, id: Number(badge.dataset.trainId) };
        }
    }
    return {missing:true,stage:stage.toJSON(),badges:[...document.querySelectorAll('[data-train-id]')].map(b=>{const hidden=b.hidden;b.hidden=false;const rect=b.getBoundingClientRect().toJSON();b.hidden=hidden;return{id:b.dataset.trainId,hidden,rect}}),camera:window.metro.mobileMapStats().center,scroll:scrollY};
  });
  assert.ok(point && !point.missing, `${label}: train badge has a reachable touch point ${JSON.stringify(point)}`);
  await page.touchscreen.tap(point.x, point.y);
  assert.equal(await page.locator('#train-detail').isVisible(), true,
    `${label}: train detail opens on real touch`);
  return point;
}

async function focusTrainOwner(page) {
  const owner = await page.evaluate(() => window.metro.getState().trains[0].from);
  const coordinate = await page.locator('#map-overview').evaluate((el, id) => {
    const map = window.metro.mobileMapStats(), point = map.bounds.find(p => p.id === id);
    if (!point) throw Error(`no map bound for train owner ${id}`);
    const frame = { left: Math.min(...map.bounds.map(p => p.x - 40)), right: Math.max(...map.bounds.map(p => p.x + 40)),
      top: Math.min(...map.bounds.map(p => p.y - 24)), bottom: Math.max(...map.bounds.map(p => p.pile ? p.pile.y + p.pile.height + 12 : p.y + 42)) };
    const scale = Math.min((el.clientWidth - 12) / Math.max(frame.right - frame.left, 1),
      (el.clientHeight - 12) / Math.max(frame.bottom - frame.top, 1));
    return { x: (el.clientWidth - (frame.right - frame.left) * scale) / 2 + (point.x - frame.left) * scale,
      y: (el.clientHeight - (frame.bottom - frame.top) * scale) / 2 + (point.y - frame.top) * scale };
  }, owner);
  const box = await page.locator('#map-overview').boundingBox();
  await page.touchscreen.tap(box.x + coordinate.x, box.y + coordinate.y);
}

try {
  for (const [width, height] of [[390, 844], [320, 480]]) {
    const label = `${width}x${height}`;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.metro?.mobileMapStats());
      const fixture = await page.evaluate(() => {
        const m = window.metro;
        m.restart({ mode: 'endless', seed: 420 });
        m.pause();
        const route = m.submit({ action: { type: 'route', line: 0, stops: [1, 2] } }, 'panel-regression');
        for (let i = 0; i < 9; i++) {
          const s = m.getState();
          if (s.phase === 'upgrade') m.submit({ action: { type: 'upgrade', choice: s.upgrades[0] } }, 'panel-regression');
          m.step(4200);
        }
        const s = m.getState();
        if (s.phase === 'upgrade') m.submit({ action: { type: 'upgrade', choice: s.upgrades[0] } }, 'panel-regression');
        return { route, trains: s.trains.length, crowded: s.stations.filter(p => p.crowd > 0).length };
      });
      assert.ok(fixture.route.ok && fixture.trains && fixture.crowded,
        `${label}: seeded route, train and crowd fixture ${JSON.stringify(fixture)}`);
      if (width === 320) {
        const parked = await page.evaluate(() => window.metro.submit({ action: { type: 'addTrain', line: 0, station: 1 } }, 'panel-regression'));
        assert.ok(parked.ok, `${label}: newly parked train remains inspectable after dense simulation ${JSON.stringify(parked)}`);
      }
      await page.locator('#zoom-reset').tap();
      if (width === 320) {
        await page.locator('#mobile-crowd-alert').tap();
        await focusTrainOwner(page);
      }
      await page.locator('#game-shell').scrollIntoViewIfNeeded();
      await page.waitForTimeout(450); // Camera/ResizeObserver settle before measuring badge hit box.
      if (width === 320) {
        await page.locator('#map-overview').focus();
        for (let attempt = 0; attempt < 18 && await page.locator('[data-train-id]').last().evaluate(el => el.hidden); attempt++) {
          const direction = await page.evaluate(() => {
            const badge = [...document.querySelectorAll('[data-train-id]')].at(-1), stage = document.querySelector('#stage').getBoundingClientRect();
            badge.hidden = false; const r = badge.getBoundingClientRect(); badge.hidden = true;
            return r.bottom < stage.top ? 'ArrowUp' : r.top > stage.bottom ? 'ArrowDown' : r.left >= stage.right ? 'ArrowLeft' : 'ArrowRight';
          });
          await page.keyboard.press(direction);
        }
      }
      const train = await touchTrain(page, label);
      assert.equal(await page.evaluate(() => window.metro.getState().phase), 'playing', `${label}: seeded game remains playable`);
      assert.equal(await page.locator('#station-peek').isVisible(), false,
        `${label}: station peek closed while train detail open`);
      const before = await page.evaluate(() => ({
        hash: window.metro.hash(), camera: window.metro.mobileMapStats(),
        crowded: window.metro.getState().stations.filter(p => p.crowd > 0)
          .sort((a, b) => b.crowd - a.crowd || a.id - b.id)
          .map(p => ({ id: p.id, queue: p.queue.length, remaining: Math.ceil((2250 - p.crowd) / 50) })),
      }));
      await page.locator('#mobile-crowd-alert').tap();
      const after = await page.evaluate(() => ({
        hash: window.metro.hash(), camera: window.metro.mobileMapStats(),
        selected: document.querySelector('.station-label.selected')?.dataset.station,
        peek: document.querySelector('#station-peek').textContent,
        trainHidden: document.querySelector('#train-detail').hidden,
      }));
      const expectedCrowd = before.crowded[width === 320 ? 1 % before.crowded.length : 0];
      assert.equal(after.hash, before.hash, `${label}: alert navigates without changing simulation`);
      assert.equal(after.selected, String(expectedCrowd.id), `${label}: alert cycles to the expected crowded station`);
      assert.match(after.peek, new RegExp(`车站 ${expectedCrowd.id} · 候车 ${expectedCrowd.queue} 人.*拥挤还剩 ${expectedCrowd.remaining} 秒`),
        `${label}: selected crowd station has accurate remaining timer`);
      assert.equal(await page.locator('#station-peek').isVisible(), true, `${label}: station peek visible`);
      assert.equal(after.trainHidden, true, `${label}: train detail is hidden when alert opens station peek`);
      assert.equal(await page.locator('#train-detail').isVisible(), false,
        `${label}: train detail and station peek never stack`);
      assert.notDeepEqual(after.camera.center, before.camera.center, `${label}: alert actually moves camera`);
      await page.locator('#zoom-reset').tap();
      await focusTrainOwner(page);
      await page.waitForTimeout(450); // Detail strip/camera settle after alert focus.
      const reopened = await touchTrain(page, `${label} after alert`);
      assert.equal(await page.locator('#station-peek').isVisible(), false,
        `${label}: reopening train detail closes the crowd station peek`);
      assert.equal(await page.evaluate(() => window.metro.hash()), before.hash,
        `${label}: reverse navigation also preserves simulation`);
      assert.deepEqual(errors, [], `${label}: no browser errors`);
      console.log(JSON.stringify({ label, train, reopened, crowdStation: before.crowded[0],
        cameraBefore: before.camera.center, cameraAfter: after.camera.center, passed: true }));
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
