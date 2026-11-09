import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './browser-launch.mjs';

const base = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:4175/integration.html';
const output = '/opt/data/cache/scratch/mini-metro-inspector-hit';
await mkdir(output, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 568, height: 320 },
    deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro?.mobileMapStats());
    await page.locator('#map-first-toggle').click();
    await page.waitForFunction(() => !document.body.classList.contains('map-first'));
    await page.evaluate(() => {
      const metro = window.metro;
      metro.restart({ mode: 'endless', seed: 420 });
      metro.pause();
      metro.step(4200);
      if (metro.getState().phase === 'upgrade') metro.submit({ action: { type: 'upgrade', choice: metro.getState().upgrades[0] } });
    });
    await page.waitForFunction(() => !document.querySelector('#mobile-crowd-alert').hidden);
    await page.locator('#mobile-crowd-alert').click();
    await page.waitForFunction(() => !document.querySelector('#station-peek').hidden);
    await page.evaluate(() => window.scrollTo(0, window.scrollY +
      document.querySelector('.map-panel').getBoundingClientRect().top - 50));
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      const hit = selector => {
        const node = document.querySelector(selector), r = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2));
      };
      const stage = document.querySelector('#stage'), stageRect = stage.getBoundingClientRect();
      const peek = document.querySelector('#station-peek');
      const selected = Number(peek.textContent.match(/车站\s*(\d+)/)?.[1]);
      const selectedLabel = [...document.querySelectorAll('#station-layer [data-station]')]
        .find(node => Number(node.dataset.station) === selected);
      const railControls = ['#line-chooser', '#queue-browser-toggle', '#zoom-out', '#zoom-reset', '#zoom-in', '#screenshot']
        .map(selector => ({ selector, box: rect(selector), hit: hit(selector) }));
      const stageHit = [0.1, 0.2, 0.8, 0.9].some(fraction =>
        stage.contains(document.elementFromPoint(stageRect.left + stageRect.width * fraction,
          (stageRect.top + stageRect.bottom) / 2)));
      return { stage: rect('#stage'), map: rect('.map-panel'), peek: rect('#station-peek'),
        peekContent: peek.textContent.trim(), peekVisible: peek.clientHeight >= peek.scrollHeight - 1,
        peekTextFits: peek.scrollWidth <= peek.clientWidth + 1,
        alert: rect('#mobile-crowd-alert'), alertContent: document.querySelector('#mobile-crowd-alert').textContent.trim(),
        alertTextFits: document.querySelector('#mobile-crowd-alert').scrollWidth <= document.querySelector('#mobile-crowd-alert').clientWidth + 1,
        toolbar: rect('.map-tools'), railControls,
        selectedLabel: selectedLabel?.getBoundingClientRect().toJSON() ?? null,
        stageHit, alertHit: hit('#mobile-crowd-alert'), screenshotHit: hit('#screenshot'),
        contextHidden: document.querySelector('#context-actions').hidden, mapFirst: document.body.classList.contains('map-first') };
    });
    await page.screenshot({ path: `${output}/568x320-crowd-peek.png`, fullPage: true });
    await page.locator('#game-shell').screenshot({ path: `${output}/568x320-crowd-peek-game.png` });
    console.log(JSON.stringify(geometry));
    const disjoint = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    assert.ok(!geometry.mapFirst && geometry.stage.height >= 112 && geometry.stage.width >= 440,
      `short-normal crowded peek needs at least 112px of wide drawable map: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.stageHit && geometry.alertHit && geometry.screenshotHit,
      `map, alert, and screenshot controls remain native-hit-testable: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.peekContent.includes('候车') && geometry.peekVisible && geometry.peekTextFits && geometry.peek.width >= 300,
      `station name, queue, crowd countdown are legible without clipping: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.alertContent.includes('拥挤') && geometry.alertTextFits && geometry.alert.width >= 170 && geometry.alert.height >= 44,
      `crowd warning is readable and a 44px touch target: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.stage.top >= geometry.peek.bottom && disjoint(geometry.stage, geometry.alert),
      `drawable map stays outside peek and crowd warning: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.selectedLabel && geometry.selectedLabel.top >= geometry.stage.top + 12 &&
      geometry.selectedLabel.bottom <= geometry.stage.bottom - 12 && geometry.selectedLabel.width >= 44,
      `focused station needs a visible hit target and queue room within the stage: ${JSON.stringify(geometry)}`);
    for (const item of geometry.railControls) {
      assert.ok(item.hit && item.box.width >= 44 && item.box.height >= 44 && disjoint(item.box, geometry.alert),
        `warning must not obstruct ${item.selector}: ${JSON.stringify(geometry)}`);
    }
    // Pan until a queue owner leaves the stage while its passengers remain.
    // Test the actual pointer receiver, not just the station's DOM rectangle.
    await page.evaluate(() => {
      document.querySelector('#stage').focus({ preventScroll: true });
      window.scrollTo(0, window.scrollY + document.querySelector('.map-panel').getBoundingClientRect().top - 50);
    });
    let coexistence;
    for (let step = 0; step < 18; step++) {
      coexistence = await page.evaluate(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const cue = [...document.querySelectorAll('.mobile-owner-cue')].find(n => n.textContent.includes('候车'));
        const stationHits = [...document.querySelectorAll('#station-layer [data-station]')].map(node => {
          const r = node.getBoundingClientRect();
          const centerX = (r.left + r.right) / 2, centerY = (r.top + r.bottom) / 2;
          const receiver = document.elementFromPoint(centerX, centerY);
          return { id: Number(node.dataset.station), rect: r.toJSON(),
            fullyVisible: r.width >= 44 && r.height >= 44 && r.left >= stage.left && r.right <= stage.right &&
              r.top >= stage.top && r.bottom <= stage.bottom,
            receiver: receiver?.className ?? null, hit: node.contains(receiver) };
        });
        return { stage: stage.toJSON(), cue: cue?.getBoundingClientRect().toJSON() ?? null,
          cueText: cue?.textContent ?? null, stationHits,
          alert: document.querySelector('#mobile-crowd-alert').getBoundingClientRect().toJSON(),
          peek: document.querySelector('#station-peek').getBoundingClientRect().toJSON(),
          hash: window.metro.hash() };
      });
      if (coexistence.cue && coexistence.stationHits.some(hit => hit.fullyVisible)) break;
      await page.keyboard.press('ArrowDown');
    }
    console.log(`owner/station coexistence: ${JSON.stringify(coexistence)}`);
    await page.locator('#game-shell').screenshot({ path: `${output}/568x320-owner-cue-game.png` });
    assert.ok(coexistence.cue && coexistence.stationHits.some(hit => hit.fullyVisible),
      'deterministic crowded peek must expose a cue alongside a visible station');
    assert.ok(coexistence.cueText.includes('2 候车'), 'fixture exposes station 2 owner cue');
    assert.ok(coexistence.stage.height >= 112 && coexistence.peek.bottom <= coexistence.cue.top &&
      disjoint(coexistence.alert, coexistence.stage), 'alert, peek, cue and canvas need separate readable strips');
    const visibleStations = coexistence.stationHits.filter(hit => hit.fullyVisible);
    for (const station of visibleStations)
      assert.ok(station.hit, `visible 44px station ${station.id} must receive native pointer: ${JSON.stringify(coexistence)}`);
    assert.ok(coexistence.cue.bottom <= coexistence.stage.top || coexistence.cue.top >= coexistence.stage.bottom,
      `owner cue must occupy a strip outside the drawable map: ${JSON.stringify(coexistence)}`);
    const beforeStationTap = await page.evaluate(() => window.metro.hash());
    const station = visibleStations[0];
    await page.touchscreen.tap((station.rect.left + station.rect.right) / 2, (station.rect.top + station.rect.bottom) / 2);
    assert.equal(await page.evaluate(() => window.metro.hash()), beforeStationTap, 'station touch does not mutate game state');
    await page.evaluate(() => window.scrollTo(0, window.scrollY +
      document.querySelector('.map-panel').getBoundingClientRect().top - 50));
    const nativeCue = await page.locator('.mobile-owner-cue').filter({hasText:'2 候车'}).first().evaluate(node => {
      const r = node.getBoundingClientRect();
      return { x: (r.left+r.right)/2, y: (r.top+r.bottom)/2,
        hit: node.contains(document.elementFromPoint((r.left+r.right)/2, (r.top+r.bottom)/2)) };
    });
    assert.ok(nativeCue.hit, 'owner cue is a native pointer receiver before touch');
    await page.touchscreen.tap(nativeCue.x, nativeCue.y);
    const afterCueTap = await page.evaluate(() => ({
      center: window.metro.mobileMapStats().center,
      owner: window.metro.mobileMapStats().bounds.find(b => b.id === 2),
    }));
    assert.ok(Math.abs(afterCueTap.center.x - afterCueTap.owner.x) < 1,
      `native owner cue tap focuses station 2: ${JSON.stringify(afterCueTap)}`);
    assert.equal(await page.evaluate(() => window.metro.hash()), coexistence.hash, 'native cue tap changes camera, not game hash');
  } finally { await page.close(); }
  console.log('Integration short-normal map remains drawable with crowd warning and peek.');
} finally { await browser.close(); }
