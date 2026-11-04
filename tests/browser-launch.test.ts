import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-ignore — browser launch helper is a Node ESM script, exercised by this test.
import { browserLaunchOptions } from '../scripts/browser-launch.mjs';

const entry = readFileSync(new URL('../scripts/browser-verify.mjs', import.meta.url), 'utf8');

describe('browser verification launch configuration', () => {
  it('uses the portable launcher in the actual browser verification entry', () => {
    expect(entry).toMatch(/chromium\.launch\(browserLaunchOptions\(\)\)/);
    expect(entry).not.toMatch(/channel:\s*['"]chrome['"]/);
  });
  it('uses Playwright-managed Chromium by default instead of system Chrome', () => {
    expect(browserLaunchOptions({})).toEqual({ headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  });

  it('allows an explicit browser executable without pinning any host path', () => {
    expect(browserLaunchOptions({ METRO_BROWSER_EXECUTABLE_PATH: '/custom/browser' })).toEqual({
      headless: true,
      executablePath: '/custom/browser',
      args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'],
    });
  });

  it('ignores an empty override', () => {
    expect(browserLaunchOptions({ METRO_BROWSER_EXECUTABLE_PATH: '  ' })).toEqual({ headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  });
});
