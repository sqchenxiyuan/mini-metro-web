import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

// Given fixed geography/camera and three independently owned routes, changing
// waiting riders must not move, replace, hide or demote any endpoint. Queues
// may overlap a 44px target, must paint above its 3D cap, and cannot steal drag.
const output = process.env.METRO_PASSENGER_OUTPUT ?? '/opt/data/cache/scratch/metro-endpoint-passengers';
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error',
  plugins: [{ name: 'passenger-renderer-observer', enforce: 'pre', transform(code, id) {
    if (!id.endsWith('/src/main.ts')) return;
    const marker = 'const api = {';
    assert.ok(code.includes(marker));
    return code.replace(marker, 'window.__passengerRenderer = renderer;\n' + marker);
  } }] });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
const reports = [];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const sample = () => {
  const m = window.metro, stage = document.querySelector('#stage').getBoundingClientRect();
  const key = el => {
    const match = el.getAttribute('aria-label').match(/^(\d+)号线(起点|终点)/);
    return `${Number(match[1]) - 1}-${match[2] === '起点' ? 'start' : 'end'}`;
  };
  const identities = window.__passengerIdentities ??= new Map();
  const collect = (selector, fallback) => [...document.querySelectorAll(selector)].map(el => {
    const id = key(el), r = el.getBoundingClientRect(), identityKey = `${fallback}:${id}`;
    if (!identities.has(identityKey)) identities.set(identityKey, el);
    const circle = document.querySelector(`[data-route-handle="${id}"]`);
    return { key: id, sameNode: identities.get(identityKey) === el,
      center: [r.x + r.width / 2, r.y + r.height / 2], size: [r.width, r.height],
      svg: circle && [stage.x + Number(circle.getAttribute('cx')), stage.y + Number(circle.getAttribute('cy'))],
      centerHit: fallback || document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const renderer = window.__passengerRenderer, scene = m.mobileMapStats() ? renderer.scene : renderer;
  const glyphs = m.mobileMapStats()
    ? renderer.queueMeshes.filter(o => o.userData.shape).map(o => ({ ...o.userData, x: o.position.x + stage.x, y: o.position.y + stage.y }))
    : [...scene.cueEntries].flatMap(([name, entry]) => entry.group.children.flatMap(child => {
      if (child.userData.shape) return [{ ...child.userData, stationId: Number(name.split('-')[1]), count: 0,
        x: stage.x + entry.group.position.x + child.position.x, y: stage.y + entry.group.position.y + child.position.y }];
      const icon = child.children.find(o => o.userData.shape);
      return icon ? [{ ...icon.userData, stationId: Number(name.split('-')[1]),
        count: JSON.parse(entry.signature).find(g => g.shape === icon.userData.shape).count,
        x: stage.x + entry.group.position.x + child.position.x, y: stage.y + entry.group.position.y + child.position.y }] : [];
    }));
  return { hash: m.hash(), routes: m.getState().lines.map(l => l.stops),
    stage: [stage.x, stage.y, stage.width, stage.height],
    projections: m.getState().stations.map(s => m.projectStation(s.id)),
    camera: m.mobileMapStats() && { center: m.mobileMapStats().center, zoom: m.mobileMapStats().zoom },
    handles: collect('.endpoint-handle', false),
    fallback: collect('[role="group"][aria-label*="地图空间不足"] button', true),
    queues: m.getState().stations.map(s => ({ id: s.id, queue: s.queue })), glyphs,
    groups: m.mobileMapStats()?.queueGroups ?? [] };
};
const setQueues = (page, count) => page.evaluate(count => {
  const m = window.metro, s = m.controller.session.state;
  const shapes = ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'pentagon', 'egg', 'gem', 'wedge'].slice(0, innerHeight < 400 ? 4 : 10);
  for (const station of s.stations) station.queue = station.id > 2 ? [] : Array.from({ length: count }, (_, i) =>
    ({ id: 10000 + station.id * 100 + i, shape: shapes[i % shapes.length], born: 0, transfers: 0 }));
  m.controller.onChange();
}, count);
const invariant = (baseline, now, label) => {
  assert.deepEqual(now.stage, baseline.stage, `${label}: stage fixed`);
  assert.deepEqual(now.projections, baseline.projections, `${label}: every station projection fixed (not queue reflow)`);
  assert.deepEqual(now.camera, baseline.camera, `${label}: camera fixed`);
  assert.deepEqual(now.routes, baseline.routes, `${label}: no route edits during comparison`);
  for (const kind of ['handles', 'fallback']) {
    assert.deepEqual(now[kind].map(h => h.key), baseline[kind].map(h => h.key), `${label}: complete ${kind} keys stay fixed`);
    for (const h of now[kind]) {
      assert.equal(h.sameNode, true, `${label}: ${h.key} ${kind} DOM identity`);
      assert.deepEqual(h.center, baseline[kind].find(b => b.key === h.key).center, `${label}: ${h.key} ${kind} exact center`);
      assert.deepEqual(h.svg, baseline[kind].find(b => b.key === h.key).svg, `${label}: ${h.key} exact SVG center`);
      assert.equal(h.centerHit, true, `${label}: ${h.key} native center remains clickable`);
      if (kind === 'handles') assert.deepEqual(h.size, [44, 44], `${label}: exact 44px hit target`);
    }
  }
  assert.equal(now.handles.length + now.fallback.length, 6, `${label}: all six endpoints accessible`);
};

const pixelProof = async page => page.evaluate(async () => {
  const m = window.metro, renderer = window.__passengerRenderer;
  const mobile = Boolean(m.mobileMapStats()), core = mobile ? renderer.scene : renderer;
  const queues = mobile ? renderer.queueScene : core.sceneCues;
  const canvas = core.canvas, stage = document.querySelector('#stage').getBoundingClientRect();
  const draw = () => { core.drawScene(); if (mobile) renderer.paint(); };
  const capture = async () => {
    const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
    const copy = document.createElement('canvas'); copy.width = image.width; copy.height = image.height;
    const ctx = copy.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, copy.width, copy.height).data;
  };
  let capOnly, blank, queueOnly, combined;
  try {
    queues.visible = false; draw(); capOnly = await capture();
    core.endpointCaps.visible = false; draw(); blank = await capture();
    queues.visible = true; draw(); queueOnly = await capture();
    core.endpointCaps.visible = true; draw(); combined = await capture();
  } finally { queues.visible = true; core.endpointCaps.visible = true; draw(); }
  const circles = [...document.querySelectorAll('[data-route-handle]')].map(el => ({
    key: el.getAttribute('data-route-handle'), x: Number(el.getAttribute('cx')), y: Number(el.getAttribute('cy')) }));
  const glyphs = mobile ? renderer.queueMeshes.filter(o => o.userData.shape).map(o => ({ x: o.position.x, y: o.position.y, shape: o.userData.shape }))
    : [...core.cueEntries.values()].flatMap(entry => entry.group.children.flatMap(o => {
      const icon = o.userData.shape ? o : o.children.find(child => child.userData.shape);
      return icon ? [{ x: entry.group.position.x + o.position.x, y: entry.group.position.y + o.position.y, shape: icon.userData.shape }] : [];
    }));
  const scale = canvas.width / stage.width;
  const delta = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  const proof = [];
  for (const h of circles) for (const g of glyphs) {
    const pixels = [];
    for (let y = Math.floor((g.y - 5) * scale); y <= Math.ceil((g.y + 5) * scale); y++)
      for (let x = Math.floor((g.x - 5) * scale); x <= Math.ceil((g.x + 5) * scale); x++) {
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height || Math.abs(x / scale - h.x) > 22 || Math.abs(y / scale - h.y) > 22) continue;
        const i = (y * canvas.width + x) * 4;
        // Same queue color with/without cap, exactly where the lit cap would
        // otherwise cover the background: real composited pixels, not metadata.
        if (delta(capOnly, blank, i) > 80 && delta(combined, capOnly, i) > 80 &&
            delta(combined, queueOnly, i) <= 3) pixels.push({ point: [x / scale + stage.x, y / scale + stage.y], color: Array.from(combined.slice(i, i + 3)) });
      }
    if (pixels.length) proof.push({ key: h.key, shape: g.shape, pixels: pixels.length, examples: pixels,
      center: [h.x + stage.x, h.y + stage.y] });
  }
  return proof;
});

async function nativeDrag(page, touch, from, to) {
  await page.evaluate(() => { window.__passengerUp = false; window.__passengerMove = null; });
  if (!touch) {
    await page.mouse.move(...from); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 20 }); await page.mouse.up();
  } else {
    const cdp = await page.context().newCDPSession(page);
    const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type,
      touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x, y, radiusX: 4, radiusY: 4, force: 1 }] });
    try {
      await send('touchStart', ...from);
      for (let i = 1; i <= 20; i++) await send('touchMove', from[0] + (to.x - from[0]) * i / 20, from[1] + (to.y - from[1]) * i / 20);
      // CDP ACK precedes DOM delivery; observe the actual last pointer move.
      await page.waitForFunction(p => window.__passengerMove && Math.hypot(window.__passengerMove.x - p.x, window.__passengerMove.y - p.y) < .1, to);
      await send('touchEnd', to.x, to.y);
    } finally { await cdp.detach(); }
  }
  await page.waitForFunction(() => window.__passengerUp);
  await settle(page);
}

try {
  for (const [width, height, touch] of [[1280, 800, false], [390, 844, true], [568, 320, true]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      const m = window.metro;
      m.restart({ mode: 'creative', seed: 77 }); m.pause();
      const s = m.controller.session.state;
      // One geographic row prevents queue-driven mobile warp; camera is manual.
      s.stations.forEach((p, i) => { p.x = [-2.4, 2.4, 0][i]; p.y = 0; p.queue = []; });
      m.controller.onChange();
      const renderer = window.__passengerRenderer;
      renderer.setZoom(m.mobileMapStats() ? 1.1 : 1);
      const stage = document.querySelector('#stage').getBoundingClientRect();
      const a = m.projectStation(1), b = m.projectStation(2);
      renderer.pan(stage.left + stage.width / 2 - (a.x + b.x) / 2,
        stage.top + (stage.height < 300 ? 34 : stage.height / 2 - 22) - a.y);
      for (let line = 0; line < 3; line++) {
        const result = m.submit({ action: { type: 'route', line, stops: [1, 2] } });
        if (!result.ok) throw Error(JSON.stringify(result));
      }
      m.controller.onChange();
      window.addEventListener('pointermove', e => { window.__passengerMove = { x: e.clientX, y: e.clientY }; }, true);
      window.addEventListener('pointerup', () => { window.__passengerUp = true; }, true);
    });
    await settle(page);
    const baseline = await page.evaluate(sample);
    assert.equal(baseline.handles.length > 0, true, `${width}: fixture needs actual map controls`);
    const frames = [baseline];
    for (const count of [1, 6, 10, 11, 30, 17, 0]) {
      await setQueues(page, count); await settle(page);
      const frame = await page.evaluate(sample); frames.push(frame);
      await writeFile(`${output}/${width}x${height}-frames.json`, JSON.stringify(frames, null, 2));
      invariant(baseline, frame, `${width} queue=${count}`);
      assert.equal(frame.queues.reduce((n, s) => n + s.queue.length, 0), count * 2, 'real authoritative queue totals');
      if (count) assert.notEqual(frame.hash, baseline.hash, 'queue changes alter the actual simulation state');
      else assert.equal(frame.hash, baseline.hash, 'empty→queued→empty restores the original authoritative state');
      if (count <= 10) assert.deepEqual(frame.glyphs.map(g => g.passengerId).sort((a, b) => a - b),
        frame.queues.flatMap(s => s.queue.map(p => p.id)).sort((a, b) => a - b), 'every individual rider ID is actually represented, not a hidden queue');
      const categories = Math.min(count, height < 400 ? 4 : 10);
      assert.equal(frame.glyphs.length, count <= 10 ? count * 2 : categories * 2, 'individual riders or every real destination category painted');
      if (count > 10 && touch) assert.ok(frame.groups.every(g => g.groups.every(item => item.visible)), 'all grouped queue categories remain on-stage');
      if (count > 10) for (const station of frame.queues.filter(s => s.queue.length)) {
        const actual = frame.glyphs.filter(g => g.stationId === station.id).map(g => [g.shape, g.count]).sort();
        const expected = Object.entries(station.queue.reduce((acc, p) => (acc[p.shape] = (acc[p.shape] ?? 0) + 1, acc), {})).sort();
        assert.deepEqual(actual, expected, 'group labels count every real rider by destination');
      }
    }
    await setQueues(page, 30); await settle(page);
    const queued = await page.evaluate(sample);
    invariant(baseline, queued, `${width} overlap fixture`);
    const pixels = await pixelProof(page);
    await writeFile(`${output}/${width}x${height}-pixels.json`, JSON.stringify(pixels, null, 2));
    assert.ok(pixels.some(p => p.pixels >= 3), `${width}: actual queue pixels must cover an actually painted 3D cap inside its 44px target`);
    const screenshot = await page.screenshot({ path: `${output}/${width}x${height}-overlap.png` });
    const pagePixels = await page.evaluate(async ({ imageData, proof }) => {
      const image = new Image(); image.src = imageData; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return proof.map(p => ({ key: p.key, shape: p.shape, visiblePixels: p.examples.filter(({ point: [x, y], color }) => {
        const rgba = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
        return color.every((c, i) => Math.abs(c - rgba[i]) <= 3);
      }).length }));
    }, { imageData: `data:image/png;base64,${screenshot.toString('base64')}`, proof: pixels });
    assert.ok(pagePixels.some(p => p.visiblePixels >= 3), `${width}: composited page retains passenger pixels above cap and inert DOM owner links`);
    const grabbed = pixels.filter(p => pagePixels.some(v => v.key === p.key && v.shape === p.shape && v.visiblePixels >= 3)).sort((a, b) => b.pixels - a.pixels)[0];
    const [lineText, side] = grabbed.key.split('-'), line = Number(lineText);
    const handle = queued.handles.find(h => h.key === grabbed.key);
    assert.equal(handle.centerHit, true, 'inert queue overlapping the cap cannot steal its native center');
    const target = queued.projections[2];
    await nativeDrag(page, touch, handle.center, target);
    const after = await page.evaluate(() => window.metro.getState().lines.map(l => l.stops));
    const expected = structuredClone(queued.routes);
    expected[line] = side === 'start' ? [3, ...expected[line]] : [...expected[line], 3];
    assert.deepEqual(after, expected, `${width}: native ${touch ? 'touch' : 'mouse'} extends exact ${grabbed.key}, preserving every other line`);
    await page.screenshot({ path: `${output}/${width}x${height}-native-extension.png` });
    reports.push({ viewport: [width, height], frames: frames.length, handles: baseline.handles, fallback: baseline.fallback,
      pixelProof: pixels, pagePixels, native: { input: touch ? 'touch' : 'mouse', key: grabbed.key, before: queued.routes, after }, errors });
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2));
  await browser.close(); await server.close();
}
console.log(JSON.stringify({ output, reports }));
