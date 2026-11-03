import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
await mkdir(new URL('../dist-sdk/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/sdk.ts'],
  outfile: 'dist-sdk/index.mjs',
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'eof',
});
await build({
  absWorkingDir: root,
  entryPoints: ['src/browser.ts'],
  outfile: 'dist-sdk/browser.mjs',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  external: ['three'],
  legalComments: 'eof',
});
await writeFile(
  new URL('../dist-sdk/package.json', import.meta.url),
  JSON.stringify(
    {
      name: '@snack-lab/orchard-metro',
      version: '1.0.0',
      type: 'module',
      license: 'GPL-3.0-or-later',
      exports: {
        '.': { types: './types/sdk.d.ts', import: './index.mjs' },
        './browser': { types: './types/browser.d.ts', import: './browser.mjs' },
      },
      dependencies: { three: '^0.180.0' },
    },
    null,
    2,
  ),
);
await Promise.all(
  ['LICENSE.md', 'NOTICE.md', 'README.md', 'AGENT.md'].map((f) =>
    copyFile(new URL(`../${f}`, import.meta.url), new URL(`../dist-sdk/${f}`, import.meta.url)),
  ),
);
await copyFile(
  new URL('../NOTICE.md', import.meta.url),
  new URL('../dist/NOTICE.txt', import.meta.url),
);
await copyFile(
  new URL('../LICENSE.md', import.meta.url),
  new URL('../dist/LICENSE.txt', import.meta.url),
);
const threeLicense = await readFile(
  resolve(dirname(require.resolve('three')), '../LICENSE'),
  'utf8',
);
await writeFile(new URL('../dist/THREE-LICENSE.txt', import.meta.url), threeLicense);
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.sdk.json'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
const declarations = new URL('../dist-sdk/types/', import.meta.url);
for (const name of await readdir(declarations)) {
  if (!name.endsWith('.d.ts')) continue;
  const path = new URL(name, declarations);
  const original = await readFile(path, 'utf8');
  await writeFile(
    path,
    original.replace(
      /from (['"])(\.\.?\/[^'"]+)(['"])/g,
      (_, quote, path) => `from ${quote}${path}.js${quote}`,
    ),
  );
}
await mkdir(new URL('../dist-sdk/examples/', import.meta.url), { recursive: true });
for (const name of ['run-agent.mjs', 'http-agent.mjs']) {
  const text = await readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8');
  await writeFile(
    new URL(`../dist-sdk/examples/${name}`, import.meta.url),
    text.replace('../dist-sdk/index.mjs', '../index.mjs'),
  );
}
console.log('Built independent DOM-free SDK and browser adapter.');
// Include the corresponding source and build inputs with the redistributable SDK.
await mkdir(new URL('../dist-sdk/source/', import.meta.url), { recursive: true });
for (const dir of ['src', 'tests', 'scripts', 'examples']) {
  await cp(
    new URL(`../${dir}/`, import.meta.url),
    new URL(`../dist-sdk/source/${dir}/`, import.meta.url),
    { recursive: true },
  );
}
for (const file of [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.sdk.json',
  'vite.config.ts',
  'vitest.config.ts',
  'index.html',
  'README.md',
  'FIDELITY.md',
  'VALIDATION.md',
  'AGENT.md',
  'LICENSE.md',
  'NOTICE.md',
]) {
  await copyFile(
    new URL(`../${file}`, import.meta.url),
    new URL(`../dist-sdk/source/${file}`, import.meta.url),
  );
}
