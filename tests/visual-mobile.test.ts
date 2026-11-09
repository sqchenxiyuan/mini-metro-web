import { describe, expect, it } from 'vitest';
import { RULES, createState } from '../src/rules';
import { MobileMapRenderer } from '../src/mobile-map';

function mobile(width = 390, height = 708) {
  const operations: { op: string; args: unknown[] }[] = [];
  const context = new Proxy({}, { get: (_, name) => (...args: unknown[]) => {
    operations.push({ op: String(name), args });
    if (name === 'measureText') return { width: 60 };
  }, set: () => true });
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context, remove() {} };
  const documentObject = { body: { classList: { contains: () => false } }, createElement: () => canvas };
  const oldDocument = globalThis.document, oldPath = globalThis.Path2D, oldRatio = globalThis.devicePixelRatio;
  const oldObserver = globalThis.ResizeObserver, oldWindow = globalThis.window;
  Object.assign(globalThis, { document: documentObject, devicePixelRatio: 1, window: { matchMedia: () => ({ matches: false }) },
    ResizeObserver: class { observe() {} disconnect() {} },
    Path2D: class { arc() {} moveTo() {} lineTo() {} closePath() {} } });
  const container = { append() {}, getBoundingClientRect: () => ({ width, height }), parentElement: null };
  const renderer = new MobileMapRenderer(container as unknown as HTMLElement);
  const restore = () => Object.assign(globalThis, { document: oldDocument, Path2D: oldPath,
    devicePixelRatio: oldRatio, ResizeObserver: oldObserver, window: oldWindow });
  return { renderer, operations, restore };
}

describe('mobile canvas crowd and waiting riders', () => {
  it('clips the red fill to the station silhouette without a warning ring', () => {
    const { renderer, operations, restore } = mobile();
    try {
      const state = createState();
      state.stations[0].crowd = RULES.crowdTicks / 2;
      renderer.render(state);
      expect(operations.some(({ op }) => op === 'clip')).toBe(true);
      expect(operations.some(({ op, args }) => op === 'fillRect' && args[2] === 2 && Number(args[3]) > 0 && Number(args[3]) < 2)).toBe(true);
      const fillIndex=operations.findIndex(({op,args})=>op==='fillRect' && args[2]===2);
      expect(fillIndex).toBeGreaterThan(0);
      expect(operations.slice(0,fillIndex).some(({op})=>op==='clip')).toBe(true);
    } finally { renderer.dispose(); restore(); }
  });
  it('reports no warning rings when crowd is present', () => {
    const {renderer,restore}=mobile();
    try {
      const state=createState();state.stations[0].crowd=RULES.crowdTicks/2;
      renderer.render(state);
      expect(renderer.cueStats().ringCount).toBe(0);
      expect(renderer.cueStats().ringStationIds).toEqual([]);
    } finally {renderer.dispose();restore();}
  });
  it('moves each visible rider independently in x/y without moving queue ownership or changing state', () => {
    const { renderer, restore } = mobile();
    try {
      const state = createState();
      state.stations[0].queue = [1, 2].map(id => ({ id, born: 0, transfers: 0, shape: 'square' as const }));
      renderer.render(state);
      const original = renderer.mapStats().visiblePositions;
      state.tick = 100;
      const snapshot = JSON.stringify(state);
      renderer.render(state);
      const moved = renderer.mapStats().visiblePositions;
      expect(moved.map(p => p.id)).toEqual(original.map(p => p.id));
      expect(moved.every((p, i) => p.x !== original[i].x && p.y !== original[i].y)).toBe(true);
      expect(JSON.stringify(state)).toBe(snapshot);
    } finally { renderer.dispose(); restore(); }
  });
  it('keeps grouped shape and exact count together on movement while preserving per-shape totals', () => {
    const { renderer, restore } = mobile();
    try {
      const state=createState();
      state.stations[0].queue=Array.from({length:12},(_,id)=>({id:id+1,born:0,transfers:0,
        shape:id%2?'triangle' as const:'square' as const}));
      renderer.render(state);
      const before=renderer.mapStats().queueGroups.find(group=>group.stationId===state.stations[0].id)!;
      expect(before.groups.map(group=>[group.shape,group.count])).toEqual([['triangle',6],['square',6]]);
      state.tick=100;renderer.render(state);
      const after=renderer.mapStats().queueGroups.find(group=>group.stationId===state.stations[0].id)!;
      expect(after.groups.map(group=>[group.shape,group.count])).toEqual([['triangle',6],['square',6]]);
      expect(after.groups.every((group,index)=>group.x!==before.groups[index].x && group.y!==before.groups[index].y)).toBe(true);
    } finally {renderer.dispose();restore();}
  });
});
