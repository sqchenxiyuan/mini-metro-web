import { describe, expect, it } from 'vitest';
import { Session } from '../src/session';
import { hash } from '../src/rules';

describe('session transient service events', () => {
  it('bounds visual history to a finite recent window after a long headless run', () => {
    const session = new Session({ seed: 412, mode: 'creative' });
    const [a,b] = session.getState().stations;
    session.submit({ action: { type: 'route', line: 0, stops: [a.id,b.id] } });
    session.submit({ action: { type: 'addTrain', line: 0, station: a.id } });
    session.step(12000);
    const events = session.drainServiceEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(128);
    expect(events.every((event) => event.tick >= session.tick - 8)).toBe(true);
  });
  it('keeps a service burst beyond 128 passengers until the consumer drains it', () => {
    const session = new Session({ seed: 412, mode: 'creative' });
    const state = session.getState();
    const [a, b] = state.stations;
    session.submit({ action: { type: 'route', line: 0, stops: [a.id, b.id] } });
    // Twenty-four trains × six delivered riders in one step exceeds the old 128-item ring.
    for (let i = 0; i < 24; i++) session.submit({ action: { type: 'addTrain', line: 0, station: a.id } });
    const raw = session as unknown as { state: typeof state };
    raw.state.trains.forEach((train, index) => {
      train.dwell = 0;
      train.passengers = Array.from({ length: 6 }, (_, n) => ({
        id: 10000 + index * 6 + n, shape: a.shape, born: 0, transfers: 0,
      }));
    });
    session.step(1);
    const events = session.drainServiceEvents();
    expect(events.filter((event) => event.type === 'deliver')).toHaveLength(144);
    expect(session.drainServiceEvents()).toEqual([]);
  });
  it('exposes actual events across multiple stepped ticks, consumes them once and preserves replay state', () => {
    const session = new Session({ seed: 412, mode: 'creative' });
    const initial = session.getState();
    const [a, b] = initial.stations;
    expect(session.submit({ action: { type: 'route', line: 0, stops: [a.id, b.id] } }).ok).toBe(true);
    expect(session.submit({ action: { type: 'addTrain', line: 0, station: a.id } }).ok).toBe(true);
    session.step(6);
    const events = session.drainServiceEvents();
    expect(events.some((event) => event.type === 'depart' && event.stationId === a.id)).toBe(true);
    session.step(100);
    expect(session.drainServiceEvents().every((event) => event.tick >= session.tick - 7)).toBe(true);
    expect(session.drainServiceEvents()).toEqual([]);
    expect(hash(session.getState())).toBe(session.exportReplay().finalHash);
  });
});
