import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './browser-launch.mjs';

const base = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:4175/integration.html';
const out = 'test-results/orphan-endpoint';
await mkdir(out, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const [width, height] of [[1280, 800], [390, 844], [568, 320]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.metro && document.querySelector('#stage canvas'));
      const result = await page.evaluate(() => {
        const metro = window.metro;
        metro.restart({ seed: 420, mode: 'creative' });
        const action = (stops) => metro.submit({ action: { type: 'route', line: 0, stops } });
        if (!action([1, 2, 3]).ok) throw Error('initial route rejected');
        let s = metro.getState(), train = s.trains[0];
        for (let i = 0; i < 600 && !(train.to === 3 && train.progress > 0.3 && train.progress < 0.75); i++) {
          metro.step(1); s = metro.getState(); train = s.trains[0];
        }
        if (!(train.to === 3 && train.progress > 0.3 && train.progress < 0.75)) throw Error('no mid-edge train');
        if (!action([1, 2]).ok) throw Error('endpoint removal rejected');
        return { id: train.id, outbound: { from: train.from, to: train.to, progress: train.progress },
          stage: document.querySelector('#stage').getBoundingClientRect().toJSON(),
          canvas: document.querySelector('#stage canvas').getBoundingClientRect().toJSON(),
          mobile: metro.mobileMapStats() !== null };
      });
      assert.deepEqual([result.outbound.from, result.outbound.to], [2, 3]);
      assert.equal(result.mobile, width < 600, `renderer mode mismatch in ${width}x${height}`);
      await page.screenshot({ path: `${out}/${width}x${height}-outbound.png` });
      const reversed = await page.evaluate(id => {
        const metro = window.metro;
        let s = metro.getState(), train = s.trains.find(t => t.id === id);
        for (let i = 0; i < 600 && train?.from !== 3; i++) {
          metro.step(1); s = metro.getState(); train = s.trains.find(t => t.id === id);
        }
        return { train, locomotives: s.resources.locomotives };
      }, result.id);
      assert.equal(reversed.train.from, 3);
      assert.equal(reversed.train.to, 2);
      assert.equal(reversed.train.progress, 0);
      assert.equal(reversed.locomotives, 23);
      await page.evaluate(() => window.metro.step(45));
      const returning = await page.evaluate(id => {
        const s = window.metro.getState(), train = s.trains.find(t => t.id === id);
        return { train, points: [2, 3].map(station => window.metro.projectStation(station)),
          canvas: window.metro.capture(), stage: document.querySelector('#stage').getBoundingClientRect().toJSON() };
      }, result.id);
      assert.equal(returning.train.from, 3);
      assert.equal(returning.train.to, 2);
      assert.ok(returning.train.progress > 0 && returning.train.progress < 1);
      await page.screenshot({ path: `${out}/${width}x${height}-returning.png` });
      const cleared = await page.evaluate(id => {
        const metro = window.metro;
        let s = metro.getState(), train = s.trains.find(t => t.id === id);
        for (let i = 0; i < 600 && train?.from !== 2; i++) {
          metro.step(1); s = metro.getState(); train = s.trains.find(t => t.id === id);
        }
        return { train, state: s, canvas: metro.capture() };
      }, result.id);
      assert.equal(cleared.train.from, 2);
      assert.equal(cleared.state.resources.locomotives, 23);
      await page.screenshot({ path: `${out}/${width}x${height}-cleared.png` });
      const pixels = await page.evaluate(async ({ before, after, points, stage }) => {
        const decode = async src => {
          const image = new Image(); image.src = src; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(image, 0, 0);
          return { pixels: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
        };
        const a = await decode(before), b = await decode(after);
        const pink = data => {
          let count = 0;
          const x1 = points[0].x - stage.left, y1 = points[0].y - stage.top;
          const x2 = points[1].x - stage.left, y2 = points[1].y - stage.top;
          for (let y = 0; y < data.height; y++) for (let x = 0; x < data.width; x++) {
            const progress = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) /
              ((x2 - x1) ** 2 + (y2 - y1) ** 2);
            if (progress < 0.25 || progress > 0.75 ||
                Math.hypot(x - x1 - progress * (x2 - x1), y - y1 - progress * (y2 - y1)) > 65) continue;
            const i = (y * data.width + x) * 4;
            const [r, g, blue] = data.pixels.slice(i, i + 3);
            if (r > 125 && r > g * 1.13 && r > blue * 1.05 && g > 60 && blue > 65) count++;
          }
          return count;
        };
        return { returning: pink(a), cleared: pink(b) };
      }, { before: returning.canvas, after: cleared.canvas, points: returning.points, stage: returning.stage });
      assert.ok(pixels.returning > pixels.cleared + 5,
        `ghost pink pixels missing in ${width}x${height}: ${JSON.stringify(pixels)}`);
      assert.deepEqual(errors, []);
      console.log(`${width}x${height}: outbound → removed endpoint → return → retained station; ghost pink pixels ${pixels.returning} → ${pixels.cleared}`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
