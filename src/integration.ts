// SPDX-License-Identifier: GPL-3.0-or-later
import { validateDecision } from './session';
import type { ActionResult, Decision, Observation } from './types';

/** External action textarea uses the same validated decision contract as SDK/HTTP. */
export function parseIntegrationDecision(text: string): Decision {
  return validateDecision(JSON.parse(text) as Decision);
}

type IntegrationGame = {
  observe(): Observation;
  submit(decision: Decision, source?: string): ActionResult;
  capture(): string;
  connectHttp(url: string): void;
  stopAgent(): void;
};

function attachIntegrationControls(game: IntegrationGame): void {
  const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
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
