import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 await page.goto(process.env.METRO_TEST_URL??'http://127.0.0.1:4175/',{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);
 await page.evaluate(()=>{window.metro.restart({mode:'endless',seed:420});window.metro.pause();window.metro.step(4100);const s=window.metro.getState();if(s.phase==='upgrade')window.metro.submit({action:{type:'upgrade',choice:s.upgrades[0]},reason:'badge-overlay'});window.metro.submit({action:{type:'route',line:0,stops:[1,2]},reason:'badge-overlay'});window.metro.submit({action:{type:'addTrain',line:0},reason:'badge-overlay'})});
 await page.waitForTimeout(200);
 const result=await page.evaluate(()=>{const badge=document.querySelector('[data-train-group="1"]'),w=document.querySelector('[data-overlay="w-1"]');const b=badge?.getBoundingClientRect(),r=w?.getBoundingClientRect();return {badge:!!badge,warning:!!w,intersect:b&&r?b.left<r.right&&b.right>r.left&&b.top<r.bottom&&b.bottom>r.top:false,alert:document.querySelector('#map-alerts')?.textContent,warningSource:window.metro.getState().stations.find(s=>s.id===1)?.crowd}});
 assert.equal(result.badge,true,'group badge fixture missing');
 assert.ok(result.warningSource>0,'station warning fixture missing');
 assert.equal(result.intersect,false,'group badge must not cover a placed crowd warning');
 if(!result.warning)assert.match(result.alert,/站拥挤/,'omitted warning must have fallback');
 console.log(JSON.stringify({passed:true,...result}));
}finally{await browser.close()}
