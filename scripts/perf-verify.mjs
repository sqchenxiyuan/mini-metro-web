// SPDX-License-Identifier: GPL-3.0-or-later
// Run: node scripts/perf-verify.mjs (prints one JSON object; does not modify the repo).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { build } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'metro-perf-'));
const outDir = join(temp, 'dist');
const frames = 120;
const warmupFrames = 30;
const viewport = { width: 1440, height: 900 };
let browser;
let server;

async function filesIn(dir) {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) result.push(...await filesIn(path));
    else if (item.isFile()) result.push(path);
  }
  return result;
}

async function bundledAssets() {
  const files = await filesIn(outDir);
  const assets = await Promise.all(files.map(async (path) => {
    const data = await readFile(path);
    return { path: relative(outDir, path).split(sep).join('/'), bytes: data.length,
      gzipBytes: gzipSync(data, { level: 9, mtime: 0 }).length };
  }));
  assets.sort((a, b) => a.path.localeCompare(b.path));
  const sum = (items, key) => items.reduce((n, item) => n + item[key], 0);
  const group = (items) => ({ bytes: sum(items, 'bytes'), gzipBytes: sum(items, 'gzipBytes') });
  return { assets, js: group(assets.filter((a) => a.path.endsWith('.js'))),
    css: group(assets.filter((a) => a.path.endsWith('.css'))), all: group(assets) };
}

// Intercept one emitted JS response in memory. This is the only way to access the
// private Three.WebGLRenderer.info without changing application source or dist.
function instrumentBundle(source) {
  const signature = /this\.renderer\.render\(this\.scene,this\.camera\)/g;
  const hits = [...source.matchAll(signature)].length;
  if (hits !== 1) throw new Error(`Expected exactly one MetroRenderer WebGL render call, got ${hits}`);
  return source.replace(signature, `(()=>{
    const __start = performance.now();
    this.renderer.render(this.scene,this.camera);
    const __end = performance.now();
    const __info = this.renderer.info;
    (window.__metroPerfRenders ??= []).push({
      ms: __end - __start,
      calls: __info.render.calls,
      triangles: __info.render.triangles,
      lines: __info.render.lines,
      points: __info.render.points,
      geometries: __info.memory.geometries,
      textures: __info.memory.textures
    });
  })()`);
}

async function managedBrowserPath() {
  // Respect an explicit override from the existing launch helper. Otherwise use
  // the matching Playwright-managed headless shell (not a system Chromium).
  if (process.env.METRO_BROWSER_EXECUTABLE_PATH) return process.env.METRO_BROWSER_EXECUTABLE_PATH;
  const chrome = chromium.executablePath();
  const shell = chrome.replace(/chromium-(\d+)\/chrome-linux64\/chrome$/, 'chromium_headless_shell-$1/chrome-headless-shell-linux64/chrome-headless-shell');
  if (existsSync(shell)) return shell;
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(tmpdir(), 'playwright-browsers')]
    .filter((cache) => cache && cache !== '0');
  for (const cache of new Set(caches)) {
    const match = chrome.match(/chromium-(\d+)\/chrome-linux64\/chrome$/);
    if (!match) continue;
    const candidate = join(cache, `chromium_headless_shell-${match[1]}`, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Matching Playwright-managed Chromium headless shell not found; run npx playwright install chromium');
}

async function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' };
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const path = resolve(outDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(outDir + sep) || !(await stat(path)).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store' });
      res.end(await readFile(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  return `http://127.0.0.1:${server.address().port}/`;
}

function summarize(values) {
  assert(values.length > 0, 'empty performance sample');
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: values.length, meanMs: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)),
    p50Ms: Number(at(0.5).toFixed(3)), p95Ms: Number(at(0.95).toFixed(3)),
    maxMs: Number(sorted.at(-1).toFixed(3)) };
}

async function fixture(page, kind) {
  return page.evaluate((kind) => {
    const metro = window.metro;
    if (!metro) throw new Error('window.metro unavailable');
    metro.restart({ seed: 420, city: 'orchard', mode: 'creative' });
    const act = (action) => {
      const result = metro.submit({ action, reason: 'deterministic performance fixture' }, 'perf');
      if (!result.ok) throw new Error(`${JSON.stringify(action)}: ${result.message}`);
    };
    if (kind === 'early') {
      const stations = metro.getState().stations;
      act({ type: 'route', line: 0, stops: stations.map((station) => station.id) });
    } else {
      const shapes = ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'pentagon', 'egg', 'gem', 'wedge'];
      // Fixed coordinate candidates. The rules, not synthetic state mutation,
      // accept/reject positions near rivers or existing stations.
      outer: for (let y = -9; y <= 9; y += 2.5) {
        for (let x = -15; x <= 15; x += 2.5) {
          const state = metro.getState();
          if (state.stations.length >= 32) break outer;
          metro.submit({ action: { type: 'station', x, y,
            shape: shapes[state.stations.length % shapes.length] }, reason: 'dense fixture' }, 'perf');
        }
      }
      const stations = metro.getState().stations;
      if (stations.length !== 32) throw new Error(`Dense fixture built ${stations.length} stations, expected 32`);
      // Adjacent stations per line ensure visible tracks and minimal crossing;
      // shared stops make an interconnected, occupied seven-line network.
      for (let line = 0; line < 7; line++) {
        const stops = stations.slice(line * 4, line * 4 + 8).map((station) => station.id);
        act({ type: 'route', line, stops });
      }
      while (metro.getState().trains.length < 24) {
        const state = metro.getState();
        act({ type: 'addTrain', line: state.trains.length % 7,
          station: state.lines[state.trains.length % 7].stops[0] });
      }
      for (const train of metro.getState().trains)
        act({ type: 'carriage', train: train.id, delta: 1 });
    }
    metro.pause(true);
    const s = metro.getState();
    return { seed: s.seed, city: s.city, mode: s.mode, paused: metro.controller.paused,
      tick: s.tick, stations: s.stations.length, routes: s.lines.filter((l) => l.stops.length).length,
      trains: s.trains.length, carriages: s.trains.reduce((n, t) => n + t.carriages, 0),
      trackSegments: s.lines.reduce((n, l) => n + Math.max(0, l.stops.length - 1) + Number(l.loop), 0),
      stateHash: metro.hash() };
  }, kind);
}

async function measure(page, kind) {
  const description = await fixture(page, kind);
  // Production app always invokes onChange from its own requestAnimationFrame.
  // The wrapper measures JS + DOM + Three render on the browser main thread.
  await page.evaluate(() => {
    if (window.__metroPerfRestore) window.__metroPerfRestore();
    const controller = window.metro.controller;
    const original = controller.onChange;
    window.__metroPerfRenders = [];
    window.__metroPerfFrames = [];
    window.__metroPerfIntervals = [];
    let previousStart;
    controller.onChange = (...args) => {
      const start = performance.now();
      window.__metroPerfIntervals.push(previousStart === undefined ? null : start - previousStart);
      previousStart = start;
      try { return original(...args); }
      finally { window.__metroPerfFrames.push(performance.now() - start); }
    };
    window.__metroPerfRestore = () => { controller.onChange = original; };
  });
  await page.waitForFunction((count) => window.__metroPerfFrames.length >= count,
    warmupFrames + frames, { timeout: 120000 });
  const samples = await page.evaluate(({ warmupFrames, frames }) => {
    window.__metroPerfRestore();
    const timings = window.__metroPerfFrames.slice(warmupFrames, warmupFrames + frames);
    const intervals = window.__metroPerfIntervals.slice(warmupFrames, warmupFrames + frames);
    const renders = window.__metroPerfRenders.slice(warmupFrames, warmupFrames + frames);
    return { timings, intervals, renders, totalFrames: window.__metroPerfFrames.length };
  }, { warmupFrames, frames });
  assert.equal(samples.timings.length, frames);
  assert.equal(samples.intervals.length, frames);
  assert.equal(samples.renders.length, frames, 'each frame must have exactly one WebGL render');
  const latest = samples.renders.at(-1);
  assert(latest.calls > 0 && latest.triangles > 0, 'WebGL draw metrics must be nonzero');
  return { fixture: description, frameInterval: summarize(samples.intervals),
    frameCallback: summarize(samples.timings),
    webglRender: summarize(samples.renders.map((render) => render.ms)),
    rendererInfo: { drawCalls: latest.calls, triangles: latest.triangles,
      vertices: latest.triangles * 3 + latest.lines * 2 + latest.points,
      lines: latest.lines, points: latest.points,
      geometries: latest.geometries, textures: latest.textures },
    rendererInfoMethod: 'WebGLRenderer.info.render; vertices are triangle indices*3 + line endpoints*2 + points (submitted vertices, not unique geometry vertices)' };
}

try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent',
    build: { outDir, emptyOutDir: true } });
  const bundle = await bundledAssets();
  const scripts = bundle.assets.filter((asset) => asset.path.endsWith('.js'));
  const candidates = await Promise.all(scripts.map(async (asset) => ({
    path: asset.path, source: await readFile(join(outDir, asset.path), 'utf8') })));
  const target = candidates.filter(({ source }) => source.includes('this.renderer.render(this.scene,this.camera)'));
  assert.equal(target.length, 1, 'expected one built renderer bundle');
  const modified = instrumentBundle(target[0].source);
  const url = await serve();
  browser = await chromium.launch({ ...browserLaunchOptions(), executablePath: await managedBrowserPath() });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route(`**/${target[0].path}`, (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: modified }));
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.metro && window.__metroPerfRenders?.length > 0, null, { timeout: 30000 });
  } catch (error) {
    console.error(JSON.stringify({ launchDiagnostics: { errors, url: page.url(),
      state: await page.evaluate(() => ({ metro: !!window.metro,
        renders: window.__metroPerfRenders?.length, content: document.body?.textContent?.slice(0, 200) })) } }));
    throw error;
  }
  const early = await measure(page, 'early');
  const dense = await measure(page, 'dense');
  assert.deepEqual(errors, [], 'browser page errors');
  console.log(JSON.stringify({ browser: `Chromium ${browser.version()}`, viewport, sampledFrames: frames,
    warmupFrames, bundle, scenes: { early, dense }, errors,
    measurement: 'Fresh Vite production build in a temporary directory; raw/gzip bytes of emitted files. Playwright Chromium with WebGL enabled; fixed paused seed-420 scenes. Browser performance.now samples 120 consecutive requestAnimationFrame intervals and application onChange callback (frame JS/DOM/Three), plus WebGLRenderer.render, after 30 warmup frames. Three renderer.info read after each draw through in-memory interception of the built JS response; bundle on disk unchanged.',
    limitations: 'Elapsed main-thread callback/render timings are CPU-submission proxies, not thread CPU accounting or GPU execution time. Three info counts submitted primitives including shadow passes; vertices are non-unique triangle/line/point submissions. Software WebGL, machine load, and viewport affect timing. Fixed paused scenes do not include simulation stepping, movement, or route rebuild spikes.' }));
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(temp, { recursive: true, force: true });
}
