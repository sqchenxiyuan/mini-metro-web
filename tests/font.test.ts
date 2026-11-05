import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const style = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const minimal = readFileSync(new URL('../src/minimal.css', import.meta.url), 'utf8');
const fontDir = new URL('../public/fonts/', import.meta.url);

// The app's Chinese labels must work even on machines without a CJK system font.
describe('local UI font', () => {
  it('ships a small, locally loaded WOFF2 with no external font dependency', () => {
    const assets = readdirSync(fontDir);
    expect(assets).toContain('NotoSansSC-Metro.woff2');
    expect(assets).not.toContain('NotoSansSC-Regular.ttf');
    const font = readFileSync(new URL('NotoSansSC-Metro.woff2', fontDir));
    expect(font.subarray(0, 4).toString('ascii')).toBe('wOF2');
    expect(font.length).toBeGreaterThan(10000);
    expect(font.length).toBeLessThan(1100000);
    expect(style).toMatch(/src:\s*url\(['"]?\/fonts\/NotoSansSC-Metro\.woff2['"]?\)\s*format\(['"]woff2['"]\)/);
    expect(style).toMatch(/font-family:\s*'Noto Sans SC Metro',[^;]*sans-serif/);
    expect(style + minimal).not.toMatch(/(?:url\(|@import\s+)[^;]*https?:\/\//i);
  });

  it('includes destination and map-control symbols instead of silently falling back to OS fonts', () => {
    const charset = execFileSync('fc-query', ['--format', '%{charset}',
      new URL('NotoSansSC-Metro.woff2', fontDir).pathname], { encoding: 'utf8' });
    const ranges = charset.split(/\s+/).filter(Boolean).map((s) => {
      const [low, high = low] = s.split('-');
      return [parseInt(low, 16), parseInt(high, 16)];
    });
    for (const char of '↩↺↻⌁⌂▰✦⬟⬡⬭')
      expect(ranges.some(([a, b]) => a <= char.codePointAt(0)! && char.codePointAt(0)! <= b),
        `missing U+${char.codePointAt(0)!.toString(16)} ${char}`).toBe(true);
  });
  it('preserves the font copyright and SIL license notice', () => {
    expect(readdirSync(fontDir)).toContain('OFL.txt');
    const notice = readFileSync(new URL('OFL.txt', fontDir), 'utf8');
    expect(notice).toContain('Copyright 2014-2021 Adobe');
    expect(notice).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(statSync(new URL('OFL.txt', fontDir)).size).toBeGreaterThan(1000);
    expect(readFileSync(new URL('DEJAVU-LICENSE.txt', fontDir), 'utf8')).toContain('Bitstream Vera');
    expect(readFileSync(new URL('NOTO-SYMBOLS-OFL.txt', fontDir), 'utf8')).toContain('The Noto Project Authors');
  });
});

describe('UI typography', () => {
  it('sets a readable base size for desktop and small-screen labels', () => {
    expect(style).toMatch(/font-size:\s*clamp\(14px,\s*[^;]*16px\)/);
    expect(minimal).toMatch(/\.city-heading strong\s*\{[^}]*font-size:\s*1[34]px/s);
    expect(minimal).toMatch(/\.resources span\s*\{[^}]*font-size:\s*1[23]px/s);
    expect(minimal).toMatch(/\.right-panel \.tabs button\s*\{[^}]*font-size:\s*1[34]px/s);
    expect(minimal).toMatch(/\.line-detail \.train-row\s*\{[^}]*font-size:\s*1[23]px/s);
  });
});
