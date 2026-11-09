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
const canvases: { width: number; height: number; text: string[] }[] = [];
vi.stubGlobal('document', {
  createElement: () => {
    const canvas = { width: 0, height: 0, text: [] as string[] };
    canvases.push(canvas);
    return { ...canvas, getContext: () => ({ clearRect() {}, fillText(value: string) { canvas.text.push(value); }, strokeText() {},
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
      queue: station.queue.length, queueShapes: station.queue.map((passenger) => passenger.shape),
      crowd: station.crowd, selected: false,
    })), { width, height });
    renderer.updateSceneCues(state, placement);
    return placement;
  };
  const cues = () => (renderer as unknown as { sceneCues: THREE.Scene }).sceneCues;
  const webgl = () => (renderer as unknown as { renderer: { render: ReturnType<typeof vi.fn>; clearDepth: ReturnType<typeof vi.fn>; autoClear: boolean } }).renderer;
  return { renderer, state, update, cues, webgl };
}

describe('station scene cues', () => {
  it('draws destination silhouettes at projected positions with crowd fill inside the station, never a map card', () => {
    const { renderer, state, update, cues, webgl } = setup();
    const snapshot = JSON.stringify(state);
    const placement = update().find((p) => p.id === state.stations[0].id)!;
    expect(placement.queue).not.toBeNull();
    expect(placement.warning).toBeNull();
    const queue = cues().getObjectByName(`queue-${state.stations[0].id}`) as THREE.Group;
    const warning = cues().getObjectByName(`warning-${state.stations[0].id}`);
    expect(queue).toBeInstanceOf(THREE.Group);
    expect(warning).toBeUndefined();
    const qBounds = queueCueBounds(state.stations[0].queue.length, placement.queue!.level!, true);
    expect(queue.position.x + qBounds.x).toBeCloseTo(placement.queue!.x);
    expect(queue.position.y + qBounds.y).toBeCloseTo(placement.queue!.y);
    expect(queue.children.some((child) => child.userData.shape === 'triangle')).toBe(true);
    expect(renderer.cueStats()).toMatchObject({ queueCount: 1, warningCount: 0, ringCount: 0,
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
  it('groups a mobile WebGL queue by destination with exact counts and no floating crowd title', () => {
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
    expect(icons).toHaveLength(0);
    const groups = queue.children as THREE.Group[];
    expect(groups.map((group) => group.children[0].userData.shape)).toEqual(['circle','triangle']);
    expect(groups.every((group) => group.children.length === 2)).toBe(true);
    expect(queue.getObjectByName('queue-connector')).toBeUndefined();
    expect(queue.children.some((child) => child instanceof THREE.Mesh &&
      (child.material as THREE.MeshBasicMaterial).map)).toBe(false);
    expect(cues().getObjectByName(`warning-${p.id}`)).toBeUndefined();
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
    expect(cues().getObjectByName(`warning-${p.id}`)).toBeUndefined();
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
  it('shows each of ten desktop passengers individually below its station', () => {
    const { renderer, state, update, cues } = setup(1024, 768);
    const p = state.stations[0];
    p.queue = Array.from({ length: 10 }, (_, i) => ({ id: 501 + i,
      shape: i % 2 ? 'square' as const : 'triangle' as const, born: 0, transfers: 0 }));
    const placed = update().find((item) => item.id === p.id)!;
    expect(placed.queue).toMatchObject({ level: 'full', height: 26 });
    const anchor = renderer.project(p.x, p.y, 0.6);
    expect(placed.queue!.x + placed.queue!.width / 2).toBeCloseTo(anchor.x);
    expect(placed.queue!.y).toBeGreaterThan(anchor.y + 36);
    const queue = cues().getObjectByName(`queue-${p.id}`) as THREE.Group;
    expect(queue.children.map((child) => child.userData.passengerId)).toEqual(p.queue.map((v) => v.id));
    expect(queue.children.map((child) => child.userData.shape)).toEqual(p.queue.map((v) => v.shape));
    expect(queue.children.some((child) => child instanceof THREE.Mesh &&
      (child.material as THREE.MeshBasicMaterial).map)).toBe(false);
    renderer.dispose();
  });
  it('groups eleven and more by destination in stable shape order with exact multipliers', () => {
    const { renderer, state, update, cues } = setup(1440, 900);
    const p = state.stations[0];
    p.crowd = 0;
    p.queue = [
      ...Array.from({ length: 9 }, (_, i) => ({ id: 601 + i, shape: 'triangle' as const, born: 0, transfers: 0 })),
      { id: 610, shape: 'square', born: 0, transfers: 0 },
      { id: 611, shape: 'circle', born: 0, transfers: 0 },
    ];
    const before = JSON.stringify(state);
    const placed = update().find((item) => item.id === p.id)!;
    const queue = cues().getObjectByName(`queue-${p.id}`) as THREE.Group;
    expect(placed.queue).toMatchObject({ level: 'full', width: 154, height: 21 });
    expect(queue.children.map((child) => child.children[0].userData.shape))
      .toEqual(['circle', 'triangle', 'square']);
    expect(queue.children.some((child) => child.userData.passengerId)).toBe(false);
    const labels = queue.children.flatMap((child) => child.children.filter((mark) => mark instanceof THREE.Mesh &&
      (mark.material as THREE.MeshBasicMaterial).map));
    expect(labels).toHaveLength(3);
    expect(canvases.slice(-3).map((canvas) => canvas.text)).toEqual([['×1'], ['×9'], ['×1']]);
    expect(JSON.stringify(state)).toBe(before);
    renderer.dispose();
  });
  it('keeps all ten destination groups and multi-digit labels inside the desktop cue rectangle', () => {
    const { renderer, state, update, cues } = setup(1440, 900);
    const p = state.stations[0];
    p.crowd = 0;
    const shapes = ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'pentagon', 'egg', 'gem', 'wedge'] as const;
    p.queue = shapes.flatMap((shape, index) => Array.from({ length: index + 12 }, (_, n) => ({
      id: index * 100 + n, shape, born: 0, transfers: 0,
    })));
    const placed = update().find((item) => item.id === p.id)!;
    expect(placed.queue).not.toBeNull();
    expect(placed.queue!.y).toBeGreaterThan(renderer.project(p.x, p.y, 0.6).y + 36);
    const queue = cues().getObjectByName(`queue-${p.id}`)!;
    expect(queue.children.map((child) => child.children[0].userData.shape))
      .toEqual(shapes);
    expect(canvases.slice(-10).map((canvas) => canvas.text[0]))
      .toEqual(shapes.map((_, index) => `×${index + 12}`));
    const actual = new THREE.Box3().setFromObject(queue);
    expect(actual.min.x).toBeGreaterThanOrEqual(placed.queue!.x - 0.01);
    expect(actual.max.x).toBeLessThanOrEqual(placed.queue!.x + placed.queue!.width + 0.01);
    expect(actual.min.y).toBeGreaterThanOrEqual(placed.queue!.y - 0.01);
    expect(actual.max.y).toBeLessThanOrEqual(placed.queue!.y + placed.queue!.height + 0.01);
    renderer.dispose();
  });
  it('centers the real grouped icons under their owner even when caller only supplies a queue total', () => {
    const { renderer, state, cues } = setup(1440, 900);
    const p = state.stations[0];
    p.crowd = 0;
    p.queue = Array.from({ length: 12 }, (_, i) => ({ id: 300 + i,
      shape: 'triangle' as const, born: 0, transfers: 0 }));
    renderer.render(state);
    const placements = layoutSceneCues(state.stations.map((station) => ({
      id: station.id, ...renderer.project(station.x, station.y, 0.6),
      queue: station.queue.length, crowd: station.crowd, selected: false,
    })), { width: 1440, height: 900 });
    renderer.updateSceneCues(state, placements);
    const queue = cues().getObjectByName(`queue-${p.id}`)!;
    const actual = new THREE.Box3().setFromObject(queue);
    expect(queue.position.x).toBeCloseTo(placements.find(item => item.id === p.id)!.queue!.x +
      placements.find(item => item.id === p.id)!.queue!.width / 2);
    expect((actual.min.x + actual.max.x) / 2).toBeGreaterThan(renderer.project(p.x, p.y, 0.6).x - 8);
    renderer.dispose();
  });
  it('keeps a bounded grouped mobile pile even for a large queue', () => {
    const { renderer, state, update, cues } = setup();
    state.stations[0].queue = Array.from({ length: 1200 }, (_, i) => ({
      id: i + 1, shape: 'triangle' as const, born: 0, transfers: 0,
    }));
    const box = update().find((p) => p.id === state.stations[0].id)!.queue;
    expect(box).not.toBeNull();
    expect(cues().getObjectByName(`queue-${state.stations[0].id}`)?.children).toHaveLength(1);
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
  it('updates station fill without a mobile warning ring as crowd time changes', () => {
    const { renderer, state, update, cues } = setup(390, 708);
    update();
    const id = state.stations[0].id;
    const fill = (renderer as unknown as { stations: Map<number, THREE.Group> }).stations.get(id)?.getObjectByName('crowd-fill') as THREE.Mesh;
    state.stations[0].crowd += RULES.hz;
    update();
    expect(cues().getObjectByName(`warning-${id}`)).toBeUndefined();
    expect((renderer as unknown as { stations: Map<number, THREE.Group> }).stations.get(id)?.getObjectByName('crowd-fill')).not.toBe(fill);
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
    expect(cues().getObjectByName(`warning-${p.id}`)).toBeUndefined();
    expect(renderer.cueStats()).toMatchObject({ queueCount: 0, warningCount: 0, ringCount: 0 });
    renderer.dispose();
  });
});
