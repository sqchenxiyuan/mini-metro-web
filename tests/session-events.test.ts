import { describe, expect, it } from 'vitest';
import { Session } from '../src/session';
import { hash } from '../src/rules';

describe('session transient service events', () => {
  it('exposes actual events across multiple stepped ticks, consumes them once and preserves replay state', () => {
    const session = new Session({ seed: 412, mode: 'creative' });
    const initial = session.getState();
    const [a, b] = initial.stations;
    expect(session.submit({ action: { type: 'route', line: 0, stops: [a.id, b.id] } }).ok).toBe(true);
    expect(session.submit({ action: { type: 'addTrain', line: 0, station: a.id } }).ok).toBe(true);
    session.step(6);
    const events = session.drainServiceEvents();
    expect(events.some((event) => event.type === 'depart' && event.stationId === a.id)).toBe(true);
    session.step(200);
    expect(session.drainServiceEvents().some((event) => event.type === 'arrive' && event.stationId === b.id)).toBe(true);
    expect(session.drainServiceEvents()).toEqual([]);
    expect(hash(session.getState())).toBe(session.exportReplay().finalHash);
  });
});
