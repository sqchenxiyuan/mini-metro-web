import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { advance, createState } from '../src/rules';
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
    setSize() {}
    setClearColor() {}
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const canvases: { width: number; height: number; calls: [string, ...unknown[]][] }[] = [];
vi.stubGlobal('window', { devicePixelRatio: 1 });
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
vi.stubGlobal('document', {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw Error(`unexpected element: ${tag}`);
    const canvas = { width: 0, height: 0, calls: [] as [string, ...unknown[]][] };
    const context = new Proxy({}, {
      get: (_target, key) => (...args: unknown[]) => canvas.calls.push([String(key), ...args]),
      set: (_target, key, value) => { canvas.calls.push([String(key), value]); return true; },
    });
    canvases.push(canvas);
    return { ...canvas, getContext: () => context };
  },
});

function setup() {
  const container = { append: vi.fn(), getBoundingClientRect: () => ({ width: 1000, height: 700 }) };
  const renderer = new MetroRenderer(container as unknown as HTMLElement);
  const state = createState();
  state.lines[0].stops = [state.stations[0].id, state.stations[1].id];
  state.trains.push({
    id: 100, line: 0, from: state.stations[0].id, to: null, progress: 0,
    direction: 1, dwell: 5, passengers: [], carriages: 0, retiring: false, moveTo: null,
  });
  const train = () => ((renderer as unknown as { trains: Map<number, { group: THREE.Group }> }).trains.get(100)!.group);
  return { renderer, state, train };
}
function passenger(id: number, shape: 'circle' | 'triangle' | 'square') {
  return { id, shape, born: 0, transfers: 0 };
}
function badge(group: THREE.Group) {
  return group.getObjectByName('train-load') as THREE.Sprite | undefined;
}
function transfers(renderer: MetroRenderer) {
  return (renderer as unknown as { transfers: THREE.Group }).transfers.children;
}

afterEach(() => { canvases.length = 0; });

describe('train load feedback', () => {
  it('animates a verified boarding transition after several ticks between renders', () => {
    const { renderer, state } = setup();
    state.trains[0].dwell = 0;
    state.stations[0].queue = [passenger(301, 'triangle')];
    for (const p of state.stations) p.nextPassenger = Infinity;
    renderer.render(state);
    for (let i = 0; i < 6; i++) advance(state);
    renderer.render(state);
    expect(state.trains[0].passengers.map((p) => p.id)).toContain(301);
    expect(transfers(renderer).some((sprite) => sprite.userData.passengerId === 301 && sprite.userData.direction === 'board')).toBe(true);
    renderer.dispose();
  });
  it('displays actual destination composition and capacity even on the first render', () => {
    const { renderer, state, train } = setup();
    state.trains[0].passengers = [passenger(101, 'triangle'), passenger(102, 'triangle'), passenger(103, 'square')];
    renderer.render(state);
    expect(badge(train())).toBeInstanceOf(THREE.Sprite);
    const drawn = canvases.at(-1)!.calls;
    expect(drawn).toContainEqual(['fillText', '3 / 6', expect.any(Number), expect.any(Number)]);
    expect(drawn).toContainEqual(['fillText', '×2', expect.any(Number), expect.any(Number)]);
    expect(drawn).toContainEqual(['fillText', '×1', expect.any(Number), expect.any(Number)]);
    expect(drawn.filter(([op]) => op === 'fill').length).toBeGreaterThanOrEqual(2);
    renderer.dispose();
  });
  it('animates real boarding from the station toward the train and real alighting back', () => {
    const { renderer, state } = setup();
    state.trains[0].dwell = 0;
    state.stations[0].queue = [passenger(101, 'triangle')];
    for (const station of state.stations) station.nextPassenger = Infinity;
    renderer.render(state);
    advance(state);
    renderer.render(state);
    expect(state.trains[0].passengers.map((p) => p.id)).toEqual([101]);
    expect(transfers(renderer)).toHaveLength(1);
    expect(transfers(renderer)[0].userData).toMatchObject({ passengerId: 101, direction: 'board' });
    const start = transfers(renderer)[0].position.x;
    advance(state);
    renderer.render(state);
    expect(transfers(renderer)[0].position.x).toBeGreaterThan(start);
    // Arrive and service at a destination; no marker unless an actual ID leaves the train.
    state.trains[0].to = state.stations[1].id;
    state.trains[0].progress = 0.999;
    renderer.render(state);
    advance(state);
    renderer.render(state);
    expect(state.score).toBe(1);
    expect(transfers(renderer).filter((sprite) => sprite.userData.direction === 'alight')).toHaveLength(1);
    expect(transfers(renderer).at(-1)!.userData).toMatchObject({ passengerId: 101, direction: 'alight' });
    renderer.dispose();
  });
  it('does not invent transfers on the first snapshot, pause, seek, reset or passenger edits', () => {
    const { renderer, state } = setup();
    renderer.render(state);
    state.tick = 1;
    state.trains[0].passengers = [passenger(501, 'square')]; // not previously waiting
    renderer.render(state);
    expect(transfers(renderer)).toHaveLength(0);
    state.stations[0].queue = [passenger(502, 'triangle')];
    renderer.render(state);
    state.tick++;
    state.stations[0].queue = [];
    state.trains[0].passengers.push(passenger(502, 'triangle'));
    renderer.render(state);
    expect(transfers(renderer)).toHaveLength(1);
    renderer.render(state); // same tick: paused or UI redraw
    expect(transfers(renderer)).toHaveLength(1);
    state.tick += 15; // replay seek
    renderer.render(state);
    expect(transfers(renderer)).toHaveLength(0);
    state.tick = 0; // reset/new game or seek backward
    renderer.render(state);
    expect(transfers(renderer)).toHaveLength(0);
    renderer.dispose();
  });
  it('drops expired markers and never presents a teleported train as station alighting', () => {
    const { renderer, state } = setup();
    state.stations[0].queue = [passenger(505, 'triangle')];
    renderer.render(state);
    state.tick++;
    state.stations[0].queue = [];
    state.trains[0].passengers = [passenger(505, 'triangle')];
    renderer.render(state);
    const marker = transfers(renderer)[0] as THREE.Sprite;
    const texture = (marker.material as THREE.SpriteMaterial).map!;
    const disposed = vi.spyOn(texture, 'dispose');
    for (let i = 0; i < 5; i++) { state.tick++; renderer.render(state); }
    expect(transfers(renderer)).toHaveLength(0);
    expect(disposed).toHaveBeenCalledOnce();
    state.tick++;
    state.trains[0].from = state.stations[1].id;
    state.trains[0].passengers = [];
    renderer.render(state);
    expect(transfers(renderer)).toHaveLength(0);
    renderer.dispose();
  });
  it('does not animate an unexplained removed passenger as delivered or transferred', () => {
    const { renderer, state } = setup();
    state.trains[0].passengers = [passenger(601, 'square')];
    renderer.render(state);
    state.tick++;
    state.trains[0].passengers = [];
    renderer.render(state);
    expect(transfers(renderer)).toHaveLength(0);
    renderer.dispose();
  });
  it('does not duplicate one delivery across multiple trains at the same station', () => {
    const { renderer, state } = setup();
    const first = state.trains[0];
    first.passengers = [passenger(601, 'circle')];
    state.trains.push({ ...first, id: 102, passengers: [passenger(602, 'circle')] });
    renderer.render(state);
    state.tick++;
    state.score++;
    first.passengers = [];
    state.trains[1].passengers = [];
    renderer.render(state);
    expect(transfers(renderer).filter((sprite) => sprite.userData.direction === 'alight')).toHaveLength(1);
    renderer.dispose();
  });
  it('updates the card when a carriage raises capacity and disposes its texture on removal', () => {
    const { renderer, state, train } = setup();
    renderer.render(state);
    const old = badge(train())!;
    const disposed = vi.spyOn((old.material as THREE.SpriteMaterial).map!, 'dispose');
    state.trains[0].carriages = 1;
    renderer.render(state);
    expect(disposed).toHaveBeenCalledOnce();
    expect(canvases.at(-1)!.calls).toContainEqual(['fillText', '0 / 12', expect.any(Number), expect.any(Number)]);
    const next = badge(train())!;
    const nextDispose = vi.spyOn((next.material as THREE.SpriteMaterial).map!, 'dispose');
    state.trains = [];
    renderer.render(state);
    expect(nextDispose).toHaveBeenCalledOnce();
    renderer.dispose();
  });
});
