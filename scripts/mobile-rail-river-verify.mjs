import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {browserLaunchOptions} from './browser-launch.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
const browser=await chromium.launch(browserLaunchOptions());
try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});
  const result=await page.evaluate(async()=>{
    const {crossings,trackPoints}=await import('/src/rules.ts');
    const {MetroRenderer,hitTestVisibleLane}=await import('/src/renderer.ts');
    const rail={};
    const draw=MetroRenderer.prototype.drawLane;
    MetroRenderer.prototype.drawLane=function(points,offset,radius,color,group,height,...rest){
      if(this.trackSource?.lines?.[0]?.stops?.join(',')==='1,2' && !rail.points && color==='#fffaf6'){
        rail.points=points.map(p=>({...p}));rail.scene=this;
      }
      return draw.call(this,points,offset,radius,color,group,height,...rest);
    };
    const m=window.metro;m.restart({mode:'creative',city:'orchard',seed:420});m.pause();
    const s=m.controller.session.state;
    s.stations[0].x=-2;s.stations[0].y=-8;
    s.stations[1].x=2;s.stations[1].y=-1;
    s.lines[0].stops=[1,2];m.controller.onChange();
    const adapter=m.controller.renderer ?? null;
    const rule=crossings(s,1,2);
    const river=point=>point.x - (Math.sin(point.y*.27)*1.35+point.y*.16);
    const canonical=trackPoints(s.stations[0],s.stations[1]);
    const visual=window.metro.mobileMapStats();
    const painted=rail.scene.getPaintedTrackLayout().segments.find(edge=>edge.from===1&&edge.to===2);
    const lane=painted.lanes.find(lane=>lane.lineId===0);
    const vertices=rail.scene.trackVertices(painted.points,lane.offset,.43,painted.endpointOffsets);
    const path=rail.scene.laneCurve(vertices);
    const touchSamples=Array.from({length:17},(_,i)=>{
      const p=path.getPoint((i+2)/20);
      const screen=rail.scene.project(p.x,p.z,p.y);
      return {x:screen.x,y:screen.y,index:hitTestVisibleLane(s,0,screen,
        rail.scene.project.bind(rail.scene),12,rail.scene.getPaintedTrackLayout())};
    });
    return {rule,canonical,painted:rail.points,touchSamples,hash:m.hash(),stationCount:visual.stationCount,
      sourceSide:canonical.map(river),canvas:document.querySelector('#stage canvas').className};
  });
  assert.equal(result.rule,0);
  assert.equal(result.stationCount,3);
  assert.ok(result.painted?.length>=3,'painted rail uses canonical bends');
  assert.equal(result.painted[1].x,result.painted[0].x,'canonical first leg keeps x coordinate');
  assert.ok(result.touchSamples.every(sample=>sample.index===1),
    `all painted bend samples hit their selected edge: ${JSON.stringify(result.touchSamples)}`);
  assert.ok(result.sourceSide.every(side=>side>0),'authoritative rail remains on one side of river');
  console.log(JSON.stringify(result));
}finally{await browser.close();await server.close();}
