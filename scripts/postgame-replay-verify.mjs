import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { runAgent, RULES } from '../dist-sdk/index.mjs';
import { browserLaunchOptions } from './browser-launch.mjs';
const server = await createServer({ server: { host:'127.0.0.1', port:0 }, logLevel:'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
 const page = await browser.newPage({viewport:{width:1280,height:800}});
 await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});await page.waitForFunction(()=>window.metro);
 assert.equal(await page.locator('#postgame-replay:visible').count(),0,'no replay tools during live game');
 const completed = await runAgent({seed:420,maxTicks:20*60*RULES.hz});
 assert.equal(completed.reason,'over');
 await page.evaluate((replay)=>{window.metro.loadReplay(replay);window.metro.seek(replay.duration)},completed.replay);
 await page.evaluate(()=>document.querySelector('#over-replay')?.click());
 assert.equal(await page.evaluate(()=>window.metro.controller.mode),'replay');
 await page.locator('#postgame-replay').waitFor({state:'visible'});
 const slider=page.locator('#postgame-timeline');
 assert.ok(Number(await slider.getAttribute('max'))>=completed.replay.duration);
 await slider.fill(String(30*RULES.hz));
 await page.waitForFunction((tick) => window.metro.getState().tick === tick, 30*RULES.hz);
 assert.equal(await page.evaluate(()=>window.metro.getState().tick),30*RULES.hz);
 console.log(JSON.stringify({passed:true,postgameReplay:true,gameTicks:completed.replay.duration}));
}finally{await browser.close();await server.close();}
