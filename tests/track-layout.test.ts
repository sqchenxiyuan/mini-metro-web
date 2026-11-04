import { describe, expect, it } from 'vitest';
import { createState } from '../src/rules';
import { deriveTrackLayout } from '../src/track-layout';

function fixture(coords: [number, number][], routes: number[][]) {
  const state = createState();
  state.stations = coords.map(([x, y], id) => ({ ...state.stations[0], id: id + 10, x, y, queue: [] }));
  state.lines = routes.map((stops, id) => ({ id, stops, loop: false }));
  return state;
}

describe('visual track layout', () => {
  it('creates one physical group and one centered lane for a route', () => {
    const layout = deriveTrackLayout(fixture([[0, 0], [4, 0]], [[10, 11]]));
    expect(layout.segments).toHaveLength(1);
    expect(layout.segments[0]).toMatchObject({ from: 10, to: 11, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }], lanes: [{ lineId: 0, offset: 0 }] });
  });

  it('puts two shared lines edge-to-edge with one group underlay, regardless of route order', () => {
    const state = fixture([[0, 0], [4, 0]], [[10, 11], [11, 10]]);
    state.lines[0].id = 5;
    state.lines[1].id = 2;
    const [pair] = deriveTrackLayout(state).segments;
    expect(pair).toMatchObject({
      from: 10, to: 11,
      lanes: [{ lineId: 2, offset: -0.105 }, { lineId: 5, offset: 0.105 }],
      underlayRadius: 0.255,
    });
    expect(deriveTrackLayout({ ...state, lines: [...state.lines].reverse() })).toEqual(deriveTrackLayout(state));
  });

  it('uses exactly seven touching rails for seven lines, even when a line has reverse service', () => {
    const state = fixture([[0, 0], [4, 0]], Array.from({ length: 7 }, (_, id) => id % 2 ? [11, 10] : [10, 11]));
    state.trains = [{ id: 42, line: 0, from: 11, to: 10, progress: 0.5, direction: -1, dwell: 0, passengers: [], carriages: 0, retiring: false, moveTo: null }];
    const [segment] = deriveTrackLayout(state).segments;
    expect(segment.lanes.map((lane) => lane.lineId)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(segment.lanes.map((lane) => Number(lane.offset.toFixed(3)))).toEqual([-0.63, -0.42, -0.21, 0, 0.21, 0.42, 0.63]);
    expect(segment.underlayRadius).toBeCloseTo(0.78);
    expect(deriveTrackLayout({ ...state, trains: [] })).toEqual(deriveTrackLayout(state));
  });

  it('keeps neighboring arcs distinct while grouping equal departure tangents at a station', () => {
    const state = fixture([[0, 0], [4, 1], [5, 2]], [[10, 11], [10, 12]]);
    const layout = deriveTrackLayout(state);
    expect(layout.segments.map(({ from, to }) => [from, to])).toEqual([[10, 11], [10, 12]]);
    expect(layout.approaches.filter((approach) => approach.stationId === 10)).toEqual([{
      stationId: 10, sector: 0, tangent: { x: 1, y: 0 }, underlayRadius: 0.255,
      lanes: [
        { lineId: 0, neighborId: 11, offset: -0.105 },
        { lineId: 1, neighborId: 12, offset: 0.105 },
      ],
    }]);
  });

  it('separates approaches in different departure sectors', () => {
    const state = fixture([[0, 0], [4, 1], [1, 4]], [[10, 11], [10, 12]]);
    const origin = deriveTrackLayout(state).approaches.filter(({ stationId }) => stationId === 10);
    expect(origin).toEqual([
      { stationId: 10, sector: 0, tangent: { x: 1, y: 0 }, lanes: [{ lineId: 0, neighborId: 11, offset: 0 }], underlayRadius: 0.15 },
      { stationId: 10, sector: 2, tangent: { x: 0, y: 1 }, lanes: [{ lineId: 1, neighborId: 12, offset: 0 }], underlayRadius: 0.15 },
    ]);
  });

  it('mirrors lane offsets at the far station to preserve physical color order', () => {
    const state = fixture([[0, 0], [4, 0]], [[10, 11], [11, 10]]);
    const layout = deriveTrackLayout(state);
    expect(layout.approaches.find(({ stationId }) => stationId === 10)?.lanes.map(({ offset }) => offset)).toEqual([-0.105, 0.105]);
    expect(layout.approaches.find(({ stationId }) => stationId === 11)?.lanes.map(({ offset }) => offset)).toEqual([0.105, -0.105]);
  });
});
