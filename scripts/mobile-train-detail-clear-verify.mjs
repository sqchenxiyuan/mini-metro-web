import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const out = '/opt/data/cache/scratch/metro-train-detail-clear';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/integration.html';
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const results = [];
try {
  for (const { width, height, mapFirst } of [
    { width: 320, height: 480, mapFirst: true },
    { width: 320, height: 480, mapFirst: false },
    { width: 390, height: 844, mapFirst: false },
  ]) {
    const label = `${width}x${height}-${mapFirst ? 'map-first' : 'normal'}`;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.metro?.mobileMapStats());
      if ((await page.locator('#map-first-toggle').getAttribute('aria-pressed') === 'true') !== mapFirst)
        await page.locator('#map-first-toggle').click();
      const setup = await page.evaluate(() => {
        const m = window.metro;
        m.restart({ seed: 77, mode: 'creative' }); m.pause();
        const route = m.submit({ action: { type: 'route', line: 0, stops: [1, 2] } });
        const train = m.submit({ action: { type: 'addTrain', line: 0, station: 1 } });
        return { route, train };
      });
      assert.ok(setup.route.ok && setup.train.ok, `${label}: grouped train fixture ${JSON.stringify(setup)}`);
      const group = page.locator('[data-train-group="1"]');
      await group.focus(); await page.keyboard.press('Space');
      assert.ok(await page.locator('#train-detail').isVisible(), `${label}: grouped detail opens`);
      const probe = () => page.evaluate(() => {
        const rect = el => el.getBoundingClientRect().toJSON();
        const stage = rect(document.querySelector('#stage'));
        const detail = rect(document.querySelector('#train-detail'));
        const station = window.metro.projectStation(2);
        const hit = document.elementFromPoint(station.x, station.y);
        const stats = window.metro.mobileMapStats();
        const radius = 3 * stats.zoom;
        const glyphs = stats.visiblePositions.filter(p => p.x + radius > 0 && p.x - radius < stage.width && p.y + radius > 0 && p.y - radius < stage.height)
          .map(p => ({ id: p.id, left: Math.max(stage.left, stage.left + p.x - radius),
            right: Math.min(stage.right, stage.left + p.x + radius), top: Math.max(stage.top, stage.top + p.y - radius),
            bottom: Math.min(stage.bottom, stage.top + p.y + radius) }));
        const list = document.querySelector('.train-group-list');
        const controls = ['#line-chooser', '#map-overview', '.map-tools button', '#train-detail-close']
          .map(s => document.querySelector(s)).filter(Boolean).map(el => ({ id: el.id || el.className, box: rect(el) }));
        return { stage, detail, station, hit: { tag: hit?.tagName, id: hit?.id, station: hit?.closest('[data-station]')?.dataset.station },
          glyphs, list: list ? { box: rect(list), scrollHeight: list.scrollHeight, clientHeight: list.clientHeight } : null,
          controls, viewport: [innerWidth, innerHeight], document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
      });
      await page.waitForTimeout(100);
      const grouped = await probe();
      assert.ok(!intersects(grouped.detail, grouped.stage), `${label}: grouped detail covers drawable stage ${JSON.stringify(grouped)}`);
      assert.ok(grouped.stage.height >= (mapFirst ? 240 : height < 600 ? 70 : 290), `${label}: stage usable ${grouped.stage.height}`);
      assert.deepEqual(grouped.glyphs.filter(g => intersects(g, grouped.detail)), [], `${label}: real passenger glyph obscured`);
      assert.equal(grouped.document[0], grouped.viewport[0], `${label}: no horizontal overflow in scrolling integration page`);
      assert.ok(grouped.controls.find(c => c.id === 'train-detail-close').box.height >= 44, `${label}: detail close touch target 44px`);
      assert.ok(grouped.list.scrollHeight > grouped.list.clientHeight, `${label}: grouped choices scroll internally`);
      await page.locator('#line-chooser').click();
      const chooser = await probe();
      assert.ok(!intersects(chooser.detail, chooser.stage), `${label}: opening line chooser cannot undo reserved train strip ${JSON.stringify(chooser)}`);
      await page.locator('#line-chooser').click();
      await page.screenshot({ path: `${out}/${label}-grouped.png` });
      // Pan through the overview until station 2 is visibly in the drawable map;
      // the old overlay intercepted its real projected point while still inside #stage.
      for (let i = 0; i < 8; i++) {
        const current = await probe();
        if (current.station.y > current.stage.top + 20 && current.station.y < current.stage.bottom - 18) break;
        await page.locator('#map-overview').focus();
        await page.keyboard.press(current.station.y <= current.stage.top + 20 ? 'ArrowUp' : 'ArrowDown');
      }
      const focused = await probe();
      assert.ok(focused.station.x > focused.stage.left + 12 && focused.station.x < focused.stage.right - 12 &&
        focused.station.y > focused.stage.top + 18 && focused.station.y < focused.stage.bottom - 18,
        `${label}: station 2 projected inside drawable stage after pan ${JSON.stringify(focused)}`);
      assert.ok(!intersects(focused.detail, focused.stage), `${label}: detail remains outside map after pan`);
      assert.notEqual(focused.hit.id, 'train-detail-close', `${label}: station 2 must not hit detail close button`);
      await page.screenshot({ path: `${out}/${label}-station-tap.png` });
      await page.touchscreen.tap(focused.station.x, focused.station.y);
      assert.ok(await page.locator('#station-peek').isVisible(), `${label}: one native tap on station 2 opens station peek`);
      assert.match(await page.locator('#station-peek').innerText(), /车站 2 · 候车/);
      assert.equal(await page.locator('#train-detail').isVisible(), false, `${label}: station replaces train panel`);
      const dense = await page.evaluate(() => {
        const m = window.metro;
        m.restart({ mode: 'endless', seed: 420 }); m.pause();
        m.submit({ action: { type: 'route', line: 0, stops: [1, 2] } });
        for (let i = 0; i < 9; i++) {
          const s = m.getState();
          if (s.phase === 'upgrade') m.submit({ action: { type: 'upgrade', choice: s.upgrades[0] } });
          m.step(4200);
        }
        const s = m.getState();
        if (s.phase === 'upgrade') m.submit({ action: { type: 'upgrade', choice: s.upgrades[0] } });
        return m.getState().stations.find(p => p.id === 1).queue.length;
      });
      assert.ok(dense > 40, `${label}: seeded real passenger fixture ${dense}`);
      await page.waitForFunction(() => document.querySelector('#mobile-crowd-alert')?.getClientRects().length && window.metro.getState().phase === 'playing');
      await page.locator('#mobile-crowd-alert').click();
      const denseTrain = page.locator('#train-layer [data-train-id]').first();
      const movingId = await denseTrain.getAttribute('data-train-id');
      await page.evaluate(id => document.querySelector(`[data-train-id="${id}"]`).click(), movingId);
      assert.ok(await page.locator('#train-detail').isVisible(), `${label}: moving train detail opens`);
      // The alert focuses an exhausted crowd; use the overview to bring a
      // queued station into frame while retaining the selected train panel.
      for (let attempt = 0; attempt < 12 && !(await page.evaluate(() => window.metro.mobileMapStats().visiblePositions.length)); attempt++) {
        const shift = await page.evaluate(() => {
          const stage=document.querySelector('#stage').getBoundingClientRect();
          const station=window.metro.getState().stations.filter(s=>s.queue.length).sort((a,b)=>b.queue.length-a.queue.length)[0];
          const p=window.metro.projectStation(station.id);
          return {x:p.x-stage.left-stage.width/2,y:p.y-stage.top-stage.height/2};
        });
        await page.locator('#map-overview').focus();
        await page.keyboard.press(Math.abs(shift.x)>Math.abs(shift.y) ? shift.x>0?'ArrowLeft':'ArrowRight' : shift.y>0?'ArrowUp':'ArrowDown');
      }
      await page.waitForTimeout(120);
      const populated = await probe();
      assert.ok(populated.glyphs.length > 0, `${label}: at least one real painted passenger visible ${JSON.stringify({stage:populated.stage,detail:populated.detail,station:populated.station})}`);
      assert.ok(!intersects(populated.detail, populated.stage), `${label}: moving train detail outside drawable stage`);
      assert.deepEqual(populated.glyphs.filter(g => intersects(g, populated.detail)), [], `${label}: no actual passenger glyph covered`);
      await page.screenshot({ path: `${out}/${label}-passengers.png` });
      results.push({ label, grouped: { stage: grouped.stage, detail: grouped.detail },
        populated: { stage: populated.stage, detail: populated.detail, visibleGlyphs: populated.glyphs.length } });
      assert.deepEqual(errors, [], `${label}: no browser errors`);
    } finally { await page.close(); }
  }
  console.log(JSON.stringify({ passed: true, results, screenshots: out }, null, 2));
} finally { await browser.close(); }
