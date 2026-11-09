import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH, args: ['--enable-webgl','--use-gl=angle','--use-angle=swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 480 }, hasTouch: true });
  await page.goto(process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/', { waitUntil:'networkidle' });
  await page.waitForFunction(() => window.metro);
  await page.evaluate(() => {
    const m=window.metro; m.restart({mode:'endless',seed:420});m.pause();
    for(let i=0;i<9;i++) {const s=m.getState();if(s.phase==='upgrade') m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});m.step(4200)}
    const s=m.getState();if(s.phase==='upgrade') m.submit({action:{type:'upgrade',choice:s.upgrades[0]}});
  });
  const count = await page.evaluate(() => window.metro.getState().stations.find(s => s.id === 1).queue.length);
  assert.ok(count > 100);
  const frame = await page.evaluate(() => ({groups:window.metro.mobileMapStats().queueGroups.find(g=>g.stationId===1)?.groups.length,
    all:window.metro.getState().stations.find(p=>p.id===1).queue.map(q=>q.id)}));
  assert.equal(frame.groups,await page.evaluate(()=>new Set(window.metro.getState().stations.find(s=>s.id===1).queue.map(q=>q.shape)).size),
    'dense station groups every destination shape');
  const beforePan = await page.evaluate(()=>window.metro.mobileMapStats().center);
  await page.locator('#queue-browser-toggle').click();
  await page.locator('[data-queue-station="1"]').click();
  await page.locator('#queue-focus-station').click();
  const stage=await page.locator('#stage').boundingBox();
  const x=stage.x+stage.width/2, low=stage.y+stage.height-35;
  await page.mouse.move(x,low);await page.mouse.down();
  await page.mouse.move(x,stage.y+45,{steps:8});await page.mouse.up();
  assert.notDeepEqual(await page.evaluate(()=>window.metro.mobileMapStats().center),beforePan,'genuine drag pans dense mobile map');
  assert.equal(await page.evaluate(()=>window.metro.mobileMapStats().queueGroups.find(g=>g.stationId===1)?.groups.length),frame.groups,'all destination groups survive pan');
  await page.close();
  const creative = await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
  await creative.goto(process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/', {waitUntil:'networkidle'});
  await creative.waitForFunction(()=>window.metro);
  await creative.evaluate(()=>window.metro.restart({mode:'creative',seed:420}));
  assert.equal(await creative.evaluate(()=>window.metro.getState().mode),'creative');
  await creative.close();
} finally { await browser.close(); }
