import { describe, expect, it } from 'vitest';
import { breakLoopEdge, endpointStep, extensionStops, removedRouteEdges, safeLoopRelease } from '../src/route-gestures';
import { advance, applyAction, createState, hash } from '../src/rules';
import type { State } from '../src/types';

function population(s: State): number {
  return s.score + s.stations.reduce((n, p) => n + p.queue.length, 0) +
    s.trains.reduce((n, t) => n + t.passengers.length + Number(!!t.transfer), 0);
}

const stops = [1, 2, 3];
describe('route gesture decisions', () => {
  it('extends the original line from either distinct outside endpoint', () => {
    expect(extensionStops(stops, 'start', [4, 5])).toEqual([5, 4, 1, 2, 3]);
    expect(extensionStops(stops, 'end', [4, 5])).toEqual([1, 2, 3, 4, 5]);
    expect(extensionStops(stops, 'start', [2])).toBeNull();
  });
  it('diffs withdrawn rail edges even when a route is replaced at the same length', () => {
    expect(removedRouteEdges([1, 2, 3], [1, 2, 4])).toEqual([[2, 3]]);
    expect(removedRouteEdges([1, 2, 3], [1, 2])).toEqual([[2, 3]]);
    expect(removedRouteEdges([1, 2, 3], [1])).toEqual([[1, 2], [2, 3]]);
    expect(removedRouteEdges([1, 2, 3], [1, 2, 3])).toEqual([]);
    expect(removedRouteEdges([1, 2, 3], [4, 1, 2, 3])).toEqual([]);
  });
  it('retracts only the adjacent prior stop from either endpoint, then allows re-extension', () => {
    expect(endpointStep([1, 2, 3, 4], 'end', [1, 2, 3, 4], 3)).toEqual({ stops: [1, 2, 3], loop: false });
    expect(endpointStep([1, 2, 3, 4], 'end', [1, 2, 3], 2)).toEqual({ stops: [1, 2], loop: false });
    expect(endpointStep([1, 2, 3, 4], 'start', [1, 2, 3, 4], 2)).toEqual({ stops: [2, 3, 4], loop: false });
    expect(endpointStep([1, 2, 3, 4], 'start', [2, 3, 4], 3)).toEqual({ stops: [3, 4], loop: false });
    expect(endpointStep([1, 2, 3, 4], 'end', [1, 2], 3)).toEqual({ stops: [1, 2, 3], loop: false });
  });
  it('retains a one-stop preview so reversing toward the prior endpoint can restore the line before release', () => {
    expect(endpointStep([1, 2, 3], 'end', [1, 2], 1)).toEqual({ stops: [1], loop: false });
    expect(endpointStep([1, 2, 3], 'start', [2, 3], 3)).toEqual({ stops: [3], loop: false });
    expect(endpointStep([1, 2, 3], 'end', [1], 2)).toEqual({ stops: [1, 2], loop: false });
  });
  it('preserves extension, one-step undo, and closure after visiting outside stations', () => {
    expect(endpointStep(stops, 'end', stops, 4)).toEqual({ stops: [1, 2, 3, 4], loop: false });
    expect(endpointStep(stops, 'end', [1, 2, 3, 4], 3)).toEqual({ stops: [1, 2, 3], loop: false });
    expect(endpointStep(stops, 'start', [4, 1, 2, 3], 1)).toEqual({ stops: [1, 2, 3], loop: false });
    expect(endpointStep(stops, 'end', stops, 1)).toEqual({ stops, loop: true });
    expect(endpointStep(stops, 'end', [1, 2], 3)).toEqual({ stops, loop: false });
    expect(endpointStep([1, 2, 3, 4], 'end', [1, 2, 3, 4], 2)).toBeNull();
    expect(endpointStep([1, 2, 3, 4], 'start', [1, 2, 3, 4], 3)).toBeNull();
  });
  it('clears the last segment through the route rule, retiring trains without losing riders', () => {
    const s = createState({ seed: 420, mode: 'normal' });
    s.nextStation = 1e8;
    for (const station of s.stations) station.nextPassenger = 1e8;
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2] }).ok).toBe(true);
    const train = s.trains[0];
    train.from = 1; train.to = 2; train.progress = 0.5;
    train.passengers.push({ id: s.nextId++, shape: 'triangle', born: 0, transfers: 0 });
    s.totalSpawned = 1;
    // One-station drafts cannot be submitted; the existing clear action is the only valid final edit.
    expect(applyAction(s, { type: 'route', line: 0, stops: [1] }).ok).toBe(false);
    expect(applyAction(s, { type: 'route', line: 0, stops: [] }).ok).toBe(true);
    expect(train.retiring).toBe(true);
    for (let i = 0; i < 500 && s.trains.length; i++) advance(s);
    expect(s.trains).toHaveLength(0);
    expect(s.resources.locomotives).toBe(3);
    expect(population(s)).toBe(s.totalSpawned);
  });
  it('opens the chosen closing edge without rotating stations', () => {
    expect(breakLoopEdge(stops, 3)).toEqual(stops);
  });
  it('rotates the route only when breaking an internal edge', () => {
    expect(breakLoopEdge(stops, 1)).toEqual([2, 3, 1]);
    expect(breakLoopEdge(stops, 2)).toEqual([3, 1, 2]);
  });
  it('conserves riders while a train finishes a removed loop edge and reverses on the opened route', () => {
    const s = createState({ seed: 420, mode: 'creative' });
    s.nextStation = 1e8;
    for (const station of s.stations) station.nextPassenger = 1e8;
    expect(applyAction(s, { type: 'route', line: 0, stops, loop: true }).ok).toBe(true);
    const train = s.trains[0];
    const passenger = { id: s.nextId++, shape: s.stations[2].shape, born: 0, transfers: 0 };
    s.totalSpawned = 1;
    train.from = 1; train.to = 2; train.progress = 0.5;
    train.passengers.push(passenger);
    expect(applyAction(s, { type: 'route', line: 0, stops: breakLoopEdge(stops, 1)!, loop: false }).ok).toBe(true);
    expect(s.lines[0]).toEqual({ id: 0, stops: [2, 3, 1], loop: false });
    let reachedOldEdge = false;
    for (let i = 0; i < 1600 && s.score < 1; i++) {
      advance(s);
      if (train.from === 2 && train.to === null) reachedOldEdge = true;
      expect(population(s)).toBe(s.totalSpawned);
    }
    expect(reachedOldEdge).toBe(true);
    expect(s.score).toBe(1);
  });
  it('rejects every loop break in extreme mode atomically, including in-transit breaks', () => {
    const s = createState({ seed: 420, mode: 'extreme' });
    expect(applyAction(s, { type: 'route', line: 0, stops, loop: true }).ok).toBe(true);
    const t = s.trains[0];
    t.from = 1; t.to = 2; t.progress = 0.5;
    for (const edge of [1, 2, 3]) {
      const before = hash(s);
      const result = applyAction(s, { type: 'route', line: 0, stops: breakLoopEdge(stops, edge)!, loop: false });
      expect(result.ok).toBe(false);
      expect(hash(s)).toBe(before);
      expect(t.to).toBe(2);
    }
  });
  it('requires a distant blank interior release, not a return or unsafe target', () => {
    const origin = { x: 100, y: 100 }, bounds = { left: 0, top: 0, right: 400, bottom: 300 };
    expect(safeLoopRelease(origin, { x: 175, y: 160 }, bounds, false)).toBe(true);
    expect(safeLoopRelease(origin, { x: 135, y: 120 }, bounds, false)).toBe(false);
    expect(safeLoopRelease(origin, { x: 175, y: 160 }, bounds, true)).toBe(false);
    expect(safeLoopRelease(origin, { x: 5, y: 160 }, bounds, false)).toBe(false);
    expect(safeLoopRelease(origin, { x: 180, y: 310 }, bounds, false)).toBe(false);
  });
});
