// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental, opt-in project proposals. Never substitute these for rules.1 replay generation.
import type { City, MapDefinition, MapPoint, MapRun, MapSpawnEvent, Shape } from './types';
import { distance, hash, riverCount, riverX, RULES, SHAPES } from './rules';

export const CREATIVE_SHAPES: readonly Shape[] = SHAPES;
const rectangle = (minX: number, maxX: number, minY: number, maxY: number) => [
  { x: minX, y: minY }, { x: maxX, y: minY },
  { x: maxX, y: maxY }, { x: minX, y: maxY },
];
const base: Shape[] = ['circle', 'triangle', 'square'];
const startStations = [
  { x: -7, y: 1, shape: 'circle' },
  { x: -3, y: -3, shape: 'triangle' },
  { x: 3, y: 2, shape: 'square' },
] satisfies { x: number; y: number; shape: Shape }[];
const area = (id: string, bounds: [number, number, number, number], shapes: Shape[], activeDay = 0) => ({
  id, polygon: rectangle(...bounds),
  shapeWeights: Object.fromEntries(shapes.map((shape) => [shape, 1])) as Partial<{ [K in Shape]: number }>,
  activeDay, maximum: 24,
});
const definition = (id: City, normalShapes: Shape[], areas: MapDefinition['areas'], schedules: MapDefinition['schedules']): MapDefinition => ({
  id, rulesVersion: 'orchard-metro.rules.2',
  viewport: { minX: -16, maxX: 16, minY: -10, maxY: 10 },
  obstacles: [], startStations, normalShapes, areas, schedules,
  separation: 2.65, waterMargin: 1.65, maxAttempts: 160, maxRetries: 3,
});

/** Editable project-proposal values; not calibrated against original Mini Metro. */
export const MAP_DEFINITIONS: Record<City, MapDefinition> = {
  orchard: {
    ...definition('orchard', [...base, 'diamond', 'star', 'cross'], [
      area('west', [-15, -6, -9, 9], [...base, 'diamond', 'star', 'cross']),
      area('east', [6, 15, -9, 9], [...base, 'diamond', 'star', 'cross'], 2),
    ], [{ id: 'orchard-growth', types: ['circle', 'triangle', 'square', 'circle', 'diamond', 'star', 'cross'], durationDays: 21, cooldownDays: 1, randomness: 0.2 }]),
    startStations: [startStations[0], { x: -4, y: -3, shape: 'triangle' }, startStations[2]],
  },
  harbor: definition('harbor', [...base, 'diamond', 'egg'], [
    area('upper', [-15, -2, 2, 9], [...base, 'diamond']),
    area('central', [-15, -2, -4, 1.9], [...base, 'egg']),
    area('lower', [11, 15, -9, -4], [...base, 'diamond', 'egg'], 3),
  ], [{ id: 'harbor-growth', types: ['triangle', 'circle', 'square', 'egg', 'diamond'], durationDays: 16, cooldownDays: 2, randomness: 0.25 }]),
  islands: definition('islands', [...base, 'star', 'cross', 'wedge'], [
    area('west', [-15, -8, -9, 9], [...base, 'star']),
    area('middle', [-2.5, 3, -9, 9], [...base, 'cross']),
    area('east', [9, 15, -9, 9], [...base, 'wedge'], 2),
  ], [{ id: 'islands-growth', types: ['circle', 'square', 'triangle', 'star', 'cross', 'wedge'], durationDays: 19, cooldownDays: 1, randomness: 0.2 }]),
};

function pointInPolygon(p: MapPoint, polygon: MapPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function edges(polygon: MapPoint[]): [MapPoint, MapPoint][] {
  return polygon.map((p, i) => [p, polygon[(i + 1) % polygon.length]]);
}
function orient(a: MapPoint, b: MapPoint, c: MapPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function intersect(a: MapPoint, b: MapPoint, c: MapPoint, d: MapPoint): boolean {
  const p = orient(a, b, c), q = orient(a, b, d), r = orient(c, d, a), s = orient(c, d, b);
  return p * q < 0 && r * s < 0;
}
function polygonsOverlap(a: MapPoint[], b: MapPoint[]): boolean {
  return a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a)) ||
    edges(a).some(([p, q]) => edges(b).some(([r, s]) => intersect(p, q, r, s)));
}
function polygonValid(points: MapPoint[]): boolean {
  if (!Array.isArray(points) || points.length < 3 || points.length > 64 ||
    points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  const signedArea = edges(points).reduce((v, [a, b]) => v + a.x * b.y - b.x * a.y, 0);
  if (Math.abs(signedArea) < 0.01) return false;
  const sides = edges(points);
  if (sides.some(([a, b]) => distance(a, b) < 0.01)) return false;
  return !sides.some(([a, b], i) => sides.some(([c, d], j) =>
    Math.abs(i - j) > 1 && Math.abs(i - j) !== sides.length - 1 && intersect(a, b, c, d)));
}
function areaTouchesWater(d: MapDefinition, polygon: MapPoint[]): boolean {
  // Reject even thin water intrusions, sampling along the curved water channels.
  for (let y = d.viewport.minY; y <= d.viewport.maxY + 0.001; y += 0.05)
    for (let r = 0; r < riverCount(d.id); r++)
      for (const offset of [-d.waterMargin, 0, d.waterMargin])
        if (pointInPolygon({ x: riverX(d.id, y, r) + offset, y }, polygon)) return true;
  return false;
}
function legalPoint(d: MapDefinition, p: MapPoint, stations: MapPoint[] = []): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) &&
    p.x >= d.viewport.minX && p.x <= d.viewport.maxX &&
    p.y >= d.viewport.minY && p.y <= d.viewport.maxY &&
    !d.obstacles.some((polygon) => pointInPolygon(p, polygon)) &&
    Array.from({ length: riverCount(d.id) }, (_, i) => i).every((i) => Math.abs(p.x - riverX(d.id, p.y, i)) >= d.waterMargin) &&
    stations.every((s) => distance(s, p) >= d.separation);
}
function integer(v: number, min: number, max: number): boolean {
  return Number.isInteger(v) && v >= min && v <= max;
}
export function validateMapDefinition(d: MapDefinition): MapDefinition {
  if (!d || d.rulesVersion !== 'orchard-metro.rules.2' || !['orchard', 'harbor', 'islands'].includes(d.id) ||
    !d.viewport || !Number.isFinite(d.viewport.minX) || !Number.isFinite(d.viewport.maxX) ||
    !Number.isFinite(d.viewport.minY) || !Number.isFinite(d.viewport.maxY) ||
    d.viewport.minX >= d.viewport.maxX || d.viewport.minY >= d.viewport.maxY ||
    !Number.isFinite(d.separation) || d.separation <= 0 ||
    !Number.isFinite(d.waterMargin) || d.waterMargin <= 0 ||
    !integer(d.maxAttempts, 1, 1000) || !integer(d.maxRetries, 0, 20) ||
    !Array.isArray(d.obstacles) || d.obstacles.some((p) => !polygonValid(p)) ||
    !Array.isArray(d.areas) || !d.areas.length || d.areas.length > 32 ||
    !Array.isArray(d.normalShapes) || !d.normalShapes.length ||
    new Set(d.normalShapes).size !== d.normalShapes.length || d.normalShapes.some((s) => !SHAPES.includes(s)) ||
    !Array.isArray(d.startStations) || d.startStations.length !== 3 ||
    d.startStations.some((p, i) => !d.normalShapes.includes(p.shape) || !legalPoint(d, p, d.startStations.slice(0, i))) ||
    !Array.isArray(d.schedules) || !d.schedules.length || d.schedules.length > 32) throw new Error('invalid map definition');
  const ids = new Set<string>();
  for (const a of d.areas) {
    if (!a || typeof a.id !== 'string' || !a.id || ids.has(a.id) || !polygonValid(a.polygon) ||
      a.polygon.some((p) => p.x < d.viewport.minX || p.x > d.viewport.maxX || p.y < d.viewport.minY || p.y > d.viewport.maxY) ||
      d.obstacles.some((p) => polygonsOverlap(p, a.polygon)) || areaTouchesWater(d, a.polygon) ||
      d.areas.some((other) => other !== a && polygonValid(other.polygon) && polygonsOverlap(other.polygon, a.polygon)) ||
      !integer(a.activeDay, 0, 100000) || !integer(a.maximum, 1, 48) ||
      !a.shapeWeights || !Object.keys(a.shapeWeights).length ||
      Object.entries(a.shapeWeights).some(([s, w]) => !d.normalShapes.includes(s as Shape) || !Number.isFinite(w) || w <= 0))
      throw new Error('invalid map area');
    ids.add(a.id);
  }
  ids.clear();
  for (const s of d.schedules) {
    if (!s || typeof s.id !== 'string' || !s.id || ids.has(s.id) ||
      !Array.isArray(s.types) || !s.types.length || s.types.length > 48 ||
      s.types.some((type) => !d.normalShapes.includes(type) ||
        !d.areas.some((a) => a.activeDay <= s.durationDays && (a.shapeWeights[type] ?? 0) > 0)) ||
      !integer(s.durationDays, 1, 1000) || !integer(s.cooldownDays, 0, 1000) ||
      !Number.isFinite(s.randomness) || s.randomness < 0 || s.randomness > 1)
      throw new Error('invalid map schedule');
    ids.add(s.id);
  }
  return d;
}

const DAY_TICKS = RULES.dayTicks;
function seeded(run: MapRun): number {
  let x = run.rng;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  run.rng = x >>> 0;
  return run.rng / 4294967296;
}
export function createMapRun(d: MapDefinition, seed: number): MapRun {
  validateMapDefinition(d);
  if (!integer(seed, 0, 0xffffffff)) throw new Error('invalid map seed');
  return {
    version: d.rulesVersion, mapId: d.id, definitionHash: hash(d), seed, rng: seed || 1, tick: 0,
    stations: structuredClone(d.startStations), events: [], pending: [],
    nextBatch: DAY_TICKS, batchIndex: 0, blocked: false,
  };
}
function planBatch(run: MapRun, d: MapDefinition): void {
  const schedule = d.schedules[run.batchIndex % d.schedules.length];
  run.batchIndex++;
  const duration = schedule.durationDays * DAY_TICKS;
  schedule.types.forEach((shape, i) => {
    const center = (i + 1) * duration / (schedule.types.length + 1);
    const spread = duration / (schedule.types.length + 1) * schedule.randomness;
    const tick = run.nextBatch + Math.max(1, Math.round(center + (seeded(run) * 2 - 1) * spread));
    run.pending.push({ shape, scheduleId: schedule.id, tick, retries: 0 });
  });
  run.pending.sort((a, b) => a.tick - b.tick);
  run.nextBatch += duration + schedule.cooldownDays * DAY_TICKS;
}
function chooseArea(run: MapRun, areas: MapDefinition['areas'], shape: Shape): MapDefinition['areas'][number] {
  const sum = areas.reduce((n, a) => n + (a.shapeWeights[shape] ?? 0), 0);
  let target = seeded(run) * sum;
  for (const area of areas) {
    target -= area.shapeWeights[shape] ?? 0;
    if (target < 0) return area;
  }
  return areas.at(-1)!;
}
function spawn(run: MapRun, d: MapDefinition, item: MapRun['pending'][number]): void {
  const day = Math.floor(run.tick / DAY_TICKS);
  const areas = d.areas.filter((a) => a.activeDay <= day && (a.shapeWeights[item.shape] ?? 0) > 0 &&
    run.events.filter((e) => e.result === 'spawned' && e.areaId === a.id).length < a.maximum);
  const event: MapSpawnEvent = {
    rulesVersion: d.rulesVersion, mapId: d.id, seed: run.seed, tick: run.tick,
    shape: item.shape, scheduleId: item.scheduleId, areaId: null, position: null,
    attempts: 0, result: 'retry',
  };
  if (run.stations.length >= RULES.maxStations) event.reason = 'station-limit';
  else if (!areas.length) event.reason = d.areas.some((a) => a.activeDay <= day && (a.shapeWeights[item.shape] ?? 0) > 0) ? 'maximum' : 'no-area';
  else {
    const area = chooseArea(run, areas, item.shape);
    event.areaId = area.id;
    const minX = Math.min(...area.polygon.map((p) => p.x)), maxX = Math.max(...area.polygon.map((p) => p.x));
    const minY = Math.min(...area.polygon.map((p) => p.y)), maxY = Math.max(...area.polygon.map((p) => p.y));
    for (let attempt = 0; attempt < d.maxAttempts; attempt++) {
      event.attempts++;
      const point = { x: Math.round((minX + seeded(run) * (maxX - minX)) * 10) / 10,
        y: Math.round((minY + seeded(run) * (maxY - minY)) * 10) / 10 };
      if (!pointInPolygon(point, area.polygon) || !legalPoint(d, point, run.stations)) continue;
      event.result = 'spawned';
      event.position = point;
      run.stations.push({ ...point, shape: item.shape });
      break;
    }
    if (event.result !== 'spawned') event.reason = 'no-point';
  }
  if (event.result !== 'spawned') {
    if (item.retries < d.maxRetries) {
      run.pending.push({ ...item, retries: item.retries + 1, tick: run.tick + DAY_TICKS });
    } else {
      event.result = 'blocked';
      run.blocked = true; // Explicit tuning failure, never silently switch shape or spin forever.
    }
  }
  run.events.push(event);
}
/** Advances the standalone map-v2 proposal only; does not alter the live rules.1 State. */
export function advanceMapRun(run: MapRun, d: MapDefinition, ticks: number): void {
  if (run.version !== d.rulesVersion || run.mapId !== d.id || run.definitionHash !== hash(d))
    throw new Error('map definition/version mismatch');
  if (!integer(ticks, 0, 1000000)) throw new Error('invalid map tick count');
  const end = run.tick + ticks;
  while (!run.blocked && (run.nextBatch <= end || run.pending.some((p) => p.tick <= end))) {
    const next = Math.min(run.nextBatch, ...run.pending.map((p) => p.tick));
    run.tick = next;
    if (next === run.nextBatch) planBatch(run, d);
    else {
      const index = run.pending.findIndex((p) => p.tick === next);
      spawn(run, d, run.pending.splice(index, 1)[0]);
    }
  }
  run.tick = end;
}