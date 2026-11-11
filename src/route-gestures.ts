// SPDX-License-Identifier: GPL-3.0-or-later
export type Point = { x: number; y: number };
export type Bounds = { left: number; top: number; right: number; bottom: number };

/** Resolve ownership against the renderer's painted geometry, never selection.
 * Narrow the existing radius-only hit API instead of duplicating lane geometry.
 */
export function paintedRailOwner(
  lines: readonly number[], hit: (line: number, radius: number) => number | null, radius = 12, selected?: number,
): { line: number; edge: number } | null {
  let result: { line: number; edge: number } | null = null, best = radius + 1;
  for (const line of [...lines].sort((a, b) => a - b)) {
    let edge = hit(line, radius);
    if (edge === null) continue;
    let low = 0, high = radius;
    for (let i = 0; i < 10; i++) {
      const middle = (low + high) / 2, closer = hit(line, middle);
      if (closer === null) low = middle;
      else { high = middle; edge = closer; }
    }
    if (high < best - .02 || Math.abs(high - best) <= .02 && line === selected) {
      best = high; result = { line, edge };
    }
  }
  return result;
}

/** Always derive from pointer-down topology, never the previous hovered draft. */
export function middleRailEdit(
  stops: readonly number[], edge: number, target: number | null, loop = false,
): { stops: number[]; kind: 'insert' | 'remove' } | null {
  if (target === null || edge < 1 || edge > stops.length - (loop ? 0 : 1)) return null;
  const index = stops.indexOf(target);
  if (index < 0) {
    const draft = [...stops]; draft.splice(edge, 0, target);
    return { stops: draft, kind: 'insert' };
  }
  if (!loop && index > 0 && index < stops.length - 1 && (index === edge - 1 || index === edge))
    return { stops: stops.filter((_, i) => i !== index), kind: 'remove' };
  return null;
}

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
  if (id === endpoint) return current.length > 1
    ? { stops: side === 'start' ? current.slice(1) : current.slice(0, -1), loop: false } : null;
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
