import { describe, expect, it } from 'vitest';
import { layoutOverlays, layoutSceneCues } from '../src/overlay-layout';

const overlaps = (a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe('anchored WebGL cue placement', () => {
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
    for (const item of placed) for (const cue of [item.queue, item.warning]) if (cue) {
      const station = stations.find((p) => p.id === item.id)!;
      expect(Math.hypot(cue.x + cue.width / 2 - station.x,
        cue.y + cue.height / 2 - station.y)).toBeLessThanOrEqual(36);
    }
    for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++)
      expect(overlaps(visible[i]!, visible[j]!)).toBe(false);
    expect(placed.filter((p) => p.queueFallback).length).toBe(stations.filter((p) => p.queue).length -
      placed.filter((p) => p.queue).length);
    expect(placed.filter((p) => p.warningFallback).length).toBe(stations.filter((p) => p.crowd).length -
      placed.filter((p) => p.warning).length);
  });
  it('places warning detail first and keeps it at the owning anchor rather than a detached card', () => {
    const stations = [{ id: 1, x: 180, y: 170, queue: 4, crowd: 300, selected: true },
      { id: 2, x: 213, y: 151, queue: 8, crowd: 300, selected: false }];
    const placed = layoutSceneCues(stations, { width: 390, height: 708 });
    expect(placed[0].warning).not.toBeNull();
    expect(placed[0].warningFallback).toBe(false);
    for (const item of placed) if (item.warning) {
      expect(Math.hypot(item.warning.x + item.warning.width / 2 - stations[item.id - 1].x,
        item.warning.y + item.warning.height / 2 - stations[item.id - 1].y)).toBeLessThanOrEqual(55);
    }
    expect(placed.flatMap((p) => [p.queue, p.warning].filter(Boolean)).every((box) =>
      !overlaps(box!, { x: 191, y: 146, width: 44, height: 44 }) ||
      placed[1].queue === box || placed[1].warning === box)).toBe(true);
  });
  it('falls back instead of pushing a sparse warning or queue away from its station', () => {
    const placed = layoutSceneCues([{ id: 19, x: 180, y: 180, queue: 6, crowd: 100, selected: true }],
      { width: 390, height: 708 });
    const shown = [placed[0].queue, placed[0].warning].filter((box) => box !== null);
    expect(shown.length).toBeGreaterThan(0);
    for (const cue of shown) expect(Math.hypot(cue!.x + cue!.width / 2 - 180,
      cue!.y + cue!.height / 2 - 180)).toBeLessThanOrEqual(36);
    expect(Number(placed[0].queueFallback) + Number(placed[0].warningFallback)).toBe(2 - shown.length);
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
