import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {browserLaunchOptions} from './browser-launch.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();const browser=await chromium.launch(browserLaunchOptions());
try {
 const page=await browser.newPage({viewport:{width:568,height:320},hasTouch:true,isMobile:true});await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);
 await page.evaluate(()=>{const m=window.metro;m.restart({mode:'endless',seed:420});m.pause();for(let i=0;i<9;i++){const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200)}const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});});
 await page.waitForTimeout(250);
 const fail=await page.evaluate(()=>{
  const st=document.querySelector('#stage').getBoundingClientRect();const stats=window.metro.mobileMapStats();const state=window.metro.getState();const groups=stats.queueGroups;return groups.flatMap(g=>{
   const s=state.stations.find(s=>s.id===g.stationId);const p=stats.bounds.find(p=>p.id===g.stationId);return g.groups.flatMap(entry=>{
    const width=64*stats.zoom,height=16*stats.zoom;
    const visible=entry.visible;
    if(!visible)return [];
    const bounds={left:entry.x-width/2,right:entry.x+width/2,top:entry.y-height/2,bottom:entry.y+height/2};
    const unsafe=bounds.left<0||bounds.right>st.width||bounds.top<0||bounds.bottom>st.height;
    return unsafe?[{station:s.id,shape:entry.shape,count:entry.count,bounds,owner:p,zoom:stats.zoom}]:[];
   });
  });
 });
 console.log(JSON.stringify({unsafe:fail.slice(0,10),count:fail.length}));
 assert.equal(fail.length,0,'visible grouped destination labels must be fully within drawable stage');
} finally {await browser.close();await server.close();}
