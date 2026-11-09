import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({server:{host:'127.0.0.1',port:0,hmr:false},logLevel:'error'});
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});
  await page.evaluate(async()=>{
    const {MetroRenderer}=await import('/src/renderer.ts');
    const original=MetroRenderer.prototype.drawLane;
    MetroRenderer.prototype.drawLane=function(...args){window.__paintedScene=this;return original.apply(this,args);};
  });
  const touch=async(start,end)=>{
    const session=await page.context().newCDPSession(page);
    const send=(type,p)=>session.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{id:1,x:p.x,y:p.y,radiusX:4,radiusY:4,force:1}]});
    await send('touchStart',start);
    for(let i=1;i<=15;i++) await send('touchMove',{x:start.x+(end.x-start.x)*i/15,y:start.y+(end.y-start.y)*i/15});
    await page.waitForFunction(({x,y})=>window.__lastLaneMove && Math.hypot(window.__lastLaneMove.x-x,window.__lastLaneMove.y-y)<.1,end);
    await send('touchEnd',end);
    await session.detach();
  };
  await page.evaluate(()=>document.querySelector('#stage').addEventListener('pointermove',e=>{
    window.__lastLaneMove={x:e.clientX,y:e.clientY};
  }));
  const fixture=async({mode='creative',line=0,stops=[1,2],loop=false,shared=false,orchard=false})=>{
    return page.evaluate(({mode,line,stops,loop,shared,orchard})=>{
      const m=window.metro;m.restart({mode,city:'orchard',seed:420});m.pause();
      const state=m.controller.session.state;
      if(orchard){state.stations[0].x=-2;state.stations[0].y=-8;state.stations[1].x=2;state.stations[1].y=-1;}
      if(shared){state.lines[0].stops=[1,2];state.lines[1].stops=[2,1];}
      else {state.lines[line].stops=stops;state.lines[line].loop=loop;}
      m.controller.selectedLine=line;m.controller.onChange();
      const scene=window.__paintedScene;
      const stage=document.querySelector('#stage').getBoundingClientRect();
      const route=state.lines[line];
      const edges=[];
      for(let i=1;i<route.stops.length;i++)edges.push([route.stops[i-1],route.stops[i],i]);
      if(route.loop)edges.push([route.stops.at(-1),route.stops[0],route.stops.length]);
      const candidates=edges.flatMap(([a,b,index])=>{
        const edge=scene.getPaintedTrackLayout().segments.find(e=>e.from===Math.min(a,b)&&e.to===Math.max(a,b));
        const lane=edge.lanes.find(l=>l.lineId===line);
        const vertices=scene.trackVertices(edge.points,lane.offset,.43,
          edge.laneEndpoints?.find(e=>e.lineId===line)??edge.endpointOffsets);
        const path=scene.laneCurve(vertices);
        return Array.from({length:13},(_,i)=>{
          const p=path.getPoint((i+2)/16),projected=scene.project(p.x,p.z,p.y);
          const point={x:projected.x+stage.left,y:projected.y+stage.top};
          const nearest=Math.min(...state.stations.map(s=>{
            const q=m.projectStation(s.id);return Math.hypot(q.x-point.x,q.y-point.y);
          }));
          const center=Math.min(point.x-stage.left,stage.right-point.x,point.y-stage.top,stage.bottom-point.y);
          return {point,index,nearest,center};
        });
      }).filter(c=>c.nearest>42&&c.center>18&&
        document.elementFromPoint(c.point.x,c.point.y)?.closest('#stage'));
      // Select the first safe painted point on the closing edge for loop checks.
      const picked=(loop?candidates.filter(c=>c.index===route.stops.length):candidates)
        .sort((a,b)=>b.nearest-a.nearest)[0];
      if(!picked)throw new Error(`No safe painted touch point: ${JSON.stringify({edges,candidates,stage})}`);
      return {picked,stage:{x:stage.x,y:stage.y,width:stage.width,height:stage.height},
        target:m.projectStation(3),hash:m.hash(),tunnels:state.resources.tunnels,center:m.mobileMapStats().center};
    },{mode,line,stops,loop,shared,orchard});
  };
  for(const config of [
    {label:'creative orchard canonical bend',orchard:true},
    {label:'normal route',mode:'normal'},
    {label:'shared selected reverse line',shared:true,line:1},
  ]){
    const {picked,target,hash,center,tunnels}=await fixture(config);
    assert.equal(picked.index,1,`${config.label}: chosen segment`);
    assert.ok(picked.nearest>42,`${config.label}: rail pointer must not select a station`);
    await touch(picked.point,target);
    await page.waitForFunction(line=>window.metro.getState().lines[line].stops.length===3,config.line??0);
    const result=await page.evaluate(line=>({stops:window.metro.getState().lines[line].stops,
      tunnels:window.metro.getState().resources.tunnels,
      center:window.metro.mobileMapStats().center,hash:window.metro.hash()}),config.line??0);
    assert.deepEqual(result.stops,config.shared?[2,3,1]:[1,3,2],`${config.label}: native drag inserts in exact selected edge`);
    assert.notEqual(result.hash,hash,`${config.label}: route committed`);
    if(config.orchard){
      const crossings=await page.evaluate(async()=>{
        const {crossings}=await import('/src/rules.ts');const s=window.metro.getState();
        return crossings(s,1,2);
      });
      assert.equal(crossings,0,'original canonical orchard edge needs no tunnel');
      assert.equal(result.tunnels,tunnels,'inserting at visible bend did not consume an invented tunnel');
    }
    assert.deepEqual(result.center,center,`${config.label}: drag did not pan camera`);
    console.log(`${config.label}: native touch inserted ${result.stops.join(',')} at painted edge; camera unchanged`);
  }
  const {picked,stage,hash,center}=await fixture({loop:true,stops:[1,2,3]});
  assert.equal(picked.index,3,'closing rail has insertion index after last stop');
  // A small outward pull far from any station or rail opens the closing edge.
  const blank={x:stage.x+stage.width*.54,y:stage.y+stage.height*.85};
  await touch(picked.point,blank);
  const result=await page.evaluate(()=>({line:window.metro.getState().lines[0],
    center:window.metro.mobileMapStats().center,hash:window.metro.hash()}));
  assert.deepEqual(result.line.stops,[1,2,3],'loop drag retains ordered stops');
  assert.equal(result.line.loop,false,'native drag opens painted closing edge');
  assert.notEqual(result.hash,hash,'loop change committed');
  assert.deepEqual(result.center,center,'loop drag did not pan camera');
  assert.deepEqual(errors,[],'browser page errors');
  console.log('loop closing edge: native touch opened loop; camera unchanged');
} finally {await browser.close();await server.close();}
