import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { RULES, createState, hash } from '../src/rules';
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
