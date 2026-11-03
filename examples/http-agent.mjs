import { createServer } from 'node:http';
import { dispatcherPolicy } from '../dist-sdk/index.mjs';
const port = Number(process.env.METRO_AGENT_PORT ?? 8789);
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, agent: 'deterministic-dispatcher' }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/decide') {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('request too large');
      chunks.push(chunk);
    }
    const observation = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      observation.protocol !== 'orchard-metro.agent.v1' ||
      observation.tick !== observation.state?.tick
    )
      throw new Error('protocol mismatch');
    const decision = dispatcherPolicy(observation);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ protocol: observation.protocol, tick: observation.tick, ...decision }),
    );
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Local HTTP Agent: http://127.0.0.1:${port}/decide`),
);
