export interface OverlayStation {
  id: number;
  x: number;
  y: number;
  queue: number;
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

/** Clip a line to an axis-aligned hit target; include its visible border. */
function crossesBox(ax: number, ay: number, bx: number, by: number, box: OverlayBox): boolean {
  let near = 0, far = 1;
  for (const [a, d, low, high] of [
    [ax, bx - ax, box.x, box.x + box.width],
    [ay, by - ay, box.y, box.y + box.height],
  ]) {
    if (Math.abs(d) < 1e-9) { if (a < low || a > high) return false; continue; }
    const enter = (low - a) / d, leave = (high - a) / d;
    near = Math.max(near, Math.min(enter, leave));
    far = Math.min(far, Math.max(enter, leave));
    if (near > far) return false;
  }
  return true;
}

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
export function queueCueBounds(count: number, level: NonNullable<OverlayBox['level']>, mobile = false): OverlayBox {
  if (mobile) {
    const columns = Math.min(6, count);
    const rows = Math.ceil(count / 6);
    return { x: -columns * 11 / 2, y: -5, width: columns * 11, height: (rows - 1) * 12 + 10 };
  }
  const icons = level === 'full' ? Math.min(count, 3) : level === 'compact' ? Math.min(count, 1) : 0;
  const text = level === 'count' ? String(count) : count > icons ? `+${count - icons}` : '';
  const textWidth = text ? Math.min(36, Math.max(16, text.length * 8)) : 0;
  const occupied = icons * 11 + (text ? Math.min(27, text.length * 8) : 0);
  const iconLeft = icons ? -occupied / 2 + 0.5 : Infinity;
  const iconRight = icons ? -occupied / 2 + (icons - 1) * 11 + 10.5 : -Infinity;
  const textLeft = text ? occupied / 2 - textWidth : Infinity;
  const textRight = text ? occupied / 2 : -Infinity;
  const x = Math.min(iconLeft, textLeft);
  return { x, y: text ? -8.5 : -5, width: Math.max(iconRight, textRight) - x,
    height: text ? 17 : 10 };
}

/** In-scene cue layout. Returned rectangles are the *drawn* geometry bounds,
 * not hypothetical cards; the warning ring remains at its station independently.
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
        const shape = queueCueBounds(p.queue, 'full', true);
        const box: OverlayBox = { x: p.x - shape.width / 2, y: p.y + 42,
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
  // All candidate centers are <=36px from their anchor. Local annotation may
  // overlap its *own* transparent target but never another station's target.
  const warningCenters = [[0, -30], [-22, -27], [22, -27], [0, 32]];
  const queueCenters = [[0, -30], [-22, -27], [22, -27], [0, 32]];
  const place = (p: OverlayStation, shape: OverlayBox, centers: number[][],
    level?: OverlayBox['level']): OverlayBox | null => {
    for (const [dx, dy] of centers) {
      const box = { x: p.x + dx - shape.width / 2, y: p.y + dy - shape.height / 2,
        width: shape.width, height: shape.height, ...(level ? { level } : {}) };
      if (box.x < 4 || box.y < 4 || box.x + box.width > viewport.width - 4 ||
        box.y + box.height > viewport.height - 4 || blocked.some((other) => intersects(box, other)) ||
        hits.some((hit) => hit.id !== p.id && intersects(box, hit.box))) continue;
      if (mobile && level && Math.hypot(dx, dy) > 17) {
        const distance = Math.hypot(dx, dy);
        const startX = p.x + dx * 13 / distance, startY = p.y + dy * 13 / distance;
        if (hits.some((hit) => hit.id !== p.id && crossesBox(startX, startY,
          p.x + dx, p.y + dy, hit.box))) continue;
      }
      blocked.push(box);
      return box;
    }
    return null;
  };
  const ordered = [...stations].sort((a, b) => Number(b.selected) - Number(a.selected) ||
    b.crowd - a.crowd || a.id - b.id);
  // On a phone the destination silhouettes are the primary game information.
  // A crowded station already has its ring and the global alert if its verbose
  // countdown cannot fit; allocate the small adjacent queue marks first.
  if (mobile) for (const p of ordered) if (p.selected && p.crowd > 0) {
    const entry = result.get(p.id)!;
    entry.warning = place(p, warningCueBounds, warningCenters);
    entry.warningFallback = !entry.warning;
  }
  if (mobile) for (const p of ordered) if (p.queue > 0) {
    const entry = result.get(p.id)!;
    for (const level of ['full', 'compact', 'count'] as const) {
      entry.queue = place(p, queueCueBounds(p.queue, level), queueCenters, level);
      if (entry.queue) break;
    }
    entry.queueFallback = !entry.queue;
  }
  for (const p of ordered) if (p.crowd > 0 && !result.get(p.id)!.warning) {
    const entry = result.get(p.id)!;
    entry.warning = place(p, warningCueBounds, warningCenters);
    entry.warningFallback = !entry.warning;
  }
  if (!mobile) for (const p of ordered) if (p.queue > 0) {
    const entry = result.get(p.id)!;
    for (const level of ['full', 'compact', 'count'] as const) {
      entry.queue = place(p, queueCueBounds(p.queue, level), queueCenters, level);
      if (entry.queue) break;
    }
    entry.queueFallback = !entry.queue;
  }
  return stations.map((p) => result.get(p.id)!);
}
