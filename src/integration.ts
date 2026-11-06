// SPDX-License-Identifier: GPL-3.0-or-later
import { validateDecision } from './session';
import { dispatcherPolicy } from './agent';
import type { ActionResult, Decision, Observation, Options, State } from './types';

/** Public integration controls configure an existing game, not its rule constants. */
export function parseIntegrationOptions(input: { seed: string; city: string; mode: string }): Options {
  const seed = Number(input.seed);
  if (!/^(0|[1-9]\d*)$/.test(input.seed) || !Number.isSafeInteger(seed) || seed > 0xffffffff)
    throw new Error('种子必须是 0–4294967295 的整数');
  if (!['orchard', 'harbor', 'islands'].includes(input.city)) throw new Error('未知地图');
  if (!['normal', 'endless', 'extreme', 'creative'].includes(input.mode)) throw new Error('未知模式');
  return { seed, city: input.city as Options['city'], mode: input.mode as Options['mode'] };
}

export function parseStepTicks(input: string): number {
  const ticks = Number(input);
  if (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(ticks) || ticks > 5000)
    throw new Error('每次只能推进 1–5000 个 tick');
  return ticks;
}

/** External action textarea uses the same validated decision contract as SDK/HTTP. */
export function parseIntegrationDecision(text: string): Decision {
  return validateDecision(JSON.parse(text) as Decision);
}

type IntegrationGame = {
  getState(): State;
  restart(options: Options): void;
  pause(value?: boolean): void;
  step(ticks?: number): State;
  controller: { paused: boolean; speed: number; setSpeed(value: number): void; mode: string; activeAgentSource: string | null };
  startAgent(policy?: typeof dispatcherPolicy, source?: string): void;
  observe(): Observation;
  submit(decision: Decision, source?: string): ActionResult;
  capture(): string;
  connectHttp(url: string): void;
  stopAgent(): void;
};

function attachIntegrationControls(game: IntegrationGame): void {
  const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const runtime = get<HTMLElement>('integration-runtime-state');
  const runtimeError = get<HTMLElement>('integration-runtime-error');
  const presetStart = get<HTMLButtonElement>('integration-preset-start');
  const presetStop = get<HTMLButtonElement>('integration-preset-stop');
  const isPreset = (): boolean => game.controller.activeAgentSource === 'preset-dispatcher';
  const syncPreset = (): void => {
    presetStart.disabled = isPreset() || game.controller.mode === 'replay';
    presetStop.disabled = !isPreset();
  };
  const refresh = (): void => {
    const s = game.getState();
    runtime.textContent = `${s.city} · ${s.mode} · tick ${s.tick} · ${game.controller.paused ? '暂停' : '运行中'} · ${game.controller.speed}× · ${s.phase}${game.controller.activeAgentSource ? ` · 控制：${game.controller.activeAgentSource}` : ''}`;
    const speed = String(game.controller.speed);
    get<HTMLSelectElement>('integration-speed').value = speed;
    document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
      const active = button.dataset.speed === speed;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    syncPreset();
  };
  refresh();
  // The game may run while the operator watches; keep status current without mutating state.
  const timer = window.setInterval(refresh, 500);
  window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
  presetStart.onclick = () => {
    try {
      game.startAgent(dispatcherPolicy, 'preset-dispatcher');
      runtimeError.textContent = '';
      refresh();
      runtime.textContent += ' · 预制策略已运行';
    } catch (error) { runtimeError.textContent = String(error); syncPreset(); }
  };
  presetStop.onclick = () => {
    if (!isPreset()) return;
    game.stopAgent();
    game.pause(true);
    refresh();
    runtime.textContent += ' · 预制策略已停止';
  };
  get<HTMLButtonElement>('integration-restart').onclick = () => {
    try {
      const options = parseIntegrationOptions({
        seed: get<HTMLInputElement>('integration-seed').value,
        city: get<HTMLSelectElement>('integration-city').value,
        mode: get<HTMLSelectElement>('integration-mode').value,
      });
      game.restart(options);
      runtimeError.textContent = '';
      refresh();
      runtime.textContent += ' · 新局已创建';
    } catch (error) { runtimeError.textContent = String(error); }
  };
  get<HTMLButtonElement>('integration-play').onclick = () => { game.pause(false); refresh(); };
  get<HTMLButtonElement>('integration-pause').onclick = () => { game.pause(true); refresh(); };
  get<HTMLSelectElement>('integration-speed').onchange = (event) => {
    try { game.controller.setSpeed(Number((event.target as HTMLSelectElement).value)); refresh(); }
    catch (error) { runtimeError.textContent = String(error); }
  };
  get<HTMLButtonElement>('integration-step').onclick = () => {
    try {
      const ticks = parseStepTicks(get<HTMLInputElement>('integration-ticks').value);
      game.pause(true);
      const state = game.step(ticks);
      refresh();
      runtime.textContent += ` · 已推进 ${ticks} tick 至 ${state.tick}`;
      runtimeError.textContent = '';
    } catch (error) { runtimeError.textContent = String(error); }
  };
  const status = get<HTMLElement>('integration-status');
  get<HTMLButtonElement>('integration-observe').onclick = () => {
    try {
      get<HTMLElement>('integration-observation').textContent = JSON.stringify(game.observe(), null, 2);
      status.textContent = '已读取当前结构化观察。';
    } catch (error) { status.textContent = String(error); }
  };
  get<HTMLButtonElement>('integration-capture').onclick = () => {
    try {
      const image = get<HTMLImageElement>('integration-image');
      image.src = game.capture();
      image.hidden = false;
      status.textContent = '已截取当前游戏画面（未上传）。';
    } catch (error) { status.textContent = String(error); }
  };
  get<HTMLButtonElement>('integration-submit').onclick = () => {
    try {
      const decision = parseIntegrationDecision(get<HTMLTextAreaElement>('integration-decision').value);
      const result = game.submit(decision, 'integration-manual');
      status.textContent = result.message;
    } catch (error) { status.textContent = String(error); }
  };
  get<HTMLButtonElement>('integration-connect').onclick = () => {
    try {
      game.connectHttp(get<HTMLInputElement>('integration-agent-url').value.trim());
      refresh();
      status.textContent = 'HTTP Agent 已接入；外部服务将收到完整结构化状态。';
    } catch (error) { status.textContent = String(error); }
  };
  get<HTMLButtonElement>('integration-stop').onclick = () => {
    game.stopAgent();
    status.textContent = '已切回手动控制。';
  };
}

if (typeof document !== 'undefined' && document.querySelector('meta[name="metro-surface"][content="integration"]')) {
  // Shared main.ts registers window.metro after its module has booted; never instantiate a second game.
  const started = performance.now();
  const bind = (): void => {
    const game = (window as unknown as { metro?: IntegrationGame }).metro;
    if (game) attachIntegrationControls(game);
    else if (performance.now() - started < 10000) window.setTimeout(bind, 30);
    else document.getElementById('integration-status')!.textContent = '游戏入口未启动，无法连接 AI 控件。';
  };
  bind();
}
