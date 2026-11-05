import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { advance, applyAction, createState, RULES } from '../src/rules';
import type { Mode } from '../src/types';

function reachWeekTwo(mode: Mode) {
  const state = createState({ mode, seed: 420 });
  state.nextStation = 1e8;
  for (const station of state.stations) station.nextPassenger = 1e8;
  state.elapsed = RULES.weekTicks - 1;
  return state;
}

describe('weekly reward', () => {
  it.each(['normal', 'endless', 'extreme'] as Mode[])(
    '%s grants the locomotive before the choice, without granting it again on selection',
    (mode) => {
      const state = reachWeekTwo(mode);
      const before = state.resources.locomotives;
      expect(advance(state)).toBe(true);
      expect(state.week).toBe(2);
      expect(state.resources.locomotives).toBe(before + 1);
      expect(state.phase).toBe('upgrade');
      expect(state.upgrades).toHaveLength(2);
      const choice = state.upgrades[0];
      expect(applyAction(state, { type: 'upgrade', choice }).ok).toBe(true);
      expect(state.resources.locomotives).toBe(before + 1);
      expect(state.phase).toBe('playing');
      expect(state.upgrades).toEqual([]);
    },
  );

  it('grants creative mode the locomotive without requiring a supply choice', () => {
    const state = reachWeekTwo('creative');
    const before = state.resources.locomotives;
    expect(advance(state)).toBe(true);
    expect(state.resources.locomotives).toBe(before + 1);
    expect(state.phase).toBe('playing');
    expect(state.upgrades).toEqual([]);
  });

  it('explains in the upgrade panel that the free locomotive has already arrived and a choice adds only one extra supply', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const panel = source.slice(source.indexOf("$('upgrade-panel').innerHTML ="), source.indexOf("if (s.phase === 'over')", source.indexOf("$('upgrade-panel').innerHTML =")));
    expect(panel).toContain('每周免费机车 ×1 已自动入库');
    expect(panel).toContain('从下方两项中任选一项额外补给');
    expect(panel).toContain('选择不会再次领取机车');
    expect(panel).toContain('s.upgrades.map((choice)');
  });
});
