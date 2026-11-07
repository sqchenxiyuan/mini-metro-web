import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();const browser=await chromium.launch(browserLaunchOptions());
const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
try {
 for(const [w,h] of [[320,480],[390,844],[568,320]]){
  const page=await browser.newPage({viewport:{width:w,height:h},isMobile:true,hasTouch:true});await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);await page.evaluate(()=>{let m=window.metro;m.restart({mode:'endless',seed:420});m.pause();for(let i=0;i<9;i++){let s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200)}let s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}})});
  const before = await page.locator('#stage').boundingBox();
  await page.locator('#line-chooser').click();await page.locator('[data-line="0"]').click();
  await page.waitForTimeout(100);
  const metrics=await page.evaluate(()=>{let rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();return{stage:rect('#stage'),bar:rect('#context-actions'),warning:rect('#mobile-crowd-alert'),footer:rect('.transport-bar'),play:rect('#play-pause'),speed:rect('.speed-switch'),warningHidden:document.querySelector('#mobile-crowd-alert').hidden,contextHidden:document.querySelector('#context-actions').hidden,stations:window.metro.getState().stations.filter(s=>s.id<=2).map(s=>({id:s.id,...window.metro.projectStation(s.id),hit:document.querySelector(`[data-station="${s.id}"]`).getBoundingClientRect().toJSON()}))}});
  assert.equal(metrics.contextHidden,false);
  assert.ok(metrics.bar.bottom<=h,`${w}x${h} context strip must fit viewport: ${JSON.stringify(metrics)}`);
  assert.equal(overlap(metrics.bar,metrics.warning),0,`${w}x${h} warning must not overlap context strip: ${JSON.stringify(metrics)}`);
  assert.equal(overlap(metrics.bar,metrics.stage),0,`${w}x${h} context strip must not overlay drawable stage`);
  assert.ok(metrics.stage.height>=before.height-52-(metrics.stage.y-before.y),`${w}x${h} context menu takes at most one row besides dynamic alert/header`);
  if (w===568) assert.ok(metrics.stage.height>=120,`${w}x${h} short landscape map remains usable: ${JSON.stringify(metrics)}`);
  if(w===568) assert.ok(metrics.stations.some(s=>s.hit.width>=44&&s.hit.top>=metrics.stage.top&&s.hit.bottom<=metrics.stage.bottom),
    'dense short-landscape context leaves an opening station fully touchable');
  console.log(JSON.stringify({size:`${w}x${h}`,metrics}));await page.screenshot({path:`/opt/data/cache/scratch/metro-acceptance/${w}x${h}-dense-context-current.png`});await page.close();
 }
}finally{await browser.close();await server.close();}
