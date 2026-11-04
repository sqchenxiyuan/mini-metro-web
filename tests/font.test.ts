import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const style = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const font = readFileSync(new URL('../public/fonts/NotoSansSC-Regular.ttf', import.meta.url));

// This is a deployment regression: system fonts in CI/containers often lack CJK glyphs.
describe('bundled Chinese UI font', () => {
  it('loads from the Vite public directory so GitHub Pages prefixes the repository base', () => {
    expect(style).toMatch(/src:\s*url\(['"]?\/fonts\/NotoSansSC-Regular\.ttf/);
    expect(style).toContain("'Noto Sans SC Metro'");
    expect(font.length).toBeGreaterThan(100000);
  });
});
