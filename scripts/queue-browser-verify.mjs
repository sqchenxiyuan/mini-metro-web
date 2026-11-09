import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {browserLaunchOptions} from './browser-launch.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
const browser=await chromium.launch(browserLaunchOptions());
try {
 for(const [width,height] of [[568,320],[390,844],[320,480]]) {
  const page=await browser.newPage({viewport:{width,height},hasTouch:true,isMobile:true});
  page.setDefaultTimeout(5000);
  await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.metro?.mobileMapStats());
  await page.evaluate(()=>{const m=window.metro;m.restart({mode:'endless',seed:420});m.pause();for(let i=0;i<9;i++){const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200)}const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}})});
  await page.waitForFunction(()=>window.metro.getState().stations.length===36);
  const state=await page.evaluate(()=>({hash:window.metro.hash(),stations:window.metro.getState().stations.map(s=>({id:s.id,queue:s.queue}))}));
  const grouped=state.stations.filter(s=>s.queue.length>10);
  const open=page.locator('#queue-browser-toggle');
  const bounds=await open.boundingBox();
  assert.ok(bounds&&bounds.width>=44&&bounds.height>=44,'native browser opener is at least 44x44');
  const overview=await page.locator('#map-overview').boundingBox();
  assert.ok(overview&&(bounds.x>=overview.x+overview.width||overview.x>=bounds.x+bounds.width||bounds.y>=overview.y+overview.height||overview.y>=bounds.y+bounds.height),'queue browser button must not cover the overview');
  for(const selector of ['#zoom-out','#zoom-reset','#zoom-in']) {
   const b=await page.locator(selector).boundingBox();
   assert.ok(b&&(bounds.x>=b.x+b.width||b.x>=bounds.x+bounds.width||bounds.y>=b.y+b.height||b.y>=bounds.y+bounds.height),'queue browser button must not cover map zoom controls');
  }
  assert.equal(await open.isVisible(),true,'station queue browser needs a native entry outside the map');
  const header=await page.locator('.topbar').boundingBox();
  assert.ok(header&&bounds.x>=header.x&&bounds.x+bounds.width<=header.x+header.width&&
    bounds.y>=header.y&&bounds.y+bounds.height<=header.y+header.height,'queue opener stays entirely in the header control rail');
  const tools=await page.locator('#line-tools-toggle').boundingBox();
  assert.ok(tools&&(bounds.x>=tools.x+tools.width||tools.x>=bounds.x+bounds.width||bounds.y>=tools.y+tools.height||tools.y>=bounds.y+bounds.height),'queue opener does not intercept line tools');
  assert.equal(await open.evaluate(e=>document.elementFromPoint(e.getBoundingClientRect().x+e.clientWidth/2,e.getBoundingClientRect().y+e.clientHeight/2)===e),true,'queue opener center hits itself');
  if(width===320) {
   await open.focus();await page.keyboard.press('Enter');
   const dialog=page.locator('#queue-browser');
   await dialog.locator(`[data-queue-station="${grouped.at(-1).id}"]`).focus();
   await page.keyboard.press('Enter');
   assert.equal(await dialog.locator('[data-queue-shape]').count()>0,true,'last dense station reachable by keyboard');
   await dialog.locator('#queue-browser-close').click();
   assert.equal(await page.evaluate(()=>window.metro.hash()),state.hash);
   console.log(JSON.stringify({viewport:[width,height],lastReachable:true,hashUnchanged:true}));
  }
  for(const station of grouped) {
   await open.click();
   const dialog=page.locator('#queue-browser');
   assert.equal(await dialog.isVisible(),true);
   await dialog.locator(`[data-queue-station="${station.id}"]`).click();
   const card=await dialog.locator(`[data-queue-station="${station.id}"]`).evaluate(e=>{
    const range=document.createRange();range.selectNodeContents(e);
    return {lines:range.getClientRects().length,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight};
   });
   assert.ok(card.lines===1&&card.scrollWidth<=card.clientWidth&&card.scrollHeight<=card.clientHeight,
    `station ${station.id}: browser card must remain single-line and uncut at ${width}x${height}: ${JSON.stringify(card)}`);
   if(station===grouped[0]) {
    const list=dialog.locator('.queue-station-list');
    assert.equal(await list.evaluate(e=>e.scrollHeight>e.clientHeight),true,'dense station list scrolls within modal');
    await page.screenshot({path:`/opt/data/cache/scratch/metro-acceptance/${width}x${height}-queue-browser.png`});
    const snapshot=await page.evaluate(()=>({button:document.querySelector('#queue-browser-toggle').getBoundingClientRect().toJSON(),dialog:document.querySelector('#queue-browser').getBoundingClientRect().toJSON(),stage:document.querySelector('#stage').getBoundingClientRect().toJSON(),list:document.querySelector('.queue-station-list').getBoundingClientRect().toJSON(),detail:document.querySelector('#queue-browser-detail').getBoundingClientRect().toJSON(),controls:[...document.querySelectorAll('#queue-browser > button')].map(e=>e.getBoundingClientRect().toJSON()),groups:[...document.querySelectorAll('#queue-browser-detail [data-queue-shape]')].map(e=>e.getBoundingClientRect().toJSON())}));
    const {dialog:panel,list:listRect,detail,controls,groups:labels}=snapshot;
    for(const label of labels)assert.ok(label.top>=detail.top&&label.bottom<=detail.bottom,'selected destination label fully within detail');
    assert.ok(detail.top>=listRect.bottom-1,'list must not overlap destination detail');
    for(const button of controls)assert.ok(button.top>=detail.bottom-1&&button.bottom<=panel.bottom,'controls fully inside dialog below detail');
    console.log(JSON.stringify({viewport:[width,height],geometry:snapshot}));
   }
   const entries=await dialog.locator('[data-queue-shape]').evaluateAll(nodes=>nodes.map(n=>({shape:n.dataset.queueShape,count:Number(n.dataset.queueCount)})));
   const expected=[...new Set(station.queue.map(p=>p.shape))].sort().map(shape=>({shape,count:station.queue.filter(p=>p.shape===shape).length}));
   assert.deepEqual(entries.sort((a,b)=>a.shape.localeCompare(b.shape)),expected,`station ${station.id}: all actual destination counts`);
   assert.equal(entries.reduce((sum,g)=>sum+g.count,0),station.queue.length);
   const stageBeforeFocus=await page.locator('#stage').evaluate(e=>e.getBoundingClientRect().height);
   await dialog.locator('#queue-focus-pile').click();
   await page.waitForFunction(id=>{const node=document.querySelector(`[data-station="${id}"]`),p=window.metro.projectStation(id);if(!node)return false;const r=node.getBoundingClientRect();return Math.abs(r.y-(p.y-5))<1},station.id);
   await page.waitForTimeout(80);
   const focus=await page.evaluate(()=>({stats:window.metro.mobileMapStats(),stage:document.querySelector('#stage').getBoundingClientRect().toJSON()}));
   const groups=focus.stats.queueGroups.find(g=>g.stationId===station.id)?.groups;
   assert.ok(groups?.every(g=>g.visible),`station ${station.id}: queue reachable after explicit focus at ${width}x${height}: ${JSON.stringify({groups,stage:focus.stage,center:focus.stats.center,zoom:focus.stats.zoom})}`);
   const box=await page.locator(`[data-station="${station.id}"]`).boundingBox();
   const stage=focus.stage;

   assert.ok(box,`station ${station.id}: focused 44px target is present at ${width}x${height}: ${JSON.stringify({groups,stage,zoom:focus.stats.zoom,center:focus.stats.center,projection:await page.evaluate(id=>window.metro.projectStation(id),station.id)})}`);
   assert.equal(box.width,44,`station ${station.id}: focused target stays exactly 44px wide`);
   assert.equal(box.height,44,`station ${station.id}: focused target stays exactly 44px high`);
   assert.ok(groups?.every(g=>g.x-8>=0&&g.x+42<=stage.width&&g.y-8>=0&&g.y+8<=stage.height),
    `station ${station.id}: complete grouped pile (icon and count) fits focused stage at ${width}x${height}: ${JSON.stringify({groups,stage})}`);
   if(width===568&&stageBeforeFocus>stage.height)
    assert.equal(stageBeforeFocus-stage.height,44,'offscreen-owner cue reserves a 44px row during focus');
   assert.ok(box&&box.x>=stage.x+12&&box.x+box.width<=stage.right-12&&box.y>=stage.y+12&&box.y+box.height<=stage.bottom-12,
    `station ${station.id}: focused 44px target keeps 12px safety margin at ${width}x${height}: ${JSON.stringify({box,stage,zoom:focus.stats.zoom,center:focus.stats.center})}`);
   if(station===grouped[0]) {
    await page.keyboard.press('Tab');
    await open.focus();await page.keyboard.press('Enter');
    assert.equal(await dialog.isVisible(),true,'keyboard Enter opens station browser');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(),false,'Escape closes station browser');
   }
  }
  assert.equal(await page.evaluate(()=>window.metro.hash()),state.hash,'navigation cannot alter authoritative game state');
  console.log(JSON.stringify({viewport:[width,height],stations:grouped.length,allExact:true,allReachable:true,hashUnchanged:true}));
  await page.close();
 }
} finally {await browser.close();await server.close();}
