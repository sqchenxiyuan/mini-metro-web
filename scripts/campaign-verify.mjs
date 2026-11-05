import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { runAgent, ReplayPlayer, hash, tunnelsUsed } from '../dist-sdk/index.mjs';
const results = [];
for (const city of ['orchard', 'harbor', 'islands'])
  for (const mode of ['normal', 'endless', 'extreme', 'creative'])
    for (const seed of [42, 420]) {
      const run = await runAgent({ city, mode, seed, maxTicks: 12000 });
      const player = new ReplayPlayer(run.replay),
        s = player.getState();
      assert.equal(hash(s), run.replay.finalHash);
      assert.equal(run.errors, 0);
      const population =
        s.score +
        s.stations.reduce((n, p) => n + p.queue.length, 0) +
        s.trains.reduce((n, t) => n + t.passengers.length + (t.transfer ? 1 : 0), 0);
      assert.equal(population, s.totalSpawned);
      assert.ok(tunnelsUsed(s) <= s.resources.tunnels);
      if (mode === 'endless' || mode === 'creative') assert.equal(s.tick, 12000);
      results.push({
        city,
        mode,
        seed,
        ticks: s.tick,
        score: s.score,
        stations: s.stations.length,
        phase: s.phase,
        hash: hash(s),
      });
    }
await mkdir('test-results', { recursive: true });
await writeFile(
  'test-results/campaign-report.json',
  JSON.stringify({ passed: true, runs: results.length, results }, null, 2),
);
console.log(JSON.stringify({ passed: true, runs: results.length, results }, null, 2));
