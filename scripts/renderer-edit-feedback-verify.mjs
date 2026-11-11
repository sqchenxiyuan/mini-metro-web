import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

// Isolated real renderers: native WebGL pixels, no DOM renderer/GPU mocks.
const out = 'test-results/renderer-edit-feedback';
await mkdir(out, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const [width, height, reducedMotion] of [[390, 500, 'no-preference'], [568, 320, 'no-preference'], [1280, 800, 'no-preference'],
    [390, 500, 'reduce'], [568, 320, 'reduce'], [1280, 800, 'reduce']]) {
    const label = `${width}x${height}${reducedMotion === 'reduce' ? '-reduced' : ''}`;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1,
      isMobile: width < 600, hasTouch: width < 600 });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/visual-crowd-fixture.html`, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        const viewport = document.createElement('meta'); viewport.name = 'viewport';
        viewport.content = 'width=device-width,initial-scale=1'; document.head.append(viewport);
        document.body.style.margin = '0';
      });
      await page.waitForFunction(({ width }) => window.innerWidth === width, { width });
      const result = await page.evaluate(async ({ width, height }) => {
        const [{ MetroRenderer }, { Mobile3DRenderer }, rules] = await Promise.all([
          import('/src/renderer.ts'), import('/src/mobile-3d.ts'), import('/src/rules.ts')]);
        const state = rules.createState({ seed: 420, mode: 'creative' });
        const template = state.stations[0];
        state.stations = [[-3, -1], [0, -2], [3, -1], [0, .3], [-3, 2.5], [3, 2.5]].map(([x, y], i) =>
          ({ ...template, id: i + 1, x, y, shape: ['circle', 'triangle', 'square', 'diamond', 'star', 'cross'][i], queue: [] }));
        state.stations[1].queue = Array.from({ length: 11 }, (_, i) =>
          ({ id: 8000 + i, born: 0, transfers: 0, shape: i % 2 ? 'triangle' : 'square' }));
        state.lines = [{ id: 0, stops: [1, 2, 3], loop: false }, { id: 1, stops: [5, 6], loop: false }];
        state.trains = [{ id: 40, line: 0, from: 1, to: 2, progress: .45, direction: 1,
          dwell: 0, passengers: [{ id: 9001, born: 0, transfers: 0, shape: 'square' }], carriages: 0, retiring: false, moveTo: null }];
        const stage = document.createElement('div');
        Object.assign(stage.style, { position: 'absolute', inset: '0', width: `${width}px`, height: `${height}px`, background: '#fff8f5' });
        document.body.replaceChildren(stage);
        const mobile = width < 600;
        const renderer = mobile ? new Mobile3DRenderer(stage) : new MetroRenderer(stage);
        renderer.render(state);
        if (mobile) { renderer.setZoom(.8); renderer.centerAt(0, 0); }
        else renderer.setZoom(1.15);
        // Settle initial ResizeObserver without allowing it to repaint mid-capture.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const scene = mobile ? renderer.scene : renderer;
        const paint = () => renderer.render(state, 0);
        paint();
        const snapshot = () => {
          const canvas = document.createElement('canvas');
          canvas.width = renderer.canvas.width; canvas.height = renderer.canvas.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(renderer.canvas, 0, 0);
          return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
        };
        const diff = (a, b, box) => {
          let changed = 0;
          const r = box ?? { x: 0, y: 0, width: a.width, height: a.height };
          for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(a.height, Math.ceil(r.y + r.height)); y++)
            for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(a.width, Math.ceil(r.x + r.width)); x++) {
              const i = (y * a.width + x) * 4;
              if ([0, 1, 2, 3].some(c => a.data[i + c] !== b.data[i + c])) changed++;
            }
          return changed;
        };
        const curves = group => group.children.filter(m => m.geometry.type === 'TubeGeometry').map(m =>
          Array.from({ length: 61 }, (_, i) => { const p = m.geometry.parameters.path.getPoint(i / 60); return [p.x, p.y, p.z]; }));
        const pose = () => { const train = scene.trains.get(40).group;
          return { position: train.position.toArray(), heading: train.rotation.y, visible: train.visible,
            passengers: train.children.filter(o => o.name === 'onboard-shape').map(o => o.userData.passengerId) }; };
        const frames = [], hashes = [];
        const save = name => { frames.push({ name, data: renderer.capture() }); hashes.push(rules.hash(state)); return snapshot(); };
        const originalHash = rules.hash(state), originalPose = pose();
        const before = save('before');
        const unrelatedAnchor = renderer.project(0, 2.5, .43);
        const unaffectedBox = { x: unrelatedAnchor.x - 24, y: unrelatedAnchor.y - 7, width: 48, height: 14 };
        renderer.showPreview(state, [1, 4, 3], 0); paint();
        const candidatePaths = curves(scene.preview);
        const preview = save('preview');
        const validPose = pose();
        const oldRail = scene.tracks.children.find(m => m.geometry.type === 'TubeGeometry' &&
          m.material.color.getHexString() !== 'fffaf6' && m.material.color.getHexString() !== 'dcb654');
        const dimmed = oldRail.material.color.getHexString() !== 'e98391';
        renderer.showPreview(state, [1, 4, 3], 0, false); paint();
        const invalid = save('invalid');
        renderer.clearPreview(); paint();
        const cleared = save('cleared');
        const previewEmpty = scene.preview.children.length === 0;
        // Committing a candidate uses exactly the same rounded canonical curves.
        state.lines[0].stops = [1, 4, 3]; paint();
        const committed = scene.tracks.children.filter(m => m.geometry.type === 'TubeGeometry' && m.material.color.getHexString() === 'e98391');
        const committedPaths = curves({ children: committed });
        const committedHash = rules.hash(state), ghostPose = pose();
        const ghostFrame = save('ghost-outbound');
        const marks = () => scene.tracks.children.filter(m => m.geometry.type === 'BoxGeometry');
        const markGeometry = marks().map(m => [m.position.x, m.position.y, m.position.z, m.rotation.y]);
        const ghostCount = marks().length;
        // Native ghost pixels must be visible, not merely surviving invisible meshes.
        const ghostRailPixels = () => {
          const image = snapshot();
          const train = renderer.projectTrain(40);
          let count = 0;
          for (const mark of marks()) {
            const p = scene.project(mark.position.x, mark.position.z, .31);
            if (train && Math.hypot(p.x - train.x, p.y - train.y) < 13) continue;
            for (let y = Math.max(0, Math.floor(p.y - 2)); y < Math.min(image.height, Math.ceil(p.y + 2)); y++)
              for (let x = Math.max(0, Math.floor(p.x - 2)); x < Math.min(image.width, Math.ceil(p.x + 2)); x++) {
                const i = (y * image.width + x) * 4, [r, g, b] = image.data.slice(i, i + 3);
                if (r > 175 && r > g * 1.18 && r > b * 1.08 && g > 80 && b > 90) count++;
              }
          }
          return count;
        };
        const outwardGhostPixels = ghostRailPixels();
        const ghostHashUnchanged = rules.hash(state) === committedHash;
        state.trains[0].from = 2; state.trains[0].to = 1; state.trains[0].progress = .55;
        const returnHash = rules.hash(state); paint();
        const returnPose = pose(), returnPixels = ghostRailPixels();
        save('ghost-return');
        const returnGeometry = marks().map(m => [m.position.x, m.position.y, m.position.z, m.rotation.y]);
        const returnHashUnchanged = rules.hash(state) === returnHash;
        state.trains[0].from = 1; state.trains[0].to = null; state.trains[0].progress = 0; paint();
        save('ghost-cleared');
        const remainingGhosts = marks().length;
        const orphanLaneGone = !scene.getPaintedTrackLayout().segments.some(e => e.from === 1 && e.to === 2 && e.lanes.some(l => l.lineId === 0));
        // Repeated invalid/clear and reset may not leave residual color, including reduced motion.
        renderer.showPreview(state, [1, 2, 3], 0, false); paint();
        state.tick = 100; paint(); state.tick = 0; paint();
        const seekRestored = scene.preview.children.length === 0;
        renderer.showPreview(state, [1, 2, 3], 0, false); paint();
        renderer.resetCamera(); paint();
        const resetRestored = scene.preview.children.length === 0;
        const stats = mobile ? renderer.mapStats() : null;
        const metrics = { mobile, native: { width: before.width, height: before.height }, originalHash,
          previewHashes: hashes.slice(0, 4), previewChanged: diff(before, preview), invalidChanged: diff(preview, invalid),
          clearChanged: diff(before, cleared), unrelatedChanged: diff(before, preview, unaffectedBox),
          dimmed, previewEmpty, originalPose, validPose, candidatePaths, committedPaths, ghostPose, returnPose,
          ghostCount, outwardGhostPixels, returnPixels, markGeometry, returnGeometry, remainingGhosts,
          ghostHashUnchanged, returnHashUnchanged, orphanLaneGone, seekRestored, resetRestored,
          groupedQueue: stats?.queueGroups.find(q => q.stationId === 2)?.total ?? state.stations[1].queue.length,
          ghostFrameChanged: diff(cleared, ghostFrame) };
        // Keep the native candidate frame in the page for the viewport capture.
        renderer.dispose(); stage.remove();
        const img = document.createElement('img'); img.src = frames.find(f => f.name === 'preview').data;
        Object.assign(img.style, { position: 'absolute', inset: '0', width: `${width}px`, height: `${height}px` });
        document.body.append(img); await img.decode();
        return { metrics, frames };
      }, { width, height });
      for (const frame of result.frames) await writeFile(`${out}/${label}-${frame.name}.png`, Buffer.from(frame.data.split(',')[1], 'base64'));
      await page.screenshot({ path: `${out}/${label}-native.png` });
      const m = result.metrics;
      await writeFile(`${out}/${label}-metrics.json`, JSON.stringify(m, null, 2));
      assert.deepEqual(m.native, { width, height });
      assert.ok(m.previewChanged > 20 && m.invalidChanged > 20, 'candidate must visibly replace old feedback');
      assert.equal(m.clearChanged, 0, 'cancel restores every native pixel');
      assert.equal(m.unrelatedChanged, 0, 'unrelated rail must not dim');
      assert.ok(m.dimmed && m.previewEmpty);
      assert.ok(m.previewHashes.every(h => h === m.originalHash));
      assert.deepEqual(m.originalPose, m.validPose, 'preview must not move/hide the train or its passenger');
      assert.deepEqual(m.candidatePaths, m.committedPaths, 'candidate geometry must match commit exactly');
      assert.deepEqual(m.originalPose, m.ghostPose, 'deletion retains exact original train position and heading');
      assert.ok(m.ghostPose.position.every((value, i) => Math.abs(value - m.returnPose.position[i]) < 1e-10),
        'return follows the same orphan lane');
      assert.ok(Math.abs(Math.abs(m.ghostPose.heading - m.returnPose.heading) - Math.PI) < 1e-8);
      assert.ok(m.ghostCount > 0 && m.outwardGhostPixels > 0 && m.returnPixels > 0, 'occupied ghosts must remain visible');
      assert.deepEqual(m.markGeometry, m.returnGeometry);
      assert.equal(m.remainingGhosts, 0, 'last train removes ghost immediately; no leftover fade');
      assert.ok(m.ghostHashUnchanged && m.returnHashUnchanged && m.orphanLaneGone);
      assert.ok(m.seekRestored && m.resetRestored);
      assert.equal(m.groupedQueue, 11);
      assert.deepEqual(errors, []);
      console.log(`${label}: preview Δ${m.previewChanged}px invalid Δ${m.invalidChanged}px cancel Δ${m.clearChanged}px unrelated Δ${m.unrelatedChanged}px; ghosts ${m.outwardGhostPixels}/${m.returnPixels}px → ${m.remainingGhosts}; hashes/pose/canonical paths preserved`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); await server.close(); }
