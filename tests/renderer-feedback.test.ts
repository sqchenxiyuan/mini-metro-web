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
function transfers(renderer: MetroRenderer) {
  return (renderer as unknown as { transfers: THREE.Group }).transfers.children;
}

afterEach(() => { canvases.length = 0; });

describe('train load feedback', () => {
  it('renders a current in-progress transfer after skipped browser frames', () => {
    const { renderer, state } = setup();
    state.trains[0].dwell = 0;
    state.stations[0].queue = [passenger(301, 'triangle')];
    for (const p of state.stations) p.nextPassenger = Infinity;
    renderer.render(state);
    advance(state);
    advance(state);
    renderer.render(state);
    expect(state.trains[0].transfer).toMatchObject({ passenger: { id: 301 }, progress: 1 });
    expect(transfers(renderer).some((sprite) => sprite.userData.passengerId === 301 && sprite.userData.direction === 'board')).toBe(true);
    renderer.dispose();
  });
  it('drops a finished transfer when several ticks pass before the next render', () => {
    const { renderer, state } = setup();
    state.trains[0].dwell = 0;
    state.stations[0].queue = [passenger(301, 'triangle')];
    for (const p of state.stations) p.nextPassenger = Infinity;
    renderer.render(state);
    for (let i = 0; i < 6; i++) advance(state);
    renderer.render(state);
    expect(state.trains[0].passengers.map((p) => p.id)).toContain(301);
    expect(transfers(renderer)).toHaveLength(0);
    renderer.dispose();
  });
  it('draws each destination as one roof shape, without numbers or multipliers', () => {
    const { renderer, state, train } = setup();
    state.trains[0].passengers = [passenger(101, 'triangle'), passenger(102, 'triangle'), passenger(103, 'square')];
    renderer.render(state);
    const icons = train().children.filter((object) => object.name === 'onboard-shape');
    expect(icons.map((icon) => icon.userData.shape)).toEqual(['triangle', 'triangle', 'square']);
    expect((icons[0] as THREE.Mesh).material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(train().getObjectByName('train-load')).toBeUndefined();
    expect(canvases.flatMap((canvas) => canvas.calls).filter(([op]) => op === 'fillText')).toEqual([]);
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
    expect(state.trains[0].transfer).toMatchObject({ direction: 'board', passenger: { id: 101 } });
    expect(transfers(renderer)).toHaveLength(1);
    expect(transfers(renderer)[0].userData).toMatchObject({ passengerId: 101, direction: 'board' });
    advance(state);
    advance(state);
    advance(state);
    renderer.render(state);
    expect(state.trains[0].passengers.map((p) => p.id)).toEqual([101]);
    expect(transfers(renderer)).toHaveLength(0);
    // At the destination the authoritative alighting state starts first; score changes on completion.
    state.trains[0].to = state.stations[1].id;
    state.trains[0].progress = 0.999;
    renderer.render(state);
    advance(state);
    renderer.render(state);
    expect(state.score).toBe(0);
    expect(state.trains[0].transfer).toMatchObject({ direction: 'alight', passenger: { id: 101 } });
    expect(transfers(renderer)).toHaveLength(1);
    advance(state);
    advance(state);
    advance(state);
    renderer.render(state);
    expect(state.score).toBe(1);
    expect(transfers(renderer)).toHaveLength(0);
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
    state.trains[0].transfer = { passenger: passenger(502, 'triangle'), direction: 'board',
      stationId: state.stations[0].id, duration: 2, progress: 0 };
    renderer.render(state);
    expect(transfers(renderer)).toHaveLength(1);
    renderer.render(state); // same tick: paused or UI redraw
    expect(transfers(renderer)).toHaveLength(1);
    state.tick += 15; // replay seek
    state.trains[0].transfer = null;
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
    state.trains[0].transfer = { passenger: passenger(505, 'triangle'), direction: 'board',
      stationId: state.stations[0].id, duration: 2, progress: 0 };
    renderer.render(state);
    const marker = transfers(renderer)[0] as THREE.Sprite;
    const texture = (marker.material as THREE.SpriteMaterial).map!;
    const disposed = vi.spyOn(texture, 'dispose');
    state.tick++;
    state.trains[0].transfer = null;
    state.trains[0].passengers = [passenger(505, 'triangle')];
    renderer.render(state);
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
    state.trains.push({ ...first, id: 102, passengers: [passenger(602, 'circle')], transfer: null });
    renderer.render(state);
    state.tick++;
    first.passengers = [];
    first.transfer = { passenger: passenger(601, 'circle'), direction: 'alight',
      stationId: state.stations[0].id, duration: 2, progress: 0 };
    state.trains[1].passengers = [];
    renderer.render(state);
    expect(transfers(renderer).filter((sprite) => sprite.userData.direction === 'alight')).toHaveLength(1);
    renderer.dispose();
  });
  it('adds one destination icon per carriage seat and removes stale icons', () => {
    const { renderer, state, train } = setup();
    state.trains[0].carriages = 3;
    state.trains[0].passengers = Array.from({ length: 24 }, (_, i) => passenger(200 + i, i % 2 ? 'square' : 'triangle'));
    renderer.render(state);
    let icons = train().children.filter((object) => object.name === 'onboard-shape');
    expect(icons).toHaveLength(24);
    expect(icons.map((icon) => icon.userData.carriage)).toEqual(Array.from({ length: 24 }, (_, i) => Math.floor(i / 6)));
    const oldGeometry = vi.spyOn((icons[23] as THREE.Mesh).geometry, 'dispose');
    state.trains[0].passengers.pop();
    renderer.render(state);
    icons = train().children.filter((object) => object.name === 'onboard-shape');
    expect(icons).toHaveLength(23);
    expect(oldGeometry).toHaveBeenCalledOnce();
    const oldIcon = icons[0];
    state.trains[0].passengers[0].shape = 'circle';
    renderer.render(state);
    expect(train().children.find((object) => object.name === 'onboard-shape' && object.userData.passengerId === 200)?.userData.shape).toBe('circle');
    expect(train().children.includes(oldIcon)).toBe(false);
    state.trains = [];
    renderer.render(state);
    expect((renderer as unknown as { trains: Map<number, unknown> }).trains.size).toBe(0);
    renderer.dispose();
  });
});
