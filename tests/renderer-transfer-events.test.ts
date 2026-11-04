import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createState } from '../src/rules';
import { MetroRenderer } from '../src/renderer';
import type { Train } from '../src/types';

vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = { remove: vi.fn(), toDataURL: () => '' };
    shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 0;
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});
const canvases: { calls: [string, ...unknown[]][] }[] = [];
vi.stubGlobal('window', { devicePixelRatio: 1 });
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
vi.stubGlobal('document', {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw Error(`unexpected element ${tag}`);
    const canvas = { width: 0, height: 0, calls: [] as [string, ...unknown[]][] };
    const context = new Proxy({}, {
      get: (_target, key) => (...args: unknown[]) => canvas.calls.push([String(key), ...args]),
      set: (_target, key, value) => { canvas.calls.push([String(key), value]); return true; },
    });
    canvases.push(canvas);
    return { ...canvas, getContext: () => context };
  },
});
afterEach(() => { canvases.length = 0; });
function scene() {
  const container = { append: vi.fn(), getBoundingClientRect: () => ({ width: 1000, height: 700 }) };
  const renderer = new MetroRenderer(container as unknown as HTMLElement);
  const state = createState();
  const at = state.stations[0].id;
  const train: Train = {
    id: 900, line: 0, from: at, to: null, progress: 0,
    direction: 1 as const, dwell: 5, passengers: [], carriages: 0, retiring: false, moveTo: null,
  };
  state.lines[0].stops = [at, state.stations[1].id];
  state.trains.push(train);
  for (const station of state.stations) station.nextPassenger = Infinity;
  return { renderer, state, train };
}
function markers(renderer: MetroRenderer) {
  return (renderer as unknown as { transfers: THREE.Group }).transfers.children;
}
function passenger(id: number, shape: 'circle' | 'triangle' | 'square') {
  return { id, shape, born: 0, transfers: 0 };
}

describe('transfer visual feedback for dense stations', () => {
  it('does not replay an old event with the same train ID after a restart at an equal tick', () => {
    const { renderer, state, train } = scene();
    renderer.render(state);
    const oldEvent = { type: 'board' as const, tick: 1, sequence: 0,
      stationId: state.stations[0].id, trainId: train.id, lineId: 0, passengerId: 77, shape: 'triangle' as const };
    state.tick = 2;
    renderer.render(state, 0, [oldEvent]);
    expect(markers(renderer)).toHaveLength(1);
    state.tick = 0; // new run with the same seed and train ID; consumer has no persisted event log
    renderer.render(state, 0, []);
    expect(markers(renderer)).toHaveLength(0);
    renderer.dispose();
  });
  it('does not fabricate snapshot-diff animation when an authoritative empty event batch is supplied', () => {
    const { renderer, state, train } = scene();
    state.stations[0].queue = [passenger(2111, 'triangle')];
    renderer.render(state);
    state.tick++;
    state.stations[0].queue = [];
    train.passengers = [passenger(2111, 'triangle')];
    renderer.render(state, 0, []);
    expect(markers(renderer)).toHaveLength(0);
    renderer.dispose();
  });
  it('keeps several real service events ordered across a tick gap even if renderer snapshots skip frames', () => {
    const { renderer, state, train } = scene();
    const station = state.stations[0];
    train.passengers = [passenger(1001, station.shape as 'circle')];
    renderer.render(state);
    const events = [
      { type: 'arrive' as const, tick: 9, sequence: 0, stationId: station.id, trainId: train.id, lineId: train.line, passengerId: null, shape: null },
      { type: 'deliver' as const, tick: 9, sequence: 1, stationId: station.id, trainId: train.id, lineId: train.line, passengerId: 1001, shape: station.shape },
      { type: 'board' as const, tick: 10, sequence: 0, stationId: station.id, trainId: train.id, lineId: train.line, passengerId: 1002, shape: 'triangle' as const },
    ];
    state.tick = 12;
    state.score++;
    train.passengers = [passenger(1002, 'triangle')];
    renderer.render(state, 0, events);
    expect(markers(renderer).map((m) => [m.userData.passengerId, m.userData.direction])).toEqual([
      [1001, 'alight'], [1002, 'board'],
    ]);
    renderer.render(state, 0, events);
    expect(markers(renderer)).toHaveLength(2);
    renderer.dispose();
  });
  it('keeps multiple alighting passengers tied to their actual train and station without inventing an event on a pause', () => {
    const { renderer, state, train } = scene();
    const station = state.stations[0];
    train.passengers.push(passenger(1001, station.shape as 'circle'), passenger(1002, station.shape as 'circle'));
    renderer.render(state);
    state.tick++;
    state.score += 2;
    train.passengers = [];
    renderer.render(state);
    expect(markers(renderer).map((m) => m.userData.passengerId).sort()).toEqual([1001, 1002]);
    renderer.render(state);
    expect(markers(renderer)).toHaveLength(2);
    renderer.dispose();
  });
});
