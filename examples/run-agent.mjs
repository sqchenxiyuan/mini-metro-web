import { mkdir, writeFile } from 'node:fs/promises';
import { runAgent, ReplayPlayer, hash } from '../dist-sdk/index.mjs';
const seed = Number(process.argv[2] ?? 420),
  maxTicks = Number(process.argv[3] ?? 24000);
const result = await runAgent({ seed, maxTicks });
const player = new ReplayPlayer(result.replay),
  state = player.seek(result.replay.duration);
await mkdir('test-results', { recursive: true });
await writeFile(`test-results/agent-${seed}.json`, JSON.stringify(result.replay));
console.log(
  JSON.stringify(
    {
      seed,
      ticks: state.tick,
      week: state.week,
      score: state.score,
      stations: state.stations.length,
      phase: state.phase,
      reason: result.reason,
      errors: result.errors,
      decisions: result.replay.decisions.length,
      hash: hash(state),
    },
    null,
    2,
  ),
);
