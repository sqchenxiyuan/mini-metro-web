// SPDX-License-Identifier: GPL-3.0-or-later
import { applyAction, copy, distance, RULES, station, tunnelsUsed } from './rules';
import { MAX_TICKS, Session, validateDecision } from './session';
import type { Action, Candidate, Decision, Observation, Options, Policy, Replay } from './types';

/** Structured-state heuristic baseline; deliberately independent of any model provider. */
export function dispatcherPolicy(observation: Observation): Decision {
  const s = observation.state;
  if (s.phase === 'over') return { action: { type: 'wait' }, reason: '本局已经结束。' };
  const candidates: Candidate[] = [];
  if (s.phase === 'upgrade') {
    const free = s.resources.tunnels - tunnelsUsed(s);
    const choice =
      free < 1 && s.upgrades.includes('tunnels')
        ? 'tunnels'
        : s.upgrades.includes('line')
          ? 'line'
          : s.upgrades.includes('carriage')
            ? 'carriage'
            : s.upgrades[0];
    return {
      action: { type: 'upgrade', choice },
      reason: `第 ${s.week} 周：优先补齐隧道与线路，再增加运力。当前剩余隧道 ${free}。`,
    };
  }
  const valid = (action: Action) => applyAction(copy(s), action).ok;
  const disconnected = s.stations
    .filter((p) => !s.lines.some((l) => l.stops.includes(p.id)))
    .sort((a, b) => b.queue.length - a.queue.length || a.id - b.id);
  if (!s.lines.some((l) => l.stops.length) && s.stations.length >= 3)
    return {
      action: { type: 'route', line: 0, stops: s.stations.slice(0, 3).map((p) => p.id) },
      reason: '先把三种基础形状串联，让首班车开始服务。',
    };
  if (disconnected.length) {
    const p = disconnected[0];
    let best: { action: Action; cost: number; label: string } | undefined;
    const consider = (action: Action, cost: number, label: string) => {
      if (!valid(action)) return;
      candidates.push({ label, value: -Math.round(cost * 10) / 10 });
      if (!best || cost < best.cost) best = { action, cost, label };
    };
    for (const l of s.lines) {
      if (!l.stops.length) {
        const targets = s.stations
          .filter((q) => q.id !== p.id && q.shape !== p.shape)
          .sort((a, b) => distance(p, a) - distance(p, b));
        for (const q of targets.slice(0, 4)) {
          const third = s.stations
            .filter((r) => r.shape !== q.shape && r.shape !== p.shape)
            .sort((a, b) => distance(q, a) - distance(q, b))[0];
          const stops = third ? [p.id, q.id, third.id] : [p.id, q.id];
          consider(
            { type: 'route', line: l.id, stops },
            distance(p, q) + (third ? distance(q, third) : 0) + 4,
            `新开 ${l.id + 1} 号线接入 ${p.id} 站`,
          );
        }
      } else
        for (let i = 0; i <= l.stops.length; i++) {
          const stops = [...l.stops];
          stops.splice(i, 0, p.id);
          let length = 0;
          for (let j = 1; j < stops.length; j++)
            length += distance(station(s, stops[j - 1]), station(s, stops[j]));
          let before = 0;
          for (let j = 1; j < l.stops.length; j++)
            before += distance(station(s, l.stops[j - 1]), station(s, l.stops[j]));
          consider(
            { type: 'route', line: l.id, stops, loop: l.loop },
            length - before + l.stops.length ** 2 * 0.65,
            `接入 ${l.id + 1} 号线第 ${i + 1} 站`,
          );
        }
    }
    if (best)
      return {
        action: best.action,
        reason: `${p.id} 站还未接入，有 ${p.queue.length} 位乘客等候。选择可用隧道内绕行最少的方案：${best.label}。`,
        candidates: candidates.sort((a, b) => b.value - a.value).slice(0, 8),
      };
  }
  if (s.resources.interchanges) {
    const busy = s.stations
      .filter((p) => !p.interchange)
      .sort((a, b) => b.queue.length - a.queue.length)[0];
    if (busy?.queue.length > 5)
      return {
        action: { type: 'interchange', station: busy.id },
        reason: `扩建 ${busy.id} 站，缓解 ${busy.queue.length} 人的候车压力。`,
      };
  }
  const lines = s.lines
    .filter((l) => l.stops.length)
    .map((l) => ({
      l,
      load: l.stops.reduce((sum, id) => sum + station(s, id).queue.length, 0),
      trains: s.trains.filter((t) => t.line === l.id && !t.retiring),
    }))
    .sort((a, b) => b.load / (b.trains.length || 0.2) - a.load / (a.trains.length || 0.2));
  for (const { l, load, trains } of lines) {
    if (s.resources.locomotives > 0 && (trains.length === 0 || (load > 6 && trains.length < 3))) {
      const at = [...l.stops].sort(
        (a, b) => station(s, b).queue.length - station(s, a).queue.length,
      )[0];
      return {
        action: {
          type: 'addTrain',
          line: l.id,
          station: at,
          direction: trains.length % 2 ? -1 : 1,
        },
        reason: `${l.id + 1} 号线有 ${load} 人候车，增派一列车并错开行车方向。`,
      };
    }
    const t = trains
      .filter((t) => t.carriages < RULES.maxCarriages)
      .sort((a, b) => a.carriages - b.carriages)[0];
    if (s.resources.carriages > 0 && t && load > 3)
      return {
        action: { type: 'carriage', train: t.id, delta: 1 },
        reason: `为 ${l.id + 1} 号线加挂车厢，每节多运送 6 人。`,
      };
  }
  return {
    action: { type: 'wait' },
    reason: disconnected.length
      ? '暂时没有可行的跨河连接，等待补给。'
      : '观察列车周转，保留资源应对新站。',
  };
}

export function createHttpAgent(url: string, headers: Record<string, string> = {}): Policy {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Agent URL 必须为 HTTP(S)');
  return async (observation, signal) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(observation),
      signal,
    });
    if (!response.ok) throw new Error(`Agent HTTP ${response.status}`);
    if (!response.body) throw new Error('Agent 返回空响应');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) throw new Error('Agent 响应超过 64 KiB');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (result.protocol !== observation.protocol || result.tick !== observation.tick)
      throw new Error('Agent 协议或 tick 不匹配');
    return validateDecision(result);
  };
}
export async function decide(
  policy: Policy,
  observation: Observation,
  timeoutMs = 3000,
  outerSignal?: AbortSignal,
): Promise<Decision> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('超时范围为 1–60000 ms');
  const controller = new AbortController(),
    relay = () => controller.abort(outerSignal?.reason ?? new Error('任务已取消'));
  if (outerSignal?.aborted) relay();
  outerSignal?.addEventListener('abort', relay, { once: true });
  let rejectAbort: (e: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(controller.signal.reason ?? new Error('Agent 已取消'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Agent 决策超时')), timeoutMs);
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    return validateDecision(
      await Promise.race([
        Promise.resolve().then(() => policy(copy(observation), controller.signal)),
        aborted,
      ]),
    );
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', relay);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
export async function runAgent(
  options: Options & {
    maxTicks?: number;
    interval?: number;
    policy?: Policy;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ replay: Replay; errors: number; reason: string }> {
  const {
    maxTicks = 45000,
    interval = 200,
    policy = dispatcherPolicy,
    timeoutMs = 3000,
    signal,
  } = options;
  if (
    !Number.isInteger(maxTicks) ||
    maxTicks < 1 ||
    maxTicks > MAX_TICKS ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > 1500
  )
    throw new Error('非法运行参数');
  const session = new Session(options);
  let errors = 0,
    stalled = 0;
  while (session.tick < maxTicks && session.getState().phase !== 'over' && !signal?.aborted) {
    const start = performance.now();
    try {
      const d = await decide(policy, session.observe(), timeoutMs, signal);
      if (signal?.aborted) break;
      const r = session.submit(d, 'agent', performance.now() - start);
      if (!r.ok) errors++;
    } catch (e) {
      if (signal?.aborted) break;
      errors++;
      session.submit(
        { action: { type: 'wait' }, reason: '控制器失败，保持现状。' },
        'agent',
        performance.now() - start,
        String(e).slice(0, 2000),
      );
    }
    const advanced = session.step(Math.min(interval, maxTicks - session.tick));
    stalled = advanced ? 0 : stalled + 1;
    if (stalled >= 3) break;
  }
  return {
    replay: session.exportReplay(),
    errors,
    reason: signal?.aborted
      ? 'cancelled'
      : stalled >= 3
        ? 'waiting-for-upgrade'
        : session.getState().phase === 'over'
          ? 'over'
          : 'tick-limit',
  };
}
