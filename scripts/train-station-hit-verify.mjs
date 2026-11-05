import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 await page.goto(process.env.METRO_TEST_URL??'http://127.0.0.1:4175/',{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);
 await page.evaluate(()=>{window.metro.restart({seed:77,mode:'creative'});window.metro.pause();window.metro.submit({action:{type:'route',line:0,stops:[1,2]},reason:'train-hit-regression'})});
 let overlap=null;
 for(let tick=0;tick<160&&!overlap;tick++){
  if(tick)await page.evaluate(()=>window.metro.step(1));
  await page.waitForTimeout(25);
  overlap=await page.evaluate(()=>{
  const badge=document.querySelector('[data-train-id]:not([hidden])');if(!badge)return null;
  const r=badge.getBoundingClientRect(), s=window.metro.getState();
  for(const p of s.stations){const a=window.metro.projectStation(p.id);if(a.x>r.left&&a.x<r.right&&a.y>r.top&&a.y<r.bottom)
   return {id:p.id,x:a.x,y:a.y,badgeId:badge.dataset.trainId,top:document.elementFromPoint(a.x,a.y)?.outerHTML.slice(0,120)};}
  return null;
  });
 }
 assert.ok(overlap,'fixture must have a train badge over a station anchor');
 const target=await page.evaluate(({x,y,id})=>{const badge=document.querySelector('[data-train-id]:not([hidden])').getBoundingClientRect(),station=document.querySelector(`[data-station="${id}"]`).getBoundingClientRect();return {x:Math.min(station.right-2,badge.right-2,x+19),y,station:station.toJSON(),badge:badge.toJSON()};},overlap);
 assert.ok(target.x>target.station.left&&target.x<target.station.right&&target.x>target.badge.left&&target.x<target.badge.right);
 await page.mouse.click(target.x,target.y);
 await page.waitForTimeout(100);
 const selected=await page.locator('#station-detail').textContent();
 console.log('train-station overlap probe',JSON.stringify({overlap,selected}));
 assert.match(selected,new RegExp(`STATION ${String(overlap.id).padStart(2,'0')}\\b`),'station should win when pointer is on station core');
 console.log(JSON.stringify({passed:true,overlap}));
}finally{await browser.close()}
