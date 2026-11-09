import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {browserLaunchOptions} from './browser-launch.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
const browser=await chromium.launch(browserLaunchOptions());
try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});
  await page.evaluate(()=>{
    const m=window.metro;m.pause();const s=m.controller.session.state;
    s.stations[0].queue=Array.from({length:11},(_,i)=>({id:700+i,shape:i<6?'triangle':'square',born:0,transfers:0}));
    m.controller.onChange();
  });
  let result;
  for(let i=0;i<40;i++){
    result=await page.evaluate(()=>({ids:window.metro.mobileMapStats().ownerCueIds,
      stage:document.querySelector('#stage').getBoundingClientRect().toJSON(),
      station:window.metro.projectStation(1),buttons:[...document.querySelectorAll('.mobile-owner-cue')].map(b=>b.textContent)}));
    if(result.ids.includes(1))break;
    await page.locator('#map-overview').focus();await page.keyboard.press('ArrowDown');
  }
  assert.ok(result.ids.includes(1),`no owner cue: ${JSON.stringify(result)}`);
  const cue=page.locator('.mobile-owner-cue').filter({hasText:'1 候车'}).first();
  await cue.focus();
  const before=await cue.evaluate(b=>{window.__focusedCue=b;return b.outerHTML;});
  await page.evaluate(()=>window.metro.step(1));
  const focus=await page.evaluate(()=>({same:document.activeElement===window.__focusedCue,
    connected:window.__focusedCue.isConnected,html:document.activeElement.outerHTML,
    ids:window.metro.mobileMapStats().ownerCueIds}));
  assert.ok(focus.same&&focus.connected,JSON.stringify({before,focus}));
  console.log(JSON.stringify({passed:true,before,focus}));
}finally{await browser.close();await server.close();}
