import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {browserLaunchOptions} from './browser-launch.mjs';
import assert from 'node:assert/strict';
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();const browser=await chromium.launch(browserLaunchOptions());
try {
 for(const [width,height] of [[320,480],[390,844],[568,320]]) {
  const page=await browser.newPage({viewport:{width,height},hasTouch:true,isMobile:true});await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro?.mobileMapStats());
  const state=await page.evaluate(()=>({stats:window.metro.mobileMapStats(),stage:document.querySelector('#stage').getBoundingClientRect().toJSON(),stations:window.metro.getState().stations.slice(0,2).map(p=>({id:p.id,queue:p.queue.length,center:document.querySelector(`[data-station="${p.id}"]`)?.getBoundingClientRect().toJSON(),point:window.metro.mobileMapStats().bounds.find(q=>q.id===p.id)}))}));
  console.log(JSON.stringify({viewport:[width,height],stage:{width:state.stage.width,height:state.stage.height},zoom:state.stats.zoom,stations:state.stations.map(p=>({id:p.id,hit:p.center&&[p.center.x,p.center.y,p.center.width,p.center.height]}))}));
  const margin=12;
  const failures=state.stations.filter(p=>p.center && (p.center.left<state.stage.left+margin || p.center.right>state.stage.right-margin || p.center.top<state.stage.top+margin || p.center.bottom>state.stage.bottom-margin));
  assert.deepEqual(failures.map(p=>p.id),[],`opening station hit targets should have ${margin}px safe margin from the drawable stage`);
  if(width===568) {
   const hash=await page.evaluate(()=>window.metro.hash());
   await page.locator('#zoom-reset').click();
   const reset=await page.evaluate(()=>({stats:window.metro.mobileMapStats(),stage:document.querySelector('#stage').getBoundingClientRect().toJSON(),targets:[1,2].map(id=>document.querySelector(`[data-station="${id}"]`)?.getBoundingClientRect().toJSON())}));
   assert.ok(reset.targets.every(r=>r&&r.left>=reset.stage.left+margin&&r.right<=reset.stage.right-margin&&r.top>=reset.stage.top+margin&&r.bottom<=reset.stage.bottom-margin),'reset preserves opening safe margin');
   assert.equal(await page.evaluate(()=>window.metro.hash()),hash);
  }
  await page.close();
 }
} finally {await browser.close();await server.close();}
