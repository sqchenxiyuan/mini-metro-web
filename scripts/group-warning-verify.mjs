import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,...(process.env.METRO_BROWSER_EXECUTABLE_PATH?{executablePath:process.env.METRO_BROWSER_EXECUTABLE_PATH}:{}),args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 await page.goto(process.env.METRO_TEST_URL??'http://127.0.0.1:4175/',{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);
 await page.evaluate(()=>{window.metro.restart({mode:'endless',seed:420});window.metro.pause();window.metro.step(4100);const s=window.metro.getState();if(s.phase==='upgrade')window.metro.submit({action:{type:'upgrade',choice:s.upgrades[0]},reason:'badge-overlay'});window.metro.submit({action:{type:'route',line:0,stops:[1,2]},reason:'badge-overlay'});window.metro.submit({action:{type:'addTrain',line:0},reason:'badge-overlay'})});
 await page.waitForTimeout(200);
 const result=await page.evaluate(()=>{const badge=document.querySelector('[data-train-group="1"]'),cues=window.metro.sceneCues(),crowd=window.metro.getState().stations.find(s=>s.id===1)?.crowd;return {badge:!!badge,warning:cues.warningStationIds.includes(1),ring:cues.ringStationIds.includes(1),alert:document.querySelector('#map-alerts')?.textContent,warningSource:crowd}});
 assert.equal(result.badge,true,'group badge fixture missing');
 assert.ok(result.warningSource>0,'station warning fixture missing');
 assert.equal(result.ring,true,'the crowded station must have a WebGL warning ring');
 if(!result.warning)assert.match(result.alert,/站拥挤/,'omitted warning detail must have fallback');
 console.log(JSON.stringify({passed:true,...result}));
}finally{await browser.close()}
