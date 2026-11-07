import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';
const server = await createServer({ server: { host:'127.0.0.1', port:0 }, logLevel:'error' });
await server.listen();const browser=await chromium.launch(browserLaunchOptions());
try {const page=await browser.newPage({viewport:{width:1280,height:800}});await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);
await page.evaluate(()=>{window.metro.restart({mode:'creative',seed:77});window.metro.pause()});
const before=await page.evaluate(()=>window.metro.getState());
const station=await page.evaluate(()=>window.metro.projectStation(1));await page.mouse.click(station.x,station.y);
const expand=page.locator('#context-actions [data-action="interchange"]');await expand.waitFor({state:'visible'});
await expand.click();
assert.equal(await page.evaluate(()=>window.metro.getState().stations.find(p=>p.id===1).interchange),true);
assert.equal(await page.evaluate(()=>window.metro.getState().resources.interchanges),before.resources.interchanges-1);
await page.locator('#new-game').click();await page.selectOption('#mode-select','creative');await page.locator('#settings-form button[type="submit"]').click();
assert.ok(await page.locator('[data-station-shape]:visible').count()>0,'creative normal entry exposes station-shape picker without inspector');
console.log(JSON.stringify({passed:true,stationUpgrade:true,creativePicker:true}));await page.close();}
finally{await browser.close();await server.close();}
