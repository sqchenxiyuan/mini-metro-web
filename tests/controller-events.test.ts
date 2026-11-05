import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('requestAnimationFrame', () => 1);
vi.stubGlobal('cancelAnimationFrame', () => {});
import { MetroController } from '../src/browser';
import { createState, hash } from '../src/rules';

describe('controller visual event boundary', () => {
  it('retains the visual previous/current pair through a no-tick frame and resets after multiple ticks', () => {
    let frame: ((now: number) => void) | undefined;
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => { frame = cb; return 1; });
    const controller = new MetroController({ seed: 420, mode: 'creative' });
    controller.submit({ action: { type: 'route', line: 0, stops: [1, 2, 3] } });
    controller.step(10);
    controller.setPaused(false);
    frame!(1000);
    frame!(1050);
    const currentTick = controller.getState().tick;
    frame!(1075);
    expect(controller.getState().tick).toBe(currentTick);
    expect(controller.motion.previous?.tick).toBe(currentTick - 1);
    frame!(1225);
    expect(controller.getState().tick).toBeGreaterThan(currentTick + 1);
    expect(controller.motion.previous).toBeNull();
    controller.dispose();
  });
  it('provides previous/current train progress across render frames without changing rule ticks', () => {
    let frame: ((now: number) => void) | undefined;
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => { frame = cb; return 1; });
    const controller = new MetroController({ seed: 420, mode: 'creative' });
    expect(controller.submit({ action: { type: 'route', line: 0, stops: [1, 2, 3] } }).ok).toBe(true);
    controller.step(10);
    expect(controller.getState().trains[0].to).not.toBeNull();
    controller.setPaused(false);
    frame!(1000); // initialize wall-time clock
    frame!(1050); // one authoritative tick
    const current = controller.getState(), previous = controller.motion.previous;
    expect(previous?.tick).toBe(current.tick - 1);
    expect(previous?.trains[0].progress).toBeLessThan(current.trains[0].progress);
    const hashAtTick = hash(current);
    frame!(1075); // halfway to the next authoritative tick
    expect(controller.getState().tick).toBe(current.tick);
    expect(controller.motion.alpha).toBeCloseTo(0.5);
    expect(hash(controller.getState())).toBe(hashAtTick);
    controller.setPaused(true);
    expect(controller.motion.previous).toBeNull();
    controller.dispose();
  });
  it('does not leak live events while inspecting a replay, then restarting', () => {
    const state = createState({ mode: 'creative', seed: 77 });
    const [a, b] = state.stations;
    const controller = new MetroController({ mode: 'creative', seed: 77 });
    controller.submit({ action: { type: 'route', line: 0, stops: [a.id, b.id] } });
    controller.submit({ action: { type: 'addTrain', line: 0, station: a.id } });
    controller.step(7);
    expect(controller.drainServiceEvents().length).toBeGreaterThan(0);
    controller.step(43);
    const replay = controller.exportReplay();
    controller.step(50);
    controller.loadReplay(replay);
    expect(controller.drainServiceEvents()).toEqual([]);
    controller.restart({ mode: 'creative', seed: 77 });
    expect(controller.drainServiceEvents()).toEqual([]);
    expect(hash(controller.getState())).toBe(hash(state));
    controller.dispose();
  });
});
