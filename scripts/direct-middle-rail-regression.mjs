import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { browserLaunchOptions } from './browser-launch.mjs';
import { mkdir, rename, writeFile, symlink } from 'node:fs/promises';

const output=process.env.METRO_RECORD_INTERACTIONS;
if(output)await mkdir(output,{recursive:true});
if(output) {
  // Use the already installed encoder without changing the read-only tool cache.
  const tools=`${output}/playwright-tools`;
  await mkdir(`${tools}/ffmpeg-1013`,{recursive:true});
  try{await symlink('/usr/local/bin/ffmpeg',`${tools}/ffmpeg-1013/ffmpeg-linux`);}catch(error){if(error.code!=='EEXIST')throw error;}
  process.env.PLAYWRIGHT_BROWSERS_PATH=tools;
}
const { chromium } = await import('@playwright/test');
const recordings=[];

const server = await createServer({server:{host:'127.0.0.1',port:0,hmr:false},logLevel:'error'});
await server.listen();
const browser = await chromium.launch(browserLaunchOptions({...process.env,
  METRO_BROWSER_EXECUTABLE_PATH:process.env.METRO_BROWSER_EXECUTABLE_PATH ?? '/opt/hermes/tools/chromium-1208/chrome-linux64/chrome'}));
const state = page => page.evaluate(() => window.metro.getState());
async function fixture(page, {stops=[1,2],line=1,loop=false,mode='creative',shared=false}={}) {
  await page.evaluate(({stops,line,loop,mode,shared})=>{
    const m=window.metro;m.restart({seed:420,mode});m.pause();
    // Deterministic geometry only; every tested edit still goes through native input and route rules.
    const s=m.controller.session.state;
    const points=innerHeight<400?[[-8,-2],[8,-2],[0,2],[-8,2],[8,2]]:[[-5,-2],[5,-2],[0,2],[-5,2],[5,2]];
    s.stations=points.map(([x,y],i)=>({...s.stations[i%3],id:i+1,x,y,queue:[],nextPassenger:1e9}));
    s.nextStation=1e9;s.resources.tunnels=50;
    if(shared)s.lines[0]={id:0,stops:[2,1],loop:false};
    assertRoute(m.submit({action:{type:'route',line,stops,loop}}));
    m.controller.selectedLine=2;m.controller.onChange();
    function assertRoute(result){if(!result.ok)throw new Error(result.message);}
  },{stops,line,loop,mode,shared});
  await page.waitForTimeout(160);
  // Fit all fixture roofs in the real camera. Desktop auto-frames; mobile uses public zoom controls.
  if(await page.evaluate(()=>Boolean(window.metro.mobileMapStats()))) {
    for(let i=0;i<8;i++) await page.locator('#zoom-out').click();
    await page.evaluate(()=>{
      const r=document.querySelector('#stage').getBoundingClientRect(),points=window.metro.getState().stations.map(s=>window.metro.projectStation(s.id));
      const x=(Math.min(...points.map(p=>p.x))+Math.max(...points.map(p=>p.x)))/2;
      const y=(Math.min(...points.map(p=>p.y))+Math.max(...points.map(p=>p.y)))/2;
      window.__mobileRailRenderer.pan(r.left+r.width/2-x,r.top+r.height/2-y);
    });
  }
  await page.waitForTimeout(100);
}
async function rail(page,line=1,edge=1) {
  return page.evaluate(async({line,edge})=>{
    const {hitTestVisibleLane}=await import('/src/renderer.ts');
    const scene=window.__railScene,s=window.metro.getState(),r=document.querySelector('#stage').getBoundingClientRect();
    const route=s.lines[line],a=route.stops[edge-1],b=route.stops[edge%route.stops.length];
    const layout=scene.getPaintedTrackLayout();
    const track=layout.segments.find(e=>e.from===Math.min(a,b)&&e.to===Math.max(a,b));
    const lane=track.lanes.find(l=>l.lineId===line);
    const path=scene.laneCurve(scene.trackVertices(track.points,lane.offset,.43,
      track.laneEndpoints?.find(l=>l.lineId===line)??track.endpointOffsets));
    const candidates=Array.from({length:81},(_,i)=>{
      const p=path.getPoint((i+4)/88),q=scene.project(p.x,p.z,p.y),point={x:r.left+q.x,y:r.top+q.y};
      const nearest=Math.min(...s.stations.map(st=>{const p=window.metro.projectStation(st.id);return Math.hypot(p.x-point.x,p.y-point.y);}));
      const hit=hitTestVisibleLane(s,line,q,scene.project.bind(scene),2,layout);
      const others=s.lines.filter(l=>l.id!==line&&l.stops.length).some(l=>hitTestVisibleLane(s,l.id,q,scene.project.bind(scene),1,layout)!==null);
      return {point,nearest,hit,others};
    }).filter(c=>c.hit===edge&&!c.others&&c.nearest>36&&c.point.x>r.left+24&&c.point.x<r.right-24&&c.point.y>r.top+24&&c.point.y<r.bottom-24&&
      document.elementFromPoint(c.point.x,c.point.y)?.closest('#stage')&&!document.elementFromPoint(c.point.x,c.point.y)?.closest('button'));
    if(!candidates.length)throw new Error(`No painted edge ${line}/${edge} safely visible ${JSON.stringify({r,candidates})}`);
    return candidates.sort((a,b)=>b.nearest-a.nearest)[0].point;
  },{line,edge});
}
async function paintedAt(page,point,color) {
  const image=await page.screenshot();
  return page.evaluate(async({bytes,point,color})=>{
    const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
    const expected=color.match(/[a-f\d]{2}/gi).map(c=>parseInt(c,16)),ratio=bitmap.width/innerWidth;
    const pixels=context.getImageData(Math.round(point.x*ratio)-6,Math.round(point.y*ratio)-6,13,13).data;
    return Array.from({length:169},(_,i)=>i*4).some(i=>expected.every((c,j)=>Math.abs(pixels[i+j]-c)<45));
  },{bytes:[...image],point,color});
}
async function authority(page) {
  return page.evaluate(()=>({hash:metro.hash(),mode:metro.controller.mode,source:metro.controller.activeAgentSource,
    decisions:metro.controller.decisions.length,stations:metro.getState().stations.length,lines:metro.getState().lines}));
}
async function blankRelease(page,from,placement=false) {
  return page.evaluate(async({from,placement})=>{
    const {hitTestVisibleLane}=await import('/src/renderer.ts');
    const {applyAction,copy}=await import('/src/rules.ts');
    const scene=window.__railScene,s=metro.getState(),r=document.querySelector('#stage').getBoundingClientRect();
    for(let y=r.top+30;y<r.bottom-30;y+=18)for(let x=r.left+30;x<r.right-30;x+=18) {
      if(Math.hypot(x-from.x,y-from.y)<75||s.stations.some(st=>{
        const p=metro.projectStation(st.id);return Math.hypot(x-p.x,y-p.y)<65;
      }))continue;
      if(!document.elementFromPoint(x,y)?.closest('#stage')||document.elementFromPoint(x,y)?.closest('button'))continue;
      const point={x:x-r.left,y:y-r.top};
      if(s.lines.some(l=>hitTestVisibleLane(s,l.id,point,scene.project.bind(scene),18,scene.getPaintedTrackLayout())!==null))continue;
      const p=window.__mobileRailRenderer?window.__mobileRailRenderer.unprojectGround(point.x,point.y):scene.unproject(point.x,point.y);
      if(placement&&(!p||Math.abs(p.x)>16||Math.abs(p.y)>10||!applyAction(copy(s),{type:'station',...p,shape:'circle'}).ok))continue;
      return{x,y};
    }
    throw new Error('No safe blank release');
  },{from,placement});
}
async function native(page,touch) {
  const delivered=p=>page.waitForFunction(p=>window.__railMove&&Math.hypot(window.__railMove.x-p.x,window.__railMove.y-p.y)<.2,p);
  if(!touch)return {down:async p=>{await page.mouse.move(p.x,p.y);await page.mouse.down();},move:async p=>{await page.mouse.move(p.x,p.y);await delivered(p);},up:()=>page.mouse.up(),cancel:()=>page.keyboard.press('Escape'),close:async()=>{}};
  const cdp=await page.context().newCDPSession(page);let last;
  const send=(type,p)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:/End|Cancel/.test(type)?[]:[{id:1,x:p.x,y:p.y,radiusX:3,radiusY:3,force:1}]});
  return {down:async p=>{last=p;await send('touchStart',p);},move:async p=>{last=p;await send('touchMove',p);await page.waitForFunction(p=>window.__railMove&&Math.hypot(window.__railMove.x-p.x,window.__railMove.y-p.y)<.2,p);},up:()=>send('touchEnd',last),cancel:()=>send('touchCancel',last),close:()=>cdp.detach()};
}
try {
  for(const [width,height,touch] of [[1280,800,false],[390,844,true],[568,320,true]].filter(([width])=>!process.env.METRO_RAIL_WIDTH||width===Number(process.env.METRO_RAIL_WIDTH))) {
    const page=await browser.newPage({viewport:{width,height},hasTouch:touch,isMobile:touch,
      ...(output?{recordVideo:{dir:output,size:{width,height}}}:{})});
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(server.resolvedUrls.local[0],{waitUntil:'networkidle'});
    await page.evaluate(()=>document.fonts.ready);
    await page.evaluate(async()=>{
      const {MetroRenderer}=await import('/src/renderer.ts');const original=MetroRenderer.prototype.drawLane;
      MetroRenderer.prototype.drawLane=function(...args){window.__railScene=this;return original.apply(this,args);};
      const {Mobile3DRenderer}=await import('/src/mobile-3d.ts');
      const mobileRender=Mobile3DRenderer.prototype.render;
      Mobile3DRenderer.prototype.render=function(...args){window.__mobileRailRenderer=this;return mobileRender.apply(this,args);};
      for(const Renderer of [MetroRenderer,Mobile3DRenderer]) {const original=Renderer.prototype.showPreview,clear=Renderer.prototype.clearPreview;
        Renderer.prototype.showPreview=function(s,stops,line,valid){const result=original.call(this,s,stops,line,valid);window.__railPreview={stops:[...stops],line,valid};return result;};
        Renderer.prototype.clearPreview=function(...args){window.__railPreview=null;return clear.apply(this,args);};}
      document.querySelector('#stage').addEventListener('pointermove',e=>{window.__railMove={x:e.clientX,y:e.clientY};});
    });
    // Keyboard arming leaves placing active: Escape during a captured rail drag
    // must cancel it before the browser emits the mouse/touch release click.
    await fixture(page);
    const picker=page.locator('#creative-picker [data-station-shape]').first();
    await picker.focus();await page.keyboard.press('Enter');
    await page.evaluate(()=>{metro.startAgent(()=>undefined,'escape-placement');metro.pause();});
    const canceledFrom=await rail(page),canceledBlank=await blankRelease(page,canceledFrom,true);
    const canceledBefore=await authority(page),canceledDrag=await native(page,touch);
    await canceledDrag.down(canceledFrom);await canceledDrag.move(canceledBlank);
    assert.equal(await page.locator('[data-middle-tip]').count(),1,'armed placement still allows a native rail pull');
    await page.keyboard.press('Escape');await canceledDrag.up();await canceledDrag.close();
    const canceledAfter=await authority(page);
    console.log(JSON.stringify({case:'escape-placement',viewport:[width,height],input:touch?'native touch':'native mouse',before:canceledBefore,after:canceledAfter}));
    assert.deepEqual(canceledAfter,canceledBefore,`${width}: Escape release cannot place a station, log a decision, or take AI control`);
    assert.equal(await page.locator('[data-route-snap],[data-middle-tip],[data-route-retract]').count(),0,'Escape clears feedback');
    // A fresh native click without rearming must remain inert; cancel clears placing,
    // not just the single compatibility click from the aborted gesture.
    const click=await native(page,touch);
    await click.down(canceledBlank);await click.up();await click.close();
    assert.deepEqual(await authority(page),canceledBefore,'Escape actually disarms creative placement');
    await picker.focus();await page.keyboard.press('Enter');
    const intentional=await native(page,touch);
    await intentional.down(canceledBlank);await intentional.up();await intentional.close();
    const placed=await authority(page);
    assert.equal(placed.stations,canceledBefore.stations+1,'next intentionally rearmed native placement succeeds');
    assert.equal(placed.decisions,canceledBefore.decisions+1,'intentional placement records exactly one decision');
    assert.equal(placed.mode,'human','only intentional placement takes control');
    assert.equal(await page.evaluate(()=>metro.controller.decisions.at(-1).result.ok),true,'intentional placement is accepted');
    // An already open line context must still close without short-circuiting
    // placement cancellation, even when keyboard focus remains on the picker.
    await fixture(page);
    await picker.focus();await page.keyboard.press('Enter');await page.keyboard.press('2');
    assert.equal(await page.locator('#context-actions').isVisible(),true,'line context is open before cancellation');
    await page.evaluate(()=>{metro.startAgent(()=>undefined,'escape-context');metro.pause();});
    const contextFrom=await rail(page),contextBlank=await blankRelease(page,contextFrom,true),contextBefore=await authority(page);
    const contextDrag=await native(page,touch);
    await contextDrag.down(contextFrom);await contextDrag.move(contextBlank);await page.keyboard.press('Escape');
    assert.equal(await page.locator('#context-actions').isVisible(),false,'Escape retains context cleanup');
    await contextDrag.up();await contextDrag.close();
    const contextClick=await native(page,touch);
    await contextClick.down(contextBlank);await contextClick.up();await contextClick.close();
    assert.deepEqual(await authority(page),contextBefore,'context cleanup cannot leave creative placement armed');
    // Redraw is another armed action: cancel a real pan, then a fresh station
    // drag must create an empty line rather than overwrite the selected route.
    await fixture(page);await page.keyboard.press('2');
    await page.locator('#context-actions [data-action="redraw"]').click();
    const redrawFrom=await rail(page),redrawBlank={x:redrawFrom.x+20,y:redrawFrom.y},redrawDrag=await native(page,touch);
    await redrawDrag.down(redrawFrom);await redrawDrag.move(redrawBlank);await page.keyboard.press('Escape');
    await redrawDrag.up();await redrawDrag.close();
    const newRoute=await native(page,touch);
    await newRoute.down(await page.evaluate(()=>metro.projectStation(3)));
    await newRoute.move(await page.evaluate(()=>metro.projectStation(5)));await newRoute.up();await newRoute.close();
    assert.deepEqual((await state(page)).lines[1].stops,[1,2],'Escape disarms redraw and preserves previously selected route');
    assert.deepEqual((await state(page)).lines[0].stops,[3,5],'next intentional station drag uses an empty route');
    // A loop can be editable at pointerdown but rule-invalid by release:
    // normal mode reaches the weekly upgrade without changing route topology.
    await fixture(page,{stops:[1,2,3],loop:true,mode:'normal'});
    await page.evaluate(()=>{
      const m=metro,s=m.controller.session.state;
      s.elapsed=4199;s.tick=4199;s.nextStation=1e9;
      m.startAgent(()=>undefined,'phase-transition');m.pause();
    });
    const phaseFrom=await rail(page,1,3),phaseBlank=await blankRelease(page,phaseFrom);
    const phaseDrag=await native(page,touch);
    await phaseDrag.down(phaseFrom);await phaseDrag.move(phaseBlank);
    assert.equal(await page.evaluate(()=>window.__railPreview?.line),1,'native loop pull is active before phase transition');
    if(touch)assert.equal(await page.locator('[data-loop-tip]').count(),1,'touch loop pull paints its SVG tip');
    await page.evaluate(()=>{metro.controller.session.step(1);metro.controller.onChange();});
    assert.equal((await state(page)).phase,'upgrade','4199 → 4200 enters weekly upgrade mid-drag');
    const phaseBefore=await authority(page);
    await phaseDrag.up();await phaseDrag.close();
    const phaseAfter=await authority(page);
    console.log(JSON.stringify({case:'phase-transition-loop-release',viewport:[width,height],input:touch?'native touch':'native mouse',before:phaseBefore,after:phaseAfter}));
    assert.deepEqual(phaseAfter,phaseBefore,`${width}: rule-invalid loop release preserves agent/source/hash/decisions and loop`);
    assert.equal(await page.locator('[data-loop-tip],[data-middle-tip],[data-route-snap],[data-route-retract]').count(),0,'rejected loop release clears transient feedback');
    assert.equal(await page.evaluate(()=>window.__railPreview),null,'rejected loop release clears renderer preview');
    // The same safe pull while playing still commits the exact grabbed edge.
    await fixture(page,{stops:[1,2,3],loop:true,mode:'normal'});
    await page.evaluate(()=>{metro.startAgent(()=>undefined,'valid-loop-break');metro.pause();});
    const validFrom=await rail(page,1,3),validBlank=await blankRelease(page,validFrom),validBefore=await authority(page);
    const validDrag=await native(page,touch);
    await validDrag.down(validFrom);await validDrag.move(validBlank);await validDrag.up();await validDrag.close();
    const validAfter=await authority(page);
    assert.deepEqual(validAfter.lines[1],{id:1,stops:[1,2,3],loop:false},'valid blank release breaks exactly closing edge');
    assert.equal(validAfter.mode,'human','valid loop break intentionally takes AI control');
    assert.equal(validAfter.decisions,validBefore.decisions+1,'valid loop break records one accepted action');
    assert.equal(await page.evaluate(()=>metro.controller.decisions.at(-1).result.ok),true,'valid loop break remains accepted');
    await fixture(page,{shared:true});
    const from=await rail(page),target=await page.evaluate(()=>window.metro.projectStation(3));
    const before=await page.evaluate(()=>window.metro.hash()),gesture=await native(page,touch);
    await gesture.down(from);await gesture.move(target);
    assert.equal(await page.evaluate(()=>window.metro.hash()),before,'preview leaves authority unchanged');
    assert.deepEqual(await page.evaluate(()=>window.__railPreview),{stops:[1,3,2],line:1,valid:true},'preview targets grabbed route');
    await page.keyboard.press('1');
    assert.deepEqual(await page.evaluate(()=>window.__railPreview),{stops:[1,3,2],line:1,valid:true},'mid-drag keyboard selection cannot retarget or cancel grabbed rail');
    await gesture.up();await gesture.close();
    assert.deepEqual((await state(page)).lines[1].stops,[1,3,2],`${width}: painted unselected lane owns inserted station`);
    assert.deepEqual((await state(page)).lines[0].stops,[2,1],`${width}: other shared lane untouched`);
    assert.deepEqual((await state(page)).lines[2].stops,[],`${width}: selected line untouched`);
    await fixture(page);
    await page.evaluate(()=>{
      const m=window.metro;
      for(const line of [0,2]){const r=m.submit({action:{type:'route',line,stops:[1,2]}});if(!r.ok)throw new Error(r.message);}
      const t=m.controller.session.state.trains.find(t=>t.line===0);
      t.from=1;t.to=2;t.progress=.4;
      const r=m.submit({action:{type:'route',line:0,stops:[]}});if(!r.ok)throw new Error(r.message);
      m.controller.selectedLine=2;m.controller.onChange();
    });
    const ghostDrag=await native(page,touch),ghostFrom=await rail(page);
    await ghostDrag.down(ghostFrom);await ghostDrag.move(await page.evaluate(()=>window.metro.projectStation(3)));await ghostDrag.up();await ghostDrag.close();
    assert.deepEqual((await state(page)).lines[1].stops,[1,3,2],'painted active lane keeps ghost-induced slot, not fresh topology offset');
    assert.deepEqual((await state(page)).lines[2].stops,[1,2],'selected adjacent lane untouched beside ghost');
    await fixture(page,{line:0});
    const ghostOnlyFrom=await rail(page,0);
    await page.evaluate(()=>{
      const m=window.metro,t=m.controller.session.state.trains.find(t=>t.line===0);
      t.from=1;t.to=2;t.progress=.4;
      m.submit({action:{type:'route',line:0,stops:[]}});m.controller.onChange();window.__railPreview=null;
    });
    const ghostOnlyHash=await page.evaluate(()=>window.metro.hash()),ghostOnly=await native(page,touch);
    await ghostOnly.down(ghostOnlyFrom);await ghostOnly.move(await page.evaluate(()=>window.metro.projectStation(3)));await ghostOnly.up();await ghostOnly.close();
    assert.equal(await page.evaluate(()=>window.metro.hash()),ghostOnlyHash,'ghost-only painted rail cannot own an editable route');
    assert.equal(await page.evaluate(()=>window.__railPreview),null,'ghost-only rail never previews an active route');
    await fixture(page,{stops:[1,3,2]});
    const removeFrom=await rail(page),removeTarget=await page.evaluate(()=>window.metro.projectStation(3));
    const removal=await native(page,touch),removalHash=await page.evaluate(()=>window.metro.hash());
    await removal.down(removeFrom);await removal.move(removeTarget);
    assert.deepEqual(await page.evaluate(()=>window.__railPreview),{stops:[1,2],line:1,valid:true},'adjacent visited interior station previews removal');
    assert.equal(await page.locator('[data-route-retract]').count(),0,'middle edit uses renderer dimming, not red overlay on preserved station shapes');
    assert.equal(await page.evaluate(()=>window.metro.hash()),removalHash,'removal preview stays transient');
    await removal.up();await removal.close();
    assert.deepEqual((await state(page)).lines[1].stops,[1,2],`${width}: direct rail removes only visited interior station`);
    await fixture(page,{stops:[1,2,3],loop:true});
    const loopFrom=await rail(page,1,3),loopTarget=await page.evaluate(()=>window.metro.projectStation(4)),loopDrag=await native(page,touch);
    await loopDrag.down(loopFrom);await loopDrag.move(loopTarget);
    assert.deepEqual(await page.evaluate(()=>window.__railPreview),{stops:[1,2,3,4,1],line:1,valid:true},'loop edge inserts outside station, not an open rotated route');
    await loopDrag.up();await loopDrag.close();
    assert.deepEqual((await state(page)).lines[1],{id:1,stops:[1,2,3,4],loop:true},'loop insertion preserves closure and stop origin');
    await fixture(page);
    assert.equal(await page.locator('[data-endpoint-cap]').count(),await page.locator('[data-route-handle]').count(),'every stable endpoint has a T cap');
    assert.ok(await page.locator('[data-endpoint-cap]').count()>0,'T caps present');
    let capPainted=false;
    for(let attempt=0;attempt<4&&!capPainted;attempt++) {
      const cap=await page.locator('[data-endpoint-cap]').first().evaluate(el=>{
        const p=new DOMPoint(5,0).matrixTransform(el.getScreenCTM());return {point:{x:p.x,y:p.y},color:el.getAttribute('stroke')};
      });
      capPainted=await paintedAt(page,cap.point,cap.color);
      if(!capPainted)await page.waitForTimeout(80); // ResizeObserver may repaint the endpoint after fixture framing.
    }
    assert.ok(capPainted,'T terminator is actually painted above game canvas');
    const snapDrag=await native(page,touch),snapHash=await page.evaluate(()=>window.metro.hash());
    await snapDrag.down(await rail(page));await snapDrag.move(await page.evaluate(()=>window.metro.projectStation(3)));
    assert.equal(await page.locator('[data-route-snap="3"]').count(),1,'valid edit emits one shape snap cue');
    assert.equal(await page.locator('[data-route-snap]').evaluate(el=>getComputedStyle(el).pointerEvents),'none','snap cannot steal touch');
    await page.waitForTimeout(460);
    assert.equal(await page.locator('[data-route-snap]').count(),0,'snap is bounded, not persistent selected decoration');
    await snapDrag.cancel();if(!touch)await snapDrag.up();await snapDrag.close();
    assert.equal(await page.evaluate(()=>window.metro.hash()),snapHash,'cancel never commits');
    await fixture(page);
    const pull=await native(page,touch),pullFrom=await rail(page),pullHash=await page.evaluate(()=>window.metro.hash());
    const blank={x:pullFrom.x,y:pullFrom.y-35};
    await pull.down(pullFrom);await pull.move(blank);
    assert.equal(await page.locator('[data-middle-tip]').count(),1,'blank middle pull continuously follows pointer before snapping');
    const end=await page.locator('[data-middle-tip]').getAttribute('data-pointer');
    assert.deepEqual(end.split(',').map(Number).map(Math.round),[blank.x,blank.y].map(Math.round),'pull tip follows real pointer');
    await pull.up();await pull.close();
    assert.equal(await page.evaluate(()=>window.metro.hash()),pullHash,'blank middle pull cancels insertion');
    assert.equal(await page.locator('[data-middle-tip]').count(),0,'middle tip clears after release');
    for(const config of [
      {label:'blank after insertion',stops:[1,2],target:3,release:null},
      {label:'nonadjacent stop after removal',stops:[1,3,2,5],target:3,release:2},
      {label:'endpoint cannot be middle-removed',stops:[1,3,2],target:1,release:1},
      {label:'extreme insert',mode:'extreme',stops:[1,2],target:3,release:3},
      {label:'extreme remove',mode:'extreme',stops:[1,3,2],target:3,release:3},
    ]) {
      await fixture(page,config);
      await page.evaluate(()=>{window.metro.startAgent(()=>undefined,'middle-regression');window.metro.pause();});
      const original=await page.evaluate(()=>({hash:window.metro.hash(),decisions:window.metro.controller.decisions.length}));
      const g=await native(page,touch),start=await rail(page),p=await page.evaluate(id=>window.metro.projectStation(id),config.target);
      await g.down(start);await g.move(p);
      if(config.release!==config.target)await g.move(config.release===null?{x:start.x,y:start.y-35}:await page.evaluate(id=>window.metro.projectStation(id),config.release));
      if(config.mode==='extreme') {
        assert.equal((await page.evaluate(()=>window.__railPreview)).valid,false,`${config.label}: rule-invalid red preview`);
        assert.equal(await page.locator('[data-route-snap]').count(),0,'invalid edits never pulse');
      }
      await g.up();await g.close();
      assert.deepEqual(await page.evaluate(()=>({hash:window.metro.hash(),decisions:window.metro.controller.decisions.length})),original,`${width} ${config.label}: no state or rejected decision writes`);
      assert.equal(await page.evaluate(()=>window.metro.controller.mode),'agent',`${config.label}: invalid release retains AI ownership`);
    }
    for(const termination of ['cancel','escape','restart']) {
      await fixture(page);
      const g=await native(page,touch),initial=await page.evaluate(()=>window.metro.hash());
      await g.down(await rail(page));await g.move(await page.evaluate(()=>window.metro.projectStation(3)));
      if(termination==='restart')await page.evaluate(()=>{window.metro.restart({seed:420,mode:'creative'});window.metro.pause();});
      else if(termination==='escape')await page.keyboard.press('Escape');
      else await g.cancel();
      assert.equal(await page.locator('[data-route-snap],[data-middle-tip],[data-route-retract]').count(),0,`${termination} clears all feedback`);
      if(termination!=='restart')assert.equal(await page.evaluate(()=>window.metro.hash()),initial,`${termination} leaves state`);
      if(termination!=='cancel'||!touch)await g.up();await g.close();
    }
    await fixture(page,{stops:[1,3,2]});
    const repeated=await native(page,touch),repeatedTarget=await page.evaluate(()=>window.metro.projectStation(3));
    await repeated.down(await rail(page));
    for(let i=0;i<5;i++)await repeated.move({x:repeatedTarget.x+i*.2,y:repeatedTarget.y});
    await repeated.up();await repeated.close();
    assert.deepEqual((await state(page)).lines[1].stops,[1,2],'repeated hover removes exactly one visited station');
    await fixture(page);
    const stale=await native(page,touch),staleFrom=await rail(page);
    await stale.down(staleFrom);await stale.move(await page.evaluate(()=>window.metro.projectStation(3)));
    await page.evaluate(()=>window.metro.submit({action:{type:'route',line:1,stops:[1,4,2]}}));
    const staleHash=await page.evaluate(()=>window.metro.hash());
    await stale.up();await stale.close();
    assert.equal(await page.evaluate(()=>window.metro.hash()),staleHash,'route changed by another authority during preview cannot be overwritten by stale draft');
    await fixture(page);
    await page.emulateMedia({reducedMotion:'reduce'});
    const reduced=await native(page,touch);
    await reduced.down(await rail(page));await reduced.move(await page.evaluate(()=>window.metro.projectStation(3)));
    assert.equal(await page.locator('[data-route-snap]').evaluate(el=>getComputedStyle(el).animationName),'none','reduced motion has static bounded cue');
    await reduced.up();await reduced.close();await page.emulateMedia({reducedMotion:'no-preference'});
    if(touch) {
      await fixture(page);
      await page.evaluate(()=>{window.metro.startAgent(()=>undefined,'pinch-middle');window.metro.pause();});
      const g=await native(page,true),from=await rail(page),to=await page.evaluate(()=>window.metro.projectStation(3)),initial=await page.evaluate(()=>window.metro.hash());
      await g.down(from);await g.move(to);
      const cdp=await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:to.x,y:to.y},{id:2,x:to.x+55,y:to.y}]});
      await page.waitForTimeout(60);
      assert.equal(await page.locator('[data-route-snap],[data-middle-tip]').count(),0,'pinch clears middle editing feedback');
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();await g.close();
      assert.equal(await page.evaluate(()=>window.metro.hash()),initial,'pinch cannot commit middle edit');
      assert.equal(await page.evaluate(()=>window.metro.controller.mode),'agent','pinch retains AI ownership');
    }
    if(output && width!==568) {
      const shot=async label=>{await page.screenshot({path:`${output}/${width}x${height}-${label}.png`});};
      const recordingStarted=Date.now();
      await fixture(page);
      await page.evaluate(()=>{const s=window.metro.controller.session.state;s.stations[2].queue=Array.from({length:5},(_,i)=>({id:s.nextId++,shape:i%2?'circle':'triangle',born:0,transfers:0}));window.metro.controller.onChange();});
      await page.waitForTimeout(100);
      await shot('01-actual-local-game-T-terminators');await page.waitForTimeout(500);
      const videoDrag=await native(page,touch),start=await rail(page),target=await page.evaluate(()=>window.metro.projectStation(3));
      const glide=async(a,b)=>{for(let i=1;i<=10;i++){await videoDrag.move({x:a.x+(b.x-a.x)*i/10,y:a.y+(b.y-a.y)*i/10});if(i<10)await page.waitForTimeout(35);}};
      await videoDrag.down(start);await glide(start,{x:start.x,y:start.y-35});await shot('02-middle-pull');
      await glide({x:start.x,y:start.y-35},target);await shot('03-insert-preview-snap');await page.waitForTimeout(450);await videoDrag.up();
      await shot('04-insert-committed');await page.waitForTimeout(450);
      const removeStart=await rail(page);await videoDrag.down(removeStart);await glide(removeStart,target);
      await shot('05-remove-preview-snap');await page.waitForTimeout(450);await videoDrag.up();await shot('06-remove-committed');await page.waitForTimeout(450);
      const cancelStart=await rail(page);await videoDrag.down(cancelStart);await glide(cancelStart,target);await shot('07-cancel-preview');
      if(touch)await videoDrag.cancel();else {await page.keyboard.press('Escape');await videoDrag.up();}
      await shot('08-cancel-restored');await page.waitForTimeout(600);await videoDrag.close();
      recordings.push({width,height,input:touch?'native Chromium CDP touch':'Playwright native mouse',localGame:true,seed:420,
        fixture:'creative five-station geometry, paused, five waiting passengers; edits are native route actions',
        demoDurationSeconds:(Date.now()-recordingStarted)/1000,finalRoute:(await state(page)).lines[1]});
    }
    assert.deepEqual(errors,[]);
    console.log(`${width}x${height} ${touch?'native touch':'mouse'}: painted owner insertion verified`);
    const video=page.video();await page.close();
    if(output&&video)await rename(await video.path(),`${output}/${width}x${height}-actual-local-game.webm`);
  }
  if(output)await writeFile(`${output}/manifest.json`,JSON.stringify(recordings,null,2));
} finally {await browser.close();await server.close();}
