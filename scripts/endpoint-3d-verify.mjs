import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

// Given existing 3D rails, when handles are supplied in CSS pixels, then the
// native canvas paints a shaded physical T at that location without state edits.
const out = process.env.METRO_ENDPOINT_OUTPUT ?? '/opt/data/cache/scratch/endpoint-3d';
await mkdir(out, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const [width, height] of [[1024, 768], [390, 500], [568, 320]]) {
    const label = `${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1,
      isMobile: width < 600, hasTouch: width < 600 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${server.resolvedUrls.local[0]}scripts/visual-crowd-fixture.html`, { waitUntil: 'networkidle' });
    const result = await page.evaluate(async ({ width, height }) => {
      document.head.insertAdjacentHTML('beforeend', '<meta name="viewport" content="width=device-width,initial-scale=1">');
      const [{ MetroRenderer }, { Mobile3DRenderer }, rules] = await Promise.all([
        import('/src/renderer.ts'), import('/src/mobile-3d.ts'), import('/src/rules.ts')]);
      Object.assign(document.body.style, { margin: '0', background: '#fff8f5' });
      const stage = document.createElement('div');
      Object.assign(stage.style, { width: `${width}px`, height: `${height}px`, position: 'relative' });
      document.body.replaceChildren(stage);
      const state = rules.createState({ mode: 'creative', seed: 77 });
      state.lines[0].stops = [1, 2];
      const r = width < 600 ? new Mobile3DRenderer(stage) : new MetroRenderer(stage);
      r.render(state);
      if (width < 600) { r.setZoom(.8); r.centerAt(0, 0); }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      r.render(state);
      const snapshot = () => {
        const c = document.createElement('canvas'); c.width = r.canvas.width; c.height = r.canvas.height;
        const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(r.canvas, 0, 0);
        return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
      };
      const frames = [];
      const save = name => { frames.push({ name, data: r.capture() }); return snapshot(); };
      const owner = { x: width / 2 - 80, y: height / 2 };
      const descriptor = { key: '0-end', line: 0, x: width / 2, y: height / 2, owner };
      const hashBefore = rules.hash(state);
      const before = save('before');
      const available = typeof r.setEndpointHandles === 'function';
      if (!available) { r.dispose(); return { available, frames }; }
      const changed = r.setEndpointHandles([descriptor]);
      const after = save('after');
      const sample = (image, x, y) => {
        const i = (Math.round(y) * image.width + Math.round(x)) * 4;
        return Array.from(image.data.slice(i, i + 4));
      };
      const changedPoints = [];
      for (let y = descriptor.y - 22; y <= descriptor.y + 22; y++)
        for (let x = descriptor.x - 22; x <= descriptor.x + 22; x++) {
          const a = sample(before, x, y), b = sample(after, x, y);
          if (a.some((v, i) => v !== b[i])) changedPoints.push({ x, y, color: b });
        }
      const colors = new Set(changedPoints.filter(p => p.color[3] === 255).map(p => p.color.slice(0, 3).join(',')));
      const coloredBounds = image => {
        const points = [];
        for (let y = descriptor.y - 18; y <= descriptor.y + 18; y++)
          for (let x = descriptor.x - 18; x <= descriptor.x + 18; x++) {
            const c = sample(image, x, y);
            if (c[0] - c[1] > 35 && c[0] - c[2] > 25) points.push([x, y]);
          }
        return [Math.min(...points.map(p => p[0])), Math.max(...points.map(p => p[0])),
          Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[1]))];
      };
      // Interior samples avoid anti-aliasing and shadows: the near-facing
      // physical wall must remain opaque 5 CSS pixels below the T's roof.
      const roofPixel = sample(after, descriptor.x - 4, descriptor.y);
      const wallPixel = sample(after, descriptor.x - 4, descriptor.y + 5);
      const twiceChanged = r.setEndpointHandles([descriptor]);
      // Verify a same-descriptor repaint cannot leave a stale camera projection.
      r.pan(23, -12);
      r.setEndpointHandles([descriptor]);
      const panned = save('panned');
      const panCenter = sample(panned, descriptor.x, descriptor.y);
      const afterCenter = sample(after, descriptor.x, descriptor.y);
      r.setZoom(1.4);
      r.setEndpointHandles([descriptor]);
      const zoomed = save('zoomed');
      const capBounds = coloredBounds(after), zoomBounds = coloredBounds(zoomed);
      const beforeClear = rules.hash(state);
      // Loop cleanup must remove real canvas geometry, not only DOM markers.
      state.lines[0].stops = [1, 2, 3]; state.lines[0].loop = true;
      r.render(state);
      const loopPaint = snapshot();
      r.setEndpointHandles([]); r.render(state);
      const loopClean = snapshot();
      const loopDiff = loopPaint.data.reduce((n, v, i) => n + Number(v !== loopClean.data[i]), 0);
      state.lines[0].stops = [1, 2]; state.lines[0].loop = false;
      r.render(state); r.setEndpointHandles([descriptor]);
      r.setEndpointHandles([]);
      const cleared = save('cleared');
      r.render(state);
      const clean = snapshot();
      const clearDiff = cleared.data.reduce((n, v, i) => n + Number(v !== clean.data[i]), 0);
      const metrics = { available, changed, twiceChanged, changedPixels: changedPoints.length, solidColors: [...colors],
        extent: changedPoints.length ? [Math.min(...changedPoints.map(p => p.x)), Math.max(...changedPoints.map(p => p.x)),
          Math.min(...changedPoints.map(p => p.y)), Math.max(...changedPoints.map(p => p.y))] : [],
        afterCenter, panCenter, roofPixel, wallPixel, capBounds, zoomBounds,
        hashBefore, hashAfter: rules.hash(state), beforeClear, clearDiff, loopDiff,
        native: [before.width, before.height] };
      r.dispose();
      return { metrics, frames };
    }, { width, height });
    for (const frame of result.frames) await writeFile(`${out}/${label}-${frame.name}.png`, Buffer.from(frame.data.split(',')[1], 'base64'));
    assert.notEqual(result.available, false, 'real renderer needs public setEndpointHandles API');
    const m = result.metrics;
    await writeFile(`${out}/${label}-metrics.json`, JSON.stringify(m, null, 2));
    assert.equal(m.available, true);
    assert.equal(m.changed, true);
    assert.equal(m.twiceChanged, false, 'stable handles do not trigger duplicate rendering');
    assert.deepEqual(m.native, [width, height]);
    assert.ok(m.changedPixels > 100, 'a physical T must be visible in native canvas pixels');
    assert.ok(m.solidColors.length > 5, 'top, bevel and sides must receive actual scene lighting');
    assert.equal(m.afterCenter[3], 255, 'T stem crosses its mapped hitbox center');
    assert.ok(m.wallPixel[0] - m.wallPixel[1] > 35 && m.wallPixel[0] - m.wallPixel[2] > 25,
      'readable colored physical side wall extends beyond the thin roof (not pale ground/shadow)');
    assert.ok(m.roofPixel.slice(0, 3).some((v, i) => Math.abs(v - m.wallPixel[i]) > 12),
      'roof and near wall receive different directional scene lighting');
    assert.deepEqual(m.panCenter, m.afterCenter, 'camera pan synchronously remaps fixed CSS center');
    // Native edge coverage can change by one pixel under zoom (MSAA + shadow
    // texel quantization); the projected silhouette must not scale with zoom.
    assert.ok(m.zoomBounds.every((v, i) => Math.abs(v - m.capBounds[i]) <= 1),
      `CSS-sized cap survives zoom within one raster edge pixel: ${m.capBounds} → ${m.zoomBounds}`);
    assert.equal(m.hashBefore, m.hashAfter, 'render-only operations cannot mutate simulation');
    assert.equal(m.clearDiff, 0, 'removing descriptors removes every cap pixel immediately');
    assert.equal(m.loopDiff, 0, 'closing a loop removes every cap mesh before descriptor refresh');
    assert.deepEqual(errors, []);
    console.log(`${label}: ${m.changedPixels} cap pixels, ${m.solidColors.length} lit colors, center/pan/hash/cleanup verified`);
    await context.close();
  }
  // Playable-entry gate: actual visible caps, hidden SVG, keyed 44px native
  // controls, train-independent placement, camera, resize and loop lifecycle.
  for (const [width, height] of [[1024, 768], [390, 844], [568, 320]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1,
      isMobile: width < 600, hasTouch: width < 600 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    await page.evaluate(() => {
      metro.restart({ mode: 'creative', seed: 77 }); metro.pause();
      const result = metro.submit({ action: { type: 'route', line: 0, stops: [1, 2] } });
      if (!result.ok) throw Error(result.message);
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(180);
    const sample = () => {
      const stage = document.querySelector('#stage').getBoundingClientRect();
      const canvas = document.querySelector('#stage canvas');
      const image = document.createElement('canvas'); image.width = canvas.width; image.height = canvas.height;
      const ctx = image.getContext('2d', { willReadFrequently: true }); ctx.drawImage(canvas, 0, 0);
      const identities = window.__capButtons ??= new Map();
      const handles = [...document.querySelectorAll('[data-route-handle]')].map(node => {
        const key = node.getAttribute('data-route-handle');
        const center = { x: Number(node.getAttribute('cx')), y: Number(node.getAttribute('cy')) };
        const button = [...document.querySelectorAll('.endpoint-handle')].find(b => {
          const r = b.getBoundingClientRect();
          return Math.hypot(r.x + r.width / 2 - stage.x - center.x, r.y + r.height / 2 - stage.y - center.y) < .1;
        });
        if (!identities.has(key)) identities.set(key, button);
        const r = button.getBoundingClientRect();
        const pixel = ctx.getImageData(Math.round(center.x * canvas.width / stage.width),
          Math.round(center.y * canvas.height / stage.height), 1, 1).data;
        const meta = document.querySelector(`[data-endpoint-cap="${key}"]`);
        const link = document.querySelector(`[data-handle-link="${key}"]`);
        return { key, center, sameButton: identities.get(key) === button, size: [r.width, r.height],
          contained: r.left >= stage.left && r.right <= stage.right && r.top >= stage.top && r.bottom <= stage.bottom,
          nativeTarget: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === button,
          pixel: [...pixel], svgHidden: getComputedStyle(meta).visibility === 'hidden',
          owner: [Number(link.getAttribute('x1')), Number(link.getAttribute('y1'))] };
      });
      return { hash: metro.hash(), tick: metro.getState().tick, handles,
        moving: metro.getState().trains.some(t => t.to !== null && t.progress > 0) };
    };
    const frames = [];
    for (let i = 0; i < 160; i++) {
      if (i) await page.evaluate(() => metro.step(1));
      frames.push(await page.evaluate(sample));
      if ([0, 26, 159].includes(i)) await page.screenshot({ path: `${out}/${width}x${height}-playable-${i}.png` });
    }
    const baseline = frames[0];
    assert.equal(baseline.handles.length, 2);
    assert.ok(frames.some(frame => frame.moving && frame.hash !== baseline.hash), 'real train motion is exercised');
    for (const frame of frames) {
      assert.deepEqual(frame.handles.map(h => h.key), baseline.handles.map(h => h.key));
      for (const h of frame.handles) {
        assert.deepEqual(h.center, baseline.handles.find(b => b.key === h.key).center, 'trains never move caps');
        assert.ok(h.sameButton && h.contained && h.nativeTarget && h.svgHidden);
        assert.deepEqual(h.size, [44, 44]);
        assert.ok(h.pixel[3] === 255 && h.pixel[0] - h.pixel[1] > 35 && h.pixel[0] - h.pixel[2] > 25,
          `mapped hitbox center must contain actual pink 3D cap pixels: ${JSON.stringify(h)}`);
      }
    }
    const hashBeforeCamera = await page.evaluate(() => metro.hash());
    await page.locator('#zoom-in').click();
    const zoomed = await page.evaluate(sample);
    assert.equal(zoomed.hash, hashBeforeCamera);
    assert.ok(zoomed.handles.some(h => {
      const old = baseline.handles.find(b => b.key === h.key);
      return Math.hypot(old.center.x - h.center.x, old.center.y - h.center.y) > 1;
    }), 'zoom reprojects handles');
    assert.ok(zoomed.handles.every(h => h.pixel[0] - h.pixel[1] > 35 && h.pixel[3] === 255));
    await page.screenshot({ path: `${out}/${width}x${height}-playable-zoomed.png` });
    await page.locator('#zoom-reset').click();
    const reset = await page.evaluate(sample);
    assert.equal(reset.hash, hashBeforeCamera);
    assert.equal(reset.handles.length, 2, 'camera reset preserves on-map endpoint controls');
    assert.ok(reset.handles.every(h => h.pixel[0] - h.pixel[1] > 35 && h.pixel[3] === 255),
      'camera reset immediately restores aligned 3D caps');
    for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }, { width, height }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const resized = await page.evaluate(sample);
      assert.equal(resized.hash, hashBeforeCamera, 'breakpoint/resize cannot edit the route');
      assert.equal(resized.handles.length, 2, 'no stale or missing caps through renderer replacement');
      assert.ok(resized.handles.every(h => h.contained && h.nativeTarget &&
        h.pixel[0] - h.pixel[1] > 35 && h.pixel[3] === 255), 'resized mesh remains aligned with real 44px target');
    }
    await page.evaluate(() => {
      const result = metro.submit({ action: { type: 'route', line: 0, stops: [1, 2, 3], loop: true } });
      if (!result.ok) throw Error(result.message);
    });
    assert.equal((await page.evaluate(sample)).handles.length, 0, 'loop retires both caps');
    await page.evaluate(() => { metro.restart({ mode: 'creative', seed: 77 }); metro.pause(); });
    assert.equal((await page.evaluate(sample)).handles.length, 0, 'restart does not retain stale caps');
    assert.deepEqual(errors, []);
    await writeFile(`${out}/${width}x${height}-playable-frames.json`, JSON.stringify(frames, null, 2));
    console.log(`${width}x${height} playable: all 160 native cap centers/keyed 44px controls stable; zoom/loop/restart verified`);
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
