import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';

const evidence = process.env.METRO_RESOURCE_EVIDENCE ?? '/opt/data/cache/scratch/resource-drag-evidence';
const before = process.argv.includes('--before');
const cases = [];
await mkdir(evidence, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(browserLaunchOptions());
try {
  for (const entry of ['', 'integration.html']) for (const [width, height] of [[1280,800],[390,844],[568,320],[320,480]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 650, isMobile: width < 650,
      recordVideo: { dir: `${evidence}/video`, size: { width, height } } });
    const page = await context.newPage();
    await page.goto(server.resolvedUrls.local[0] + entry, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.metro);
    await page.evaluate(async () => { await document.fonts.ready; window.metro.pause(); });
    await page.screenshot({ path: `${evidence}/${before ? 'before' : 'after'}-${entry ? 'integration' : 'play'}-${width}x${height}.png` });
    if (!before) {
      assert.equal(await page.locator('[data-resource="locomotive"]').count(), 1, 'a stable directly draggable locomotive stock button exists');
      await page.evaluate(async () => {
        const { MetroRenderer } = await import('/src/renderer.ts');
        const draw = MetroRenderer.prototype.drawLane;
        MetroRenderer.prototype.drawLane = function(...args) { window.__resourceScene = this; return draw.apply(this, args); };
        const m = window.metro; m.restart({ mode: 'creative', seed: 420 }); m.pause();
        m.submit({ action: { type: 'route', line: 0, stops: [1,2,3] } });
      });
      if (entry) {
        await page.evaluate(() => { const top = document.querySelector('#game-shell').getBoundingClientRect().top + scrollY; scrollTo(0, top); });
        await page.waitForTimeout(100);
      }
      const toggle = page.locator('#resource-toggle');
      if (await toggle.isVisible()) await toggle.click();
      const stock = page.locator('[data-resource="locomotive"]');
      const box = await stock.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, 'resource stock has a true 44px source');
      const targetAt = () => page.evaluate(() => {
        const scene = window.__resourceScene, stage = document.querySelector('#stage').getBoundingClientRect();
        const edge = scene.getPaintedTrackLayout().segments.find(e => e.lanes.some(l => l.lineId === 0));
        const lane = edge.lanes.find(l => l.lineId === 0);
        const vertices = scene.trackVertices(edge.points, lane.offset, .43,
          edge.laneEndpoints?.find(e => e.lineId === 0) ?? edge.endpointOffsets);
        const path = scene.laneCurve(vertices), p = path.getPoint(.5), q = scene.project(p.x,p.z,p.y);
        return { x: q.x + stage.left, y: q.y + stage.top };
      });
      let target = await targetAt();
      const initial = await page.evaluate(() => ({ hash: window.metro.hash(), stock: window.metro.getState().resources.locomotives,
        decisions: window.metro.controller.decisions.length }));
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 18 });
      assert.equal(await page.evaluate(() => window.metro.hash()), initial.hash, 'hover is visual only');
      const trayGeometry = await page.evaluate(() => [...document.querySelectorAll('#resource-toggle, .resource-stock')].map(e => ({ name:e.id || e.dataset.stock, rect:e.getBoundingClientRect().toJSON() })));
      for (const item of trayGeometry.filter(item => item.rect.width)) {
        assert.ok(item.rect.x >= 0 && item.rect.right <= width && item.rect.y >= 0 && item.rect.bottom <= height, `${item.name} remains inside native viewport`);
      }
      await page.screenshot({ path: `${evidence}/preview-${entry ? 'integration' : 'play'}-${width}x${height}.png` });
      assert.equal(await page.locator('#resource-preview[data-valid="true"]').count(), 1, 'release target is explicitly previewed');
      await page.mouse.up();
      const result = await page.evaluate(() => ({ stock: window.metro.getState().resources.locomotives, decisions: window.metro.controller.decisions.length }));
      assert.equal(result.stock, initial.stock - 1, 'native mouse release consumes exactly one locomotive');
      assert.equal(result.decisions, initial.decisions + 1, 'one committed action');
      const snapshot = () => page.evaluate(() => ({ hash: window.metro.hash(), stock: window.metro.getState().resources,
        decisions: window.metro.controller.decisions.length, mode: window.metro.controller.mode, source: window.metro.controller.activeAgentSource }));
      let startPoint = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      // Keyboard never dispatches just because a line is selected.
      await stock.evaluate(e=>e.focus({preventScroll:true})); const keyBefore = await snapshot();
      await page.keyboard.press('Enter'); assert.deepEqual(await snapshot(), keyBefore);
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#resource-preview[data-valid="true"]').count(), 1);
      await page.keyboard.press('Enter');
      assert.equal((await snapshot()).stock.locomotives, keyBefore.stock.locomotives - 1);
      // Keyed inventory source and focus survive ordinary UI updates.
      assert.equal(await stock.evaluate(e => { window.__stockSource = e; e.focus({preventScroll:true}); window.metro.controller.onChange(); return window.__stockSource === document.querySelector('[data-resource="locomotive"]') && document.activeElement === e; }), true);
      // A direct carriage drop uses a real projected core, then a line drop has an explicit train preview.
      const car = page.locator('[data-resource="carriage"]'), carBox = await car.boundingBox();
      const core = await page.evaluate(() => { const r = document.querySelector('#stage').getBoundingClientRect(), s = window.metro.getState(); const id=s.trains[0].id,p=window.__resourceScene.projectTrain(id); return { x:p.x+r.left,y:p.y+r.top,id }; });
      const carBefore = await snapshot();
      await page.mouse.move(carBox.x+22,carBox.y+22); await page.mouse.down(); await page.mouse.move(core.x,core.y,{steps:15});
      assert.equal(await page.locator('#resource-preview[data-valid="true"]').count(),1,'carriage core target preview');
      assert.match(await page.locator('#resource-preview span').textContent(),new RegExp(`${core.id} 号列车`));
      await page.mouse.up(); assert.equal((await snapshot()).stock.carriages,carBefore.stock.carriages-1);
      await page.mouse.move(carBox.x+22,carBox.y+22); await page.mouse.down(); await page.mouse.move(target.x,target.y,{steps:15});
      assert.match(await page.locator('#resource-preview span').textContent(),/号列车/,'rail carriage drop names its nearest eligible train');
      await page.mouse.up(); assert.equal((await snapshot()).stock.carriages,carBefore.stock.carriages-2);
      // AI ownership and all authoritative state remain untouched until a valid release.
      await page.evaluate(() => { window.metro.startAgent(() => ({action:{type:'wait'}}),'resource-cancel-probe'); window.metro.pause(); });
      for (const cancellation of ['Escape','blur','blank']) {
        if(await toggle.isVisible() && await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
        const unchanged = await snapshot();
        await page.mouse.move(startPoint.x,startPoint.y); await page.mouse.down(); await page.mouse.move(target.x,target.y,{steps:12});
        assert.deepEqual(await snapshot(),unchanged,'held source has no simulation or ownership effects');
        if(cancellation==='Escape') await page.keyboard.press('Escape');
        if(cancellation==='blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        if(cancellation==='blank') await page.mouse.move(5,5);
        await page.mouse.up(); assert.deepEqual(await snapshot(),unchanged,`${cancellation} leaves AI, stock, hash and records untouched`);
        assert.equal(await page.locator('#resource-preview').isVisible(),false);
        // A later ordinary map click must not revive creative/resource placement.
        const blank = await page.locator('#stage').boundingBox();
        await page.mouse.click(blank.x+8,Math.min(height-90,blank.y+blank.height-10)); assert.deepEqual(await snapshot(),unchanged,'unarmed click after cancel has no hidden placement');
        if(await toggle.isVisible() && await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
        const currentBox = await stock.boundingBox(); startPoint={x:currentBox.x+currentBox.width/2,y:currentBox.y+currentBox.height/2};
        target=await targetAt();
        const intentional = await snapshot();
        await page.mouse.move(startPoint.x,startPoint.y); await page.mouse.down(); await page.mouse.move(target.x,target.y,{steps:12});
        assert.equal(await page.locator('#resource-preview[data-valid="true"]').count(),1,'fresh intentional target re-previews after cancel');
        await page.mouse.up();
        assert.equal((await snapshot()).stock.locomotives,intentional.stock.locomotives-1,'fresh intentional drag succeeds after cancellation');
        await page.evaluate(() => { window.metro.startAgent(() => ({action:{type:'wait'}}),'resource-cancel-probe'); window.metro.pause(); });
      }
      if(width<650) {
        const cdp = await context.newCDPSession(page);
        const touch = (type,points) => cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(p=>({radiusX:3,radiusY:3,force:1,...p}))});
        await page.evaluate(() => window.addEventListener('pointermove',e => window.__resourceMove={x:e.clientX,y:e.clientY},true));
        const touchBefore = await snapshot();
        await touch('touchStart',[{id:1,...startPoint}]);
        for(let i=1;i<=16;i++) await touch('touchMove',[{id:1,x:startPoint.x+(target.x-startPoint.x)*i/16,y:startPoint.y+(target.y-startPoint.y)*i/16}]);
        await page.waitForFunction(p=>window.__resourceMove && Math.hypot(window.__resourceMove.x-p.x,window.__resourceMove.y-p.y)<1,target);
        assert.deepEqual(await snapshot(),touchBefore,'CDP native touch hover has no authoritative effect');
        await touch('touchEnd',[]);
        assert.equal((await snapshot()).stock.locomotives,touchBefore.stock.locomotives-1,'native touch release consumes once');
        const touchCarBefore=await snapshot(), cb=await car.boundingBox();
        await touch('touchStart',[{id:1,x:cb.x+22,y:cb.y+22}]);
        await touch('touchMove',[{id:1,x:target.x,y:target.y}]);
        await page.waitForFunction(p=>window.__resourceMove && Math.hypot(window.__resourceMove.x-p.x,window.__resourceMove.y-p.y)<1,target);
        assert.equal(await page.locator('#resource-preview[data-valid="true"]').count(),1,'native touch carriage has explicit eligible train');
        await touch('touchEnd',[]);
        assert.equal((await snapshot()).stock.carriages,touchCarBefore.stock.carriages-1,'native touch carriage consumes once');
        await page.evaluate(() => { window.metro.startAgent(() => ({action:{type:'wait'}}),'resource-multitouch-probe'); window.metro.pause(); });
        for(const reverse of [false,true]) {
          const unchanged = await snapshot();
          await touch('touchStart',[{id:1,...(reverse?target:startPoint)}]);
          await touch('touchStart',[{id:1,...(reverse?target:startPoint)},{id:2,...(reverse?startPoint:target)}]);
          await touch('touchMove',[{id:1,x:target.x-15,y:target.y},{id:2,x:target.x+15,y:target.y}]);
          await touch('touchEnd',[]); assert.deepEqual(await snapshot(),unchanged,'second finger cancels resource/route capture in either order');
        }
        const unchanged = await snapshot();
        await touch('touchStart',[{id:1,...startPoint}]); await touch('touchMove',[{id:1,...target}]); await touch('touchCancel',[]);
        assert.deepEqual(await snapshot(),unchanged,'native pointercancel does not spend or take AI');
        await cdp.detach();
      }
      await page.screenshot({path:`${evidence}/completed-${entry?'integration':'play'}-${width}x${height}.png`});
      // Stale releases are rejected before reaching controller.submit (including no rejected record).
      for(const stale of ['phase','stock','route','restart']) {
        if(await toggle.isVisible() && await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
        await page.mouse.move(startPoint.x,startPoint.y); await page.mouse.down(); await page.mouse.move(target.x,target.y,{steps:12});
        await page.evaluate(stale => {
          const m=window.metro,s=m.controller.session.state;
          if(stale==='phase')s.phase='upgrade';
          if(stale==='stock')s.resources.locomotives=0;
          if(stale==='route')s.lines[0].stops=[];
          if(stale==='restart')m.restart({mode:'creative',seed:421});
          m.controller.onChange();
        },stale);
        const changed=await snapshot(); await page.mouse.up(); assert.deepEqual(await snapshot(),changed,`${stale}: release must not record a rejection or take control`);
        // Reset the deterministic fixture for the next stale-state scenario.
        await page.evaluate(() => { const m=window.metro;m.restart({mode:'creative',seed:420});m.pause();m.submit({action:{type:'route',line:0,stops:[1,2,3]}}); });
      }
      // Settings owns native keys even when resource placement had a valid keyboard candidate.
      const activate = locator => width < 650 ? locator.tap() : locator.click();
      const armKeyboard = async () => {
        if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await activate(toggle);
        await stock.evaluate(e => e.focus({ preventScroll: true }));
        await page.keyboard.press('Enter'); await page.keyboard.press('ArrowRight');
        assert.equal(await page.locator('#resource-preview[data-valid="true"]').isVisible(), true, 'keyboard candidate is armed before opening settings');
      };
      const typeSeed = async value => {
        await activate(page.locator('#seed-input'));
        await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(value);
      };
      await page.evaluate(() => { window.metro.startAgent(() => ({ action: { type: 'wait' } }), 'resource-modal-probe'); window.metro.pause(); });
      const modalBefore = await snapshot();
      await armKeyboard(); await activate(page.locator('#new-game'));
      await typeSeed('-1'); await page.keyboard.press('Enter');
      const modalAfter = await snapshot();
      console.log(`${entry || 'play'} ${width}x${height}: invalid settings Enter ${JSON.stringify({ before: modalBefore, after: modalAfter })}`);
      assert.equal(await page.locator('#settings-dialog').evaluate(e => e.open), true, 'native number constraint keeps invalid settings open');
      assert.deepEqual(modalAfter, modalBefore, 'invalid settings Enter must not spend stock, record an action, change hash or take AI ownership');
      assert.equal(await page.locator('#resource-preview').isVisible(), false, 'opening settings clears the resource draft');
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.locator('#seed-input').inputValue(), '0', 'native input arrow still increments the seed');
      await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('#seed-input').inputValue(), '0', 'native input arrows still step the seed within its minimum');
      await page.locator('#city-select').evaluate(e => e.focus({ preventScroll: true }));
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('#city-select').inputValue(), 'harbor', 'native select arrow still changes its option');
      await page.keyboard.press('ArrowUp');
      assert.deepEqual(await snapshot(), modalBefore, 'editing settings leaves simulation and AI ownership untouched');
      await activate(page.locator('#settings-cancel'));
      // Return to the embedded map after the header/modal may have scrolled its page.
      const restoreMap = async (projectTarget = true) => {
        if (entry) await page.evaluate(() => scrollTo(0, document.querySelector('#game-shell').getBoundingClientRect().top + scrollY));
        if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await activate(toggle);
        if (projectTarget) target = await targetAt();
        const currentBox = await stock.boundingBox(); startPoint = { x: currentBox.x + currentBox.width / 2, y: currentBox.y + currentBox.height / 2 };
      };
      await restoreMap();
      await page.mouse.click(target.x, target.y);
      assert.deepEqual(await snapshot(), modalBefore, 'unarmed map click after closing settings cannot revive the keyboard candidate');
      await armKeyboard(); await page.keyboard.press('Enter');
      const intentionalKey = await snapshot();
      assert.equal(intentionalKey.stock.locomotives, modalBefore.stock.locomotives - 1, 'fresh intentional keyboard placement still spends exactly once');
      assert.equal(intentionalKey.decisions, modalBefore.decisions + 1);
      assert.equal(intentionalKey.mode, 'human', 'only intentional placement takes AI ownership');
      // A valid native form submit must restart, not confirm the previous resource choice.
      await armKeyboard(); await activate(page.locator('#new-game'));
      await page.locator('#mode-select').evaluate(e => e.focus({ preventScroll: true })); await page.keyboard.press('End');
      await typeSeed('421'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#settings-dialog').open && window.metro.getState().seed === 421);
      const restarted = await snapshot();
      assert.equal(await page.evaluate(() => window.metro.getState().mode), 'creative');
      assert.equal(restarted.decisions, 0, 'valid settings Enter follows the original clean restart path');
      assert.equal(await page.locator('#resource-preview').isVisible(), false, 'valid restart also leaves no resource draft');
      await restoreMap(false); await page.mouse.click(target.x, target.y);
      assert.deepEqual(await snapshot(), restarted, 'valid settings restart leaves no latent placement');
      await page.evaluate(() => { const m = window.metro; m.restart({ mode: 'creative', seed: 420 }); m.pause(); m.submit({ action: { type: 'route', line: 0, stops: [1,2,3] } }); });
      await restoreMap();
      // The document-level resource handler must also defer to dialogs opened by other UI paths.
      await armKeyboard();
      await page.evaluate(() => document.querySelector('#help-dialog').showModal());
      const otherDialogBefore = await snapshot();
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
      assert.deepEqual(await snapshot(), otherDialogBefore, 'any open dialog owns arrows and Enter, not the resource fallback choice');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#help-dialog').evaluate(e => e.open), false, 'Escape keeps its native dialog dismissal');
      await restoreMap(); await page.mouse.click(target.x, target.y);
      assert.deepEqual(await snapshot(), otherDialogBefore, 'other dialog dismissal cannot revive a resource choice');
      // Editing outside dialogs also discards placement without stealing native keys.
      await page.evaluate(() => {
        const controls = document.createElement('div'); controls.id = 'resource-editable-probe';
        controls.style.cssText = 'position:fixed;top:60px;left:8px;z-index:99999;background:white';
        controls.innerHTML = '<input value="123"><select><option>a</option><option>b</option></select><textarea>abc</textarea><div contenteditable><span>abc</span></div>';
        document.body.append(controls);
      });
      for (const selector of ['input', 'select', 'textarea', '[contenteditable] span']) {
        await armKeyboard();
        const editableBefore = await snapshot();
        const control = page.locator(`#resource-editable-probe ${selector}`);
        await activate(control);
        if (selector === 'select') {
          await page.keyboard.press('Escape'); // Close its native popup without leaving the focused select.
          await page.keyboard.press('ArrowDown');
          assert.equal(await control.inputValue(), 'b', 'standalone select retains its native option navigation');
        } else {
          await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft'); await page.keyboard.type('x');
          const text = selector.includes('contenteditable') ? await control.textContent() : await control.inputValue();
          assert.equal(text, selector === 'input' ? '12x3' : 'abxc', `${selector} retains native caret navigation and editing`);
          await page.keyboard.press('Enter');
        }
        assert.deepEqual(await snapshot(), editableBefore, `${selector} cannot commit the prior resource choice`);
        assert.equal(await page.locator('#resource-preview').isVisible(), false, `${selector} focus clears placement`);
        await page.mouse.click(target.x, target.y);
        assert.deepEqual(await snapshot(), editableBefore, `${selector} cannot leave a latent map placement`);
      }
      await page.locator('#resource-editable-probe').evaluate(e => e.remove());
      await page.evaluate(() => { const m = window.metro; m.restart({ mode: 'creative', seed: 420 }); m.pause(); m.submit({ action: { type: 'route', line: 0, stops: [1,2,3] } }); });
      await restoreMap();
      await page.evaluate(() => { const m=window.metro; m.loadReplay(m.exportReplay()); });
      assert.equal(await stock.isDisabled(),true,'replay stock is disabled but counted');
      console.log(`${entry||'play'} ${width}x${height}: mouse locomotive/carriage-core/carriage-line, keyboard, stable focus, AI cancels${width<650?', native touch + both-order second finger + pointercancel':''} PASS`);
    }
    const controls = await page.evaluate(() => ({ stockButtons:document.querySelectorAll('[data-resource]').length,
      counts: [...document.querySelectorAll('[data-stock]')].map(e=>({kind:e.dataset.stock,count:e.querySelector('b').textContent})),
      stage:document.querySelector('#stage').getBoundingClientRect().toJSON() }));
    const video=page.video(); await context.close();
    const videoPath=`${evidence}/${before?'before':'after'}-${entry?'integration':'play'}-${width}x${height}.webm`;
    await video.saveAs(videoPath);
    cases.push({entry:entry||'index.html',width,height,...controls,video:videoPath,ok:true});
  }
  if (before) {
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls.local[0]);
    assert.equal(await page.locator('[data-resource="locomotive"]').count(), 1, 'RED: direct stock button is absent');
  }
  await writeFile(`${evidence}/result.json`, JSON.stringify({ ok: true, cases }, null, 2));
} finally { await browser.close(); await server.close(); }
