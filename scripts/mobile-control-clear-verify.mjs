import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const out = '/opt/data/cache/scratch/metro-control-clear';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH });
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/';
const rect = r => ({ x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height });
const intersects = (a,b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

async function probe(page, label) {
  const result = await page.evaluate(() => {
    const stage = document.querySelector('#stage').getBoundingClientRect();
    const selectors = ['#map-overview','.map-tools','#zoom-out','#zoom-reset','#zoom-in','#screenshot','#mobile-crowd-alert','#station-peek','.left-panel','.topbar','.transport-bar'];
    const overlays = selectors.flatMap(selector => {
      const element = document.querySelector(selector);
      if (!element || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return [];
      const r = element.getBoundingClientRect();
      return [{selector,rect:{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}];
    });
    const visible = window.metro.mobileMapStats().visiblePositions.filter(p => p.x >= 0 && p.x < stage.width && p.y >= 0 && p.y < stage.height).map(p => ({id:p.id,shape:p.shape,x:stage.x+p.x,y:stage.y+p.y}));
    const collisions = overlays.flatMap(({selector,rect:r}) => visible.filter(p => p.x>=r.x && p.x<r.right && p.y>=r.y && p.y<r.bottom).map(p => ({selector,...p})));
    return {visible:visible.length,overlays,collisions,stage:{x:stage.x,y:stage.y,right:stage.right,bottom:stage.bottom,height:stage.height},viewport:[innerWidth,innerHeight]};
  });
  await page.screenshot({path:`${out}/${label}.png`});
  assert.deepEqual(result.viewport,[320,Number(label.slice(4,7))],`${label}: native viewport`);

  if(label.endsWith('-default')) assert.ok(result.visible>0,`${label}: real painted glyphs required`);
  const mapOverlays = new Set(['#map-overview','.map-tools','#zoom-out','#zoom-reset','#zoom-in','#screenshot','#mobile-crowd-alert','#station-peek','.left-panel','.topbar','.transport-bar']);
  for (const overlay of result.overlays.filter(o=>mapOverlays.has(o.selector))) {
    if (overlay.selector === '.transport-bar') continue;
    assert.ok(!intersects(overlay.rect,result.stage),`${label}: ${overlay.selector} intrudes on drawable stage`);
  }
  assert.equal(result.collisions.length,0,`${label}: opaque overlays hide glyph centers: ${JSON.stringify(result.collisions.slice(0,24))}`);
  for (const selector of ['#map-overview','.map-tools']) {
    const overlay=result.overlays.find(o=>o.selector===selector);
    assert.ok(overlay && !intersects(overlay.rect,result.stage),`${label}: ${selector} must be reserved outside the drawable map`);
  }
  return {label,visible:result.visible,collisions:result.collisions.length,stage:result.stage,overlays:result.overlays};
}
try {
  const results=[];
  for (const height of [480,600]) {
    const page=await browser.newPage({viewport:{width:320,height},deviceScaleFactor:1,isMobile:true,hasTouch:true});
    await page.goto(url,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>window.metro?.mobileMapStats());
    await page.evaluate(()=>{const m=window.metro;m.restart({mode:'endless',seed:420});m.pause();for(let i=0;i<2;i++){let s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200)}let s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});});
    await page.waitForTimeout(150);
    results.push(await probe(page,`320x${height}-default`));
    const hit = await page.evaluate(() => {
      const elements = ['#map-overview','#zoom-out','#zoom-reset','#zoom-in','#screenshot'].map(selector=>{
        const r=document.querySelector(selector).getBoundingClientRect();
        return {selector,top:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id};
      });
      return elements;
    });
    for (const {selector,top} of hit) assert.equal(top,selector.slice(1),`${height}: ${selector} center hit target, not a sibling`);
    const centerBefore = await page.evaluate(()=>window.metro.mobileMapStats().center);
    await page.locator('#map-overview').click({position:{x:14,y:20}});
    assert.notDeepEqual(await page.evaluate(()=>window.metro.mobileMapStats().center),centerBefore,`${height}: overview tap pans, not intercepted by adjacent controls`);
    const mostCrowded=await page.evaluate(()=>window.metro.getState().stations.filter(s=>s.crowd>0).sort((a,b)=>b.crowd-a.crowd||a.id-b.id)[0].id);
    await page.locator('#mobile-crowd-alert').click();
    const focused=await page.evaluate(id=>{
      const p=window.metro.projectStation(id),r=document.querySelector('#stage').getBoundingClientRect();
      return {x:p.x,y:p.y,stage:r.toJSON(),peek:document.querySelector('#station-peek').hidden};
    },mostCrowded);
    assert.ok(focused.x>=focused.stage.left&&focused.x<=focused.stage.right&&focused.y>=focused.stage.top&&focused.y<=focused.stage.bottom,`${height}: alert centers crowded station`);
    assert.ok(focused.peek,`${height}: ordinary page keeps legacy peek hidden`);
    await page.waitForTimeout(150);
    results.push(await probe(page,`320x${height}-detail`));
    await page.close();
  }
  console.log(JSON.stringify({ok:true,results,screenshots:out},null,2));
} finally {await browser.close();}
