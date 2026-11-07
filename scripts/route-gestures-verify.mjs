import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './browser-launch.mjs';
const browser = await chromium.launch(browserLaunchOptions({ ...process.env, METRO_BROWSER_EXECUTABLE_PATH: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? '/opt/hermes/tools/chromium-1208/chrome-linux64/chrome' }));
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/';
async function drag(page, a, b, touch = false) {
  if (!touch) { await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x,b.y,{steps:14}); await page.mouse.up(); return; }
  const cdp = await page.context().newCDPSession(page);
  const send = (type,x,y) => cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{id:1,x,y,radiusX:4,radiusY:4,force:1}]});
  await send('touchStart',a.x,a.y);
  for (let i=1;i<=14;i++) await send('touchMove',a.x+(b.x-a.x)*i/14,a.y+(b.y-a.y)*i/14);
  await send('touchEnd',b.x,b.y); await cdp.detach();
}
const state = page => page.evaluate(() => window.metro.getState());
const ids = page => page.evaluate(() => [1,2,3].map(id => window.metro.projectStation(id)));
const handlePoint = (page, name) => page.locator(`[data-route-handle="${name}"]`).evaluate(node => {
  const rect=document.querySelector('#stage').getBoundingClientRect();
  return {x:rect.left+Number(node.getAttribute('cx')),y:rect.top+Number(node.getAttribute('cy'))};
});
const route = (page,line,stops,loop=false) => page.evaluate(({line,stops,loop})=>window.metro.submit({action:{type:'route',line,stops,loop}}),{line,stops,loop});
const reset = async (page,mode='normal') => {
  await page.evaluate(mode=>{window.metro.restart({seed:420,mode});window.metro.pause();},mode);
  await page.waitForFunction(()=>window.metro?.getState().lines.every(line=>line.stops.length===0));
  await page.waitForTimeout(120);
};
const center = (a,b) => ({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
async function railPoint(page, edge) {
 return page.evaluate(async edge => {
  const { hitTestVisibleLane } = await import('/src/renderer.ts');
  const s=window.metro.getState(), p=s.stations.slice(0,3), q=p.map(x=>window.metro.projectStation(x.id));
  const determinant=(p[1].x-p[0].x)*(p[2].y-p[0].y)-(p[2].x-p[0].x)*(p[1].y-p[0].y);
  const fit=(axis)=>{
   const dx=((q[1][axis]-q[0][axis])*(p[2].y-p[0].y)-(q[2][axis]-q[0][axis])*(p[1].y-p[0].y))/determinant;
   const dy=((q[2][axis]-q[0][axis])*(p[1].x-p[0].x)-(q[1][axis]-q[0][axis])*(p[2].x-p[0].x))/determinant;
   return [dx,dy,q[0][axis]-dx*p[0].x-dy*p[0].y];
  };
  const fx=fit('x'),fy=fit('y'),stage=document.querySelector('#stage').getBoundingClientRect();
  const project=(x,y)=>({x:fx[0]*x+fx[1]*y+fx[2]-stage.left,y:fy[0]*x+fy[1]*y+fy[2]-stage.top});
  const pair=edge===1?[q[0],q[1]]:[q[1],q[2]],mid={x:(pair[0].x+pair[1].x)/2,y:(pair[0].y+pair[1].y)/2};
  for(let radius=0;radius<=80;radius+=3) for(let dx=-radius;dx<=radius;dx+=3) for(let dy=-radius;dy<=radius;dy+=3) {
   const x=mid.x+dx,y=mid.y+dy;
   if(hitTestVisibleLane(s,0,{x:x-stage.left,y:y-stage.top},project,5)===edge) return {x,y};
  }
  throw new Error(`no visible lane found for edge ${edge}`);
 },edge);
}
async function mobileRailPoint(page,edge) {
 return page.evaluate(async edge=>{
  const {MobileMapRenderer}=await import('/src/mobile-map.ts');
  const renderer=Object.create(MobileMapRenderer.prototype);
  const s=window.metro.getState(), stats=window.metro.mobileMapStats(),stage=document.querySelector('#stage').getBoundingClientRect();
  Object.assign(renderer,{state:s,points:[],center:stats.center,zoom:stats.zoom,size:{width:stage.width,height:stage.height},
   routeCache:new Map(),recentLineKey:'',recentLineLayout:null,layoutKey:'',
   sourceYs:[...new Set(s.stations.map(p=>p.y))].sort((a,b)=>a-b),warpValues:[]});
  const {geographicLayout}=await import('/src/mobile-map.ts');
  renderer.points=geographicLayout(s.stations);
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
 for (const [width,height,touch] of [[1280,800,false],[1280,800,true],[390,844,true]]) {
  const page = await browser.newPage({viewport:{width,height},hasTouch:touch,isMobile:touch});
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(url,{waitUntil:'networkidle'}); await page.waitForFunction(()=>window.metro);
  await reset(page);
  if (touch && width < 650) {
    for(let i=0;i<6;i++) await page.locator('#zoom-out').click();
    await drag(page,{x:360,y:580},{x:280,y:580},touch);
  }
  let [a,b,c]=await ids(page);
  await drag(page,a,b,touch);
  if (touch) { [a,b,c]=await ids(page); await page.waitForTimeout(100); }
  assert.deepEqual((await state(page)).lines[0].stops,[1,2],`${width} initial body drag`);
  await drag(page,a,b,touch);
  assert.deepEqual((await state(page)).lines[1].stops,[1,2],`${width} occupied body creates a new line`);
  if (!touch) {
    const secondHandle=await page.locator('[data-route-handle="1-end"]').evaluate(node=>{
      const box=document.querySelector('#stage').getBoundingClientRect();
      return {x:box.left+Number(node.getAttribute('cx')),y:box.top+Number(node.getAttribute('cy'))};
    });
    const firstHandle=await page.locator('[data-route-handle="0-end"]').evaluate(node=>{
      const box=document.querySelector('#stage').getBoundingClientRect();
      return {x:box.left+Number(node.getAttribute('cx')),y:box.top+Number(node.getAttribute('cy'))};
    });
    assert.ok(Math.hypot(firstHandle.x-secondHandle.x,firstHandle.y-secondHandle.y)>=15,'shared endpoint handles are separate');
    await drag(page,secondHandle,c);
    assert.deepEqual((await state(page)).lines[1].stops,[1,2,3],`${width} shared station handle owns its exact line`);
    assert.deepEqual((await state(page)).lines[0].stops,[1,2],`${width} other shared line untouched`);
  }
  assert.equal(await page.locator('#station-peek').isVisible(),false,`${width} drag cannot peek`);
  await reset(page); [a,b,c]=await ids(page);
  if (touch && width < 650) {
    // Fit all three opening stations by using the real zoom and pan controls.
    for(let i=0;i<3;i++) await page.locator('#zoom-out').click();
    await drag(page,{x:370,y:580},{x:280,y:580},touch);
    [a,b,c]=await ids(page);
  }
  assert.equal((await route(page,0,[1,2])).ok,true);
  // Handle should be accessible just outside the station body along the outward rail direction.
  const from=await handlePoint(page,'0-start');
  await drag(page,from,c,touch);
  assert.deepEqual((await state(page)).lines[0].stops,[3,1,2],`${width} prepend from start handle`);
  await reset(page); [a,b,c]=await ids(page);
  if (touch && width < 650) {
    // Fit all three opening stations by using the real zoom and pan controls.
    for(let i=0;i<3;i++) await page.locator('#zoom-out').click();
    await drag(page,{x:370,y:580},{x:280,y:580},touch);
    [a,b,c]=await ids(page);
  }
  assert.equal((await route(page,0,[1,2])).ok,true);
  for(const handle of await page.locator('[data-route-handle]').evaluateAll(nodes=>nodes.map(node=>({
    id:node.getAttribute('data-route-handle'),x:Number(node.getAttribute('cx')),y:Number(node.getAttribute('cy'))})))) {
    const box=await page.locator('#stage').boundingBox();
    assert.ok(handle.x>=11&&handle.x<=box.width-11&&handle.y>=11&&handle.y<=box.height-11,
      `visible endpoint handle ${handle.id} within stage`);
  }
  const end=await handlePoint(page,'0-end');
  await drag(page,end,c,touch);
  assert.deepEqual((await state(page)).lines[0].stops,[1,2,3],`${width} append from end handle`);
  // Selecting a different line mid-gesture cannot retarget the grabbed owner.
  await reset(page); [a,b,c]=await ids(page);
  assert.equal((await route(page,0,[1,2])).ok,true);
  const locked=await handlePoint(page,'0-end');
  if (!touch) {await page.mouse.move(locked.x,locked.y);await page.mouse.down();await page.evaluate(()=>window.metro.controller.selectedLine=1);await page.mouse.move(c.x,c.y,{steps:14});await page.mouse.up();
   assert.deepEqual((await state(page)).lines[0].stops,[1,2,3],`${width} line ID locked`);
   assert.deepEqual((await state(page)).lines[1].stops,[],`${width} selection not modified`);}
  await reset(page); [a,b,c]=await ids(page);
  if (touch && width < 650) {
    for(let i=0;i<3;i++) await page.locator('#zoom-out').click();
    await drag(page,{x:370,y:580},{x:280,y:580},touch);
    [a,b,c]=await ids(page);
  }
  assert.equal((await route(page,0,[1,2,3],true)).ok,true);
  const original=await state(page);
  const s=await page.locator('#stage').boundingBox();
  const edge=touch&&width<650?await mobileRailPoint(page,3):center(a,c), blank={x:s.x+s.width*.8,y:s.y+s.height*.78};
  await drag(page,edge,blank,touch);
  assert.equal((await state(page)).lines[0].loop,false,`${width} loop release removes closing edge`);
  assert.deepEqual((await state(page)).lines[0].stops,[1,2,3],`${width} closure keeps stop order`);
  assert.equal(await page.locator('[data-loop-tip]').count(),0,`${width} deformation clears after release`);
  await reset(page); [a,b,c]=await ids(page);
  if (touch && width < 650) {
    for(let i=0;i<3;i++) await page.locator('#zoom-out').click();
    await drag(page,{x:370,y:580},{x:280,y:580},touch);
    [a,b,c]=await ids(page);
  }
  assert.equal((await route(page,0,[1,2,3],true)).ok,true);
  const before=await state(page); await drag(page,center(a,c),{x:center(a,c).x+18,y:center(a,c).y+14},touch);
  assert.deepEqual((await state(page)).lines[0],before.lines[0],`${width} short pull cancels`);
  if (touch && width < 650) {
    const mobileStage=await page.locator('#stage').boundingBox();
    for (const [edgeIndex,expected] of [[1,[2,3,1]],[2,[3,1,2]]]) {
      await reset(page); [a,b,c]=await ids(page);
      for(let i=0;i<3;i++) await page.locator('#zoom-out').click();
      await drag(page,{x:370,y:580},{x:280,y:580},touch);
      assert.equal((await route(page,0,[1,2,3],true)).ok,true);
      const start=await mobileRailPoint(page,edgeIndex);
      await drag(page,start,{x:mobileStage.x+mobileStage.width*.83,y:mobileStage.y+mobileStage.height*.79},touch);
      assert.deepEqual((await state(page)).lines[0],{id:0,stops:expected,loop:false},`mobile edge ${edgeIndex} rotates`);
    }
  }
  if (!touch) {
    const stage=await page.locator('#stage').boundingBox();
    for (const [index,expected] of [[0,[2,3,1]],[1,[3,1,2]]]) {
      await reset(page); [a,b,c]=await ids(page);
      assert.equal((await route(page,0,[1,2,3],true)).ok,true);
      const grab=await railPoint(page,index+1);
      await page.waitForTimeout(120);
      await drag(page,grab,{x:stage.x+stage.width*.8,y:stage.y+stage.height*.78});
      assert.deepEqual((await state(page)).lines[0],{id:0,stops:expected,loop:false},`internal edge ${index} rotates`);
    }
    for (const [name,kind,mode] of [['return','return','normal'],['station','station','normal'],['rail','rail','normal'],['outside','outside','normal'],['extreme','blank','extreme']]) {
      await reset(page,mode); [a,b,c]=await ids(page);
      assert.equal((await route(page,0,[1,2,3],true)).ok,true);
      const initial=(await state(page)).lines[0];
      const start=await railPoint(page,3);
      const target=kind==='return'?start:kind==='station'?b:kind==='rail'?await railPoint(page,1):kind==='outside'?{x:stage.x+stage.width-4,y:stage.y+stage.height*.8}:{x:stage.x+stage.width*.8,y:stage.y+stage.height*.78};
      await drag(page,start,target);
      assert.deepEqual((await state(page)).lines[0],initial,`${name} pull cancels`);
    }
  }
  assert.deepEqual(errors,[],`${width} browser errors`);
  console.log(`${width}x${height}: ${touch?'touch':'mouse'} body, both handles, loop, short cancel passed`);
  await page.close();
 }
} finally {await browser.close();}
