import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const output = '/opt/data/cache/scratch/metro-owner-cue';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless:true,
  executablePath:process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader'] });
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/';
const results = [];
try {
  for (const {width,height,mapFirst} of [
    {width:320,height:480,mapFirst:true}, {width:320,height:480,mapFirst:false},
    {width:390,height:844,mapFirst:false},
  ]) {
    console.log(`checking ${width}x${height} mapFirst=${mapFirst}`);
    const page = await browser.newPage({viewport:{width,height},deviceScaleFactor:1,hasTouch:true,isMobile:true});
    const errors=[];
    page.on('pageerror', error=>errors.push(String(error)));
    await page.goto(url,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>window.metro?.mobileMapStats());
    const defaultMapFirst=await page.locator('#map-first-toggle').getAttribute('aria-pressed');
    if (width===320 && mapFirst) assert.equal(defaultMapFirst,'true','short phone starts map-first');
    const toggle=page.locator('#map-first-toggle');
    if ((await toggle.getAttribute('aria-pressed')==='true') !== mapFirst) await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'),String(mapFirst),'actual layout mode');
    await page.evaluate(()=>{
      const m=window.metro;m.restart({mode:'endless',seed:420});m.pause();
      for(let i=0;i<9;i++) {const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200);}
      const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});
    });
    const state = await page.evaluate(()=>({ids:window.metro.getState().stations.find(s=>s.id===1).queue.map(p=>p.id),hash:window.metro.hash()}));
    assert.equal(state.ids.length,122,'seed 420 dense pile fixture');
    // Position the owner using the real overview gesture, then drag the map upward.
    const point=await page.evaluate(()=>{
      const stats=window.metro.mobileMapStats(),p=stats.bounds.find(p=>p.id===1),r=document.querySelector('#map-overview').getBoundingClientRect();
      const left=Math.min(...stats.bounds.map(v=>v.x-40)),right=Math.max(...stats.bounds.map(v=>v.x+40));
      const top=Math.min(...stats.bounds.map(v=>v.y-24)),bottom=Math.max(...stats.bounds.map(v=>v.pile?v.pile.y+v.pile.height+12:v.y+42));
      const scale=Math.min((r.width-12)/(right-left),(r.height-12)/(bottom-top));
      return {x:(r.width-(right-left)*scale)/2+(p.x-left)*scale,y:(r.height-(bottom-top)*scale)/2+(p.y-top)*scale};
    });
    await page.locator('#map-overview').click({position:point});
    const seen=new Set();
    let checked=0;
    for(let step=0;step<12;step++) {
      const probe=await page.evaluate(()=>{
        const stage=document.querySelector('#stage').getBoundingClientRect(),stats=window.metro.mobileMapStats();
        const cues=[...document.querySelectorAll('.mobile-owner-cue')].map(el=>({text:el.textContent,rect:el.getBoundingClientRect().toJSON()}));
        const ids=new Set(window.metro.getState().stations.find(s=>s.id===1).queue.map(q=>q.id));
        const visible=stats.visiblePositions.filter(p=>ids.has(p.id));
        const radius=6*stats.zoom;
        const fullyVisible=stats.visiblePositions.filter(p=>p.x>=radius && p.x<=stage.width-radius && p.y>=radius && p.y<=stage.height-radius);
        const collisions=fullyVisible.flatMap(p=>cues.filter(c=>stage.left+p.x+radius>c.rect.left && stage.left+p.x-radius<c.rect.right && stage.top+p.y+radius>c.rect.top && stage.top+p.y-radius<c.rect.bottom).map(c=>({id:p.id,x:p.x,y:p.y,cue:c.text})));
        return {stage:stage.toJSON(),station:window.metro.projectStation(1),center:stats.center,cues,visible:visible.filter(p=>fullyVisible.includes(p)).map(p=>p.id),collisions,viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight]};
      });
      for(const id of probe.visible) seen.add(id);
      assert.deepEqual(probe.viewport,[width,height],'native device dimensions');
      assert.deepEqual(probe.document,probe.viewport,'no document overflow');
      if(probe.cues.some(c=>c.text.includes('↑1'))) {
        checked++;
        await page.screenshot({path:`${output}/${width}x${height}-${mapFirst?'map-first':'normal'}-pan-${step}.png`});
        assert.deepEqual(probe.collisions,[],`owner cue covers passenger glyph centers: ${JSON.stringify(probe)}`);
        const cue=probe.cues.find(c=>c.text.includes('↑1'));
        assert.ok(cue.rect.width>=44 && cue.rect.height>=44,'cue is a usable 44px touch target');
      }
      if(step===11)break;
      const r=probe.stage;
      const x=Math.min(r.right-30,Math.max(r.left+100,Math.round(r.left+r.width/2)));
      const low=Math.min(r.bottom-30,r.top+Math.max(95,r.height*.72));
      const high=Math.max(r.top+40,low-Math.min(100,r.height*.45));
      await page.mouse.move(x,low);await page.mouse.down();await page.mouse.move(x,high,{steps:4});await page.mouse.up();
    }
    assert.ok(checked>=1,`${width}x${height} ${mapFirst?'map-first':'normal'} exposed offscreen-owner cue`);
    assert.deepEqual(seen,new Set(state.ids),'all 122 actual passenger shapes become visible by panning');
    const button=page.locator('.mobile-owner-cue').filter({hasText:'↑1 候车↓'});
    // Restore a cue if the final pan moved past the entire pile.
    if(!await button.count()) await page.locator('#map-overview').click({position:point});
    for(let attempt=0;attempt<12 && !await button.count();attempt++) {
      const r=await page.locator('#stage').boundingBox();
      const p=await page.evaluate(()=>window.metro.projectStation(1));
      const x=r.x+r.width/2,above=p.y<r.y;
      const from=above?r.y+55:Math.min(r.y+r.height-35,r.y+130);
      const to=above?Math.min(r.y+r.height-30,from+110):r.y+45;
      await page.mouse.move(x,from);await page.mouse.down();
      await page.mouse.move(x,to,{steps:4});await page.mouse.up();
    }
    assert.ok(await button.count(),`owner cue exists before click ${JSON.stringify(await page.evaluate(()=>({cues:[...document.querySelectorAll('.mobile-owner-cue')].map(e=>e.textContent),stats:window.metro.mobileMapStats().center,station:window.metro.projectStation(1),stage:document.querySelector('#stage').getBoundingClientRect().toJSON()})))}`);
    const route=await page.evaluate(()=>window.metro.submit({action:{type:'route',line:0,stops:[1,2]}},'test-fixture'));
    assert.ok(route.ok,`parked train setup for cue: ${JSON.stringify(route)}`);
    state.hash=await page.evaluate(()=>window.metro.hash());
    // Read everything inside the same JS task as the click: no animation frame
    // or game-state update may silently repair stale DOM targets/overview.
    const immediate=await page.evaluate(()=>{
      const canvas=document.querySelector('#map-overview');
      const before=canvas.toDataURL();
      const cue=[...document.querySelectorAll('.mobile-owner-cue')].find(el=>el.textContent.includes('↑1 候车↓'));
      cue.click();
      const stage=document.querySelector('#stage').getBoundingClientRect();
      const station=window.metro.projectStation(1);
      const target=document.querySelector('[data-station="1"]');
      const train=document.querySelector('[data-train-id]');
      return {station,stage:stage.toJSON(),left:parseFloat(target.style.left),top:parseFloat(target.style.top),
        hidden:target.hidden,trainLeft:parseFloat(train.style.left),trainTop:parseFloat(train.style.top),
        trainHidden:train.hidden,overviewChanged:canvas.toDataURL()!==before};
    });
    assert.ok(immediate.station.y>=immediate.stage.top+20 && immediate.station.y<=immediate.stage.bottom-20,
      `cue centers owner synchronously: ${JSON.stringify(immediate)}`);
    assert.equal(immediate.hidden,false,'focused station target is immediately available');
    assert.ok(Math.abs(immediate.left+immediate.stage.left-immediate.station.x)<.01 &&
      Math.abs(immediate.top+immediate.stage.top-immediate.station.y)<.01,
    `cue synchronously reprojects station target: ${JSON.stringify(immediate)}`);
    assert.equal(immediate.trainHidden,false,'cue reveals focused parked train hit target');
    assert.ok(Math.abs(immediate.trainLeft+immediate.stage.left-immediate.station.x-47)<.01 &&
      Math.abs(immediate.trainTop+immediate.stage.top-immediate.station.y+42)<.01,
    `cue synchronously reprojects parked train target: ${JSON.stringify(immediate)}`);
    assert.equal(immediate.overviewChanged,true,'cue synchronously repaints overview viewport');
    const after=await page.evaluate(()=>({station:window.metro.projectStation(1),rect:document.querySelector('#stage').getBoundingClientRect().toJSON(),hash:window.metro.hash()}));
    assert.ok(after.station.y>=after.rect.top+20 && after.station.y<=after.rect.bottom-20,'click focuses actual owning station');
    assert.equal(after.hash,state.hash,'gestures/cue do not mutate game state');
    const stageBox=after.rect;
    const probeCenter=await page.evaluate(()=>window.metro.mobileMapStats().center);
    const x=stageBox.right-55, startY=stageBox.top+Math.min(120,stageBox.height-40), endY=stageBox.top+35;
    const target=await page.evaluate(([x,y])=>{const el=document.elementFromPoint(x,y);return {tag:el?.tagName,id:el?.id,cls:el?.className,stage:document.querySelector('#stage')?.getBoundingClientRect().toJSON()}},[x,startY]);
    assert.equal(target.cls,'mobile-geographic-canvas',`touch begins on map canvas: ${JSON.stringify(target)}`);
    const cdp=await page.context().newCDPSession(page);
    const send=async (type,y)=>cdp.send('Input.dispatchTouchEvent',{
      type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1,radiusX:5,radiusY:5,force:1}],
    });
    await send('touchStart',startY);
    for(let i=1;i<=6;i++) await send('touchMove',startY+(endY-startY)*i/6);
    await send('touchEnd',endY);
    const touched=await page.evaluate(()=>({center:window.metro.mobileMapStats().center,hash:window.metro.hash()}));
    assert.notDeepEqual(touched.center,probeCenter,'one real touch gesture pans the map');
    assert.equal(touched.hash,state.hash,'touch pan cannot mutate simulation');
    assert.deepEqual(errors,[],'browser console errors');
    results.push({width,height,mapFirst,checked,seen:seen.size,hash:after.hash});
    await page.close();
  }
  console.log(JSON.stringify({ok:true,results,screenshots:output},null,2));
} finally {await browser.close();}
