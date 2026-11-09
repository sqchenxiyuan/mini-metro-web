import { describe, it, expect } from 'vitest';
import {
  advance,
  applyAction,
  copy,
  createState,
  findRoute,
  hash,
  RULES,
  station,
  trackLength,
  trackPoints,
  trackPosition,
  tunnelsUsed,
} from '../src/rules';
import { ReplayPlayer, Session } from '../src/session';
import { decide, dispatcherPolicy, runAgent } from '../src/agent';
import type { Passenger, State } from '../src/types';

function quiet(): State {
  const s = createState();
  s.nextStation = 1e8;
  for (const p of s.stations) p.nextPassenger = 1e8;
  return s;
}
function ticks(s: State, n: number): void {
  for (let i = 0; i < n; i++) advance(s);
}
function passenger(s: State, shape: Passenger['shape']): Passenger {
  return { id: s.nextId++, shape, born: s.elapsed, transfers: 0 };
}
function population(s: State): number {
  return (
    s.score +
    s.stations.reduce((n, p) => n + p.queue.length, 0) +
    s.trains.reduce((n, t) => n + t.passengers.length + (t.transfer ? 1 : 0), 0)
  );
}

describe('transport rules', () => {
  it('rejects previous-version replays after endpoint return semantics change', () => {
    const session = new Session({ seed: 42 });
    expect(session.getState().version).toBe('orchard-metro.rules.7');
    expect(session.exportReplay().format).toBe('orchard-metro.replay.v7');
    expect(() => new ReplayPlayer({ ...session.exportReplay(), format: 'orchard-metro.replay.v6' } as unknown as import('../src/types').Replay)).toThrow(/录像结构不合法/);
  });
  it('runs at 50 ticks per real second while preserving day, week, crowd and speed durations', () => {
    expect(RULES.hz).toBe(50);
    expect(RULES.dayTicks / RULES.hz).toBe(12);
    expect(RULES.weekTicks / RULES.hz).toBe(84);
    expect(RULES.crowdTicks / RULES.hz).toBe(45);
    const s = createState({ seed: 42 });
    expect(s.nextStation / RULES.hz).toBe(21);
    expect(s.stations[0].nextPassenger / RULES.hz).toBeGreaterThanOrEqual(4);
    const start = station(s, 1).nextPassenger;
    expect(start / RULES.hz).toBeLessThan(9);
    applyAction(s, { type: 'route', line: 0, stops: [1, 2] });
    const t = s.trains[0]; t.dwell = 0;
    for (let i = 0; i < 23; i++) advance(s);
    expect(t.to).toBe(2);
    const a = station(s, 1), b = station(s, 2);
    const duration = trackLength(a, b) / RULES.speed;
    const tickCount = Math.ceil(trackLength(a, b) / (RULES.speed / RULES.hz));
    expect(Math.abs(tickCount / RULES.hz - duration)).toBeLessThanOrEqual(1 / RULES.hz);
  });
  it('uses a new replay/rules version when tick cadence changes', () => {
    const s = new Session({ seed: 42 });
    expect(s.getState().version).toBe('orchard-metro.rules.7');
    expect(s.exportReplay().format).toBe('orchard-metro.replay.v7');
    expect(() => new ReplayPlayer({ ...s.exportReplay(), format: 'orchard-metro.replay.v3' } as unknown as import('../src/types').Replay)).toThrow(/录像结构不合法/);
  });
  it('versions the destination weighting change in rules and replays', () => {
    const session = new Session({ seed: 42 });
    expect(session.getState().version).toBe('orchard-metro.rules.7');
    expect(session.exportReplay().format).toBe('orchard-metro.replay.v7');
    expect(() => new ReplayPlayer({ ...session.exportReplay(), format: 'orchard-metro.replay.v4' } as unknown as import('../src/types').Replay)).toThrow(/录像结构不合法/);
  });
  it('never chooses the origin shape when no matching destination exists', () => {
    const s = createState({ seed: 91, mode: 'creative' });
    for (const p of s.stations) p.shape = 'circle';
    s.stations[0].nextPassenger = 1;
    for (const p of s.stations.slice(1)) p.nextPassenger = 1e8;
    advance(s);
    expect(s.stations[0].queue).toEqual([]);
    expect(s.totalSpawned).toBe(0);
    s.stations[2].shape = 'diamond';
    s.stations[0].nextPassenger = s.elapsed + 1;
    advance(s);
    expect(s.stations[0].queue.map((p) => p.shape)).toEqual(['diamond']);
  });
  it('does not spike the new special shape demand across ordinary city growth', () => {
    const s = createState({ seed: 420, mode: 'normal' });
    s.nextStation = 1;
    for (let i = 0; i < 6; i++) {
      advance(s);
      s.nextStation = s.elapsed + 1;
    }
    expect(s.stations.map((p) => p.shape)).toContain('diamond');
    const origins = s.stations.filter((p) => p.shape !== 'diamond');
    for (const p of s.stations) p.nextPassenger = 1e8;
    let diamond = 0, generated = 0;
    for (let i = 0; i < 400; i++) {
      for (const p of origins) p.nextPassenger = s.elapsed + 1;
      advance(s);
      for (const p of origins) {
        const last = p.queue.at(-1);
        if (last?.born === s.elapsed) {
          if (last.shape === 'diamond') diamond++;
          generated++;
        }
        p.queue = [];
      }
    }
    expect(generated).toBeGreaterThan(0);
    expect(diamond / generated).toBeLessThan(0.2);
  });
  it('keeps a rare special destination below its station-share demand across multiple seeded runs', () => {
    for (const seed of [1, 17, 420, 9001]) {
      const s = createState({ seed, mode: 'creative' });
      const source = s.stations[0];
      const starting = [...s.stations];
      for (let i = 0; i < 4; i++) for (const base of starting)
        s.stations.push({ ...base, id: s.nextId++, queue: [], nextPassenger: 1e8 });
      s.stations.push({ ...source, id: s.nextId++, shape: 'star', queue: [], nextPassenger: 1e8 });
      for (const p of s.stations) p.nextPassenger = 1e8;
      let special = 0;
      for (let i = 0; i < 600; i++) {
        source.nextPassenger = s.elapsed + 1;
        advance(s);
        if (source.queue[0].shape === 'star') special++;
        source.queue = [];
      }
      expect(special).toBeLessThan(100);
    }
  });
  it('weights destination shapes by the number of existing stations, not distinct shapes', () => {
    const s = createState({ seed: 420, mode: 'creative' });
    const source = s.stations[0];
    // One rare special station among many ordinary ones: each destination station
    // gets one weight, rather than giving the rare shape a third of all demand.
    for (let i = 0; i < 3; i++) for (const base of s.stations.slice(0, 3))
      s.stations.push({ ...base, id: s.nextId++, queue: [], nextPassenger: 1e8 });
    s.stations.push({ ...source, id: s.nextId++, shape: 'diamond', queue: [], nextPassenger: 1e8 });
    for (const p of s.stations) p.nextPassenger = 1e8;
    let special = 0;
    const samples = 2000;
    for (let i = 0; i < samples; i++) {
      source.nextPassenger = s.elapsed + 1;
      advance(s);
      expect(source.queue).toHaveLength(1);
      if (source.queue[0].shape === 'diamond') special++;
      source.queue = [];
    }
    expect(special / samples).toBeGreaterThan(0.06);
    expect(special / samples).toBeLessThan(0.16);
  });
  it('uses the same octilinear track in both travel directions', () => {
    const a = { x: -3, y: -3 },
      b = { x: 3, y: 2 };
    expect(trackPoints(a, b)).toEqual(trackPoints(b, a).reverse());
    for (const t of [0.1, 0.3, 0.7, 0.9]) {
      const p = trackPosition(a, b, t),
        q = trackPosition(b, a, 1 - t);
      expect(p.x).toBeCloseTo(q.x);
      expect(p.y).toBeCloseTo(q.y);
    }
  });
  it('starts with distinct destinations, finite resources and deterministic cities', () => {
    const a = createState({ seed: 42 }),
      b = createState({ seed: 42 });
    expect(a.stations.map((p) => p.shape)).toEqual(['circle', 'triangle', 'square']);
    ticks(a, 2500);
    ticks(b, 2500);
    expect(hash(a)).toBe(hash(b));
    expect(a.stations.length).toBeGreaterThan(3);
    expect(a.resources.locomotives).toBe(3);
  });
  it('validates routes atomically and reserves river crossings', () => {
    const s = quiet();
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2, 3] }).ok).toBe(true);
    expect(tunnelsUsed(s)).toBe(1);
    expect(s.resources.locomotives).toBe(2);
    const before = hash(s);
    expect(applyAction(s, { type: 'route', line: 1, stops: [1, 1] }).ok).toBe(false);
    expect(hash(s)).toBe(before);
    s.resources.tunnels = 1;
    const h = hash(s);
    expect(applyAction(s, { type: 'route', line: 1, stops: [1, 3] }).ok).toBe(false);
    expect(hash(s)).toBe(h);
  });
  it('delivers a passenger only at the matching shape, using a transfer', () => {
    const s = quiet();
    station(s, 1).queue = [passenger(s, 'square')];
    s.totalSpawned = 1;
    applyAction(s, { type: 'route', line: 0, stops: [1, 2] });
    applyAction(s, { type: 'route', line: 1, stops: [2, 3] });
    expect(findRoute(s, 1, 'square')?.line).toBe(0);
    let transferred = false;
    for (let i = 0; i < 1000 && s.score < 1; i++) {
      advance(s);
      const p = [
        ...s.stations.flatMap((p) => p.queue),
        ...s.trains.flatMap((t) => t.passengers),
      ][0];
      if (p?.transfers) transferred = true;
      expect(population(s)).toBe(1);
    }
    expect(transferred).toBe(true);
    expect(s.score).toBe(1);
  });
  it('boards the forward loop train even if a reverse train makes the opposite shortcut shorter', () => {
    const s = quiet();
    s.resources.tunnels = 8;
    const [a, b, c] = s.stations;
    a.x = 0; a.y = 0; b.x = 9; b.y = 0; c.x = 1; c.y = 0;
    expect(applyAction(s, { type: 'route', line: 0, stops: [a.id, b.id, c.id], loop: true }).ok).toBe(true);
    const forward = s.trains[0];
    expect(applyAction(s, { type: 'addTrain', line: 0, station: b.id, direction: -1 }).ok).toBe(true);
    forward.from = a.id; forward.direction = 1; forward.dwell = 0;
    const p = passenger(s, c.shape);
    a.queue.push(p);
    advance(s);
    expect(forward.transfer?.passenger.id).toBe(p.id);
    ticks(s, 10);
    expect(forward.passengers.map((r) => r.id)).toContain(p.id);
  });
  it('boards a rider toward the next stop on a one-way loop even when reverse is geographically shorter', () => {
    const s = quiet();
    s.resources.tunnels = 8;
    const [a, b, c] = s.stations;
    a.x = 0; a.y = 0; b.x = 9; b.y = 0; c.x = 1; c.y = 0;
    expect(applyAction(s, { type: 'route', line: 0, stops: [a.id, b.id, c.id], loop: true }).ok).toBe(true);
    const t = s.trains[0];
    t.from = a.id; t.direction = 1; t.dwell = 0;
    const p = passenger(s, c.shape);
    a.queue.push(p);
    advance(s);
    expect(t.transfer?.passenger.id).toBe(p.id);
    ticks(s, 10);
    expect(t.passengers.map((r) => r.id)).toContain(p.id);
  });
  it('does not board unreachable destinations or serve lines without locomotives', () => {
    const s = quiet();
    station(s, 1).queue = [passenger(s, 'star')];
    applyAction(s, { type: 'route', line: 0, stops: [1, 2] });
    ticks(s, 500);
    expect(station(s, 1).queue).toHaveLength(1);
    expect(s.trains[0].passengers).toHaveLength(0);
    s.resources.locomotives = 0;
    applyAction(s, { type: 'route', line: 1, stops: [2, 3] });
    expect(findRoute(s, 1, 'square')).toBeNull();
  });
  it('reverses at endpoints and continuously runs a three-station loop', () => {
    const s = quiet();
    s.resources.tunnels = 8;
    applyAction(s, { type: 'route', line: 0, stops: [1, 2, 3], loop: true });
    const seen = new Set<number>();
    for (let i = 0; i < 1125; i++) {
      advance(s);
      seen.add(s.trains[0].from);
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
    applyAction(s, { type: 'route', line: 0, stops: [1, 2, 3], loop: false });
    ticks(s, 875);
    expect([1, -1]).toContain(s.trains[0].direction);
  });
  it('returns a train from a removed endpoint along the deleted edge before resuming its retained line', () => {
    const s = quiet();
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2, 3] }).ok).toBe(true);
    const t = s.trains[0];
    t.from = 2; t.to = 3; t.progress = 0.5; t.direction = 1; t.dwell = 0;
    const id = t.id;
    const events: import('../src/types').ServiceEvent[] = [];
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2] }).ok).toBe(true);
    expect(t.to).toBe(3);
    for (let i = 0; i < 500 && t.from !== 3; i++) advance(s, event => events.push(event));
    expect(events.slice(-2).map(event => [event.type, event.stationId])).toEqual([['arrive', 3], ['depart', 3]]);
    expect(s.trains.map(train => train.id)).toContain(id);
    expect(t.from).toBe(3);
    expect(t.to).toBe(2);
    expect(t.progress).toBe(0);
    advance(s);
    expect(t.progress).toBeGreaterThan(0);
    for (let i = 0; i < 500 && t.from !== 2; i++) advance(s);
    expect(s.trains.map(train => train.id)).toContain(id);
    expect(t.from).toBe(2);
    expect(s.lines[0].stops).toEqual([1, 2]);
    for (let i = 0; i < 500 && t.to !== 1; i++) advance(s);
    expect(t.to).toBe(1);
    expect(s.resources.locomotives).toBe(2);
  });
  it('retains a deleted edge until the last of two trains clears it', () => {
    const s = quiet();
    expect(applyAction(s, { type: 'route', line: 0, stops: [2, 1, 3] }).ok).toBe(true);
    const first = s.trains[0];
    first.from = 1; first.to = 3; first.progress = 0.75; first.dwell = 0;
    expect(applyAction(s, { type: 'addTrain', line: 0, station: 1 }).ok).toBe(true);
    const second = s.trains[1];
    second.from = 1; second.to = 3; second.progress = 0.2;
    expect(applyAction(s, { type: 'route', line: 0, stops: [2, 1] }).ok).toBe(true);
    expect(tunnelsUsed(s)).toBe(1);
    for (let i = 0; i < 500 && !(first.from === 1 && first.progress === 0 && first.to === null); i++) advance(s);
    // The first train reached the removed endpoint and traversed back while
    // the later train still occupies the same deleted rail.
    expect(first.from).toBe(1);
    expect(first.to).toBeNull();
    expect(second.to).not.toBeNull();
    expect(tunnelsUsed(s)).toBe(1);
    for (let i = 0; i < 500 && second.from !== 1; i++) advance(s);
    expect(s.trains).toHaveLength(2);
    expect(tunnelsUsed(s)).toBe(0);
  });
  it('keeps a removed tunnel reserved through the return and releases it when the last train clears', () => {
    const s = quiet();
    expect(applyAction(s, { type: 'route', line: 0, stops: [2, 1, 3] }).ok).toBe(true);
    const t = s.trains[0];
    t.from = 1; t.to = 3; t.progress = 0.5; t.direction = 1; t.dwell = 0;
    expect(applyAction(s, { type: 'route', line: 0, stops: [2, 1] }).ok).toBe(true);
    expect(tunnelsUsed(s)).toBe(1);
    for (let i = 0; i < 500 && t.from !== 3; i++) advance(s);
    expect(t.to).toBe(1);
    expect(tunnelsUsed(s)).toBe(1);
    for (let i = 0; i < 500 && t.from !== 1; i++) advance(s);
    expect(t.from).toBe(1);
    expect(tunnelsUsed(s)).toBe(0);
  });
  it('unloads passengers at the removed station without retiring the returning train', () => {
    const s = quiet();
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2, 3] }).ok).toBe(true);
    const t = s.trains[0], target = station(s, 3);
    t.from = 2; t.to = 3; t.progress = 0.95; t.passengers = [passenger(s, target.shape), passenger(s, 'triangle')];
    s.totalSpawned = 2;
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2] }).ok).toBe(true);
    for (let i = 0; i < 200 && t.from !== 3; i++) advance(s);
    expect(s.score).toBe(1);
    expect(target.queue).toHaveLength(1);
    expect(target.queue[0].transfers).toBe(1);
    expect(population(s)).toBe(2);
    expect(t.passengers).toHaveLength(0);
    expect(t.to).toBe(2);
    expect(s.resources.locomotives).toBe(2);
  });
  it('replays a public-action endpoint retraction at the same mid-return hash', () => {
    const session = new Session({ seed: 420, mode: 'creative' });
    expect(session.submit({ action: { type: 'route', line: 0, stops: [1, 2, 3] } }).ok).toBe(true);
    let train = session.getState().trains[0];
    for (let i = 0; i < 700 && !(train.to === 3 && train.progress > 0.4); i++) {
      session.step(1);
      train = session.getState().trains[0];
    }
    expect(train.to).toBe(3);
    expect(session.submit({ action: { type: 'route', line: 0, stops: [1, 2] } }).ok).toBe(true);
    for (let i = 0; i < 500 && train.from !== 3; i++) {
      session.step(1);
      train = session.getState().trains[0];
    }
    expect(train.to).toBe(2);
    session.step(45);
    const returning = session.getState();
    expect(returning.trains[0]).toMatchObject({ from: 3, to: 2 });
    expect(returning.trains[0].progress).toBeGreaterThan(0);
    const player = new ReplayPlayer(session.exportReplay());
    expect(hash(player.seek(returning.tick))).toBe(hash(returning));
    player.seek(0);
    expect(hash(player.seek(returning.tick))).toBe(hash(returning));
  });
  it('refuses endpoint retraction in extreme mode without changing a moving train', () => {
    const s = createState({ mode: 'extreme', seed: 42 });
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2, 3] }).ok).toBe(true);
    const t = s.trains[0];
    t.from = 2; t.to = 3; t.progress = 0.5;
    const before = hash(s);
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2] }).ok).toBe(false);
    expect(hash(s)).toBe(before);
  });
  it('retires a returning train only when its surviving line is subsequently deleted', () => {
    const s = quiet();
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2, 3] }).ok).toBe(true);
    const t = s.trains[0];
    t.from = 2; t.to = 3; t.progress = 0.99;
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2] }).ok).toBe(true);
    for (let i = 0; i < 200 && t.from !== 3; i++) advance(s);
    expect(t.to).toBe(2);
    expect(applyAction(s, { type: 'route', line: 0, stops: [] }).ok).toBe(true);
    for (let i = 0; i < 400 && s.trains.length; i++) advance(s);
    expect(s.trains).toHaveLength(0);
    expect(s.resources.locomotives).toBe(3);
  });
  it('retires a train after arrival if its whole line was deleted', () => {
    const s = quiet();
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 3] }).ok).toBe(true);
    const t = s.trains[0];
    t.from = 1; t.to = 3; t.progress = 0.5;
    expect(applyAction(s, { type: 'route', line: 0, stops: [] }).ok).toBe(true);
    for (let i = 0; i < 400 && s.trains.length; i++) advance(s);
    expect(s.trains).toHaveLength(0);
    expect(s.resources.locomotives).toBe(3);
  });
  it('keeps a deleted tunnel occupied until its moving train arrives and preserves passengers', () => {
    const s = quiet();
    applyAction(s, { type: 'route', line: 0, stops: [1, 3] });
    const t = s.trains[0];
    t.dwell = 0;
    station(s, 1).queue = Array.from({ length: 5 }, () => passenger(s, 'square'));
    s.totalSpawned = 5;
    ticks(s, 95);
    expect(t.to).toBe(3);
    expect(t.passengers).toHaveLength(5);
    applyAction(s, { type: 'route', line: 0, stops: [] });
    expect(tunnelsUsed(s)).toBe(1);
    expect(s.resources.locomotives).toBe(2);
    ticks(s, 500);
    expect(tunnelsUsed(s)).toBe(0);
    expect(s.trains).toHaveLength(0);
    expect(s.resources.locomotives).toBe(3);
    expect(population(s)).toBe(5);
    expect(s.score).toBe(5);
  });
  it('enforces capacity and cannot remove a carriage that carries passengers', () => {
    const s = quiet();
    applyAction(s, { type: 'route', line: 0, stops: [1, 2] });
    const t = s.trains[0];
    t.dwell = 0;
    station(s, 1).queue = Array.from({ length: 14 }, () => passenger(s, 'triangle'));
    advance(s);
    expect(t.transfer).toMatchObject({ direction: 'board', progress: 0 });
    ticks(s, 60);
    expect(t.passengers).toHaveLength(6);
    expect(station(s, 1).queue).toHaveLength(8);
    s.resources.carriages = 1;
    expect(applyAction(s, { type: 'carriage', train: t.id, delta: 1 }).ok).toBe(true);
    t.passengers.push(passenger(s, 'triangle'));
    expect(applyAction(s, { type: 'carriage', train: t.id, delta: -1 }).ok).toBe(false);
  });
  it('relocates only after unloading at the next station', () => {
    const s = quiet();
    applyAction(s, { type: 'route', line: 0, stops: [1, 2] });
    applyAction(s, { type: 'route', line: 1, stops: [2, 3] });
    const t = s.trains[0];
    t.dwell = 0;
    station(s, 1).queue = [passenger(s, 'square')];
    ticks(s, 25);
    const from = t.from;
    applyAction(s, { type: 'moveTrain', train: t.id, line: 1, station: 3 });
    expect(t.from).toBe(from);
    expect(t.line).toBe(0);
    ticks(s, 150);
    expect(t.line).toBe(1);
    expect(population(s)).toBe(1);
  });
  it('overcrowding builds above six and recovers below the threshold', () => {
    const s = quiet(),
      p = s.stations[0];
    p.queue = Array.from({ length: 7 }, () => passenger(s, 'square'));
    ticks(s, 100);
    expect(p.crowd).toBe(100);
    p.queue.pop();
    ticks(s, 20);
    expect(p.crowd).toBe(60);
    p.queue.push(passenger(s, 'square'));
    ticks(s, RULES.crowdTicks - 60);
    expect(s.phase).toBe('over');
    expect(s.lostStation).toBe(p.id);
  });
  it('offers weekly supply and halts until a valid choice', () => {
    const s = quiet();
    s.elapsed = RULES.weekTicks - 1;
    advance(s);
    expect(s.phase).toBe('upgrade');
    expect(s.resources.locomotives).toBe(4);
    const before = hash(s);
    advance(s);
    expect(hash(s)).toBe(before);
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2] }).ok).toBe(false);
    expect(applyAction(s, { type: 'upgrade', choice: s.upgrades[0] }).ok).toBe(true);
    expect(s.phase).toBe('playing');
  });
  it('reconstructs a mid-transfer state at the same tick during replay', () => {
    const session = new Session({ mode: 'creative', seed: 19 });
    const [a, b] = session.getState().stations;
    expect(session.submit({ action: { type: 'route', line: 0, stops: [a.id, b.id] } }).ok).toBe(true);
    // Use natural spawning to ensure the rider and its route are recorded deterministically.
    for (let i = 0; i < 3000 && !session.getState().trains.some((t) => t.transfer); i++) session.step(1);
    const snapshot = session.getState();
    expect(snapshot.trains.some((t) => t.transfer)).toBe(true);
    const replay = session.exportReplay();
    const player = new ReplayPlayer(replay);
    expect(player.seek(snapshot.tick)).toEqual(snapshot);
  });
  it('rejects old rules-2 replays instead of silently applying changed transfer timing', () => {
    const session = new Session({ seed: 13 });
    expect(session.exportReplay().format).toBe('orchard-metro.replay.v7');
    const old = { ...session.exportReplay(), format: 'orchard-metro.replay.v2' };
    expect(() => new ReplayPlayer(old as import('../src/types').Replay)).toThrow(/录像结构不合法/);
  });
  it('rejects an old rules-1 replay after the boarding rules change', () => {
    const s = new Session({ seed: 13 });
    expect(s.getState().version).toBe('orchard-metro.rules.7');
    expect(s.exportReplay().format).toBe('orchard-metro.replay.v7');
    const legacy = { ...s.exportReplay(), format: 'orchard-metro.replay.v1' };
    expect(() => new ReplayPlayer(legacy as unknown as import('../src/types').Replay)).toThrow();
  });
  it('supports endless survival, restricted extreme editing, and creative land placement', () => {
    const s = quiet();
    s.mode = 'endless';
    s.stations[0].queue = Array.from({ length: 7 }, () => passenger(s, 'square'));
    ticks(s, 2500);
    expect(s.phase).toBe('playing');
    s.mode = 'extreme';
    applyAction(s, { type: 'route', line: 0, stops: [1, 2] });
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 3, 2] }).ok).toBe(false);
    expect(applyAction(s, { type: 'route', line: 0, stops: [1, 2, 3] }).ok).toBe(true);
    const c = createState({ mode: 'creative' });
    expect(applyAction(c, { type: 'station', x: -10, y: -5, shape: 'star' }).ok).toBe(true);
    expect(applyAction(c, { type: 'station', x: 0, y: 0, shape: 'star' }).ok).toBe(false);
  });
  it('conserves all generated passengers throughout a baseline game', () => {
    const s = createState({ seed: 420 });
    for (let i = 0; i < 12500 && s.phase !== 'over'; i++) {
      if (i % 200 === 0 || s.phase === 'upgrade')
        applyAction(
          s,
          dispatcherPolicy({
            protocol: 'orchard-metro.agent.v1',
            tick: s.tick,
            state: copy(s),
            budget: {
              freeTunnels: s.resources.tunnels - tunnelsUsed(s),
              trainCapacity: 6,
              crowdLimit: 6,
              tickSeconds: 1 / RULES.hz,
            },
          }).action,
        );
      advance(s);
      expect(population(s)).toBe(s.totalSpawned);
      expect(s.resources.locomotives).toBeGreaterThanOrEqual(0);
      expect(tunnelsUsed(s)).toBeLessThanOrEqual(s.resources.tunnels);
    }
    expect(s.score).toBeGreaterThan(50);
    expect(s.week).toBeGreaterThan(1);
  });
});

describe('recording, re-simulation and agent boundaries', () => {
  it('reconstructs exact observations between multiple operations at the same tick', () => {
    const game = new Session();
    const before = game.getState();
    game.submit({ action: { type: 'route', line: 0, stops: [1, 2, 3] }, reason: 'connect' });
    const mid = game.getState();
    game.submit({ action: { type: 'addTrain', line: 0 } });
    game.step(800);
    game.submit({ action: { type: 'carriage', train: 999, delta: 1 }, reason: 'invalid target' });
    const r = game.exportReplay(),
      p = new ReplayPlayer(r);
    expect(hash(p.seek(800))).toBe(hash(game.getState()));
    expect(p.observationAtDecision(0).state).toEqual(before);
    expect(p.observationAtDecision(1).state).toEqual(mid);
    expect(p.seek(0).trains).toHaveLength(2);
    expect(r.decisions[2].result.ok).toBe(false);
  });
  it('rejects modified actions, observations, checkpoints, final hashes and versions', () => {
    const game = new Session();
    game.submit({ action: { type: 'route', line: 0, stops: [1, 2, 3] } });
    game.step(1600);
    const r = game.exportReplay();
    for (const change of [
      (r: ReturnType<Session['exportReplay']>) => {
        r.decisions[0].action = { type: 'wait' };
      },
      (r: ReturnType<Session['exportReplay']>) => {
        r.decisions[0].observationHash = 'bad';
      },
      (r: ReturnType<Session['exportReplay']>) => {
        r.checkpoints[1].state.score++;
      },
      (r: ReturnType<Session['exportReplay']>) => {
        r.finalHash = 'bad';
      },
    ]) {
      const modified = copy(r);
      change(modified);
      expect(() => new ReplayPlayer(modified)).toThrow();
    }
    expect(() => new ReplayPlayer('{}')).toThrow();
    const missing = copy(r);
    missing.checkpoints.shift();
    expect(() => new ReplayPlayer(missing)).toThrow('初始检查点');
    const metadata = copy(r);
    metadata.createdAt = 'invalid';
    expect(() => new ReplayPlayer(metadata)).toThrow('结构');
    const immutable = new ReplayPlayer(r);
    expect(() => {
      immutable.replay.decisions[0].tick = 99;
    }).toThrow();
  });
  it('round-trips a complete agent run across weekly pauses and game over', async () => {
    const result = await runAgent({ seed: 420, maxTicks: 24000 });
    const p = new ReplayPlayer(result.replay);
    expect(hash(p.getState())).toBe(result.replay.finalHash);
    expect(result.errors).toBe(0);
    expect(p.getState().score).toBeGreaterThan(100);
    expect(result.reason).toBe('over');
    for (const i of [
      0,
      Math.floor(result.replay.decisions.length / 2),
      result.replay.decisions.length - 1,
    ])
      expect(hash(p.observationAtDecision(i).state)).toBe(
        result.replay.decisions[i].observationHash,
      );
  }, 30000);
  it('aborts non-cooperating policies, rejects malformed results and stops stalled upgrades', async () => {
    const observation = new Session().observe();
    await expect(decide(() => new Promise(() => {}), observation, 10)).rejects.toThrow('超时');
    const c = new AbortController();
    c.abort(new Error('cancelled'));
    await expect(
      decide(() => ({ action: { type: 'wait' } }), observation, 100, c.signal),
    ).rejects.toThrow('cancelled');
    await expect(
      decide(
        () => ({ action: { type: 'upgrade', choice: 'invalid' as 'line' } }),
        observation,
        100,
      ),
    ).rejects.toThrow();
    const run = await runAgent({
      mode: 'endless',
      maxTicks: 5000,
      interval: 600,
      policy: () => ({ action: { type: 'wait' } }),
    });
    expect(run.reason).toBe('waiting-for-upgrade');
    expect(run.replay.duration).toBe(RULES.weekTicks);
  });
});
