import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { applyAction, copy, createState, LINE_COLORS } from '../src/rules';
import { MetroRenderer, hitTestVisibleLane } from '../src/renderer';

vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = { remove: vi.fn() };
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
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }),
});

function setup(reverse = false) {
  const container = { append: vi.fn(), getBoundingClientRect: () => ({ width: 1200, height: 800 }) };
  const renderer = new MetroRenderer(container as unknown as HTMLElement);
  const state = createState();
  const [a, b, c] = state.stations;
  a.x = reverse ? 5 : -5; a.y = 0;
  b.x = reverse ? -5 : 5; b.y = 0;
  c.x = 0; c.y = 6;
  state.lines = LINE_COLORS.map((_, id) => ({ id, stops: id % 2 ? [b.id, a.id] : [a.id, b.id], loop: false }));
  state.resources.tunnels = 100;
  return { renderer, state, a, b, c };
}

function visibleMiddle(renderer: MetroRenderer, lineId: number) {
  const tracks = (renderer as unknown as { tracks: THREE.Group }).tracks.children as THREE.Mesh[];
  const color = new THREE.Color(LINE_COLORS[lineId]).getHexString();
  const mesh = tracks.find((item) => (item.material as THREE.MeshStandardMaterial).color.getHexString() === color)!;
  const point = (mesh.geometry as THREE.TubeGeometry).parameters.path.getPoint(0.5);
  return renderer.project(point.x, point.z, point.y);
}

describe('visible lane route insertion hit testing', () => {
  it('hits the selected outer colored lane instead of the centerline and inserts on its edge at both zoom levels', () => {
    const { renderer, state, a, b, c } = setup();
    const selectedLine = 6;
    for (const zoom of [1, 1.8]) {
      renderer.setZoom(zoom);
      renderer.render(state, selectedLine);
      (renderer as unknown as { camera: THREE.OrthographicCamera }).camera.updateMatrixWorld();
      const point = visibleMiddle(renderer, selectedLine);
      const center = renderer.project(0, 0, 0.43);
      expect(Math.hypot(point.x - center.x, point.y - center.y)).toBeGreaterThan(12);
      expect(hitTestVisibleLane(state, selectedLine, center, renderer.project.bind(renderer), 12)).toBeNull();
      const index = hitTestVisibleLane(state, selectedLine, point, renderer.project.bind(renderer), 12);
      expect(index).toBe(1);
      const route = [...state.lines[selectedLine].stops];
      route.splice(index!, 0, c.id);
      const updated = copy(state);
      expect(applyAction(updated, { type: 'route', line: selectedLine, stops: route, loop: false }).ok).toBe(true);
      expect(updated.lines[selectedLine].stops).toEqual([a.id, c.id, b.id]);
    }
    renderer.dispose();
  });
  it('uses the reversed route order on a seven-line shared edge', () => {
    const { renderer, state, a, b, c } = setup(true);
    const selectedLine = 5;
    renderer.setZoom(1.8);
    renderer.render(state, selectedLine);
    (renderer as unknown as { camera: THREE.OrthographicCamera }).camera.updateMatrixWorld();
    const point = visibleMiddle(renderer, selectedLine);
    const index = hitTestVisibleLane(state, selectedLine, point, renderer.project.bind(renderer), 12);
    expect(index).toBe(1);
    const route = [...state.lines[selectedLine].stops];
    route.splice(index!, 0, c.id);
    const updated = copy(state);
    expect(applyAction(updated, { type: 'route', line: selectedLine, stops: route, loop: false }).ok).toBe(true);
    expect(updated.lines[selectedLine].stops).toEqual([b.id, c.id, a.id]);
    renderer.dispose();
  });
});
