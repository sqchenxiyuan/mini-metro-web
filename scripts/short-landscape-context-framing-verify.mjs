import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();const browser=await chromium.launch(browserLaunchOptions());
try {
 const page=await browser.newPage({viewport:{width:568,height:320},hasTouch:true,isMobile:true});await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);
  const sample = () => page.evaluate(() => { const stage=document.querySelector('#stage').getBoundingClientRect();const s=[1,2].map(id=>{const p=window.metro.projectStation(id),e=document.querySelector(`[data-station="${id}"]`),r=e.getBoundingClientRect();return{id,project:p,hit:r.toJSON(),visible:!e.hidden,at:document.elementFromPoint(p.x,p.y)?.closest('[data-station]')?.dataset.station}});return {stage:stage.toJSON(),s,zoom:window.metro.mobileMapStats().zoom} });
 const initial=await sample();
 await page.locator('#line-chooser').click();await page.locator('[data-line="0"]').click();
 await page.waitForFunction(() => {
   const stage=document.querySelector('#stage').getBoundingClientRect();
   return [1,2].every(id=>{const e=document.querySelector(`[data-station="${id}"]`),r=e.getBoundingClientRect();return !e.hidden && r.top>=stage.top && r.bottom<=stage.bottom;});
 });
 const state=await sample();
 console.log(JSON.stringify({initial,state}));
 assert.equal(state.s.length,2);
 assert.ok(state.s.every(({project:p,hit:r,visible})=>visible&&r.top>=state.stage.top&&r.bottom<=state.stage.bottom&&p.y>=state.stage.top&&p.y<=state.stage.bottom),'opening stations must remain entirely usable after selecting a line');
}finally{await browser.close();await server.close();}
