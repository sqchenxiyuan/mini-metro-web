import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

// Observe the actual static obstacle boxes from layoutHandles, not a copy of
// its reservation formula. This probe does not modify production source.
const reservationMarker = '  const fits = (x: number, y: number): boolean => {';
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
  plugins: [{ name: 'badge-reservation-probe', enforce: 'pre', transform(code, id) {
    if (!id.endsWith('/src/main.ts')) return;
    assert.ok(code.includes(reservationMarker), 'reservation probe must instrument layoutHandles');
    return code.replace(reservationMarker,
      '  window.__badgeReservations = blocked.slice(-lastState.stations.length * 2).map(({left, top, right, bottom}) => ({left, top, right, bottom}));\n' + reservationMarker);
  } }] });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
const sample = () => {
  const metro = window.metro;
  const stage = document.querySelector('#stage').getBoundingClientRect();
  const handles = [...document.querySelectorAll('[data-route-handle]')].map(circle => {
    const key = circle.getAttribute('data-route-handle');
    const button = [...document.querySelectorAll('.endpoint-handle')].find(b =>
      b.getAttribute('aria-label')?.startsWith(`${Number(key.split('-')[0]) + 1}号线${key.endsWith('start') ? '起点' : '终点'}`));
    const rect = button?.getBoundingClientRect();
    const identities = window.__endpointStabilityButtons ??= new Map();
    if (!identities.has(key)) identities.set(key, button);
    return { key, sameButton: identities.get(key) === button,
      center: rect && [rect.x + rect.width / 2, rect.y + rect.height / 2],
      svg: [stage.x + Number(circle.getAttribute('cx')), stage.y + Number(circle.getAttribute('cy'))],
      size: rect && [rect.width, rect.height] };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const trains = metro.getState().trains.map(t => {
    const badge = document.querySelector(`[data-train-id="${t.id}"]`);
    return { id: t.id, from: t.from, to: t.to, progress: t.progress,
      rect: badge && !badge.hidden ? badge.getBoundingClientRect().toJSON() : null };
  });
  return { tick: metro.getState().tick, hash: metro.hash(), trains, handles,
    stage: [stage.x, stage.y, stage.width, stage.height],
    stations: [1, 2].map(id => metro.projectStation(id)),
    camera: metro.mobileMapStats() && { center: metro.mobileMapStats().center, zoom: metro.mobileMapStats().zoom } };
};
const pointNear = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.05);
const sameCamera = (a, b) => pointNear(a.stage, b.stage) &&
  a.stations.every((p, i) => pointNear([p.x, p.y], [b.stations[i].x, b.stations[i].y]));
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
  a.y < b.y + b.height && a.y + a.height > b.y;
const contains = (outer, inner) => outer.left <= inner.left + 0.01 &&
  outer.top <= inner.top + 0.01 && outer.right >= inner.right - 0.01 &&
  outer.bottom >= inner.bottom - 0.01;

try {
  for (const [width, height, touch] of [[1024, 768, false], [390, 844, true], [568, 320, true]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    const fixture = await page.evaluate(() => {
      const m = window.metro;
      m.restart({ mode: 'creative', seed: 77 }); m.pause();
      return m.submit({ action: { type: 'route', line: 0, stops: [1, 2] } });
    });
    assert.equal(fixture.ok, true, JSON.stringify(fixture));
    // Allow the opening camera's scheduled frame and ResizeObserver to settle.
    await page.waitForTimeout(150);
    const frames = [];
    for (let i = 0; i < 160; i++) {
      if (i) await page.evaluate(() => window.metro.step(1));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      frames.push(await page.evaluate(sample));
    }
    const initial = frames[0];
    assert.equal(initial.handles.length, 2, `${width}: both route endpoints need on-map 44px controls`);
    assert.ok(initial.handles.every(h => h.center && h.size[0] >= 44 && h.size[1] >= 44),
      `${width}: measure real 44px DOM targets as well as SVG centers`);
    const changed = frames.filter(frame => frame.hash !== initial.hash);
    assert.ok(changed.length > 50, `${width}: simulation must really advance`);
    assert.ok(changed.some(frame => frame.trains.some(t => t.to !== null && t.progress > 0)),
      `${width}: train must really move`);
    const fixed = frames.filter(frame => sameCamera(initial, frame));
    assert.ok(fixed.length > 60, `${width}: camera and stage must stay fixed over actual train motion`);
    const initialKeys = initial.handles.map(h => h.key).sort();
    for (const frame of fixed) assert.deepEqual(frame.handles.map(h => h.key).sort(), initialKeys,
      `${width}: fixed-camera frame ${frame.tick} retains the complete endpoint key set`);
    const jitter = fixed.flatMap(frame => frame.handles.flatMap(handle => {
      const baseline = initial.handles.find(h => h.key === handle.key);
      return !baseline || !pointNear(handle.center, baseline.center) || !pointNear(handle.svg, baseline.svg)
        ? [{ tick: frame.tick, hash: frame.hash, train: frame.trains[0],
          key: handle.key, from: baseline?.center, to: handle.center,
          svgFrom: baseline?.svg, svgTo: handle.svg }] : [];
    }));
    const crossings = fixed.filter(frame => frame.trains.some(train => train.to !== null && train.rect &&
      frame.handles.some(handle => handle.center && overlaps(train.rect,
        { x: handle.center[0] - 22, y: handle.center[1] - 22, width: 44, height: 44 }))));
    console.log(JSON.stringify({ viewport: [width, height], frames: frames.length,
      changedHashes: changed.length, cameraStable: fixed.length, movingCrossings: crossings.length,
      firstCrossing: crossings[0] && {tick:crossings[0].tick,hash:crossings[0].hash,train:crossings[0].trains[0]}, jitter: jitter.slice(0, 5),
      initial: { tick: initial.tick, hash: initial.hash, train: initial.trains[0], handles: initial.handles.map(({key,center,svg,size}) => ({key,center,svg,size})) },
      last: { tick: frames.at(-1).tick, hash: frames.at(-1).hash, train: frames.at(-1).trains[0] } }));
    assert.equal(fixed.every(frame => frame.handles.length === initial.handles.length &&
      frame.handles.every(handle => handle.sameButton)), true,
      `${width}: handle count and DOM identities must survive train motion`);
    assert.deepEqual(jitter.slice(0, 5), [], `${width}: endpoint DOM and SVG centers must remain fixed with unchanged camera/route`);
    const staticObstacles = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('[data-station]')].filter(n => !n.hidden && n.getClientRects().length)
        .map(n => n.getBoundingClientRect().toJSON());
      const handles = [...document.querySelectorAll('.endpoint-handle')].map(n => n.getBoundingClientRect().toJSON());
      return { boxes, handles };
    });
    assert.ok(staticObstacles.handles.every(a => staticObstacles.boxes.every(b => !overlaps(a, b))),
      `${width}: handle stays clear of station targets`);
    await page.evaluate(() => {
      const m = window.metro;
      m.restart({ mode: 'creative', seed: 77 }); m.pause();
      for (const [line, stops] of [[1, 2], [1, 3], [2, 1]].entries()) {
        const result = m.submit({ action: { type: 'route', line, stops } });
        if (!result.ok) throw Error(JSON.stringify(result));
      }
    });
    const badgeBounds = await page.evaluate(() => {
      const stations = window.metro.getState().stations;
      const reserved = window.__badgeReservations;
      return [...document.querySelectorAll('[data-train-group], [data-train-id]')]
        .filter(el => !el.hidden && (el.hasAttribute('data-train-group') ||
          window.metro.getState().trains.some(t => String(t.id) === el.dataset.trainId && t.to === null)))
        .map(el => {
          const group = el.hasAttribute('data-train-group');
          const stationId = group ? Number(el.dataset.trainGroup) :
            window.metro.getState().trains.find(t => String(t.id) === el.dataset.trainId).from;
          const index = stations.findIndex(s => s.id === stationId);
          return { name: group ? `group-${stationId}` : `train-${el.dataset.trainId}`,
            actual: el.getBoundingClientRect().toJSON(), reservation: reserved[index * 2 + Number(group)] };
        });
    });
    console.log(JSON.stringify({ viewport: [width, height], badgeBounds }));
    assert.ok(badgeBounds.some(b => b.name.startsWith('group-')), `${width}: fixture exposes grouped badge`);
    assert.ok(badgeBounds.some(b => b.name.startsWith('train-')), `${width}: fixture exposes parked badge`);
    for (const badge of badgeBounds) assert.ok(contains(badge.reservation, badge.actual),
      `${width}: static reservation must contain entire ${badge.name} CSS hit box: ${JSON.stringify(badge)}`);
    if (width === 1024) {
      const groupAccess = await page.evaluate(() => {
        const badge = document.querySelector('[data-train-group="1"]');
        const rect = badge.getBoundingClientRect();
        const station = document.querySelector('[data-station="1"]').getBoundingClientRect();
        for (let y = rect.top + 2; y < rect.bottom - 2; y += 3)
          for (let x = rect.left + 2; x < rect.right - 2; x += 3)
            if (document.elementFromPoint(x, y) === badge &&
              !(x >= station.left && x <= station.right && y >= station.top && y <= station.bottom) &&
              Math.hypot(x - window.metro.projectStation(1).x,
                y - window.metro.projectStation(1).y) > 14) return { x, y };
        return null;
      });
      assert.ok(groupAccess, `${width}: grouped badge retains a native hit region`);
      await page.mouse.click(groupAccess.x, groupAccess.y);
      assert.equal(await page.locator('#context-actions [data-action="retire"]').count(), 1,
        `${width}: native grouped badge click opens train actions`);
      console.log(JSON.stringify({ viewport: [width, height], groupAccess, nativeGroupClick: 'train context opened' }));
    }
    if (width === 390) {
      // Shared endpoints stress both parked individual badges and a group badge
      // through arrival/departure; none may alter 44px handle boxes.
      await page.evaluate(() => {
        const m = window.metro;
        m.restart({ mode: 'creative', seed: 77 }); m.pause();
        for (const [line, stops] of [[1, 2], [1, 3], [2, 1]].entries()) {
          const result = m.submit({ action: { type: 'route', line, stops } });
          if (!result.ok) throw Error(JSON.stringify(result));
        }
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const sharedFrames = [];
      for (let tick = 0; tick < 160; tick++) {
        if (tick) await page.evaluate(() => window.metro.step(1));
        sharedFrames.push(await page.evaluate(() => {
          const rect = el => el.getBoundingClientRect().toJSON();
          const handles = [...document.querySelectorAll('.endpoint-handle')].map(el =>
            ({ name: el.getAttribute('aria-label'), rect: rect(el) }));
          const parked = [...document.querySelectorAll('[data-train-id], [data-train-group]')]
            .filter(el => !el.hidden && (el.hasAttribute('data-train-group') ||
              window.metro.getState().trains.find(t => String(t.id) === el.dataset.trainId)?.to === null))
            .map(el => ({ name: el.dataset.trainId ?? `group-${el.dataset.trainGroup}`, rect: rect(el) }));
          return { hash: window.metro.hash(), handles, parked };
        }));
      }
      const sharedInitial = sharedFrames[0];
      assert.equal(sharedInitial.handles.length, 6, 'three shared routes expose six on-map handles');
      assert.ok(sharedFrames.filter(frame => frame.hash !== sharedInitial.hash).length > 100,
        'shared-route fixture advances actual trains');
      const sharedJitter = sharedFrames.flatMap((frame, tick) => frame.handles.flatMap(handle => {
        const original = sharedInitial.handles.find(h => h.name === handle.name);
        return !original || !pointNear([handle.rect.x, handle.rect.y],
          [original.rect.x, original.rect.y]) ? [{ tick, name: handle.name }] : [];
      }));
      const sharedKeys = sharedInitial.handles.map(h => h.name).sort();
      assert.equal(new Set(sharedKeys).size, 6, 'each shared endpoint has a distinct key');
      for (const [tick, frame] of sharedFrames.entries()) assert.deepEqual(
        frame.handles.map(h => h.name).sort(), sharedKeys,
        `shared endpoint key set must survive frame ${tick} (not just surviving handles)`);
      const sharedParkedOverlap = sharedFrames.flatMap((frame, tick) => frame.handles.flatMap(handle =>
        frame.parked.filter(train => overlaps(handle.rect, train.rect))
          .map(train => ({ tick, handle: handle.name, parked: train.name }))));
      console.log(JSON.stringify({ sharedRoutes: { frames: sharedFrames.length,
        changedHashes: sharedFrames.filter(frame => frame.hash !== sharedInitial.hash).length,
        groupFrames: sharedFrames.filter(frame => frame.parked.some(t => t.name.startsWith('group-'))).length,
        sharedJitter, sharedParkedOverlap } }));
      assert.deepEqual(sharedJitter, [], 'shared endpoints stay fixed across train/group transitions');
      assert.deepEqual(sharedParkedOverlap, [], 'no shared endpoint overlaps a parked/group badge');
      const train6Access = await page.evaluate(() => {
        const m = window.metro;
        m.restart({ mode: 'creative', seed: 77 }); m.pause();
        for (const [line, stops] of [[1, 2], [1, 3], [2, 1]].entries())
          m.submit({ action: { type: 'route', line, stops } });
        const badge = document.querySelector('[data-train-id="6"]');
        const rect = badge.getBoundingClientRect();
        for (let y = rect.top + 2; y < rect.bottom - 2; y += 3)
          for (let x = rect.left + 2; x < rect.right - 2; x += 3)
            if (document.elementFromPoint(x, y) === badge) return { x, y };
        return null;
      });
      assert.ok(train6Access, 'shared endpoint train 6 badge must retain a native tap region');
      await page.touchscreen.tap(train6Access.x, train6Access.y);
      assert.equal(await page.locator('#context-actions [data-action="retire"]').count(), 1,
        'native shared-endpoint train 6 tap opens train actions');
      console.log(JSON.stringify({ train6Access, nativeTrain6Tap: 'train context opened' }));
      await page.evaluate(() => {
        const m = window.metro;
        m.restart({ mode: 'creative', seed: 77 }); m.pause();
        for (const [line, stops] of [[1, 2], [1, 3], [2, 1]].entries())
          m.submit({ action: { type: 'route', line, stops } });
        m.step(159);
      });
      const preZoom = await page.evaluate(sample);
      await page.locator('#zoom-in').click();
      const zoomed = await page.evaluate(sample);
      assert.equal(zoomed.hash, preZoom.hash, 'camera-only zoom leaves simulation hash unchanged');
      assert.ok(!sameCamera(preZoom, zoomed), 'camera-only zoom changes station projections');
      assert.ok(!pointNear(zoomed.handles.find(h => h.key === '0-end').center,
        preZoom.handles.find(h => h.key === '0-end').center),
      'camera change can legitimately reproject endpoint controls');
      console.log(JSON.stringify({ cameraZoom: { hash: zoomed.hash,
        endBefore: preZoom.handles.find(h => h.key === '0-end').center,
        endAfter: zoomed.handles.find(h => h.key === '0-end').center } }));
      const parkedCrossings = fixed.flatMap(frame => frame.trains.filter(t => t.to === null && t.rect &&
        frame.handles.some(h => overlaps(t.rect,
          { x: h.center[0] - 22, y: h.center[1] - 22, width: 44, height: 44 }))).map(t => ({tick:frame.tick,train:t.id})));
      assert.deepEqual(parkedCrossings, [], 'parked train badges never overlap the stable 44px endpoint target');
      console.log(JSON.stringify({ parkedCrossings }));
      const parkedAccess = await page.evaluate(() => {
        const m = window.metro;
        m.restart({ mode: 'creative', seed: 77 }); m.pause();
        m.submit({ action: { type: 'route', line: 0, stops: [1, 2] } });
        m.step(119);
        const badge = document.querySelector('[data-train-id="4"]');
        const rect = badge.getBoundingClientRect();
        for (let y = rect.top + 2; y < rect.bottom - 2; y += 3)
          for (let x = rect.left + 2; x < rect.right - 2; x += 3)
            if (document.elementFromPoint(x, y) === badge) return { x, y };
        return null;
      });
      assert.ok(parkedAccess, 'parked badge keeps a native clickable area outside the higher-priority handle');
      await page.touchscreen.tap(parkedAccess.x, parkedAccess.y);
      assert.equal(await page.locator('#context-actions').isVisible(), true,
        'native parked badge tap opens the train context, not a route handle');
      assert.equal(await page.locator('#context-actions [data-action="retire"]').count(), 1,
        'train context exposes its retire action');
      console.log(JSON.stringify({ parkedBadgeClickableAt: parkedAccess, nativeBadgeTap: 'train context opened' }));
      // With three shared routes, a train departing station 1 crosses the
      // first route's start handle. This remains a native drag, not an arm/click.
      const atCrossing = await page.evaluate(() => {
        const m = window.metro;
        m.restart({ mode: 'creative', seed: 77 }); m.pause();
        for (const [line, stops] of [[1, 2], [1, 3], [2, 1]].entries()) {
          const route = m.submit({ action: { type: 'route', line, stops } });
          if (!route.ok) throw Error(JSON.stringify(route));
        }
        m.step(26);
        return m.projectStation(3);
      });
      const crossing = await page.evaluate(sample);
      const end = crossing.handles.find(h => h.key === '0-start');
      assert.ok(crossing.trains.some(t => t.to !== null && t.rect && overlaps(t.rect,
        { x: end.center[0] - 22, y: end.center[1] - 22, width: 44, height: 44 })),
      `real moving badge must cross the dragged endpoint: ${JSON.stringify(crossing)}`);
      const centerHit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, end.center);
      assert.equal(centerHit, 'endpoint-handle', 'handle receives input over train layer');
      const target = atCrossing;
      console.log(JSON.stringify({ crossing: { tick: crossing.tick, hash: crossing.hash,
        train: crossing.trains.find(t => t.to !== null), handle: end.center, destination: target, centerHit } }));
      assert.ok(target.x >= crossing.stage[0] && target.x <= crossing.stage[0] + crossing.stage[2] &&
        target.y >= crossing.stage[1] && target.y <= crossing.stage[1] + crossing.stage[3],
        'third station is reachable at fixed camera');
      const cdp = await page.context().newCDPSession(page);
      const touchEvent = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x, y, radiusX: 4, radiusY: 4, force: 1 }],
      });
      await touchEvent('touchStart', ...end.center);
      for (let i = 1; i <= 16; i++) await touchEvent('touchMove',
        end.center[0] + (target.x - end.center[0]) * i / 16,
        end.center[1] + (target.y - end.center[1]) * i / 16);
      await touchEvent('touchEnd', target.x, target.y);
      assert.deepEqual(await page.evaluate(() => window.metro.getState().lines[0].stops), [3, 1, 2],
        'native drag while moving train crosses handle extends exact route');
      const edited = await page.evaluate(sample);
      assert.notEqual(edited.hash, crossing.hash, 'route drag changes authoritative simulation hash');
      assert.ok(!pointNear(edited.handles.find(h => h.key === '0-start').center, end.center),
        'a structural route edit is allowed to relocate its endpoint handle');
      console.log('390: moving-train crossing + native endpoint drag passed');
    }
    assert.deepEqual(errors, [], `${width}: no browser exceptions`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
