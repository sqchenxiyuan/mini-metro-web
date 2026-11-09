import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
const browser=await chromium.launch(browserLaunchOptions());
const intersect=(a,b)=>Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
const allFailures=[];
try {
 for(const [width,height] of [[320,480],[390,844],[568,320],[1024,768]]) {
  const page=await browser.newPage({viewport:{width,height},hasTouch:width<=650,isMobile:width<=650});page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);
  const result=await page.evaluate(()=>{const m=window.metro;m.restart({mode:'creative',seed:77});m.pause();
   const routes=[[1,2],[1,3],[2,1]];
   return routes.map((stops,line)=>({line,stops,...m.submit({action:{type:'route',line,stops}})}));});
  assert.ok(result.every(r=>r.ok),`shared-endpoint fixture must be valid: ${JSON.stringify(result)}`);
  await page.waitForTimeout(100);
  const samples=[];
  for(const phase of ['initial','context','zoom']) {
   if(phase==='context'){
    if(width<=650){await page.locator('#line-chooser').click();await page.locator('[data-line="0"]').click();}
    else await page.locator('[data-line="0"]').click();
   }
   if(phase==='zoom')await page.locator('#zoom-in').click();
   const sample=await page.evaluate(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
    const stage=rect(document.querySelector('#stage'));
    const handles=[...document.querySelectorAll('.endpoint-handle')].filter(e=>e.getClientRects().length).map(e=>({name:e.getAttribute('aria-label'),rect:rect(e),pressed:e.getAttribute('aria-pressed')}));
    const links=[...document.querySelectorAll('[data-handle-link]')].map(e=>e.getAttribute('data-handle-link'));
    const stations=[...document.querySelectorAll('[data-station]')].filter(e=>!e.hidden&&e.getClientRects().length).map(e=>({id:e.dataset.station,rect:rect(e)}));
    const queues=window.metro.sceneCues().bounds.filter(b=>b.kind==='queue').map(b=>({id:b.id,rect:{x:stage.x+b.x,y:stage.y+b.y,width:b.width,height:b.height}}));
    const trains=[...document.querySelectorAll('[data-train-id],[data-train-group]')].filter(e=>!e.hidden&&e.getClientRects().length).map(e=>({id:e.dataset.trainId||e.dataset.trainGroup,rect:rect(e)}));
    const controls=['#context-actions','#mobile-crowd-alert','#queue-browser-toggle'].map(s=>document.querySelector(s)).filter(e=>e&&!e.hidden&&e.getClientRects().length).map(e=>({name:e.id,rect:rect(e)}));
    const fallback=[...document.querySelectorAll('[role="group"][aria-label*="地图空间不足"] button')].map(e=>e.getAttribute('aria-label'));
    const lines=window.metro.getState().lines;
    const owners=handles.map(h=>{const m=h.name.match(/^(\d+)号线(起点|终点)/),line=lines[Number(m?.[1])-1],id=m?.[2]==='起点'?line?.stops[0]:line?.stops.at(-1),p=window.metro.projectStation(id);return {name:h.name,distance:Math.hypot(p.x-(h.rect.x+h.rect.width/2),p.y-(h.rect.y+h.rect.height/2))}});
    return {stage,handles,links,stations,queues,trains,controls,fallback,owners,hash:window.metro.hash()};
   });
   const collisions=[];
   for(const h of sample.handles){
    const r=h.rect,s=sample.stage;
    if(r.width<44||r.height<44||r.x<s.x||r.y<s.y||r.x+r.width>s.x+s.width||r.y+r.height>s.y+s.height)collisions.push([h.name,'out-of-stage']);
    for(const station of sample.stations)if(intersect(r,station.rect))collisions.push([h.name,`station ${station.id}`]);
    for(const queue of sample.queues)if(intersect(r,queue.rect))collisions.push([h.name,`queue ${queue.id}`]);
    for(const other of sample.handles)if(other!==h&&h.name<other.name&&intersect(r,other.rect))collisions.push([h.name,other.name]);
    for(const train of sample.trains)if(intersect(r,train.rect))collisions.push([h.name,`train ${train.id}`]);
    for(const control of sample.controls)if(intersect(r,control.rect))collisions.push([h.name,control.name]);
   }
   for(const owner of sample.owners)if(owner.distance>110)collisions.push([owner.name,`disconnected from owner (${owner.distance.toFixed(1)}px)`]);
   assert.equal(sample.links.length,sample.handles.length,`${width}x${height} ${phase}: every fanned-out handle needs an inert colored owner link`);
   const centers=await page.evaluate(()=>[...document.querySelectorAll('.endpoint-handle')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {name:e.getAttribute('aria-label'),atCenter:document.elementFromPoint(x,y)?.getAttribute('aria-label')||document.elementFromPoint(x,y)?.getAttribute('data-train-id')||document.elementFromPoint(x,y)?.className}}));
   for(const center of centers)if(center.atCenter!==center.name)collisions.push([center.name,`center hit ${center.atCenter}`]);
   samples.push({phase,handles:sample.handles.length,fallback:sample.fallback,collisions,centers,hash:sample.hash,stage:sample.stage});
   if(phase==='context'&&width<=650)await page.screenshot({path:`/opt/data/cache/scratch/metro-acceptance/${width}x${height}-shared-endpoint-context.png`});
  }
  console.log(JSON.stringify({viewport:[width,height],routes:result.map(r=>r.ok),samples,errors}));
  assert.deepEqual(errors,[],'no JS errors');
  assert.ok(samples[0].handles+samples[0].fallback.length>=2,'shared endpoints remain accessible by handle or fallback');
  for(const s of samples){
   assert.equal(s.handles+s.fallback.length,6,`${width}x${height} ${s.phase}: every shared endpoint has a handle or named fallback`);
   for(const collision of s.collisions)allFailures.push({viewport:[width,height],phase:s.phase,collision});
  }
  if(width===568){
   await page.locator('#zoom-reset').click();
   const start=await page.getByRole('button',{name:/3号线终点.*延长/}).boundingBox();
   const goal=await page.locator('[data-station="3"]').boundingBox();
   assert.ok(start&&goal,'third line end and destination are both visible for native touch');
   assert.equal(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.classList.contains('endpoint-handle'),{x:start.x+start.width/2,y:start.y+start.height/2}),true,'third line end must be a native draggable stage handle, not a keyboard-only fallback');
   const a={x:start.x+start.width/2,y:start.y+start.height/2},b={x:goal.x+goal.width/2,y:goal.y+goal.height/2};
   const cdp=await page.context().newCDPSession(page);
   const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{id:1,x,y,radiusX:4,radiusY:4,force:1}]});
   // The natural direct extension traverses the offset handle's own station.
   // Crossing it must not permanently remove that stop on the way to station 3.
   await touch('touchStart',a.x,a.y);
   for(let i=1;i<=25;i++)await touch('touchMove',a.x+(b.x-a.x)*i/25,a.y+(b.y-a.y)*i/25);
   await touch('touchEnd',b.x,b.y);
   assert.deepEqual((await page.evaluate(()=>window.metro.getState())).lines.slice(0,3).map(l=>l.stops),
     [[1,2],[1,3],[2,1,3]],'direct native chord extends line 3 without retracting its crossed own endpoint');
   const ownHandle=await page.getByRole('button',{name:/3号线终点.*延长/}).boundingBox();
   const own=await page.evaluate(()=>window.metro.projectStation(3));
   assert.ok(ownHandle,'extended line retains its own draggable end');
   await touch('touchStart',ownHandle.x+ownHandle.width/2,ownHandle.y+ownHandle.height/2);
   await touch('touchMove',own.x,own.y);
   await touch('touchEnd',own.x,own.y);
   assert.deepEqual((await page.evaluate(()=>window.metro.getState())).lines.slice(0,3).map(l=>l.stops),
     [[1,2],[1,3],[2,1]],'deliberate release on own endpoint still retracts exact line 3');
   await page.locator('#zoom-reset').click();
   const detourStart=await page.getByRole('button',{name:/3号线终点.*延长/}).boundingBox();
   const detourGoal=await page.locator('[data-station="3"]').boundingBox();
   assert.ok(detourStart&&detourGoal);
   const detourA={x:detourStart.x+detourStart.width/2,y:detourStart.y+detourStart.height/2};
   const detourB={x:detourGoal.x+detourGoal.width/2,y:detourGoal.y+detourGoal.height/2};
   // The direct chord may cross the grabbed route's own terminal station,
   // so retain a separate detour check for exact overlapping-line ownership.
   const waypoint=await page.evaluate(({a,b})=>{
     const own=window.metro.projectStation(1),box=document.querySelector('#stage').getBoundingClientRect();
     const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
     const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
     const candidates=[1,-1].map(sign=>({x:mid.x-sign*dy/length*24,y:mid.y+sign*dx/length*24}));
     const distanceToSegment=(p,q,r)=>{const t=Math.max(0,Math.min(1,((r.x-p.x)*(q.x-p.x)+(r.y-p.y)*(q.y-p.y))/((q.x-p.x)**2+(q.y-p.y)**2)));return Math.hypot(r.x-p.x-t*(q.x-p.x),r.y-p.y-t*(q.y-p.y));};
     return candidates.find(p=>p.x>box.left+20&&p.x<box.right-20&&p.y>box.top+20&&p.y<box.bottom-20&&distanceToSegment(a,p,own)>30&&distanceToSegment(p,b,own)>30);
   },{a:detourA,b:detourB});
   assert.ok(waypoint,`touch extension can avoid the retracting endpoint: ${JSON.stringify(await page.evaluate(({a,b})=>({a,b,own:window.metro.projectStation(1),stage:document.querySelector('#stage').getBoundingClientRect().toJSON()}),{a:detourA,b:detourB}))}`);
   await touch('touchStart',detourA.x,detourA.y);
   for(const [from,to] of [[detourA,waypoint],[waypoint,detourB]])for(let i=1;i<=14;i++)await touch('touchMove',from.x+(to.x-from.x)*i/14,from.y+(to.y-from.y)*i/14);
   await touch('touchEnd',detourB.x,detourB.y);
   const state=await page.evaluate(()=>window.metro.getState());
   assert.deepEqual(state.lines.slice(0,3).map(l=>l.stops),[[1,2],[1,3],[2,1,3]],'real touch extends exact third line, not overlapping first line');
   await page.screenshot({path:'/opt/data/cache/scratch/metro-acceptance/568x320-third-line-touch.png'});
   console.log('native touch exact line identity passed');
   await page.evaluate(()=>{const stage=document.querySelector('#stage');stage.style.width='40px';stage.style.height='40px';});
   await page.locator('#zoom-in').click();
   const fallback=page.getByRole('button',{name:/3号线终点.*延长.*地图空间不足/});
   assert.equal(await fallback.count(),1,'a blocked endpoint remains explicitly keyboard accessible outside the map');
   await fallback.focus();await page.keyboard.press('Enter');
   assert.equal(await fallback.getAttribute('aria-pressed'),'true','fallback arms the exact line endpoint');
   await page.evaluate(()=>{const stage=document.querySelector('#stage');stage.style.removeProperty('width');stage.style.removeProperty('height');});
   await page.locator('#zoom-in').click();
   const destination=await page.locator('[data-station="3"]').boundingBox();
   assert.ok(destination,'destination is visible after restoring the map');
   await page.touchscreen.tap(destination.x+destination.width/2,destination.y+destination.height/2);
   assert.deepEqual((await page.evaluate(()=>window.metro.getState())).lines[2].stops,[2,1,3],'fallback tap targets the armed endpoint');
   await page.keyboard.press('Escape');
  }
  await page.close();
 }
}finally{await browser.close();await server.close();}
console.log(JSON.stringify({allFailures}));
assert.deepEqual(allFailures,[],'handle geometry collisions');
