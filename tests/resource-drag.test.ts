import { describe, expect, it } from 'vitest';
import { applyAction, createState, hash } from '../src/rules';
import { ResourceDrag, type ResourceGeometry } from '../src/resource-drag';

const geometry: ResourceGeometry = {
  railAt: p => p.y === 50 ? { line: 0, edge: 1 } : null,
  stationPoint: id => ({ x: id === 1 ? 0 : id === 2 ? 100 : 200, y: 50 }),
  trainPoint: () => ({ x: 40, y: 50 }),
  contains: () => true,
};
function fixture() {
  const state = createState({ mode: 'creative' });
  applyAction(state, { type: 'route', line: 0, stops: [1,2,3] });
  const actions: unknown[] = [];
  const drag = new ResourceDrag({ state: () => state, replay: () => false, geometry,
    commit: action => { actions.push(action); return applyAction(state, action).ok; } });
  return { state, actions, drag };
}
describe('direct inventory placement', () => {
  it('previews the existing on-route station without spending, then consumes one locomotive only on release', () => {
    const { state, actions, drag } = fixture(), before = hash(state), stock = state.resources.locomotives;
    expect(drag.begin('locomotive')).toBe(true);
    const preview = drag.move({ x: 30, y: 50 });
    expect(preview?.action).toEqual({ type: 'addTrain', line: 0, station: 1, direction: 1 });
    expect(hash(state)).toBe(before); expect(actions).toEqual([]);
    expect(drag.release({ x: 30, y: 50 })).toBe(true);
    expect(state.resources.locomotives).toBe(stock - 1);
    expect(state.trains.at(-1)?.from).toBe(1);
    expect(actions).toHaveLength(1);
  });
  it('targets the visible train core for a carriage, not the badge or first train in a line', () => {
    const { state, actions } = fixture();
    applyAction(state, { type: 'addTrain', line: 0, station: 3 });
    const second = state.trains[1].id;
    const drag = new ResourceDrag({ state: () => state, replay: () => false,
      geometry: { ...geometry, railAt: () => null, trainPoint: id => ({ x: id === second ? 160 : 40, y: 60 }) },
      commit: action => { actions.push(action); return applyAction(state, action).ok; } });
    drag.begin('carriage');
    expect(drag.move({ x: 160, y: 60 })?.action).toEqual({ type: 'carriage', train: second, delta: 1 });
    expect(drag.release({ x: 160, y: 60 })).toBe(true);
    expect(state.trains[0].carriages).toBe(0); expect(state.trains[1].carriages).toBe(1);
  });
  it('uses the last meaningful movement along the rail for an interior station direction', () => {
    const { drag } = fixture();
    drag.begin('locomotive');
    drag.move({ x: 135, y: 50 });
    expect(drag.move({ x: 110, y: 50 })?.action).toEqual({ type: 'addTrain', line: 0, station: 2, direction: -1 });
    expect(drag.move({ x: 110, y: 50 })?.direction).toBe(-1);
  });
  it.each(['upgrade','over'] as const)('does not submit after playing changes to %s while held', phase => {
    const { state, actions, drag } = fixture(); drag.begin('locomotive'); drag.move({ x: 30, y: 50 });
    state.phase = phase; const before = hash(state);
    expect(drag.release({ x: 30, y: 50 })).toBe(false); expect(hash(state)).toBe(before); expect(actions).toEqual([]);
  });
  it('does not submit when the stock was spent externally while held', () => {
    const { state, actions, drag } = fixture(); drag.begin('locomotive'); drag.move({ x: 30, y: 50 });
    state.resources.locomotives = 0; const before = hash(state);
    expect(drag.release({ x: 30, y: 50 })).toBe(false); expect(hash(state)).toBe(before); expect(actions).toEqual([]);
  });
  it('re-evaluates moving train cores on release rather than retaining the hovered train', () => {
    const { state, actions } = fixture(); applyAction(state, { type: 'addTrain', line: 0, station: 3 });
    let moved = false;
    const drag = new ResourceDrag({ state: () => state, replay: () => false,
      geometry: { ...geometry, railAt: () => null, trainPoint: id => ({ x: (id === state.trains[0].id) !== moved ? 40 : 160, y: 60 }) },
      commit: action => { actions.push(action); return applyAction(state, action).ok; } });
    drag.begin('carriage'); drag.move({ x: 40, y: 60 }); moved = true;
    expect(drag.release({ x: 40, y: 60 })).toBe(true); expect(state.trains[0].carriages).toBe(0); expect(state.trains[1].carriages).toBe(1);
  });
  it('does not use an unavailable train core as a route shortcut', () => {
    const { state, drag, actions } = fixture(); state.trains[0].retiring = true;
    drag.begin('carriage'); expect(drag.release({ x: 40, y: 50 })).toBe(false); expect(actions).toEqual([]);
  });
  it('does not leave an old resource armed after a new begin fails', () => {
    const { state, drag, actions } = fixture(); drag.begin('locomotive'); drag.move({ x: 30, y: 50 });
    state.resources.carriages = 0; expect(drag.begin('carriage')).toBe(false);
    expect(drag.release({ x: 30, y: 50 })).toBe(false); expect(actions).toEqual([]);
  });
  it('allows an explicit keyboard station target even away from the rail hit surface', () => {
    const { state, actions } = fixture();
    const drag = new ResourceDrag({ state: () => state, replay: () => false,
      geometry: { ...geometry, railAt: () => null },
      commit: action => { actions.push(action); return applyAction(state, action).ok; } });
    drag.begin('locomotive');
    expect(drag.move({ x: 100, y: 50 }, { line: 0, station: 2 })?.action).toEqual({ type: 'addTrain', line: 0, station: 2, direction: 1 });
    expect(drag.release({ x: 100, y: 50 }, { line: 0, station: 2 })).toBe(true);
  });
  it('keeps an explicit missing keyboard train invalid instead of falling back to another train', () => {
    const { drag, actions } = fixture(); drag.begin('carriage');
    expect(drag.release({ x: 40, y: 50 }, { line: 0, train: 999 })).toBe(false);
    expect(actions).toEqual([]);
  });
  it('does not arm in replay or with zero stock', () => {
    const { state, actions } = fixture();
    const drag = new ResourceDrag({ state: () => state, replay: () => true, geometry,
      commit: action => { actions.push(action); return applyAction(state, action).ok; } });
    const before = hash(state); expect(drag.begin('locomotive')).toBe(false);
    expect(drag.release({ x: 40, y: 50 })).toBe(false); expect(hash(state)).toBe(before); expect(actions).toEqual([]);
  });
  it.each(['retiring','moveTo','full'] as const)('rejects a %s train without falling through to a line target', unavailable => {
    const { state, drag, actions } = fixture(), train = state.trains[0];
    if(unavailable==='retiring') train.retiring=true;
    if(unavailable==='moveTo') train.moveTo={line:0,station:2};
    if(unavailable==='full') train.carriages=3;
    const before=hash(state); drag.begin('carriage'); expect(drag.release({x:40,y:50})).toBe(false);
    expect(hash(state)).toBe(before); expect(actions).toEqual([]);
  });
  it('cancel clears placement so later release cannot dispatch', () => {
    const { drag, actions } = fixture(); drag.begin('locomotive'); drag.move({x:40,y:50}); drag.cancel();
    expect(drag.kind).toBe(null); expect(drag.preview).toBe(null); expect(drag.release({x:40,y:50})).toBe(false); expect(actions).toEqual([]);
  });
  it('uses the local painted bend tangent rather than the station-to-station chord for direction', () => {
    const { state, actions } = fixture();
    const drag = new ResourceDrag({state:()=>state,replay:()=>false,geometry:{...geometry,railAt:()=>({line:0,edge:1}),railVector:()=>({x:0,y:1})},
      commit:action=>{actions.push(action);return applyAction(state,action).ok;}});
    drag.begin('locomotive'); drag.move({x:110,y:50});
    expect(drag.move({x:110,y:48})?.action).toEqual({type:'addTrain',line:0,station:2,direction:-1});
  });
  it('rejects a route changed after hover without calling the submission boundary', () => {
    const { state, actions, drag } = fixture();
    drag.begin('locomotive'); drag.move({ x: 30, y: 50 });
    applyAction(state, { type: 'route', line: 0, stops: [1,3,2] });
    const before = hash(state);
    expect(drag.release({ x: 30, y: 50 })).toBe(false);
    expect(hash(state)).toBe(before); expect(actions).toEqual([]);
  });
});
