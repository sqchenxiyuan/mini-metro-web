import type { Shape } from './types';
export interface OverlayStation {
  id: number;
  x: number;
  y: number;
  queue: number;
  /** Real destinations, so the reserved rectangle matches the drawn groups. */
  queueShapes?: readonly Shape[];
  crowd: number;
  selected: boolean;
}
export interface OverlayBox {
  x: number;
  y: number;
  width: number;
  height: number;
  level?: 'full' | 'compact' | 'count';
}
export interface OverlayPlacement {
  id: number;
  queue: OverlayBox | null;
  warning: OverlayBox | null;
  warningFallback: boolean;
  queueFallback: boolean;
}

const intersects = (a: OverlayBox, b: OverlayBox, pad = 2): boolean =>
  a.x < b.x + b.width + pad && a.x + a.width + pad > b.x &&
  a.y < b.y + b.height + pad && a.y + a.height + pad > b.y;


/** Display-only, deterministic placement in CSS pixels; never writes to game state. */
export function layoutOverlays(stations: readonly OverlayStation[], viewport: { width: number; height: number },
  mobile = false, reserved: readonly OverlayBox[] = []): OverlayPlacement[] {
  const result = new Map(stations.map((p) => [p.id, {
    id: p.id, queue: null, warning: null, warningFallback: false, queueFallback: false,
  } as OverlayPlacement]));
  // Reserve touch targets too: an adjacent overlay must never appear to belong
  // to, or be intercepted by, the neighboring station button.
  const projectedHit = stations.map((p) => ({
    x: p.x - (mobile ? 22 : 18), y: p.y - 5,
    width: mobile ? 44 : 36, height: mobile ? 44 : 36,
  }));
  const blocked: OverlayBox[] = [...reserved, ...projectedHit];
  const warningOffsets = [[0, 25], [0, -37], [20, 25], [-20, 25], [20, -37], [-20, -37]];
  const queueOffsets = [[0, 25], [0, -36], [-38, 24], [38, 24], [-38, -34], [38, -34],
    [0, 47], [-58, 7], [58, 7], [-58, 45], [58, 45]];
  function place(p: OverlayStation, width: number, height: number,
    level?: OverlayBox['level'], offsets = queueOffsets, maxDistance = Infinity): OverlayBox | null {
    for (const [dx, dy] of offsets) {
      if (Math.hypot(dx, dy + height / 2) > maxDistance) continue;
      const candidate = { x: Math.round(p.x + dx - width / 2), y: Math.round(p.y + dy),
        width, height, ...(level ? { level } : {}) };
      if (candidate.x < 4 || candidate.y < 4 || candidate.x + width > viewport.width - 4 ||
        candidate.y + height > viewport.height - 4 || blocked.some((box) => intersects(candidate, box))) continue;
      blocked.push(candidate);
      return candidate;
    }
    return null;
  }
  // Warnings are safety-critical; assign space before lower-priority queue summaries.
  const ordered = [...stations].sort((a, b) => Number(b.selected) - Number(a.selected) ||
    b.crowd - a.crowd || a.id - b.id);
  for (const p of ordered) if (p.crowd > 0) {
    const r = result.get(p.id)!;
    r.warning = place(p, mobile ? 44 : 40, 20, undefined, warningOffsets, 48);
    r.warningFallback = !r.warning;
  }
  for (const p of ordered) if (p.queue > 0) {
    const r = result.get(p.id)!;
    for (const [width, height, level] of [
      [mobile ? 58 : 66, 32, 'full'], [44, 20, 'compact'], [28, 18, 'count'],
    ] as const) {
      r.queue = place(p, width, height, level);
      if (r.queue) break;
    }
    r.queueFallback = !r.queue;
  }
  return stations.map((p) => result.get(p.id)!);
}

/** Local CSS-pixel bounds of the actual WebGL geometries, including text planes. */
export const warningCueBounds: OverlayBox = { x: 7, y: -40.5, width: 24, height: 28.5 };
export function queueCueBounds(count: number, _level: NonNullable<OverlayBox['level']>, mobile = false,
  groupCount?: number): OverlayBox {
  if (mobile && count <= 10) {
    const columns = Math.min(6, count);
    const rows = Math.ceil(count / 6);
    return { x: -columns * 11 / 2 - 2, y: -7, width: columns * 11 + 4, height: (rows - 1) * 12 + 14 };
  }
  if (count <= 10) {
    const columns = Math.min(6, count);
    const rows = Math.ceil(count / 6);
    return { x: -columns * 11 / 2 - 2, y: -7, width: columns * 11 + 4,
      height: (rows - 1) * 12 + 14 };
  }
  // Unknown destinations reserve all ten shapes; actual destinations size exactly.
  const groups = groupCount ?? 10;
  const columns = Math.min(groups, 4), rows = Math.ceil(groups / 4);
  return { x: -columns * 50 / 2 - 2, y: -10.5, width: columns * 50 + 4,
    height: (rows - 1) * 20 + 21 };
}

/** In-scene cue layout. Returned rectangles include small jitter margins;
 * crowd fill lives on the station and does not consume a floating cue box.
 */
export function layoutSceneCues(stations: readonly OverlayStation[],
  viewport: { width: number; height: number }, reserved: readonly OverlayBox[] = []): OverlayPlacement[] {
  const mobile = viewport.width <= 650;
  const hitSize = mobile ? 44 : 36;
  if (mobile) {
    // A queue is a single indivisible pile directly below its own station.
    // Neither selection nor crowd state may move another station's silhouettes.
    const hits = stations.map((p) => ({ id: p.id, box: {
      x: p.x - 22, y: p.y - 5, width: 44, height: 44,
    } }));
    const blocked = [...reserved];
    const result = new Map<number, OverlayPlacement>();
    for (const p of [...stations].sort((a, b) => a.id - b.id)) {
      const placement: OverlayPlacement = { id: p.id, queue: null, warning: null,
        warningFallback: false, queueFallback: false };
      if (p.queue > 0) {
        const shape = queueCueBounds(p.queue, 'full', true, p.queueShapes && new Set(p.queueShapes).size);
        const box: OverlayBox = { x: p.x + shape.x, y: p.y + 42,
          width: shape.width, height: shape.height, level: 'full' };
        if (box.x >= 4 && box.y >= 4 && box.x + box.width <= viewport.width - 4 &&
          box.y + box.height <= viewport.height - 4 &&
          !blocked.some((other) => intersects(box, other)) &&
          !hits.some((hit) => hit.id !== p.id && intersects(box, hit.box))) {
          placement.queue = box;
          blocked.push(box);
        } else placement.queueFallback = true;
      }
      result.set(p.id, placement);
    }
    return stations.map((p) => result.get(p.id)!);
  }
  const hits = stations.map((p) => ({ id: p.id, box: {
    x: p.x - hitSize / 2, y: p.y - 5, width: hitSize, height: hitSize,
  } }));
  const blocked: OverlayBox[] = [...reserved];
  const result = new Map(stations.map((p) => [p.id, {
    id: p.id, queue: null, warning: null, warningFallback: false, queueFallback: false,
  } as OverlayPlacement]));
  // Retain only the station-owned queue; warnings never reserve map space.
  const ordered = [...stations].sort((a, b) => Number(b.selected) - Number(a.selected) ||
    b.crowd - a.crowd || a.id - b.id);
  if (!mobile) for (const p of ordered) if (p.queue > 0) {
    const entry = result.get(p.id)!;
    const shape = queueCueBounds(p.queue, 'full', false, p.queueShapes && new Set(p.queueShapes).size);
    const box: OverlayBox = { x: p.x + shape.x, y: p.y + 42,
      width: shape.width, height: shape.height, level: 'full' };
    if (box.x >= 4 && box.y >= 4 && box.x + box.width <= viewport.width - 4 &&
      box.y + box.height <= viewport.height - 4 &&
      !blocked.some((other) => intersects(box, other)) &&
      !hits.some((hit) => hit.id !== p.id && intersects(box, hit.box))) {
      entry.queue = box;
      blocked.push(box);
    } else entry.queueFallback = true;
  }
  return stations.map((p) => result.get(p.id)!);
}
