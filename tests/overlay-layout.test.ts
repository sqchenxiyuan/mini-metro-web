import { describe, expect, it } from 'vitest';
import { layoutOverlays } from '../src/overlay-layout';

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
