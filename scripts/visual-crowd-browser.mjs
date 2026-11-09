import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { browserLaunchOptions } from './browser-launch.mjs';

const output = 'test-results/visual-crowd';
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 840 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/visual-crowd-fixture.html`, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const [{ MetroRenderer }, { createState, RULES, SHAPES }, { layoutSceneCues }] = await Promise.all([
      import('/src/renderer.ts'), import('/src/rules.ts'), import('/src/overlay-layout.ts')]);
    const stage = document.createElement('div');
    Object.assign(stage.style, { position: 'absolute', left: '0', top: '0', width: '1360px', height: '840px', background: '#fff8f5' });
    document.body.append(stage);
    const renderer = new MetroRenderer(stage);
    const state = createState({ mode: 'normal' });
    const station = state.stations[0];
    station.queue = [1, 2, 3, 4, 5, 6, 7, 8].map(id => ({ id, shape: 'triangle', born: 0, transfers: 0 }));

    const project = () => renderer.project(station.x, station.y, .6);
    const pixels = () => {
      const snap = document.createElement('canvas');
      snap.width = 1360; snap.height = 840;
      const ctx = snap.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(renderer.canvas, 0, 0);
      const anchor = project();
      const data = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
      return { center: data(anchor.x, anchor.y), low: data(anchor.x, anchor.y + 9), anchor };
    };
    const frames = [];
    const fingerprint = (() => {
      const clone=structuredClone(state);
      clone.stations[0].crowd=0;clone.stations[0].shape='circle';clone.stations[0].interchange=false;
      return JSON.stringify(clone);
    })();
    const baseline = JSON.stringify(state);
    for (const fraction of [0, .25, .5, 1, .25, 0]) {
      station.crowd = Math.round(fraction * RULES.crowdTicks);
      renderer.render(state);
      const anchor = project();
      const placements = layoutSceneCues(state.stations.map(p => ({ id:p.id, ...renderer.project(p.x,p.y), queue:p.queue.length,
        queueShapes:p.queue.map(q=>q.shape), crowd:p.crowd, selected:false })), {width:1360,height:840});
      renderer.updateSceneCues(state, placements);
      const fill = pixels();
      if ([0, .5, 1].includes(fraction)) {
        // The captured map contains the actual WebGL station and queue marks.
        const url = renderer.capture();
        frames.push({ screenshot: url, fraction, fill, ringCount: renderer.cueStats().ringCount,
          warningCount: renderer.cueStats().warningCount, queueCount: renderer.cueStats().queueCount,
          anchor, stateUnchanged: state.tick === 0 && (() => { const clone=structuredClone(state);clone.stations[0].crowd=0;return JSON.stringify(clone)===fingerprint; })() });
        continue;
      }
      frames.push({ fraction, fill, ringCount: renderer.cueStats().ringCount,
        warningCount: renderer.cueStats().warningCount, queueCount: renderer.cueStats().queueCount,
        anchor, stateUnchanged: state.tick === 0 && (() => { const clone=structuredClone(state);clone.stations[0].crowd=0;return JSON.stringify(clone)===fingerprint; })() });
    }
    const afterFrames=JSON.stringify(state);
    const matrix=[];
    const sheet=document.createElement('canvas');sheet.width=SHAPES.length*100;sheet.height=2*4*100;
    const sheetContext=sheet.getContext('2d');
    for (const [index,shape] of SHAPES.entries()) for (const interchange of [false,true]) {
      const sequence=[];
      station.shape=shape;station.interchange=interchange;
      for (const [step,fraction] of [0,.25,1,0].entries()) {
        station.crowd=Math.round(fraction*RULES.crowdTicks);
        renderer.render(state);
        const anchor=project(), source=document.createElement('canvas');source.width=1360;source.height=840;
        const context=source.getContext('2d',{willReadFrequently:true});context.drawImage(renderer.canvas,0,0);
        const pixel=(dx,dy)=>[...context.getImageData(Math.round(anchor.x+dx),Math.round(anchor.y+dy),1,1).data];
        const region=context.getImageData(Math.round(anchor.x-24),Math.round(anchor.y-24),48,48).data;
        let red=0;
        for(let i=0;i<region.length;i+=4) if(region[i]>region[i+1]*1.5 && region[i]>region[i+2]*1.35)red++;
        sequence.push({fraction,center:pixel(0,0),red});
        const col=index*100,row=(Number(interchange)*4+step)*100;
        sheetContext.drawImage(renderer.canvas,anchor.x-35,anchor.y-35,70,70,col+15,row+15,70,70);
      }
      matrix.push({shape,interchange,sequence});
    }
    return {frames,matrix,sheet:sheet.toDataURL('image/png'),fingerprint,baseline,afterFrames,
      stateWithoutCrowd:(()=>{const clone=structuredClone(state);clone.stations[0].crowd=0;clone.stations[0].shape='circle';clone.stations[0].interchange=false;return JSON.stringify(clone)})()};
  });
  assert.deepEqual(errors, []);
  assert.equal(result.baseline,result.afterFrames,'no crowd rendering mutation in full cycle');
  assert.ok(result.frames.every(frame => frame.ringCount === 0 && frame.warningCount === 0));
  assert.ok(result.frames.every(frame => frame.stateUnchanged));
  assert.notDeepEqual(result.frames[0].fill.low, result.frames[3].fill.low, 'full crowd changes lower station pixels');
  assert.deepEqual(result.frames[0].fill.low, result.frames[5].fill.low, 'recovery restores original station pixels');
  assert.ok(result.frames.every(frame => JSON.stringify(frame.fill.center) === JSON.stringify(result.frames[0].fill.center)),
    'central destination marker must remain visible through every crowd stage');
  for(const {shape,interchange,sequence} of result.matrix){
    // Sign is uppermost: preserve its projected silhouette, but a shape's centroid
    // may lie outside its sign (e.g. triangle/interchange), so compare all pixels.
    assert.ok(sequence[2].red>sequence[0].red,`${shape}/${interchange}: no red fill at full crowd`);
    assert.ok(sequence[1].red<sequence[2].red,`${shape}/${interchange}: fill did not rise bottom-up`);
    assert.equal(sequence[3].red,sequence[0].red,`${shape}/${interchange}: fill did not clear`);
  }
  assert.equal(result.stateWithoutCrowd,result.fingerprint,'rendering must not mutate authoritative state');
  assert.deepEqual(result.matrix.map(item=>item.shape).filter((shape,index,array)=>array.indexOf(shape)===index),
    ['circle','triangle','square','diamond','star','cross','pentagon','egg','gem','wedge']);
  await (await import('node:fs/promises')).writeFile(`${output}/all-shapes-crowd-matrix.png`,Buffer.from(result.sheet.split(',')[1],'base64'));
  for (const frame of result.frames.filter(frame => frame.screenshot)) {
    const name = `desktop-${Math.round(frame.fraction * 100)}.png`;
    const buffer = Buffer.from(frame.screenshot.split(',')[1], 'base64');
    await (await import('node:fs/promises')).writeFile(`${output}/${name}`, buffer);
  }
  await page.screenshot({ path: `${output}/desktop-recovered.png` });
  console.log(JSON.stringify({passed:true, frames:result.frames.map(({fraction,fill,ringCount})=>({fraction,center:fill.center,low:fill.low,ringCount})), errors,
    matrix:result.matrix.map(({shape,interchange,sequence})=>({shape,interchange,red:sequence.map(frame=>frame.red)})),
    screenshots:[`${output}/desktop-0.png`,`${output}/desktop-50.png`,`${output}/desktop-100.png`,`${output}/desktop-recovered.png`,`${output}/all-shapes-crowd-matrix.png`]}, null, 2));
  await page.close();
} finally {
  await browser.close();
  await server.close();
}
