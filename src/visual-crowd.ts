// SPDX-License-Identifier: GPL-3.0-or-later
import { RULES } from './rules';
import type { Mode, Passenger } from './types';

/** Rendering only: saturation in non-losing modes must not read as terminal red. */
export function crowdFillFraction(crowd: number, mode: Mode): number {
  const fraction = Math.max(0, Math.min(1, crowd / RULES.crowdTicks));
  return mode === 'endless' || mode === 'creative' ? fraction * 0.7 : fraction;
}

/** Deterministic visual displacement in CSS pixels; never consumes simulation RNG. */
export function passengerJitter(id: number, born: number, tick: number, reducedMotion: boolean): { x: number; y: number } {
  if (reducedMotion) return { x: 0, y: 0 };
  const age = Math.max(0, tick - born);
  const strength = 0.45 + 0.95 * Math.min(1, age / (RULES.hz * 30));
  const phase = id * 2.399963229728653;
  return {
    x: strength * Math.sin(tick / 13 + phase),
    y: strength * Math.sin(tick / 17 + phase * 1.73),
  };
}

/** Group mark represents all its riders; move the icon and exact count together. */
export function groupJitter(passengers: readonly Passenger[], tick: number, reducedMotion: boolean): { x: number; y: number } {
  if (!passengers.length || reducedMotion) return { x: 0, y: 0 };
  const sum = passengers.reduce((acc, rider) => {
    const delta = passengerJitter(rider.id, rider.born, tick, false);
    acc.x += delta.x;
    acc.y += delta.y;
    return acc;
  }, { x: 0, y: 0 });
  return { x: sum.x / passengers.length, y: sum.y / passengers.length };
}
