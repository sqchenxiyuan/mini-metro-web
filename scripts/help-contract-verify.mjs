import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {browserLaunchOptions} from './browser-launch.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();const browser=await chromium.launch(browserLaunchOptions());
try {
 for (const entry of ['', 'integration.html']) {
  const page=await browser.newPage();await page.goto(new URL(entry,server.resolvedUrls.local[0]).href,{waitUntil:'networkidle'});
  await page.locator('#help').click();
  const guide=await page.locator('#help-dialog').innerText();
  assert.match(guide,/车站本体.*新建.*线路/,'body drag creates another line');
  assert.match(guide,/开放线路首尾.*手柄.*延长/,'both handles extend same route');
  assert.match(guide,/环线.*轨道.*空白/,'loop breaking gesture is documented');
  assert.match(guide,/结束后.*回放/,'normal postgame replay is documented');
  assert.doesNotMatch(guide,/右侧移除|点“重画线路”重新规划/,'obsolete inspector directions removed');
  await page.close();
 }
 console.log('human and integration help describe current route gestures and replay');
} finally {await browser.close();await server.close();}
