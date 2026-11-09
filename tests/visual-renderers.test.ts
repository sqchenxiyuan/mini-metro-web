import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { RULES, applyAction, createState, hash, trackPoints } from '../src/rules';
import { MetroRenderer } from '../src/renderer';

vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = { remove() {}, toDataURL: () => '' };
    shadowMap = { enabled: false, type: 0 };
    setPixelRatio() {} setSize() {} setClearColor() {} render() {} clearDepth() {} dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});
vi.stubGlobal('window', { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) });
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
vi.stubGlobal('document', { createElement: () => {
  const canvas = { width: 0, height: 0 };
  return { ...canvas, getContext: () => ({ fillText() {}, strokeText() {} }) };
} });

function setup() {
  const renderer = new MetroRenderer({ append() {}, getBoundingClientRect: () => ({ width: 1100, height: 700 }) } as unknown as HTMLElement);
  const state = createState();
  const station = state.stations[0];
  const sceneStation = () => (renderer as unknown as { stations: Map<number, THREE.Group> }).stations.get(station.id)!;
  const cues = () => (renderer as unknown as { sceneCues: THREE.Scene }).sceneCues;
  return { renderer, state, station, sceneStation, cues };
}

describe('desktop renderer visual crowd', () => {
  it('draws one dashed deleted edge while multiple trains occupy it in either direction and removes it only after the last clears', () => {
    const { renderer, state } = setup();
    expect(applyAction(state, { type: 'route', line: 0, stops: [1, 2, 3] }).ok).toBe(true);
    const first = state.trains[0];
    first.from = 2; first.to = 3; first.progress = 0.5;
    expect(applyAction(state, { type: 'addTrain', line: 0, station: 2 }).ok).toBe(true);
    const second = state.trains[1];
    second.from = 3; second.to = 2; second.progress = 0.25;
    expect(applyAction(state, { type: 'route', line: 0, stops: [1, 2] }).ok).toBe(true);
    const tracks = () => (renderer as unknown as { tracks: THREE.Group }).tracks;
    const count = () => tracks().children.filter(child => child instanceof THREE.Mesh &&
      child.geometry instanceof THREE.BoxGeometry && child.position.y === 0.31).length;
    renderer.render(state);
    const initial = count();
    expect(initial).toBeGreaterThan(0);
    first.from = 3; first.to = 2; first.progress = 0.1;
    renderer.render(state);
    expect(count()).toBe(initial);
    second.from = 2; second.to = 1; second.progress = 0.2;
    renderer.render(state);
    expect(count()).toBe(initial);
    first.from = 2; first.to = 1; first.progress = 0.1;
    renderer.render(state);
    expect(count()).toBe(0);
    renderer.dispose();
  });

  it('keeps an outbound and reversing orphan train on the same warped dashed canonical path', () => {
    const { renderer, state } = setup();
    expect(applyAction(state, { type: 'route', line: 0, stops: [1, 2, 3] }).ok).toBe(true);
    const source = structuredClone(state);
    const raw = source.stations;
    // A mobile row expansion bends the canonical 2→3 path between source rows.
    const rows = [...new Set(raw.map(p => p.y))].sort((a, b) => a - b);
    const warp = (x: number, y: number) => {
      let offset = 0;
      for (let i = 1; i < rows.length; i++) {
        const fraction = Math.max(0, Math.min(1, (y - rows[i - 1]) / (rows[i] - rows[i - 1])));
        offset += (i % 2 ? 3 : -1) * fraction;
      }
      return { x: x * .86, y: y + offset };
    };
    const visible = { ...state, stations: state.stations.map(p => ({ ...p, ...warp(p.x, p.y) })) };
    renderer.setRiverTransform(warp);
    renderer.setTrackSource(source, rows);
    const train = state.trains[0];
    train.from = 2; train.to = 3; train.progress = .47;
    const scene = renderer as unknown as {
      trains: Map<number, { group: THREE.Group }>;
      tracks: THREE.Group;
    };
    const trainAt = () => scene.trains.get(train.id)!.group.position.clone();
    const marks = () => scene.tracks.children.filter(child => child instanceof THREE.Mesh &&
      child.geometry instanceof THREE.BoxGeometry && child.position.y === .31) as THREE.Mesh[];
    renderer.render(visible);
    const outbound = trainAt();
    const originalMarks = marks().length;
    const initialHash = hash(state);
    expect(applyAction(state, { type: 'route', line: 0, stops: [1, 2] }).ok).toBe(true);
    renderer.setTrackSource(state, rows);
    renderer.render(visible);
    expect(trainAt().distanceTo(outbound)).toBeLessThan(1e-5);
    const dashes = marks();
    expect(dashes.length).toBeGreaterThan(5);
    // The ghost has no editable active-route segment in the authoritative state.
    expect(state.lines[0].stops).toEqual([1, 2]);
    const nearestDash = (position: THREE.Vector3) => dashes.reduce((nearest, dash) =>
      Math.hypot(dash.position.x - position.x, dash.position.z - position.z) <
        Math.hypot(nearest.position.x - position.x, nearest.position.z - position.z) ? dash : nearest);
    const headingDelta = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    expect(headingDelta(scene.trains.get(train.id)!.group.rotation.y, nearestDash(trainAt()).rotation.y)).toBeLessThan(.15);
    const painted = renderer.getPaintedTrackLayout()!;
    expect(painted.segments.some(edge => edge.from === 2 && edge.to === 3 &&
      edge.lanes.some(lane => lane.lineId === 0))).toBe(true);
    expect(hash(state)).not.toBe(initialHash);
    expect(originalMarks).toBe(0);
    // The queue-warped original rail passes through an intermediate source row;
    // the dashed geometry must retain that bend rather than connecting endpoints.
    const canonical = source.stations;
    const a = canonical.find(p => p.id === 2)!, b = canonical.find(p => p.id === 3)!;
    const straight = { x: (warp(a.x, a.y).x + warp(b.x, b.y).x) / 2,
      y: (warp(a.x, a.y).y + warp(b.x, b.y).y) / 2 };
    const actualMid = dashes[Math.floor(dashes.length / 2)].position;
    expect(Math.hypot(actualMid.x - straight.x, actualMid.z - straight.y)).toBeGreaterThan(.2);
    const distanceToDashes = (position: THREE.Vector3) => Math.min(...dashes.map(dash =>
      Math.hypot(dash.position.x - position.x, dash.position.z - position.z)));
    expect(distanceToDashes(trainAt())).toBeLessThan(.35);
    for (const progress of [.1, .25, .4, .55, .7, .85]) {
      train.from = 2; train.to = 3; train.progress = progress;
      renderer.render(visible);
      const outward = trainAt();
      expect(distanceToDashes(outward)).toBeLessThan(.35);
      expect(headingDelta(scene.trains.get(train.id)!.group.rotation.y, nearestDash(outward).rotation.y)).toBeLessThan(.15);
      train.from = 3; train.to = 2; train.progress = 1 - progress;
      renderer.render(visible);
      expect(trainAt().distanceTo(outward)).toBeLessThan(1e-5);
      expect(distanceToDashes(trainAt())).toBeLessThan(.35);
    }
    train.from = 3; train.to = 2; train.progress = .53;
    const returningHash = hash(state);
    renderer.render(visible);
    expect(hash(state)).toBe(returningHash);
    expect(trainAt().distanceTo(outbound)).toBeLessThan(1e-5);
    expect(headingDelta(scene.trains.get(train.id)!.group.rotation.y,
      nearestDash(trainAt()).rotation.y + Math.PI)).toBeLessThan(.15);
    renderer.dispose();
  });

  it('keeps a ghost on canonical bends when a mobile row is warped after deletion', () => {
    const { renderer, state } = setup();
    expect(applyAction(state, { type: 'route', line: 0, stops: [1, 2, 3] }).ok).toBe(true);
    const raw = structuredClone(state);
    const rows = [...new Set(raw.stations.map(p => p.y))].sort((a, b) => a - b);
    let stretch = 1;
    const warp = (x: number, y: number) => ({ x: x * .86, y: y + stretch * Math.max(0, y - rows[0]) });
    const visible = () => ({ ...state, stations: state.stations.map(p => ({ ...p, ...warp(p.x, p.y) })) });
    renderer.setRiverTransform(warp);
    renderer.setTrackSource(state, rows);
    state.trains[0].from = 2; state.trains[0].to = 3; state.trains[0].progress = .4;
    renderer.render(visible());
    expect(applyAction(state, { type: 'route', line: 0, stops: [1, 2] }).ok).toBe(true);
    renderer.render(visible());
    stretch = 2;
    renderer.setRiverTransform(warp);
    const transformed = visible();
    renderer.render(transformed);
    const live = renderer as unknown as { tracks: THREE.Group; trains: Map<number, { group: THREE.Group }> };
    const marks = live.tracks.children.filter(child =>
      child instanceof THREE.Mesh && child.geometry instanceof THREE.BoxGeometry && child.position.y === .31);
    const rail = renderer.getPaintedTrackLayout()!.segments.find(edge => edge.from === 2 && edge.to === 3)!;
    const sourceBend = trackPoints(raw.stations.find(p => p.id === 2)!, raw.stations.find(p => p.id === 3)!);
    expect(sourceBend.length).toBeGreaterThan(2);
    expect(rail.points.length).toBeGreaterThanOrEqual(sourceBend.length);
    for (const point of sourceBend) expect(rail.points.some(p =>
      Math.hypot(p.x - warp(point.x, point.y).x, p.y - warp(point.x, point.y).y) < 1e-6)).toBe(true);
    // Every original corner survives reflow; recomputing trackPoints from the
    // transformed endpoints would move the bend and fail this assertion.
    const transformedBend = trackPoints(transformed.stations.find(p => p.id === 2)!,
      transformed.stations.find(p => p.id === 3)!);
    expect(rail.points).not.toEqual(transformedBend);
    expect(marks.length).toBeGreaterThan(0);
    const train = live.trains.get(state.trains[0].id)!.group.position;
    expect(Math.min(...marks.map(mark => Math.hypot(mark.position.x - train.x, mark.position.z - train.z))))
      .toBeLessThan(.35);
    renderer.dispose();
  });

  it('uses the orphan lane when another line still owns the same pair', () => {
    const { renderer, state } = setup();
    expect(applyAction(state, { type: 'route', line: 0, stops: [1, 2, 3] }).ok).toBe(true);
    expect(applyAction(state, { type: 'route', line: 1, stops: [2, 3] }).ok).toBe(true);
    const train = state.trains[0];
    train.from = 2; train.to = 3; train.progress = .45;
    const group = () => (renderer as unknown as { trains: Map<number, { group: THREE.Group }> }).trains.get(train.id)!.group;
    renderer.render(state);
    const before = group().position.clone();
    expect(applyAction(state, { type: 'route', line: 0, stops: [1, 2] }).ok).toBe(true);
    renderer.render(state);
    expect(group().position.distanceTo(before)).toBeLessThan(1e-5);
    const layout = renderer.getPaintedTrackLayout()!;
    expect(layout.segments.filter(edge => edge.from === 2 && edge.to === 3).map(edge =>
      edge.lanes.map(lane => lane.lineId))).toEqual([[1], [0]]);
    renderer.render(state);
    expect(group().position.distanceTo(before)).toBeLessThan(1e-5);
    renderer.dispose();
  });

  it('clips red fill inside the original station shape, rises from bottom and recedes without a floating warning', () => {
    const { renderer, state, station, sceneStation, cues } = setup();
    station.crowd = RULES.crowdTicks / 4;
    const stateHash = hash(state);
    renderer.render(state);
    expect(hash(state)).toBe(stateHash);
    const fill = sceneStation().getObjectByName('crowd-fill') as THREE.Mesh;
    expect(fill).toBeInstanceOf(THREE.Mesh);
    expect(fill.userData.fraction).toBeCloseTo(.25);
    expect(fill.geometry.getAttribute('position').count).toBeGreaterThan(0);
    station.crowd = RULES.crowdTicks / 2;
    renderer.render(state);
    expect((sceneStation().getObjectByName('crowd-fill') as THREE.Mesh).userData.fraction).toBeCloseTo(.5);
    station.crowd = RULES.crowdTicks / 4;
    renderer.render(state);
    expect((sceneStation().getObjectByName('crowd-fill') as THREE.Mesh).userData.fraction).toBeCloseTo(.25);
    renderer.updateSceneCues(state, []);
    expect(cues().getObjectByName(`warning-${station.id}`)).toBeUndefined();
    expect(sceneStation().getObjectByName('warning-ring')).toBeUndefined();
    station.crowd = 0;
    renderer.render(state);
    expect(sceneStation().getObjectByName('crowd-fill')).toBeUndefined();
    renderer.dispose();
  });
  it('keeps full-red loss exclusive to normal/extreme', () => {
    const { renderer, state, station, sceneStation } = setup();
    station.crowd = RULES.crowdTicks;
    for (const mode of ['normal', 'extreme', 'endless', 'creative'] as const) {
      state.mode = mode;
      renderer.render(state);
      expect((sceneStation().getObjectByName('crowd-fill') as THREE.Mesh).userData.fraction)
        [mode === 'normal' || mode === 'extreme' ? 'toBe' : 'toBeLessThan'](1);
    }
    renderer.dispose();
  });
  it('leaves central destination signs and pale keylines legible through all ten silhouettes and interchange scales', () => {
    const { renderer, state, station, sceneStation } = setup();
    const shapes = ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'pentagon', 'egg', 'gem', 'wedge'] as const;
    for (const shape of shapes) for (const interchange of [false, true]) for (const fraction of [.1, .5, 1, .25, 0]) {
      station.shape = shape;
      station.interchange = interchange;
      station.crowd = Math.round(RULES.crowdTicks * fraction);
      renderer.render(state);
      const stationMesh = sceneStation();
      const slabs = stationMesh.children.filter((object) => object instanceof THREE.Mesh) as THREE.Mesh[];
      const fill = stationMesh.getObjectByName('crowd-fill') as THREE.Mesh | undefined;
      expect(stationMesh.scale.x).toBe(interchange ? 1.3 : 1);
      expect(slabs.length).toBe(fraction ? 6 : 5);
      if (fill) {
        expect(fill.position.y).toBeGreaterThan(.745);
        expect(fill.position.y).toBeLessThan(.765);
        expect(fill.renderOrder).toBeLessThanOrEqual(slabs[4].renderOrder);
        expect(fill.userData.fraction).toBeCloseTo(fraction, 2);
      } else expect(fraction).toBe(0);
    }
    renderer.dispose();
  });
  it('jiggles every individual x/y slot while paused snapshots and reduced motion stay still', () => {
    const { renderer, state, station, cues } = setup();
    station.queue = [11, 12, 13].map(id => ({ id, born: 0, transfers: 0, shape: 'triangle' as const }));
    const placement = [{ id: station.id, queue: { x: 400, y: 420, width: 66, height: 32, level: 'full' as const }, warning: null,
      warningFallback: false, queueFallback: false }];
    const positions = () => (cues().getObjectByName(`queue-${station.id}`) as THREE.Group).children
      .filter(child => child.userData.passengerId).map(child => child.position.clone());
    renderer.render(state); renderer.updateSceneCues(state, placement);
    const initial = positions();
    state.tick = 100;
    renderer.updateSceneCues(state, placement);
    const changed = positions();
    expect(changed.every((point, index) => point.x !== initial[index].x && point.y !== initial[index].y)).toBe(true);
    expect(new Set(changed.map((point, index) => `${point.x-initial[index].x},${point.y-initial[index].y}`)).size).toBe(3);
    renderer.updateSceneCues(state, placement);
    expect(positions()).toEqual(changed);
    const oldMatchMedia = globalThis.matchMedia;
    Object.assign(globalThis, { matchMedia: () => ({ matches: true }) });
    renderer.updateSceneCues(state, placement);
    expect(positions().every((p, index) => p.x === [-11, 0, 11][index] && p.y === 0)).toBe(true);
    Object.assign(globalThis, { matchMedia: oldMatchMedia });
    renderer.dispose();
  });
  it('keeps exact grouped destination counts attached to each moving icon', () => {
    const { renderer, state, station, cues } = setup();
    station.queue = Array.from({length: 11}, (_,index) => ({id:index+100, born:0, transfers:0,
      shape:index%2?'triangle' as const:'square' as const}));
    const placement = [{ id: station.id, queue: { x: 400, y: 420, width: 104, height: 21, level: 'full' as const },
      warning: null, warningFallback: false, queueFallback: false }];
    renderer.render(state); renderer.updateSceneCues(state, placement);
    const groups = () => (cues().getObjectByName(`queue-${station.id}`) as THREE.Group).children as THREE.Group[];
    expect(groups().map(group => group.name)).toEqual(['queue-group-triangle','queue-group-square']);
    expect(groups().every(group => group.children.length === 2 && group.children[0] instanceof THREE.Mesh &&
      group.children[1] instanceof THREE.Mesh)).toBe(true);
    const before=groups().map(group => group.position.clone());
    state.tick=120;renderer.updateSceneCues(state,placement);
    expect(groups().every((group,index) => group.position.x !== before[index].x && group.position.y !== before[index].y)).toBe(true);
    renderer.dispose();
  });
  it('does not allocate crowd geometry again for an unchanged paused or replayed snapshot', () => {
    const {renderer,state,station,sceneStation}=setup();
    station.crowd=RULES.crowdTicks/2;
    renderer.render(state);
    const first=sceneStation().getObjectByName('crowd-fill');
    renderer.render(state);
    expect(sceneStation().getObjectByName('crowd-fill')).toBe(first);
    state.tick=18;renderer.render(state);
    expect(sceneStation().getObjectByName('crowd-fill')).toBe(first);
    state.tick=0;renderer.render(state);
    expect(sceneStation().getObjectByName('crowd-fill')).toBe(first);
    renderer.dispose();
  });
});
