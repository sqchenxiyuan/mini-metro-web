// SPDX-License-Identifier: GPL-3.0-or-later
import { segments, station, trackPoints } from './rules';
import type { State } from './types';

/** One visual rail per distinct line, not per direction or train. */
export interface TrackLane {
  lineId: number;
  /** Signed distance to the left of the canonical path (renderer world units). */
  offset: number;
}

export interface TrackSegment {
  /** Canonical station-id order, independent of a line's stop order. */
  from: number;
  to: number;
  points: { x: number; y: number }[];
  lanes: TrackLane[];
  /** Radius for a single white underlay centered on the shared path. */
  underlayRadius: number;
}

export interface TrackApproach {
  stationId: number;
  /** E, NE, N, NW, W, SW, S, SE, counterclockwise from east. */
  sector: number;
  /** Unit direction of the first trackPoints leg away from the station. */
  tangent: { x: number; y: number };
  underlayRadius: number;
  /** Distinct arcs remain distinct even when they leave in the same sector. */
  lanes: (TrackLane & { neighborId: number })[];
}

export interface TrackLayout {
  segments: TrackSegment[];
  approaches: TrackApproach[];
}

/** Derive drawable rails without changing the simulation state. */
export function deriveTrackLayout(state: State): TrackLayout {
  const byPair = new Map<string, TrackSegment>();
  for (const line of state.lines) {
    for (const [a, b] of segments(line)) {
      const from = Math.min(a, b), to = Math.max(a, b);
      const key = `${from}:${to}`;
      let segment = byPair.get(key);
      if (!segment) {
        segment = { from, to, points: trackPoints(station(state, from), station(state, to)), lanes: [], underlayRadius: 0 };
        byPair.set(key, segment);
      }
      if (!segment.lanes.some((lane) => lane.lineId === line.id))
        segment.lanes.push({ lineId: line.id, offset: 0 });
    }
  }
  const result = [...byPair.values()].sort((a, b) => a.from - b.from || a.to - b.to);
  for (const segment of result) {
    segment.lanes.sort((a, b) => a.lineId - b.lineId);
    segment.lanes.forEach((lane, index) => { lane.offset = (index - (segment.lanes.length - 1) / 2) * 0.21; });
    segment.underlayRadius = segment.lanes.length * 0.105 + 0.045;
  }
  const approaches = new Map<string, TrackApproach>();
  for (const segment of result) for (const stationId of [segment.from, segment.to]) {
    const forward = stationId === segment.from;
    const points = forward ? segment.points : [...segment.points].reverse();
    const dx = points[1].x - points[0].x, dy = points[1].y - points[0].y;
    if (dx === 0 && dy === 0) continue;
    const sector = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
    const key = `${stationId}:${sector}`;
    let approach = approaches.get(key);
    if (!approach) {
      const length = Math.hypot(dx, dy);
      approach = { stationId, sector, tangent: { x: dx / length, y: dy / length }, lanes: [], underlayRadius: 0 };
      approaches.set(key, approach);
    }
    for (const lane of segment.lanes)
      approach.lanes.push({ lineId: lane.lineId, neighborId: forward ? segment.to : segment.from, offset: 0 });
  }
  const orderedApproaches = [...approaches.values()].sort((a, b) => a.stationId - b.stationId || a.sector - b.sector);
  for (const approach of orderedApproaches) {
    approach.lanes.sort((a, b) => a.lineId - b.lineId || a.neighborId - b.neighborId);
    const anchor = result.find((segment) =>
      segment.from === Math.min(approach.stationId, approach.lanes[0].neighborId) &&
      segment.to === Math.max(approach.stationId, approach.lanes[0].neighborId))!;
    const orientation = anchor.from === approach.stationId ? 1 : -1;
    approach.lanes.forEach((lane, index) => { lane.offset = orientation * (index - (approach.lanes.length - 1) / 2) * 0.21; });
    approach.underlayRadius = approach.lanes.length * 0.105 + 0.045;
  }
  return { segments: result, approaches: orderedApproaches };
}
