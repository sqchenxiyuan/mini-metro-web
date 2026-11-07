import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const out = '/opt/data/cache/scratch/metro-peek-clear';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless:true,
  executablePath:process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader'] });
const url = process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/integration.html';
const intersects = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const results=[];
try {
  for (const {width,height,mapFirst} of [
    {width:390,height:844,mapFirst:false},
    {width:320,height:480,mapFirst:true},
    {width:320,height:480,mapFirst:false},
  ]) {
    const label=`${width}x${height}-${mapFirst?'map-first':'normal'}`;
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1,isMobile:true,hasTouch:true});
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(url,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>window.metro?.mobileMapStats());
    if ((await page.locator('#map-first-toggle').getAttribute('aria-pressed')==='true')!==mapFirst)
      await page.locator('#map-first-toggle').click();
    await page.evaluate(()=>{
      const m=window.metro;m.restart({mode:'endless',seed:420});m.pause();
      for(let i=0;i<9;i++){const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200);}
      const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});
    });
    assert.equal(await page.evaluate(()=>window.metro.getState().stations.find(s=>s.id===1).queue.length),122,`${label}: real dense seed`);
    await page.locator('#mobile-crowd-alert').click();
    assert.ok(await page.locator('#station-peek').isVisible(),`${label}: alert opens detail`);
    await page.locator('#game-shell').scrollIntoViewIfNeeded();
    const selected=Number((await page.locator('#station-peek').innerText()).match(/车站 (\d+)/)?.[1]);
    assert.ok(Number.isInteger(selected),`${label}: card names selected station`);
    const probe=()=>page.evaluate(id=>{
      const box=e=>e.getBoundingClientRect().toJSON(),stage=box(document.querySelector('#stage'));
      const stats=window.metro.mobileMapStats();
      const radius=3*stats.zoom;
      const glyphs=stats.visiblePositions.filter(p=>p.x+radius>0&&p.x-radius<stage.width&&p.y+radius>0&&p.y-radius<stage.height)
        .map(p=>({id:p.id,left:Math.max(stage.left,stage.left+p.x-radius),right:Math.min(stage.right,stage.left+p.x+radius),
          top:Math.max(stage.top,stage.top+p.y-radius),bottom:Math.min(stage.bottom,stage.top+p.y+radius)}));
      const cues=[...document.querySelectorAll('.mobile-owner-cue')].map(e=>({text:e.textContent,rect:box(e)}));
      return {peek:box(document.querySelector('#station-peek')),stage,station:window.metro.projectStation(id),
        glyphs,cues,controls:['.left-panel .line-choice','#line-tools-toggle','#mobile-crowd-alert','#map-overview']
          .map(s=>document.querySelector(s)).filter(e=>e&&e.getClientRects().length).map(e=>({name:e.id||e.className,rect:box(e)})),
        viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight]};
    },selected);
    const check=(v,phase)=>{
      assert.ok(v.stage.height >= (mapFirst?260:height<600?80:300),`${label} ${phase}: drawable map height ${v.stage.height}`);
      assert.ok(!intersects(v.peek,v.stage),`${label} ${phase}: card overlaps drawable stage ${JSON.stringify(v)}`);
      assert.ok(v.station.x>=v.stage.left+20&&v.station.x<=v.stage.right-20&&v.station.y>=v.stage.top+20&&v.station.y<=v.stage.bottom-20,
        `${label} ${phase}: selected station is visible in map ${JSON.stringify(v.station)} ${JSON.stringify(v.stage)}`);
      assert.deepEqual(v.glyphs.filter(g=>intersects(g,v.peek)),[],`${label} ${phase}: painted passenger glyphs covered, peek=${JSON.stringify(v.peek)} stage=${JSON.stringify(v.stage)}`);
      assert.deepEqual(v.cues.filter(c=>intersects(c.rect,v.peek)||intersects(c.rect,v.stage)),[],`${label} ${phase}: owner cue covered by card or stage`);
      assert.deepEqual(v.controls.filter(c=>intersects(c.rect,v.peek)),[],`${label} ${phase}: card covers control`);
      assert.equal(v.document[0],v.viewport[0],`${label} ${phase}: no horizontal overflow in scrolling integration page`);
    };
    await page.waitForTimeout(170);
    const focused=await probe();check(focused,'alert focus');
    await page.screenshot({path:`${out}/${label}-alert.png`});
    const centerBefore=await page.evaluate(()=>window.metro.mobileMapStats().center);
    await page.locator('#map-overview').focus();await page.keyboard.press('ArrowDown');
    assert.notDeepEqual(await page.evaluate(()=>window.metro.mobileMapStats().center),centerBefore,`${label}: map pannable with card open`);
    // Real repeated drag pans move station 1 above the stage while retaining its waiting passengers.
    let cueProbe=null;
    for(let step=0;step<30;step++) {
      const v=await probe();
      if(v.cues.some(c=>c.text.startsWith(`↑${selected} `))){cueProbe=v;break;}
      if(v.station.y < v.stage.top - 18 && v.glyphs.length===0) break; // Pile has fully passed the cue's visible edge.
      const r=v.stage,x=Math.round(r.left+r.width/2),from=r.top+Math.max(48,r.height*.57);
      await page.mouse.move(x,from);await page.mouse.down();await page.mouse.move(x,from-24,{steps:4});await page.mouse.up();
    }
    assert.ok(cueProbe,`${label}: offscreen selected owner cue appears while its pile remains in view; last=${JSON.stringify(await probe())}`);
    // The selected owner has intentionally left the viewport; only inspect cue and map now.
    assert.ok(!intersects(cueProbe.peek,cueProbe.stage),`${label}: card clear of stage after pan`);
    assert.deepEqual(cueProbe.glyphs.filter(g=>intersects(g,cueProbe.peek)),[],`${label}: no visible passenger obscured after pan`);
    assert.deepEqual(cueProbe.cues.filter(c=>intersects(c.rect,cueProbe.peek)||intersects(c.rect,cueProbe.stage)),[],`${label}: owner cue remains clear after pan`);
    const owner=page.locator('.mobile-owner-cue').filter({hasText:new RegExp(`^↑${selected} `)}).first();
    await page.screenshot({path:`${out}/${label}-offscreen-owner.png`});
    await owner.click();
    const returned=await probe();check(returned,'owner return');
    assert.deepEqual(errors,[],`${label}: no browser errors`);
    results.push({label,selected,focused:{stage:focused.stage,peek:focused.peek,glyphs:focused.glyphs.length},
      offscreen:{stage:cueProbe.stage,peek:cueProbe.peek,cues:cueProbe.cues.map(c=>c.text)},returned:returned.station});
    await page.close();
  }
  console.log(JSON.stringify({ok:true,results,screenshots:out},null,2));
} finally {await browser.close();}
