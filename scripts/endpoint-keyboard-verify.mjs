import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const [width, height] of [[1280,800],[568,320],[390,844]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 650, isMobile: width < 650 });
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    await page.evaluate(() => {
      window.metro.restart({ mode: 'creative', seed: 77 }); window.metro.pause();
      const r = window.metro.submit({ action: { type: 'route', line: 0, stops: [1,2] } });
      if (!r.ok) throw Error(JSON.stringify(r));
    });
    const start = page.getByRole('button', { name: /1号线起点.*延长/ });
    const end = page.getByRole('button', { name: /1号线终点.*延长/ });
    await start.waitFor(); await end.waitFor();
    const stage = await page.locator('#stage').boundingBox();
    for (const handle of [start,end]) {
      const box = await handle.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= stage.x && box.y >= stage.y &&
        box.x + box.width <= stage.x + stage.width && box.y + box.height <= stage.y + stage.height,
        `${width}x${height}: full 44px endpoint hit target in stage`);
    }
    const station = page.locator('[data-station="3"]');
    await start.focus(); await page.keyboard.press('Enter');
    assert.equal(await start.getAttribute('aria-pressed'), 'true', 'keyboard arms the chosen handle');
    await page.keyboard.press('Escape');
    assert.deepEqual((await page.evaluate(() => window.metro.getState())).lines[0].stops,[1,2], 'Escape leaves authoritative line intact');
    if (width === 390) {
      for (let i = 0; i < 5; i++) await page.locator('#zoom-out').click();
      await page.locator('#map-overview').focus();
      for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => !document.querySelector('[data-station="3"]').hidden);
      // Pan back until the line's end button and target station are in view together.
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    }
    await end.focus(); await page.keyboard.press('Space');
    await station.focus(); await page.keyboard.press('Enter');
    assert.deepEqual((await page.evaluate(() => window.metro.getState())).lines[0].stops,[1,2,3], 'keyboard commits to exact line end');
    assert.deepEqual((await page.evaluate(() => window.metro.getState())).lines[1].stops,[], 'no new line created');
    if (width === 568) {
      await page.evaluate(() => {
        const m=window.metro;m.restart({ mode:'creative', seed:77 });m.pause();
        m.submit({ action:{ type:'route', line:0, stops:[1,2] } });
      });
      await page.waitForFunction(() => document.querySelectorAll('.endpoint-handle').length === 2);
      const button = await page.getByRole('button', { name: /1号线终点.*延长/ }).boundingBox();
      const target = await page.locator('[data-station="3"]').boundingBox();
      assert.ok(button && target && !await page.locator('[data-station="3"]').isHidden());
      const a={x:button.x+button.width/2,y:button.y+button.height/2},b={x:target.x+target.width/2,y:target.y+target.height/2};
      const cdp=await page.context().newCDPSession(page);
      const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{id:1,x,y,radiusX:5,radiusY:5,force:1}]});
      await touch('touchStart',a.x,a.y);
      for(let i=1;i<=14;i++) await touch('touchMove',a.x+(b.x-a.x)*i/14,a.y+(b.y-a.y)*i/14);
      await touch('touchEnd',b.x,b.y);
      assert.deepEqual((await page.evaluate(() => window.metro.getState())).lines[0].stops,[1,2,3], 'short-landscape touch extends the grabbed route');
    }
    console.log(`${width}x${height} endpoint keyboard access and cancel passed`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
