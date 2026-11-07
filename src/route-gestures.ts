// SPDX-License-Identifier: GPL-3.0-or-later
export type Point = { x: number; y: number };
export type Bounds = { left: number; top: number; right: number; bottom: number };

/** The edge index is the insertion position returned by the visible-lane hit test. */
export function breakLoopEdge(stops: readonly number[], edge: number): number[] | null {
  if (stops.length < 3 || edge < 1 || edge > stops.length) return null;
  return edge === stops.length ? [...stops] : [...stops.slice(edge), ...stops.slice(0, edge)];
}

export function extensionStops(stops: readonly number[], side: 'start' | 'end', additions: readonly number[]): number[] | null {
  if (!additions.length || additions.some(id => stops.includes(id)) || new Set(additions).size !== additions.length) return null;
  return side === 'start' ? [...additions].reverse().concat(stops) : [...stops, ...additions];
}

export function safeLoopRelease(start: Point, end: Point, bounds: Bounds, unsafe: boolean): boolean {
  const margin = 20;
  return !unsafe && Math.hypot(end.x - start.x, end.y - start.y) >= 65 &&
    end.x >= bounds.left + margin && end.x <= bounds.right - margin &&
    end.y >= bounds.top + margin && end.y <= bounds.bottom - margin;
}
