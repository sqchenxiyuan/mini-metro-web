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
  it('accepts only a decision envelope, not arbitrary JSON or malformed actions', async () => {
    const { parseIntegrationDecision } = await import('../src/integration');
    expect(parseIntegrationDecision('{"action":{"type":"wait"}}')).toEqual({ action: { type: 'wait' } });
    expect(() => parseIntegrationDecision('{"type":"wait"}')).toThrow();
    expect(() => parseIntegrationDecision('{"action":{"type":"unknown"}}')).toThrow();
  });
});
