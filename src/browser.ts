// SPDX-License-Identifier: GPL-3.0-or-later
import { createHttpAgent, decide, dispatcherPolicy } from './agent';
import { RULES } from './rules';
import { ReplayPlayer, Session } from './session';
import type {
  ActionResult,
  Decision,
  Observation,
  Options,
  Policy,
  Record,
  Replay,
  ServiceEvent,
  State,
} from './types';

/** One presentation frame, detached from simulation state and replay authority. */
export interface RenderSnapshot {
  state: State;
  events: ServiceEvent[];
  motion: { previous: State | null; alpha: number };
}

export class MetroController {
  private session: Session;
  private player: ReplayPlayer | null = null;
  private replayTick = 0;
  private focusedState: State | null = null;
  focusedDecision: number | null = null;
  private policy: Policy | null = null;
  private source = 'baseline';
  private pending: AbortController | null = null;
  private epoch = 0;
  private nextDecision = 0;
  private failures = 0;
  private last = 0;
  private accumulator = 0;
  private previousMotion: State | null = null;
  /** Visual-only one-tick-lag interpolation; never feeds the simulation or replay. */
  get motion(): { previous: State | null; alpha: number } {
    // A one-tick-late image needs the preceding state even on frames with no tick.
    // Reset to the current state whenever simulation cadence skips that pair.
    return { previous: this.paused || this.player || this.focusedState ? null : this.previousMotion,
      alpha: this.accumulator };
  }
  private frame = 0;
  private disposed = false;
  paused = true;
  speed = 1;
  selectedLine = 0;
  onChange: () => void = () => {};
  capture: () => string = () => '';
  drainServiceEvents(): ServiceEvent[] {
    if (this.player || this.focusedState) {
      this.session.drainServiceEvents();
      return [];
    }
    return this.session.drainServiceEvents();
  }
  /** Consume a coherent frame after the controller's logic tick, never during it. */
  getRenderSnapshot(): RenderSnapshot {
    const motion = this.motion;
    return {
      state: this.getState(),
      events: structuredClone(this.drainServiceEvents()),
      motion: { previous: motion.previous ? structuredClone(motion.previous) : null, alpha: motion.alpha },
    };
  }
  constructor(options: Options = {}) {
    this.session = new Session(options);
    this.frame = requestAnimationFrame(this.loop);
  }
  get mode(): 'human' | 'agent' | 'replay' {
    return this.player ? 'replay' : this.policy ? 'agent' : 'human';
  }
  get waiting(): boolean {
    return !!this.pending;
  }
  get decisions(): Record[] {
    return this.player ? this.player.replay.decisions : this.session.decisions;
  }
  get replayDuration(): number {
    return this.player?.replay.duration ?? this.session.tick;
  }
  getState(): State {
    return this.focusedState
      ? structuredClone(this.focusedState)
      : this.player
        ? this.player.getState()
        : this.session.getState();
  }
  observe(): Observation {
    if (this.player) throw new Error('回放观察请使用 observationAtDecision');
    return this.session.observe();
  }
  submit(decision: Decision, source = 'script'): ActionResult {
    if (this.player) throw new Error('回放模式不能操作，请返回新局');
    this.takeControl();
    const result = this.session.submit(decision, source);
    this.previousMotion = null;
    this.onChange();
    return result;
  }
  step(ticks = 1): State {
    if (this.player) throw new Error('回放模式请使用 seek');
    this.takeControl();
    this.paused = true;
    this.session.step(ticks);
    this.previousMotion = null;
    this.onChange();
    return this.getState();
  }
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.cancel();
    else {
      this.focusedState = null;
      this.focusedDecision = null;
    }
    this.accumulator = 0;
    this.previousMotion = null;
    this.onChange();
  }
  setSpeed(speed: number): void {
    if (![1, 2, 4].includes(speed)) throw new Error('倍速为 1 / 2 / 4');
    this.speed = speed;
    this.onChange();
  }
  private cancel(): void {
    this.epoch++;
    this.pending?.abort(new Error('控制权已切换'));
    this.pending = null;
  }
  takeControl(): void {
    this.cancel();
    this.policy = null;
    this.previousMotion = null;
    this.failures = 0;
    this.onChange();
  }
  restart(options: Options = {}): void {
    const session = new Session(options);
    this.cancel();
    this.policy = null;
    this.player = null;
    this.focusedState = null;
    this.focusedDecision = null;
    this.session = session;
    this.selectedLine = 0;
    this.paused = true;
    this.accumulator = 0;
    this.previousMotion = null;
    this.onChange();
  }
  startAgent(policy: Policy = dispatcherPolicy, source = 'dispatcher-baseline'): void {
    if (this.player) throw new Error('请先退出回放');
    this.cancel();
    this.policy = policy;
    this.previousMotion = null;
    this.source = source;
    this.nextDecision = this.session.tick;
    this.failures = 0;
    this.paused = false;
    this.onChange();
  }
  connectHttp(url: string): void {
    this.startAgent(createHttpAgent(url), 'http-agent');
  }
  exportReplay(): Replay {
    return this.player ? structuredClone(this.player.replay) : this.session.exportReplay();
  }
  loadReplay(replay: Replay | string): void {
    const player = new ReplayPlayer(replay);
    this.cancel();
    this.policy = null;
    this.focusedState = null;
    this.focusedDecision = null;
    this.player = player;
    this.replayTick = 0;
    this.player.seek(0);
    this.selectedLine = 0;
    this.paused = true;
    this.accumulator = 0;
    this.previousMotion = null;
    this.onChange();
  }
  seek(tick: number): State {
    if (!this.player) throw new Error('尚未加载录像');
    this.focusedState = null;
    this.focusedDecision = null;
    const s = this.player.seek(tick);
    this.previousMotion = null;
    this.replayTick = s.tick;
    this.onChange();
    return s;
  }
  focusDecision(index: number): State {
    if (!this.player) this.loadReplay(this.session.exportReplay());
    const observation = this.player!.observationAtDecision(index);
    this.paused = true;
    this.focusedDecision = index;
    this.focusedState = observation.state;
    this.previousMotion = null;
    this.replayTick = observation.tick;
    this.player!.seek(observation.tick);
    this.onChange();
    return this.getState();
  }
  observationAtDecision(index: number): Observation {
    const p = this.player ?? new ReplayPlayer(this.session.exportReplay());
    return p.observationAtDecision(index);
  }
  private async ask(): Promise<void> {
    if (!this.policy || this.pending) return;
    const controller = new AbortController(),
      epoch = this.epoch,
      policy = this.policy,
      start = performance.now();
    this.pending = controller;
    this.previousMotion = null;
    this.onChange();
    try {
      const d = await decide(policy, this.session.observe(), 5000, controller.signal);
      if (epoch !== this.epoch || controller.signal.aborted) return;
      const r = this.session.submit(d, this.source, performance.now() - start);
      this.previousMotion = null;
      this.failures = r.ok ? 0 : this.failures + 1;
    } catch (e) {
      if (epoch !== this.epoch || controller.signal.aborted) return;
      this.failures++;
      this.session.submit(
        { action: { type: 'wait' }, reason: '控制器未返回有效决策，保持局面。' },
        this.source,
        performance.now() - start,
        String(e).slice(0, 2000),
      );
      this.previousMotion = null;
    } finally {
      if (epoch === this.epoch) {
        this.pending = null;
        this.nextDecision = this.session.tick + 200;
        if (this.failures >= 3) {
          this.policy = null;
          this.paused = true;
        }
        this.onChange();
      }
    }
  }
  private loop = (now: number): void => {
    if (this.disposed) return;
    const delta = this.last ? Math.min(0.15, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.paused) {
      if (this.player) {
        this.replayTick = Math.min(
          this.player.replay.duration,
          this.replayTick + delta * RULES.hz * this.speed,
        );
        this.player.seek(Math.floor(this.replayTick));
        if (this.replayTick >= this.player.replay.duration) this.paused = true;
      } else if (
        this.policy &&
        !this.pending &&
        (this.session.tick >= this.nextDecision || this.session.getState().phase === 'upgrade')
      )
        void this.ask();
      else if (!this.pending) {
        this.accumulator += delta * RULES.hz * this.speed;
        const ticks = Math.floor(this.accumulator);
        this.accumulator -= ticks;
        if (ticks > 0) {
          const before = this.session.getState();
          const advanced = this.session.step(ticks);
          this.previousMotion = advanced === 1 ? before : null;
        }
      }
    }
    this.onChange();
    this.frame = requestAnimationFrame(this.loop);
  };
  dispose(): void {
    this.disposed = true;
    this.cancel();
    cancelAnimationFrame(this.frame);
  }
}
export function createBrowserGame(options: Options = {}): MetroController {
  return new MetroController(options);
}
