// SPDX-License-Identifier: GPL-3.0-or-later
import { applyAction, copy, LINE_COLORS } from './rules';
import type { Action, State } from './types';

export type ResourceKind = 'locomotive' | 'carriage';
export interface ResourcePoint { x: number; y: number }
export interface ResourceGeometry {
  railAt(point: ResourcePoint): { line: number; edge: number } | null;
  stationPoint(id: number): ResourcePoint | null;
  trainPoint(id: number): ResourcePoint | null;
  contains(point: ResourcePoint): boolean;
  /** Forward route tangent of the nearest last-painted lane segment. */
  railVector?(point: ResourcePoint, hit: { line: number; edge: number }): ResourcePoint | null;
}
export interface ResourcePreview {
  action: Action;
  point: ResourcePoint;
  line: number;
  label: string;
  direction?: 1 | -1;
}
export interface ResourceHost {
  state(): State;
  replay(): boolean;
  geometry: ResourceGeometry;
  commit(action: Action): boolean;
}
/** Visual draft only. The host is called once, after copied-current-state validation. */
export class ResourceDrag {
  kind: ResourceKind | null = null;
  preview: ResourcePreview | null = null;
  private routes = new Map<number, string>();
  private lastRailPoint: ResourcePoint | null = null;
  private direction: 1 | -1 = 1;
  constructor(private host: ResourceHost) {}
  begin(kind: ResourceKind): boolean {
    this.cancel();
    const s = this.host.state();
    if (this.host.replay() || s.phase !== 'playing' || s.resources[kind === 'locomotive' ? 'locomotives' : 'carriages'] < 1) return false;
    this.kind = kind;
    return true;
  }
  move(point: ResourcePoint, explicit?: { line: number; station?: number; train?: number }): ResourcePreview | null {
    const s = this.host.state(), geometry = this.host.geometry;
    this.preview = null;
    if (!this.kind || !geometry.contains(point)) return null;
    const hit = explicit ? { line: explicit.line, edge: 1 } : geometry.railAt(point);
    if (this.kind === 'carriage') {
      const visible = s.trains.flatMap(train => {
        const p = geometry.trainPoint(train.id);
        return p && geometry.contains(p) ? [{ train, point: p, distance: Math.hypot(p.x - point.x, p.y - point.y) }] : [];
      }).sort((a, b) => a.distance - b.distance || a.train.id - b.train.id);
      const core = visible.find(t => t.distance <= 18);
      const target = explicit?.train !== undefined ? visible.find(t => t.train.id === explicit.train) : core ?? visible.find(t => t.train.line === hit?.line &&
        applyAction(copy(s), { type: 'carriage', train: t.train.id, delta: 1 }).ok);
      if (!target) return null;
      const action: Action = { type: 'carriage', train: target.train.id, delta: 1 };
      const route = s.lines.find(l => l.id === target.train.line);
      if (!route || !this.routeCurrent(route) || !applyAction(copy(s), action).ok) return null;
      return this.preview = { action, point: target.point, line: target.train.line,
        label: `${target.train.line + 1} 号线 · ${target.train.id} 号列车 +1 车厢` };
    }
    const line = hit && s.lines.find(l => l.id === hit.line);
    if (!line || line.stops.length < 2 || !this.routeCurrent(line)) return null;
    let closest: { id: number; point: ResourcePoint; distance: number } | null = null;
    for (const id of line.stops) {
      if (explicit?.station !== undefined && id !== explicit.station) continue;
      const p = geometry.stationPoint(id);
      if (!p) continue;
      const distance = Math.hypot(p.x - point.x, p.y - point.y);
      if (!closest || distance < closest.distance) closest = { id, point: p, distance };
    }
    if (!closest) return null;
    const a = geometry.stationPoint(line.stops[(hit!.edge - 1) % line.stops.length]);
    const b = geometry.stationPoint(line.stops[hit!.edge % line.stops.length]);
    if (a && b && this.lastRailPoint) {
      const vector = geometry.railVector?.(point, hit!) ?? { x: b.x - a.x, y: b.y - a.y };
      const length = Math.hypot(vector.x, vector.y);
      const along = ((point.x - this.lastRailPoint.x) * vector.x +
        (point.y - this.lastRailPoint.y) * vector.y) / Math.max(1, length);
      // CSS-pixel noise rejection is visual tuning, not original-game timing.
      if (Math.abs(along) > 1) this.direction = along > 0 ? 1 : -1;
    }
    this.lastRailPoint = { ...point };
    const index = line.stops.indexOf(closest.id);
    const direction = !line.loop && index === 0 ? 1 : !line.loop && index === line.stops.length - 1 ? -1 : this.direction;
    const action: Action = { type: 'addTrain', line: line.id, station: closest.id, direction };
    if (!applyAction(copy(s), action).ok) return null;
    return this.preview = { action, point: closest.point, line: line.id, direction,
      label: `${line.id + 1} 号线 · ${closest.id} 站出库 ${direction === 1 ? '→' : '←'}` };
  }
  private routeCurrent(line: State['lines'][number]): boolean {
    const identity = JSON.stringify([line.stops, line.loop]);
    if (this.routes.has(line.id) && this.routes.get(line.id) !== identity) return false;
    this.routes.set(line.id, identity);
    return true;
  }
  release(point: ResourcePoint, explicit?: { line: number; station?: number; train?: number }): boolean {
    const candidate = this.move(point, explicit);
    this.cancel();
    return !!candidate && !this.host.replay() && applyAction(copy(this.host.state()), candidate.action).ok && this.host.commit(candidate.action);
  }
  cancel(): void { this.kind = null; this.preview = null; this.routes.clear(); this.lastRailPoint = null; this.direction = 1; }
}

export interface ResourceDragDOMHost extends ResourceHost {
  stage: HTMLElement;
  tray: HTMLElement;
  /** Clears route draft, armed endpoint, creative placement, and redraw together. */
  clearOtherGestures(): void;
  routeBusy(): boolean;
  changed(): void;
}
/** Document capture is essential: inventory sources live outside the map stage. */
export function installResourceDrag(host: ResourceDragDOMHost) {
  const drag = new ResourceDrag(host), doc = host.stage.ownerDocument;
  const preview = doc.createElement('div');
  preview.id = 'resource-preview'; preview.hidden = true;
  preview.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 9h13l9 9v6H5z M18 10v8h8 M9 25v3 M23 25v3"/></svg><span></span>';
  doc.body.append(preview);
  const status = doc.createElement('span'); status.className = 'resource-sr'; status.setAttribute('role', 'status'); host.tray.append(status);
  let pointer: number | null = null, source: HTMLElement | null = null;
  let origin = { x: 0, y: 0 }, last = origin, moved = false, armed = false, swallowClick = false;
  const held = new Set<number>(), blocked = new Set<number>();
  let keyChoice: { point: ResourcePoint; line: number; station?: number; train?: number } | undefined;
  let choiceIndex = -1;
  const consume = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const paint = (point = last) => {
    const target = drag.preview;
    preview.hidden = !drag.kind;
    preview.dataset.valid = String(!!target);
    preview.dataset.kind = drag.kind ?? '';
    preview.style.setProperty('--resource-line', target ? LINE_COLORS[target.line] : '#55545a');
    const p = target?.point ?? point;
    preview.style.left = `${p.x}px`; preview.style.top = `${p.y}px`;
    const text = target?.label ?? (drag.kind === 'locomotive' ? '拖到彩色轨道 · 就近车站出库' : '拖到列车或彩色轨道 · 预览目标列车');
    preview.querySelector('span')!.textContent = text;
    // Keep the visual label inside native viewports and away from queue glyphs.
    preview.querySelector('span')!.style.transform = `translateX(${Math.max(8 - p.x, Math.min(12, innerWidth - p.x - 225))}px)`;
    if (status.textContent !== text) status.textContent = text;
    for (const button of host.tray.querySelectorAll<HTMLElement>('[data-resource]'))
      button.setAttribute('aria-pressed', String(button.dataset.resource === drag.kind));
  };
  const cancel = () => {
    if (pointer !== null) { blocked.add(pointer); swallowClick = true; }
    pointer = null; source = null; armed = false; keyChoice = undefined; choiceIndex = -1;
    drag.cancel(); preview.hidden = true;
    host.clearOtherGestures(); paint(); host.changed();
  };
  const start = (kind: ResourceKind) => {
    cancel();
    if (!drag.begin(kind)) return false;
    armed = true; paint(); host.changed(); return true;
  };
  const explicitTarget = (target: Element) => {
    const station = target.closest<HTMLElement>('[data-station]'), train = target.closest<HTMLElement>('[data-train-id], [data-train-choice]');
    const s = host.state();
    if (train && drag.kind === 'carriage') {
      const id = Number(train.dataset.trainId ?? train.dataset.trainChoice), t = s.trains.find(t => t.id === id), p = host.geometry.trainPoint(id);
      if (t && p) return { point: p, line: t.line, train: id };
    }
    if (station && drag.kind === 'locomotive') {
      const id = Number(station.dataset.station), line = s.lines.find(l => l.stops.includes(id)), p = host.geometry.stationPoint(id);
      if (line && p) return { point: p, line: line.id, station: id };
    }
    return undefined;
  };
  // Modal and editing controls own their native input; entering either discards
  // the whole draft so a later map click cannot revive a fallback keyChoice.
  const outsideResourceScope = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null;
    if (!doc.querySelector('dialog[open]') && !element?.closest('input, select, textarea') &&
        !(element as HTMLElement | null)?.isContentEditable) return false;
    if (drag.kind || pointer !== null || blocked.size) cancel();
    return true;
  };
  doc.addEventListener('focusin', event => { outsideResourceScope(event.target); }, true);
  doc.addEventListener('pointerdown', event => {
    if (outsideResourceScope(event.target)) return;
    held.add(event.pointerId);
    if (held.size > 1 && (drag.kind || pointer !== null || blocked.size ||
        (event.target as Element).closest('[data-resource]'))) {
      for (const id of held) blocked.add(id);
      cancel(); consume(event); return;
    }
    if (blocked.size) { blocked.add(event.pointerId); consume(event); return; }
    const target = event.target as Element, button = target.closest<HTMLButtonElement>('[data-resource]');
    if (!button && !(armed && host.stage.contains(target))) { swallowClick = false; return; }
    if (event.button !== 0 || button?.disabled || (!button && !drag.kind) || host.routeBusy()) return;
    swallowClick = false;
    if (button && !start(button.dataset.resource as ResourceKind)) return;
    host.clearOtherGestures();
    pointer = event.pointerId; source = button ?? host.stage; origin = last = { x: event.clientX, y: event.clientY }; moved = !button;
    try { source.setPointerCapture(event.pointerId); } catch { /* native implicit touch capture still routes to document */ }
    consume(event); paint();
  }, true);
  doc.addEventListener('pointermove', event => {
    if (outsideResourceScope(event.target)) return;
    if (blocked.has(event.pointerId)) { consume(event); return; }
    if (event.pointerId !== pointer) return;
    last = { x: event.clientX, y: event.clientY };
    moved ||= Math.hypot(last.x - origin.x, last.y - origin.y) > 6;
    if (moved) { keyChoice = undefined; drag.move(last); paint(); }
    consume(event);
  }, true);
  for (const type of ['pointerup', 'pointercancel'] as const) doc.addEventListener(type, event => {
    held.delete(event.pointerId);
    if (outsideResourceScope(event.target)) { blocked.delete(event.pointerId); return; }
    if (blocked.delete(event.pointerId)) { consume(event); return; }
    if (pointer !== event.pointerId) return;
    const capture = source; pointer = null; source = null; swallowClick = true;
    if (type === 'pointercancel') cancel();
    else if (moved) { drag.release({ x: event.clientX, y: event.clientY }); armed = false; preview.hidden = true; host.clearOtherGestures(); paint(); host.changed(); }
    else { armed = true; paint(); }
    try { if (capture?.hasPointerCapture(event.pointerId)) capture.releasePointerCapture(event.pointerId); } catch { /* canceled capture */ }
    consume(event);
  }, true);
  doc.addEventListener('click', event => {
    if (outsideResourceScope(event.target)) { swallowClick = false; return; }
    const target = event.target as Element, button = target.closest<HTMLButtonElement>('[data-resource]');
    if (swallowClick && event.detail > 0) { swallowClick = false; consume(event); return; }
    if (button) {
      consume(event);
      if (keyChoice && drag.kind === button.dataset.resource) { drag.release(keyChoice.point, keyChoice); cancel(); }
      else start(button.dataset.resource as ResourceKind);
      return;
    }
    if (!armed) return;
    const explicit = explicitTarget(target);
    if (explicit) { consume(event); drag.release(explicit.point, explicit); cancel(); }
  }, true);
  doc.addEventListener('keydown', event => {
    if (outsideResourceScope(event.target)) return;
    if (event.key === 'Escape' && (drag.kind || blocked.size)) {
      cancel(); doc.body.classList.remove('resource-tray-open');
      const toggle = doc.getElementById('resource-toggle'); toggle?.setAttribute('aria-expanded', 'false');
      if (toggle) toggle.textContent = '物资';
      consume(event); return;
    }
    if (!armed || !drag.kind || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter'].includes(event.key)) return;
    if (event.key === 'Enter') {
      const explicit = explicitTarget(event.target as Element) ?? keyChoice;
      if (explicit) { drag.release(explicit.point, explicit); cancel(); consume(event); }
      return;
    }
    const s = host.state();
    const choices = drag.kind === 'locomotive' ? s.lines.filter(l => l.stops.length > 1).flatMap(l => l.stops.map(station => ({ line: l.id, station, point: host.geometry.stationPoint(station) })))
      : s.trains.filter(t => !t.retiring && !t.moveTo).map(t => ({ line: t.line, train: t.id, point: host.geometry.trainPoint(t.id) }));
    const available = choices.filter(t => t.point && host.geometry.contains(t.point));
    if (available.length) {
      const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      choiceIndex = (choiceIndex + delta + available.length) % available.length;
      const choice = available[choiceIndex]; keyChoice = { ...choice, point: choice.point! };
      last = keyChoice.point; drag.move(last, keyChoice); paint();
    }
    consume(event);
  }, true);
  doc.addEventListener('wheel', event => { if (!outsideResourceScope(event.target) && (drag.kind || blocked.size)) consume(event); }, { capture: true, passive: false });
  window.addEventListener('blur', () => { cancel(); held.clear(); blocked.clear(); swallowClick = true; });
  return {
    cancel,
    get kind() { return drag.kind; },
    get active() { return pointer !== null || !!drag.kind || blocked.size > 0; },
    refresh() {
      if (doc.querySelector('dialog[open]')) { if (drag.kind) cancel(); return; }
      if (host.replay() || host.state().phase !== 'playing') { if (drag.kind) cancel(); return; }
      if (drag.kind && (moved || keyChoice)) { drag.move(last, keyChoice); paint(); }
    },
  };
}
