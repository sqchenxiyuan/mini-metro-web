import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const out = '/opt/data/cache/scratch/metro-map-first';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/';
const errors = [];
const geometry = () => {
  const rect = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom } : null; };
  return { stage:rect('#stage'), alert:rect('#mobile-crowd-alert'), score:rect('.score-block'), footer:rect('.transport-bar'),
    document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight], viewport:[innerWidth,innerHeight], zoom:window.metro.mobileMapStats().zoom,
    stations:[1,2].map(id=>window.metro.projectStation(id)), controls:['#map-first-toggle','#new-game','#tools-toggle','#replay-toggle','#help','#line-tools-toggle','#play-pause','[data-speed="1"]','[data-speed="2"]','[data-speed="4"]','#zoom-in','#zoom-out','#zoom-reset','#screenshot'].map(sel=>({sel,...rect(sel)})) };
};
const overlap = (a,b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
async function assertPeekClear(page, stationId, source, focused = true) {
  const actual = await page.evaluate(id => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
    const stage = rect('#stage');
    const queues = window.metro.sceneCues().bounds.filter(c => c.kind === 'queue' && c.id === id).map(c => ({x:stage.x+c.x,y:stage.y+c.y,right:stage.x+c.x+c.width,bottom:stage.y+c.y+c.height}));
    const stats=window.metro.mobileMapStats();
    const ownerIds=new Set(window.metro.getState().stations.find(s=>s.id===id).queue.map(p=>p.id));
    const glyphs=stats.visiblePositions.map(p=>({id:p.id,x:stage.x+p.x,y:stage.y+p.y,radius:6*stats.zoom}));
    const cues=[...document.querySelectorAll('.mobile-owner-cue')].map(e=>({text:e.textContent,rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,right:e.getBoundingClientRect().right,bottom:e.getBoundingClientRect().bottom}}));
    const target=rect(`[data-station="${id}"]`);
    return {peek:rect('#station-peek'),stage,station:window.metro.projectStation(id),target,queues,zoom:stats.zoom,
      painted:stats.visibleDrawnPassengerIds.length,ownerGlyphs:glyphs.filter(g=>ownerIds.has(g.id)).length,
      glyphs,cues,viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],
      barriers:['.topbar','.left-panel','#line-tools-toggle','#mobile-crowd-alert','.transport-bar'].filter(s => { const e=document.querySelector(s); return e && e.getClientRects().length; }).map(s => ({selector:s,rect:rect(s)}))};
  }, stationId);
  const {peek,stage,station,target,queues,glyphs,cues,barriers}=actual;
  assert.ok(peek.width>0 && peek.height>0,`${source}: peek displayed`);
  // A detail card and optional 44px owner-cue row consume real space above the map.
  // Assert drawable geometry and content, not a fixed fraction of phone height.
  assert.ok(stage.width>=280 && stage.height>=200,`${source}: drawable map ${stage.width}x${stage.height}`);
  assert.ok(actual.zoom>=.95,`${source}: silhouettes remain legible at zoom ${actual.zoom}`);
  assert.deepEqual(actual.document,actual.viewport,`${source}: no document overflow`);
  assert.ok(!overlap(peek,stage),`${source}: peek ${JSON.stringify(peek)} obscures map ${JSON.stringify(stage)}`);
  if (focused) {
    assert.ok(station.x>=stage.x+20 && station.x<=stage.right-20 && station.y>=stage.y+20 && station.y<=stage.bottom-20,`${source}: focused station ${JSON.stringify(station)} must remain in map ${JSON.stringify(stage)}`);
    assert.ok(target && target.x>=stage.x && target.right<=stage.right && target.y>=stage.y && target.bottom<=stage.bottom,`${source}: entire selected station hit target in drawable map ${JSON.stringify(target)}`);
    assert.ok(actual.ownerGlyphs>0,`${source}: selected station's actual passengers visible`);
    assert.ok(!overlap(peek,{x:station.x-20,y:station.y-20,right:station.x+20,bottom:station.y+20}),`${source}: selected station hidden by card`);
  }
  assert.equal(actual.painted,glyphs.length,`${source}: passenger draw accounting`);
  for(const {id,x,y,radius} of glyphs) {
    const visible={x:Math.max(stage.x,x-radius),y:Math.max(stage.y,y-radius),right:Math.min(stage.right,x+radius),bottom:Math.min(stage.bottom,y+radius)};
    assert.ok(visible.x<visible.right && visible.y<visible.bottom,`${source}: painted glyph ${id} misses drawable canvas`);
    assert.ok(!overlap(peek,visible),`${source}: visible glyph ${id} hidden by detail`);
  }
  for(const {text,rect} of cues) {
    assert.ok(!overlap(rect,stage) && !overlap(rect,peek),`${source}: owner cue ${text} covers map or detail`);
    for(const {id,x,y,radius} of glyphs) assert.ok(!overlap(rect,{x:x-radius,y:y-radius,right:x+radius,bottom:y+radius}),`${source}: owner cue ${text} hides glyph ${id}`);
  }
  for(const queue of queues){const visible={x:Math.max(queue.x,stage.x),y:Math.max(queue.y,stage.y),right:Math.min(queue.right,stage.right),bottom:Math.min(queue.bottom,stage.bottom)};if(visible.x<visible.right && visible.y<visible.bottom)assert.ok(!overlap(peek,visible),`${source}: visible passenger queue hidden by card`);}
  for(const {selector,rect} of barriers)assert.ok(!overlap(peek,rect),`${source}: peek intersects ${selector}`);
  const {glyphs: _checkedGlyphs, ...summary}=actual;
  return summary;
}
try {
  const page = await browser.newPage({ viewport:{width:320,height:480}, deviceScaleFactor:1, isMobile:true, hasTouch:true });
  page.on('pageerror', e=>errors.push(String(e)));
  await page.goto(url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.metro?.mobileMapStats());
  const hash = await page.evaluate(()=>window.metro.hash());
  assert.equal(await page.locator('#map-first-toggle').getAttribute('aria-pressed'),'true','short phone initially opens map-first');
  await page.waitForFunction(()=>{const r=document.querySelector('#stage').getBoundingClientRect();const p=window.metro.projectStation(2);return p.y>=r.y+20 && p.y<=r.bottom-20;});
  let opening = await page.evaluate(geometry);
  assert.ok(opening.stage.height >= 330,`opening stage ${opening.stage.height}`);
  assert.equal(opening.zoom,.55,`opening narrow-phone zoom ${opening.zoom}`);
  assert.ok(opening.stations.every(p=>p.x >= opening.stage.x+20 && p.x <= opening.stage.right-20 && p.y >= opening.stage.y+20 && p.y <= opening.stage.bottom-20),`opening stations ${JSON.stringify(opening.stations)} stage ${JSON.stringify(opening.stage)} viewport ${JSON.stringify(opening.viewport)}`);
  assert.equal(await page.locator('#map-overview').count(),0,'no permanent minimap obscures opening station hit targets');
  assert.deepEqual(opening.document,opening.viewport,'no document overflow');
  assert.equal(await page.evaluate(()=>window.metro.hash()),hash,'layout toggle cannot change simulation');
  await page.screenshot({path:`${out}/320x480-opening-map-first.png`});
  const [a,b]=opening.stations;
  const cdp=await page.context().newCDPSession(page);
  const touch=async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1,radiusX:5,radiusY:5,force:1}]});
  await touch('touchStart',b.x,b.y);
  for(let i=1;i<=12;i++){await touch('touchMove',b.x+(a.x-b.x)*i/12,b.y+(a.y-b.y)*i/12);await page.waitForTimeout(20);}
  await touch('touchEnd',a.x,a.y);
  assert.deepEqual(await page.evaluate(()=>window.metro.getState().lines[0].stops),[2,1],'one real touch gesture draws opening route');
  await page.screenshot({path:`${out}/320x480-route-map-first.png`});
  await page.locator('#map-first-toggle').evaluate(el=>el.blur());await page.keyboard.press('m');
  assert.equal(await page.locator('#map-first-toggle').getAttribute('aria-pressed'),'false','keyboard shortcut closes mode');
  let normal = await page.evaluate(geometry);
  assert.equal(normal.zoom,.55,'normal 320x480 camera zoom restored');
  assert.ok(normal.stage.height < 300,`normal layout remains available: ${normal.stage.height}px`);
  await page.setViewportSize({width:320,height:500});
  assert.equal(await page.locator('#map-first-toggle').getAttribute('aria-pressed'),'false','same short-phone breakpoint retains explicit normal choice');
  await page.setViewportSize({width:320,height:480});
  assert.equal(await page.locator('#map-first-toggle').getAttribute('aria-pressed'),'false','returning within same breakpoint retains explicit normal choice');
  await page.screenshot({path:`${out}/320x480-normal-option.png`});
  await page.keyboard.press('m');
  assert.equal(await page.locator('#map-first-toggle').getAttribute('aria-pressed'),'true','keyboard shortcut opens mode');
  await page.evaluate(()=>{const m=window.metro;m.restart({mode:'endless',seed:420});m.pause();for(let i=0;i<9;i++){let s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200)}let s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});});
  await page.waitForTimeout(150);
  let late = await page.evaluate(geometry);
  assert.ok((await page.evaluate(()=>window.metro.getState().stations[0].queue.length))>100,'dense real state');
  assert.ok(late.stage.height >= 300,`late stage ${late.stage.height}`);
  assert.equal(late.zoom,.55,`late narrow-phone frame zoom ${late.zoom}`);
  assert.equal(await page.locator('#mobile-crowd-alert').isVisible(),true,'crowd alert remains reachable');
  assert.ok(!overlap(late.alert,late.stage) && !overlap(late.alert,late.score),'warning is outside map and score');
  assert.deepEqual(late.document,late.viewport,'no overflow late');
  assert.deepEqual(late.viewport,[320,480],`viewport must remain native; overflow=${JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('body *')].map(e=>({id:e.id,cls:String(e.className).slice(0,45),r:e.getBoundingClientRect()})).filter(v=>v.r.width&&v.r.height&&(v.r.right>321||v.r.bottom>481)).slice(0,20).map(v=>[v.id,v.cls,v.r.x,v.r.y,v.r.width,v.r.height])))}`);
  assert.ok(late.alert.bottom<=480 && late.alert.right<=320,'alert visible within device viewport');
  for(const c of late.controls.filter(c=>!['#tools-toggle','#replay-toggle'].includes(c.sel))){assert.ok(c.width>=44 && c.height>=44,`${c.sel} touch target ${c.width}x${c.height}`);assert.ok(c.x>=0 && c.right<=320 && c.y>=0 && c.bottom<=480,`${c.sel} reachable ${JSON.stringify(c)}`);}
  assert.ok(late.controls.every(c=>!overlap(c,late.alert)),`alert intersects ${JSON.stringify(late.controls.filter(c=>overlap(c,late.alert)))}, ${JSON.stringify(late.alert)}`);
  await page.waitForTimeout(3700); // Let transient route toast clear for native visual evidence.
  await page.screenshot({path:`${out}/320x480-late-map-first.png`});
  const crowdedId=await page.evaluate(()=>window.metro.getState().stations.filter(s=>s.crowd>0).sort((a,b)=>b.crowd-a.crowd||a.id-b.id)[0].id);
  const beforeFocus=await page.evaluate(()=>window.metro.mobileMapStats().center);
  await page.locator('#mobile-crowd-alert').click();
  assert.equal(await page.locator('#station-peek').isVisible(),false,'ordinary crowd focus does not open legacy peek');
  assert.notDeepEqual(await page.evaluate(()=>window.metro.mobileMapStats().center),beforeFocus,'warning navigates camera');
  const crowdPoint=await page.evaluate(id=>({point:window.metro.projectStation(id),stage:document.querySelector('#stage').getBoundingClientRect().toJSON()}),crowdedId);
  assert.ok(crowdPoint.point.x>=crowdPoint.stage.left&&crowdPoint.point.x<=crowdPoint.stage.right&&crowdPoint.point.y>=crowdPoint.stage.top&&crowdPoint.point.y<=crowdPoint.stage.bottom,'warning centers most crowded station');
  assert.ok((await page.evaluate(()=>window.metro.mobileMapStats().zoom))>=1.35,'focused warning increases glyph size for inspection');
  await page.screenshot({path:`${out}/320x480-late-alert-focus.png`});
  await page.locator('#zoom-reset').click();
  assert.equal(await page.evaluate(()=>window.metro.mobileMapStats().zoom),.55,'reset restores narrow-phone frame');
  const tapPoint=await page.evaluate(id=>window.metro.projectStation(id),crowdedId);
  await page.touchscreen.tap(tapPoint.x,tapPoint.y);
  assert.equal(await page.locator('#station-peek').isVisible(),true,'ordinary station tap exposes station queue status');
  assert.match(await page.locator('#station-peek').innerText(),new RegExp(`车站 ${crowdedId} · 候车`),'station status identifies tapped station');
  const stationCanUpgrade=await page.evaluate(id=>{const s=window.metro.getState();return !s.stations.find(p=>p.id===id).interchange&&s.resources.interchanges>0;},crowdedId);
  assert.equal(await page.locator('#context-actions').isVisible(),stationCanUpgrade,'context actions reflect available station upgrade');
  await page.screenshot({path:`${out}/320x480-late-station-tap.png`});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#context-actions').isVisible(),false,'Escape closes context actions');
  const lineToolsHit=await page.evaluate(()=>{const r=document.querySelector('#line-tools-toggle').getBoundingClientRect(),e=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {target:e?.id,expected:'line-tools-toggle'};});
  assert.equal(lineToolsHit.target,lineToolsHit.expected,'line tools button must not be intercepted by queue browser');
  await page.locator('#line-tools-toggle').click();
  assert.ok(await page.locator('#add-train').isVisible());
  await page.locator('#line-tools-close').click();
  // The narrow-phone frame starts at its minimum .55 zoom. First enlarge,
  // then verify zoom-out actually reduces it rather than testing the clamp.
  await page.locator('#zoom-in').click();
  const beforeZoomOut=await page.evaluate(()=>window.metro.mobileMapStats().zoom);
  assert.ok(beforeZoomOut>.55,'zoom-in enlarges the narrow-phone map');
  await page.locator('#zoom-out').click();
  assert.ok((await page.evaluate(()=>window.metro.mobileMapStats().zoom))<beforeZoomOut);
  await page.locator('#zoom-reset').click();
  assert.equal(await page.evaluate(()=>window.metro.mobileMapStats().zoom),.55,'map-first reset restores narrow-phone frame');
  const hashBeforePan=await page.evaluate(()=>window.metro.hash());
  const panBefore=await page.evaluate(()=>window.metro.mobileMapStats().center);
  await page.locator('#stage').focus();await page.keyboard.press('ArrowDown');
  assert.notDeepEqual(await page.evaluate(()=>window.metro.mobileMapStats().center),panBefore,'map keyboard pan');
  assert.equal(await page.evaluate(()=>window.metro.hash()),hashBeforePan,'camera pan and zoom cannot change simulation');
  assert.equal(errors.length,0,`browser errors ${errors}`);
  await page.close();
  const tall=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
  await tall.goto(url,{waitUntil:'networkidle'});await tall.waitForFunction(()=>window.metro?.mobileMapStats());
  assert.equal(await tall.locator('#map-first-toggle').isVisible(),false,'390x844 keeps normal mode');
  assert.ok((await tall.evaluate(geometry)).stage.height>400);
  await tall.screenshot({path:`${out}/390x844-normal.png`});
  await tall.setViewportSize({width:320,height:480});
  await tall.waitForFunction(()=>document.querySelector('#map-first-toggle').getAttribute('aria-pressed')==='true');
  assert.equal(await tall.locator('#map-first-toggle').getAttribute('aria-pressed'),'true','crossing into short phone enables map-first');
  assert.ok((await tall.evaluate(geometry)).stage.height>=330,'crossing into short phone expands map');
  await tall.locator('#map-first-toggle').click();
  assert.equal(await tall.locator('#map-first-toggle').getAttribute('aria-pressed'),'false','manual normal choice on short phone');
  await tall.setViewportSize({width:390,height:844});
  assert.equal(await tall.locator('#map-first-toggle').getAttribute('aria-pressed'),'false','leaving short phone resets mode');
  await tall.setViewportSize({width:320,height:480});
  await tall.waitForFunction(()=>document.querySelector('#map-first-toggle').getAttribute('aria-pressed')==='true');
  assert.equal(await tall.locator('#map-first-toggle').getAttribute('aria-pressed'),'true','a fresh short-phone crossing defaults to map-first');
  await tall.close();
  const integration=await browser.newPage({viewport:{width:320,height:480},hasTouch:true});
  await integration.goto(new URL('/integration.html',url).href,{waitUntil:'networkidle'});
  await integration.waitForFunction(()=>window.metro?.mobileMapStats());
  assert.equal(await integration.locator('#map-first-toggle').getAttribute('aria-pressed'),'true','integration page defaults to map-first on short phone');
  assert.ok((await integration.evaluate(geometry)).stage.height>=330,'integration entry mode');
  await integration.locator('#map-first-toggle').click();
  assert.equal(await integration.locator('#map-first-toggle').getAttribute('aria-pressed'),'false','integration normal option remains usable');
  assert.ok((await integration.evaluate(geometry)).zoom<.8,'integration normal camera restored');
  await integration.locator('#tools-toggle').click();
  assert.ok(await integration.locator('#agent-toggle').isVisible(),'agent controls retained');
  await integration.close();
  console.log(JSON.stringify({ok:true,opening,late,crowdedId,crowdPoint,errors,screenshots:out},null,2));
} finally {await browser.close();}
