import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { RULES, createState } from '../src/rules';
import { layoutSceneCues, queueCueBounds } from '../src/overlay-layout';
import { MetroRenderer } from '../src/renderer';

vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = { remove: vi.fn(), toDataURL: () => '' };
    shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 0;
    autoClear = true;
    render = vi.fn();
    clearDepth = vi.fn();
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});
vi.stubGlobal('window', { devicePixelRatio: 1 });
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
const canvases: { width: number; height: number }[] = [];
vi.stubGlobal('document', {
  createElement: () => {
    const canvas = { width: 0, height: 0 };
    canvases.push(canvas);
    return { ...canvas, getContext: () => ({ clearRect() {}, fillText() {}, strokeText() {},
      set font(_v: string) {}, set textAlign(_v: string) {}, set textBaseline(_v: string) {},
      set fillStyle(_v: string) {}, set strokeStyle(_v: string) {}, set lineWidth(_v: number) {} }) };
  },
});
function setup(width = 390, height = 708) {
  const container = { append: vi.fn(), getBoundingClientRect: () => ({ width, height }) };
  const renderer = new MetroRenderer(container as unknown as HTMLElement);
  const state = createState();
  const p = state.stations[0];
  p.queue = [{ id: 1001, shape: 'triangle', born: 0, transfers: 0 }];
  p.crowd = RULES.hz * 3;
  const update = () => {
    renderer.render(state);
    const placement = layoutSceneCues(state.stations.map((station) => ({
      id: station.id, ...renderer.project(station.x, station.y),
      queue: station.queue.length, crowd: station.crowd, selected: false,
    })), { width, height });
    renderer.updateSceneCues(state, placement);
    return placement;
  };
  const cues = () => (renderer as unknown as { sceneCues: THREE.Scene }).sceneCues;
  const webgl = () => (renderer as unknown as { renderer: { render: ReturnType<typeof vi.fn>; clearDepth: ReturnType<typeof vi.fn>; autoClear: boolean } }).renderer;
  return { renderer, state, update, cues, webgl };
}

describe('station scene cues', () => {
  it('draws destination silhouettes and warning in the WebGL scene at projected layout positions, never a card', () => {
    const { renderer, state, update, cues, webgl } = setup();
    const snapshot = JSON.stringify(state);
    const placement = update().find((p) => p.id === state.stations[0].id)!;
    expect(placement.queue).not.toBeNull();
    expect(placement.warning).toBeNull();
    const queue = cues().getObjectByName(`queue-${state.stations[0].id}`) as THREE.Group;
    const warning = cues().getObjectByName(`warning-${state.stations[0].id}`) as THREE.Group;
    expect(queue).toBeInstanceOf(THREE.Group);
    expect(warning).toBeInstanceOf(THREE.Group);
    const qBounds = queueCueBounds(state.stations[0].queue.length, placement.queue!.level!, true);
    expect(queue.position.x + qBounds.x).toBeCloseTo(placement.queue!.x);
    expect(queue.position.y + qBounds.y).toBeCloseTo(placement.queue!.y);
    expect(queue.children.some((child) => child.userData.shape === 'triangle')).toBe(true);
    expect(warning.position.x).toBeCloseTo(renderer.project(state.stations[0].x, state.stations[0].y).x);
    expect(warning.children.some((child) => child.name === 'warning-ring')).toBe(true);
    expect(warning.getObjectByName('warning-symbol')).toBeUndefined();
    expect(renderer.cueStats()).toMatchObject({ queueCount: 1, warningCount: 0, ringCount: 1,
      queueStationIds: [state.stations[0].id], warningStationIds: [] });
    expect(renderer.cueStats().bounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: state.stations[0].id, kind: 'queue',
        x: placement.queue!.x, y: placement.queue!.y }),
    ]));
    expect(cues().children.some((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.PlaneGeometry)).toBe(false);
    expect(webgl().clearDepth).toHaveBeenCalled();
    expect(webgl().render.mock.calls.at(-1)?.[0]).toBe(cues());
    expect(JSON.stringify(state)).toBe(snapshot);
    renderer.dispose();
  });
  it('renders every real mobile passenger shape in stacked rows, with no count, connector or drifting warning text', () => {
    const { renderer, state, update, cues } = setup(390, 708);
    const p = state.stations[0];
    p.queue = Array.from({ length: 12 }, (_, i) => ({ id: i + 1,
      shape: i % 2 ? 'circle' as const : 'triangle' as const, born: 0, transfers: 0 }));
    p.crowd = RULES.hz;
    const placed = update().find((entry) => entry.id === p.id)!;
    expect(placed.queue).not.toBeNull();
    expect(placed.warning).toBeNull();
    const queue = cues().getObjectByName(`queue-${p.id}`) as THREE.Group;
    const icons = queue.children.filter((child) => child.userData.shape);
    expect(icons.map((icon) => icon.userData.passengerId)).toEqual(p.queue.map((v) => v.id));
    expect(icons.map((icon) => icon.userData.shape)).toEqual(p.queue.map((v) => v.shape));
    expect(new Set(icons.map((icon) => icon.position.y)).size).toBeGreaterThan(1);
    expect(queue.getObjectByName('queue-connector')).toBeUndefined();
    expect(queue.children.some((child) => child instanceof THREE.Mesh &&
      (child.material as THREE.MeshBasicMaterial).map)).toBe(false);
    const warning = cues().getObjectByName(`warning-${p.id}`)!;
    expect(warning.getObjectByName('warning-ring')).toBeTruthy();
    expect(warning.getObjectByName('warning-detail')).toBeUndefined();
    renderer.dispose();
  });

  it('contains projected mesh and texture geometry inside placed rectangles, not guessed cards', () => {
    const { renderer, state, update, cues } = setup();
    const p = state.stations[0];
    const placement = update().find((item) => item.id === p.id)!;
    expect(placement.queue).not.toBeNull();
    const queue = cues().getObjectByName(`queue-${p.id}`)!;
    cues().updateMatrixWorld(true);
    const actual = new THREE.Box3().setFromObject(queue);
    expect(actual.min.x).toBeGreaterThanOrEqual(placement.queue!.x - 0.01);
    expect(actual.max.x).toBeLessThanOrEqual(placement.queue!.x + placement.queue!.width + 0.01);
    expect(actual.min.y).toBeGreaterThanOrEqual(placement.queue!.y - 0.01);
    expect(actual.max.y).toBeLessThanOrEqual(placement.queue!.y + placement.queue!.height + 0.01);
    expect(placement.warning).toBeNull();
    expect(cues().getObjectByName(`warning-${p.id}`)?.getObjectByName('warning-ring')).toBeTruthy();
    renderer.dispose();
  });
  it('does not reupload queue text when its screen position changes without changing passengers', () => {
    const { renderer, state, update, cues } = setup(390, 708);
    state.stations[0].queue = Array.from({ length: 4 }, (_, id) => ({
      id: id + 1, shape: 'triangle' as const, born: 0, transfers: 0,
    }));
    const placed = update();
    const shifted = placed.map((item) => item.queue ? {
      ...item, queue: { ...item.queue, x: item.queue.x + 0.5, y: item.queue.y + 0.5 },
    } : item);
    const count = canvases.length;
    renderer.updateSceneCues(state, shifted);
    expect(canvases).toHaveLength(count);
    expect(cues().getObjectByName(`queue-${state.stations[0].id}`)?.getObjectByName('queue-connector')).toBeUndefined();
    renderer.dispose();
  });
  it('leaves desktop cue geometry without mobile connector lines', () => {
    const { renderer, state, update, cues } = setup(800, 708);
    state.stations[0].queue = Array.from({ length: 3 }, (_, id) => ({
      id, shape: 'triangle' as const, born: 0, transfers: 0,
    }));
    const placed = update().find((item) => item.id === state.stations[0].id)!;
    expect(placed.queue).not.toBeNull();
    expect(cues().getObjectByName(`queue-${state.stations[0].id}`)?.getObjectByName('queue-connector')).toBeUndefined();
    renderer.dispose();
  });
  it('omits an oversized mobile pile rather than drawing a four-digit count', () => {
    const { renderer, state, update, cues } = setup();
    state.stations[0].queue = Array.from({ length: 1200 }, (_, i) => ({
      id: i + 1, shape: 'triangle' as const, born: 0, transfers: 0,
    }));
    const box = update().find((p) => p.id === state.stations[0].id)!.queue;
    expect(box).toBeNull();
    expect(cues().getObjectByName(`queue-${state.stations[0].id}`)).toBeUndefined();
    renderer.dispose();
  });
  it('reprojects on zoom and replay without stale cues, reuses geometry and uploads text only on change', () => {
    const { renderer, state, update, cues } = setup();
    const p = state.stations[0];
    p.queue.push({ id: 1002, shape: 'circle', born: 0, transfers: 0 },
      { id: 1003, shape: 'square', born: 0, transfers: 0 },
      { id: 1004, shape: 'triangle', born: 0, transfers: 0 });
    update();
    const queue = cues().getObjectByName(`queue-${p.id}`) as THREE.Group;
    const originalX = queue.position.x;
    const icon = queue.children.find((child) => child.userData.shape === 'triangle') as THREE.Mesh;
    const geometry = icon.geometry;
    const count = canvases.length;
    update();
    expect(cues().getObjectByName(`queue-${p.id}`)).toBe(queue);
    expect(queue.children.find((child) => child.userData.shape === 'triangle')).toBe(icon);
    expect(canvases).toHaveLength(count);
    renderer.setZoom(1.5);
    update();
    expect(queue.position.x).not.toBe(originalX);
    expect((queue.children.find((child) => child.userData.shape === 'triangle') as THREE.Mesh).geometry).toBe(geometry);
    const afterZoom = canvases.length;
    update();
    expect(canvases).toHaveLength(afterZoom);
    p.crowd += RULES.hz;
    update();
    expect(canvases).toHaveLength(afterZoom);
    state.tick = 100;
    p.queue = [];
    p.crowd = 0;
    update();
    expect(cues().children).toHaveLength(0);
    state.tick = 0;
    p.queue = [{ id: 300, shape: 'triangle', born: 0, transfers: 0 }];
    update();
    expect(cues().getObjectByName(`queue-${p.id}`)).toBeTruthy();
    renderer.dispose();
    expect(geometry).toBeDefined();
  });
  it('reuses the mobile warning ring as crowd time changes and selection moves', () => {
    const { renderer, state, update, cues } = setup(390, 708);
    update();
    const id = state.stations[0].id;
    const ring = cues().getObjectByName(`warning-${id}`)?.getObjectByName('warning-ring');
    state.stations[0].crowd += RULES.hz;
    update();
    expect(cues().getObjectByName(`warning-${id}`)?.getObjectByName('warning-ring')).toBe(ring);
    renderer.dispose();
  });
  it('keeps mobile cue marks bounded and suppresses fallback marks instead of drawing detached warnings', () => {
    const { renderer, state, update, cues } = setup(320, 600);
    const p = state.stations[0];
    p.queue = Array.from({ length: 40 }, (_, i) => ({ id: i + 500, shape: 'triangle' as const, born: 0, transfers: 0 }));
    update();
    const queue = cues().getObjectByName(`queue-${p.id}`) as THREE.Group;
    const bounds = new THREE.Box3().setFromObject(queue);
    expect(bounds.max.x - bounds.min.x).toBeLessThanOrEqual(66);
    const omitted = state.stations.map((station) => ({ id: station.id, queue: null, warning: null,
      queueFallback: true, warningFallback: true }));
    renderer.updateSceneCues(state, omitted);
    expect(cues().getObjectByName(`queue-${p.id}`)).toBeUndefined();
    const warning = cues().getObjectByName(`warning-${p.id}`) as THREE.Group;
    expect(warning.children.some((child) => child.name === 'warning-ring')).toBe(true);
    expect(warning.getObjectByName('warning-symbol')).toBeUndefined();
    expect(renderer.cueStats()).toMatchObject({ queueCount: 0, warningCount: 0, ringCount: 1,
      ringStationIds: [p.id] });
    expect(warning.position.x).toBeCloseTo(renderer.project(p.x, p.y).x);
    renderer.dispose();
  });
});
