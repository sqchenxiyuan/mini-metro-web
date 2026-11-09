import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { browserLaunchOptions } from './browser-launch.mjs';

const browser = await chromium.launch(browserLaunchOptions());
const origin = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175';
const output = 'test-results/responsive-3d';
await mkdir(output, { recursive: true });
const errors = [];
const touch = async (page, path) => {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: path[0].x, y: path[0].y, id: 1 }] });
  for (const point of path.slice(1)) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  const last = path.at(-1);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: last.x, y: last.y, id: 1 }] });
  await session.detach();
};
try {
  for (const [width,height] of [[390,844],[320,480],[568,320]]) {
    const context = await browser.newContext({ viewport: {width,height}, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${width}: ${String(e)}`));
    await page.goto(`${origin}/`, {waitUntil:'networkidle'});
    await page.waitForFunction(() => window.metro && document.querySelector('#stage canvas'));
    const shape = await page.locator('#stage canvas').evaluate(c => ({webgl: Boolean(c.getContext('webgl2') || c.getContext('webgl')), width:c.width, height:c.height}));
    assert.equal(shape.webgl, true, `${width}x${height} narrow stage must use WebGL`);
    const stage = await page.locator('#stage').boundingBox();
    assert.ok(stage.height >= 130, `stage usable: ${stage.height}`);
    const hash = await page.evaluate(() => window.metro.hash());
    const points = await page.evaluate(() => [1,2].map(id => window.metro.projectStation(id)));
    assert.ok(points.every(p => p.x >= stage.x + 22 && p.x <= stage.x + stage.width - 22 && p.y >= stage.y + 22 && p.y <= stage.y + stage.height - 22), 'opening stations must be touchable');
    const hitRects=await page.locator('[data-station]').evaluateAll(nodes=>nodes.slice(0,2).map(n=>n.getBoundingClientRect().toJSON()));
    assert.ok(hitRects.every(r=>r.width>=44 && r.height>=44 && r.left>=stage.x && r.right<=stage.x+stage.width && r.top>=stage.y && r.bottom<=stage.y+stage.height),`44px targets must fit ${width}x${height}: ${JSON.stringify(hitRects)}`);
    await page.screenshot({path:`${output}/${width}x${height}-opening.png`});
    await touch(page, [points[0], ...Array.from({length:12},(_,i)=>({x: points[0].x+(points[1].x-points[0].x)*(i+1)/12,y:points[0].y+(points[1].y-points[0].y)*(i+1)/12}))]);
    await page.waitForFunction(() => window.metro.getState().lines.some(l => l.stops.join(',') === '1,2'));
    const route = await page.evaluate(() => window.metro.getState().lines.find(l => l.stops.join(',') === '1,2')?.stops);
    assert.deepEqual(route, [1,2]);
    await page.screenshot({path:`${output}/${width}x${height}-route.png`});
    const panning = await page.evaluate(() => window.metro.projectStation(1));
    await touch(page, [{x:stage.x+stage.width-35,y:stage.y+stage.height-35}, {x:stage.x+stage.width-68,y:stage.y+stage.height-70}]);
    const after = await page.evaluate(() => window.metro.projectStation(1));
    assert.ok(Math.hypot(after.x-panning.x,after.y-panning.y)>5, 'touch pan moves station projection');
    const targetAfterPan=await page.locator('[data-station="1"]').boundingBox();
    assert.ok(Math.abs(targetAfterPan.x+targetAfterPan.width/2-after.x)<1 && Math.abs(targetAfterPan.y+5-after.y)<1,`DOM hit target follows touch pan: ${JSON.stringify({targetAfterPan,after})}`);
    const beforeOverview = await page.evaluate(() => window.metro.mobileMapStats().center);
    await page.locator('#map-overview').click({position:{x:10,y:10}});
    const afterOverview = await page.evaluate(() => window.metro.mobileMapStats().center);
    assert.notDeepEqual(afterOverview,beforeOverview,'overview moves camera');
    const afterOverviewPoint=await page.evaluate(() => window.metro.projectStation(1));
    const targetAfterOverview=await page.locator('[data-station="1"]').boundingBox();
    assert.ok(Math.abs(targetAfterOverview.x+targetAfterOverview.width/2-afterOverviewPoint.x)<1 && Math.abs(targetAfterOverview.y+5-afterOverviewPoint.y)<1,'DOM hit target follows overview');
    assert.notEqual(hash, await page.evaluate(() => window.metro.hash()), 'route changes simulation state');
    await page.locator('#zoom-in').click();
    await page.waitForTimeout(80);
    assert.equal((await page.locator('#stage canvas').count()),1);
    const zoomBeforePinch=await page.evaluate(() => window.metro.mobileMapStats().zoom);
    const session=await page.context().newCDPSession(page);
    const mx=stage.x+stage.width/2,my=stage.y+stage.height/2;
    const tp=(id,x,y)=>({id,x,y,radiusX:1,radiusY:1,force:.5});
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[tp(1,mx-35,my)]});
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[tp(1,mx-35,my),tp(2,mx+35,my)]});
    for(let i=1;i<=5;i++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[tp(1,mx-35-i*5,my),tp(2,mx+35+i*5,my)]});
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await session.detach();
    const zoomAfterPinch=await page.evaluate(() => window.metro.mobileMapStats().zoom);
    assert.ok(zoomAfterPinch>zoomBeforePinch+.04,`pinch zoom ${zoomBeforePinch} -> ${zoomAfterPinch}`);
    await page.evaluate(() => {
      const game=window.metro, state=game.controller.session.state;
      game.pause();
      state.stations[0].queue=Array.from({length:11},(_,i)=>({id:900+i,shape:i<6?'triangle':'square',born:0,transfers:0}));
      game.controller.onChange();
    });
    const queue=await page.evaluate(() => window.metro.mobileMapStats().queueGroups[0]);
    assert.equal(queue.total,11);
    assert.deepEqual(queue.groups.map(g=>[g.shape,g.count]),[['triangle',6],['square',5]]);
    await page.evaluate(() => {
      const s=window.metro.controller.session.state;
      s.stations[0].crowd=40;
      window.metro.controller.onChange();
    });
    assert.equal(await page.locator('#mobile-crowd-alert').isVisible(),true);
    await page.locator('#mobile-crowd-alert').click();
    assert.ok(await page.evaluate(() => { const s=window.metro.mobileMapStats();return Math.abs(s.center.x-s.bounds.find(b=>b.id===1).x)<1; }),'crowd jump centers warning station');
    await page.locator('#queue-browser-toggle').click();
    await page.locator('[data-queue-station="1"]').click();
    assert.equal(await page.locator('#queue-focus-pile').isVisible(),true);
    await page.locator('#queue-focus-pile').click();
    assert.equal(await page.locator('#queue-browser').evaluate(el=>el.open),false);
    const focus=await page.evaluate(() => window.metro.mobileMapStats());
    assert.ok(Math.abs(focus.center.x-focus.bounds.find(b=>b.id===1).x)<150,'queue focus must center its owner');
    await page.screenshot({path:`${output}/${width}x${height}-queue.png`});
    // A ten-shape grouped pile extends well below its roof at fixed CSS-pixel
    // offsets, including after the owner cue reserves its own stage row.
    await page.locator('#map-overview').focus();
    await page.evaluate(() => {
      const station=window.metro.controller.session.state.stations[0];
      station.queue=Array.from({length:21},(_,i)=>({id:900+i,shape:['triangle','square','circle','diamond','star','cross','pentagon','egg','gem','wedge'][i%10],born:0,transfers:0}));
      window.metro.controller.onChange();
    });
    let offscreenOwner=false;
    for(let i=0;i<14;i++){
      const state=await page.evaluate(()=>{const s=window.metro.mobileMapStats(),p=window.metro.projectStation(1),r=document.querySelector('#stage').getBoundingClientRect();
        return {relativeY:p.y-r.y,groups:s.queueGroups.find(g=>g.stationId===1)?.groups,ownerCueIds:s.ownerCueIds,stageY:r.y};});
      // Reflow can reserve 44px for the cue row, shifting the stage after a
      // camera step. Require a roof well above the row and an actually
      // painted glyph, rather than multiplying CSS-pixel rows by map zoom.
      if(state.relativeY < -35 && state.groups?.some(g=>g.visible) && state.ownerCueIds.includes(1)){
        offscreenOwner=true;break;
      }
      await page.keyboard.press('ArrowDown');
    }
    assert.equal(offscreenOwner,true,'offscreen owner retains an onstage queue and cue');
    const painted=await page.evaluate(()=>{const s=window.metro.mobileMapStats(),p=window.metro.projectStation(1),r=document.querySelector('#stage').getBoundingClientRect();
      return {roof:p.y-r.y,stage:r.toJSON(),groups:s.queueGroups.find(g=>g.stationId===1)?.groups,ownerCueIds:s.ownerCueIds};});
    assert.ok(painted.roof < -18 && painted.groups?.some(g=>g.visible),`offscreen owner must retain painted queue: ${JSON.stringify(painted)}`);
    if (process.env.METRO_OWNER_TRACE) console.log(`owner condition ${width}x${height}: ${JSON.stringify(painted)}`);
    try {
      await page.waitForFunction(() => window.metro.mobileMapStats().ownerCueIds.includes(1) &&
        document.querySelector('.mobile-owner-cue')?.textContent?.includes('1 候车'),null,{timeout:4000});
    } catch (error) {
      const state=await page.evaluate(()=>({stage:document.querySelector('#stage').getBoundingClientRect().toJSON(),station:window.metro.projectStation(1),stats:window.metro.mobileMapStats()}));
      throw new Error(`offscreen owner cue did not stabilize at ${width}x${height}: ${JSON.stringify(state)}`,{cause:error});
    }
    const cue=page.locator('.mobile-owner-cue').filter({hasText:'1 候车'}).first();
    assert.equal(await cue.isVisible(),true);
    try { await cue.click({timeout:3500}); }
    catch(error) {
      const samples=[];
      for(let i=0;i<12;i++) {
        samples.push(await page.evaluate(()=>({time:performance.now(),stage:document.querySelector('#stage').getBoundingClientRect().toJSON(),station:window.metro.projectStation(1),ownerCueIds:window.metro.mobileMapStats().ownerCueIds,
          center:window.metro.mobileMapStats().center,zoom:window.metro.mobileMapStats().zoom,cue:[...document.querySelectorAll('.mobile-owner-cue')].map(n=>n.getBoundingClientRect().toJSON()),
          groups:window.metro.mobileMapStats().queueGroups.find(g=>g.stationId===1)?.groups})));
        await page.waitForTimeout(35);
      }
      throw new Error(`owner cue native click failed ${width}x${height}: ${JSON.stringify(samples)}`,{cause:error});
    }
    const owner=await page.evaluate(()=>window.metro.mobileMapStats());
    assert.ok(Math.abs(owner.center.x-owner.bounds.find(b=>b.id===1).x)<1,'owner cue centers station');
    if (width===390) {
      await page.evaluate(() => window.metro.pause());
      const beforeRotation=await page.evaluate(() => ({hash:window.metro.hash(),center:window.metro.mobileMapStats().center}));
      await page.setViewportSize({width:568,height:320});
      await page.waitForTimeout(120);
      assert.equal(await page.evaluate(() => window.metro.hash()),beforeRotation.hash,'rotation must not alter simulation');
      assert.deepEqual(await page.evaluate(() => window.metro.mobileMapStats().center),beforeRotation.center,'manual camera center must survive rotation');
      assert.equal((await page.locator('#stage canvas').evaluate(c=>Boolean(c.getContext('webgl2')))),true);
      await page.setViewportSize({width:390,height:844});
      await page.waitForTimeout(120);
      assert.equal(await page.evaluate(() => window.metro.hash()),beforeRotation.hash);
      assert.deepEqual(await page.evaluate(() => window.metro.mobileMapStats().center),beforeRotation.center,'manual camera center must return after rotation');
      await page.screenshot({path:`${output}/390x844-returned.png`});
      const beforeBreakpoint=await page.evaluate(() => ({center:window.metro.mobileMapStats().center,zoom:window.metro.mobileMapStats().zoom}));
      await page.setViewportSize({width:900,height:600});
      await page.waitForFunction(() => window.metro?.mobileMapStats()===null);
      assert.equal(await page.locator('#stage canvas').evaluate(c=>Boolean(c.getContext('webgl2'))),true);
      assert.equal(await page.evaluate(() => window.metro.mobileMapStats()),null,'desktop renderer restored');
      await page.setViewportSize({width:390,height:844});
      await page.waitForFunction(() => window.metro?.mobileMapStats()?.stationCount>=3);
      assert.equal(await page.locator('#stage canvas').evaluate(c=>Boolean(c.getContext('webgl2'))),true);
      assert.ok(await page.evaluate(() => window.metro.mobileMapStats()?.stationCount>=3),`mobile adapter restored: ${JSON.stringify(await page.evaluate(() => ({stats:window.metro.mobileMapStats(),canvases:[...document.querySelectorAll('#stage canvas')].map(c=>c.className),mobile:matchMedia('(max-width: 650px)').matches})))}`);
      assert.deepEqual(await page.evaluate(() => ({center:window.metro.mobileMapStats().center,zoom:window.metro.mobileMapStats().zoom})),beforeBreakpoint,'manual mobile camera survives desktop breakpoint');
      assert.equal(await page.evaluate(() => window.metro.hash()),beforeRotation.hash,'breakpoint roundtrip preserves game');
    }
    console.log(`${width}x${height}: WebGL, touch route, pan, zoom OK; screenshots ${output}/${width}x${height}-{opening,route}.png`);
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
