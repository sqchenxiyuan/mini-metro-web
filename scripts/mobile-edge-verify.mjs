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
  const overview = page.locator('#map-overview');
  const frame = await page.evaluate(() => ({bounds:window.metro.mobileMapStats().bounds.find(p=>p.id===1), all:window.metro.getState().stations.find(p=>p.id===1).queue.map(q=>q.id)}));
  const seen = new Set();
  // Aim from the owning station's actual projected map position rather than
  // a hard-coded miniature-map pixel that shifts when its size changes.
  const point = await page.evaluate(() => {
    const stats=window.metro.mobileMapStats(),p=stats.bounds.find(p=>p.id===1),r=document.querySelector('#map-overview').getBoundingClientRect();
    const left=Math.min(...stats.bounds.map(v=>v.x-40)),right=Math.max(...stats.bounds.map(v=>v.x+40));
    const top=Math.min(...stats.bounds.map(v=>v.y-24)),bottom=Math.max(...stats.bounds.map(v=>v.pile?v.pile.y+v.pile.height+12:v.y+42));
    const scale=Math.min((r.width-12)/(right-left),(r.height-12)/(bottom-top));
    return {x:(r.width-(right-left)*scale)/2+(p.x-left)*scale,y:(r.height-(bottom-top)*scale)/2+(p.y-top)*scale};
  });
  await overview.click({position:point});
  for(let n=0;n<20;n++) {
    const ids = await page.evaluate(()=>window.metro.mobileMapStats().visibleDrawnPassengerIds);
    for(const id of ids) if(frame.all.includes(id)) seen.add(id);
    await page.mouse.move(180,245);await page.mouse.down();await page.mouse.move(180,145,{steps:2});await page.mouse.up();
  }
  assert.deepEqual(seen,new Set(frame.all),'all passengers of a tall pile must be scroll-reachable');
  await page.close();
  const creative = await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
  await creative.goto(process.env.METRO_TEST_URL ?? 'http://127.0.0.1:5175/', {waitUntil:'networkidle'});
  await creative.waitForFunction(()=>window.metro);
  await creative.evaluate(()=>window.metro.restart({mode:'creative',seed:420}));
  // Set placement through real UI (not private app variables).
  await creative.locator('#tools-toggle').click();
  console.log('creative controls',await creative.locator('#inspector').innerText());
  await creative.close();
} finally { await browser.close(); }
