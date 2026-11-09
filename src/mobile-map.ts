// SPDX-License-Identifier: GPL-3.0-or-later
import { LINE_COLORS, SHAPES, riverCount, riverX, segments, trackPoints } from './rules';
import { deriveTrackLayout } from './track-layout';
import type { Passenger, Shape, State, Station } from './types';
import { crowdFillFraction, groupJitter, passengerJitter } from './visual-crowd';

export interface MapStation { id: number; x: number; y: number; sourceY: number; shape: Shape; passengers: Passenger[]; crowd: number; interchange: boolean }
const GLYPH_SIZE = 12, GLYPH_PITCH_X = 14, GLYPH_PITCH_Y = 15;
const GROUP_SIZE = 16, GROUP_PITCH_X = 64, GROUP_PITCH_Y = 25;
const GROUP_COLUMNS = 2;
export const QUEUE_GROUP_THRESHOLD = 10;
export type QueueDisplay = {kind:'individual';passengers:readonly Passenger[]} |
  {kind:'grouped';groups:{shape:Shape;count:number}[]};
export function queueDisplay(p: Pick<MapStation,'passengers'>): QueueDisplay {
  if(p.passengers.length <= QUEUE_GROUP_THRESHOLD) return {kind:'individual',passengers:p.passengers};
  const counts = new Map<Shape,number>();
  for(const passenger of p.passengers) counts.set(passenger.shape,(counts.get(passenger.shape)??0)+1);
  return {kind:'grouped',groups:SHAPES.filter(shape=>counts.has(shape)).map(shape=>({shape,count:counts.get(shape)!}))};
}
export const pileBounds = (p: Pick<MapStation,'x'|'y'> & ({passengers:Passenger[]} | {queue:Passenger[]})) => {
  const passengers='passengers' in p ? p.passengers : p.queue;
  if(!passengers.length)return null;
  const display=queueDisplay({passengers});
  if(display.kind==='grouped')return {
    x:p.x-Math.min(GROUP_COLUMNS,display.groups.length)*GROUP_PITCH_X/2, y:p.y+42,
    width:Math.min(GROUP_COLUMNS,display.groups.length)*GROUP_PITCH_X,
    height:Math.floor((display.groups.length-1)/GROUP_COLUMNS)*GROUP_PITCH_Y+GROUP_SIZE+12,
  };
  return {
    x: p.x - Math.min(6, passengers.length) * GLYPH_PITCH_X / 2, y: p.y + 42,
    width: Math.min(6, passengers.length) * GLYPH_PITCH_X,
    height: Math.floor((passengers.length - 1) / 6) * GLYPH_PITCH_Y + GLYPH_SIZE,
  };
};

/** The queue remains at its world position; this cue only locates its offscreen owner. */
export function offscreenPileOwner(p: MapStation, anchor: { x: number; y: number }, width: number, height: number, zoom: number): { x: number; y: number; direction: 'above' } | null {
  const pile = pileBounds(p);
  if (!pile || anchor.y >= -18 || anchor.x < 10 || anchor.x > width - 10 ||
      anchor.y + (42 + pile.height) * zoom <= 0 || anchor.y + 42 * zoom >= height) return null;
  return { x: anchor.x, y: 8, direction: 'above' };
}

export const offscreenOwnerLabel = (id: number): string => `↑${id} 候车↓`;

/** Fit measured labels into one row. If full set cannot fit, rotate a spatially ordered window. */
export function layoutOwnerCueLabels(cues: readonly { id: number; x: number; width?: number }[], width: number, offset = 0): { id: number; x: number; y: number; width: number }[] {
  const gap = 6;
  const ordered = cues.map(c => ({...c, width:c.width ?? 90})).sort((a,b) => a.x-b.x || a.id-b.id);
  const fits = (items: typeof ordered, available: number) =>
    items.reduce((sum,c) => sum+c.width, 0) + Math.max(0,items.length-1)*gap <= available;
  if (!ordered.length) return [];
  const cycling = !fits(ordered,width);
  const available = cycling ? width-65 : width;
  const rotated = cycling ? [...ordered.slice(offset % ordered.length), ...ordered.slice(0,offset % ordered.length)] : ordered;
  const selected: typeof ordered = [];
  for (const cue of rotated) {
    if (!fits([...selected,cue],available)) break;
    selected.push(cue);
  }
  // A single very long station ID still has a reachable cue, clipped only at the viewport edge.
  if (!selected.length) selected.push(rotated[0]);
  const spatial = selected.sort((a,b) => a.x-b.x || a.id-b.id);
  const centers = spatial.map(c=>Math.max(c.width/2,Math.min(available-c.width/2,c.x)));
  for (let i=1;i<centers.length;i++) centers[i]=Math.max(centers[i],centers[i-1]+(spatial[i-1].width+spatial[i].width)/2+gap);
  centers[centers.length-1]=Math.min(centers.at(-1)!,available-spatial.at(-1)!.width/2);
  for (let i=centers.length-2;i>=0;i--)
    centers[i]=Math.min(centers[i],centers[i+1]-(spatial[i].width+spatial[i+1].width)/2-gap);
  const positioned=spatial.map((c,i)=>({id:c.id,x:centers[i],y:0,width:c.width}));
  return positioned;
}

export function railPileCrossing(points: readonly { x: number; y: number }[], p: MapStation): { x: number; y: number }[] {
  const box=pileBounds(p);if(!box)return [];
  const left=box.x,right=box.x+box.width,top=box.y,bottom=box.y+box.height;
  const crossings:{x:number;y:number}[]=[];
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y;
    let lo=0,hi=1;
    for(const [q,d] of [[left-a.x,dx],[a.x-right,-dx],[top-a.y,dy],[a.y-bottom,-dy]]) {
      if(d===0) {if(q>0){lo=2;break;}continue;}
      const t=q/d;
      if(d>0)lo=Math.max(lo,t);else hi=Math.min(hi,t);
    }
    if(lo>hi || lo>=1 || hi<=0)continue;
    if(lo>0)crossings.push({x:a.x+dx*lo,y:a.y+dy*lo});
    if(hi<1)crossings.push({x:a.x+dx*hi,y:a.y+dy*hi});
  }
  return crossings;
}
export function railCrossesPile(points: readonly { x: number; y: number }[], p: MapStation): boolean {
  return railPileCrossing(points,p).length>=2;
}

export function laneVertices(projected: readonly {x:number;y:number}[], laneIndex: number, laneCount: number): {x:number;y:number}[] {
  return projected.map((p,i)=>{
    const previous=projected[Math.max(0,i-1)],next=projected[Math.min(projected.length-1,i+1)];
    const dx=next.x-previous.x,dy=next.y-previous.y,length=Math.hypot(dx,dy)||1;
    const offset=(laneIndex-(laneCount-1)/2)*4.2;
    return {x:p.x-dy/length*offset,y:p.y+dx/length*offset};
  });
}

type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

/** Map-only polyline routing. Canonical tracks, line stops, and train progress never change. */
export function corridorRoute(canonical: readonly Point[], stations: readonly MapStation[], from: number, to: number, clearance = 8): Point[] {
  if (canonical.length < 2) return [...canonical];
  const obstacles: Box[] = stations.flatMap(p => [
    ...(p.id === from || p.id === to ? [] : [{ x:p.x-22, y:p.y-22, width:44, height:44 }]),
    pileBounds(p),
  ].filter((b): b is Box => b !== null)).map(b => ({
    x:b.x-clearance, y:b.y-clearance, width:b.width+2*clearance, height:b.height+2*clearance,
  }));
  // Strict interior: corners and edges of the padded boxes are navigable.
  const crosses = (a: Point, b: Point, box: Box): boolean => {
    const eps=1e-6, left=box.x+eps, right=box.x+box.width-eps;
    const top=box.y+eps, bottom=box.y+box.height-eps;
    let lo=0,hi=1;
    for(const [origin,delta,min,max] of [[a.x,b.x-a.x,left,right],[a.y,b.y-a.y,top,bottom]]) {
      if(Math.abs(delta)<eps) { if(origin<=min || origin>=max)return false; continue; }
      const enter=(min-origin)/delta, exit=(max-origin)/delta;
      lo=Math.max(lo,Math.min(enter,exit));hi=Math.min(hi,Math.max(enter,exit));
    }
    return lo < hi && hi > 0 && lo < 1;
  };
  const clear=(a:Point,b:Point) => !obstacles.some(box=>crosses(a,b,box));
  if(canonical.slice(1).every((p,i)=>clear(canonical[i],p)))return [...canonical];
  const [start,end]=[canonical[0],canonical.at(-1)!];
  // Visibility graph: shortest geometric detour around foreign station/queue
  // rectangles. Original rail bends are candidate waypoints, not constraints.
  const nodes: Point[]=[start,end,...canonical.slice(1,-1).filter(p=>
    !obstacles.some(b=>p.x>b.x && p.x<b.x+b.width && p.y>b.y && p.y<b.y+b.height))];
  for(const b of obstacles) for(const x of [b.x,b.x+b.width]) for(const y of [b.y,b.y+b.height])
    if(!obstacles.some(other=>x>other.x+1e-6 && x<other.x+other.width-1e-6 && y>other.y+1e-6 && y<other.y+other.height-1e-6))
      nodes.push({x,y});
  const distance=nodes.map(()=>Infinity), previous=nodes.map(()=>-1), visited=new Set<number>();
  distance[0]=0;
  for(let step=0;step<nodes.length;step++) {
    let u=-1;
    for(let i=0;i<nodes.length;i++) if(!visited.has(i) && (u<0 || distance[i]<distance[u]))u=i;
    if(u<0 || !Number.isFinite(distance[u]) || u===1)break;
    visited.add(u);
    for(let v=0;v<nodes.length;v++) {
      if(v===u || visited.has(v) || !clear(nodes[u],nodes[v]))continue;
      const candidate=distance[u]+Math.hypot(nodes[u].x-nodes[v].x,nodes[u].y-nodes[v].y);
      if(candidate<distance[v]-1e-8){distance[v]=candidate;previous[v]=u;}
    }
  }
  if(!Number.isFinite(distance[1]))return [...canonical]; // No safe corridor exists.
  const route: Point[]=[];
  for(let i=1;i>=0;i=previous[i]){route.push(nodes[i]);if(i===0)break;}
  return route.reverse();
}

/** Interpolate the drawable rail by arc length; reverse travel uses reversed progress. */
export function routePointAt(points: readonly Point[], progress: number): Point {
  if(!points.length)return {x:0,y:0};
  if(points.length===1)return points[0];
  const lengths=points.slice(1).map((p,i)=>Math.hypot(p.x-points[i].x,p.y-points[i].y));
  let remaining=lengths.reduce((a,b)=>a+b,0)*Math.max(0,Math.min(1,progress));
  for(let i=0;i<lengths.length;i++) {
    if(remaining<=lengths[i] || i===lengths.length-1) {
      const t=lengths[i] ? Math.max(0,Math.min(1,remaining/lengths[i])) : 0;
      return {x:points[i].x+(points[i+1].x-points[i].x)*t,
        y:points[i].y+(points[i+1].y-points[i].y)*t};
    }
    remaining-=lengths[i];
  }
  return points.at(-1)!;
}

/** Forward longest-path constraints: each source y has one monotone screen y. */
export function geographicLayout(stations: readonly Station[]): MapStation[] {
  const xs = stations.map(p => p.x * 60);
  const ys = [...new Set(stations.map(p => p.y))].sort((a, b) => a - b);
  const expanded = ys.map(y => y * 70);
  const queueBoxes = stations.map(p=>pileBounds(p));
  for (let j = 1; j < ys.length; j++) {
    expanded[j] = Math.max(expanded[j], expanded[j - 1] + 0.01);
    for (let i = 0; i < j; i++) for (let a = 0; a < stations.length; a++) {
      const p = stations[a];
      if (p.y !== ys[i]) continue;
      const wp = queueBoxes[a]?.width ?? 0;
      const hp = queueBoxes[a]?.height ?? 0;
      for (let b = 0; b < stations.length; b++) {
        const q = stations[b];
        if (q.y !== ys[j]) continue;
        const wq = queueBoxes[b]?.width ?? 0;
        const dx = Math.abs(xs[a] - xs[b]);
        let required = 0;
        if (dx < 56) required = 56;
        if (hp && dx < wp / 2 + 34) required = Math.max(required, hp + 59);
        if (hp && wq && dx < (wp + wq) / 2 + 12) required = Math.max(required, hp + 12);
        expanded[j] = Math.max(expanded[j], expanded[i] + required);
      }
    }
  }
  // Keep the map centered around original geography instead of drifting down as queues grow.
  const shift = (expanded[0] + expanded.at(-1)! - ys[0] * 70 - ys.at(-1)! * 70) / 2;
  return stations.map((p, i) => ({ id: p.id, x: xs[i], y: expanded[ys.indexOf(p.y)] - shift,
    sourceY: p.y, shape: p.shape, passengers: p.queue, crowd: p.crowd, interchange: p.interchange }));
}

const ink: Record<Shape, string> = { circle: '#84516f', triangle: '#3e7778', square: '#69538f',
  diamond: '#456e9a', star: '#967039', cross: '#a15c60', pentagon: '#6a558a', egg: '#827144',
  gem: '#3d7885', wedge: '#80604b' };
function silhouette(shape: Shape): Path2D {
  const p = new Path2D();
  if (shape === 'circle') { p.arc(0, 0, 1, 0, Math.PI * 2); return p; }
  const sides: Record<Exclude<Shape, 'circle'>, number[][]> = {
    triangle: [[0,-1],[-.9,.78],[.9,.78]], square: [[-1,-1],[1,-1],[1,1],[-1,1]],
    diamond: [[0,-1],[1,0],[0,1],[-1,0]], star: Array.from({length:10}, (_,i) => {
      const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? .47 : 1;
      return [Math.cos(a)*r, Math.sin(a)*r]; }),
    cross: [[-.34,-1],[.34,-1],[.34,-.34],[1,-.34],[1,.34],[.34,.34],[.34,1],[-.34,1],[-.34,.34],[-1,.34],[-1,-.34],[-.34,-.34]],
    pentagon: Array.from({length:5},(_,i) => [Math.sin(i*2*Math.PI/5), -Math.cos(i*2*Math.PI/5)]),
    egg: Array.from({length:16},(_,i) => { const a=i*2*Math.PI/16; return [Math.sin(a)*(.75-Math.cos(a)*.17),-Math.cos(a)]; }),
    gem: [[-.8,-.44],[-.48,-.86],[.48,-.86],[.8,-.44],[.57,.68],[0,1],[-.57,.68]],
    wedge: [[-.9,.86],[.86,.86],[.86,-.98]],
  };
  const vertices = sides[shape];
  p.moveTo(vertices[0][0], vertices[0][1]);
  for (const [x,y] of vertices.slice(1)) p.lineTo(x,y);
  p.closePath(); return p;
}
let paths: Record<Shape, Path2D> | null = null;
function shapePaths(): Record<Shape, Path2D> {
  return paths ??= Object.fromEntries((Object.keys(ink) as Shape[]).map(shape => [shape, silhouette(shape)])) as Record<Shape, Path2D>;
}

export class MobileMapRenderer {
  readonly canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private observer: ResizeObserver;
  private size = { width: 1, height: 1 };
  private zoom = 1;
  private center = { x: 0, y: 0 };
  private initialized = false;
  private userMovedCamera = false;
  private landscapeFramed = false;
  private layoutKey = '';
  private points: MapStation[] = [];
  private sourceYs: number[] = [];
  private warpValues: number[] = [];
  private preview: { stops: number[]; line: number; valid: boolean } | null = null;
  private state: State | null = null;
  private drawnIds: number[] = [];
  private visibleIds: number[] = [];
  private visiblePositions: { id: number; x: number; y: number; shape: Shape }[] = [];
  private queueGroups: {stationId:number;total:number;groups:{shape:Shape;count:number;x:number;y:number;visible:boolean}[]}[] = [];
  private ownerCueIds: number[] = [];
  private ownerCueOffset = 0;
  private cueControls: HTMLButtonElement[] = [];
  private lastCueSignature = '';
  private crossingCount = 0;
  private lastMs = 0;
  private trainPositions = new Map<number, { x: number; y: number }>();
  private recentLineLayout: ReturnType<typeof deriveTrackLayout> | null = null;
  private recentLineKey = '';
  private routeCache = new Map<string, Point[]>();
  constructor(private container: HTMLElement, private onOwnerFocus?: () => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mobile-geographic-canvas';
    this.context = this.canvas.getContext('2d', { alpha: false })!;
    container.append(this.canvas);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }
  private resize(): void {
    const { width, height } = this.container.getBoundingClientRect();
    const changed = width !== this.size.width || height !== this.size.height;
    this.size = { width: Math.max(1, width), height: Math.max(1, height) };
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(this.size.width * ratio) || this.canvas.height !== Math.round(this.size.height * ratio)) {
      this.canvas.width = Math.round(this.size.width * ratio);
      this.canvas.height = Math.round(this.size.height * ratio);
    }
    if (changed && !this.userMovedCamera && document.body.classList.contains('map-first')) {
      if (this.size.width >= 500 && this.size.width > this.size.height && this.size.height < 300 &&
          (this.landscapeFramed || (this.state?.stations.length ?? 0) <= 3)) {
        this.frameOpeningStations(); return;
      }
      if (this.landscapeFramed && this.points.length) {
        const first = this.points[0], second = this.points[1] ?? first;
        this.zoom = 1;
        this.center = {x:(first.x+second.x)/2,y:(first.y+second.y)/2};
        this.landscapeFramed = false;
      }
    }
    this.draw();
  }
  private warp(y: number): number {
    if (!this.points.length) return y * 70;
    const knots = this.sourceYs;
    if (y <= knots[0]) return this.warpValues[0] + (y-knots[0])*70;
    if (y >= knots.at(-1)!) return this.warpValues.at(-1)! + (y-knots.at(-1)!)*70;
    for (let i=1;i<knots.length;i++) if (y <= knots[i]) {
      const t=(y-knots[i-1])/(knots[i]-knots[i-1]);
      return this.warpValues[i-1]*(1-t)+this.warpValues[i]*t;
    }
    return y*70;
  }
  project(x: number, y: number, _height = .6): { x: number; y: number } {
    return { x: (x*60-this.center.x)*this.zoom + this.size.width/2,
      y: (this.warp(y)-this.center.y)*this.zoom + this.size.height/2 };
  }
  unproject(x: number, y: number): { x: number; y: number } {
    const sourceY = (y-this.size.height/2)/this.zoom + this.center.y;
    const knots=this.sourceYs;
    let rawY = sourceY/70;
    if (knots.length) {
      const first=this.warp(knots[0]), last=this.warp(knots.at(-1)!);
      if(sourceY<first) rawY=knots[0]+(sourceY-first)/70;
      else if(sourceY>last) rawY=knots.at(-1)!+(sourceY-last)/70;
      else for(let i=1;i<knots.length;i++) {
        const lo=this.warp(knots[i-1]), hi=this.warp(knots[i]);
        if(sourceY<=hi) { rawY=knots[i-1]+(knots[i]-knots[i-1])*(sourceY-lo)/(hi-lo); break; }
      }
    }
    return { x: ((x-this.size.width/2)/this.zoom+this.center.x)/60, y: rawY };
  }
  setZoom(value: number): void { this.landscapeFramed = false; this.zoom = Math.max(.55, Math.min(1.8, value)); this.draw(); }
  getZoom(): number { return this.zoom; }
  hasUserCamera(): boolean { return this.userMovedCamera; }
  pan(dx: number, dy: number): void { this.userMovedCamera = true; this.center.x -= dx/this.zoom; this.center.y -= dy/this.zoom; this.draw(); }
  centerAt(x: number, y: number): void { this.userMovedCamera = true; this.center = { x, y }; this.draw(); }
  resetCamera(): void { this.initialized = false; this.userMovedCamera = false; this.landscapeFramed = false; this.zoom = 1; if(this.state) this.render(this.state); }
  /** Fit opening hit targets within the measured drawable stage. */
  frameOpeningStations(): void {
    const first = this.points[0], second = this.points[1] ?? first;
    if (!first) return;
    if ((this.state?.stations.length ?? 0) > 3 && first.passengers.length) {
      const pile=pileBounds(first);
      // On a crowded short screen, fit one complete station and its own queue.
      // The opening two-station frame cannot show their distant piles legibly.
      const top=first.y-5, bottom=pile ? pile.y+pile.height : first.y+39;
      this.zoom=Math.min(1,Math.max(.55,(this.size.height-24)/(bottom-top)));
      this.center={x:first.x,y:(top+bottom)/2};
      this.landscapeFramed=true;
      this.draw();
      return;
    }
    // When the train detail reduces the landscape canvas to a thin strip,
    // keep one 44px owner target wholly inside it rather than fitting two
    // illegible glyphs or leaving both offscreen.
    if (this.size.height < 100) {
      this.zoom = 1;
      this.center = {x:first.x,y:first.y + 17};
      this.landscapeFramed = true;
      this.draw();
      return;
    }
    const targetWidth = 44, targetTop = -5, targetBottom = 39, margin = 12;
    const dx = Math.abs(first.x - second.x), dy = Math.abs(first.y - second.y);
    const fit = Math.min(1, (this.size.width - targetWidth - 2 * margin) / (dx || 1),
      (this.size.height - (targetBottom - targetTop) - 2 * margin) / (dy || 1));
    // Short landscape needs zoom below .45 to keep both complete 44px targets
    // and their 12px stage inset; the hit box extends 5px up and 39px down.
    // The user's explicit zoom remains unrestricted.
    const midpoint = fit >= .35 ? (first.y + second.y) / 2 : first.y;
    this.zoom = fit >= .35 ? fit : 1;
    this.center = {x:fit >= .35 ? (first.x+second.x)/2 : first.x,
      y:midpoint + (targetTop + targetBottom) / (2 * this.zoom)};
    this.landscapeFramed = true;
    this.draw();
  }
  showPreview(_s: State, stops: number[], line: number, valid = true): void { this.preview = {stops,line,valid}; this.draw(); }
  clearPreview(): void { this.preview = null; this.draw(); }
  updateSceneCues(_state?: Readonly<State>, _placements?: readonly unknown[]): void { /* All mobile cues are drawn in the single canvas during render. */ }
  cueStats() { return { queueCount: this.points.filter(p=>p.passengers.length).length, warningCount: 0,
    ringCount: 0, queueStationIds: this.points.filter(p=>p.passengers.length).map(p=>p.id),
    warningStationIds: [] as number[], ringStationIds: [] as number[],
    bounds: this.points.flatMap(p => {const b=pileBounds(p); if(!b)return []; const q=this.project(p.x/60,p.sourceY);
      return [{ id:p.id,kind:'queue' as const,x:q.x-b.width*this.zoom/2,y:q.y+42*this.zoom,width:b.width*this.zoom,height:b.height*this.zoom }]; }) }; }
  /** Every ID is accounted for; compact groups are separate from painted passenger shapes. */
  mapStats() { return { laidOutPassengerIds: [...this.drawnIds], visibleDrawnPassengerIds: [...this.visibleIds],
    queueGroups:[...this.queueGroups],
    visiblePositions: [...this.visiblePositions], ownerCueIds: [...this.ownerCueIds], crossingCount: this.crossingCount,
    renderMs: this.lastMs, stationCount: this.points.length, center: {...this.center}, zoom:this.zoom,
    bounds: this.points.map(p => ({id:p.id,x:p.x,y:p.y,pile:pileBounds(p)})) }; }
  projectTrain(id: number): { x: number; y: number } | null { return this.trainPositions.get(id) ?? null; }
  private lineLayout(s: State): ReturnType<typeof deriveTrackLayout> {
    const key = JSON.stringify([s.lines.map(l => [l.id,l.stops,l.loop]),
      s.stations.map(p => [p.id,p.x,p.y])]);
    if (key !== this.recentLineKey || !this.recentLineLayout) {
      this.recentLineKey = key;
      this.recentLineLayout = deriveTrackLayout(s);
    }
    return this.recentLineLayout;
  }
  private projectWorld(p: Point): Point {
    return {x:(p.x-this.center.x)*this.zoom+this.size.width/2,
      y:(p.y-this.center.y)*this.zoom+this.size.height/2};
  }
  private visualRoute(from: number, to: number): Point[] {
    const a=Math.min(from,to), b=Math.max(from,to), key=`${a}:${b}`;
    let route=this.routeCache.get(key);
    if(!route) {
      const first=this.state!.stations.find(p=>p.id===a), second=this.state!.stations.find(p=>p.id===b);
      if(!first || !second)return [];
      const canonical=trackPoints(first,second);
      const warped: Point[]=[];
      for(let i=0;i<canonical.length;i++) {
        if(i===0) {warped.push({x:canonical[i].x*60,y:this.warp(canonical[i].y)});continue;}
        const prev=canonical[i-1],pt=canonical[i];
        const knots=this.sourceYs.filter(k=>k>Math.min(prev.y,pt.y)&&k<Math.max(prev.y,pt.y));
        for(const t of [...knots.map(k=>(k-prev.y)/(pt.y-prev.y)),1].sort((x,y)=>x-y))
          warped.push({x:(prev.x+(pt.x-prev.x)*t)*60,y:this.warp(prev.y+(pt.y-prev.y)*t)});
      }
      route=corridorRoute(warped,this.points,a,b,10);
      this.routeCache.set(key,route);
    }
    return from===a?route:[...route].reverse();
  }
  hitTestLane(s: State, lineId: number, point: { x: number; y: number }, radius = 12): number | null {
    let best = radius, insertion: number | null = null;
    const line = s.lines.find(l => l.id === lineId);
    if (!line) return null;
    for (const segment of this.lineLayout(s).segments) {
      const laneIndex = segment.lanes.findIndex(l => l.lineId === lineId);
      if (laneIndex < 0) continue;
      const projected = this.visualRoute(segment.from,segment.to).map(p=>this.projectWorld(p));
      const vertices = laneVertices(projected,laneIndex,segment.lanes.length);
      for (const [index, [from, to]] of segments(line).entries()) {
        if (Math.min(from, to) !== segment.from || Math.max(from, to) !== segment.to) continue;
        for (let j = 1; j < vertices.length; j++) {
          const a = vertices[j - 1], b = vertices[j], dx = b.x - a.x, dy = b.y - a.y;
          const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
          const d = Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t);
          if (d < best) { best = d; insertion = index + 1; }
        }
      }
    }
    return insertion;
  }
  render(s: State): void {
    this.state=s;
    const key=s.stations.map(p=>`${p.id},${p.x},${p.y},${p.queue.length},${p.queue.length>QUEUE_GROUP_THRESHOLD ? SHAPES.map(shape=>p.queue.filter(r=>r.shape===shape).length).join('.') : ''}`).join(';');
    if(key!==this.layoutKey) {
      this.points=geographicLayout(s.stations);
      this.sourceYs=[...new Set(s.stations.map(p=>p.y))].sort((a,b)=>a-b);
      this.warpValues=this.sourceYs.map(y=>this.points.find(p=>p.sourceY===y)!.y);
      this.layoutKey=key;
      this.routeCache.clear();
    } else for(let i=0;i<this.points.length;i++) {
      this.points[i].passengers=s.stations[i].queue;
      this.points[i].crowd=s.stations[i].crowd;
    }
    const first=this.points.find(p=>p.id===this.state!.stations[0].id), second=this.points.find(p=>p.id===this.state!.stations[1]?.id) ?? first;
    if(!this.initialized && first && second) {
      this.zoom = this.size.width < 360 ? .55 : 1;
      this.center={x:(first.x+second.x)/2,y:(first.y+second.y)/2};
      this.initialized=true;
      if (document.body.classList.contains('map-first') && this.size.width >= 500 && this.size.width > this.size.height && this.size.height < 300) {
        this.frameOpeningStations(); return;
      }
    }
    this.draw();
  }
  private draw(): void {
    if(!this.state || !this.points.length) return;
    const begin=performance.now(), c=this.context, ratio=this.canvas.width/this.size.width, paths=shapePaths();
    const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    c.setTransform(ratio,0,0,ratio,0,0);
    c.fillStyle='#fff8f5'; c.fillRect(0,0,this.size.width,this.size.height);
    const {width,height}=this.size;
    // Rendering is clipped to the map; all authoritative IDs are still accounted for offscreen.
    this.drawnIds=[]; this.visibleIds=[]; this.visiblePositions=[]; this.queueGroups=[]; this.ownerCueIds=[]; this.crossingCount=0;
    for(const p of this.points) for(const passenger of p.passengers) this.drawnIds.push(passenger.id);
    if(new Set(this.drawnIds).size!==this.drawnIds.length) throw new Error('mobile map passenger reconciliation failed');
    c.save();
    c.beginPath();c.rect(0,0,width,height);c.clip();
    const samples=120;
    for(let r=0;r<riverCount(this.state.city);r++) {
      c.beginPath();
      const ymin=this.unproject(0,-80).y,ymax=this.unproject(0,height+80).y;
      for(let i=0;i<=samples;i++) {
        const y=ymin+(ymax-ymin)*i/samples, v=this.project(riverX(this.state.city,y,r),y);
        if(i===0)c.moveTo(v.x,v.y); else c.lineTo(v.x,v.y);
      }
      c.lineWidth=9*this.zoom; c.strokeStyle='#d3e9ed'; c.stroke();
    }
    const path=(a: Station,b: Station) => {
      const pts=this.visualRoute(a.id,b.id).map(p=>this.projectWorld(p));c.beginPath();
      pts.forEach((v,i)=>{if(i===0)c.moveTo(v.x,v.y);else c.lineTo(v.x,v.y);});
    };
    const byId=new Map(this.state.stations.map(p=>[p.id,p]));
    c.lineCap='round';c.lineJoin='round';
    for(const segment of this.lineLayout(this.state).segments) {
      const projected=this.visualRoute(segment.from,segment.to).map(p=>this.projectWorld(p));
      for(let index=0;index<segment.lanes.length;index++) {
        const lane=segment.lanes[index];
        const vertices=laneVertices(projected,index,segment.lanes.length);
        c.beginPath();
        vertices.forEach(({x,y},i)=>{if(i===0)c.moveTo(x,y);else c.lineTo(x,y);});
        c.lineWidth=5.2;c.strokeStyle='#fff9f7';c.stroke();
        c.lineWidth=3.5;c.strokeStyle=LINE_COLORS[lane.lineId];c.stroke();
      }
    }
    if(this.preview) for(let i=1;i<this.preview.stops.length;i++) {
      const a=byId.get(this.preview.stops[i-1]),b=byId.get(this.preview.stops[i]); if(!a||!b)continue;
      path(a,b);c.setLineDash([7,5]);c.lineWidth=3;c.strokeStyle=this.preview.valid?LINE_COLORS[this.preview.line]:'#d54c60';c.stroke();c.setLineDash([]);
    }
    this.trainPositions.clear();
    for(const t of this.state.trains) {
      const a=byId.get(t.from),b=byId.get(t.to ?? t.from);if(!a||!b)continue;
      const pos=routePointAt(this.visualRoute(t.from,t.to ?? t.from),t.to===null?0:t.progress);
      const segment=this.lineLayout(this.state).segments.find(s=>s.from===Math.min(t.from,t.to ?? t.from)&&s.to===Math.max(t.from,t.to ?? t.from));
      const laneIndex=segment?.lanes.findIndex(l=>l.lineId===t.line) ?? -1;
      const vertices=segment && laneIndex>=0 ? laneVertices(this.visualRoute(t.from,t.to!).map(p=>this.projectWorld(p)),
        t.from===segment.from?laneIndex:segment.lanes.length-1-laneIndex,segment.lanes.length) : [];
      const v=vertices.length?routePointAt(vertices,t.progress):this.projectWorld(pos);
      this.trainPositions.set(t.id,v);
      if(v.x < -20 || v.y < -20 || v.x > width+20 || v.y > height+20)continue;
      c.fillStyle=LINE_COLORS[t.line];c.fillRect(v.x-8,v.y-5,16,10);
      c.fillStyle='#fff9f7';c.fillRect(v.x-4,v.y-3,8,2);
    }
    for(const p of this.points) {
      const x=(p.x-this.center.x)*this.zoom+width/2, y=(p.y-this.center.y)*this.zoom+height/2;
      if(x>=-25&&x<=width+25&&y>=-25&&y<=height+25) {
        c.save();c.translate(x,y);c.scale(15*this.zoom,15*this.zoom);
        c.lineWidth=.34;c.strokeStyle='#fffaf7';c.stroke(paths[p.shape]);
        c.fillStyle=ink[p.shape];c.fill(paths[p.shape]);
        const fraction=crowdFillFraction(p.crowd,this.state.mode);
        if(fraction) {
          c.save();c.clip(paths[p.shape]);c.fillStyle='rgba(223,49,60,.56)';
          c.fillRect(-1,1-2*fraction,2,2*fraction);c.restore();
        }
        c.restore();
        c.font='10px system-ui';c.fillStyle='#786b87';c.textAlign='center';c.fillText(String(p.id),x,y+32*this.zoom);
      }
      const display=queueDisplay(p);
      if(display.kind==='grouped') {
        const groups=display.groups.map(({shape,count},index)=>{
          const row=Math.floor(index/GROUP_COLUMNS),column=index%GROUP_COLUMNS;
          const rowSize=Math.min(GROUP_COLUMNS,display.groups.length-row*GROUP_COLUMNS);
          const jitter=groupJitter(p.passengers.filter(rider=>rider.shape===shape),this.state!.tick,reducedMotion);
          const px=x-rowSize*GROUP_PITCH_X*this.zoom/2+(column+.5)*GROUP_PITCH_X*this.zoom+jitter.x;
          const py=y+(48+row*GROUP_PITCH_Y)*this.zoom+jitter.y;
          const radius=GROUP_SIZE/2*this.zoom;
          const visible=px-GROUP_PITCH_X*this.zoom/2>=0&&px+GROUP_PITCH_X*this.zoom/2<=width&&
            py-radius>=0&&py+radius<=height;
          if(visible) {
            c.save();c.translate(px-GROUP_PITCH_X*this.zoom*.28,py);
            c.scale(radius,radius);c.lineWidth=.42;c.strokeStyle='#fff8f5';c.stroke(paths[shape]);
            c.fillStyle=ink[shape];c.fill(paths[shape]);c.restore();
            c.font=`600 ${Math.max(12,Math.round(15*this.zoom))}px system-ui`;
            c.textAlign='left';c.textBaseline='middle';c.fillStyle='#332942';
            c.fillText(`×${count}`,px-GROUP_PITCH_X*this.zoom*.10,py);
          }
          return {shape,count,x:px,y:py,visible};
        });
        this.queueGroups.push({stationId:p.id,total:p.passengers.length,groups});
        continue;
      }
      // Rows remain in world space as the camera pans past their station; a
      // tall queue can be explored on a short phone instead of disappearing
      // the moment its owning station leaves the viewport.
      for(let index=0;index<p.passengers.length;index++) {
        const passenger=p.passengers[index];
        const row=Math.floor(index/6), size=Math.min(6,p.passengers.length-row*6);
        const jitter=passengerJitter(passenger.id,passenger.born,this.state.tick,reducedMotion);
        const px=x-size*GLYPH_PITCH_X*this.zoom/2+((index%6)+.5)*GLYPH_PITCH_X*this.zoom+jitter.x;
        const py=y+(48+row*GLYPH_PITCH_Y)*this.zoom+jitter.y;
        const radius=GLYPH_SIZE/2*this.zoom;
        if(px+radius<=0||px-radius>=width||py+radius<=0||py-radius>=height) continue;
        c.save();c.translate(px,py);c.scale(GLYPH_SIZE/2*this.zoom,GLYPH_SIZE/2*this.zoom);
        // A paper keyline keeps each complete silhouette distinct from rails.
        c.lineWidth=.55;c.strokeStyle='#fff8f5';c.stroke(paths[passenger.shape]);
        c.fillStyle=ink[passenger.shape];c.fill(paths[passenger.shape]);c.restore();
        this.visibleIds.push(passenger.id);
        this.visiblePositions.push({id:passenger.id,x:px,y:py,shape:passenger.shape});
      }
    }
    // Queues remain above rails in the painter's order. A safe corridor has
    // no portal markers: the same detoured geometry drives paint and hits.
    // Screen-space ownership cue; passengers and station stay in world space.
    // All raw owners remain discoverable via the map; a compact row only pages
    // their screen-space labels when there is insufficient horizontal room.
    const rawOwnerCues = this.points.flatMap(p => {
      const anchor = { x:(p.x-this.center.x)*this.zoom+width/2, y:(p.y-this.center.y)*this.zoom+height/2 };
      return offscreenPileOwner(p,anchor,width,height,this.zoom) ? [{ p, anchor }] : [];
    });
    const measured = rawOwnerCues.map(({p,anchor}) => ({id:p.id,x:anchor.x,
      width:Math.ceil((c.font='600 13px system-ui',c.measureText(offscreenOwnerLabel(p.id)).width)+8)}));
    const labelPositions = layoutOwnerCueLabels(measured,width,this.ownerCueOffset);
    const cycling = labelPositions.length < rawOwnerCues.length;
    // A cue is a sibling of the stage, in the reserved strip above its canvas.
    // This keeps the entire button outside the drawable world-space area.
    if (this.container.parentElement) {
      const signature=JSON.stringify([labelPositions.map(c=>[c.id,Math.round(c.x),c.width]),cycling,width]);
      if (signature!==this.lastCueSignature) {
      this.lastCueSignature=signature;
      for (const button of this.cueControls ?? []) button.remove();
      this.cueControls=[];
      const cueHost=this.container.parentElement;
      for (const cue of labelPositions) {
        const button=document.createElement('button');button.type='button';button.className='mobile-owner-cue';
        button.textContent=offscreenOwnerLabel(cue.id);
        button.setAttribute('aria-label',`车站 ${cue.id}，下方候车乘客，点击定位`);
        button.style.left=`${cue.x-cue.width/2}px`;button.style.width=`${cue.width}px`;
        button.onpointerdown=e=>e.stopPropagation();
        button.onclick=()=>this.focusOwner(cue.id);
        cueHost.append(button);this.cueControls.push(button);
      }
      if (cycling) {
        const button=document.createElement('button');button.type='button';button.className='mobile-owner-cue mobile-owner-next';
        button.textContent='下一站 ›';button.setAttribute('aria-label',`切换上方候车车站，当前共 ${rawOwnerCues.length} 站`);
        button.style.left=`${width-64}px`;button.style.width='64px';
        button.onpointerdown=e=>e.stopPropagation();
        button.onclick=()=>{this.ownerCueOffset=(this.ownerCueOffset+1)%rawOwnerCues.length;this.draw();
          this.cueControls.at(-1)?.focus();};
        cueHost.append(button);this.cueControls.push(button);
      }
      }
    }
    // The dashed owner stem must also stop before entering the drawable map;
    // any pixels in the stage belong exclusively to real world-space glyphs.
    // Native buttons in the reserved strip retain touch and keyboard focus.
    for (const cue of labelPositions) this.ownerCueIds.push(cue.id);
    c.restore();
    this.lastMs=performance.now()-begin;
  }
  focusOwner(id: number): void {
    const p=this.points.find(point=>point.id===id);
    if (!p) return;
    this.centerAt(p.x,p.y);
    this.onOwnerFocus?.();
  }
  capture(): string { return this.canvas.toDataURL('image/png'); }
  dispose(): void { this.observer.disconnect();for(const button of this.cueControls) button.remove();this.canvas.remove(); }
}
