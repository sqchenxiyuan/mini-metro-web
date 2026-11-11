import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createState, hash, LINE_COLORS } from '../src/rules';
import { MetroRenderer } from '../src/renderer';

// Only the GPU boundary is replaced: all geometry/material/render logic is real.
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = { remove() {}, toDataURL: () => '' };
    shadowMap = { enabled: false, type: 0 };
    setPixelRatio() {} setSize() {} setClearColor() {} render() {} dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});
vi.stubGlobal('window', { devicePixelRatio: 1 });
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

function setup() {
  const renderer = new MetroRenderer({ append() {}, getBoundingClientRect: () => ({ width: 1200, height: 800 }) } as unknown as HTMLElement);
  const state = createState({ mode: 'creative' });
  const [a, b, c] = state.stations;
  a.x = -5; a.y = -2; b.x = 4; b.y = 2; c.x = 3; c.y = 3;
  state.lines = [{ id: 0, stops: [a.id, b.id], loop: false }, { id: 1, stops: [a.id, b.id], loop: false }];
  return { renderer, state };
}
function group(renderer: MetroRenderer, key: 'tracks' | 'preview') {
  return (renderer as unknown as Record<typeof key, THREE.Group>)[key].children as THREE.Mesh[];
}
function pathPoints(mesh: THREE.Mesh) {
  const path = (mesh.geometry as THREE.TubeGeometry).parameters.path;
  return Array.from({ length: 41 }, (_, index) => {
    const p = path.getPoint(index / 40);
    return [p.x, p.y, p.z];
  });
}
function colored(renderer: MetroRenderer, line: number) {
  return group(renderer, 'tracks').filter(m => (m.material as THREE.MeshStandardMaterial).color.getHexString() === new THREE.Color(LINE_COLORS[line]).getHexString());
}

describe('line editing rail feedback', () => {
  it('subdues occupied ghost marks without moving their original path and removes them at the last train clearance', () => {
    const { renderer, state } = setup();
    const [a, b] = state.stations;
    state.trains = [0, 1].map(index => ({ id: 40 + index, line: 0, from: index ? b.id : a.id,
      to: index ? a.id : b.id, progress: index ? .6 : .4, direction: 1 as const,
      dwell: 0, passengers: [], carriages: 0, retiring: false, moveTo: null }));
    renderer.render(state);
    const groups = (renderer as unknown as { trains: Map<number, { group: THREE.Group }> }).trains;
    const pose = [...groups.values()].map(({ group }) => ({ position: group.position.clone(), heading: group.rotation.y }));
    state.lines[0].stops = [1, 3];
    const before = hash(state);
    renderer.render(state);
    const marks = () => group(renderer, 'tracks').filter(m => m.geometry instanceof THREE.BoxGeometry);
    expect(marks().length).toBeGreaterThan(5);
    const lineColor = new THREE.Color(LINE_COLORS[0]);
    for (const mark of marks()) {
      expect((mark.geometry as THREE.BoxGeometry).parameters.width).toBeLessThan(.07);
      const paint = (mark.material as THREE.MeshStandardMaterial).color;
      expect(paint.equals(lineColor)).toBe(false);
      expect(paint.g).toBeGreaterThan(lineColor.g);
    }
    expect([...groups.values()].map(({ group }) => ({ position: group.position.clone(), heading: group.rotation.y }))).toEqual(pose);
    expect(hash(state)).toBe(before);
    const geometry = marks().map(mark => [mark.position.x, mark.position.y, mark.position.z, mark.rotation.y]);
    renderer.render(state, 1); // rebuild while occupied must retain the frozen lane
    expect(marks().map(mark => [mark.position.x, mark.position.y, mark.position.z, mark.rotation.y])).toEqual(geometry);
    state.trains[0].from = b.id; state.trains[0].to = null;
    renderer.render(state);
    expect(marks().length).toBe(geometry.length);
    state.trains[1].from = a.id; state.trains[1].to = null;
    renderer.render(state);
    expect(marks()).toHaveLength(0); // no residual fade/semantic lifetime extension
    renderer.dispose();
  });
  it('drops transient paint on reset, seed change and backward seek even with a manual camera', () => {
    for (const boundary of ['reset', 'seed', 'seek'] as const) {
      const { renderer, state } = setup();
      state.tick = 100;
      renderer.setZoom(1.2);
      renderer.render(state);
      renderer.showPreview(state, [1, 3], 0, false);
      if (boundary === 'reset') renderer.resetCamera();
      if (boundary === 'seed') state.seed++;
      if (boundary === 'seek') state.tick = 0;
      renderer.render(state);
      expect(group(renderer, 'preview')).toHaveLength(0);
      expect(colored(renderer, 0)).toHaveLength(1);
      renderer.dispose();
    }
  });
  it('dims an old retained pair if the candidate changes its canonical station-approach lane', () => {
    const { renderer, state } = setup();
    const [a, b, c] = state.stations;
    a.x = 0; a.y = 0; b.x = 8; b.y = 0; c.x = 7; c.y = 1;
    state.lines = [{ id: 0, stops: [a.id, b.id], loop: false }];
    renderer.render(state);
    const old = colored(renderer, 0)[0];
    // Closing this triangle introduces another same-sector entrance at station a.
    renderer.showPreview(state, [a.id, b.id, c.id, a.id], 0);
    expect((old.material as THREE.MeshStandardMaterial).color.getHexString()).not.toBe(new THREE.Color(LINE_COLORS[0]).getHexString());
    renderer.clearPreview();
    expect(colored(renderer, 0)).toHaveLength(1);
    renderer.dispose();
  });
  it('dims only superseded rails of the edited line, persists on redraw, and restores after invalid/cancel', () => {
    const { renderer, state } = setup();
    state.lines[1].stops = [2, 3];
    state.trains = [{ id: 40, line: 0, from: 1, to: 2, progress: .4, direction: 1,
      dwell: 0, passengers: [{ id: 600, shape: 'square', born: 0, transfers: 0 }], carriages: 0, retiring: false, moveTo: null }];
    renderer.render(state);
    const rail = colored(renderer, 0)[0], other = colored(renderer, 1)[0];
    const original = (rail.material as THREE.MeshStandardMaterial).color.clone();
    const otherColor = (other.material as THREE.MeshStandardMaterial).color.clone();
    const trains = (renderer as unknown as { trains: Map<number, { group: THREE.Group }> }).trains;
    const train = trains.get(40)!.group;
    const trainPosition = train.position.clone(), trainMaterials = train.children.map(m => (m as THREE.Mesh).material);
    const before = hash(state);
    renderer.showPreview(state, [1, 3], 0, false);
    expect((rail.material as THREE.MeshStandardMaterial).color.equals(original)).toBe(false);
    expect((other.material as THREE.MeshStandardMaterial).color.equals(otherColor)).toBe(true);
    expect((group(renderer, 'preview')[0].material as THREE.MeshStandardMaterial).color.getHexString()).toBe('e75c58');
    renderer.render(state, 1); // selected-line cache rebuild must not lose editing emphasis
    expect(colored(renderer, 0)).toHaveLength(0);
    expect(train.position.equals(trainPosition)).toBe(true);
    expect(train.children.map(m => (m as THREE.Mesh).material)).toEqual(trainMaterials);
    expect(train.visible).toBe(true);
    renderer.clearPreview();
    expect(group(renderer, 'preview')).toHaveLength(0);
    expect(colored(renderer, 0)).toHaveLength(1);
    expect(colored(renderer, 1)).toHaveLength(1);
    renderer.showPreview(state, [1, 2, 3], 0);
    expect(colored(renderer, 0)).toHaveLength(1); // a retained rail is not dimmed
    renderer.clearPreview();
    expect(hash(state)).toBe(before);
    renderer.dispose();
  });
  it('treats a one-stop withdrawal as a dimmed old route until clear, without inventing a candidate segment', () => {
    const { renderer, state } = setup();
    renderer.render(state);
    const original = group(renderer, 'tracks').map(m => ({
      geometry: m.geometry, paint: (m.material as THREE.MeshStandardMaterial).color.getHexString(),
    }));
    const before = hash(state);
    renderer.showPreview(state, [1], 0);
    expect(group(renderer, 'preview')).toHaveLength(0);
    expect(colored(renderer, 0)).toHaveLength(0);
    expect(colored(renderer, 1)).toHaveLength(1);
    renderer.clearPreview();
    expect(group(renderer, 'tracks').map(m => ({ geometry: m.geometry,
      paint: (m.material as THREE.MeshStandardMaterial).color.getHexString() }))).toEqual(original);
    expect(hash(state)).toBe(before);
    renderer.dispose();
  });
  it('draws a solid candidate on the exact committed canonical lane, including shared offsets in either direction', () => {
    for (const reverse of [false, true]) {
      const { renderer, state } = setup();
      renderer.render(state);
      const stops = reverse ? [2, 1] : [1, 2];
      const before = hash(state);
      renderer.showPreview(state, stops, 0);
      const preview = group(renderer, 'preview');
      expect(preview).toHaveLength(1);
      expect(preview[0].geometry).toBeInstanceOf(THREE.TubeGeometry);
      const candidatePoints = pathPoints(preview[0]);
      expect((preview[0].geometry as THREE.TubeGeometry).parameters.radius).toBe(.105);
      expect((preview[0].material as THREE.MeshStandardMaterial).color.getHexString()).toBe(new THREE.Color(LINE_COLORS[0]).getHexString());
      expect(hash(state)).toBe(before);
      renderer.clearPreview();
      state.lines[0].stops = stops;
      renderer.render(state);
      expect(candidatePoints).toEqual(pathPoints(colored(renderer, 0)[0]));
      renderer.dispose();
    }
  });
});
