import { describe, expect, it } from 'vitest';
import { layoutOverlays, layoutSceneCues } from '../src/overlay-layout';

const overlaps = (a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe('anchored WebGL cue placement', () => {
  it('keeps every drawn passenger in a full fixed queue, with an accessible fallback for crowded stations', () => {
    const points = [[1,125,380,30],[2,178,338,29],[3,257,391,29],[10,150,320,28],
      [23,191,385,26],[36,287,344,24],[53,342,395,21],[77,244,316,15],
      [102,86,394,13],[125,357,344,12],[147,326,302,10],[184,175,432,6],
      [214,92,293,3],[255,226,291,0]];
    const stations = points.map(([id,x,y,queue]) => ({ id,x,y,queue,crowd:0,selected:false }));
    const placed = layoutSceneCues(stations,{width:390,height:708});
    expect(placed.filter(p=>p.queue).length).toBeGreaterThan(0);
    expect(placed.filter(p=>p.queueFallback).length).toBe(stations.filter(p=>p.queue).length-placed.filter(p=>p.queue).length);
  });
  it('puts a complete phone queue below its owner or omits it, irrespective of selection and crowd', () => {
    const stations = [{ id: 1, x: 170, y: 170, queue: 12, crowd: 0, selected: false },
      { id: 2, x: 250, y: 170, queue: 8, crowd: 0, selected: false }];
    const initial = layoutSceneCues(stations, { width: 390, height: 708 });
    expect(initial[0].queue).toMatchObject({ level: 'full', width: 66, height: 22 });
    expect(initial[0].queue!.x + initial[0].queue!.width / 2).toBe(170);
    expect(initial[0].queue!.y).toBeGreaterThan(209);
    expect(initial[0].warning).toBeNull();
    const changed = layoutSceneCues(stations.map((p) => ({ ...p, selected: !p.selected, crowd: 500 })),
      { width: 390, height: 708 });
    expect(changed.map((p) => p.queue)).toEqual(initial.map((p) => p.queue));
    expect(changed.every((p) => p.warning === null && !p.warningFallback)).toBe(true);
  });
  it('shows only complete below-station piles on a populated phone map', () => {
    // Seed 420, week 4, 390px: most stations are crowded and have queues.
    const points = [[1,125,380,30],[2,178,338,29],[3,257,391,29],[10,150,320,28],
      [23,191,385,26],[36,287,344,24],[53,342,395,21],[77,244,316,15],
      [102,86,394,13],[125,357,344,12],[147,326,302,10],[184,175,432,6],
      [214,92,293,3],[255,226,291,0]];
    const stations = points.map(([id,x,y,queue]) => ({ id, x, y, queue,
      crowd: id === 184 || id === 214 || id === 255 ? 0 : 2250, selected: false }));
    const placed = layoutSceneCues(stations, { width: 390, height: 708 });
    expect(placed.some((p) => p.queue !== null)).toBe(true);
    expect(placed.every((p) => !p.queue || p.queue.level === 'full')).toBe(true);
    expect(placed.every((p) => p.warning === null && !p.warningFallback)).toBe(true);
    for (const item of placed) if (item.queue) {
      const owner = stations.find((p) => p.id === item.id)!;
      expect(item.queue.x + item.queue.width / 2).toBe(owner.x);
      expect(item.queue.y).toBe(owner.y + 42);
    }
  });
  it('avoids all station touch rectangles and other actual cue bounds at phone density', () => {
    const stations = Array.from({ length: 16 }, (_, i) => ({ id: i + 1,
      x: 75 + (i % 4) * 35, y: 180 + Math.floor(i / 4) * 42,
      queue: i % 3 ? 12 : 2, crowd: i % 4 === 0 ? 300 : 0, selected: i === 4 }));
    const reserved = [{ x: 38, y: 100, width: 34, height: 34 }];
    const placed = layoutSceneCues(stations, { width: 390, height: 708 }, reserved);
    const visible = placed.flatMap((p) => [p.queue, p.warning].filter((v) => v !== null));
    expect(visible.length).toBeGreaterThan(0);
    for (const cue of visible) {
      expect(overlaps(cue!, reserved[0])).toBe(false);
      const owner = placed.find((p) => p.queue === cue || p.warning === cue)!.id;
      for (const station of stations.filter((p) => p.id !== owner)) expect(overlaps(cue!, {
        x: station.x - 22, y: station.y - 5, width: 44, height: 44,
      })).toBe(false);
      expect(cue!.x).toBeGreaterThanOrEqual(0);
      expect(cue!.x + cue!.width).toBeLessThanOrEqual(390);
    }
    for (const item of placed) if (item.queue) {
      const station = stations.find((p) => p.id === item.id)!;
      expect(item.queue.x + item.queue.width / 2).toBe(station.x);
      expect(item.queue.y).toBe(station.y + 42);
    }
    for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++)
      expect(overlaps(visible[i]!, visible[j]!)).toBe(false);
    expect(placed.filter((p) => p.queueFallback).length).toBe(stations.filter((p) => p.queue).length -
      placed.filter((p) => p.queue).length);
    expect(placed.filter((p) => p.warningFallback).length).toBe(0);
  });
  it('keeps warning rings at stations without a detached mobile warning detail', () => {
    const stations = [{ id: 1, x: 180, y: 170, queue: 4, crowd: 300, selected: true },
      { id: 2, x: 213, y: 151, queue: 8, crowd: 300, selected: false }];
    const placed = layoutSceneCues(stations, { width: 390, height: 708 });
    expect(placed.every((item) => item.warning === null && !item.warningFallback)).toBe(true);
    expect(placed.every((item) => item.queue || item.queueFallback)).toBe(true);
  });
  it('falls back instead of pushing a sparse warning or queue away from its station', () => {
    const placed = layoutSceneCues([{ id: 19, x: 180, y: 180, queue: 6, crowd: 100, selected: true }],
      { width: 390, height: 708 });
    expect(placed[0].warning).toBeNull();
    expect(placed[0].warningFallback).toBe(false);
    expect(placed[0].queue).not.toBeNull();
    expect(placed[0].queue!.y).toBe(222);
    expect(placed[0].queueFallback).toBe(false);
  });
});

describe('map information overlay placement', () => {
  it('keeps the station hit target separate while placing dense queues without collisions', () => {
    const stations = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, x: 60 + (i % 4) * 34,
      y: 130 + Math.floor(i / 4) * 44, queue: 8, crowd: 0, selected: false }));
    const placed = layoutOverlays(stations, { width: 390, height: 708 }, true);
    const visible = placed.flatMap((p) => [p.queue, p.warning].filter((v) => v !== null));
    for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]!, b = visible[j]!;
      expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
    }
    expect(placed.some((p) => p.queue !== null)).toBe(true);
    expect(placed.every((p) => p.queue || p.queueFallback)).toBe(true);
    expect(placed.map((p) => p.id)).toEqual(stations.map((p) => p.id));
  });
  it('preserves warning priority and marks warnings not placeable for the global alert', () => {
    const stations = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, x: 170 + (i % 6) * 7,
      y: 270 + Math.floor(i / 6) * 8, queue: 8, crowd: 100, selected: i === 0 }));
    const placed = layoutOverlays(stations, { width: 390, height: 708 }, true);
    expect(placed.some((p) => p.warning !== null)).toBe(true);
    expect(placed.some((p) => p.warningFallback)).toBe(true);
    expect(placed.some((p) => p.queueFallback)).toBe(true);
    const visible = placed.flatMap((p) => [p.queue, p.warning].filter((v) => v !== null));
    for (const a of visible) for (const b of visible) if (a !== b)
      expect(a!.x < b!.x + b!.width && a!.x + a!.width > b!.x && a!.y < b!.y + b!.height && a!.y + a!.height > b!.y).toBe(false);
  });
  it('keeps sparse labels visible and in bounds near the map edge', () => {
    const placed = layoutOverlays([{ id: 1, x: 24, y: 80, queue: 3, crowd: 12, selected: true }],
      { width: 390, height: 708 }, true);
    expect(placed[0].queue).not.toBeNull();
    expect(placed[0].warning).not.toBeNull();
    for (const item of [placed[0].queue, placed[0].warning]) {
      expect(item!.x).toBeGreaterThanOrEqual(0);
      expect(item!.y).toBeGreaterThanOrEqual(0);
      expect(item!.x + item!.width).toBeLessThanOrEqual(390);
      expect(item!.y + item!.height).toBeLessThanOrEqual(708);
    }
  });
  it('does not place a station warning far away from its station anchor', () => {
    const placed = layoutOverlays([{ id: 9, x: 180, y: 180, queue: 4, crowd: 10, selected: false },
      { id: 10, x: 180, y: 222, queue: 0, crowd: 20, selected: false }],
      { width: 390, height: 708 }, true);
    for (const p of placed) if (p.warning) {
      const anchorY = p.id === 9 ? 180 : 222;
      expect(Math.abs(p.warning.x + p.warning.width / 2 - 180)).toBeLessThanOrEqual(24);
      expect(Math.abs(p.warning.y + p.warning.height / 2 - anchorY)).toBeLessThanOrEqual(48);
    }
  });
});
