// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  LINE_COLORS,
  RULES,
  riverCount,
  riverX,
  segments,
  station,
  trackPoints,
  trackPosition,
} from './rules';
import type { City, ServiceEvent, Shape, State, Station } from './types';
import { deriveTrackLayout } from './track-layout';

const MAT = (color: THREE.ColorRepresentation, roughness = 0.85) =>
  new THREE.MeshStandardMaterial({ color, roughness, flatShading: true });
function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function box(
  w: number,
  h: number,
  d: number,
  color: THREE.ColorRepresentation,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(w, h, d), MAT(color), x, y, z);
}
function sphere(r: number, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0): THREE.Mesh {
  return mesh(new THREE.SphereGeometry(r, 12, 8), MAT(color), x, y, z);
}
function roundedBox(
  w: number, h: number, d: number, radius: number, color: string, x = 0, y = 0, z = 0,
): THREE.Mesh {
  const material = MAT(color);
  material.flatShading = false;
  return mesh(new RoundedBoxGeometry(w, h, d, 2, radius), material, x, y, z);
}
function disposeGroup(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      for (const m of Array.isArray(object.material) ? object.material : [object.material])
        m.dispose();
    }
  });
  group.clear();
}
// The destination silhouette is the station architecture, not a character.
export function stationOutline(shape: Shape, radius: number): THREE.Shape {
  const outline = new THREE.Shape();
  if (shape === 'circle') {
    outline.absarc(0, 0, radius, 0, Math.PI * 2, false);
    return outline;
  }
  let points: number[][];
  if (shape === 'triangle') {
    points = [[0, 1], [-0.9, -0.7], [0.9, -0.7]];
  } else if (shape === 'square') {
    points = [[-0.78, 0.78], [-0.78, -0.78], [0.78, -0.78], [0.78, 0.78]];
  } else if (shape === 'diamond') {
    points = [[0, 1], [-1, 0], [0, -1], [1, 0]];
  } else if (shape === 'star') {
    points = Array.from({ length: 10 }, (_, i) => {
      const a = -i * Math.PI / 5;
      const r = i % 2 ? 0.48 : 1;
      return [Math.sin(a) * r, Math.cos(a) * r];
    });
  } else if (shape === 'pentagon') {
    points = Array.from({ length: 5 }, (_, i) => [Math.sin(i * 2 * Math.PI / 5), Math.cos(i * 2 * Math.PI / 5)]);
  } else if (shape === 'egg') {
    points = Array.from({ length: 16 }, (_, i) => {
      const a = i * 2 * Math.PI / 16;
      return [Math.sin(a) * (0.75 - Math.cos(a) * 0.17), Math.cos(a)];
    });
  } else if (shape === 'gem') {
    points = [[-0.8, 0.44], [-0.48, 0.86], [0.48, 0.86], [0.8, 0.44], [0.57, -0.68], [0, -1], [-0.57, -0.68]];
  } else if (shape === 'wedge') {
    points = [[-0.9, -0.86], [0.86, -0.86], [0.86, 0.98]];
  } else {
    points = [[-0.34, 1], [-0.34, 0.34], [-1, 0.34], [-1, -0.34],
      [-0.34, -0.34], [-0.34, -1], [0.34, -1], [0.34, -0.34],
      [1, -0.34], [1, 0.34], [0.34, 0.34], [0.34, 1]];
  }
  // Round each corner without losing the destination silhouette.
  const corner = (i: number, neighbor: number) => {
    const a = points[i], b = points[(neighbor + points.length) % points.length];
    return [(a[0] * 0.88 + b[0] * 0.12) * radius,
      (a[1] * 0.88 + b[1] * 0.12) * radius];
  };
  const first = corner(0, 1);
  outline.moveTo(first[0], first[1]);
  for (let n = 1; n <= points.length; n++) {
    const i = n % points.length, before = corner(i, i - 1), after = corner(i, i + 1);
    outline.lineTo(before[0], before[1]);
    outline.quadraticCurveTo(points[i][0] * radius, points[i][1] * radius, after[0], after[1]);
  }
  outline.closePath();
  return outline;
}
function stationSlab(
  shape: Shape, radius: number, height: number, depth: number, color: string, bevel: number,
): THREE.Mesh {
  const slab = mesh(new THREE.ExtrudeGeometry(stationOutline(shape, radius), {
    depth,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 3,
    curveSegments: 8,
    steps: 1,
  }), MAT(color), 0, height);
  slab.rotation.x = -Math.PI / 2;
  return slab;
}
function makeStation(p: Station): THREE.Group {
  const g = new THREE.Group();
  const palettes: Record<Shape, [string, string]> = {
    circle: ['#efb5cd', '#84516f'],
    triangle: ['#a6d9cd', '#3e7778'],
    square: ['#c5b8e8', '#69538f'],
    diamond: ['#aad2ed', '#456e9a'],
    star: ['#f4d28e', '#967039'],
    cross: ['#eeb8ac', '#a15c60'],
    pentagon: ['#d9c4ef', '#6a558a'],
    egg: ['#e7d9aa', '#827144'],
    gem: ['#b0dce7', '#3d7885'],
    wedge: ['#d9c6b0', '#80604b'],
  };
  const [roof, sign] = palettes[p.shape];
  // Soft, rounded station roofs with a pale rim and contrasting destination signs.
  g.add(stationSlab(p.shape, 0.61, 0.23, 0.05, '#fffaf6', 0.045));
  g.add(stationSlab(p.shape, 0.43, 0.33, 0.2, '#91b4c4', 0.035));
  g.add(stationSlab(p.shape, 0.53, 0.53, 0.035, '#fff9f5', 0.045));
  g.add(stationSlab(p.shape, 0.5, 0.6, 0.09, roof, 0.055));
  g.add(stationSlab(p.shape, 0.29, 0.75, 0.018, sign, 0.008));
  g.position.set(p.x, 0, p.y);
  return g;
}
function trainModel(color: string, carriages: number): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i <= carriages; i++) {
    const z = -i * 0.8;
    g.add(roundedBox(0.52, 0.38, 0.72, 0.09, color, 0, 0.25, z));
    g.add(roundedBox(0.46, 0.14, 0.62, 0.065, '#fffaf4', 0, 0.44, z));
    g.add(roundedBox(0.34, 0.17, 0.035, 0.015, '#627b9e', 0, 0.3, z + 0.354));
    for (const x of [-0.259, 0.259])
      for (const dz of [-0.15, 0.12])
        g.add(roundedBox(0.018, 0.14, 0.18, 0.008, '#d4e8f4', x, 0.3, z + dz));
    for (const x of [-0.255, 0.255])
      for (const dz of [-0.2, 0.2]) g.add(sphere(0.075, '#797c95', x, 0.08, z + dz));
    if (i === 0) {
      for (const x of [-0.14, 0.14]) g.add(sphere(0.038, '#fff0bd', x, 0.18, z + 0.36));
    }
  }
  return g;
}
// Canvas texture keeps the small, camera-facing load card readable at map zoom.
function trainLoadCard(passengers: State['trains'][number]['passengers'], carriages: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 156;
  const ctx = canvas.getContext('2d')!;
  const counts = new Map<Shape, number>();
  for (const p of passengers) counts.set(p.shape, (counts.get(p.shape) ?? 0) + 1);
  const groups = [...counts].sort(([a], [b]) => a.localeCompare(b));
  const rows = Math.max(1, Math.ceil(groups.length / 5));
  const cardHeight = groups.length ? 74 + rows * 39 : 83;
  ctx.fillStyle = '#fffaf6';
  ctx.strokeStyle = '#465069';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(3, 3, 378, cardHeight, 15);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#283248';
  ctx.font = 'bold 35px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${passengers.length} / ${RULES.capacity * (1 + carriages)}`, 192, 42);
  groups.forEach(([shape, count], i) => {
    const col = i % 5, row = Math.floor(i / 5);
    const x = 33 + col * 73, y = 82 + row * 39;
    const outline = stationOutline(shape, 14);
    const points = outline.getPoints(20);
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index) ctx.lineTo(x + point.x, y - point.y);
      else ctx.moveTo(x + point.x, y - point.y);
    });
    ctx.closePath();
    ctx.fillStyle = '#3e5877';
    ctx.fill();
    ctx.fillStyle = '#283248';
    ctx.font = 'bold 25px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`×${count}`, x + 17, y + 9);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  badge.name = 'train-load';
  badge.position.set(0, 1.55, -carriages * 0.4);
  badge.scale.set(2.55, 1.04, 1);
  badge.renderOrder = 20;
  return badge;
}
function disposeBadge(badge: THREE.Sprite): void {
  (badge.material as THREE.SpriteMaterial).map?.dispose();
  badge.material.dispose();
}
type LoadSnapshot = {
  tick: number;
  seed: number;
  score: number;
  trains: Map<number, { from: number; to: number | null; line: number; passengers: Map<number, Shape> }>;
  queues: Map<number, Set<number>>;
};
type Transfer = { sprite: THREE.Sprite; start: THREE.Vector3; end: THREE.Vector3; tick: number };
function transferMarker(shape: Shape): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fffaf6';
  ctx.strokeStyle = '#283248';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(32, 32, 29, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const points = stationOutline(shape, 19).getPoints(28);
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i) ctx.lineTo(32 + p.x, 32 - p.y);
    else ctx.moveTo(32 + p.x, 32 - p.y);
  });
  ctx.closePath();
  ctx.fillStyle = '#3e5877';
  ctx.fill();
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
  sprite.scale.set(0.7, 0.7, 1);
  sprite.renderOrder = 21;
  return sprite;
}
export class MetroRenderer {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 120);
  private environment = new THREE.Group();
  private tracks = new THREE.Group();
  private preview = new THREE.Group();
  private stations = new Map<number, THREE.Group>();
  private trains = new Map<number, { group: THREE.Group; carriages: number; line: number; loadKey: string }>();
  private transfers = new THREE.Group();
  private activeTransfers: Transfer[] = [];
  private loadSnapshot: LoadSnapshot | null = null;
  private city: City | null = null;
  private routeKey = '';
  private trackLayout: ReturnType<typeof deriveTrackLayout> | null = null;
  private observer: ResizeObserver;
  private zoom = 1;
  private manualCamera = false;
  private frameKey = '';
  private frameSize = { width: 22, height: 14 };
  private previousTrainAnchors = new Map<number, THREE.Vector3>();
  private center = { x: 0, y: 0 };
  private bounds = { width: 1, height: 1 };
  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      alpha: true,
    });
    this.canvas = this.renderer.domElement;
    container.append(this.canvas);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor('#fff8f5', 0);
    this.scene.add(new THREE.HemisphereLight('#fff8f6', '#bdc3e1', 1.7));
    const sun = new THREE.DirectionalLight('#fff8ef', 1.9);
    sun.position.set(-12, 26, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, {
      left: -25,
      right: 25,
      top: 25,
      bottom: -25,
      near: 1,
      far: 70,
    });
    sun.shadow.bias = -0.0007;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = 3;
    this.scene.add(sun);
    this.scene.add(this.environment, this.tracks, this.preview, this.transfers);
    this.camera.position.set(0, 32, 24);
    this.camera.lookAt(0, 0, 0);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }
  setZoom(value: number): void {
    this.manualCamera = true;
    this.zoom = Math.max(0.8, Math.min(1.8, value));
    this.resize();
  }
  getZoom(): number {
    return this.zoom;
  }
  pan(dx: number, dy: number): void {
    this.manualCamera = true;
    this.center.x = Math.max(
      -12,
      Math.min(
        12,
        this.center.x - (dx * (this.camera.right - this.camera.left)) / this.bounds.width,
      ),
    );
    this.center.y = Math.max(
      -8,
      Math.min(
        8,
        this.center.y - (dy * (this.camera.top - this.camera.bottom)) / this.bounds.height / 0.8,
      ),
    );
    this.camera.position.set(this.center.x, 32, 24 + this.center.y);
    this.camera.lookAt(this.center.x, 0, this.center.y);
  }
  resetCamera(): void {
    this.manualCamera = false;
    this.frameKey = '';
    this.zoom = 1;
  }
  private resize(): void {
    const { width, height } = this.container.getBoundingClientRect();
    this.bounds = { width: Math.max(1, width), height: Math.max(1, height) };
    this.renderer.setSize(this.bounds.width, this.bounds.height);
    const aspect = this.bounds.width / this.bounds.height,
      half = Math.max(this.frameSize.height / 2, this.frameSize.width / aspect / 2) / this.zoom;
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
  }
  private buildEnvironment(city: City): void {
    disposeGroup(this.environment);
    this.city = city;
    const ground = mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshBasicMaterial({ color: '#fff8f5', toneMapped: false }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.castShadow = false;
    this.environment.add(ground);
    const shadow = mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ color: '#8f83a6', opacity: 0.09 }),
      0,
      0.015,
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.castShadow = false;
    this.environment.add(shadow);
    for (let river = 0; river < riverCount(city); river++) {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= 600; i++) {
        const y = -90 + i * 0.3;
        points.push(new THREE.Vector3(riverX(city, y, river), 0.04, y));
      }
      const makeRibbon = (width: number, color: string, height: number) => {
        const vertices: number[] = [],
          indices: number[] = [];
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          vertices.push(p.x - width, height, p.z, p.x + width, height, p.z);
          if (i < points.length - 1) {
            const a = i * 2;
            indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        const material = new THREE.MeshBasicMaterial({
          color,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        const water = mesh(geometry, material);
        water.castShadow = false;
        this.environment.add(water);
      };
      makeRibbon(0.97, '#e7f2f5', 0.045);
      makeRibbon(0.89, '#c8e5f0', 0.05);
    }
  }
  private track(
    a: Station,
    b: Station,
    color: string,
    group: THREE.Group,
    offset = 0,
    ghost = false,
  ): void {
    const points = trackPoints(a, b);
    for (let i = 1; i < points.length; i++)
      this.trackPiece(points[i - 1], points[i], color, group, offset, ghost);
  }
  private trackPiece(
    a: { x: number; y: number },
    b: { x: number; y: number },
    color: string,
    group: THREE.Group,
    offset = 0,
    ghost = false,
  ): void {
    const dx = b.x - a.x,
      dz = b.y - a.y,
      len = Math.hypot(dx, dz),
      ox = (dz / len) * offset,
      oz = (-dx / len) * offset;
    if (ghost) {
      for (let d = 0; d < len; d += 0.5) {
        const t = (d + 0.12) / len;
        const mark = box(0.07, 0.025, 0.25, color, a.x + dx * t + ox, 0.31, a.y + dz * t + oz);
        mark.rotation.y = Math.atan2(dx, dz);
        group.add(mark);
      }
      return;
    }
    const path = new THREE.LineCurve3(
      new THREE.Vector3(a.x + ox, 0.31, a.y + oz),
      new THREE.Vector3(b.x + ox, 0.31, b.y + oz),
    );
    group.add(mesh(new THREE.TubeGeometry(path, 1, 0.15, 12, false), MAT('#fffaf6')));
    const colored = new THREE.LineCurve3(
      new THREE.Vector3(a.x + ox, 0.43, a.y + oz),
      new THREE.Vector3(b.x + ox, 0.43, b.y + oz),
    );
    group.add(mesh(new THREE.TubeGeometry(colored, 1, 0.105, 8, false), MAT(color)));
  }
  private drawLane(
    points: { x: number; y: number }[], offset: number, radius: number,
    color: string, group: THREE.Group, height: number,
    endpointOffsets?: { from: number; to: number },
  ): void {
    const vertices: THREE.Vector3[] = [];
    const startOffset = endpointOffsets?.from ?? offset;
    const endOffset = endpointOffsets?.to ?? offset;
    const totalLength = points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
    let traveled = 0;
    const at = (distance: number) => startOffset + (endOffset - startOffset) * (totalLength ? distance / totalLength : 0);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dz = b.y - a.y;
      const length = Math.hypot(dx, dz);
      if (length < 1e-6) continue;
      const nx = dz / length, nz = -dx / length;
      if (!vertices.length) vertices.push(new THREE.Vector3(a.x + nx * at(0), height, a.y + nz * at(0)));
      traveled += length;
      const localOffset = at(traveled);
      // Meet the adjacent offset segments with a bounded miter, avoiding a visible corner crack.
      if (i < points.length - 1) {
        const next = points[i + 1], ndx = next.x - b.x, ndz = next.y - b.y;
        const nLength = Math.hypot(ndx, ndz);
        if (nLength > 1e-6) {
          const mx = ndz / nLength, mz = -ndx / nLength;
          const scale = 1 + nx * mx + nz * mz;
          if (scale > 0.5) {
            const miter = localOffset / scale;
            vertices.push(new THREE.Vector3(b.x + (nx + mx) * miter, height, b.y + (nz + mz) * miter));
            continue;
          }
        }
      }
      vertices.push(new THREE.Vector3(b.x + nx * localOffset, height, b.y + nz * localOffset));
    }
    if (vertices.length < 2) return;
    // Each offset segment remains straight through the station entrance.
    for (let i = 1; i < vertices.length; i++) {
      const path = new THREE.LineCurve3(vertices[i - 1], vertices[i]);
      group.add(mesh(new THREE.TubeGeometry(path, 1, radius, 10, false), MAT(color)));
    }
  }
  private laneOffset(layout: ReturnType<typeof deriveTrackLayout> | null, lineId: number, from: number, to: number, progress = 0): number {
    const segment = layout?.segments.find((edge) =>
      (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from));
    const lane = segment?.lanes.find((item) => item.lineId === lineId);
    if (!lane || !segment) return 0;
    const endpoints = segment.endpointOffsets;
    const t = from === segment.from ? progress : 1 - progress;
    const canonical = endpoints ? endpoints.from + (endpoints.to - endpoints.from) * t : lane.offset;
    return from === segment.from ? canonical : -canonical;
  }
  showPreview(s: State, stops: number[], line: number, valid = true): void {
    disposeGroup(this.preview);
    for (let i = 1; i < stops.length; i++)
      this.track(
        station(s, stops[i - 1]),
        station(s, stops[i]),
        valid ? LINE_COLORS[line] : '#e75c58',
        this.preview,
        0,
        true,
      );
  }
  clearPreview(): void {
    disposeGroup(this.preview);
  }
  private clearTransfers(): void {
    for (const { sprite } of this.activeTransfers) disposeBadge(sprite);
    this.activeTransfers = [];
    this.transfers.clear();
  }
  private updateTransfers(s: State, events?: readonly ServiceEvent[]): void {
    const previous = this.loadSnapshot;
    const current: LoadSnapshot = {
      tick: s.tick,
      seed: s.seed,
      score: s.score,
      trains: new Map(s.trains.map((t) => [t.id, {
        from: t.from, to: t.to, line: t.line,
        passengers: new Map(t.passengers.map((p) => [p.id, p.shape])),
      }])),
      queues: new Map(s.stations.map((p) => [p.id, new Set(p.queue.map((q) => q.id))])),
    };
    const delta = previous ? s.tick - previous.tick : 0;
    if (!previous || previous.seed !== s.seed || delta < 0 || delta > 8) this.clearTransfers();
    if (previous && previous.seed === s.seed && delta > 0 && delta <= 8 && events === undefined) {
      let delivered = Math.max(0, s.score - previous.score);
      for (const t of s.trains) {
        const old = previous.trains.get(t.id);
        if (!old || old.line !== t.line ||
            (old.to !== null ? old.to !== t.from : old.from !== t.from)) continue;
        const p = s.stations.find((p) => p.id === t.from);
        if (!p) continue;
        const start = new THREE.Vector3(p.x - 0.85, 1.05, p.y + 0.55);
        const door = new THREE.Vector3(p.x, 1.14, p.y);
        // Passenger IDs must move between the actual queue and this train.
        for (const passenger of t.passengers) {
          if (!old.passengers.has(passenger.id) &&
              previous.queues.get(t.from)?.has(passenger.id) &&
              !current.queues.get(t.from)?.has(passenger.id))
            this.addTransfer(passenger.id, passenger.shape, 'board', start, door, s.tick);
        }
        const removed = [...old.passengers].filter(([id]) =>
          !current.trains.get(t.id)!.passengers.has(id));
        // A transferred ID is in the station queue; a delivered ID matches
        // the station shape and consumes one of the observed score increments.
        for (const [id, shape] of removed) {
          if (current.queues.get(t.from)?.has(id))
            this.addTransfer(id, shape, 'alight', door, start, s.tick);
          else if (shape === p.shape && delivered > 0) {
            this.addTransfer(id, shape, 'alight', door, start, s.tick);
            delivered--;
          }
        }
      }
    }
    if (events?.length && previous && previous.seed === s.seed && delta > 0) {
      // The simulation log, not adjacent-render diffs, is authoritative across missed frames.
      const valid = events.filter((event) => event.tick > previous.tick && event.tick <= s.tick)
        .sort((a, b) => a.tick - b.tick || a.sequence - b.sequence);
      for (const event of valid) {
        if (event.type !== 'board' && event.type !== 'deliver' && event.type !== 'transferOut') continue;
        if (event.passengerId === null || event.shape === null) continue;
        const p = s.stations.find((item) => item.id === event.stationId);
        if (!p) continue;
        const waiting = new THREE.Vector3(p.x - 0.85, 1.05, p.y + 0.55);
        const trainAnchor = this.previousTrainAnchors.get(event.trainId);
        const door = trainAnchor && trainAnchor.distanceTo(new THREE.Vector3(p.x, 0.48, p.y)) < 2.2
          ? new THREE.Vector3(trainAnchor.x, 1.14, trainAnchor.z)
          : new THREE.Vector3(p.x, 1.14, p.y);
        const boarding = event.type === 'board';
        this.addTransfer(event.passengerId, event.shape, boarding ? 'board' : 'alight',
          boarding ? waiting : door, boarding ? door : waiting, s.tick);
      }
    }
    // No simulated passengers are added; these are visual echoes of observed ID changes.
    for (const transfer of [...this.activeTransfers]) {
      const progress = (s.tick - transfer.tick) / 5;
      if (progress >= 1) {
        this.transfers.remove(transfer.sprite);
        disposeBadge(transfer.sprite);
        this.activeTransfers.splice(this.activeTransfers.indexOf(transfer), 1);
      } else {
        transfer.sprite.position.copy(transfer.start).lerp(transfer.end, Math.max(0, progress));
      }
    }
    this.loadSnapshot = current;
  }
  private addTransfer(
    passengerId: number, shape: Shape, direction: 'board' | 'alight',
    start: THREE.Vector3, end: THREE.Vector3, tick: number,
  ): void {
    const sprite = transferMarker(shape);
    sprite.userData = { passengerId, direction };
    this.transfers.add(sprite);
    this.activeTransfers.push({ sprite, start, end, tick });
  }
  render(s: State, selectedLine = 0, events?: readonly ServiceEvent[]): void {
    this.updateTransfers(s, events);
    if (this.city !== s.city) this.buildEnvironment(s.city);
    const frameKey = JSON.stringify(s.stations.map((p) => [p.x, p.y]));
    if (!this.manualCamera && frameKey !== this.frameKey) {
      this.frameKey = frameKey;
      const xs = s.stations.map((p) => p.x),
        ys = s.stations.map((p) => p.y);
      const minX = Math.min(...xs),
        maxX = Math.max(...xs),
        minY = Math.min(...ys),
        maxY = Math.max(...ys);
      this.center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      this.frameSize = {
        width: Math.max(19, maxX - minX + 9),
        height: Math.max(13, (maxY - minY) * 0.8 + 9),
      };
      this.camera.position.set(this.center.x, 32, 24 + this.center.y);
      this.camera.lookAt(this.center.x, 0, this.center.y);
      this.resize();
    }
    const live = new Set(s.stations.map((p) => p.id));
    for (const [id, g] of this.stations)
      if (!live.has(id)) {
        this.scene.remove(g);
        disposeGroup(g);
        this.stations.delete(id);
      }
    for (const p of s.stations) {
      let g = this.stations.get(p.id);
      if (g && g.userData.shape !== p.shape) {
        this.scene.remove(g);
        disposeGroup(g);
        g = undefined;
      }
      if (!g) {
        g = makeStation(p);
        g.userData.shape = p.shape;
        this.stations.set(p.id, g);
        this.scene.add(g);
      }
      g.position.set(p.x, 0, p.y);
      g.scale.setScalar(p.interchange ? 1.3 : 1);
    }
    const ghost = s.trains.filter(
      (t) =>
        t.to !== null &&
        !segments(s.lines[t.line]).some(
          ([a, b]) => (a === t.from && b === t.to) || (b === t.from && a === t.to),
        ),
    );
    const key = JSON.stringify([s.lines, ghost.map((t) => [t.line, t.from, t.to]), selectedLine]);
    if (key !== this.routeKey) {
      this.routeKey = key;
      disposeGroup(this.tracks);
      this.trackLayout = deriveTrackLayout(s);
      for (const edge of this.trackLayout.segments) {
        this.drawLane(edge.points, 0, 0.105, '#fffaf6', this.tracks, 0.20);
        for (const lane of edge.lanes)
          this.drawLane(edge.points, lane.offset, 0.105, LINE_COLORS[lane.lineId], this.tracks, 0.43, edge.endpointOffsets);
      }
      for (const t of ghost)
        this.track(
          station(s, t.from),
          station(s, t.to!),
          LINE_COLORS[t.line],
          this.tracks,
          0,
          true,
        );
    }
    const trainIds = new Set(s.trains.map((t) => t.id));
    for (const [id, t] of this.trains)
      if (!trainIds.has(id)) {
        this.scene.remove(t.group);
        const card = t.group.getObjectByName('train-load');
        if (card instanceof THREE.Sprite) disposeBadge(card);
        disposeGroup(t.group);
        this.trains.delete(id);
      }
    for (const t of s.trains) {
      let entry = this.trains.get(t.id);
      if (!entry || entry.carriages !== t.carriages || entry.line !== t.line) {
        if (entry) {
          this.scene.remove(entry.group);
          const card = entry.group.getObjectByName('train-load');
          if (card instanceof THREE.Sprite) disposeBadge(card);
          disposeGroup(entry.group);
        }
        entry = {
          group: trainModel(LINE_COLORS[t.line], t.carriages),
          carriages: t.carriages,
          line: t.line,
          loadKey: '',
        };
        this.trains.set(t.id, entry);
        this.scene.add(entry.group);
      }
      const loadKey = JSON.stringify([t.carriages, t.passengers.map((p) => p.shape).sort()]);
      if (entry.loadKey !== loadKey) {
        const old = entry.group.getObjectByName('train-load');
        if (old instanceof THREE.Sprite) {
          entry.group.remove(old);
          disposeBadge(old);
        }
        entry.group.add(trainLoadCard(t.passengers, t.carriages));
        entry.loadKey = loadKey;
      }
      const a = station(s, t.from),
        b = t.to !== null ? station(s, t.to) : a,
        position = trackPosition(a, b, t.progress),
        lane = t.to !== null ? this.laneOffset(this.trackLayout, t.line, t.from, t.to, t.progress) : 0,
        tangent = new THREE.Vector2(Math.sin(position.angle), Math.cos(position.angle)),
        lateral = new THREE.Vector2(tangent.y, -tangent.x);
      entry.group.position.set(position.x + lateral.x * lane, 0.48, position.y + lateral.y * lane);
      if (t.to !== null) entry.group.rotation.y = position.angle;
      entry.group.visible = true;
    }
    this.previousTrainAnchors = new Map([...this.trains].map(([id, entry]) => [id, entry.group.position.clone()]));
    this.renderer.render(this.scene, this.camera);
  }
  project(x: number, y: number, height = 0.6): { x: number; y: number } {
    const v = new THREE.Vector3(x, height, y).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.bounds.width, y: ((1 - v.y) / 2) * this.bounds.height };
  }
  unproject(x: number, y: number): { x: number; y: number } | null {
    const ndc = new THREE.Vector2(
        (x / this.bounds.width) * 2 - 1,
        1 - (y / this.bounds.height) * 2,
      ),
      ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const point = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point)) return null;
    return { x: point.x, y: point.z };
  }
  capture(): string {
    return this.canvas.toDataURL('image/png');
  }
  dispose(): void {
    this.observer.disconnect();
    this.clearTransfers();
    this.loadSnapshot = null;
    this.previousTrainAnchors.clear();
    this.trackLayout = null;
    disposeGroup(this.environment);
    disposeGroup(this.tracks);
    disposeGroup(this.preview);
    for (const g of this.stations.values()) disposeGroup(g);
    for (const t of this.trains.values()) {
      const card = t.group.getObjectByName('train-load');
      if (card instanceof THREE.Sprite) disposeBadge(card);
      disposeGroup(t.group);
    }
    this.renderer.dispose();
    this.canvas.remove();
  }
}
