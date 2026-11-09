import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {browserLaunchOptions} from './browser-launch.mjs';

const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});
await server.listen();
const browser=await chromium.launch(browserLaunchOptions());
try {
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.metro?.mobileMapStats());
  const result=await page.evaluate(async()=>{
    const {Mobile3DRenderer}=await import('/src/mobile-3d.ts');
    const {MetroRenderer}=await import('/src/renderer.ts');
    const timing={};
    for(const [proto,method] of [[Mobile3DRenderer.prototype,'prepare'],[Mobile3DRenderer.prototype,'reflow'],[Mobile3DRenderer.prototype,'fitQueues'],[Mobile3DRenderer.prototype,'camera'],[Mobile3DRenderer.prototype,'paint'],[Mobile3DRenderer.prototype,'ownerCues'],[Mobile3DRenderer.prototype,'mapStats'],[MetroRenderer.prototype,'render'],[MetroRenderer.prototype,'visualTrackLayout']]){
      const original=proto[method];proto[method]=function(...args){const start=performance.now();try{return original.apply(this,args);}finally{const name=`${proto.constructor.name}.${method}`;const data=timing[name]??={ms:0,count:0};data.ms+=performance.now()-start;data.count++;}};
    }
    const m=window.metro;
    m.restart({mode:'endless',seed:420});m.pause();
    for(let i=0;i<9;i++){
      const s=m.getState();
      if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});
      m.step(4200);
    }
    const s=m.getState();
    if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});
    const state=m.getState();
    for(const data of Object.values(timing)){data.ms=0;data.count=0;}
    const sample=[];
    for(let i=0;i<20;i++){
      const t=performance.now();m.step(1);sample.push(performance.now()-t);
    }
    return {stations:state.stations.length,queued:state.stations.reduce((sum,p)=>sum+p.queue.length,0),
      meanMs:sample.reduce((sum,x)=>sum+x,0)/sample.length,overBudget:sample.filter(x=>x>16.7).length,
      samples:sample.map(n=>+n.toFixed(2)),timing,hash:m.hash()};
  });
  assert.equal(result.stations,36);
  console.log(JSON.stringify(result));
  assert.ok(result.timing['MetroRenderer.render'].count <= 20,
    `Dense UI rendered ${result.timing['MetroRenderer.render'].count} scene frames in 20 steps (expected one per step)`);
} finally {await browser.close();await server.close();}
