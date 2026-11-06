// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
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
vi.stubGlobal('window', { devicePixelRatio: 1 });
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
vi.stubGlobal('document', {
  createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ clearRect() {}, fillText() {}, strokeText() {},
      set font(_value: string) {}, set textAlign(_value: string) {},
      set textBaseline(_value: string) {}, set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {}, set lineWidth(_value: number) {} }),
  }),
});
function setup() {
  const container = { append: vi.fn(), getBoundingClientRect: () => ({ width: 1000, height: 700 }) };
  const renderer = new MetroRenderer(container as unknown as HTMLElement);
  const state = createState();
  const train: Train = { id: 900, line: 0, from: state.stations[0].id, to: null, progress: 0,
    direction: 1, dwell: 0, passengers: [], carriages: 0, retiring: false, moveTo: null };
  state.lines[0].stops = [state.stations[0].id, state.stations[1].id];
  state.trains.push(train);
  return { renderer, state, train };
}
const passenger = (id: number, shape: 'triangle' | 'square') => ({ id, shape, born: 0, transfers: 0 });
const movingMarkers = (renderer: MetroRenderer) =>
  (renderer as unknown as { transfers: THREE.Group }).transfers.children;
const roofIcons = (renderer: MetroRenderer, id: number) =>
  (renderer as unknown as { trains: Map<number, { group: THREE.Group }> }).trains.get(id)!.group
    .children.filter((child) => child.name === 'onboard-shape').map((child) => child.userData.passengerId);

describe('discrete boarding and alighting feedback', () => {
  it('never draws a moving transfer marker, even after a replay seek or skipped render frames', () => {
    const { renderer, state, train } = setup();
    train.transfer = { passenger: passenger(777, 'triangle'), direction: 'board',
      stationId: state.stations[0].id, duration: 10, progress: 5 };
    renderer.render(state);
    expect(movingMarkers(renderer)).toHaveLength(0);
    expect(roofIcons(renderer, train.id)).toEqual([]);
    state.tick += 25;
    train.transfer = { ...train.transfer, progress: 9, stationId: state.stations[1].id };
    renderer.render(state, 0, []);
    expect(movingMarkers(renderer)).toHaveLength(0);
    expect(roofIcons(renderer, train.id)).toEqual([]);
    renderer.dispose();
  });
  it('shows each completed boarding exactly once on the train and no ghost after reset', () => {
    const { renderer, state, train } = setup();
    train.transfer = { passenger: passenger(1001, 'triangle'), direction: 'board',
      stationId: state.stations[0].id, duration: 10, progress: 10 };
    renderer.render(state);
    expect(roofIcons(renderer, train.id)).toEqual([]);
    train.transfer = null;
    train.passengers.push(passenger(1001, 'triangle'));
    state.tick++;
    renderer.render(state);
    expect(roofIcons(renderer, train.id)).toEqual([1001]);
    expect(movingMarkers(renderer)).toHaveLength(0);
    train.passengers = [];
    state.tick = 0;
    renderer.render(state, 0, []);
    expect(roofIcons(renderer, train.id)).toEqual([]);
    expect(movingMarkers(renderer)).toHaveLength(0);
    renderer.dispose();
  });
  it('removes a delivered passenger directly from the roof with no intermediate sprite', () => {
    const { renderer, state, train } = setup();
    train.passengers = [passenger(1001, 'square'), passenger(1002, 'triangle')];
    renderer.render(state);
    expect(roofIcons(renderer, train.id)).toEqual([1001, 1002]);
    train.passengers = [passenger(1002, 'triangle')];
    train.transfer = { passenger: passenger(1001, 'square'), direction: 'alight',
      stationId: state.stations[0].id, duration: 10, progress: 2 };
    renderer.render(state);
    expect(roofIcons(renderer, train.id)).toEqual([1002]);
    expect(movingMarkers(renderer)).toHaveLength(0);
    renderer.dispose();
  });
});
