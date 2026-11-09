import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {browserLaunchOptions} from './browser-launch.mjs';
import {mkdir} from 'node:fs/promises';
const output='/opt/data/cache/scratch/metro-compact-queues';await mkdir(output,{recursive:true});
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
const browser=await chromium.launch(browserLaunchOptions());
try {
 for (const [w,h] of [[320,480],[390,844],[568,320]]) {
  const page=await browser.newPage({viewport:{width:w,height:h},hasTouch:true,isMobile:true});
  await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro?.mobileMapStats());
  await page.evaluate(()=>{const m=window.metro;m.restart({mode:'endless',seed:420});m.pause();for(let i=0;i<9;i++){const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200);}const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});});
  await page.waitForFunction(()=>window.metro.getState().stations.length===36);
  await page.waitForTimeout(200);
  const observed=await page.evaluate(()=>({hash:window.metro.hash(),stats:window.metro.mobileMapStats(),stage:document.querySelector('#stage').getBoundingClientRect().toJSON(),station:window.metro.getState().stations[0]}));
  const grouped=observed.stats.queueGroups;
  assert.ok(grouped?.length,'renderer must expose compact glyph groups as distinct from laid-out passenger IDs');
  const incomplete=grouped.filter(g=>g.groups.some(x=>!x.visible)&&g.groups.some(x=>x.visible));
  console.log(JSON.stringify({viewport:[w,h],partiallyVisibleStations:incomplete.map(g=>g.stationId)}));
  if(w===568) {
    const opening=grouped.find(g=>g.stationId===observed.station.id);
    const roof=await page.evaluate(id=>{const node=document.querySelector(`#station-layer .station-label[data-station="${id}"]`);const box=node.getBoundingClientRect(),stage=document.querySelector('#stage').getBoundingClientRect();return {x:box.left-stage.left+box.width/2,y:box.top-stage.top+5,box:box.toJSON()};},observed.station.id);
    const margin=12;
    const groups=opening?.groups.map(g=>({shape:g.shape,count:g.count,x:g.x,y:g.y,
      // Group icon extends 5px left and label extends 42px right; jitter is already in x/y.
      contained:g.x-5>=margin && g.x+42<=observed.stage.width-margin &&
        g.y-8>=margin && g.y+8<=observed.stage.height-margin}));
    await page.screenshot({path:`${output}/${w}x${h}-dense.png`});
    console.log(JSON.stringify({viewport:[w,h],stage:observed.stage,roof,groups,center:observed.stats.center,zoom:observed.stats.zoom}));
    assert.ok(groups?.every(g=>g.contained),'default short-landscape camera keeps every opening station queue icon and exact-count label inside 12px stage margin');
    assert.ok(roof.box.left>=observed.stage.x+margin && roof.box.right<=observed.stage.x+observed.stage.width-margin &&
      roof.box.top>=observed.stage.y+margin && roof.box.bottom<=observed.stage.y+observed.stage.height-margin,
      'default crowded station complete 44px hit target keeps 12px stage margin');
  }
  const owner=grouped.find(g=>g.stationId===observed.station.id);
  assert.ok(owner,'first station must have compact destination groups');
  assert.deepEqual(owner.groups.map(({shape,count})=>({shape,count})).sort((a,b)=>a.shape.localeCompare(b.shape)), Object.entries(observed.station.queue.reduce((acc,p)=>(acc[p.shape]=(acc[p.shape]??0)+1,acc),{})).sort().map(([shape,count])=>({shape,count})));
  assert.equal(owner.groups.reduce((n,g)=>n+g.count,0),observed.station.queue.length);
  const lowOccupancy=await page.evaluate(()=>window.metro.getState().stations.filter(s=>s.queue.length<=10).reduce((n,s)=>n+s.queue.length,0));
  assert.equal(observed.stats.laidOutPassengerIds.length,observed.stats.queueGroups.reduce((n,g)=>n+g.total,0)+lowOccupancy);
  await page.screenshot({path:`${output}/${w}x${h}-dense.png`});
  console.log(JSON.stringify({viewport:[w,h],hash:observed.hash,groups:owner.groups,queued:observed.station.queue.length}));
  await page.close();
 }
} finally {await browser.close();await server.close();}
