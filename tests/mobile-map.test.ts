import { describe, expect, it } from 'vitest';
import { createState, segments } from '../src/rules';
import { geographicLayout, pileBounds, queueDisplay, offscreenPileOwner, offscreenOwnerLabel, layoutOwnerCueLabels, railCrossesPile, railPileCrossing, laneVertices, corridorRoute, routePointAt, MobileMapRenderer } from '../src/mobile-map';
import type { State } from '../src/types';

function crowdedState(): State {
  const state = createState();
  state.stations.push(...Array.from({ length: 24 }, (_, i) => ({
    ...state.stations[i % 3], id: 100 + i, x: -12 + i * 0.91, y: -7 + i * 0.47,
    queue: Array.from({ length: 105 }, (_, j) => ({ id: i * 105 + j + 1,
      shape: (['circle', 'triangle', 'square'] as const)[j % 3], born: 0, transfers: 0 })),
  })));
  return state;
}

describe('mobile geographic map', () => {
  it('shows each real passenger up to ten; at eleven groups exact destination counts in a stable order', () => {
    const p = geographicLayout(createState().stations)[0];
    p.passengers = Array.from({length:10},(_,i)=>({id:i+1,shape:i%2?'triangle' as const:'square' as const,born:0,transfers:0}));
    expect(queueDisplay(p)).toEqual({kind:'individual',passengers:p.passengers});
    p.passengers.push({id:11,shape:'triangle',born:0,transfers:0});
    expect(queueDisplay(p)).toEqual({kind:'grouped',groups:[{shape:'triangle',count:6},{shape:'square',count:5}]});
    p.passengers = [...p.passengers].reverse();
    expect(queueDisplay(p)).toEqual({kind:'grouped',groups:[{shape:'triangle',count:6},{shape:'square',count:5}]});
    expect(pileBounds(p)?.height).toBeLessThan(50);
  });
  it('summarizes every actual destination, not one sample icon or an overall headcount', () => {
    const p=geographicLayout(createState().stations)[0];
    p.passengers = Array.from({length:122},(_,i)=>({id:i+1,shape:(['square','triangle','diamond','star','cross'] as const)[i%5],born:0,transfers:0}));
    const representation=queueDisplay(p);
    expect(representation.kind).toBe('grouped');
    if (representation.kind === 'grouped') {
      expect(representation.groups.map(g=>g.shape)).toEqual(['triangle','square','diamond','star','cross']);
      expect(representation.groups.reduce((n,g)=>n+g.count,0)).toBe(p.passengers.length);
      expect(representation.groups.map(g=>g.count)).toEqual([25,25,24,24,24]);
    }
    expect(pileBounds(p)?.height).toBeLessThan(105);
  });
  it('reflects alight/board changes across the threshold without touching the passenger objects', () => {
    const p=geographicLayout(createState().stations)[0];
    const passengers=Array.from({length:11},(_,i)=>({id:i+1,shape:'square' as const,born:0,transfers:0}));
    p.passengers=passengers;
    const before=JSON.stringify(passengers);
    expect(queueDisplay(p)).toEqual({kind:'grouped',groups:[{shape:'square',count:11}]});
    expect(JSON.stringify(passengers)).toBe(before);
    p.passengers=passengers.slice(1);
    expect(queueDisplay(p)).toEqual({kind:'individual',passengers:p.passengers});
  });
  it('keeps the mobile renderer authoritative state unchanged at grouped threshold', () => {
    const s=createState();
    s.stations[0].queue=Array.from({length:11},(_,id)=>({id:id+1,shape:id%2?'triangle' as const:'square' as const,born:0,transfers:0}));
    const before=JSON.stringify(s);
    const p=geographicLayout(s.stations)[0];
    expect(queueDisplay(p)).toEqual({kind:'grouped',groups:[{shape:'triangle',count:5},{shape:'square',count:6}]});
    expect(JSON.stringify(s)).toBe(before);
  });
  it('switches geographic pile geometry at the eleven-passenger boundary without moving ownership', () => {
    const state=createState();
    state.stations[0].queue=Array.from({length:10},(_,id)=>({id,shape:'triangle' as const,born:0,transfers:0}));
    const ten=geographicLayout(state.stations);
    const tenBox=pileBounds(ten[0])!;
    expect(tenBox).toMatchObject({y:ten[0].y+42,width:84,height:27});
    state.stations[0].queue.push({id:10,shape:'square',born:0,transfers:0});
    const eleven=geographicLayout(state.stations);
    const elevenBox=pileBounds(eleven[0])!;
    expect(elevenBox).toMatchObject({y:eleven[0].y+42,width:128,height:28});
  });
  it('keeps both initial station hit targets in a 320px viewport when centered on the opening pair', () => {
    const state = createState();
    const points = geographicLayout(state.stations);
    const a = points[0], b = points[1];
    expect(Math.abs(a.x - b.x) + 44).toBeLessThanOrEqual(320);
    expect(Math.abs(a.y - b.y) + 44).toBeLessThanOrEqual(464);
  });
  it('marks an offscreen owner at the edge only while its anchored queue remains visible', () => {
    const p = {id:10,x:-306,y:-372,sourceY:0,shape:'square' as const,crowd:0,interchange:false,
      passengers:Array.from({length:115},(_,id)=>({id,shape:'circle' as const,born:0,transfers:0}))};
    expect(offscreenPileOwner(p,{x:154,y:-32},390,506,1)).toEqual({x:154,y:8,direction:'above'});
    expect(offscreenPileOwner(p,{x:154,y:12},390,506,1)).toBeNull();
    expect(offscreenPileOwner(p,{x:154,y:-340},390,506,1)).toBeNull();
    expect(offscreenPileOwner(p,{x:-90,y:-32},390,506,1)).toBeNull();
  });
  it('packs visible owner cues into one top row while retaining their horizontal relationship to anchored piles', () => {
    const cues = layoutOwnerCueLabels([{ id: 2, x: 128 }, { id: 10, x: 189 }, { id: 2474, x: 36 }], 320);
    expect(cues.map(c => c.id)).toEqual([2474, 2, 10]);
    expect(cues.every(c => c.y === 0)).toBe(true);
    for (let i = 0; i < cues.length; i++) for (let j = i + 1; j < cues.length; j++) {
      const a = cues[i], b = cues[j];
      expect(Math.abs(a.x - b.x) >= 94, `${a.id} and ${b.id} collide`).toBe(true);
    }
    expect(cues.every(c => Math.abs(c.x - ({ 2:128, 10:189, 2474:36 } as Record<number,number>)[c.id]) <= 55)).toBe(true);
  });
  it('packs four measured owner labels at 320 without collision or losing their anchor order', () => {
    const inputs = [{ id: 2, x: 42, width: 59 }, { id: 10, x: 132, width: 68 },
      { id: 806, x: 211, width: 77 }, { id: 2474, x: 284, width: 86 }];
    const cues = layoutOwnerCueLabels(inputs, 320);
    expect(cues.map(c => c.id)).toEqual(inputs.map(c => c.id));
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i].x - inputs[i].width / 2).toBeGreaterThanOrEqual(0);
      expect(cues[i].x + inputs[i].width / 2).toBeLessThanOrEqual(320);
      if (i) expect(cues[i].x - inputs[i].width / 2 - (cues[i-1].x + inputs[i-1].width / 2)).toBeGreaterThanOrEqual(6);
    }
  });
  it('cycles six owner identities on a narrow screen instead of overlapping or hiding queues', () => {
    const inputs = [2, 10, 806, 2474, 3099, 4100].map((id, i) => ({id, x: 28 + i * 53, width: 86}));
    const pages = inputs.map((_, offset) => layoutOwnerCueLabels(inputs, 320, offset));
    expect(pages[0].length).toBeLessThan(inputs.length);
    expect(new Set(pages.flat().map(c => c.id))).toEqual(new Set(inputs.map(c => c.id)));
    for (const page of pages) for (let i = 0; i < page.length; i++) {
      expect(page[i].x - 43).toBeGreaterThanOrEqual(0);
      expect(page[i].x + 43).toBeLessThanOrEqual(255); // last 65px reserved for navigation
      if (i) expect(page[i].x - page[i-1].x).toBeGreaterThanOrEqual(92);
    }
  });
  it('fits measured four-digit labels at 390 and keeps station IDs unique', () => {
    const inputs = [
      {id:2,x:55,width:59},{id:10,x:127,width:68},{id:806,x:206,width:77},
      {id:2474,x:283,width:86},{id:3000,x:355,width:86},
    ];
    const pages=inputs.map((_,offset)=>layoutOwnerCueLabels(inputs,390,offset));
    expect(pages[0].length).toBeLessThan(inputs.length);
    expect(new Set(pages.flat().map(c=>c.id))).toEqual(new Set(inputs.map(c=>c.id)));
    // In cycling mode the last 65px belong to the native next button.
    const pageWidth=pages[0].length<inputs.length?325:390;
    for (const page of pages) for(let i=0;i<page.length;i++) {
      expect(page[i].x-page[i].width/2).toBeGreaterThanOrEqual(0);
      expect(page[i].x+page[i].width/2).toBeLessThanOrEqual(pageWidth);
      if(i) expect(page[i].x-page[i].width/2-page[i-1].x-page[i-1].width/2).toBeGreaterThanOrEqual(6);
    }
  });
  it('does not render offscreen cue rectangles outside the narrow stage', () => {
    const cues = layoutOwnerCueLabels([{ id: 1, x: 7 }, { id: 2, x: 311 }], 320);
    expect(cues.every(c => c.x >= 45 && c.x <= 275)).toBe(true);
  });
  it('names an offscreen station and the waiting passengers below it without moving the pile', () => {
    expect(offscreenOwnerLabel(10)).toBe('↑10 候车↓');
  });
  it('reserves a bounded per-destination grouped cue rather than drawing 105 individual shapes', () => {
    const p = geographicLayout(crowdedState().stations).find(p => p.id === 100)!;
    const box = pileBounds(p)!;
    expect(queueDisplay(p).kind).toBe('grouped');
    expect(box).toMatchObject({width:128,height:53});
  });
  it('recognizes a rail crossing only over a foreign passenger pile', () => {
    const p = {id:10,x:150,y:100,sourceY:0,shape:'square' as const,crowd:0,interchange:false,
      passengers:[{id:1,shape:'circle' as const,born:0,transfers:0}]};
    expect(railCrossesPile([{x:100,y:148},{x:200,y:148}],p)).toBe(true);
    expect(railPileCrossing([{x:100,y:148},{x:200,y:148}],p)).toEqual([{x:143,y:148},{x:157,y:148}]);
    expect(railCrossesPile([{x:100,y:20},{x:200,y:20}],p)).toBe(false);
    expect(railCrossesPile([{x:120,y:148},{x:120,y:153}],p)).toBe(false);
  });
  it('routes a shared geographic rail clear of a foreign 115-passenger pile and its station core', () => {
    const state = createState();
    state.stations[0].x = -7; state.stations[0].y = 1;
    state.stations[1].x = -3; state.stations[1].y = -3;
    const foreign = { ...state.stations[2], id: 10, x: -5.1, y: -4.7,
      queue: Array.from({ length: 115 }, (_, i) => ({ id: 1000+i, shape: 'circle' as const, born: 0, transfers: 0 })) };
    const layout = geographicLayout([...state.stations.slice(0, 2), foreign]);
    layout[1].passengers=Array.from({length:114},(_,i)=>({id:3000+i,shape:'circle',born:0,transfers:0}));
    const [from, to, obstacle] = layout;
    const route = corridorRoute([{x:from.x,y:from.y},{x:to.x,y:to.y}], layout, from.id, to.id, 1);
    expect(route[0]).toEqual({x:from.x,y:from.y});
    expect(route.at(-1)).toEqual({x:to.x,y:to.y});
    const intersects = (box: {x:number;y:number;width:number;height:number}) => route.slice(1).some((v,i) => {
      const a=route[i], steps=100;
      return Array.from({length:steps+1},(_,j)=>j/steps).some(t=>
        a.x+(v.x-a.x)*t > box.x && a.x+(v.x-a.x)*t < box.x+box.width &&
        a.y+(v.y-a.y)*t > box.y && a.y+(v.y-a.y)*t < box.y+box.height);
    });
    expect(intersects(pileBounds(obstacle)!), 'rail crosses a foreign queue').toBe(false);
    expect(intersects(pileBounds(to)!), 'rail crosses the destination queue before its station').toBe(false);
    expect(intersects({x:obstacle.x-22,y:obstacle.y-22,width:44,height:44}), 'rail crosses a foreign station').toBe(false);
    expect(routePointAt(route,0)).toEqual(route[0]);
    expect(routePointAt(route,1)).toEqual(route.at(-1));
    for(const fraction of [.1,.3,.5,.7,.9]) {
      const v=routePointAt(route,fraction);
      expect(route.slice(1).some((b,i)=>{
        const a=route[i],dx=b.x-a.x,dy=b.y-a.y;
        const t=Math.max(0,Math.min(1,((v.x-a.x)*dx+(v.y-a.y)*dy)/(dx*dx+dy*dy||1)));
        return Math.hypot(v.x-a.x-t*dx,v.y-a.y-t*dy)<1e-6;
      }),`train at ${fraction} must be on visual rail`).toBe(true);
    }
  });
  it('shares one detoured route between paint, lane hit-testing, preview, and forward/reverse trains', () => {
    const state = createState();
    state.stations[0].x=-7;state.stations[0].y=1;
    state.stations[1].x=-3;state.stations[1].y=-3;
    state.stations[2].x=-5.1;state.stations[2].y=-1.5;
    state.stations[2].queue=Array.from({length:115},(_,i)=>({id:i+1000,shape:'circle' as const,born:0,transfers:0}));
    state.lines=[{id:0,stops:[1,2],loop:false}];
    const renderer=Object.create(MobileMapRenderer.prototype) as MobileMapRenderer;
    const harness=renderer as any;
    harness.container={getBoundingClientRect:()=>({width:390,height:506})};
    harness.size={width:390,height:506};harness.zoom=1;harness.center={x:0,y:0};
    harness.context={setTransform(){},fillRect(){},save(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},setLineDash(){},arc(){},fill(){},restore(){},translate(){},scale(){},fillText(){}};
    harness.canvas={width:390};harness.initialized=true;harness.layoutKey='';harness.points=[];
    harness.sourceYs=[];harness.warpValues=[];harness.recentLineKey='';harness.recentLineLayout=null;harness.routeCache=new Map();
    harness.trainPositions=new Map();harness.preview=null;harness.drawnIds=[];harness.visibleIds=[];
    harness.visiblePositions=[];harness.ownerCueIds=[];
    const calls:{x:number;y:number}[][]=[];
    harness.context.moveTo=(x:number,y:number)=>{calls.push([{x,y}]);};
    harness.context.lineTo=(x:number,y:number)=>{calls.at(-1)?.push({x,y});};
    const original=globalThis.Path2D;
    (globalThis as any).Path2D=class { arc(){} moveTo(){} lineTo(){} closePath(){} };
    try {
      renderer.render(state);
      const rail=calls.find(c=>c.length>2 && c.some(p=>p.x < 0)) ?? calls.find(c=>c.length>2 && c.some(p=>Math.abs(p.x-(-306+195))<5));
      expect(rail,'detoured rail is drawn').toBeDefined();
      const route=harness.visualRoute(1,2);
      expect(route.length).toBeGreaterThan(2);
      expect(renderer.mapStats().crossingCount).toBe(0);
      expect(rail).toEqual(route.map((p:{x:number;y:number})=>harness.projectWorld(p)));
      const point=harness.projectWorld(routePointAt(route,.5));
      expect(renderer.hitTestLane(state,0,point,5)).toBe(1);
      renderer.showPreview(state,[1,2],0);
      const preview=calls.at(-1)!;
      expect(preview).toEqual(rail);
      const forward={id:700,line:0,from:1,to:2,progress:.35,direction:1 as const,dwell:0,passengers:[],carriages:1,retiring:false,moveTo:null};
      state.trains=[forward,{...forward,id:701,from:2,to:1,progress:.35,direction:-1 as const}];
      const originalState=JSON.stringify(state);
      renderer.render(state);
      const a=renderer.projectTrain(700)!,b=renderer.projectTrain(701)!;
      expect(Math.hypot(a.x-harness.projectWorld(routePointAt(route,.35)).x,a.y-harness.projectWorld(routePointAt(route,.35)).y)).toBeLessThan(1e-6);
      expect(Math.hypot(b.x-harness.projectWorld(routePointAt(route,.65)).x,b.y-harness.projectWorld(routePointAt(route,.65)).y)).toBeLessThan(1e-6);
      expect(a).not.toEqual(b);
      expect(JSON.stringify(state)).toBe(originalState);
      state.lines.push({id:1,stops:[1,2],loop:false});
      state.trains.push({...forward,id:702,line:1});
      renderer.render(state);
      const laneA=renderer.projectTrain(700)!,laneB=renderer.projectTrain(702)!;
      expect(Math.hypot(laneA.x-laneB.x,laneA.y-laneB.y)).toBeGreaterThan(3);
      expect(Math.hypot(laneA.x-laneB.x,laneA.y-laneB.y)).toBeLessThan(5);
    } finally { (globalThis as any).Path2D=original; }
  });
  it('selects the painted closing rail of a loop for insertion after its last stop', () => {
    const state = createState();
    state.stations[0].x = -5; state.stations[0].y = -4;
    state.stations[1].x = 6; state.stations[1].y = -4;
    state.stations[2].x = 5; state.stations[2].y = 6;
    state.lines = [{ id: 0, stops: [1, 2, 3], loop: true }];
    expect(segments(state.lines[0]).at(-1)).toEqual([3, 1]);
    const renderer = Object.create(MobileMapRenderer.prototype) as MobileMapRenderer;
    const map = renderer as any;
    map.state = state;
    map.points = geographicLayout(state.stations);
    map.sourceYs = [...new Set(state.stations.map(p => p.y))].sort((a, b) => a - b);
    map.warpValues = map.sourceYs.map((y: number) => map.points.find((p: { sourceY: number }) => p.sourceY === y).y);
    map.size = { width: 390, height: 506 };
    map.zoom = 1;
    map.center = { x: 0, y: 0 };
    map.routeCache = new Map();
    map.recentLineKey = '';
    map.recentLineLayout = null;
    const closingRail = map.visualRoute(1, 3);
    const touch = map.projectWorld(routePointAt(closingRail, .5));
    expect(renderer.hitTestLane(state, 0, touch, 5)).toBe(state.lines[0].stops.length);
  });
  it('recomputes corridors when a foreign queue changes height without changing the simulation', () => {
    const state=createState();
    state.stations[0].x=-7;state.stations[0].y=1;state.stations[1].x=-3;state.stations[1].y=-3;
    state.stations[2].x=-5.1;state.stations[2].y=-1.5;
    state.stations[2].queue=Array.from({length:115},(_,i)=>({id:1000+i,shape:'circle' as const,born:0,transfers:0}));
    const full=geographicLayout(state.stations), [a,b]=full;
    const canonical=[{x:a.x,y:a.y},{x:b.x,y:b.y}];
    const crowded=corridorRoute(canonical,full,a.id,b.id,10);
    state.stations[2].queue=[];
    const empty=geographicLayout(state.stations);
    const cleared=corridorRoute([{x:empty[0].x,y:empty[0].y},{x:empty[1].x,y:empty[1].y}],empty,a.id,b.id,10);
    expect(crowded).not.toEqual(cleared);
    expect(state.stations[0].x).toBe(-7);
    expect(state.stations[1].y).toBe(-3);
  });
  it('uses the same offset lane vertices for rail paint and dragging', () => {
    expect(laneVertices([{x:0,y:0},{x:100,y:0}],0,2)).toEqual([{x:0,y:-2.1},{x:100,y:-2.1}]);
    expect(laneVertices([{x:0,y:0},{x:100,y:0}],1,2)).toEqual([{x:0,y:2.1},{x:100,y:2.1}]);
  });
  it('places the complete pile immediately below its station without overlap or omitted passenger IDs', () => {
    const state = crowdedState();
    const layout = geographicLayout(state.stations);
    const drawn = layout.flatMap(p => p.passengers.map(v => v.id));
    expect(drawn.sort((a, b) => a - b)).toEqual(state.stations.flatMap(p => p.queue.map(v => v.id)).sort((a, b) => a - b));
    for (const p of layout) {
      expect(p.passengers).toEqual(state.stations.find(s => s.id === p.id)!.queue);
      const a = pileBounds(p);
      if (!a) continue;
      expect(a.y).toBe(p.y + 42);
      for (const q of layout) {
        if (q.id === p.id) continue;
        const b = pileBounds(q);
        const hit = { x: q.x - 22, y: q.y - 5, width: 44, height: 44 };
        const overlaps = (r: typeof hit) => a.x < r.x + r.width && r.x < a.x + a.width && a.y < r.y + r.height && r.y < a.y + a.height;
        expect(overlaps(hit), `${p.id} pile vs ${q.id} station`).toBe(false);
        if (b) expect(overlaps(b), `${p.id} pile vs ${q.id} pile`).toBe(false);
      }
    }
    const ys = [...layout].sort((a, b) => a.sourceY - b.sourceY);
    for (let i = 1; i < ys.length; i++) expect(ys[i].y).toBeGreaterThan(ys[i - 1].y);
  });
});
