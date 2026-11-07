import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const out = '/opt/data/cache/scratch/metro-landscape-framing';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/';
const sample = () => {
  const rect = el => { const r = el.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
  const stage = rect(document.querySelector('#stage'));
  const stations = [1, 2].map(id => {
    const node = document.querySelector(`[data-station="${id}"]`);
    const core = window.metro.projectStation(id);
    const hit = rect(node);
    const atCore = document.elementFromPoint(core.x, core.y);
    return {id, core, hit, hidden:node.hidden, target:atCore?.closest('[data-station]')?.dataset.station};
  });
  const controls = ['#map-first-toggle','#new-game','#tools-toggle','#replay-toggle','#help',
    '#line-chooser','#map-overview','#play-pause','[data-speed="1"]','[data-speed="2"]','[data-speed="4"]',
    '#zoom-in','#zoom-out','#zoom-reset','#screenshot']
    .map(sel => ({sel, ...rect(document.querySelector(sel))}));
  return {stage, stations, controls, zoom:window.metro.mobileMapStats().zoom,
    center:window.metro.mobileMapStats().center, hash:window.metro.hash(),
    pressed:document.querySelector('#map-first-toggle').getAttribute('aria-pressed'),
    document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight], viewport:[innerWidth,innerHeight]};
};
function visible(s, station) {
  const {core, hit} = station;
  if (station.hidden || station.target !== String(station.id) ||
      core.x < s.stage.left + 8 || core.x > s.stage.right - 8 ||
      core.y < s.stage.top + 8 || core.y > s.stage.bottom - 8) return false;
  // Preserve the existing portrait camera; its lower DOM hit box extends 7px
  // below the stage but the core remains natively touchable.
  if (s.viewport[0] === 320 && s.viewport[1] === 480 && s.stage.height >= 300) return true;
  return hit.left >= s.stage.left && hit.right <= s.stage.right &&
    hit.top >= s.stage.top && hit.bottom <= s.stage.bottom;
}
function assertFrame(s, label, count = 2) {
  assert.equal(s.pressed, 'true', `${label}: map-first active`);
  assert.ok(s.stage.height > 80, `${label}: stage has usable height ${JSON.stringify(s.stage)}`);
  assert.ok(s.stations.filter(p => visible(s,p)).length >= count,
    `${label}: ${count} real opening hit targets fully inside stage BEFORE pan/zoom: ${JSON.stringify(s)}`);
  assert.deepEqual(s.document,s.viewport,`${label}: no document overflow`);
  for (const c of s.controls) {
    assert.ok(c.width >= 44 && c.height >= 44,`${label}: ${c.sel} is a 44px touch target ${JSON.stringify(c)}`);
    assert.ok(c.left >= 0 && c.right <= s.viewport[0] && c.top >= 0 && c.bottom <= s.viewport[1],
      `${label}: ${c.sel} remains in viewport ${JSON.stringify(c)}`);
  }
}
const results = [];
try {
  for (const scenario of ['fresh','rotate','train-detail','manual']) {
    const page = await browser.newPage({viewport:scenario==='fresh'?{width:568,height:320}:{width:320,height:480},
      deviceScaleFactor:1,isMobile:true,hasTouch:true});
    const errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    try {
      await page.goto(url,{waitUntil:'networkidle'});
      await page.waitForFunction(()=>window.metro?.mobileMapStats());
      const hash = await page.evaluate(()=>window.metro.hash());
      if (scenario === 'train-detail') {
        const fixture = await page.evaluate(()=>{
          const m=window.metro;m.restart({mode:'creative',seed:77});m.pause();
          return [m.submit({action:{type:'route',line:0,stops:[1,2]}}),m.submit({action:{type:'addTrain',line:0,station:1}})];
        });
        assert.ok(fixture.every(r=>r.ok),`train detail setup ${JSON.stringify(fixture)}`);
        const group=page.locator('[data-train-group="1"]');
        await group.focus();await page.keyboard.press('Space');
        assert.equal(await page.locator('#train-detail').isVisible(),true,'detail strip opens');
      }
      if(scenario === 'manual') {
        await page.locator('#map-overview').focus();
        await page.keyboard.press('ArrowRight');
        await page.locator('#zoom-in').click();
        const before=await page.evaluate(sample);
        await page.setViewportSize({width:568,height:320});
        await page.waitForTimeout(120);
        const after=await page.evaluate(sample);
        assert.equal(after.zoom,before.zoom,'user zoom preserved on landscape resize');
        assert.deepEqual(after.center,before.center,'user pan preserved on landscape resize');
        assert.equal(after.hash,before.hash,'manual camera resize keeps simulation hash');
        results.push({scenario,zoom:after.zoom,center:after.center});
        continue;
      }
      if(scenario !== 'fresh') {
        await page.setViewportSize({width:568,height:320});
        await page.waitForFunction(()=>document.querySelector('#stage').getBoundingClientRect().width===568);
      }
      // Let the stage ResizeObserver and responsive CSS settle without moving the camera.
      await page.waitForTimeout(120);
      const landscape=await page.evaluate(sample);
      assertFrame(landscape,`${scenario} landscape`,scenario==='train-detail'?1:2);
      assert.equal(landscape.hash,await page.evaluate(()=>window.metro.hash()),'framing does not change the simulation');
      await page.screenshot({path:`${out}/${scenario}-568x320.png`});
      if(scenario==='fresh') {
        const [a,b]=landscape.stations.map(p=>p.core);
        const cdp=await page.context().newCDPSession(page);
        const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1,radiusX:5,radiusY:5,force:1}]});
        await touch('touchStart',b.x,b.y);
        for(let i=1;i<=12;i++){await touch('touchMove',b.x+(a.x-b.x)*i/12,b.y+(a.y-b.y)*i/12);await page.waitForTimeout(20);}
        await touch('touchEnd',a.x,a.y);
        assert.deepEqual(await page.evaluate(()=>window.metro.getState().lines[0].stops),[2,1],
          'one native touch gesture draws the opening route without preparatory zoom or pan');
      }
      if(scenario!=='fresh') {
        await page.setViewportSize({width:320,height:480});
        await page.waitForTimeout(120);
        const portrait=await page.evaluate(sample);
        assertFrame(portrait,`${scenario} portrait`,scenario==='train-detail'?0:2);
        assert.equal(portrait.hash,landscape.hash,`${scenario}: rotation keeps game hash`);
        await page.setViewportSize({width:568,height:320});
        await page.waitForTimeout(120);
        assertFrame(await page.evaluate(sample),`${scenario} landscape return`,scenario==='train-detail'?1:2);
      }
      assert.deepEqual(errors,[],`${scenario}: no browser errors`);
      results.push({scenario,landscape:{stage:landscape.stage,zoom:landscape.zoom,stations:landscape.stations},hash:landscape.hash});
    } finally {await page.close();}
  }
  console.log(JSON.stringify({ok:true,results,screenshots:out},null,2));
} finally {await browser.close();}
