// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from 'three';
import { MetroRenderer, hitTestVisibleLane, stationOutline } from './renderer';
import { geographicLayout, pileBounds, queueDisplay, offscreenOwnerLabel,
  layoutOwnerCueLabels } from './mobile-map';
import type { Shape, State } from './types';
import { groupJitter, passengerJitter } from './visual-crowd';

/** A single WebGL scene with geographic phone coordinates and screen-sized queue glyphs. */
export class Mobile3DRenderer {
  readonly canvas: HTMLCanvasElement;
  private scene: MetroRenderer;
  private state: State | null = null;
  private visualState: State | null = null;
  private points: ReturnType<typeof geographicLayout> = [];
  private ys: number[] = [];
  private warp: number[] = [];
  private riverKey = '';
  private layoutKey = '';
  private stationById = new Map<number, State['stations'][number]>();
  private center = {x:0,y:0};
  private zoom = 1;
  private moved = false;
  private selectedLine = 0;

  private queueScene = new THREE.Scene();
  private queueMeshes: THREE.Object3D[] = [];
  private queueObjects = new Map<string, THREE.Mesh>();
  private queueSignature = '';
  private queueGeometry = new Map<Shape, THREE.ShapeGeometry>();
  private queueMaterials = new Map<Shape, THREE.MeshBasicMaterial>();
  private queueGroups: {stationId:number;total:number;groups:{shape:Shape;count:number;x:number;y:number;visible:boolean}[]}[] = [];
  private ownerCueIds:number[]=[];
  private cueButtons:HTMLButtonElement[]=[];
  private cueOffset=0;
  private observer: ResizeObserver;
  private onOwnerFocus?: () => void;
  constructor(private container: HTMLElement, onOwnerFocus?: () => void) {
    this.scene = new MetroRenderer(container);
    this.canvas = this.scene.canvas;
    this.canvas.classList.add('mobile-3d-canvas');
    this.onOwnerFocus = onOwnerFocus;
    this.observer = new ResizeObserver(() => { this.camera(); this.reflow(); this.frameOpeningQueue(); if(this.visualState)this.scene.render(this.visualState,this.selectedLine);
      this.paint(); this.onOwnerFocus?.(); });
    this.observer.observe(container);
  }
  private rawY(y:number): number {
    if (!this.ys.length) return y*70;
    if (y <= this.ys[0]) return this.warp[0]+(y-this.ys[0])*70;
    if (y >= this.ys.at(-1)!) return this.warp.at(-1)!+(y-this.ys.at(-1)!)*70;
    for (let i=1;i<this.ys.length;i++) if (y<=this.ys[i]) {
      const t=(y-this.ys[i-1])/(this.ys[i]-this.ys[i-1]);
      return this.warp[i-1]*(1-t)+this.warp[i]*t;
    }
    return y*70;
  }
  private inverseY(y:number): number {
    if (!this.ys.length) return y/70;
    if (y<=this.warp[0]) return this.ys[0]+(y-this.warp[0])/70;
    if (y>=this.warp.at(-1)!) return this.ys.at(-1)!+(y-this.warp.at(-1)!)/70;
    for (let i=1;i<this.ys.length;i++) if (y<=this.warp[i])
      return this.ys[i-1]+(this.ys[i]-this.ys[i-1])*(y-this.warp[i-1])/(this.warp[i]-this.warp[i-1]);
    return y/70;
  }
  private world(x:number,y:number) { return {x:x*60/70,y:this.rawY(y)/70}; }
  /** The 2D layout reserves map units; reserve actual pixels after the pitched camera is known. */
  private fitQueues(s:State):void {
    if(!this.ys.length)return;
    const layout=this.points;
    const rowAt=(y:number)=>this.ys.indexOf(y);
    const scale=Math.abs(this.scene.project(0,1,.6).y-this.scene.project(0,0,.6).y);
    if(scale<1e-6)return;
    // Rows are indexed by source geography; account for every lower station, not array order.
    for(let j=1;j<this.ys.length;j++){
      let required=this.warp[j];
      for(const upper of layout){
        const i=rowAt(upper.sourceY);
        if(i>=j || !upper.passengers.length)continue;
        const display=queueDisplay(upper);
        const columns=display.kind==='grouped'?2:6;
        const rows=Math.ceil((display.kind==='grouped'?display.groups.length:upper.passengers.length)/columns);
        // Reserve the complete group label and jitter envelope, not just its icon.
        const halfWidth=display.kind==='grouped'?64+42+2:Math.min(6,upper.passengers.length)*11/2+7;
        const bottom=48+(rows-1)*(display.kind==='grouped'?22:12)+
          (display.kind==='grouped'?10:7)+2;
        for(const lower of layout){
          // Compare projected CSS pixels with the complete glyph/label rectangle.
          // Map-space x differences cannot be compared with screen-sized labels.
          const upperX=this.scene.project(upper.x/70,this.warp[i]/70,.6).x;
          const lowerX=this.scene.project(lower.x/70,this.warp[j]/70,.6).x;
          if(lower.sourceY!==this.ys[j] || Math.abs(upperX-lowerX)>halfWidth+22)continue;
          required=Math.max(required,this.warp[i]+(bottom+5)/scale*70);
        }
      }
      if(required>this.warp[j])this.warp[j]=required;
    }
    // Preserve the layout's midpoint while increasing row separation.
    const shift=(this.warp[0]+this.warp.at(-1)!-this.ys[0]*70-
      this.ys.at(-1)!*70)/2;
    this.warp=this.warp.map(y=>y-shift);
    for(const p of layout)p.y=this.warp[rowAt(p.sourceY)];
    this.visualState={...s,stations:s.stations.map(p=>({...p,...this.world(p.x,p.y),queue:[]}))};
  }
  private reflow():void {
    if(!this.state)return;
    const s=this.state;
    const key=JSON.stringify([s.stations.map(p=>[p.id,p.x,p.y,
      queueDisplay({passengers:p.queue}).kind==='grouped'
        ? `g${new Set(p.queue.map(q=>q.shape)).size}`
        : `i${p.queue.length}`]),
      this.zoom,this.container.clientWidth,this.container.clientHeight]);
    if(key!==this.layoutKey){
      this.visualState=this.prepare(s);
      this.fitQueues(s);
      this.layoutKey=key;
      const riverKey=JSON.stringify([s.city,this.ys,this.warp]);
      if(riverKey!==this.riverKey){
        this.scene.setRiverTransform((x,y)=>this.world(x,y));
        this.riverKey=riverKey;
      }
    } else {
      for(const point of this.points){
        const source=this.stationById?.get(point.id) ?? s.stations.find(p=>p.id===point.id);
        if(source){point.passengers=source.queue;point.crowd=source.crowd;}
      }
      this.visualState={...s,stations:s.stations.map(p=>({...p,...this.world(p.x,p.y),queue:[]}))};
    }
  }
  private camera(): void {
    // Do not change the desktop camera; this adapter owns a separate renderer.
    const scene = this.scene as unknown as {camera:THREE.OrthographicCamera; renderer:THREE.WebGLRenderer;
      center:{x:number;y:number};frameSize:{width:number;height:number};bounds:{width:number;height:number};zoom:number;manualCamera:boolean};
    const rect=this.container.getBoundingClientRect();
    const w=Math.max(1,rect.width),h=Math.max(1,rect.height);
    scene.bounds={width:w,height:h};
    scene.renderer.setSize(w,h);
    scene.manualCamera=true;
    scene.zoom=this.zoom;
    // Keep station architecture legible in portrait and preserve room for pan.
    scene.frameSize={width:Math.max(7.8,w/62),height:Math.max(7.8,h/62)};
    scene.center={x:this.center.x/70,y:this.center.y/70};
    scene.camera.position.set(scene.center.x,32,24+scene.center.y);
    scene.camera.lookAt(scene.center.x,0,scene.center.y);
    const aspect=w/h, half=Math.max(scene.frameSize.height/2,scene.frameSize.width/aspect/2)/this.zoom;
    scene.camera.left=-half*aspect;scene.camera.right=half*aspect;
    scene.camera.top=half;scene.camera.bottom=-half;scene.camera.updateProjectionMatrix();
    const cue=(this.scene as unknown as {cueCamera:THREE.OrthographicCamera}).cueCamera;
    cue.left=0;cue.right=w;cue.top=0;cue.bottom=h;cue.updateProjectionMatrix();
  }
  private prepare(s:State): State {
    this.points=geographicLayout(s.stations);
    this.ys=[...new Set(s.stations.map(p=>p.y))].sort((a,b)=>a-b);
    this.warp=this.ys.map(y=>this.points.find(p=>p.sourceY===y)!.y);
    const transformed=s.stations.map(p=>({...p,...this.world(p.x,p.y),queue:[]}));
    return {...s,stations:transformed};
  }
  render(s:State, selectedLine=0, events?: Parameters<MetroRenderer['render']>[2], _motion?: Parameters<MetroRenderer['render']>[3]): void {
    const first=this.state===null;
    this.state=s;
    this.stationById=new Map(s.stations.map(p=>[p.id,p]));
    this.selectedLine=selectedLine;
    if (first) {this.prepare(s);this.openingCamera();}
    this.camera();
    this.reflow();
    this.frameOpeningQueue();
    this.scene.setTrackSource(s,this.ys);
    // The scene and hit tests both use the same transformed world coordinates.
    // Motion interpolation is omitted because its previous snapshot uses the original coordinates.
    this.scene.render(this.visualState!,selectedLine,events);
    this.paint();
  }
  private openingCamera():void {
    const first=this.points[0], second=this.points[1] ?? first;
    if (!first) return;
    const w=this.container.clientWidth,h=this.container.clientHeight;
    const dx=Math.abs(first.x-second.x),dy=Math.abs(first.y-second.y);
    const baseline=Math.max(7.8*70, w*70/62, h*70/62);
    this.zoom=Math.max(.55,Math.min(1.8,Math.min((w-64)*70/(Math.max(dx,1)*baseline),
      (h-90)*70/(Math.max(dy,1)*baseline))));
    // Target geometry must not be placed outside the interactive stage.
    this.center={x:(first.x+second.x)/2,y:(first.y+second.y)/2+17/this.zoom};
    // The initial map may already contain a third station. Keep every opening
    // touch target fully inside the stage, not merely the first route endpoints.
    const frameWidth=Math.max(7.8,w/62)*70;
    const halfWidth=frameWidth/(2*this.zoom);
    const minX=Math.min(...this.points.map(p=>p.x)),maxX=Math.max(...this.points.map(p=>p.x));
    const margin=22*frameWidth/(w*this.zoom);
    if(maxX-minX<=2*(halfWidth-margin))
      this.center.x=Math.max(maxX-halfWidth+margin,
        Math.min(this.center.x,minX+halfWidth-margin));
  }
  /** Fit the first crowded station's screen-sized glyphs and 44px target in a short stage. */
  private frameOpeningQueue():void {
    if(this.moved || !this.state || this.container.clientWidth<500 || this.container.clientHeight>300)return;
    const station=this.state.stations[0],point=this.points[0];
    if(!station || !point)return;
    const display=queueDisplay(point);
    if(display.kind!=='grouped')return;
    const columns=Math.min(2,display.groups.length);
    const rows=Math.ceil(display.groups.length/columns);
    const h=this.container.clientHeight, margin=12;
    // Each count label is 16px high; two pixels cover deterministic group jitter.
    const minRoof=margin+5;
    const maxRoof=Math.min(h-margin-39,h-margin-48-(rows-1)*22-8-2);
    if(maxRoof<minRoof)return; // Not enough room to satisfy both constraints at this stage size.
    const roof=this.project(station.x,station.y,.6).y;
    const target=Math.max(minRoof,Math.min(maxRoof,roof));
    if(Math.abs(roof-target)<.01)return;
    const original=this.center.y;
    this.center.y=original+70;this.camera();
    const shifted=this.project(station.x,station.y,.6).y;
    if(Math.abs(shifted-roof)>1e-6)
      this.center.y=original+70*(target-roof)/(shifted-roof);
    else this.center.y=original;
    this.camera();
  }
  private paint():void {
    if (!this.state || !this.visualState) return;
    const reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const camera=(this.scene as unknown as {cueCamera:THREE.OrthographicCamera;renderer:THREE.WebGLRenderer}).cueCamera;
    const renderer=(this.scene as unknown as {cueCamera:THREE.OrthographicCamera;renderer:THREE.WebGLRenderer}).renderer;
    const signature=JSON.stringify([this.state.stations.map(p=>[p.id,p.x,p.y,p.queue.map(q=>[q.id,q.shape,q.born])]),
      this.center,this.zoom,this.container.clientWidth,this.container.clientHeight,this.state.tick,reducedMotion]);
    if(signature===this.queueSignature) {
      renderer.autoClear=false;renderer.clearDepth();renderer.render(this.queueScene,camera);renderer.autoClear=true;
      return;
    }
    this.queueSignature=signature;
    this.queueObjects ??= new Map();
    this.queueGeometry ??= new Map();
    this.queueMaterials ??= new Map();
    // Retain GPU resources across ticks; rebuild only changed ownership/counts.
    const live=new Set<string>();
    const retain=(key:string,create:()=>THREE.Mesh):THREE.Mesh=>{
      live.add(key);
      let object=this.queueObjects.get(key);
      if(!object){object=create();this.queueObjects.set(key,object);this.queueScene.add(object);}
      return object;
    };
    this.queueMeshes=[];
    this.queueGroups=[];
    const add=(object:THREE.Object3D)=>{this.queueMeshes.push(object);};
    const colors:Record<Shape,string>={circle:'#a44c77',triangle:'#347c70',square:'#6c4c99',diamond:'#316b9d',star:'#9e6b21',cross:'#ad5352',pentagon:'#7757a3',egg:'#827037',gem:'#337487',wedge:'#8d6745'};
    for(const p of this.points) {
      if(!p.passengers.length)continue;
      const pos=this.project(this.state.stations.find(st=>st.id===p.id)!.x,p.sourceY,.6);
      const display=queueDisplay(p);
      const groups=display.kind==='grouped' ? display.groups : p.passengers.map(person=>({shape:person.shape,count:0}));
      const columns=display.kind==='grouped'?Math.min(2,groups.length):6;
      const pitch=display.kind==='grouped'?64:11;
      const visibleGroups:{shape:Shape;count:number;x:number;y:number;visible:boolean}[]=[];
      groups.forEach(({shape,count},index)=>{
        const row=Math.floor(index/columns), rowSize=Math.min(columns,groups.length-row*columns);
        const rider=p.passengers[index];
        const offset=display.kind==='grouped'
          ? groupJitter(p.passengers.filter(person=>person.shape===shape),this.state!.tick,reducedMotion)
          : passengerJitter(rider.id,rider.born,this.state!.tick,reducedMotion);
        const x=pos.x-rowSize*pitch/2+(index%columns+.5)*pitch+offset.x;
        const y=pos.y+48+(display.kind==='grouped'?row*22:row*12)+offset.y;
        const visible=x>=0&&x<=this.container.clientWidth&&y>=0&&y<=this.container.clientHeight;
        if(display.kind==='grouped') visibleGroups.push({shape,count,x,y,visible});
        const key=display.kind==='individual'?`rider-${rider.id}`:`group-${p.id}-${shape}`;
        const icon=retain(key,()=>{
          let geometry=this.queueGeometry.get(shape),material=this.queueMaterials.get(shape);
          if(!geometry){geometry=new THREE.ShapeGeometry(stationOutline(shape,5));this.queueGeometry.set(shape,geometry);}
          if(!material){material=new THREE.MeshBasicMaterial({color:colors[shape],side:THREE.DoubleSide,depthTest:false,depthWrite:false,toneMapped:false});this.queueMaterials.set(shape,material);}
          return new THREE.Mesh(geometry,material);
        });
        icon.visible=visible;icon.position.set(x,y,0);icon.scale.y=-1;
        icon.userData={stationId:p.id,shape,passengerId:display.kind==='individual'?rider.id:undefined,count};
        if(!visible) return;
        add(icon);
        if(display.kind==='grouped') {
          const label=retain(`label-${p.id}-${shape}-${count}`,()=>{
            const canvas=document.createElement('canvas');canvas.width=76;canvas.height=32;
            const ctx=canvas.getContext('2d')!;ctx.font='bold 20px system-ui';ctx.textBaseline='middle';ctx.fillStyle='#332942';ctx.fillText(`×${count}`,2,16);
            const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
            return new THREE.Mesh(new THREE.PlaneGeometry(38,16),new THREE.MeshBasicMaterial({map:texture,transparent:true,side:THREE.DoubleSide,depthTest:false,depthWrite:false,toneMapped:false}));
          });
          label.visible=true;label.position.set(x+23,y,1);label.scale.y=-1;add(label);
        }
      });
      if(display.kind==='grouped')this.queueGroups.push({stationId:p.id,total:p.passengers.length,groups:visibleGroups});
    }
    for(const [key,object] of this.queueObjects)if(!live.has(key)){
      this.queueScene.remove(object);
      if(key.startsWith('label-')){
        object.geometry.dispose();const material=object.material as THREE.MeshBasicMaterial;
        material.map?.dispose();material.dispose();
      }
      this.queueObjects.delete(key);
    }
    renderer.autoClear=false;renderer.clearDepth();renderer.render(this.queueScene,camera);renderer.autoClear=true;
    this.ownerCues();
  }
  private ownerCues():void {
    const previous=new Map(this.cueButtons.map(button=>[(button as HTMLButtonElement & {cueKey:string}).cueKey,button]));
    this.cueButtons=[];this.ownerCueIds=[];
    const w=this.container.clientWidth,h=this.container.clientHeight;
    const candidates=this.points.filter(p=>{
      const station=this.state!.stations.find(s=>s.id===p.id)!;
      const anchor=this.project(station.x,station.y,.6);
      const display=queueDisplay(p);
      const columns=display.kind==='grouped'?Math.min(2,display.groups.length):6;
      const rows=Math.ceil((display.kind==='grouped'?display.groups.length:p.passengers.length)/columns);
      const bottom=anchor.y+48+(rows-1)*(display.kind==='grouped'?22:12)+8;
      return p.passengers.length>0 && anchor.y < -18 && anchor.x >= 10 && anchor.x <= w-10 &&
        bottom>0 && anchor.y+40<h;
    }).map(p=>({id:p.id,x:this.project(this.state!.stations.find(s=>s.id===p.id)!.x,p.sourceY,.6).x,
      width:Math.max(59,Math.ceil(offscreenOwnerLabel(p.id).length*14+8))}));
    const cues=layoutOwnerCueLabels(candidates,w,this.cueOffset);
    const host=this.container.parentElement;
    if(!host)return;
    const make=(key:string,label:string,x:number,width:number,action:()=>void)=>{
      const button=(previous.get(key) ?? document.createElement('button')) as HTMLButtonElement & {cueKey:string};
      previous.delete(key);button.cueKey=key;button.type='button';
      button.className='mobile-owner-cue';button.style.left=`${x-width/2}px`;button.style.width=`${width}px`;
      button.textContent=label;button.onpointerdown=e=>e.stopPropagation();button.onclick=action;
      if(!button.isConnected)host.append(button);
      this.cueButtons.push(button);return button;
    };
    for(const cue of cues){
      const button=make(`owner-${cue.id}`,offscreenOwnerLabel(cue.id),cue.x,cue.width,()=>this.focusOwner(cue.id));
      button.setAttribute('aria-label',`车站 ${cue.id}，下方候车乘客，点击定位`);
      this.ownerCueIds.push(cue.id);
    }
    if(cues.length<candidates.length){
      const button=make('next','下一站 ›',w-32,64,()=>{this.cueOffset=(this.cueOffset+1)%candidates.length;this.ownerCues();
        this.cueButtons.at(-1)?.focus();});
      button.classList.add('mobile-owner-next');
    }
    for(const button of previous.values())button.remove();
  }
  focusOwner(id:number){const point=this.points.find(p=>p.id===id);if(!point)return;
    this.centerAt(point.x,point.y);this.onOwnerFocus?.();}
  updateSceneCues(state:Readonly<State>, _placements?: readonly unknown[]):void {
    // The scene's warning treatment remains on the original 3D station silhouettes.
    if(!this.visualState)return;
    this.scene.updateSceneCues({...this.visualState,stations:this.visualState.stations.map((p,i)=>({...p,crowd:state.stations[i]?.crowd??0}))},[]);
    this.paint();
  }
  cueStats(){return {queueCount:this.points.filter(p=>p.passengers.length).length,warningCount:0,
    ringCount:0,queueStationIds:this.points.filter(p=>p.passengers.length).map(p=>p.id),warningStationIds:[],
    ringStationIds:[],bounds:[]};}
  /** The overview outline is the ground-plane frustum, not CSS pixels divided by zoom. */
  private viewportBounds(){
    const width=this.container?.clientWidth ?? 0,height=this.container?.clientHeight ?? 0;
    if(!this.scene?.unproject)return {x:this.center?.x??0,y:this.center?.y??0,width:0,height:0};
    const a=this.scene.unproject(0,0),b=this.scene.unproject(width,height);
    if(!a||!b)return {x:this.center.x,y:this.center.y,width:0,height:0};
    const x0=a.x*70,y0=a.y*70,x1=b.x*70,y1=b.y*70;
    return {x:Math.min(x0,x1),y:Math.min(y0,y1),width:Math.abs(x1-x0),height:Math.abs(y1-y0)};
  }
  mapStats(){return {laidOutPassengerIds:this.points.flatMap(p=>p.passengers.map(q=>q.id)),
    visibleDrawnPassengerIds:this.queueMeshes.filter(o=>o.userData.passengerId!==undefined).map(o=>o.userData.passengerId as number),
    queueGroups:this.queueGroups,
    visiblePositions:this.queueMeshes.filter(o=>o.userData.passengerId!==undefined).map(o=>({id:o.userData.passengerId as number,
      x:o.position.x,y:o.position.y,shape:o.userData.shape as Shape})), ownerCueIds:[...this.ownerCueIds], crossingCount:0,
    renderMs:0,stationCount:this.points.length,center:{...this.center},zoom:this.zoom,
    viewport:this.viewportBounds(),
    bounds:this.points.map(p=>({id:p.id,x:p.x,y:p.y,pile:pileBounds(p)}))};}
  project(x:number,y:number,height=.6){const pos=this.world(x,y);return this.scene.project(pos.x,pos.y,height);}
  unproject(x:number,y:number){const p=this.scene.unprojectAtHeight(x,y,.6);return p?{x:p.x*70/60,y:this.inverseY(p.y*70)}:null;}
  /** Ground-plane picks are for creative placement away from the projected station roofs. */
  unprojectGround(x:number,y:number){const p=this.scene.unproject(x,y);return p?{x:p.x*70/60,y:this.inverseY(p.y*70)}:null;}
  projectTrain(id:number){return this.scene.projectTrain(id);}
  hitTestLane(s:State,line:number,point:{x:number;y:number},radius=12){
    const layout = this.scene.getPaintedTrackLayout();
    return layout ? hitTestVisibleLane(s,line,point,this.scene.project.bind(this.scene),radius,layout) : null;
  }
  setZoom(value:number){this.moved=true;this.zoom=Math.max(.55,Math.min(1.8,value));this.camera();
    if(this.visualState){this.reflow();this.scene.render(this.visualState!,this.selectedLine);this.paint();this.onOwnerFocus?.();}}
  getZoom(){return this.zoom;}
  cameraState(){return {center:{...this.center},zoom:this.zoom,moved:this.moved};}
  restoreCamera(snapshot:{center:{x:number;y:number};zoom:number;moved:boolean}){
    this.center={...snapshot.center};this.zoom=snapshot.zoom;this.moved=snapshot.moved;
    this.camera();if(this.visualState){this.reflow();this.scene.render(this.visualState!,this.selectedLine);this.paint();}
  }
  hasUserCamera(){return this.moved;}
  pan(dx:number,dy:number){this.moved=true;
    const a=this.unproject(this.container.clientWidth/2,this.container.clientHeight/2);
    const b=this.unproject(this.container.clientWidth/2-dx,this.container.clientHeight/2-dy);
    if(a&&b){this.center.x+=(b.x-a.x)*60;this.center.y+=this.rawY(b.y)-this.rawY(a.y);}
    this.camera();this.scene.render(this.visualState!,this.selectedLine);this.paint();
  }
  centerAt(x:number,y:number){this.moved=true;this.center={x,y};this.camera();this.scene.render(this.visualState!,this.selectedLine);this.paint();}
  /** Move a projected roof to a stage row without publishing intermediate owner cues. */
  centerStationAt(x:number,y:number,targetY:number){
    this.moved=true;
    const start=this.center.y;
    this.center={x,y:start};this.camera();
    const xCurrent=this.project(x,y,.6).x;
    this.center.x+=70;this.camera();
    const xShifted=this.project(x,y,.6).x;
    if(Math.abs(xShifted-xCurrent)>1e-6)
      this.center.x=x+70*(this.container.clientWidth/2-xCurrent)/(xShifted-xCurrent);
    this.camera();
    const current=this.project(x,y,.6).y;
    this.center.y=start+70;this.camera();
    const shifted=this.project(x,y,.6).y;
    this.center.y=Math.abs(shifted-current)>1e-6
      ? start+70*(targetY-current)/(shifted-current):start;
    this.camera();this.scene.render(this.visualState!,this.selectedLine);this.paint();
  }
  resetCamera(){this.moved=false;this.openingCamera();this.camera();if(this.visualState){this.reflow();this.frameOpeningQueue();this.scene.render(this.visualState!,this.selectedLine);this.paint();}}
  frameOpeningStations(){if(!this.moved){this.openingCamera();this.camera();if(this.visualState){this.reflow();this.frameOpeningQueue();this.scene.render(this.visualState!,this.selectedLine);this.paint();}}}
  showPreview(s:State,stops:number[],line:number,valid=true){
    this.scene.showPreview(this.visualState??this.prepare(s),stops,line,valid);this.scene.render(this.visualState!,line);this.paint();}
  clearPreview(){this.scene.clearPreview();if(this.visualState){this.scene.render(this.visualState,this.selectedLine);this.paint();}}
  capture(){return this.scene.capture();}
  dispose(){this.observer.disconnect();for(const button of this.cueButtons)button.remove();
    for(const [key,obj] of this.queueObjects){if(!key.startsWith('label-'))continue;
      obj.geometry.dispose();const material=obj.material as THREE.MeshBasicMaterial;material.map?.dispose();material.dispose();}
    for(const geometry of this.queueGeometry.values())geometry.dispose();
    for(const material of this.queueMaterials.values())material.dispose();
    this.queueObjects.clear();
    this.scene.dispose();}
}
