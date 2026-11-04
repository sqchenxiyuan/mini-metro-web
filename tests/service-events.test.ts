// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { advance, applyAction, copy, createState, hash, station } from '../src/rules';
import type { Passenger, ServiceEvent, State } from '../src/types';

function quiet(): State {
  const s = createState();
  s.nextStation = 1e8;
  for (const p of s.stations) p.nextPassenger = 1e8;
  return s;
}
function passenger(s: State, shape: Passenger['shape']): Passenger {
  return { id: s.nextId++, shape, born: s.elapsed, transfers: 0 };
}
function route(s: State, line: number, stops: number[]): void {
  expect(applyAction(s, { type: 'route', line, stops }).ok).toBe(true);
}

describe('per-tick passenger service events', () => {
  it('reports real boarding before departure with station and train identity', () => {
    const s = quiet();
    route(s, 0, [1, 2]);
    const train = s.trains[0];
    train.dwell = 0;
    const p = passenger(s, 'triangle');
    station(s, 1).queue.push(p);
    const events: ServiceEvent[] = [];

    expect(advance(s, (event) => events.push(event))).toBe(true);
    expect(events).toEqual([
      { type: 'board', tick: 1, sequence: 0, stationId: 1, trainId: train.id, lineId: 0, passengerId: p.id, shape: 'triangle' },
    ]);
    expect(train.passengers.map((r) => r.id)).toEqual([p.id]);
    expect(station(s, 1).queue).toEqual([]);
    for (let i = 0; i < 7; i++) advance(s, (event) => events.push(event));
    expect(events.at(-1)).toEqual({ type: 'depart', tick: 8, sequence: 0,
      stationId: 1, trainId: train.id, lineId: 0, passengerId: null, shape: null });
  });

  it('orders arrival, transfer-out, delivery and boarding across trains in one tick', () => {
    const s = quiet();
    route(s, 0, [1, 2]);
    route(s, 1, [2, 3]);
    const [first, second] = s.trains;
    const transfer = passenger(s, 'square');
    const delivered = passenger(s, 'triangle');
    const returnTrip = passenger(s, 'circle');
    first.passengers = [transfer, delivered];
    first.to = 2;
    first.progress = 0.999;
    second.dwell = 0;
    station(s, 2).queue.push(returnTrip);
    const events: ServiceEvent[] = [];

    advance(s, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'arrive', tick: 1, sequence: 0, stationId: 2, trainId: first.id, lineId: 0, passengerId: null, shape: null },
      { type: 'transferOut', tick: 1, sequence: 1, stationId: 2, trainId: first.id, lineId: 0, passengerId: transfer.id, shape: 'square' },
      { type: 'deliver', tick: 1, sequence: 2, stationId: 2, trainId: first.id, lineId: 0, passengerId: delivered.id, shape: 'triangle' },
      { type: 'board', tick: 1, sequence: 3, stationId: 2, trainId: first.id, lineId: 0, passengerId: returnTrip.id, shape: 'circle' },
      { type: 'board', tick: 1, sequence: 4, stationId: 2, trainId: second.id, lineId: 1, passengerId: transfer.id, shape: 'square' },
    ]);
    expect(transfer.transfers).toBe(1);
    expect(s.score).toBe(1);
    expect(station(s, 2).queue).toEqual([]);
    expect(first.passengers).toEqual([returnTrip]);
    expect(second.passengers).toEqual([transfer]);
  });

  it('preserves tick-local ordering when collecting many ticks and suppresses paused ticks', () => {
    const s = quiet();
    route(s, 0, [1, 2]);
    const train = s.trains[0];
    train.dwell = 0;
    const p = passenger(s, 'triangle');
    station(s, 1).queue.push(p);
    const events: ServiceEvent[] = [];
    for (let i = 0; i < 110; i++) advance(s, (event) => events.push(event));
    expect(events.slice(0, 5).map(({ type, tick, sequence }) => [type, tick, sequence])).toEqual([
      ['board', 1, 0], ['depart', 8, 0], ['arrive', expect.any(Number), 0],
      ['deliver', expect.any(Number), 1], ['depart', expect.any(Number), 0],
    ]);
    expect(events[2].tick).toBe(events[3].tick);
    expect(events[4].tick).toBeGreaterThan(events[3].tick);
    expect(events.slice(5).map(({ type, tick, sequence }) => [type, tick, sequence])).toEqual([
      ['arrive', expect.any(Number), 0], ['depart', expect.any(Number), 0],
    ]);
    expect(events[3]).toMatchObject({ stationId: 2, passengerId: p.id, shape: 'triangle', lineId: 0, trainId: train.id });
    s.phase = 'upgrade';
    const previous = events.length;
    expect(advance(s, (event) => events.push(event))).toBe(false);
    expect(events).toHaveLength(previous);
  });

  it('leaves state, RNG, score and hash identical with or without an observer', () => {
    const observed = createState({ seed: 1234 });
    route(observed, 0, [1, 2]);
    route(observed, 1, [2, 3]);
    const unobserved = copy(observed);
    const events: ServiceEvent[] = [];
    for (let i = 0; i < 700; i++) {
      expect(advance(observed, (event) => events.push(event))).toBe(advance(unobserved));
      expect(hash(observed)).toBe(hash(unobserved));
      expect(observed).toEqual(unobserved);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(observed.rng).toBe(unobserved.rng);
    expect(observed.score).toBe(unobserved.score);
    expect(Object.keys(observed)).toEqual(Object.keys(unobserved));
    expect(JSON.stringify(observed)).not.toContain('serviceEvents');
  });

  it('reports forced unload on retirement without inventing a departure', () => {
    const s = quiet();
    route(s, 0, [1, 2]);
    const train = s.trains[0];
    const delivered = passenger(s, 'triangle');
    const transferred = passenger(s, 'square');
    train.passengers = [delivered, transferred];
    train.to = 2;
    train.progress = 0.999;
    train.retiring = true;
    const events: ServiceEvent[] = [];

    advance(s, (event) => events.push(event));

    expect(events.map((event) => [event.type, event.tick, event.sequence, event.stationId,
      event.trainId, event.lineId, event.passengerId, event.shape])).toEqual([
      ['arrive', 1, 0, 2, train.id, 0, null, null],
      ['deliver', 1, 1, 2, train.id, 0, delivered.id, 'triangle'],
      ['transferOut', 1, 2, 2, train.id, 0, transferred.id, 'square'],
    ]);
    expect(s.trains).toEqual([]);
    expect(station(s, 2).queue.map((p) => p.id)).toEqual([transferred.id]);
    expect(s.score).toBe(1);
  });
});
