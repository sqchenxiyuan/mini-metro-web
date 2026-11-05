import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,...(process.env.METRO_BROWSER_EXECUTABLE_PATH?{executablePath:process.env.METRO_BROWSER_EXECUTABLE_PATH}:{}),args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 await page.goto(process.env.METRO_TEST_URL??'http://127.0.0.1:4175/',{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);
 await page.evaluate(()=>{window.metro.restart({seed:420,mode:'endless'});window.metro.pause();for(let i=0;i<9;i++){const s=window.metro.getState();if(s.phase==='upgrade')window.metro.submit({action:{type:'upgrade',choice:s.upgrades[0]},reason:'overlay test'});window.metro.step(4200)}const s=window.metro.getState();if(s.phase==='upgrade')window.metro.submit({action:{type:'upgrade',choice:s.upgrades[0]},reason:'overlay test'})});
 await page.waitForTimeout(220);
 const metrics=await page.evaluate(()=>{
  const state=window.metro.getState(), r=(e)=>e.getBoundingClientRect(), hit=(x,y)=>x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top;
  const sceneCues=window.metro.sceneCues();
  const stations=[...document.querySelectorAll('[data-station]')];
  const queued=state.stations.filter(p=>p.queue.length).length, warned=state.stations.filter(p=>p.crowd>0).length;
  const drawnQueues=sceneCues.queueCount, drawnWarnings=sceneCues.warningCount;
  const alerts=document.querySelector('#map-alerts')?.textContent??'';
  const badge=document.querySelector('[data-train-id]:not([hidden])'),badgeRect=badge?.getBoundingClientRect();
  const badgeStation=badgeRect?stations.filter(s=>hit(badgeRect,r(s))).map(s=>s.dataset.station):[];
  return {queued,warned,drawnQueues,drawnWarnings,alerts,badgeStation,sceneCues,domOverlays:document.querySelectorAll('#overlay-layer [data-overlay]').length};
 });
 assert.equal(metrics.domOverlays,0,'passenger and warning cues must render inside the game canvas');
 assert.equal(metrics.sceneCues.ringCount,metrics.warned,'every crowded station keeps a scene warning ring');
 assert.equal(metrics.badgeStation.length,0,'train hit target must not cover station touch targets');
 assert.equal(metrics.queued,metrics.drawnQueues+Number(metrics.alerts.match(/(\d+) 站候车详情/)?.[1]??0));
 assert.equal(metrics.warned,metrics.drawnWarnings+Number(metrics.alerts.match(/(\d+) 站拥挤/)?.[1]??0));
 const alert = page.locator('#map-alerts');
 if (await alert.isVisible()) {
   const controls=await page.locator('.left-panel').boundingBox(), a=await alert.boundingBox();
   assert.ok(a.y >= controls.y + controls.height || a.y + a.height <= controls.y,
     'fallback alert must not cover collapsed line controls');
   await page.locator('#line-tools-toggle').click();
   const panel=await page.locator('#line-tools').boundingBox();
   assert.ok(a.x + a.width <= panel.x || a.x >= panel.x + panel.width ||
     a.y + a.height <= panel.y || a.y >= panel.y + panel.height,
     'fallback alert must not cover expanded line tools');
   await page.locator('#line-tools-close').click();
   const omitted = await alert.getAttribute('data-omitted');
   const missing = new Set(omitted.split(',').map(Number));
   assert.ok(missing.size > 1);
   await alert.click();
   const first = await page.locator('.station-label.selected').getAttribute('data-station');
   assert.equal(await page.locator('#station-peek').isVisible(), true,
     'fallback navigation must expose the selected station queue and crowd detail');
   assert.match(await page.locator('#station-peek').textContent(), new RegExp(`车站 ${first}\\b`));
   await alert.click();
   const second = await page.locator('.station-label.selected').getAttribute('data-station');
   assert.ok(missing.has(Number(first)) && missing.has(Number(second)), 'alert only cycles omitted stations');
   assert.notEqual(first,second,'repeated alert clicks must navigate omitted stations');
   // Reset while the cycle has outstanding stations, not only after completing it.
   await page.evaluate(() => window.metro.restart({seed:421,mode:'endless'}));
   assert.equal(await alert.isVisible(),false,'restart must clear an in-progress fallback cycle');
   assert.equal(await alert.getAttribute('data-omitted'),'', 'new game must not keep omitted station IDs');
   // Restore the dense scenario; verify every ID from its fresh omitted set.
   await page.evaluate(() => {window.metro.restart({seed:420,mode:'endless'});window.metro.pause();for(let i=0;i<9;i++){const s=window.metro.getState();if(s.phase==='upgrade')window.metro.submit({action:{type:'upgrade',choice:s.upgrades[0]},reason:'overlay test'});window.metro.step(4200)}const s=window.metro.getState();if(s.phase==='upgrade')window.metro.submit({action:{type:'upgrade',choice:s.upgrades[0]},reason:'overlay test'})});
   const freshMissing = new Set((await alert.getAttribute('data-omitted')).split(',').map(Number));
   assert.ok(freshMissing.size > 1);
   const visited = new Set();
   // A complete cycle must survive layout changes caused by selection.
   for (let i=0;i<freshMissing.size;i++) {
     assert.equal(await alert.isVisible(),true,'alert must stay available until the cycle completes');
     await alert.click();
     visited.add(Number(await page.locator('.station-label.selected').getAttribute('data-station')));
   }
   assert.deepEqual(visited,freshMissing,'selection-induced layout changes must not skip omitted stations');
   assert.equal(await page.locator('#inspector').isVisible(),false,
     'inspector must not cover the selected map station');
   // Seek across snapshots with different station sets while a cycle is open.
   await page.evaluate(() => { const r = window.metro.exportReplay(); window.metro.loadReplay(r); window.metro.seek(r.duration); });
   await page.locator('#inspector-close').click();
   assert.equal(await alert.isVisible(),true,'late replay snapshot needs fallback navigation');
   await alert.click();
   await page.evaluate(() => window.metro.seek(0));
   assert.equal(await alert.isVisible(),false,'seeking to an early snapshot must clear stale fallback stations');
   assert.equal(await page.locator('#station-peek').isVisible(),false,'replay seek must clear stale selected-station details');
   assert.equal(await alert.getAttribute('data-omitted'),'', 'early snapshot must not inherit late station IDs');
 }
 console.log(JSON.stringify({passed:true,...metrics}));
}finally{await browser.close()}
