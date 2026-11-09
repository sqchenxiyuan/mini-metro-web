import { describe, expect, it } from 'vitest';
import { RULES } from '../src/rules';
import { crowdFillFraction, groupJitter, passengerJitter } from '../src/visual-crowd';
import { layoutSceneCues, queueCueBounds } from '../src/overlay-layout';

describe('visual-only station crowd and queue motion', () => {
  it('fills from empty through partial to full only in loss-capable modes, then recedes', () => {
    expect(crowdFillFraction(0, 'normal')).toBe(0);
    expect(crowdFillFraction(RULES.crowdTicks / 2, 'normal')).toBeCloseTo(.5);
    expect(crowdFillFraction(RULES.crowdTicks, 'extreme')).toBe(1);
    expect(crowdFillFraction(RULES.crowdTicks / 4, 'normal')).toBeCloseTo(.25);
    expect(crowdFillFraction(RULES.crowdTicks, 'endless')).toBeLessThan(1);
    expect(crowdFillFraction(RULES.crowdTicks, 'creative')).toBeLessThan(1);
  });
  it('jiggles every rider independently within a bounded x/y slot, deterministically and without mutating ID', () => {
    const first = passengerJitter(101, 0, 31, false);
    const same = passengerJitter(101, 0, 31, false);
    expect(first).toEqual(same);
    expect(first).not.toEqual(passengerJitter(102, 0, 31, false));
    expect(first).not.toEqual(passengerJitter(101, 0, 62, false));
    for (const id of [101, 102, 103]) for (const tick of [0, 31, 62, 1000]) {
      const { x, y } = passengerJitter(id, 0, tick, false);
      expect(Math.abs(x)).toBeLessThanOrEqual(1.4);
      expect(Math.abs(y)).toBeLessThanOrEqual(1.4);
    }
  });
  it('freezes within a tick and disables motion under reduced motion regardless of age', () => {
    expect(passengerJitter(12, 5, 500, true)).toEqual({ x: 0, y: 0 });
    expect(passengerJitter(12, 499, 500, false)).not.toEqual({ x: 0, y: 0 });
  });
  it('groups all rider phases into one bounded shared icon-and-count offset', () => {
    const riders = [1, 2, 3].map(id => ({ id, born: 0, transfers: 0, shape: 'circle' as const }));
    const mark = groupJitter(riders, 100, false);
    expect(mark.x).toBeCloseTo(riders.reduce((sum, p) => sum + passengerJitter(p.id, p.born, 100, false).x, 0) / riders.length);
    expect(mark.y).toBeCloseTo(riders.reduce((sum, p) => sum + passengerJitter(p.id, p.born, 100, false).y, 0) / riders.length);
    expect(groupJitter(riders, 100, true)).toEqual({ x: 0, y: 0 });
  });
  it('reserves jitter margins for exact grouped mobile marks and no displaced crowd warning', () => {
    const stations = [{ id: 1, x: 180, y: 150, queue: 12, queueShapes: ['circle', 'triangle'] as const,
      crowd: RULES.crowdTicks / 2, selected: false }];
    const layout = layoutSceneCues(stations, { width: 390, height: 700 });
    expect(layout[0].warning).toBeNull();
    expect(layout[0].warningFallback).toBe(false);
    expect(layout[0].queue?.width).toBe(queueCueBounds(12, 'full', true, 2).width);
    expect(layout[0].queue?.width).toBeGreaterThan(100);
    expect(queueCueBounds(2, 'full', true).width).toBeGreaterThan(24);
  });
});
