// SPDX-License-Identifier: GPL-3.0-or-later
import {
  advance,
  applyAction,
  copy,
  createState,
  hash,
  normalizeAction,
  RULES,
  tunnelsUsed,
} from './rules';
import type {
  ActionResult,
  Checkpoint,
  Decision,
  Observation,
  Options,
  Record,
  Replay,
  ServiceEvent,
  State,
} from './types';

export const MAX_TICKS = 1080000; // Six hours at 50 Hz; a replay safety limit, not a win condition.
export const MAX_REPLAY_BYTES = 32 * 1024 * 1024;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function validateDecision(value: Decision): Decision {
  if (!value || typeof value !== 'object') throw new Error('缺少 decision');
  const action = normalizeAction(value.action);
  if (
    value.reason !== undefined &&
    (typeof value.reason !== 'string' || value.reason.length > 2000)
  )
    throw new Error('reason 最多 2000 字符');
  if (
    value.candidates !== undefined &&
    (!Array.isArray(value.candidates) ||
      value.candidates.length > 20 ||
      value.candidates.some(
        (c) =>
          !c || typeof c.label !== 'string' || c.label.length > 120 || !Number.isFinite(c.value),
      ))
  )
    throw new Error('非法候选决策');
  return {
    action,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    ...(value.candidates ? { candidates: copy(value.candidates) } : {}),
  };
}
export function observeState(state: State): Observation {
  return {
    protocol: 'orchard-metro.agent.v1',
    tick: state.tick,
    state: copy(state),
    budget: {
      freeTunnels: state.resources.tunnels - tunnelsUsed(state),
      trainCapacity: RULES.capacity,
      crowdLimit: RULES.crowdLimit,
      tickSeconds: 1 / RULES.hz,
    },
  };
}
export class Session {
  private state: State;
  private recording: Replay;
  private serviceEvents: ServiceEvent[] = [];
  drainServiceEvents(): ServiceEvent[] {
    return this.serviceEvents.splice(0);
  }
  constructor(options: Options = {}) {
    this.state = createState(options);
    this.recording = {
      format: 'orchard-metro.replay.v6',
      createdAt: new Date().toISOString(),
      options: { seed: this.state.seed, city: this.state.city, mode: this.state.mode },
      duration: 0,
      decisions: [],
      checkpoints: [],
      finalHash: hash(this.state),
    };
    this.checkpoint();
  }
  private checkpoint(): void {
    this.recording.checkpoints.push({
      tick: this.state.tick,
      cursor: this.recording.decisions.length,
      state: copy(this.state),
      hash: hash(this.state),
    });
  }
  getState(): State {
    return copy(this.state);
  }
  get tick(): number {
    return this.state.tick;
  }
  get decisions(): Record[] {
    return copy(this.recording.decisions);
  }
  get lastDecision(): Record | undefined {
    const d = this.recording.decisions.at(-1);
    return d ? copy(d) : undefined;
  }
  observe(): Observation {
    return observeState(this.state);
  }
  submit(value: Decision, source = 'script', elapsedMs = 0, error?: string): ActionResult {
    const d = validateDecision(value);
    if (
      typeof source !== 'string' ||
      source.length > 80 ||
      !Number.isFinite(elapsedMs) ||
      elapsedMs < 0 ||
      (error !== undefined && (typeof error !== 'string' || error.length > 2000))
    )
      throw new Error('非法决策元数据');
    if (this.recording.decisions.length >= 50000)
      throw new Error('决策达到 50000 条上限，请保存并开新局');
    const before = hash(this.state),
      result = applyAction(this.state, d.action);
    this.recording.decisions.push({
      ...d,
      id: this.recording.decisions.length,
      tick: this.tick,
      source,
      elapsedMs,
      observationHash: before,
      afterHash: hash(this.state),
      result,
      ...(error ? { error } : {}),
    });
    return copy(result);
  }
  step(ticks = 1): number {
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > MAX_TICKS) throw new Error('非法步数');
    let advanced = 0;
    for (let i = 0; i < ticks; i++) {
      if (this.tick >= MAX_TICKS) throw new Error('达到六小时回放安全上限');
      if (!advance(this.state, (event) => this.serviceEvents.push(event))) break;
      // Keep the current step's full service burst, but discard old visual frames.
      if (this.serviceEvents.length && this.serviceEvents[0].tick < this.tick - 7)
        this.serviceEvents = this.serviceEvents.filter((event) => event.tick >= this.tick - 7);
      advanced++;
      if (this.tick % 1500 === 0) this.checkpoint();
    }
    return advanced;
  }
  exportReplay(): Replay {
    const result = copy(this.recording);
    result.duration = this.tick;
    result.finalHash = hash(this.state);
    return result;
  }
}
export function createSession(options: Options = {}): Session {
  return new Session(options);
}

function stepUntil(s: State, tick: number): void {
  while (s.tick < tick)
    if (!advance(s)) throw new Error(`录像在 tick ${s.tick} 停止，无法推进至 ${tick}`);
}
/** Imports re-simulate everything. Untrusted checkpoints never become authoritative state. */
export class ReplayPlayer {
  readonly replay: Replay;
  private trusted: Checkpoint[] = [];
  private state: State;
  constructor(raw: Replay | string) {
    const json = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (new TextEncoder().encode(json).byteLength > MAX_REPLAY_BYTES)
      throw new Error('录像超过 32 MiB');
    const r = JSON.parse(json) as Replay;
    if (
      !r ||
      r.format !== 'orchard-metro.replay.v6' ||
      typeof r.createdAt !== 'string' ||
      r.createdAt.length > 40 ||
      !Number.isFinite(Date.parse(r.createdAt)) ||
      !r.options ||
      !Number.isInteger(r.options.seed) ||
      typeof r.options.city !== 'string' ||
      typeof r.options.mode !== 'string' ||
      !Number.isInteger(r.duration) ||
      r.duration < 0 ||
      r.duration > MAX_TICKS ||
      !Array.isArray(r.decisions) ||
      r.decisions.length > 50000 ||
      !Array.isArray(r.checkpoints) ||
      r.checkpoints.length > MAX_TICKS / 1500 + 1 ||
      typeof r.finalHash !== 'string'
    )
      throw new Error('录像结构不合法');
    const s = createState(r.options),
      verified: Record[] = [];
    const cps = r.checkpoints;
    if (!cps.length || cps[0]?.tick !== 0 || cps[0]?.cursor !== 0)
      throw new Error('录像缺少初始检查点');
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i];
      if (
        !c ||
        !Number.isInteger(c.tick) ||
        c.tick < 0 ||
        c.tick > r.duration ||
        !Number.isInteger(c.cursor) ||
        c.cursor < 0 ||
        c.cursor > r.decisions.length ||
        (i && (c.tick < cps[i - 1].tick || c.cursor < cps[i - 1].cursor))
      )
        throw new Error('检查点顺序不合法');
    }
    let cursor = 0,
      cp = 0;
    const check = () => {
      while (cp < cps.length && cps[cp].tick === s.tick && cps[cp].cursor === cursor) {
        const c = cps[cp++];
        if (c.hash !== hash(s) || hash(c.state) !== c.hash)
          throw new Error('检查点与操作重算不一致');
        this.trusted.push({ tick: s.tick, cursor, state: copy(s), hash: hash(s) });
      }
    };
    check();
    while (cursor < r.decisions.length) {
      const d = r.decisions[cursor];
      if (
        !d ||
        d.id !== cursor ||
        !Number.isInteger(d.tick) ||
        d.tick < s.tick ||
        d.tick > r.duration ||
        typeof d.source !== 'string' ||
        d.source.length > 80 ||
        !Number.isFinite(d.elapsedMs) ||
        d.elapsedMs < 0 ||
        (d.error !== undefined && (typeof d.error !== 'string' || d.error.length > 2000))
      )
        throw new Error('决策记录不合法');
      while (s.tick < d.tick) {
        stepUntil(s, s.tick + 1);
        check();
      }
      const clean = validateDecision(d);
      if (d.observationHash !== hash(s)) throw new Error(`决策 ${cursor} 的观察与重算不一致`);
      const result = applyAction(s, clean.action);
      if (d.afterHash !== hash(s) || JSON.stringify(result) !== JSON.stringify(d.result))
        throw new Error(`决策 ${cursor} 的执行结果不一致`);
      verified.push({ ...d, ...clean, result });
      cursor++;
      check();
    }
    while (s.tick < r.duration) {
      stepUntil(s, s.tick + 1);
      check();
    }
    if (cp !== cps.length || hash(s) !== r.finalHash) throw new Error('录像最终状态或检查点不一致');
    if (!this.trusted.length)
      this.trusted.push({
        tick: 0,
        cursor: 0,
        state: createState(r.options),
        hash: hash(createState(r.options)),
      });
    this.replay = freeze({ ...r, decisions: verified });
    this.state = s;
  }
  private reconstruct(tick: number, untilCursor: number): State {
    const c = [...this.trusted].reverse().find((c) => c.tick <= tick && c.cursor <= untilCursor)!;
    const s = copy(c.state);
    for (let i = c.cursor; i < untilCursor; i++) {
      const d = this.replay.decisions[i];
      stepUntil(s, d.tick);
      applyAction(s, d.action);
    }
    stepUntil(s, tick);
    return s;
  }
  seek(tick: number): State {
    if (!Number.isFinite(tick)) throw new Error('非法回放时间');
    tick = Math.max(0, Math.min(this.replay.duration, Math.floor(tick)));
    const cursor = this.replay.decisions.findIndex((d) => d.tick > tick);
    this.state = this.reconstruct(tick, cursor < 0 ? this.replay.decisions.length : cursor);
    return this.getState();
  }
  observationAtDecision(index: number): Observation {
    if (!Number.isInteger(index) || index < 0 || index >= this.replay.decisions.length)
      throw new Error('决策不存在');
    return observeState(this.reconstruct(this.replay.decisions[index].tick, index));
  }
  getState(): State {
    return copy(this.state);
  }
}
