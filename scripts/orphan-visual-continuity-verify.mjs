import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './browser-launch.mjs';

const base = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/';
const out = 'test-results/orphan-visual-continuity';
await mkdir(out, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const [width, height] of [[390, 500], [568, 320], [1280, 800]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1,
      isMobile: width < 600, hasTouch: width < 600 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.metro && document.querySelector('#stage canvas'));
      const result = await page.evaluate(() => {
        const metro = window.metro;
        metro.restart({ seed: 420, mode: 'creative' });
        metro.pause();
        const route = stops => metro.submit({ action: { type: 'route', line: 0, stops } });
        if (!route([1, 2, 3]).ok) throw Error('initial route rejected');
        let state = metro.getState(), train = state.trains[0];
        for (let i = 0; i < 600 && !(train.from === 2 && train.to === 3 && train.progress > .42 && train.progress < .6); i++) {
          metro.step(1); state = metro.getState(); train = state.trains[0];
        }
        if (!(train.from === 2 && train.to === 3 && train.progress > .42 && train.progress < .6))
          throw Error('no mid-edge train');
        // Force the layout to reserve multiple queue rows at the departing station.
        const live = metro.controller.session.state;
        live.stations.find(p => p.id === 2).queue = Array.from({ length: 36 }, (_, i) =>
          ({ id: 8000 + i, born: 0, transfers: 0,
            shape: ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'pentagon', 'egg', 'gem', 'wedge'][i % 10] }));
        metro.controller.onChange();
        const position = id => {
          const badge = document.querySelector(`[data-train-id="${id}"]`);
          if (!badge) throw Error('train badge missing');
          const rect = badge.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        };
        const before = { position: position(train.id), stations: [2, 3].map(id => metro.projectStation(id)),
          tick: state.tick, progress: train.progress,
          bounds: document.querySelector('#stage').getBoundingClientRect().toJSON(), canvas: metro.capture() };
        if (!route([1, 2]).ok) throw Error('endpoint removal rejected');
        state = metro.getState(); train = state.trains.find(t => t.id === train.id);
        const after = { position: position(train.id), stations: [2, 3].map(id => metro.projectStation(id)),
          tick: state.tick, progress: train.progress, bounds: document.querySelector('#stage').getBoundingClientRect().toJSON(),
          canvas: metro.capture() };
        return { before, after, train: { id: train.id, from: train.from, to: train.to },
          queue: metro.mobileMapStats()?.queueGroups.find(p => p.stationId === 2)?.total ??
            metro.getState().stations.find(p => p.id === 2).queue.length,
          mobile: metro.mobileMapStats() !== null };
      });
      const { before, after } = result;
      // These are the exact native-resolution WebGL frames before/after the
      // route edit; page screenshots below also retain the surrounding UI.
      await Promise.all([['before', before.canvas], ['after', after.canvas]].map(([name, image]) =>
        writeFile(`${out}/${width}x${height}-${name}-canvas.png`, Buffer.from(image.split(',')[1], 'base64'))));
      const jump = Math.hypot(before.position.x - after.position.x, before.position.y - after.position.y);
      const stationShift = Math.max(...before.stations.map((p, i) =>
        Math.hypot(p.x - after.stations[i].x, p.y - after.stations[i].y)));
      console.log(`${width}x${height}: outbound same-tick jump ${jump.toFixed(3)}px; station shift ${stationShift.toFixed(3)}px; train ${JSON.stringify(result.train)}; progress ${after.progress.toFixed(4)}`);
      await page.screenshot({ path: `${out}/${width}x${height}-outbound.png` });
      assert.equal(result.mobile, width < 600);
      assert.equal(result.queue, 36, 'queue-induced warp fixture must be active');
      assert.deepEqual([result.train.from, result.train.to], [2, 3]);
      assert.equal(before.tick, after.tick, 'route edit does not advance the simulation tick');
      assert.equal(before.progress, after.progress);
      assert.ok(stationShift < .05, `camera/station shift masks comparison: ${stationShift}px`);
      assert.ok(jump < .5, `train jumps when the endpoint is removed: ${jump}px`);
      const returning = await page.evaluate(id => {
        const metro = window.metro;
        let state = metro.getState(), train = state.trains.find(t => t.id === id);
        for (let i = 0; i < 600 && train?.from !== 3; i++) {
          metro.step(1); state = metro.getState(); train = state.trains.find(t => t.id === id);
        }
        const current = () => { const r = document.querySelector(`[data-train-id="${id}"]`).getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
        const atEndpoint = current();
        if (train?.from !== 3 || train.to !== 2) throw Error('return did not begin');
        const samples = [];
        for (let i = 0; i < 8; i++) {
          metro.step(5); state = metro.getState(); train = state.trains.find(t => t.id === id);
          samples.push({ progress: train.progress, position: current(), canvas: metro.capture() });
        }
        metro.step(5);
        state = metro.getState(); train = state.trains.find(t => t.id === id);
        return { atEndpoint, current: current(), samples, train, canvas: metro.capture() };
      }, result.train.id);
      assert.ok(returning.train.from === 3 && returning.train.to === 2 && returning.train.progress > 0);
      await page.screenshot({ path: `${out}/${width}x${height}-returning.png` });
      await writeFile(`${out}/${width}x${height}-returning-canvas.png`,
        Buffer.from(returning.canvas.split(',')[1], 'base64'));
      const railPixels = await page.evaluate(async ({ before, after, returnCanvas, samples, outbound, returning, stage }) => {
        const decode = async src => {
          const image = new Image(); image.src = src; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(image, 0, 0);
          return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
        };
        const old = await decode(before), now = await decode(after), back = await decode(returnCanvas);
        const sampled = await Promise.all(samples.map(async sample =>
          ({ progress: sample.progress, position: sample.position, image: await decode(sample.canvas) })));
        const onRail = (p, image) => {
          let count = 0;
          const cx = p.x - stage.left, cy = p.y - stage.top;
          for (let y = Math.max(0, Math.floor(cy - 19)); y < Math.min(image.height, Math.ceil(cy + 19)); y++)
            for (let x = Math.max(0, Math.floor(cx - 19)); x < Math.min(image.width, Math.ceil(cx + 19)); x++) {
              if (Math.hypot(cx - x, cy - y) < 11) continue; // exclude train body and badge
              const i = (y * image.width + x) * 4;
              const [r, g, b] = image.data.slice(i, i + 3);
              if (r > 175 && r > g * 1.18 && r > b * 1.08 && g > 80 && b > 90) count++;
            }
          return count;
        };
        return { outbound: onRail(outbound, now), returning: onRail(returning, back),
          returnSamples: sampled.map(sample => ({ progress: sample.progress, pixels: onRail(sample.position, sample.image) })),
          before: onRail(outbound, old) };
      }, { before: before.canvas, after: after.canvas, returnCanvas: returning.canvas,
        samples: returning.samples, outbound: after.position,
        returning: returning.current, stage: after.bounds });
      console.log(`${width}x${height}: rail pixels beside outbound ${railPixels.before} → ${railPixels.outbound}; return ${railPixels.returning}; samples ${railPixels.returnSamples.map(s => `${s.progress.toFixed(2)}:${s.pixels}`).join(',')}`);
      assert.ok(railPixels.outbound > 0 && railPixels.returning > 0 &&
        railPixels.returnSamples.every(sample => sample.pixels > 0),
        `missing dashed rail alongside train: ${JSON.stringify(railPixels)}`);
      await writeFile(`${out}/${width}x${height}-metrics.json`, JSON.stringify({ jump, stationShift, railPixels, result: {
        mobile: result.mobile, queue: result.queue, train: result.train, progress: after.progress },
        returning: { train: returning.train, position: returning.current } }, null, 2));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
