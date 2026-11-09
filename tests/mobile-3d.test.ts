import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createState, crossings, trackPoints } from '../src/rules';
import { geographicLayout } from '../src/mobile-map';
import { Mobile3DRenderer } from '../src/mobile-3d';
import { MetroRenderer } from '../src/renderer';
import { passengerJitter, groupJitter } from '../src/visual-crowd';

function queueHarness(s: ReturnType<typeof createState>) {
  const renderer = Object.create(Mobile3DRenderer.prototype) as Mobile3DRenderer;
  (renderer as any).state = s;
  (renderer as any).visualState = s;
  (renderer as any).points = geographicLayout(s.stations);
  (renderer as any).ys = [];
  (renderer as any).scene = {project:()=>({x:100,y:100}),renderer:{autoClear:true,clearDepth(){},render(){}},cueCamera:{}};
  (renderer as any).container = {clientWidth:390,clientHeight:506};
  (renderer as any).queueScene = new THREE.Scene();
  (renderer as any).queueMeshes = [];
  (renderer as any).queueGroups = [];
  (renderer as any).cueButtons = [];
  (renderer as any).ownerCueIds = [];
  return renderer;
}

describe('narrow WebGL map adapter', () => {
  it('warps canonical rail bends with the river instead of recomputing bends from warped endpoints', () => {
    const s=createState({mode:'creative',city:'orchard'});
    s.stations[0].x=-2;s.stations[0].y=-8;
    s.stations[1].x=2;s.stations[1].y=-1;
    s.lines[0].stops=[s.stations[0].id,s.stations[1].id];
    expect(crossings(s,s.stations[0].id,s.stations[1].id)).toBe(0);
    const adapter=queueHarness(s);
    (adapter as any).prepare(s);
    const scene=Object.create(MetroRenderer.prototype) as MetroRenderer;
    (scene as any).setTrackSource(s);
    (scene as any).setRiverTransform=(transform:(x:number,y:number)=>{x:number;y:number})=>{(scene as any).riverTransform=transform;};
    scene.setRiverTransform((x,y)=>(adapter as any).world(x,y));
    const layout=(scene as any).visualTrackLayout((adapter as any).visualState ??
      {...s,stations:s.stations.map(p=>({...p,...(adapter as any).world(p.x,p.y)}))});
    const actual=layout.segments[0].points;
    const expected=trackPoints(s.stations[0],s.stations[1]).map(p=>(adapter as any).world(p.x,p.y));
    expect(actual[0]).toEqual(expected[0]);
    expect(actual.at(-1)).toEqual(expected.at(-1));
    expect(actual).toContainEqual(expected[1]);
    const canonical=trackPoints(s.stations[0],s.stations[1]);
    const sampled=canonical.flatMap((point,i)=>i===canonical.length-1?[]:
      Array.from({length:17},(_,j)=>({x:point.x+(canonical[i+1].x-point.x)*j/16,
        y:point.y+(canonical[i+1].y-point.y)*j/16}))).concat(canonical.at(-1)!);
    for(const point of sampled) {
      const transformed=(adapter as any).world(point.x,point.y);
      const nearest=Math.min(...actual.slice(1).map((next:{x:number;y:number},i:number)=>{
        const previous=actual[i],dx=next.x-previous.x,dy=next.y-previous.y;
        const t=Math.max(0,Math.min(1,((transformed.x-previous.x)*dx+(transformed.y-previous.y)*dy)/(dx*dx+dy*dy)));
        return Math.hypot(transformed.x-previous.x-dx*t,transformed.y-previous.y-dy*t);
      }));
      expect(nearest).toBeLessThan(0.005);
    }
    expect(actual).not.toEqual(trackPoints((adapter as any).world(-2,-8),(adapter as any).world(2,-1)));
    expect(crossings(s,s.stations[0].id,s.stations[1].id)).toBe(0);
  });
  it('warps preview rail bends from the same canonical route', () => {
    const s=createState({mode:'creative'});
    s.stations[0].x=-2;s.stations[0].y=-8;
    s.stations[1].x=2;s.stations[1].y=-1;
    const adapter=queueHarness(s);(adapter as any).prepare(s);
    const scene=Object.create(MetroRenderer.prototype) as MetroRenderer;
    (scene as any).preview=new THREE.Group();
    (scene as any).setTrackSource(s);
    (scene as any).riverTransform=(x:number,y:number)=>(adapter as any).world(x,y);
    const observed:{x:number;y:number}[][]=[];
    (scene as any).drawLane=(points:{x:number;y:number}[])=>observed.push(points);
    const visual={...s,stations:s.stations.map(p=>({...p,...(adapter as any).world(p.x,p.y)}))};
    scene.showPreview(visual,[s.stations[0].id,s.stations[1].id],0);
    expect(observed[0][0]).toEqual(trackPoints(s.stations[0],s.stations[1]).map(p=>(adapter as any).world(p.x,p.y))[0]);
    expect(observed[0]).toContainEqual((adapter as any).world(-2,-5));
    expect(observed[0].at(-1)).toEqual((adapter as any).world(2,-1));
  });
  it('keeps the focused owner cue button connected across a tick repaint', () => {
    const s=createState();s.stations[0].queue=Array.from({length:11},(_,i)=>({id:100+i,shape:'triangle' as const,born:0,transfers:0}));
    const renderer=queueHarness(s);
    const host={children:[] as any[],append(button:any){this.children.push(button);button.isConnected=true;}};
    (renderer as any).container={clientWidth:390,clientHeight:506,parentElement:host};
    (renderer as any).project=()=>({x:195,y:-44});
    const original=globalThis.document;
    let focused:any=null;
    (globalThis as any).document={createElement:()=>({style:{},isConnected:false,setAttribute(){},
      remove(){this.isConnected=false;if(focused===this)focused=null;},focus(){focused=this;}})};
    try {
      (renderer as any).ownerCues();
      const button=(renderer as any).cueButtons[0];button.focus();
      s.tick++;
      (renderer as any).ownerCues();
      expect(focused).toBe(button);
      expect(button.isConnected).toBe(true);
    } finally {(globalThis as any).document=original;}
  });
  it('retains grouped queue GPU mesh and label texture when only tick changes', () => {
    const s=createState();s.tick=90;
    s.stations[0].queue=Array.from({length:11},(_,i)=>({id:700+i,shape:i<6?'triangle' as const:'square' as const,born:0,transfers:0}));
    const renderer=queueHarness(s);
    const original=globalThis.document;
    (globalThis as any).document={createElement:()=>({width:0,height:0,getContext:()=>({font:'',textBaseline:'',fillStyle:'',fillText(){}})})};
    try {
      (renderer as any).paint();
      const first=(renderer as any).queueMeshes[0] as THREE.Mesh;
      const label=(renderer as any).queueMeshes[1] as THREE.Mesh;
      const texture=(label.material as THREE.MeshBasicMaterial).map;
      const before=first.position.clone();
      s.tick++;
      (renderer as any).paint();
      expect((renderer as any).queueMeshes[0]).toBe(first);
      expect((renderer as any).queueMeshes[1]).toBe(label);
      expect((label.material as THREE.MeshBasicMaterial).map).toBe(texture);
      expect(first.position.equals(before)).toBe(false);
    } finally {(globalThis as any).document=original;}
  });
  it('does not recompute queue spacing when grouped count changes but shape set and geography do not', () => {
    const s=createState();s.stations[0].queue=Array.from({length:11},(_,i)=>({id:i+10,shape:'triangle' as const,born:0,transfers:0}));
    const renderer=queueHarness(s);
    (renderer as any).scene.project=(_x:number,y:number)=>({x:160,y:y*20});
    (renderer as any).scene.setRiverTransform=()=>{};
    let fits=0;
    const original=(renderer as any).fitQueues;
    (renderer as any).fitQueues=function(state:typeof s){fits++;original.call(this,state);};
    (renderer as any).reflow();
    const originalY=(renderer as any).points[0].y;
    s.stations[0].queue.push({id:30,shape:'triangle',born:1,transfers:0});s.tick++;
    (renderer as any).reflow();
    expect(fits).toBe(1);
    expect((renderer as any).points[0].passengers).toHaveLength(12);
    expect((renderer as any).points[0].y).toBe(originalY);
  });
  it('jiggles every queued rider from fixed x/y slots regardless of age and crowd without changing simulation state', () => {
    const s = createState();
    s.tick = 120;
    s.stations[0].crowd = 0;
    s.stations[0].queue = [
      {id:101,shape:'triangle',born:0,transfers:0},
      {id:102,shape:'square',born:120,transfers:0},
    ];
    const renderer = queueHarness(s);
    const snapshot = JSON.stringify(s);
    (renderer as any).paint();
    const positions = renderer.mapStats().visiblePositions;
    expect(positions.map(p=>p.id)).toEqual([101,102]);
    for (const [index, position] of positions.entries()) {
      const rider = s.stations[0].queue[index];
      const offset = passengerJitter(rider.id,rider.born,s.tick,false);
      expect(position.x).toBeCloseTo(100-11+(index+.5)*11+offset.x);
      expect(position.y).toBeCloseTo(148+offset.y);
    }
    expect(JSON.stringify(s)).toBe(snapshot);
    const frozen = renderer.mapStats().visiblePositions;
    (renderer as any).paint();
    expect(renderer.mapStats().visiblePositions).toEqual(frozen);
    s.stations[0].crowd = 100;
    s.tick = 121;
    (renderer as any).points = geographicLayout(s.stations);
    (renderer as any).paint();
    expect(renderer.mapStats().visiblePositions[0].x).toBeCloseTo(100-11+5.5+passengerJitter(101,0,121,false).x);
  });
  it('moves grouped icon and exact number together using all riders, including freshly born riders', () => {
    const s=createState();s.tick=90;
    s.stations[0].queue=Array.from({length:11},(_,i)=>({id:100+i,shape:i<6?'triangle' as const:'square' as const,
      born:i%2 ? 90 : 0,transfers:0}));
    const renderer=queueHarness(s);
    const oldDocument=globalThis.document;
    (globalThis as any).document={createElement:()=>({width:0,height:0,getContext:()=>({font:'',textBaseline:'',fillStyle:'',fillText(){}})})};
    try {
      (renderer as any).paint();
      const groups=renderer.mapStats().queueGroups[0].groups;
      for(const [i,group] of groups.entries()) {
        const passengers=s.stations[0].queue.filter(p=>p.shape===group.shape);
        const offset=groupJitter(passengers,s.tick,false);
        const baseX=100-64+(i+.5)*64;
        expect(group.x).toBeCloseTo(baseX+offset.x);
        expect(group.y).toBeCloseTo(148+offset.y);
        const icon=(renderer as any).queueMeshes.find((mesh:THREE.Object3D)=>mesh.userData.shape===group.shape);
        const label=(renderer as any).queueMeshes[(renderer as any).queueMeshes.indexOf(icon)+1];
        expect(icon.position.x).toBeCloseTo(group.x);
        expect(label.position.x-icon.position.x).toBe(23);
        expect(label.position.y).toBeCloseTo(icon.position.y);
      }
    } finally { (globalThis as any).document=oldDocument; }
  });
  it('keeps a grouped 11-rider pile clear of the next warped station hit target', () => {
    const s=createState();
    s.stations[1].x=s.stations[0].x;
    s.stations[1].y=s.stations[0].y+1;
    s.stations[0].queue=Array.from({length:11},(_,i)=>({id:500+i,shape:i<6?'triangle' as const:'square' as const,born:0,transfers:0}));
    const renderer=queueHarness(s);
    const [first,next]=geographicLayout(s.stations);
    (renderer as any).scene.project=(x:number,y:number)=>({x:160+x*0,y:100+(y-first.y/70)*70*54/(next.y-first.y)});
    (renderer as any).prepare(s);
    (renderer as any).fitQueues(s);
    const fittedFirst=(renderer as any).points[0];
    (renderer as any).scene.project=(x:number,y:number)=>({x:160+x*0,y:100+(y-fittedFirst.y/70)*70*54/(next.y-first.y)});
    const oldDocument=globalThis.document;
    (globalThis as any).document={createElement:()=>({width:0,height:0,getContext:()=>({font:'',textBaseline:'',fillStyle:'',fillText(){}})})};
    try {
      (renderer as any).paint();
      const groups=renderer.mapStats().queueGroups[0].groups;
      expect(groups).toHaveLength(2);
      expect(groups.every((g:{visible:boolean})=>g.visible)).toBe(true);
      const nextY=renderer.project(s.stations[1].x,s.stations[1].y,.6).y;
      expect(groups.every((g:{x:number;y:number})=>
        g.y+8<=nextY-5 || g.y-8>=nextY+39 || g.x+42<=138 || g.x-8>=182),
        JSON.stringify({groups,nextY,warp:(renderer as any).warp,ys:(renderer as any).ys,points:(renderer as any).points.map((p:any)=>({id:p.id,x:p.x,y:p.y,sourceY:p.sourceY}))})).toBe(true);
    } finally { (globalThis as any).document=oldDocument; }
  });
  it('reserves the grouped label width when the next row is horizontally offset', () => {
    const s=createState();s.stations[1].y=s.stations[0].y+1;s.stations[1].x=s.stations[0].x+1.15;
    s.stations[0].queue=Array.from({length:11},(_,id)=>({id:id+400,shape:id<6?'triangle' as const:'square' as const,born:0,transfers:0}));
    const renderer=queueHarness(s);
    (renderer as any).scene.project=(x:number,y:number)=>({x:x*70,y:y*20});
    (renderer as any).prepare(s);
    (renderer as any).fitQueues(s);
    const upper=renderer.project(s.stations[0].x,s.stations[0].y,.6);
    const lower=renderer.project(s.stations[1].x,s.stations[1].y,.6);
    const labelRight=upper.x+32+42+1.4;
    expect(labelRight).toBeGreaterThan(lower.x-22);
    expect(upper.y+48+10+1.4).toBeLessThanOrEqual(lower.y-5);
    expect((renderer as any).warp[1]-(renderer as any).warp[0]).toBeGreaterThan(70);
  });
  it('separates a low-zoom queue label from the next station using projected horizontal pixels', () => {
    const s=createState();s.stations[1].x=s.stations[0].x+2.5;s.stations[1].y=s.stations[0].y+1;
    s.stations[0].queue=Array.from({length:11},(_,id)=>({id:800+id,shape:id<6?'triangle' as const:'square' as const,born:0,transfers:0}));
    const renderer=queueHarness(s);
    (renderer as any).scene.project=(x:number,y:number)=>({x:195+x*70/60*21,y:240+y*21});
    (renderer as any).prepare(s);
    (renderer as any).fitQueues(s);
    const upper=renderer.project(s.stations[0].x,s.stations[0].y,.6);
    const lower=renderer.project(s.stations[1].x,s.stations[1].y,.6);
    // A grouped right-hand label extends to x+74; the next 44px target starts at x-22.
    expect(upper.x+74).toBeGreaterThan(lower.x-22);
    expect(upper.y+48+10+2).toBeLessThanOrEqual(lower.y-5);
  });
  it('keeps a cue for an offscreen owner with fixed-size GPU glyphs still onstage', () => {
    const s=createState();s.stations[0].queue=Array.from({length:11},(_,id)=>({id:900+id,shape:id<6?'triangle' as const:'square' as const,born:0,transfers:0}));
    const renderer=queueHarness(s);
    (renderer as any).zoom=.55;
    (renderer as any).container={clientWidth:390,clientHeight:506,parentElement:{append(){}}};
    (renderer as any).project=()=>({x:195,y:-44});
    const previous=globalThis.document;
    (globalThis as any).document={createElement:()=>({style:{},setAttribute(){},remove(){}})};
    try {
      (renderer as any).ownerCues();
      expect(renderer.mapStats().ownerCueIds).toContain(s.stations[0].id);
    } finally {(globalThis as any).document=previous;}
  });
  it('warps river ribbons with the same rows as stations without changing river rules', () => {
    const s=createState();
    s.stations[0].queue=Array.from({length:11},(_,i)=>({id:i+700,shape:i%2?'square' as const:'triangle' as const,born:0,transfers:0}));
    const renderer=queueHarness(s);
    const sourceY=s.stations[1].y;
    const sourceX=1.25;
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([sourceX-.89,.05,sourceY,sourceX+.89,.05,sourceY],3));
    const water=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial());
    water.userData.riverSource=geometry.getAttribute('position').array.slice();
    const scene=Object.create(MetroRenderer.prototype) as MetroRenderer;
    const environment=new THREE.Group();environment.add(water);
    (scene as any).environment=environment;
    (renderer as any).scene=scene;
    (renderer as any).prepare(s);
    (scene as any).setRiverTransform((x:number,y:number)=>(renderer as any).world(x,y));
    const transformed=(renderer as any).world(sourceX,sourceY);
    expect(geometry.getAttribute('position').getZ(0)).toBeCloseTo(transformed.y);
    expect(geometry.getAttribute('position').getX(0)).toBeCloseTo((sourceX-.89)*60/70);
    expect(s.stations[1].y).toBe(sourceY);
  });
  it('round-trips station roof projections for route preview', () => {
    const s=createState();
    const renderer=queueHarness(s);
    (renderer as any).prepare(s);
    const camera=new THREE.OrthographicCamera(-4,4,4,-4,.1,100);
    camera.position.set(0,32,24);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const scene=Object.create(MetroRenderer.prototype) as MetroRenderer;
    (scene as any).camera=camera;
    (scene as any).bounds={width:390,height:506};
    (renderer as any).scene=scene;
    for(const station of s.stations) {
      const screen=renderer.project(station.x,station.y,.6);
      const position=renderer.unproject(screen.x,screen.y);
      expect(position).not.toBeNull();
      expect(position!.x).toBeCloseTo(station.x,4);
      expect(position!.y).toBeCloseTo(station.y,4);
    }
  });
  it('offers an explicit ground-plane creative pick distinct from roof projection', () => {
    const s=createState();const renderer=queueHarness(s);
    (renderer as any).prepare(s);
    const camera=new THREE.OrthographicCamera(-4,4,4,-4,.1,100);
    camera.position.set(0,32,24);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const scene=Object.create(MetroRenderer.prototype) as MetroRenderer;
    (scene as any).camera=camera;(scene as any).bounds={width:390,height:506};
    (renderer as any).scene=scene;
    const station=s.stations[0],screen=renderer.project(station.x,station.y,.6);
    const roof=renderer.unproject(screen.x,screen.y)!;
    const ground=renderer.unprojectGround(screen.x,screen.y)!;
    expect(roof.y).toBeCloseTo(station.y);
    expect(ground.y).not.toBeCloseTo(station.y);
    expect(ground.x).toBeCloseTo(station.x);
  });
  it('reports actual ground viewport extents in warped map units for overview', () => {
    const s=createState(),renderer=queueHarness(s);
    (renderer as any).prepare(s);
    const camera=new THREE.OrthographicCamera(-4,4,4,-4,.1,100);
    camera.position.set(0,32,24);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const scene=Object.create(MetroRenderer.prototype) as MetroRenderer;
    (scene as any).camera=camera;(scene as any).bounds={width:390,height:506};
    (renderer as any).scene=scene;
    const viewport=renderer.mapStats().viewport;
    expect(viewport.width).toBeCloseTo(8*70);
    expect(viewport.height).toBeGreaterThan(8*70);
    expect(viewport.x+viewport.width/2).toBeCloseTo(0);
    expect(viewport.y+viewport.height/2).toBeCloseTo(0);
  });
  it('does not rebuild river vertices when only the simulation tick changes', () => {
    const s=createState(),renderer=queueHarness(s);
    let updates=0;
    (renderer as any).scene.setRiverTransform=()=>{updates++;};
    (renderer as any).scene.render=()=>{};
    (renderer as any).scene.project=(_x:number,y:number)=>({x:0,y});
    (renderer as any).camera=()=>{};
    (renderer as any).paint=()=>{};
    (renderer as any).state=s;
    (renderer as any).reflow();
    s.tick++;
    (renderer as any).reflow();
    expect(updates).toBe(1);
  });
  it('keeps reduced-motion queues fixed and replay seek positions deterministic', () => {
    const s=createState();s.tick=95;s.stations[0].queue=[{id:15,shape:'star',born:95,transfers:0}];
    const renderer=queueHarness(s);
    const oldMatch=globalThis.matchMedia;
    (globalThis as any).matchMedia=()=>({matches:true});
    try {
      (renderer as any).paint();
      expect(renderer.mapStats().visiblePositions[0]).toMatchObject({x:100,y:148});
      s.tick=115;(renderer as any).paint();
      expect(renderer.mapStats().visiblePositions[0]).toMatchObject({x:100,y:148});
      (globalThis as any).matchMedia=()=>({matches:false});
      (renderer as any).paint();
      const forward=renderer.mapStats().visiblePositions[0];
      s.tick=90;(renderer as any).paint();
      s.tick=115;(renderer as any).paint();
      expect(renderer.mapStats().visiblePositions[0]).toEqual(forward);
    } finally { (globalThis as any).matchMedia=oldMatch; }
  });
  it('reports no painted warning ring for a crowded WebGL station', () => {
    const s=createState();s.stations[0].crowd=40;
    const renderer=queueHarness(s);
    expect(renderer.cueStats().ringCount).toBe(0);
    expect(renderer.cueStats().ringStationIds).toEqual([]);
  });
  it('reflows warped queue rows on zoom without changing simulation', () => {
    const s=createState();s.stations[1].x=s.stations[0].x;s.stations[1].y=s.stations[0].y+1;
    s.stations[0].queue=Array.from({length:11},(_,id)=>({id:id+300,shape:id%2?'triangle' as const:'square' as const,born:0,transfers:0}));
    const renderer=queueHarness(s);
    let scale=1;
    (renderer as any).scene.project=(_x:number,y:number)=>({x:160,y:y*scale});
    (renderer as any).scene.render=()=>{};
    (renderer as any).scene.setRiverTransform=()=>{};
    (renderer as any).camera=()=>{};
    (renderer as any).paint=()=>{};
    (renderer as any).prepare(s);
    (renderer as any).fitQueues(s);
    const before=(renderer as any).warp;
    const snapshot=JSON.stringify(s);
    scale=.2;renderer.setZoom(1.5);
    expect((renderer as any).warp[1]-(renderer as any).warp[0]).toBeGreaterThan(before[1]-before[0]);
    expect(JSON.stringify(s)).toBe(snapshot);
  });
  it('redraws WebGL and notifies touch projection on camera-only zoom', () => {
    const s=createState();
    const renderer=queueHarness(s);
    const calls:string[]=[];
    (renderer as any).scene.render=()=>calls.push('scene');
    (renderer as any).scene.setRiverTransform=()=>{};
    (renderer as any).scene.renderer.render=()=>calls.push('queue');
    (renderer as any).camera=()=>calls.push('camera');
    (renderer as any).onOwnerFocus=()=>calls.push('targets');
    renderer.setZoom(1.3);
    expect(calls).toEqual(['camera','scene','queue','targets']);
  });
  it('frames every opening station with its complete 44px touch target in portrait', () => {
    const s=createState();
    const renderer=queueHarness(s);
    const points=geographicLayout(s.stations).slice(0,3);

    // Narrow view should fit the initial three, not every late-game station.
    for(const width of [390,320]) {
      (renderer as any).points=points;
      (renderer as any).container={clientWidth:width,clientHeight:width===390?506:344};
      (renderer as any).openingCamera();
      const {center,zoom}=renderer.cameraState();
      const visualWidth=Math.max(7.8,width/62)*70;
      const x=width/2+(points[2].x-center.x)*zoom*width/visualWidth;
      expect(x+22).toBeLessThanOrEqual(width);
    }
  });
  it('retains queue GPU meshes across unchanged presentation frames', () => {
    const s=createState();
    s.stations[0].queue=[{id:101,shape:'triangle',born:0,transfers:0}];
    const scene={project:()=>({x:100,y:100}),renderer:{autoClear:true,clearDepth(){},render(){}},cueCamera:{}};
    const adapter=Object.create(Mobile3DRenderer.prototype) as Mobile3DRenderer;
    (adapter as any).state=s;
    (adapter as any).visualState=s;
    (adapter as any).points=geographicLayout(s.stations);
    (adapter as any).ys=[];
    (adapter as any).scene=scene;
    (adapter as any).container={clientWidth:390,clientHeight:506};
    (adapter as any).queueScene=new THREE.Scene();
    (adapter as any).queueMeshes=[];
    (adapter as any).queueGroups=[];
    (adapter as any).cueButtons=[];
    (adapter as any).paint();
    const first=(adapter as any).queueMeshes[0];
    (adapter as any).paint();
    expect((adapter as any).queueMeshes[0]).toBe(first);
  });
  it('reports painted grouped destinations separately from authoritative IDs', () => {
    const s = createState();
    s.stations[0].queue = Array.from({length:11},(_,id)=>({id,shape:id%2?'triangle' as const:'square' as const,born:0,transfers:0}));
    const renderer = Object.create(Mobile3DRenderer.prototype) as Mobile3DRenderer;
    (renderer as any).state = s;
    (renderer as any).visualState = s;
    (renderer as any).points = geographicLayout(s.stations);
    (renderer as any).ys = [];
    (renderer as any).scene = {project:()=>({x:-200,y:100}),renderer:{autoClear:true,clearDepth(){},render(){}},cueCamera:{}};
    (renderer as any).container = {clientWidth:390,clientHeight:506};
    (renderer as any).queueScene = new THREE.Scene();
    (renderer as any).queueMeshes = [];
    (renderer as any).queueGroups = [];
    (renderer as any).cueButtons = [];
    (renderer as any).paint();
    expect(renderer.mapStats().queueGroups[0]).toMatchObject({stationId:s.stations[0].id,total:11,
      groups:[{shape:'triangle',count:5},{shape:'square',count:6}]});
    expect(renderer.mapStats().queueGroups[0].groups.every((g:{visible?:boolean})=>typeof g.visible === 'boolean')).toBe(true);
    expect(renderer.mapStats().visibleDrawnPassengerIds).toEqual([]);
    expect(renderer.mapStats().laidOutPassengerIds).toHaveLength(11);
  });
});
