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
