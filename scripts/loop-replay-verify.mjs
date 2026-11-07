import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions({ ...process.env,
  METRO_BROWSER_EXECUTABLE_PATH: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? '/opt/hermes/tools/chromium-1208/chrome-linux64/chrome' }));
const drag = async (page, a, b) => {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 16 });
  await page.mouse.up();
};
const snapshot = page => page.evaluate(() => window.metro.getState());
const route = (page, stops, loop = false) => page.evaluate(({ stops, loop }) =>
  window.metro.submit({ action: { type: 'route', line: 0, stops, loop } }), { stops, loop });
const population = s => s.score + s.stations.reduce((n, p) => n + p.queue.length, 0) +
  s.trains.reduce((n, t) => n + t.passengers.length + Number(!!t.transfer), 0);
async function railPoint(page, edge) {
  return page.evaluate(async edge => {
    const { hitTestVisibleLane } = await import('/src/renderer.ts');
    const s = window.metro.getState(), p = s.stations.slice(0, 3);
    const q = p.map(x => window.metro.projectStation(x.id));
    const det = (p[1].x-p[0].x)*(p[2].y-p[0].y)-(p[2].x-p[0].x)*(p[1].y-p[0].y);
    const fit = axis => {
      const dx = ((q[1][axis]-q[0][axis])*(p[2].y-p[0].y)-(q[2][axis]-q[0][axis])*(p[1].y-p[0].y))/det;
      const dy = ((q[2][axis]-q[0][axis])*(p[1].x-p[0].x)-(q[1][axis]-q[0][axis])*(p[2].x-p[0].x))/det;
      return [dx, dy, q[0][axis]-dx*p[0].x-dy*p[0].y];
    };
    const fx = fit('x'), fy = fit('y'), stage = document.querySelector('#stage').getBoundingClientRect();
    const project = (x, y) => ({ x:fx[0]*x+fx[1]*y+fx[2]-stage.left,
      y:fy[0]*x+fy[1]*y+fy[2]-stage.top });
    const pair = edge === 1 ? [q[0], q[1]] : edge === 2 ? [q[1], q[2]] : [q[2], q[0]];
    const mid = { x:(pair[0].x+pair[1].x)/2, y:(pair[0].y+pair[1].y)/2 };
    for (let radius=0; radius<=90; radius+=3) for (let dx=-radius;dx<=radius;dx+=3)
      for (let dy=-radius;dy<=radius;dy+=3) {
        const x=mid.x+dx, y=mid.y+dy;
        if (hitTestVisibleLane(s,0,{x:x-stage.left,y:y-stage.top},project,5) === edge) return {x,y};
      }
    throw new Error(`visible edge ${edge} not found`);
  }, edge);
}
async function mobileRailPoint(page,edge) {
  return page.evaluate(async edge=>{
    const { MobileMapRenderer, geographicLayout } = await import('/src/mobile-map.ts');
    const renderer = Object.create(MobileMapRenderer.prototype);
    const s=window.metro.getState(), stats=window.metro.mobileMapStats(), stage=document.querySelector('#stage').getBoundingClientRect();
    Object.assign(renderer,{state:s,points:geographicLayout(s.stations),center:stats.center,zoom:stats.zoom,
      size:{width:stage.width,height:stage.height},routeCache:new Map(),recentLineKey:'',recentLineLayout:null,
      layoutKey:'',sourceYs:[...new Set(s.stations.map(p=>p.y))].sort((a,b)=>a-b),warpValues:[]});
    renderer.warpValues=renderer.sourceYs.map(y=>renderer.points.find(p=>p.sourceY===y)?.y??y*70);
    const a=s.stations[edge===3?2:edge-1],b=s.stations[edge===3?0:edge];
    const p=window.metro.projectStation(a.id),q=window.metro.projectStation(b.id);
    const mid={x:(p.x+q.x)/2,y:(p.y+q.y)/2};
    for(let radius=0;radius<90;radius+=4)for(let x=-radius;x<=radius;x+=4)for(let y=-radius;y<=radius;y+=4){
      const point={x:mid.x+x,y:mid.y+y};
      if(point.x<stage.left+28||point.x>stage.right-28||point.y<stage.top+28||point.y>stage.bottom-28)continue;
      if(renderer.hitTestLane(s,0,{x:point.x-stage.left,y:point.y-stage.top},4)===edge)return point;
    }
    throw new Error(`mobile rail edge ${edge} not visible`);
  },edge);
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  await page.evaluate(() => { window.metro.restart({ seed: 420, mode: 'creative' }); window.metro.pause(); });
  await page.waitForFunction(() => window.metro.getState().lines.every(line => !line.stops.length));
  assert.equal((await route(page, [1,2,3], true)).ok, true);
  // Insert one actual in-flight rider into the authoritative state to cover the
  // critical travel/transfer transition rather than only the idle-train case.
  await page.evaluate(() => {
    const state = window.metro.controller.session.state;
    const train = state.trains[0];
    train.from = 1; train.to = 2; train.progress = 0.1;
    train.passengers.push({ id: state.nextId++, shape: state.stations[2].shape, born: 0, transfers: 0 });
    state.totalSpawned++;
    for (const station of state.stations) station.nextPassenger = 1e8;
    state.nextStation = 1e8;
    window.metro.controller.onChange();
  });
  const stage = await page.locator('#stage').boundingBox();
  const grab = await railPoint(page, 1);
  const release = { x: stage.x + stage.width * .81, y: stage.y + stage.height * .77 };
  const before = await snapshot(page);
  assert.equal(population(before), before.totalSpawned);
  await drag(page, grab, release);
  const opened = await snapshot(page);
  assert.deepEqual(opened.lines[0], { id:0, stops:[2,3,1], loop:false }, 'in-flight internal edge opens');
  assert.equal(population(opened), opened.totalSpawned);
  assert.equal(opened.trains[0].to, 2, 'old hop completes before reroute');
  assert.equal(await page.locator('[data-loop-tip]').count(), 0);
  const firstHash = await windowHash(page);
  async function windowHash(p) { return p.evaluate(() => window.metro.hash()); }
  for (let i=0;i<14;i++) {
    await page.evaluate(() => window.metro.step(60));
    const s=await snapshot(page);
    assert.equal(population(s), s.totalSpawned, `passenger conservation at tick ${s.tick}`);
  }
  const final = await snapshot(page);
  assert.equal(final.score, 1, 'rider reaches destination after edge break');
  // This synthetic in-flight fixture is not replayable: its state was
  // injected directly; replay verification below uses public actions only.
  await page.evaluate(() => { window.metro.restart({ seed: 420, mode: 'creative' }); window.metro.pause(); });
  await page.waitForFunction(() => window.metro.getState().lines.every(line => !line.stops.length));
  assert.equal((await route(page, [1,2,3], true)).ok, true);
  await page.evaluate(() => window.metro.step(120));
  await page.waitForTimeout(160);
  const replayGrab = await railPoint(page,1);
  await drag(page,replayGrab,release);
  assert.deepEqual((await snapshot(page)).lines[0].stops,[2,3,1]);
  const reference = new Map();
  // Tick-0 route is included by seek(0), even though the initial checkpoint
  // captures the pre-decision state.
  reference.set(0, (await page.evaluate(() => window.metro.exportReplay())).decisions[0].afterHash);
  reference.set(120, await windowHash(page));
  for(let i=0;i<5;i++) {
    await page.evaluate(() => window.metro.step(53));
    const s=await snapshot(page);
    reference.set(s.tick, await windowHash(page));
  }
  const replay=await page.evaluate(() => window.metro.exportReplay());
  assert.ok(replay.decisions.some(d => d.action.type === 'route' && !d.action.loop && d.action.stops.join(',') === '2,3,1'));
  await page.evaluate(replay => window.metro.loadReplay(replay), replay);
  for (const tick of [...reference.keys()].reverse()) {
    const got = await page.evaluate(tick => { window.metro.seek(tick); return { tick:window.metro.getState().tick, hash:window.metro.hash() }; },tick);
    assert.equal(got.tick,tick);
    assert.equal(got.hash,reference.get(tick),`seek hash at ${tick}`);
  }
  const baseline = await page.evaluate(() => window.metro.hash());
  await page.evaluate(() => window.metro.seek(120));
  const atBreak = await snapshot(page);
  assert.deepEqual(atBreak.lines[0].stops,[2,3,1], 'same-tick break decision included in seek');
  await page.evaluate(() => window.metro.seek(0));
  assert.equal(await windowHash(page),baseline,'repeated seek is pure');
  // Extreme mode must reject the same valid-looking loop break both in the
  // pointer interaction and through the public action API.
  await page.evaluate(() => { window.metro.restart({ seed:420, mode:'extreme' }); window.metro.pause(); });
  await page.waitForFunction(() => window.metro.getState().mode === 'extreme');
  assert.equal((await route(page,[1,2,3],true)).ok,true);
  await page.waitForTimeout(160);
  const extremeRail=await railPoint(page,1);
  const extremeBefore=await windowHash(page);
  await drag(page,extremeRail,release);
  assert.equal(await windowHash(page),extremeBefore,'extreme pointer pull does not mutate state');
  assert.deepEqual((await snapshot(page)).lines[0],{ id:0, stops:[1,2,3], loop:true });
  const rejected=await route(page,[2,3,1],false);
  assert.equal(rejected.ok,false);
  assert.equal(await windowHash(page),extremeBefore,'extreme API route rejection is atomic');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ passed:true, inTransit:true, conservation:true, replaySeekHash:true,
    hashesChecked:reference.size, firstHash, finalScore:final.score }));
  await page.close();
  if (process.env.METRO_PROBE_CASE !== 'green') {
  const phone=await browser.newPage({ viewport:{width:390,height:844},hasTouch:true,isMobile:true });
  await phone.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});
  await phone.waitForFunction(()=>window.metro);
  await phone.evaluate(()=>{window.metro.restart({seed:420,mode:'creative'});window.metro.pause()});
  await phone.waitForFunction(()=>window.metro.getState().mode==='creative');
  for(let i=0;i<3;i++)await phone.locator('#zoom-out').click();
  const prep=await phone.locator('#stage').boundingBox();
  const touch=async(a,b)=>{
    const cdp=await phone.context().newCDPSession(phone);
    const send=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{id:1,x,y,radiusX:4,radiusY:4,force:1}]});
    await send('touchStart',a.x,a.y);
    for(let i=1;i<=14;i++)await send('touchMove',a.x+(b.x-a.x)*i/14,a.y+(b.y-a.y)*i/14);
    await send('touchEnd',b.x,b.y);await cdp.detach();
  };
  await touch({x:370,y:prep.y+prep.height*.55},{x:280,y:prep.y+prep.height*.55});
  assert.equal((await route(phone,[1,2,3],true)).ok,true);
  await phone.evaluate(()=>{
    const s=window.metro.controller.session.state;
    for(const station of s.stations)station.nextPassenger=1e8;
    const p=s.stations[0];
    for(let i=0;i<7;i++){p.queue.push({id:s.nextId++,shape:s.stations[2].shape,born:0,transfers:0});s.totalSpawned++;}
    window.metro.controller.onChange();
  });
  await phone.waitForFunction(()=>window.metro.mobileMapStats()?.visiblePositions.some(p=>p.id));
  const glyph=await phone.evaluate(()=>{
    const rect=document.querySelector('#stage').getBoundingClientRect();
    const target=window.metro.mobileMapStats().visiblePositions.at(-1);
    return {x:rect.left+target.x,y:rect.top+target.y,id:target.id};
  });
  const mobileStage=await phone.locator('#stage').boundingBox();
  const start=await mobileRailPoint(phone,1);
  const target={x:mobileStage.x+mobileStage.width*.83,y:mobileStage.y+mobileStage.height*.79};
  assert.ok(Math.hypot(start.x-glyph.x,start.y-glyph.y)>65,'unsafe glyph probe uses a long pull');
  const glyphTargets=await phone.evaluate(async ({x,y})=>{
    const { MobileMapRenderer, geographicLayout }=await import('/src/mobile-map.ts');
    const s=window.metro.getState(),stats=window.metro.mobileMapStats(),rect=document.querySelector('#stage').getBoundingClientRect();
    const renderer=Object.create(MobileMapRenderer.prototype);
    Object.assign(renderer,{state:s,points:geographicLayout(s.stations),center:stats.center,zoom:stats.zoom,
      size:{width:rect.width,height:rect.height},routeCache:new Map(),recentLineKey:'',recentLineLayout:null,
      layoutKey:'',sourceYs:[...new Set(s.stations.map(p=>p.y))].sort((a,b)=>a-b),warpValues:[]});
    renderer.warpValues=renderer.sourceYs.map(y=>renderer.points.find(p=>p.sourceY===y)?.y??y*70);
    return {stationDistances:s.stations.map(p=>Math.hypot(x-window.metro.projectStation(p.id).x,y-window.metro.projectStation(p.id).y)),
      rail:renderer.hitTestLane(s,0,{x:x-rect.left,y:y-rect.top},12)};
  },glyph);
  assert.ok(glyphTargets.stationDistances.every(d=>d>=30),'passenger glyph release is not within station hit zone');
  assert.equal(glyphTargets.rail,null,'passenger glyph release is not on track');
  await touch(start,target);
  assert.deepEqual((await snapshot(phone)).lines[0],{id:0,stops:[2,3,1],loop:false},
    'same busy loop can open at a distant blank target');
  assert.equal((await route(phone,[1,2,3],true)).ok,true);
  await phone.waitForTimeout(100);
  // Test first: releasing on an actual passenger silhouette must NOT open the loop.
  const beforeGlyph=await windowHash(phone);
  await touch(start,glyph);
  assert.deepEqual((await snapshot(phone)).lines[0],{id:0,stops:[1,2,3],loop:true},
    'passenger glyph is not safe blank space');
  assert.equal(await windowHash(phone),beforeGlyph,'release over passenger glyph must not break loop');
  console.log(JSON.stringify({mobile:true,unsafeGlyph:true,blankBreak:true}));
  await phone.close();
  }
} finally { await browser.close(); await server.close(); }
