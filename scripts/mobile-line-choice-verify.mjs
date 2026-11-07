import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const output = '/opt/data/cache/scratch/metro-line-choice';
await mkdir(output,{recursive:true});
const browser = await chromium.launch({headless:true,executablePath:process.env.METRO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH});
const url=process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/';
const overlap=(a,b)=>a.x<b.right&&b.x<a.right&&a.y<b.bottom&&b.y<a.bottom;
try {
  {
    const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
    await page.goto(url,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>window.metro?.mobileMapStats());
    await page.evaluate(()=>{const m=window.metro;m.restart({mode:'endless',seed:420});m.pause();for(let i=0;i<9;i++){const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200);}const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});});
    await page.waitForFunction(()=>document.querySelectorAll('.line-choice').length===7);
    const tools=page.locator('#line-tools-toggle');
    await page.keyboard.press('7');
    await page.waitForFunction(()=>window.metro.controller.selectedLine===6);
    const cue=await page.locator('#line-chooser').boundingBox();
    assert.ok(cue&&cue.width>=44&&cue.height>=44&&cue.x>=0&&cue.x+cue.width<=390,'390x844: keyboard-selected line 7 visibly cued on screen');
    assert.match(await page.locator('#line-chooser').innerText(),/7/,'390x844: cue shows line 7');
    await page.screenshot({path:`${output}/390x844-keyboard-seven-native.png`});
    await page.keyboard.press('1');
    await page.locator('#line-chooser').tap();
    const seven=page.locator('.line-choice[data-line="6"]');
    const sevenBox=await seven.boundingBox();
    const stage=await page.locator('#stage').boundingBox();
    assert.ok(sevenBox&&sevenBox.width>=44&&sevenBox.height>=44&&sevenBox.x>=0&&sevenBox.x+sevenBox.width<=390,'390x844: seventh line has reachable 44px target');
    assert.ok(sevenBox.y+sevenBox.height<=stage.y,'390x844: seventh choice does not cover drawable map');
    await page.mouse.click(sevenBox.x+sevenBox.width/2,sevenBox.y+sevenBox.height/2);
    assert.equal(await page.evaluate(()=>window.metro.controller.selectedLine),6,'390x844: real center tap on line 7 selects it, not tools');
    assert.equal(await tools.getAttribute('aria-expanded'),'false','390x844: line tools stay closed');
    assert.equal(await page.locator('#line-chooser').getAttribute('aria-expanded'),'false','390x844: chooser closes after selection');
    await page.close();
    console.log('390x844: real center tap selects line 7 without tools; keyboard 7 visibly cued');
  }
  for(const [width,height,mapFirst] of [[320,480,true],[320,480,false],[320,600,true],[320,600,false],[390,844,false]]) {
    const label=`human-${width}x${height}-${mapFirst?'map-first':'normal'}`;
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1,isMobile:true,hasTouch:true});
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(url,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>window.metro?.mobileMapStats());
    if((await page.locator('#map-first-toggle').getAttribute('aria-pressed')==='true')!==mapFirst)await page.locator('#map-first-toggle').click();
    await page.evaluate(()=>{const m=window.metro;m.restart({mode:'endless',seed:420});m.pause();for(let i=0;i<9;i++){const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200);}const s=m.getState();if(s.phase==='upgrade')m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});});
    await page.waitForFunction(()=>document.querySelectorAll('.line-choice').length===7);
    const initialHash=await page.evaluate(()=>window.metro.hash());
    await page.locator('#line-tools-toggle').blur();await page.keyboard.press('7');
    await page.waitForFunction(()=>window.metro.controller.selectedLine===6);
    await page.waitForFunction(()=>document.querySelector('#line-chooser')?.textContent.includes('7'));
    assert.equal(await page.locator('#line-chooser').count(),1,`${label}: collapsed active-line chooser exists`);
    const closed=await page.evaluate(()=>{
      const box=s=>document.querySelector(s).getBoundingClientRect().toJSON();
      return {active:box('.line-choice.active'),trigger:box('#line-chooser'),stage:box('#stage'),tools:box('#line-tools-toggle'),overview:box('#map-overview'),mapTools:box('.map-tools'),viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],text:document.querySelector('#line-chooser').textContent,expanded:document.querySelector('#line-chooser').getAttribute('aria-expanded')};
    });
    assert.match(closed.text,/7/,`${label}: collapsed active line visible after keyboard shortcut`);
    assert.equal(closed.expanded,'false',`${label}: chooser starts closed`);
    assert.ok(closed.trigger.width>=44&&closed.trigger.height>=44,`${label}: 44px chooser target`);
    assert.ok(closed.trigger.x>=0&&closed.trigger.right<=width&&closed.trigger.y>=0&&closed.trigger.bottom<=height,`${label}: chooser in viewport ${JSON.stringify(closed)}`);
    assert.deepEqual(closed.document,closed.viewport,`${label}: native viewport`);
    for(const barrier of [closed.stage,closed.tools,closed.overview,closed.mapTools])assert.ok(!overlap(closed.trigger,barrier),`${label}: trigger overlaps map/control ${JSON.stringify(barrier)}`);
    await page.screenshot({path:`${output}/${label}-line7-keyboard.png`});
    await page.locator('#line-chooser').click();
    assert.equal(await page.locator('#line-chooser').getAttribute('aria-expanded'),'true',`${label}: chooser opens`);
    for(let id=0;id<7;id++) {
      const button=page.locator(`.line-choice[data-line="${id}"]`),r=await button.boundingBox();
      assert.ok(r&&r.width>=44&&r.height>=44&&r.x>=0&&r.x+r.width<=width&&r.y>=0&&r.y+r.height<=height,`${label}: line ${id+1} touch target reachable ${JSON.stringify(r)}`);
    }
    await page.screenshot({path:`${output}/${label}-seven-options.png`});
    await page.locator('.line-choice[data-line="3"]').tap();
    assert.equal(await page.evaluate(()=>window.metro.controller.selectedLine),3,`${label}: touch selects fourth line`);
    assert.equal(await page.locator('#line-chooser').getAttribute('aria-expanded'),'false',`${label}: chooser closes after selection`);
    await page.waitForFunction(()=>document.querySelector('#line-chooser').textContent.includes('4'));
    assert.match(await page.locator('#line-chooser').innerText(),/4/,`${label}: touch choice visible in collapsed rail`);
    await page.screenshot({path:`${output}/${label}-line4-touch.png`});
    await page.locator('#mobile-crowd-alert').click();
    assert.equal(await page.locator('#station-peek').isVisible(),false,`${label}: ordinary page has no legacy peek`);
    const focus=await page.evaluate(()=>{
      const stations=window.metro.getState().stations.filter(s=>s.crowd>0).sort((a,b)=>b.crowd-a.crowd||a.id-b.id);
      const stage=document.querySelector('#stage').getBoundingClientRect();
      const p=window.metro.projectStation(stations[0].id);
      return {id:stations[0].id,point:p,stage:stage.toJSON()};
    });
    assert.ok(focus.point.x>=focus.stage.left&&focus.point.x<=focus.stage.right&&focus.point.y>=focus.stage.top&&focus.point.y<=focus.stage.bottom,
      `${label}: crowd alert locates the most crowded station in drawable map`);
    await page.locator('#line-chooser').click();
    const detailOpen=await page.evaluate(()=>{
      const box=s=>document.querySelector(s).getBoundingClientRect().toJSON();
      return {options:box('#line-list'),stage:box('#stage')};
    });
    assert.ok(!overlap(detailOpen.options,detailOpen.stage),`${label}: options outside drawable stage ${JSON.stringify(detailOpen)}`);
    await page.locator('.line-choice[data-line="6"]').tap();
    assert.equal(await page.locator('#station-peek').isVisible(),false,`${label}: line selection does not reveal legacy peek`);
    await page.screenshot({path:`${output}/${label}-line7-after-crowd-focus.png`});
    assert.equal(await page.evaluate(()=>window.metro.hash()),initialHash,`${label}: selection cannot alter game state`);
    assert.deepEqual(errors,[],`${label}: no page errors`);
    console.log(`${label}: seven reachable; keyboard 7 and touch 4 reflected; native viewport`);
    await page.close();
  }
} finally {await browser.close();}
