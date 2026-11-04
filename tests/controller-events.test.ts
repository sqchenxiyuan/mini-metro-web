import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('requestAnimationFrame', () => 1);
vi.stubGlobal('cancelAnimationFrame', () => {});
import { MetroController } from '../src/browser';
import { createState, hash } from '../src/rules';

describe('controller visual event boundary', () => {
  it('does not leak live events while inspecting a replay, then restarting', () => {
    const state = createState({ mode: 'creative', seed: 77 });
    const [a, b] = state.stations;
    const controller = new MetroController({ mode: 'creative', seed: 77 });
    controller.submit({ action: { type: 'route', line: 0, stops: [a.id, b.id] } });
    controller.submit({ action: { type: 'addTrain', line: 0, station: a.id } });
    controller.step(50);
    expect(controller.drainServiceEvents().length).toBeGreaterThan(0);
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
