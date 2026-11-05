import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 await page.goto(process.env.METRO_TEST_URL??'http://127.0.0.1:4175/',{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);
 const first=await page.evaluate(()=>{
  window.metro.restart({seed:77,mode:'creative'});window.metro.pause();
  const route=window.metro.submit({action:{type:'route',line:0,stops:[1,2]},reason:'group overlap'});
  const add=window.metro.submit({action:{type:'addTrain',line:0},reason:'group overlap'});
  const station=window.metro.submit({action:{type:'station',x:-7,y:-1.01,shape:'circle'},reason:'group overlap'});
  return {route,add,station,ids:window.metro.getState().stations.map(p=>p.id)};
 });
 assert.ok(first.route.ok&&first.add.ok&&first.station.ok,JSON.stringify(first));
 await page.waitForTimeout(200);
 const overlap=await page.evaluate(()=>{
  const b=document.querySelector('[data-train-group]')?.getBoundingClientRect(),p=document.querySelector('[data-station="6"]')?.getBoundingClientRect();
  if(!b||!p)return null;
  const x=Math.max(b.left,p.left)+Math.min(8,(Math.min(b.right,p.right)-Math.max(b.left,p.left))/2),y=Math.max(b.top,p.top)+Math.min(8,(Math.min(b.bottom,p.bottom)-Math.max(b.top,p.top))/2);
  return {x,y,width:Math.min(b.right,p.right)-Math.max(b.left,p.left),height:Math.min(b.bottom,p.bottom)-Math.max(b.top,p.top),top:document.elementFromPoint(x,y)?.outerHTML.slice(0,130)};
 });
 assert.ok(overlap&&overlap.width>2&&overlap.height>2,JSON.stringify(overlap));
 await page.mouse.click(overlap.x,overlap.y);
 await page.waitForTimeout(100);
 assert.equal(await page.locator('#train-detail').isVisible(),false,'group chooser must not open on another station hit target');
 assert.match(await page.locator('#station-detail .eyebrow').textContent(),/STATION 06/);
 console.log(JSON.stringify({passed:true,overlap}));
} finally {await browser.close()}
