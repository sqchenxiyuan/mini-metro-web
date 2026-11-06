import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';


const html = () => readFile(new URL('../integration.html', import.meta.url), 'utf8');

describe('separate integration surface', () => {
  it('boots the shared game inside a centered shell and places AI settings outside #app', async () => {
    const page = await html();
    expect(page).toContain('<meta name="metro-surface" content="integration"');
    expect(page).toMatch(/<section[^>]+id="game-shell"[^>]*>\s*<div id="app"><\/div>\s*<\/section>/);
    expect(page).toContain('id="integration-controls"');
    expect(page.indexOf('id="integration-controls"')).toBeGreaterThan(page.indexOf('</section>'));
    expect(page).toContain('src="/src/main.ts"');
    expect(page).toContain('src="/src/integration.ts"');
  });
  it('places an immediately visible runtime panel before the game with map/mode/seed and simulation controls', async () => {
    const page = await html();
    expect(page.indexOf('id="integration-runtime"')).toBeLessThan(page.indexOf('id="game-shell"'));
    for (const id of ['integration-city','integration-mode','integration-seed','integration-restart',
      'integration-play','integration-pause','integration-speed','integration-ticks','integration-step'])
      expect(page).toContain(`id="${id}"`);
    expect(page).toMatch(/body:has\(#integration-runtime\)\s*\{[^}]*overflow:\s*visible/);
    expect(page).toContain('id="integration-runtime-error"');
  });
  it('validates explicit game settings and simulation step amounts', async () => {
    const { parseIntegrationOptions, parseStepTicks } = await import('../src/integration');
    expect(parseIntegrationOptions({ seed: '421', city: 'harbor', mode: 'endless' }))
      .toEqual({ seed: 421, city: 'harbor', mode: 'endless' });
    expect(() => parseIntegrationOptions({ seed: '-1', city: 'harbor', mode: 'endless' })).toThrow();
    expect(() => parseIntegrationOptions({ seed: '3.5', city: 'harbor', mode: 'endless' })).toThrow();
    expect(() => parseIntegrationOptions({ seed: '1', city: 'fake', mode: 'endless' })).toThrow();
    expect(parseStepTicks('50')).toBe(50);
    expect(() => parseStepTicks('0')).toThrow();
    expect(() => parseStepTicks('50000')).toThrow();
  });
  it('accepts only a decision envelope, not arbitrary JSON or malformed actions', async () => {
    const { parseIntegrationDecision } = await import('../src/integration');
    expect(parseIntegrationDecision('{"action":{"type":"wait"}}')).toEqual({ action: { type: 'wait' } });
    expect(() => parseIntegrationDecision('{"type":"wait"}')).toThrow();
    expect(() => parseIntegrationDecision('{"action":{"type":"unknown"}}')).toThrow();
  });
});
