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
    s.trains.reduce((n, t) => n + t.passengers.length, 0)
  );
}

describe('transport rules', () => {
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
    ticks(a, 1000);
    ticks(b, 1000);
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
    for (let i = 0; i < 450; i++) {
      advance(s);
      seen.add(s.trains[0].from);
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
    applyAction(s, { type: 'route', line: 0, stops: [1, 2, 3], loop: false });
    ticks(s, 350);
    expect([1, -1]).toContain(s.trains[0].direction);
  });
  it('keeps a deleted tunnel occupied until its moving train arrives and preserves passengers', () => {
    const s = quiet();
    applyAction(s, { type: 'route', line: 0, stops: [1, 3] });
    const t = s.trains[0];
    t.dwell = 0;
    station(s, 1).queue = Array.from({ length: 5 }, () => passenger(s, 'square'));
    s.totalSpawned = 5;
    ticks(s, 25);
    expect(t.to).toBe(3);
    expect(t.passengers).toHaveLength(5);
    applyAction(s, { type: 'route', line: 0, stops: [] });
    expect(tunnelsUsed(s)).toBe(1);
    expect(s.resources.locomotives).toBe(2);
    ticks(s, 200);
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
    expect(t.passengers).toHaveLength(1);
    ticks(s, 10);
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
    ticks(s, 10);
    const from = t.from;
    applyAction(s, { type: 'moveTrain', train: t.id, line: 1, station: 3 });
    expect(t.from).toBe(from);
    expect(t.line).toBe(0);
    ticks(s, 60);
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
    ticks(s, 840);
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
  it('rejects an old rules-1 replay after the boarding rules change', () => {
    const s = new Session({ seed: 13 });
    expect(s.getState().version).toBe('orchard-metro.rules.2');
    expect(s.exportReplay().format).toBe('orchard-metro.replay.v2');
    const legacy = { ...s.exportReplay(), format: 'orchard-metro.replay.v1' };
    expect(() => new ReplayPlayer(legacy as unknown as import('../src/types').Replay)).toThrow();
  });
  it('supports endless survival, restricted extreme editing, and creative land placement', () => {
    const s = quiet();
    s.mode = 'endless';
    s.stations[0].queue = Array.from({ length: 7 }, () => passenger(s, 'square'));
    ticks(s, 1000);
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
    for (let i = 0; i < 5000 && s.phase !== 'over'; i++) {
      if (i % 80 === 0 || s.phase === 'upgrade')
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
              tickSeconds: 0.05,
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
    game.step(650);
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
    expect(run.replay.duration).toBe(1680);
  });
});
