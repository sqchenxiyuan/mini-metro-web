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

export function removedRouteEdges(original: readonly number[], draft: readonly number[]): [number, number][] {
  const edges = new Set<string>();
  for (let i = 1; i < draft.length; i++)
    edges.add([draft[i - 1], draft[i]].sort((a, b) => a - b).join(':'));
  const removed: [number, number][] = [];
  for (let i = 1; i < original.length; i++) {
    const a = original[i - 1], b = original[i];
    if (!edges.has([a, b].sort((x, y) => x - y).join(':'))) removed.push([a, b]);
  }
  return removed;
}

/** One visited station per move; never erase unvisited intermediate stops. */
export function endpointStep(
  original: readonly number[], side: 'start' | 'end', current: readonly number[], id: number,
): { stops: number[]; loop: boolean } | null {
  if (!current.length) return null;
  const endpoint = side === 'start' ? current[0] : current.at(-1)!;
  if (id === endpoint) return null;
  const adjacent = side === 'start' ? current[1] : current.at(-2);
  if (id === adjacent) return { stops: side === 'start' ? current.slice(1) : current.slice(0, -1), loop: false };
  const originalIndex = original.indexOf(endpoint);
  const nextOriginal = original[originalIndex + (side === 'start' ? -1 : 1)];
  if (id === nextOriginal && !current.includes(id))
    return { stops: side === 'start' ? [id, ...current] : [...current, id], loop: false };
  const opposite = side === 'start' ? current.at(-1) : current[0];
  if (id === opposite && current.length >= 3) return { stops: [...current], loop: true };
  if (original.includes(id) || current.includes(id)) return null;
  return { stops: side === 'start' ? [id, ...current] : [...current, id], loop: false };
}

export function safeLoopRelease(start: Point, end: Point, bounds: Bounds, unsafe: boolean): boolean {
  const margin = 20;
  return !unsafe && Math.hypot(end.x - start.x, end.y - start.y) >= 65 &&
    end.x >= bounds.left + margin && end.x <= bounds.right - margin &&
    end.y >= bounds.top + margin && end.y <= bounds.bottom - margin;
}
