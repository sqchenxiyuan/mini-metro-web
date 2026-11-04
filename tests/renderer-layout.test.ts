import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { LINE_COLORS, createState } from '../src/rules';
import * as layoutModule from '../src/track-layout';
import { MetroRenderer } from '../src/renderer';

vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = { remove: vi.fn(), toDataURL: () => '' };
    shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 0;
    setPixelRatio() {}
    setSize = vi.fn();
    setClearColor() {}
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});
vi.stubGlobal('window', { devicePixelRatio: 1 });
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
vi.stubGlobal('document', {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw Error(`unexpected element ${tag}`);
    const context = new Proxy({}, {
      get: () => () => {},
      set: () => true,
    });
    return { width: 0, height: 0, getContext: () => context };
  },
});

function setup() {
  const container = { append: vi.fn(), getBoundingClientRect: () => ({ width: 1200, height: 800 }) };
  const renderer = new MetroRenderer(container as unknown as HTMLElement);
  const state = createState();
  state.stations[0].x = -5;
  state.stations[0].y = 0;
  state.stations[1].x = 5;
  state.stations[1].y = 0;
  return { renderer, state };
}
function tracks(renderer: MetroRenderer) {
  return (renderer as unknown as { tracks: THREE.Group }).tracks.children as THREE.Mesh[];
}
function trackColors(renderer: MetroRenderer) {
  return tracks(renderer).map((item) => (item.material as THREE.MeshStandardMaterial).color.getHexString());
}

describe('automatic camera framing', () => {
  it('widens before the scheduled spawn so even an edge station appears inside the view without a spawn-time snap', () => {
    const { renderer, state } = setup();
    state.nextStation = 1680;
    const frame = () => (renderer as unknown as { frameSize: { width: number; height: number } }).frameSize.width;
    renderer.render(state);
    const start = frame();
    state.elapsed = state.nextStation - 120;
    renderer.render(state);
    const middle = frame();
    state.elapsed = state.nextStation - 1;
    renderer.render(state);
    const before = frame();
    const centerBefore = { ...(renderer as unknown as { center: { x: number; y: number } }).center };
    const edge = { x: 15.5 * (0.48 + state.nextStation / 1680 * 0.12), y: 9.3 * (0.48 + state.nextStation / 1680 * 0.12) };
    const projected = renderer.project(edge.x, edge.y);
    expect(middle).toBeGreaterThan(start);
    expect(before).toBeGreaterThan(middle);
    expect(projected.x).toBeGreaterThan(0);
    expect(projected.x).toBeLessThan(1200);
    expect(projected.y).toBeGreaterThan(0);
    expect(projected.y).toBeLessThan(800);
    state.elapsed = state.nextStation;
    state.nextStation += 400;
    state.stations.push({ ...state.stations[0], id: 900, ...edge, queue: [] });
    renderer.render(state);
    expect(Math.abs(frame() - before)).toBeLessThan(0.25);
    const centerAfter = (renderer as unknown as { center: { x: number; y: number } }).center;
    expect(Math.hypot(centerAfter.x - centerBefore.x, centerAfter.y - centerBefore.y)).toBeLessThan(0.25);
    renderer.dispose();
  });
  it('updates projection without reallocating the WebGL drawing buffer during the lead-in', () => {
    const { renderer, state } = setup();
    state.nextStation = 1680;
    renderer.render(state);
    const webgl = (renderer as unknown as { renderer: { setSize: ReturnType<typeof vi.fn> } }).renderer;
    webgl.setSize.mockClear();
    for (const tick of [state.nextStation - 180, state.nextStation - 120, state.nextStation - 60]) {
      state.elapsed = tick;
      renderer.render(state);
    }
    expect(webgl.setSize).not.toHaveBeenCalled();
    renderer.dispose();
  });
  it('resizes the drawing buffer when the container itself changes size', () => {
    let width = 1200;
    const container = { append: vi.fn(), getBoundingClientRect: () => ({ width, height: 800 }) };
    const renderer = new MetroRenderer(container as unknown as HTMLElement);
    const webgl = (renderer as unknown as { renderer: { setSize: ReturnType<typeof vi.fn> } }).renderer;
    webgl.setSize.mockClear();
    width = 900;
    (renderer as unknown as { resize: () => void }).resize();
    expect(webgl.setSize).toHaveBeenCalledWith(900, 800);
    renderer.dispose();
  });
  it('restores the opening field of view for a new game after an expanded late game', () => {
    const { renderer, state } = setup();
    state.nextStation = 1680;
    renderer.render(state);
    state.elapsed = state.nextStation - 1;
    renderer.render(state);
    const expanded = (renderer as unknown as { frameSize: { width: number } }).frameSize.width;
    renderer.resetCamera();
    const fresh = createState();
    renderer.render(fresh);
    const opening = (renderer as unknown as { frameSize: { width: number } }).frameSize.width;
    expect(opening).toBeLessThan(expanded);
    expect(opening).toBe(19);
    renderer.dispose();
  });
  it('keeps the whole spawn envelope inside the portrait viewport before spawning', () => {
    const container = { append: vi.fn(), getBoundingClientRect: () => ({ width: 390, height: 708 }) };
    const renderer = new MetroRenderer(container as unknown as HTMLElement);
    const state = createState();
    state.nextStation = 1680;
    renderer.render(state);
    state.elapsed = state.nextStation - 1;
    renderer.render(state);
    const range = 0.48 + (state.nextStation / 1680) * 0.12;
    for (const x of [-15.5 * range, 15.5 * range])
      for (const y of [-9.3 * range, 9.3 * range]) {
        const p = renderer.project(x, y);
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(390);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(708);
      }
    renderer.dispose();
  });
  it('does not undo a player camera adjustment while waiting for a station', () => {
    const { renderer, state } = setup();
    renderer.render(state);
    renderer.setZoom(1.4);
    renderer.pan(40, 30);
    const before = { size: { ...(renderer as unknown as { frameSize: { width: number; height: number } }).frameSize },
      center: { ...(renderer as unknown as { center: { x: number; y: number } }).center } };
    state.elapsed = state.nextStation - 1;
    renderer.render(state);
    expect((renderer as unknown as { frameSize: { width: number; height: number } }).frameSize).toEqual(before.size);
    expect((renderer as unknown as { center: { x: number; y: number } }).center).toEqual(before.center);
    expect(renderer.getZoom()).toBe(1.4);
    renderer.dispose();
  });
});

describe('shared station visual layout', () => {
  it('draws seven ordered touching colors over one continuous pale backing when seven lines share a segment in either direction', () => {
    const { renderer, state } = setup();
    const a = state.stations[0].id, b = state.stations[1].id;
    state.lines = LINE_COLORS.map((_, id) => ({ id, stops: id % 2 ? [b, a] : [a, b], loop: false }));
    renderer.render(state);
    const objects = tracks(renderer);
    const white = objects.filter((m) => (m.material as THREE.MeshStandardMaterial).color.getHexString() === 'fffaf6');
    expect(white).toHaveLength(1);
    const whitePosition = white[0].geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(Math.max(...Array.from({ length: whitePosition.count }, (_, i) => whitePosition.getY(i) + white[0].position.y))).toBeLessThan(0.325);
    const colors = new Set(LINE_COLORS.map((c) => new THREE.Color(c).getHexString()));
    const colored = objects.filter((m) => colors.has((m.material as THREE.MeshStandardMaterial).color.getHexString()));
    expect(colored).toHaveLength(7);
    const minX = Math.min(...colored.flatMap((m) => {
      const geo = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      return Array.from({ length: geo.count }, (_, i) => geo.getX(i) + m.position.x);
    }));
    expect(minX).toBeLessThan(-4.8);
    // For a straight X-axis segment, the offset is visible in the Z coordinates of the tube endpoints.
    const zs = colored.map((m) => (m.geometry as THREE.TubeGeometry).parameters.path.getPoint(0).z).sort((x, y) => x - y);
    for (let i = 1; i < zs.length; i++) expect(zs[i] - zs[i - 1]).toBeCloseTo(0.21, 4);
    expect(new Set(trackColors(renderer).filter((c) => colors.has(c))).size).toBe(7);
    renderer.dispose();
  });
  it('does not invent an approach across a shorter branch than the approach length', () => {
    const { renderer, state } = setup();
    const center = state.stations[0], one = state.stations[1], two = state.stations[2];
    center.x = 0; center.y = 0;
    one.x = 3; one.y = 0;
    two.x = 0.5; two.y = 0.3;
    state.lines = [{ id: 0, stops: [center.id, one.id], loop: false }, { id: 1, stops: [center.id, two.id], loop: false }];
    renderer.render(state);
    const overlays = tracks(renderer).filter((m) => (m.geometry as THREE.TubeGeometry).parameters.path.getPoint(0).y > 0.45);
    expect(overlays).toHaveLength(0);
    renderer.dispose();
  });
  it('hides old colors at the same station after the route is cleared', () => {
    const { renderer, state } = setup();
    const [a, b] = state.stations;
    state.lines[0].stops = [a.id, b.id];
    renderer.render(state);
    expect(tracks(renderer).length).toBeGreaterThan(0);
    state.lines[0].stops = [];
    renderer.render(state);
    expect(tracks(renderer)).toHaveLength(0);
    renderer.dispose();
  });
  it('places seven colors around a straight station approach without masking the tracks with a pale rail', () => {
    const { renderer, state } = setup();
    const a = state.stations[0].id, b = state.stations[1].id;
    state.lines = LINE_COLORS.map((_, id) => ({ id, stops: [a, b], loop: false }));
    renderer.render(state);
    const white = tracks(renderer).filter((m) => (m.material as THREE.MeshStandardMaterial).color.getHexString() === 'fffaf6');
    expect(white).toHaveLength(1);
    const whites = white[0].geometry.getAttribute('position') as THREE.BufferAttribute;
    const maxY = Math.max(...Array.from({ length: whites.count }, (_, i) => whites.getY(i) + white[0].position.y));
    expect(maxY).toBeLessThan(0.32);
    renderer.dispose();
  });
  it('renders reversed-coordinate shared-edge color order consistently with its own train at the dense station', () => {
    const { renderer, state } = setup();
    const [a,b,c] = state.stations;
    a.x=8; a.y=0; b.x=0; b.y=0; c.x=7; c.y=1;
    state.lines=[{id:0,stops:[a.id,b.id],loop:false},{id:1,stops:[a.id,b.id],loop:false},{id:2,stops:[a.id,c.id],loop:false}];
    state.trains=[{id:900,line:1,from:a.id,to:b.id,progress:0.08,direction:1,dwell:0,passengers:[],carriages:0,retiring:false,moveTo:null}];
    renderer.render(state);
    const group=(renderer as unknown as {trains:Map<number,{group:THREE.Group}>}).trains.get(900)!.group;
    const rail=tracks(renderer).find((m)=>(m.material as THREE.MeshStandardMaterial).color.getHexString()===new THREE.Color(LINE_COLORS[1]).getHexString())!;
    const path=(rail.geometry as THREE.TubeGeometry).parameters.path;
    const expectedZ=path.getPoint(0).z+(path.getPoint(1).z-path.getPoint(0).z)*0.08;
    expect(group.position.z).toBeCloseTo(expectedZ,3);
    renderer.dispose();
  });
  it('renders a shared pair plus a distinct same-sector branch with three non-overlapping station entrances', () => {
    const { renderer, state } = setup();
    const [a,b,c] = state.stations;
    a.x=0; a.y=0; b.x=8; b.y=0; c.x=7; c.y=1;
    state.lines=[{id:0,stops:[a.id,b.id],loop:false},{id:1,stops:[a.id,b.id],loop:false},{id:2,stops:[a.id,c.id],loop:false}];
    renderer.render(state);
    const paths=tracks(renderer).filter((m)=>LINE_COLORS.some((col)=>new THREE.Color(col).getHexString()===(m.material as THREE.MeshStandardMaterial).color.getHexString()))
      .map((m)=>(m.geometry as THREE.TubeGeometry).parameters.path.getPoint(0))
      .filter((point)=>Math.abs(point.x-a.x)<0.00001);
    expect(paths).toHaveLength(3);
    const z=paths.map((point)=>point.z).sort((x,y)=>x-y);
    for(let i=1;i<z.length;i++)expect(z[i]-z[i-1]).toBeCloseTo(0.21,4);
    renderer.dispose();
  });
  it('keeps distinct same-sector branches separated beyond the entrance and aligns their trains to those visible lanes', () => {
    const { renderer, state } = setup();
    const origin = state.stations[0], one = state.stations[1], two = state.stations[2];
    origin.x = 0; origin.y = 0; one.x = 7; one.y = 1; two.x = 7; two.y = 2;
    state.lines = [
      { id: 0, stops: [origin.id, one.id], loop: false },
      { id: 1, stops: [origin.id, two.id], loop: false },
    ];
    state.trains = state.lines.map((line) => ({ id: 50 + line.id, line: line.id,
      from: origin.id, to: line.stops[1], progress: 0.4, direction: 1 as const, dwell: 0,
      passengers: [], carriages: 0, retiring: false, moveTo: null }));
    renderer.render(state);
    const colors = LINE_COLORS.slice(0, 2).map((c) => new THREE.Color(c).getHexString());
    const paths = tracks(renderer).filter((m) => colors.includes((m.material as THREE.MeshStandardMaterial).color.getHexString()))
      .map((m) => ({ color: (m.material as THREE.MeshStandardMaterial).color.getHexString(),
        a: (m.geometry as THREE.TubeGeometry).parameters.path.getPoint(0),
        b: (m.geometry as THREE.TubeGeometry).parameters.path.getPoint(1) }));
    const atMid = paths.filter((p) => Math.min(p.a.x, p.b.x) < 3 && Math.max(p.a.x, p.b.x) > 3);
    expect(new Set(atMid.map((p) => p.color)).size).toBe(2);
    const z = atMid.map((p) => p.a.z + (p.b.z - p.a.z) * ((3 - p.a.x) / (p.b.x - p.a.x))).sort((a,b) => a-b);
    expect(z[1] - z[0]).toBeCloseTo(0.21, 2);
    const groups = (renderer as unknown as { trains: Map<number, { group: THREE.Group }> }).trains;
    const trains = [...groups.values()].map((v) => v.group.position.z).sort((a,b)=>a-b);
    expect(trains[1] - trains[0]).toBeCloseTo(0.21, 2);
    renderer.dispose();
  });
  it('keeps reverse-direction trains on the same interpolating branch lane', () => {
    const { renderer, state } = setup();
    const [a,b,c] = state.stations;
    state.stations.push({ ...a, id: 777, x: 1, y: 0, queue: [] });
    a.x=0; a.y=0; b.x=8; b.y=0; c.x=7; c.y=1;
    state.lines = [{ id:0, stops:[a.id,c.id],loop:false },{ id:1,stops:[b.id,a.id],loop:false },{ id:2,stops:[b.id,777],loop:false }];
    state.trains=[{id:889,line:1,from:b.id,to:a.id,progress:0.5,direction:1,dwell:0,passengers:[],carriages:0,retiring:false,moveTo:null}];
    renderer.render(state);
    const target=tracks(renderer).find((m)=>(m.material as THREE.MeshStandardMaterial).color.getHexString()===new THREE.Color(LINE_COLORS[1]).getHexString())!;
    const path=(target.geometry as THREE.TubeGeometry).parameters.path;
    const train=(renderer as unknown as { trains: Map<number,{group:THREE.Group}> }).trains.get(889)!.group;
    expect(train.position.z).toBeCloseTo((path.getPoint(0).z+path.getPoint(1).z)/2,3);
    renderer.dispose();
  });
  it('renders a lane that transitions between disagreeing endpoint sectors and keeps the train on it', () => {
    const { renderer, state } = setup();
    const [a,b,c] = state.stations;
    state.stations.push({ ...a, id: 777, x: 1, y: 0, queue: [] });
    a.x=0; a.y=0; b.x=8; b.y=0; c.x=7; c.y=1;
    state.lines = [
      { id:0, stops:[a.id,c.id], loop:false },
      { id:1, stops:[a.id,b.id], loop:false },
      { id:2, stops:[b.id,777], loop:false },
    ];
    state.trains=[{id:888,line:1,from:a.id,to:b.id,progress:0.5,direction:1,dwell:0,passengers:[],carriages:0,retiring:false,moveTo:null}];
    renderer.render(state);
    const target = tracks(renderer).find((m) => (m.material as THREE.MeshStandardMaterial).color.getHexString() === new THREE.Color(LINE_COLORS[1]).getHexString())!;
    const path=(target.geometry as THREE.TubeGeometry).parameters.path;
    const start=path.getPoint(0),end=path.getPoint(1);
    expect(start.z).not.toBeCloseTo(end.z);
    const train=(renderer as unknown as { trains: Map<number,{group:THREE.Group}> }).trains.get(888)!.group;
    expect(train.position.z).toBeCloseTo((start.z+end.z)/2,3);
    renderer.dispose();
  });
  it('draws two distinct same-sector routes to different neighbors as a touching pair near the station', () => {
    const { renderer, state } = setup();
    const center = state.stations[0], one = state.stations[1], two = state.stations[2];
    center.x = 0; center.y = 0;
    one.x = 6; one.y = 0;
    two.x = 6; two.y = 0.3;
    state.lines = [
      { id: 0, stops: [center.id, one.id], loop: false },
      { id: 1, stops: [center.id, two.id], loop: false },
    ];
    renderer.render(state);
    const colors = LINE_COLORS.slice(0, 2).map((c) => new THREE.Color(c).getHexString());
    const p = tracks(renderer).filter((m) => colors.includes((m.material as THREE.MeshStandardMaterial).color.getHexString()));
    const first = p.filter((m) => (m.geometry as THREE.TubeGeometry).parameters.path.getPoint(0).x === center.x &&
      (m.geometry as THREE.TubeGeometry).parameters.path.getPoint(0).y > 0.42);
    expect(first).toHaveLength(2);
    expect(first.every((m) => (m.geometry as THREE.TubeGeometry).parameters.path.getPoint(0).y === 0.43)).toBe(true);
    const zs = first.map((m) => (m.geometry as THREE.TubeGeometry).parameters.path.getPoint(0).z).sort((a, b) => a - b);
    expect(zs[1] - zs[0]).toBeCloseTo(0.21, 4);
    renderer.dispose();
  });
  it('preserves lane geometry when a hand-supplied path contains a degenerate segment', () => {
    const { renderer } = setup();
    const helper = renderer as unknown as { trackVertices: (points: {x:number;y:number}[], offset:number, height:number) => THREE.Vector3[] };
    const points=[{x:0,y:0},{x:0,y:0},{x:4,y:0}];
    const vertices=helper.trackVertices(points,0.105,0.48);
    expect(vertices).toHaveLength(2);
    expect(vertices[0].x).toBeCloseTo(0);
    expect(vertices[1].x).toBeCloseTo(4);
    renderer.dispose();
  });
  it('keeps train interpolation aligned when a degenerate first leg precedes a real leg', () => {
    const { renderer, state } = setup();
    const a = state.stations[0], b = state.stations[1];
    a.x=0; a.y=0; b.x=4; b.y=4.0000001;
    state.lines[0].stops=[a.id,b.id];
    state.trains=[{id:991,line:0,from:a.id,to:b.id,progress:0.25,direction:1,dwell:0,passengers:[],carriages:0,retiring:false,moveTo:null}];
    expect(() => renderer.render(state)).not.toThrow();
    const group=(renderer as unknown as {trains:Map<number,{group:THREE.Group}>}).trains.get(991)!.group;
    expect(Number.isFinite(group.position.x)).toBe(true);
    expect(Number.isFinite(group.position.z)).toBe(true);
    renderer.dispose();
  });
  it('keeps train interpolation aligned when a near-zero centerline segment is skipped', () => {
    const { renderer, state } = setup();
    const a = state.stations[0], b = state.stations[1];
    a.x = 0; a.y = 0; b.x = 0.0000001; b.y = 0.0000001;
    state.lines[0].stops = [a.id,b.id];
    state.trains=[{id:990,line:0,from:a.id,to:b.id,progress:0.5,direction:1,dwell:0,passengers:[],carriages:0,retiring:false,moveTo:null}];
    expect(() => renderer.render(state)).not.toThrow();
    const group = (renderer as unknown as {trains:Map<number,{group:THREE.Group}>}).trains.get(990)!.group;
    expect(Number.isFinite(group.position.x)).toBe(true);
    expect(Number.isFinite(group.position.z)).toBe(true);
    renderer.dispose();
  });
  it('keeps an outer-lane train centered on its visible mitered bend', () => {
    const { renderer, state } = setup();
    const a = state.stations[0], b = state.stations[1];
    a.x = 0; a.y = 0; b.x = 8; b.y = 3;
    state.lines = LINE_COLORS.map((_, id) => ({ id, stops: [a.id, b.id], loop: false }));
    state.trains = [{ id: 990, line: 6, from: a.id, to: b.id,
      progress: 5 / (5 + Math.hypot(3, 3)), direction: 1, dwell: 0,
      passengers: [], carriages: 0, retiring: false, moveTo: null }];
    renderer.render(state);
    const color = new THREE.Color(LINE_COLORS[6]).getHexString();
    const rails = tracks(renderer).filter((m) =>
      (m.material as THREE.MeshStandardMaterial).color.getHexString() === color);
    expect(rails).toHaveLength(2);
    const bend = (rails[0].geometry as THREE.TubeGeometry).parameters.path.getPoint(1);
    const train = (renderer as unknown as { trains: Map<number, { group: THREE.Group }> }).trains.get(990)!.group.position;
    expect(Math.hypot(train.x - bend.x, train.z - bend.z)).toBeLessThan(0.105);
    renderer.dispose();
  });
  it('keeps a 45-degree offset bend miter inside the two intended parallel lane edges', () => {
    const { renderer, state } = setup();
    const a = state.stations[0], b = state.stations[1];
    a.x = -4; a.y = 0; b.x = 4; b.y = 3;
    state.lines = [
      { id: 0, stops: [a.id, b.id], loop: false },
      { id: 1, stops: [a.id, b.id], loop: false },
    ];
    renderer.render(state);
    const colored = tracks(renderer).filter((m) =>
      (m.material as THREE.MeshStandardMaterial).color.getHexString() === new THREE.Color(LINE_COLORS[0]).getHexString());
    expect(colored).toHaveLength(2);
    const joint = (colored[0].geometry as THREE.TubeGeometry).parameters.path.getPoint(1);
    const bend = { x: b.x - Math.abs(b.y - a.y), y: a.y };
    const offset = -0.105;
    const normalA = { x: 0, y: -1 };
    const normalB = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
    const factor = offset / (1 + Math.SQRT1_2);
    expect(joint.x).toBeCloseTo(bend.x + (normalA.x + normalB.x) * factor, 4);
    expect(joint.z).toBeCloseTo(bend.y + (normalA.y + normalB.y) * factor, 4);
    renderer.dispose();
  });
  it('derives the route layout once per unchanged frame, even with 32 moving trains', () => {
    const { renderer, state } = setup();
    const [a, b] = state.stations;
    state.lines[0].stops = [a.id, b.id];
    state.trains = Array.from({ length: 32 }, (_, id) => ({
      id: 1000 + id, line: 0, from: a.id, to: b.id, progress: id / 64,
      direction: 1 as const, dwell: 0, passengers: [], carriages: 0, retiring: false, moveTo: null,
    }));
    const count = vi.spyOn(layoutModule, 'deriveTrackLayout');
    renderer.render(state);
    const first = count.mock.calls.length;
    expect(first).toBe(1);
    state.tick++;
    state.trains.forEach((t) => { t.progress += 0.01; });
    renderer.render(state);
    expect(count.mock.calls.length).toBe(first);
    count.mockRestore();
    renderer.dispose();
  });
  it('keeps trains on their own colored rail when station ID order opposes spatial order', () => {
    const { renderer, state } = setup();
    const a = state.stations[0], b = state.stations[1];
    a.x = 5; a.y = 0; b.x = -5; b.y = 0;
    state.lines = [
      { id: 0, stops: [a.id, b.id], loop: false },
      { id: 1, stops: [b.id, a.id], loop: false },
    ];
    state.trains = state.lines.map((line) => ({ id: 200 + line.id, line: line.id,
      from: line.stops[0], to: line.stops[1], progress: 0.5,
      direction: 1 as const, dwell: 0, passengers: [], carriages: 0, retiring: false, moveTo: null }));
    renderer.render(state);
    const meshes = tracks(renderer);
    const trains = (renderer as unknown as { trains: Map<number, { group: THREE.Group }> }).trains;
    for (const line of state.lines) {
      const color = new THREE.Color(LINE_COLORS[line.id]).getHexString();
      const mesh = meshes.find((m) => (m.material as THREE.MeshStandardMaterial).color.getHexString() === color)!;
      const path = (mesh.geometry as THREE.TubeGeometry).parameters.path;
      const train = trains.get(200 + line.id)!.group;
      expect(train.position.z).toBeCloseTo(path.getPoint(0).z, 4);
      expect(train.position.z).toBeCloseTo(path.getPoint(1).z, 4);
    }
    renderer.dispose();
  });
  it('places trains on their own visible color lane when seven lines share a segment', () => {
    const { renderer, state } = setup();
    const a = state.stations[0].id, b = state.stations[1].id;
    state.lines = LINE_COLORS.map((_, id) => ({ id, stops: id % 2 ? [b, a] : [a, b], loop: false }));
    state.trains = state.lines.map((line) => ({
      id: 200 + line.id, line: line.id, from: line.stops[0], to: line.stops[1],
      progress: 0.5, direction: 1 as const, dwell: 0, passengers: [], carriages: 0,
      retiring: false, moveTo: null,
    }));
    renderer.render(state);
    const trainGroups = (renderer as unknown as { trains: Map<number, { group: THREE.Group }> }).trains;
    const zs = [...trainGroups.values()].map((value) => value.group.position.z).sort((x, y) => x - y);
    expect(new Set(zs.map((z) => z.toFixed(3))).size).toBe(7);
    for (let i = 1; i < zs.length; i++) expect(zs[i] - zs[i - 1]).toBeCloseTo(0.21, 4);
    renderer.dispose();
  });
  it('enlarges an upgraded station without replacing its destination silhouette', () => {
    const { renderer, state } = setup();
    state.stations[0].shape = 'triangle';
    renderer.render(state);
    const stations = (renderer as unknown as { stations: Map<number, THREE.Group> }).stations;
    expect(stations.get(state.stations[0].id)?.scale.x).toBe(1);
    state.stations[0].interchange = true;
    renderer.render(state);
    const upgraded = stations.get(state.stations[0].id)!;
    expect(upgraded.scale.x).toBeGreaterThanOrEqual(1.25);
    expect(upgraded.scale.x).toBeLessThanOrEqual(1.35);
    expect(upgraded.userData.shape).toBe('triangle');
    renderer.dispose();
  });
});
