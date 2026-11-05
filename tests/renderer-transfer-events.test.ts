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
  it('replaces a same-rider marker if the replay station changes at the same tick', () => {
    const { renderer, state, train } = scene();
    state.tick = 7;
    train.transfer = { passenger: passenger(777, 'triangle'), direction: 'board',
      stationId: state.stations[0].id, duration: 2, progress: 1 };
    renderer.render(state);
    const before = markers(renderer)[0];
    train.transfer = { ...train.transfer, stationId: state.stations[1].id };
    renderer.render(state, 0, []);
    expect(markers(renderer)).toHaveLength(1);
    expect(markers(renderer)[0]).not.toBe(before);
    expect(markers(renderer)[0].userData.stationId).toBe(state.stations[1].id);
    renderer.dispose();
  });
  it('replaces a marker at the same tick when the same rider has a different transfer direction', () => {
    const { renderer, state, train } = scene();
    state.tick = 7;
    train.transfer = { passenger: passenger(777, 'triangle'), direction: 'board',
      stationId: state.stations[0].id, duration: 2, progress: 1 };
    renderer.render(state);
    const before = markers(renderer)[0];
    train.transfer = { ...train.transfer, direction: 'alight' };
    renderer.render(state, 0, []);
    expect(markers(renderer)).toHaveLength(1);
    expect(markers(renderer)[0]).not.toBe(before);
    expect(markers(renderer)[0].userData.direction).toBe('alight');
    renderer.dispose();
  });
  it('clears a live marker when replay replaces the state at the same tick', () => {
    const { renderer, state, train } = scene();
    state.tick = 7;
    train.transfer = { passenger: passenger(777, 'triangle'), direction: 'board',
      stationId: state.stations[0].id, duration: 2, progress: 1 };
    renderer.render(state);
    expect(markers(renderer)).toHaveLength(1);
    train.transfer = null;
    renderer.render(state, 0, []);
    expect(markers(renderer)).toHaveLength(0);
    renderer.dispose();
  });
  it('shows a completed in-transit endpoint before the passenger enters the carriage', () => {
    const { renderer, state, train } = scene();
    const id = 902;
    train.transfer = { passenger: passenger(id, 'triangle'), direction: 'board',
      stationId: state.stations[0].id, duration: 1, progress: 0 };
    renderer.render(state);
    const start = markers(renderer)[0].position.clone();
    state.tick++;
    train.transfer.progress = 1;
    renderer.render(state);
    const end = markers(renderer)[0].position.clone();
    expect(end.distanceTo(start)).toBeGreaterThan(0.1);
    expect(train.passengers).toHaveLength(0);
    state.tick++;
    train.transfer = null;
    train.passengers.push(passenger(id, 'triangle'));
    renderer.render(state);
    expect(markers(renderer)).toHaveLength(0);
    renderer.dispose();
  });
  it('draws a transfer directly from authoritative progress on the first frame or after seek', () => {
    const { renderer, state, train } = scene();
    train.transfer = { passenger: passenger(901, 'triangle'), direction: 'board',
      stationId: state.stations[0].id, duration: 2, progress: 1 };
    renderer.render(state, 0, []);
    expect(markers(renderer)).toHaveLength(1);
    expect(markers(renderer)[0].userData).toMatchObject({ passengerId: 901, trainId: 900, direction: 'board' });
    const pos = markers(renderer)[0].position.clone();
    state.tick += 20;
    renderer.render(state, 0, []);
    expect(markers(renderer)).toHaveLength(1);
    expect(markers(renderer)[0].position.distanceTo(pos)).toBe(0);
    renderer.dispose();
  });
  it('does not replay an old event with the same train ID after a restart at an equal tick', () => {
    const { renderer, state, train } = scene();
    renderer.render(state);
    const oldEvent = { type: 'board' as const, tick: 1, sequence: 0,
      stationId: state.stations[0].id, trainId: train.id, lineId: 0, passengerId: 77, shape: 'triangle' as const };
    state.tick = 2;
    train.transfer = { passenger: passenger(77, 'triangle'), direction: 'board',
      stationId: state.stations[0].id, duration: 2, progress: 1 };
    renderer.render(state, 0, [oldEvent]);
    expect(markers(renderer)).toHaveLength(1);
    state.tick = 0;
    train.transfer = null;
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
    train.transfer = { passenger: passenger(1001, station.shape as 'circle'),
      direction: 'alight', stationId: station.id, duration: 2, progress: 1 };
    renderer.render(state, 0, events);
    expect(markers(renderer).map((m) => [m.userData.passengerId, m.userData.direction])).toEqual([[1001, 'alight']]);
    renderer.render(state, 0, events);
    expect(markers(renderer)).toHaveLength(1);
    renderer.dispose();
  });
  it('keeps multiple alighting passengers tied to their actual train and station without inventing an event on a pause', () => {
    const { renderer, state, train } = scene();
    const station = state.stations[0];
    train.passengers.push(passenger(1001, station.shape as 'circle'), passenger(1002, station.shape as 'circle'));
    renderer.render(state);
    state.tick++;
    state.score += 1;
    train.passengers = [passenger(1002, station.shape as 'circle')];
    train.transfer = { passenger: passenger(1001, station.shape as 'circle'),
      direction: 'alight', stationId: station.id, duration: 2, progress: 0 };
    renderer.render(state);
    expect(markers(renderer).map((m) => m.userData.passengerId)).toEqual([1001]);
    renderer.render(state);
    expect(markers(renderer)).toHaveLength(1);
    renderer.dispose();
  });
});
