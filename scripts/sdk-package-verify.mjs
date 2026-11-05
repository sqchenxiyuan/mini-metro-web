import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url),
  root = resolve('test-results/sdk-consumer');
await mkdir(root, { recursive: true });
await mkdir('artifacts', { recursive: true });
// Invoke the actual npm CLI through Node, avoiding Windows .cmd shell interpolation.
const npmCli =
  process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const npm = (args, cwd = process.cwd()) =>
  execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', windowsHide: true });
const packed = JSON.parse(
  npm(['pack', './dist-sdk', '--pack-destination', 'artifacts', '--json']),
)[0];
const tarball = resolve('artifacts', packed.filename);
await writeFile(
  resolve(root, 'package.json'),
  JSON.stringify({ name: 'metro-consumer', private: true, type: 'module' }),
);
npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], root);
npm(
  ['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', '@types/node@^24.19.2'],
  root,
);
await writeFile(
  resolve(root, 'verify.mjs'),
  `
import assert from 'node:assert/strict';
Object.defineProperty(globalThis,'document',{get(){throw new Error('DOM touched by SDK');}});
const {createSession,dispatcherPolicy,ReplayPlayer,hash}=await import('@snack-lab/orchard-metro');
const s=createSession({seed:421});
for(let i=0;i<60;i++){s.submit(dispatcherPolicy(s.observe()));s.step(200);if(s.getState().phase==='over')break;}
const replay=s.exportReplay(),player=new ReplayPlayer(replay);
assert.equal(hash(player.getState()),hash(s.getState()));
assert.equal(hash(player.observationAtDecision(0).state),replay.decisions[0].observationHash);
console.log(JSON.stringify({tick:s.tick,hash:hash(s.getState()),score:s.getState().score,decisions:replay.decisions.length}));
`,
);
const node = JSON.parse(
  execFileSync(process.execPath, ['verify.mjs'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }),
);
await writeFile(
  resolve(root, 'verify.mts'),
  `
import {createSession,runAgent,ReplayPlayer,type Policy} from '@snack-lab/orchard-metro';
const session=createSession({seed:421});
const policy:Policy=async (obs,signal)=>({action:{type:'wait'},reason:String(obs.tick)+signal.aborted});
session.submit(await policy(session.observe(),new AbortController().signal));
const result=await runAgent({policy,maxTicks:200});
new ReplayPlayer(result.replay).seek(200);
`,
);
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    '--noEmit',
    '--strict',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--lib',
    'ES2023',
    '--types',
    'node',
    'verify.mts',
  ],
  { cwd: root, stdio: 'pipe', windowsHide: true },
);
await writeFile(
  resolve(root, 'index.html'),
  `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><script type="module">import {createBrowserGame} from '/node_modules/@snack-lab/orchard-metro/browser.mjs';window.game=createBrowserGame({seed:421});window.game.submit({action:{type:'route',line:0,stops:[1,2,3]},reason:'installed SDK'});window.game.step(120);document.body.textContent='Installed SDK: '+window.game.getState().tick;</script>`,
);
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      root,
      '.' + (req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0])),
    );
    if (!path.startsWith(root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.setHeader('Content-Type', /\.(m?js)$/.test(path) ? 'application/javascript' : 'text/html');
    res.end(await readFile(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.game?.getState().tick === 120);
  const browserState = await page.evaluate(() => {
    const r = window.game.exportReplay();
    window.game.loadReplay(r);
    window.game.focusDecision(0);
    const before = window.game.getState();
    window.game.seek(120);
    const after = window.game.getState();
    window.game.dispose();
    return { before: before.trains.length, after: after.trains.length };
  });
  assert.deepEqual(browserState, { before: 0, after: 1 });
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    tarball,
    node,
    types: 'NodeNext + ES2023-only, no DOM lib',
    browser: browserState,
    errors,
  };
  await writeFile('test-results/sdk-package-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
