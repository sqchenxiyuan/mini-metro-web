import { describe, expect, it } from 'vitest';
import { advanceMapRun, createMapRun, CREATIVE_SHAPES, MAP_DEFINITIONS, validateMapDefinition } from '../src/map-generation';
import { distance, hash, riverCount, riverX, SHAPES } from '../src/rules';
import { ReplayPlayer, Session } from '../src/session';
import type { City, MapDefinition } from '../src/types';

const cities: City[] = ['orchard', 'harbor', 'islands'];
const clone = <T>(value: T): T => structuredClone(value);

describe('opt-in city map generator (project proposal, not original-game calibration)', () => {
  it('validates three distinct city definitions and keeps Creative ten shapes separate from each Normal city pool', () => {
    expect(CREATIVE_SHAPES).toEqual(SHAPES);
    const signatures = new Set<string>();
    for (const city of cities) {
      const definition = validateMapDefinition(MAP_DEFINITIONS[city]);
      expect(definition.id).toBe(city);
      expect(definition.rulesVersion).toBe('orchard-metro.rules.2');
      expect(definition.normalShapes.length).toBeLessThan(CREATIVE_SHAPES.length);
      expect(definition.normalShapes.every((shape) => SHAPES.includes(shape))).toBe(true);
      signatures.add(JSON.stringify([definition.areas, definition.schedules]));
    }
    expect(signatures.size).toBe(cities.length);
  });
  it('rejects malformed polygons, water overlap, unreachable shapes, weights, schedules and invalid starts', () => {
    const invalid = (edit: (d: MapDefinition) => void) => {
      const d = clone(MAP_DEFINITIONS.orchard);
      edit(d);
      expect(() => validateMapDefinition(d)).toThrow();
    };
    invalid((d) => { d.areas[0].polygon.pop(); d.areas[0].polygon.pop(); });
    invalid((d) => { d.obstacles = [clone(d.areas[0].polygon)]; });
    invalid((d) => { d.areas[0].shapeWeights.circle = -1; });
    invalid((d) => { d.areas[0].shapeWeights.circle = NaN; });
    invalid((d) => { d.areas.forEach((a) => { delete a.shapeWeights.circle; }); });
    invalid((d) => { d.areas.forEach((a) => { a.activeDay = 100; }); });
    invalid((d) => { d.startStations[0].x = -30; });
    invalid((d) => { d.startStations[0].x = 0; });
    invalid((d) => { d.schedules[0].durationDays = 0; });
    invalid((d) => { d.maxAttempts = Infinity; });
  });
  it('schedules seeded batches and records legal, deterministic results across cities and seeds', () => {
    for (const city of cities) for (const seed of [0, 1, 42, 420, 9001]) {
      const d = MAP_DEFINITIONS[city];
      const a = createMapRun(d, seed), b = createMapRun(d, seed);
      for (let day = 0; day < 45; day++) {
        advanceMapRun(a, d, 240);
        advanceMapRun(b, d, 240);
      }
      expect(hash(a)).toBe(hash(b));
      expect(a.events.length).toBeGreaterThan(1);
      expect(a.events.every((e) => e.rulesVersion === d.rulesVersion && e.mapId === city && e.seed === seed)).toBe(true);
      expect(a.events.every((e) => d.normalShapes.includes(e.shape))).toBe(true);
      expect(a.events.filter((e) => e.result === 'spawned').length).toBe(a.stations.length - d.startStations.length);
      for (const e of a.events.filter((e) => e.result === 'spawned')) {
        const p = e.position!;
        expect(e.areaId).not.toBeNull();
        expect(p.x).toBeGreaterThanOrEqual(d.viewport.minX);
        expect(p.x).toBeLessThanOrEqual(d.viewport.maxX);
        expect(p.y).toBeGreaterThanOrEqual(d.viewport.minY);
        expect(p.y).toBeLessThanOrEqual(d.viewport.maxY);
        for (let r = 0; r < riverCount(city); r++) expect(Math.abs(p.x - riverX(city, p.y, r))).toBeGreaterThanOrEqual(d.waterMargin);
      }
      for (let i = 0; i < a.stations.length; i++) for (let j = 0; j < i; j++)
        expect(distance(a.stations[i], a.stations[j])).toBeGreaterThanOrEqual(d.separation);
    }
  });
  it('keeps default rules.1 state/replay fingerprints stable and does not activate map-v2 implicitly', () => {
    const fingerprints = { orchard: ['97f4db53', '54c9b591'], harbor: ['b31a002c', 'd7796ecb'], islands: ['595ec61d', '3fb90f18'] };
    for (const city of cities) {
      const game = new Session({ seed: 42, city });
      expect(game.getState().version).toBe('orchard-metro.rules.1');
      expect(hash(game.getState())).toBe(fingerprints[city][0]);
      game.step(1000);
      expect(hash(game.getState())).toBe(fingerprints[city][1]);
      expect(hash(new ReplayPlayer(game.exportReplay()).getState())).toBe(fingerprints[city][1]);
    }
  });
  it('bounds impossible placements, logs failure without replacing the scheduled shape', () => {
    const d = clone(MAP_DEFINITIONS.islands);
    d.maxAttempts = 2;
    d.maxRetries = 1;
    d.areas = [{ id: 'occupied', polygon: [
      { x: -7.1, y: 0.9 }, { x: -6.9, y: 0.9 }, { x: -6.9, y: 1.1 }, { x: -7.1, y: 1.1 },
    ], shapeWeights: { circle: 1 }, activeDay: 0, maximum: 5 }];
    d.schedules = [{ id: 'blocked', types: ['circle'], durationDays: 4, cooldownDays: 1, randomness: 0 }];
    const run = createMapRun(d, 7);
    advanceMapRun(run, d, 10000);
    expect(run.blocked).toBe(true);
    expect(run.events.map((e) => e.result)).toEqual(['retry', 'blocked']);
    expect(run.events.map((e) => e.shape)).toEqual(['circle', 'circle']);
    expect(run.events.map((e) => e.attempts)).toEqual([2, 2]);
    expect(run.stations).toHaveLength(3);
  });
  it('rejects a changed definition during a seeded run rather than silently continuing a different map', () => {
    const d = clone(MAP_DEFINITIONS.orchard);
    const run = createMapRun(d, 42);
    d.schedules[0].types[0] = 'square';
    expect(() => advanceMapRun(run, d, 240)).toThrow(/definition|fingerprint|mismatch/i);
  });
  it('rejects areas that touch water or overlap another region', () => {
    const water = clone(MAP_DEFINITIONS.orchard);
    water.areas[0].polygon = [
      { x: -4, y: -2 }, { x: 4, y: -2 }, { x: 4, y: 2 }, { x: -4, y: 2 },
    ];
    expect(() => validateMapDefinition(water)).toThrow();
    const overlap = clone(MAP_DEFINITIONS.orchard);
    overlap.areas.push({ ...clone(overlap.areas[0]), id: 'overlap' });
    expect(() => validateMapDefinition(overlap)).toThrow();
  });
  it('is invariant to chunked versus single-step advancement of the same simulation ticks', () => {
    const d = MAP_DEFINITIONS.harbor;
    const a = createMapRun(d, 42), b = createMapRun(d, 42);
    advanceMapRun(a, d, 12000);
    for (let i = 0; i < 50; i++) advanceMapRun(b, d, 240);
    expect(hash(a)).toBe(hash(b));
  });
  it('enforces area maximum and logs exhausted area instead of changing shape', () => {
    const d = clone(MAP_DEFINITIONS.islands);
    d.schedules = [{ id: 'cap', types: ['circle'], durationDays: 2, cooldownDays: 0, randomness: 0 }];
    d.areas = [d.areas[0]];
    d.areas[0].maximum = 1;
    d.areas[0].shapeWeights = { circle: 1 };
    d.maxRetries = 0;
    const run = createMapRun(d, 12);
    advanceMapRun(run, d, 1600);
    expect(run.events.some((e) => e.result === 'spawned')).toBe(true);
    expect(run.events.at(-1)?.reason).toBe('maximum');
    expect(run.events.at(-1)?.result).toBe('blocked');
  });
});
