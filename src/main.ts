// SPDX-License-Identifier: GPL-3.0-or-later
import './style.css';
import './minimal.css';
import './mobile-map.css';
import { MetroController } from './browser';
import { hitTestVisibleLane, MetroRenderer } from './renderer';
import { layoutSceneCues } from './overlay-layout';
import { creativeStationPicker } from './station-picker';
import { Mobile3DRenderer } from './mobile-3d';
import { breakLoopEdge, endpointStep, extensionStops, removedRouteEdges, safeLoopRelease } from './route-gestures';
import { MetroAudio } from './audio';
import { observeState } from './session';
import {
  CITY_NAMES,
  GLYPHS,
  LINE_COLORS,
  RULES,
  SHAPES,
  UPGRADE_NAMES,
  applyAction,
  copy,
  hash,
  stationCapacity,
  trackPoints,
  trackPosition,
  tunnelsUsed,
} from './rules';
import type { Action, City, Mode, Options, Replay, Shape, State } from './types';

const integrationSurface = document.querySelector('meta[name="metro-surface"][content="integration"]') !== null;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header class="topbar">
  <span class="brand" aria-hidden="true"></span>
  <div class="city-heading"><strong id="city-name">河湾新城</strong><span id="mode-label">经典模式</span></div>
  <div class="score-block"><span class="score-icon">♧</span><div><strong id="score">0</strong><span>已送达乘客</span></div></div>
  <div class="header-actions"><button id="map-first-toggle" class="text-button" type="button" aria-label="切换地图优先视图" aria-pressed="false" title="地图优先视图 (M)">地图</button><button id="new-game" class="text-button">新局</button><button id="tools-toggle" class="text-button" aria-expanded="false" aria-controls="inspector" ${integrationSurface ? '' : 'hidden'}>调度</button><button id="replay-toggle" class="text-button" aria-expanded="false" aria-controls="inspector" ${integrationSurface ? '' : 'hidden'}>回放</button><button id="help" class="icon-button" title="游玩说明">?</button></div>
  <button id="queue-browser-toggle" type="button" aria-haspopup="dialog" aria-controls="queue-browser" aria-label="查看各站候车目的地">候车</button>
</header>
<main class="workspace">
  <aside class="left-panel">
    <button id="line-chooser" type="button" aria-label="选择线路" aria-controls="line-list" aria-expanded="false"></button>
    <div id="line-list" class="line-list" aria-label="选择线路"></div>
    <button id="line-tools-toggle" class="icon-button" title="线路工具" aria-label="线路工具" aria-expanded="false" aria-controls="line-tools">···</button>
    <div id="line-tools" class="line-detail" hidden>
      <div class="detail-title"><i id="line-dot"></i><strong id="line-name">红线</strong><span id="line-length"></span><button id="line-tools-close" class="text-button" aria-label="收起线路工具">×</button></div>
      <p id="route-text">从一座车站拖到另一座，画出第一条线路。</p>
      <div class="button-pair"><button id="redraw">重画线路</button><button id="loop-line">闭合环线</button></div>
      <div class="button-pair"><button id="add-train">＋ 派列车</button><button id="clear-line" class="subtle">撤销线路</button></div>
      <div id="train-list" class="train-list"></div>
    </div>
  </aside>
  <section class="map-panel" aria-label="地铁地图">
    <div class="map-heading"><div><span class="live-dot"></span><span id="map-status">准备出发</span></div><span id="week-label">第 1 周 · 星期一</span></div>
    <div id="stage" tabindex="0" role="region" aria-label="地铁地图，方向键移动视野"><div id="station-layer"></div><div id="train-layer"></div><div id="context-actions" class="context-actions" hidden></div></div>
    <button id="mobile-crowd-alert" type="button" hidden>拥挤车站</button>
    <button id="map-alerts" type="button" aria-label="查看地图拥挤车站" hidden></button>
    <div id="station-peek" role="status" aria-live="polite" hidden></div>
    <div id="train-detail" class="train-detail" hidden></div>
    <div class="map-tools"><button id="zoom-out" title="缩小">−</button><button id="zoom-reset" title="恢复视野">⌂</button><button id="zoom-in" title="放大">＋</button><button id="screenshot" title="保存地图截图">▧</button></div>
    <div id="creative-picker" class="creative-picker" hidden></div>
    <div id="map-hint" class="map-hint"><span>拖过车站，连起第一条线路。</span></div>
    <div id="toast" role="status"></div>
    <div id="upgrade-panel" class="floating-overlay" hidden></div>
    <div id="game-over" class="floating-overlay" hidden></div>
    <div id="postgame-replay" class="postgame-replay" hidden><label>回放时间 <input id="postgame-timeline" type="range" min="0" max="1" value="0" aria-label="结算后回放时间"/></label><button id="postgame-play" type="button">播放</button><button id="postgame-restart" type="button">相同种子重试</button><button id="postgame-new" type="button">新局</button></div>
  </section>
  <aside id="inspector" class="right-panel" hidden aria-label="调度与回放" ${integrationSurface ? '' : 'inert'}>
    <div id="inspector-resources" class="inspector-resources" aria-label="剩余调度资源"></div>
    <div class="tabs"><button id="tab-dispatch" class="active">调度</button><button id="tab-replay">回放</button><button id="inspector-close" class="text-button" aria-label="收起面板">×</button></div>
    <section id="dispatch-pane">
      <div id="station-detail" class="station-detail" hidden></div>
      ${integrationSurface ? `<div class="agent-controls"><div class="section-heading"><span>自动调度</span><span class="agent-tag">AGENT</span></div><p>内置启发式策略。操作与公开决策说明自动记入回放。</p><button id="agent-toggle" class="primary full">启动自动调度 ↗</button><details><summary>连接 HTTP Agent</summary><input id="agent-url" value="http://127.0.0.1:8789/decide" aria-label="Agent 地址"/><button id="connect-agent" class="soft-button full">连接并运行</button><small>发送完整状态，包含车站、线路、列车、资源及随机数和内部计时。等待回复时冻结游戏时钟。</small></details><button id="agent-observation" class="text-button">查看 Agent 收到的数据 ↗</button></div><div id="last-decision" class="last-decision"></div>` : ''}
    </section>
    <section id="replay-pane" hidden>
      <p class="muted">查看操作记录，或还原某次决策前的地图。</p>
      <div class="button-pair"><button id="replay-current" class="primary">回看本局</button><button id="export-replay">导出 JSON</button></div>
      <div class="button-pair"><button id="import-replay">导入旅程</button><button id="save-local">保存到本机</button></div><input id="import-file" type="file" accept="application/json,.json" hidden/>
      <div class="timeline"><div><span id="replay-position">0:00</span><span id="replay-duration">0:00</span></div><input id="timeline" type="range" min="0" max="1" value="0" aria-label="回放时间"/><div class="button-pair"><button id="step-back">− 5 秒</button><button id="step-forward">＋ 5 秒</button></div></div>
      <div class="section-heading"><span>决策记录</span><span id="decision-count">0</span></div><div id="decision-list" class="decision-list"></div><div class="button-pair"><button id="decisions-earlier">更早的记录</button><button id="decisions-later">较新的记录</button></div>
      <div class="section-heading"><span>本机旅程</span><button id="refresh-history" class="text-button">刷新</button></div><div id="history-list"></div>
    </section>
  </aside>
</main>
<footer class="transport-bar"><div class="transport-controls"><button id="play-pause" class="play-button" aria-label="播放或暂停">▶</button><div class="speed-switch" aria-label="运行速度"><button data-speed="1" class="active" aria-pressed="true">1×</button><button data-speed="2" aria-pressed="false">2×</button><button data-speed="4" aria-pressed="false">4×</button></div></div><div id="resources" class="resources" aria-label="剩余调度资源"></div><div class="day-progress"><span id="day-clock">星期一</span><div><i id="day-fill"></i></div><span id="clock">00:00</span></div><div class="footer-right"><span id="control-label">手动规划</span><button id="sound" class="icon-button" title="声音开关">♫</button></div></footer>
<dialog id="queue-browser" aria-label="各站候车目的地"><div id="queue-browser-content"></div><button id="queue-focus-station" type="button">定位车站</button><button id="queue-focus-pile" type="button">定位候车</button><button id="queue-browser-close" type="button">关闭</button></dialog>
<dialog id="settings-dialog"><form id="settings-form"><span class="eyebrow">LET'S BUILD A LITTLE CITY</span><h2>开始一段新旅程</h2><label>目的地<select id="city-select"><option value="orchard">河湾新城 · 蜿蜒的单河城市</option><option value="harbor">东岸港湾 · 城市东侧的河湾</option><option value="islands">双子群岛 · 两条河流，三片陆地</option></select></label><label>模式<select id="mode-select"><option value="normal">经典 · 拥挤过久将结束旅程</option><option value="endless">无尽 · 保留需求，没有拥挤失败</option><option value="extreme">极限 · 线路只能从端点延长</option><option value="creative">创意 · 充足资源，可手动建站</option></select></label><label>地图种子<input id="seed-input" type="number" min="0" max="4294967295" value="420"/></label><div class="button-pair"><button type="button" id="settings-cancel">再逛一会儿</button><button class="primary" type="submit">出发 ↗</button></div></form></dialog>
<dialog id="help-dialog"><span class="eyebrow">A POCKET GUIDE</span><h2>地铁乘车指南</h2><ol><li>乘客的形状就是目的地。把不同形状的车站连起来；列车会自动接送和换乘。</li><li>拖车站本体到另一站可新建可用线路，即使车站已有线路也一样；不依赖当前选线。可以连续拖过多站。</li><li>开放线路首尾的同色手柄分别用于向前、向后延长原线路。键盘可先激活手柄，再选目标车站；Escape 取消。拖回起点可闭合环线。</li><li>把环线的一段轨道拉离原位，在安全空白处松开可断开该段；短拉或松在车站、其它轨道上不会修改线路。右键车站可将它移出当前线路。</li><li>点击线路、列车或可扩建站会显示当前可用操作：派车、车厢、扩建等。</li><li>每段跨河连接消耗隧道。车站超过 6 人开始计时，持续 45 秒将结束旅程；减少到 6 人以下，计时会逐渐恢复。枢纽容量为 18 人。</li><li>空格暂停，1–7 选线。每周免费获得一台机车，再选一项补给。可随时暂停规划。</li><li>游戏结束后可以查看旅程回放；普通游玩时不会显示回放工具。AI 集成页可导入、导出和定位回放时间。</li>${integrationSurface ? '<li>AI 集成页可读取完整结构化状态并连接外部 Agent；它并非只看屏幕的视觉 AI。</li>' : ''}</ol><p class="muted">Mini Metro 核心玩法的独立重建；3 张原创地图、原创程序化画面与音效。原版城市数据及精确节奏未对齐，验证边界见随附 FIDELITY.md。</p><button id="help-close" class="primary full">开始规划</button></dialog>
<dialog id="decision-dialog"><span class="eyebrow">AT THE MOMENT OF DECISION</span><h2>决策现场</h2><div id="decision-content"></div><button id="decision-close" class="primary full">返回旅程</button></dialog>
<dialog id="observation-dialog"><h2>Agent 当前观察</h2><p>这是实际接口的完整 JSON。包含内部状态，并非只看屏幕。HTTP 回复 action，游戏校验并执行。</p><pre id="observation-json"></pre><button id="observation-close" class="primary full">关闭</button></dialog>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage'),
  layer = $('station-layer'),
  trainLayer = $('train-layer'),
  controller = new MetroController();
let mobileMap = window.matchMedia('(max-width: 650px)').matches;
function syncMapKeyboardTarget(): void {
  stage.tabIndex = mobileMap ? 0 : -1;
  stage.setAttribute('aria-label', mobileMap ? '地铁地图，方向键移动视野' : '地铁地图');
}
syncMapKeyboardTarget();
const shortPhone = window.matchMedia('(max-width: 650px) and (max-height: 600px)');
let mapFirst = false;
let normalZoom = 0.55;
let tallMobileZoom: number | null = null;
function setMapFirst(open: boolean, saveNormalZoom = true): void {
  if (!shortPhone.matches || !mobileMap) open = false;
  if (mapFirst === open) return;
  if (open && saveNormalZoom) normalZoom = renderer.getZoom();
  mapFirst = open;
  document.body.classList.toggle('map-first', open);
  $('map-first-toggle').setAttribute('aria-pressed', String(open));
  $('map-first-toggle').textContent = open ? '常规' : '地图';
  uiAt = 0;
  update();
  if (open && renderer instanceof Mobile3DRenderer) {
    if (stage.clientWidth >= 500 && stage.clientWidth > stage.clientHeight && stage.clientHeight < 300 && !renderer.hasUserCamera()) renderer.frameOpeningStations();
    else renderer.setZoom(stage.clientWidth < 360 && stage.clientWidth <= stage.clientHeight ? 0.55 : Math.max(1, renderer.getZoom()));
  } else renderer.setZoom(normalZoom);
  if (mobileMap) syncMobileCameraTargets();
}
$('map-first-toggle').onclick = () => setMapFirst(!mapFirst);
shortPhone.addEventListener('change', () => {
  if (!mobileMap) return;
  if (shortPhone.matches) tallMobileZoom = renderer.getZoom();
  else if (!mapFirst) normalZoom = renderer.getZoom();
  setMapFirst(shortPhone.matches, false);
  if (!shortPhone.matches && tallMobileZoom !== null) renderer.setZoom(tallMobileZoom);
});
let renderer: MetroRenderer | Mobile3DRenderer = mobileMap ? new Mobile3DRenderer(stage, syncMobileCameraTargets) : new MetroRenderer(stage);
let mobileCameraSnapshot: ReturnType<Mobile3DRenderer['cameraState']> | null = null;
const audio = new MetroAudio();
const LINE_NAMES = ['红线', '黄线', '青线', '紫线', '绿线', '粉线', '蓝灰线'];
const DAY_NAMES = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
let selectedStation: number | null = null,
  redrawing = false,
  draft: number[] | null = null,
  draftLoop = false,
  dragStart = { x: 0, y: 0 },
  moved = false,
  uiAt = 0,
  lastScore = 0,
  stationKey = '',
  lineKey = '',
  trainKey = '',
  detailKey = '',
  selectedTrain: number | null = null,
  decisionKey = '',
  phaseKey = '',
  lastState: State = controller.getState(),
  toastTimer = 0;
let decisionPage = 0;
const nodes = new Map<number, HTMLButtonElement>();
function escape(text: unknown): string {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
function clock(tick: number): string {
  const sec = Math.floor(tick / RULES.hz);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function toast(text: string, error = false): void {
  $('toast').textContent = text;
  $('toast').setAttribute('role', error ? 'alert' : 'status');
  $('toast').classList.toggle('error', error);
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => $('toast').classList.remove('show'), 3600);
}
function act(action: Action, reason: string): boolean {
  try {
    const r = controller.submit({ action, reason }, 'human');
    toast(r.message, !r.ok);
    if (r.ok) audio.note(440, 0.09);
    return r.ok;
  } catch (e) {
    toast(String(e), true);
    return false;
  }
}
function resetView(): void {
  mobileCameraSnapshot = null;
  hideContext();
  setLineChooser(false);
  nodes.forEach((n) => n.remove());
  nodes.clear();
  disarmEndpoint();
  stationKey = lineKey = trainKey = detailKey = decisionKey = phaseKey = '';
  selectedStation = null;
  alertCycle = [];
  mobileCrowdIndex = 0;
  $('station-peek').hidden = true;
  $<HTMLDialogElement>('queue-browser').close();
  queueBrowserStation = null;
  alertCycleReplayKey = null;
  $('map-alerts').hidden = true;
  $('map-alerts').dataset.omitted = '';
  selectedTrain = null;
  $('train-detail').hidden = true;
  delete $('train-detail').dataset.groupStation;
  delete $('train-detail').dataset.groupKey;
  trainLayer.replaceChildren();
  clearGesture();
  panning = null;
  decisionPage = 0;
  renderer.resetCamera();
  // On the narrow map the 1x opening frame pins both endpoint stations to
  // opposite stage corners, leaving no room for a full 44px route control.
  if (mapFirst && renderer instanceof Mobile3DRenderer && stage.clientWidth <= stage.clientHeight)
    renderer.setZoom(stage.clientWidth < 360 ? 0.55 : 1);
  setLineTools(false);
  setInspector(false);
  const creative = controller.getState().mode === 'creative';
  $('creative-picker').hidden = integrationSurface || !creative;
  $('creative-picker').innerHTML = creative && !integrationSurface ? creativeStationPicker() : '';
  $('station-detail').innerHTML = creative
    ? `<span class="eyebrow">CREATIVE CITY</span><p>选择站型，再点击空白地面建站。</p>${creativeStationPicker()}`
    : '<span class="eyebrow">STATION NOTES</span><p>点一下车站，查看等候乘客<br>和它连接的线路。</p>';
  detailKey = creative ? 'creative' : '';
  update();
}
function setInspector(open: boolean): void {
  if (!integrationSurface) open = false;
  $('inspector').hidden = !open;
  $('tools-toggle').setAttribute('aria-expanded', String(open && $('replay-pane').hidden));
  $('replay-toggle').setAttribute('aria-expanded', String(open && !$('replay-pane').hidden));
}
function setLineTools(open: boolean): void {
  $('line-tools').hidden = !open;
  $('line-tools-toggle').setAttribute('aria-expanded', String(open));
}
function setTab(replay: boolean, open = true): void {
  $('dispatch-pane').hidden = replay;
  $('replay-pane').hidden = !replay;
  $('tab-dispatch').classList.toggle('active', !replay);
  $('tab-replay').classList.toggle('active', replay);
  setInspector(open);
  uiAt = 0;
  refreshHistory();
}
type ContextTarget = { type: 'line'; id: number } | { type: 'station'; id: number } | { type: 'train'; id: number };
let contextTarget: ContextTarget | null = null;
function hideContext(): void {
  contextTarget = null;
  $('context-actions').hidden = true;
  $('context-actions').replaceChildren();
}
function showContext(target: ContextTarget): void {
  if (integrationSurface || controller.mode === 'replay') return;
  const s = controller.getState();
  if (s.phase !== 'playing') return;
  const actions = $('context-actions');
  const options: { action: string; label: string; disabled?: boolean }[] = [];
  let point: { x: number; y: number } | null = null;
  if (target.type === 'line') {
    const line = s.lines.find(l => l.id === target.id);
    if (!line) return;
    options.push({ action: 'addTrain', label: '＋ 派列车', disabled: line.stops.length < 2 || s.resources.locomotives < 1 });
    if (line.stops.length) {
      options.push({ action: 'redraw', label: '重画' });
      if (!line.loop && line.stops.length >= 3) options.push({ action: 'loop', label: '闭合环线' });
      options.push({ action: 'clear', label: '撤销线路' });
      const p = s.stations.find(station => station.id === line.stops.at(-1));
      if (p) point = renderer.project(p.x, p.y, 0.6);
    }
  } else if (target.type === 'station') {
    const p = s.stations.find(station => station.id === target.id);
    if (!p || p.interchange || s.resources.interchanges < 1) return;
    options.push({ action: 'interchange', label: '扩建枢纽' });
    point = renderer.project(p.x, p.y, 0.6);
  } else {
    const train = s.trains.find(t => t.id === target.id);
    if (!train) return;
    options.push({ action: 'carriage', label: '＋ 车厢', disabled: s.resources.carriages < 1 });
    if (train.carriages) options.push({ action: 'uncar', label: '− 车厢' });
    options.push({ action: 'retire', label: '回库' });
    if (s.lines.some(line => line.id !== train.line && line.stops.length)) options.push({ action: 'move', label: '调往其它线路' });
    const p = s.stations.find(station => station.id === train.from);
    if (p) point = renderer.project(p.x, p.y, 0.6);
  }
  if (!options.length) { hideContext(); return; }
  contextTarget = target;
  actions.replaceChildren(...options.map(option => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.action = option.action;
    b.textContent = option.label;
    b.disabled = Boolean(option.disabled);
    return b;
  }));
  const stageBox = stage.getBoundingClientRect();
  const pile = point && renderer instanceof Mobile3DRenderer && target.type === 'station'
    ? renderer.mapStats().bounds.find(b => b.id === target.id)?.pile : null;
  // Keep controls in a measured side rail: never put them over a station, route, or waiting pile.
  actions.style.left = 'auto';
  actions.style.right = '8px';
  actions.style.top = '8px';
  actions.style.bottom = 'auto';
  if (point && point.x > stageBox.width * 0.55) { actions.style.left = '8px'; actions.style.right = 'auto'; }
  if (point && point.y < 110 && (pile || point.x > stageBox.width * 0.55)) {
    actions.style.top = 'auto'; actions.style.bottom = '8px';
  }
  actions.hidden = false;
  if (!integrationSurface && renderer instanceof Mobile3DRenderer && shortPhone.matches &&
      stage.clientWidth >= 500 && !renderer.hasUserCamera() && s.stations.length <= 3) {
    const mobileRenderer = renderer;
    requestAnimationFrame(() => mobileRenderer.frameOpeningStations());
  }
}
$('context-actions').addEventListener('pointerdown', (event) => event.stopPropagation());
$('context-actions').addEventListener('pointerup', (event) => event.stopPropagation());
$('context-actions').addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-action]');
  const target = contextTarget;
  if (!button || !target) return;
  event.stopPropagation();
  const action = button.dataset.action;
  if (target.type === 'line') {
    controller.selectedLine = target.id;
    if (action === 'addTrain') act({ type: 'addTrain', line: target.id }, '增派列车。');
    if (action === 'redraw') { redrawing = true; toast('从车站拖出，重新绘制所选线路。'); }
    if (action === 'loop') {
      const line = controller.getState().lines[target.id];
      act({ type: 'route', line: target.id, stops: line.stops, loop: true }, '闭合所选线路。');
    }
    if (action === 'clear') act({ type: 'route', line: target.id, stops: [] }, '撤销所选线路。');
  } else if (target.type === 'station' && action === 'interchange') {
    act({ type: 'interchange', station: target.id }, '扩建枢纽。');
  } else if (target.type === 'train') {
    const train = controller.getState().trains.find(t => t.id === target.id);
    if (!train) return;
    if (action === 'carriage' || action === 'uncar') act({ type: 'carriage', train: train.id, delta: action === 'carriage' ? 1 : -1 }, '调整列车车厢。');
    if (action === 'retire') act({ type: 'removeTrain', train: train.id }, '列车到站后回库。');
    if (action === 'move') {
      const other = controller.getState().lines.find(line => line.id !== train.line && line.stops.length);
      if (other) act({ type: 'moveTrain', train: train.id, line: other.id, station: other.stops[0] }, '调往其它线路。');
    }
  }
  hideContext();
});
function setLine(id: number): void {
  controller.selectedLine = id;
  if (!integrationSurface) showContext({ type: 'line', id });
  setLineChooser(false);
  redrawing = false;
  draft = null;
  renderer.clearPreview();
  uiAt = 0;
}
function setLineChooser(open: boolean): void {
  $('line-list').classList.toggle('open', open);
  $('line-chooser').setAttribute('aria-expanded', String(open));
}
function nearest(clientX: number, clientY: number): number | null {
  const rect = stage.getBoundingClientRect();
  let best = 30,
    result: number | null = null;
  for (const p of lastState.stations) {
    const q = renderer.project(p.x, p.y, 0.5),
      d = Math.hypot(q.x - (clientX - rect.left), q.y - (clientY - rect.top));
    if (mobileMap && (q.x < 0 || q.x > rect.width || q.y < 0 || q.y > rect.height)) continue;
    if (d < best) {
      best = d;
      result = p.id;
    }
  }
  return result;
}
function nearestStationCore(clientX: number, clientY: number): number | null {
  const rect = stage.getBoundingClientRect();
  let best = 12, result: number | null = null;
  for (const p of lastState.stations) {
    const q = renderer.project(p.x, p.y, 0.6);
    const distance = Math.hypot(q.x - (clientX - rect.left), q.y - (clientY - rect.top));
    if (distance < best) { best = distance; result = p.id; }
  }
  return result;
}
function stationUnderPointer(clientX: number, clientY: number): number | null {
  const rect = stage.getBoundingClientRect();
  const candidates = [...nodes].filter(([, node]) => {
    if (node.hidden) return false;
    const b = node.getBoundingClientRect();
    return clientX >= b.left && clientX <= b.right && clientY >= b.top && clientY <= b.bottom;
  });
  if (!candidates.length) return null;
  return candidates.map(([id]) => {
    const p = lastState.stations.find((station) => station.id === id)!;
    const q = renderer.project(p.x, p.y, 0.6);
    return { id, distance: Math.hypot(q.x - (clientX - rect.left), q.y - (clientY - rect.top)) };
  }).sort((a, b) => a.distance - b.distance || a.id - b.id)[0].id;
}
function currentLine() {
  return controller.getState().lines[controller.selectedLine];
}
function preview(): void {
  if (!draft) return;
  const s = controller.getState();
  const lineId = gestureLine ?? controller.selectedLine;
  const valid = draft.length === 1 ? s.mode !== 'extreme' :
    applyAction(copy(s), { type: 'route', line: lineId, stops: draft, loop: draftLoop }).ok;
  // The renderer's preview is additive: mark rails proposed for removal in the
  // gesture layer so the player can see what will disappear before releasing.
  handleLayer.querySelectorAll('[data-route-retract]').forEach(node => node.remove());
  if (gestureKind === 'endpoint') {
    const painted = renderer instanceof Mobile3DRenderer ? renderer.getPaintedTrackLayout() : null;
    for (const [fromId, toId] of removedRouteEdges(originalStops, draft)) {
      const edge = painted?.segments.find(item => item.from === Math.min(fromId, toId) && item.to === Math.max(fromId, toId));
      const a = s.stations.find(p => p.id === fromId)!;
      const b = s.stations.find(p => p.id === toId)!;
      const points = edge?.points ?? trackPoints(a, b);
      const project = edge && renderer instanceof Mobile3DRenderer
        ? renderer.projectTrackPoint.bind(renderer) : renderer.project.bind(renderer);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      path.setAttribute('data-route-retract', '');
      path.setAttribute('points', points.map(p => {
        const q = project(p.x, p.y, 0.6);
        return `${q.x},${q.y}`;
      }).join(' '));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', valid ? '#e75c58' : '#8d8a88');
      path.setAttribute('stroke-width', '5'); path.setAttribute('stroke-dasharray', '5 5');
      path.setAttribute('opacity', '.8');
      handleLayer.append(path);
    }
  }
  // A one-stop draft means the last segment will clear the line on release.
  renderer.showPreview(s, draftLoop ? [...draft, draft[0]] : draft, lineId, valid);
}
let panning: { x: number; y: number } | null = null;
let suppressCreativeClick = false;
let pointerStation: number | null = null;
let insertAt: number | null = null,
  originalStops: number[] = [];
let gestureLine: number | null = null;
let gestureKind: 'body' | 'endpoint' | 'insert' | 'loop' | null = null;
let endpointSide: 'start' | 'end' = 'end';
let endpointVisited: number | null = null;
let loopEdge: number | null = null;
let gesturePointer: number | null = null;
let loopPoint = { x: 0, y: 0 };
const handleRadius = 13;
const endpointButtons = new Map<string, HTMLButtonElement>();
const fallbackButtons = new Map<string, HTMLButtonElement>();
const handlePositions = new Map<string, { x: number; y: number }>();
const handleFallback = document.createElement('div');
handleFallback.setAttribute('role', 'group');
handleFallback.setAttribute('aria-label', '地图空间不足，选择线路端点后按车站延长');
handleFallback.style.cssText = 'position:absolute;z-index:5;left:8px;bottom:8px;max-width:calc(100% - 16px);display:flex;gap:4px;overflow-x:auto';
handleFallback.hidden = true;
stage.parentElement!.append(handleFallback);
let armedEndpoint: { line: number; side: 'start' | 'end' } | null = null;
function disarmEndpoint(): void {
  armedEndpoint = null;
  for (const button of endpointButtons.values()) button.setAttribute('aria-pressed', 'false');
  for (const button of handleFallback.querySelectorAll('button')) button.setAttribute('aria-pressed', 'false');
}
type HandleSide = 'start' | 'end';
type HitRect = { left: number; top: number; right: number; bottom: number };
const handleSize = 44;
function overlaps(a: HitRect, b: HitRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
// One measured, ordered pass: never place a handle independently of its peers.
// Train motion is not an obstacle. Reserve where a train *could park* at every
// station, so arriving, departing and regrouping badges cannot move the handle.
function layoutHandles(): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const bounds = stage.getBoundingClientRect();
  const blocked: HitRect[] = [
    ...nodes.values(),
    ...document.querySelectorAll<HTMLElement>('#context-actions, #mobile-crowd-alert, #queue-browser-toggle, #map-alerts, .map-tools, #creative-picker'),
  ].filter(el => !el.hidden && el.getClientRects().length > 0)
    .map(el => el.getBoundingClientRect());
  // Match the two CSS badge hit boxes and the placement in paint(): a single
  // parked train sits beside its station on mobile, while a group sits above.
  // These projections depend only on station geometry and camera, never trains.
  // minimal.css renders the desktop group at 28px (text + padding + border),
  // unlike the 25px minimum for a blank single. Both are 35px on mobile.
  // Subpixel CSS positioning rounds independently of renderer projections;
  // one pixel of slack on each edge keeps the true button hit box reserved.
  const badgeWidth = mobileMap ? 44 : 34;
  const singleHeight = mobileMap ? 35 : 25, groupHeight = mobileMap ? 35 : 28;
  const badgeSlack = 1;
  for (const station of lastState.stations) {
    const p = renderer.project(station.x, station.y, 0.9);
    const x = bounds.left + p.x, y = bounds.top + p.y;
    const singleX = x + (mobileMap ? 47 : 0), singleY = y - (mobileMap ? 42 : 0);
    blocked.push({ left: singleX - badgeWidth / 2 - badgeSlack, right: singleX + badgeWidth / 2 + badgeSlack,
      top: singleY - singleHeight / 2 - badgeSlack, bottom: singleY + singleHeight / 2 + badgeSlack });
    blocked.push({ left: x - badgeWidth / 2 - badgeSlack, right: x + badgeWidth / 2 + badgeSlack,
      top: y - groupHeight * 1.55 - badgeSlack, bottom: y - groupHeight * 0.55 + badgeSlack });
  }
  if (renderer instanceof Mobile3DRenderer) {
    const stats = renderer.mapStats();
    for (const p of stats.bounds) if (p.pile) {
      const anchor = lastState.stations.find(s => s.id === p.id);
      if (!anchor) continue;
      const point = renderer.project(anchor.x, anchor.y, 0.6);
      const pile = p.pile;
      blocked.push({left: bounds.left + point.x - pile.width * stats.zoom / 2,
        right: bounds.left + point.x + pile.width * stats.zoom / 2,
        top: bounds.top + point.y + 42 * stats.zoom,
        bottom: bounds.top + point.y + (42 + pile.height) * stats.zoom});
    }
  } else for (const cue of renderer.cueStats().bounds) {
    if (cue.kind === 'queue') blocked.push({left: bounds.left + cue.x, top: bounds.top + cue.y,
      right: bounds.left + cue.x + cue.width, bottom: bounds.top + cue.y + cue.height});
  }
  const fits = (x: number, y: number): boolean => {
    const box = { left: x - handleSize / 2, top: y - handleSize / 2,
      right: x + handleSize / 2, bottom: y + handleSize / 2 };
    return box.left >= bounds.left && box.right <= bounds.right &&
      box.top >= bounds.top && box.bottom <= bounds.bottom &&
      !blocked.some(other => overlaps(box, other));
  };
  // Reserve scarce mobile drag slots for newer routes before offering older
  // endpoints a keyboard fallback; otherwise the third route cannot be dragged.
  const lines = mobileMap ? [...controller.getState().lines].reverse() : controller.getState().lines;
  for (const line of lines) for (const side of (mobileMap ? ['end', 'start'] : ['start', 'end']) as HandleSide[]) {
    if (line.loop || line.stops.length < 2) continue;
    const endpoint = line.stops[side === 'start' ? 0 : line.stops.length - 1];
    const neighbor = line.stops[side === 'start' ? 1 : line.stops.length - 2];
    const a = lastState.stations.find(p => p.id === endpoint);
    const b = lastState.stations.find(p => p.id === neighbor);
    if (!a || !b) continue;
    const p = renderer.project(a.x, a.y, 0.6), q = renderer.project(b.x, b.y, 0.6);
    const theta = Math.atan2(p.y - q.y, p.x - q.x);
    const angles = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9, -9, 10, -10, 11, -11, 12];
    let found: { x: number; y: number } | null = null;
    // Keep a handle visibly owned by its endpoint; if the nearby fan has no
    // legal 44px slot, offer the labeled fallback instead of a detached dot.
    for (let radius = 60; radius <= 100 && !found; radius += 20)
      for (const turn of angles) {
        const angle = theta + turn * Math.PI / 12;
        const x = bounds.left + p.x + Math.cos(angle) * radius;
        const y = bounds.top + p.y + Math.sin(angle) * radius;
        if (fits(x, y)) { found = { x, y }; break; }
      }
    if (!found) continue; // Exposed separately in the fallback control list.
    const key = `${line.id}-${side}`;
    result.set(key, found);
    blocked.push({ left: found.x - 22, right: found.x + 22,
      top: found.y - 22, bottom: found.y + 22 });
  }
  return result;
}
function hitEndpoint(x: number, y: number): { line: number; side: HandleSide } | null {
  let best = handleRadius, result: { line: number; side: HandleSide } | null = null;
  for (const [key, p] of handlePositions) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < best) {
      best = d;
      const [line, side] = key.split('-');
      result = { line: Number(line), side: side as HandleSide };
    }
  }
  return result;
}
// SVG is visual-only; focusable buttons share the same points for keyboard and touch.
const handleLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
handleLayer.setAttribute('aria-hidden', 'true');
handleLayer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;overflow:visible';
stage.append(handleLayer);
const endpointLayer = document.createElement('div');
endpointLayer.className = 'endpoint-layer';
stage.append(endpointLayer);
endpointLayer.addEventListener('click', e => e.stopPropagation());
function paintHandles(): void {
  const rect = stage.getBoundingClientRect();
  const draggedTip = handleLayer.querySelector('[data-loop-tip]');
  const routeTip = handleLayer.querySelector('[data-route-tip]');
  const retractRails = [...handleLayer.querySelectorAll('[data-route-retract]')];
  handleLayer.replaceChildren();
  const visible = new Set<string>();
  handlePositions.clear();
  const locations = layoutHandles();
  const fallbackVisible = new Set<string>();
  for (const line of controller.getState().lines) for (const side of ['start', 'end'] as const) {
    const key = `${line.id}-${side}`;
    if (line.loop || line.stops.length < 2 || locations.has(key)) continue;
    fallbackVisible.add(key);
    let button = fallbackButtons.get(key);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${line.id + 1}号线${side === 'start' ? '起点' : '终点'} ↗`;
      button.setAttribute('aria-label', `${line.id + 1}号线${side === 'start' ? '起点' : '终点'}延长：地图空间不足，激活后用键盘选目标车站`);
      button.style.cssText = `flex:none;min-width:44px;min-height:44px;border:2px solid ${LINE_COLORS[line.id]};background:#fffaf6`;
      button.onclick = () => {
        armedEndpoint = { line: line.id, side };
        for (const other of endpointButtons.values()) other.setAttribute('aria-pressed', 'false');
        for (const other of fallbackButtons.values()) other.setAttribute('aria-pressed', String(other === button));
      };
      fallbackButtons.set(key, button);
    }
    button.setAttribute('aria-pressed', String(armedEndpoint?.line === line.id && armedEndpoint.side === side));
    // Reappending a connected button would detach focus on each paint.
    if (!button.isConnected) handleFallback.append(button);
  }
  for (const [key, button] of fallbackButtons) if (!fallbackVisible.has(key)) {
    button.remove(); fallbackButtons.delete(key);
  }
  handleFallback.hidden = !fallbackVisible.size;
  for (const [key, p] of locations) {
    const [id, side] = key.split('-');
    const lineId = Number(id);
    visible.add(key);
    handlePositions.set(key, p);
    let button = endpointButtons.get(key);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'endpoint-handle';
      button.setAttribute('aria-label', `${lineId + 1}号线${side === 'start' ? '起点' : '终点'}延长：激活后选目标车站，Escape 取消`);
      button.setAttribute('aria-pressed', String(armedEndpoint?.line === lineId && armedEndpoint.side === side));
      button.addEventListener('click', e => {
        if (e.detail !== 0 || controller.mode === 'replay') return;
        armedEndpoint = { line: lineId, side: side as HandleSide };
        for (const other of endpointButtons.values()) other.setAttribute('aria-pressed', String(other === button));
      });
      endpointLayer.append(button);
      endpointButtons.set(key, button);
    }
    button.setAttribute('aria-pressed', String(armedEndpoint?.line === lineId && armedEndpoint.side === side));
    button.style.left = `${p.x - rect.left}px`;
    button.style.top = `${p.y - rect.top}px`;
    button.style.setProperty('--line', LINE_COLORS[lineId]);
    const line = controller.getState().lines[lineId];
    const stationId = side === 'start' ? line.stops[0] : line.stops.at(-1);
    const station = lastState.stations.find(s => s.id === stationId);
    if (station) {
      const owner = renderer.project(station.x, station.y, 0.6);
      const link = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      link.setAttribute('data-handle-link', key);
      link.setAttribute('x1', String(owner.x)); link.setAttribute('y1', String(owner.y));
      link.setAttribute('x2', String(p.x - rect.left)); link.setAttribute('y2', String(p.y - rect.top));
      link.setAttribute('stroke', LINE_COLORS[lineId]); link.setAttribute('stroke-width', '2');
      link.setAttribute('stroke-dasharray', '3 3'); link.setAttribute('opacity', '.65');
      handleLayer.append(link);
    }
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(p.x - rect.left)); circle.setAttribute('cy', String(p.y - rect.top));
    circle.setAttribute('r', '9'); circle.setAttribute('fill', LINE_COLORS[lineId]);
    circle.setAttribute('stroke', '#fff'); circle.setAttribute('stroke-width', '2');
    circle.setAttribute('data-route-handle', key);
    handleLayer.append(circle);
  }
  for (const [key, button] of endpointButtons) if (!visible.has(key)) {
    button.remove(); endpointButtons.delete(key);
    // A keyboard-armed endpoint can leave the viewport while the user pans to
    // its target. Preserve its route identity until selection/Escape or a route edit.
    if (armedEndpoint && `${armedEndpoint.line}-${armedEndpoint.side}` === key &&
        !controller.getState().lines[armedEndpoint.line]?.stops.length) armedEndpoint = null;
  }
  for (const rail of retractRails) handleLayer.append(rail);
  if (draggedTip) handleLayer.append(draggedTip);
  if (routeTip) handleLayer.append(routeTip);
}
function clearGesture(): void {
  draft = null; insertAt = null; pointerStation = null; gestureLine = null;
  gestureKind = null; loopEdge = null; endpointVisited = null; gesturePointer = null;
  renderer.clearPreview();
  handleLayer.querySelectorAll('[data-route-retract]').forEach(node => node.remove());
  handleLayer.querySelector('[data-loop-tip]')?.remove();
  handleLayer.querySelector('[data-route-tip]')?.remove();
}
function drawRouteTip(e: PointerEvent): void {
  handleLayer.querySelector('[data-route-tip]')?.remove();
  if (!draft || !moved || gestureLine === null || gestureKind === 'insert' || gestureKind === 'loop') return;
  const end = draft[gestureKind === 'endpoint' && endpointSide === 'start' ? 0 : draft.length - 1];
  const station = controller.getState().stations.find(p => p.id === end);
  if (!station) return;
  const anchor = renderer.project(station.x, station.y, 0.6);
  const rect = stage.getBoundingClientRect();
  const tip = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  tip.setAttribute('data-route-tip', '');
  tip.setAttribute('x1', String(anchor.x)); tip.setAttribute('y1', String(anchor.y));
  tip.setAttribute('x2', String(e.clientX - rect.left)); tip.setAttribute('y2', String(e.clientY - rect.top));
  tip.setAttribute('stroke', LINE_COLORS[gestureLine]);
  tip.setAttribute('stroke-width', '3'); tip.setAttribute('stroke-dasharray', '7 5');
  handleLayer.append(tip);
}
function passengerUnderPointer(x:number,y:number): boolean {
  if(!(renderer instanceof Mobile3DRenderer))return false;
  const rect=stage.getBoundingClientRect();
  return renderer.mapStats().visiblePositions.some(p=>Math.hypot(rect.left+p.x-x,rect.top+p.y-y)<=9);
}
function nearbySegment(x: number, y: number): number | null {
  const rect = stage.getBoundingClientRect();
  const nearestTrack = (renderer instanceof Mobile3DRenderer)
    ? renderer.hitTestLane(controller.getState(), controller.selectedLine,
      { x: x - rect.left, y: y - rect.top }, 12)
    : hitTestVisibleLane(controller.getState(), controller.selectedLine,
      { x: x - rect.left, y: y - rect.top }, renderer.project.bind(renderer), 12);
  return nearestTrack;
}
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || controller.mode === 'replay' || gesturePointer !== null) return;
  suppressCreativeClick = false;
  const targetHandle = (e.target as Element).closest<HTMLButtonElement>('.endpoint-handle');
  const targetKey = targetHandle && [...endpointButtons].find(([, button]) => button === targetHandle)?.[0];
  const handle = targetKey ? { line: Number(targetKey.split('-')[0]), side: targetKey.split('-')[1] as 'start' | 'end' }
    : hitEndpoint(e.clientX, e.clientY);
  if (handle) {
    disarmEndpoint();
    gesturePointer = e.pointerId;
    gestureKind = 'endpoint'; gestureLine = handle.line; endpointSide = handle.side;
    originalStops = [...controller.getState().lines[handle.line].stops];
    draft = [...originalStops]; draftLoop = false;
    endpointVisited = handle.side === 'start' ? originalStops[0] : originalStops.at(-1)!;
    pointerStation = null; insertAt = null; moved = false;
    dragStart = { x: e.clientX, y: e.clientY };
    $('station-peek').hidden = true;
    stage.setPointerCapture(e.pointerId);
    return;
  }
  const coreStation = nearestStationCore(e.clientX, e.clientY);
  const label = (e.target as Element).closest<HTMLElement>('[data-station]');
  const trainTarget = (e.target as Element).closest('[data-train-id], [data-train-group]');
  if (mobileMap && trainTarget && coreStation === null) return;
  // A train's transparent hit box may overlap an actual station touch target.
  const buttonStation = stationUnderPointer(e.clientX, e.clientY);
  if (trainTarget && coreStation === null && buttonStation === null) return;
  const nearby = nearest(e.clientX, e.clientY);
  // DOM stacking is arbitrary when touch targets overlap. Prefer the closest
  // rendered station, then the closest button within the touch target.
  const id = coreStation ?? (trainTarget ? buttonStation : null) ?? nearby
    ?? (label ? Number(label.dataset.station) : null) ?? buttonStation;
  // A station press is also the pointer half of an armed keyboard selection.
  // Defer committing until release so a move can still be a normal route drag.
  if (id === null) disarmEndpoint();
  pointerStation = id;
  gesturePointer = e.pointerId;
  dragStart = { x: e.clientX, y: e.clientY };
  moved = false;
  if (id === null) {
    insertAt = nearbySegment(e.clientX, e.clientY);
    if (insertAt !== null && !redrawing) {
      gestureLine = controller.selectedLine;
      originalStops = [...currentLine().stops];
      if (currentLine().loop) {
        gestureKind = 'loop'; loopEdge = insertAt;
        loopPoint = { x: e.clientX, y: e.clientY };
        draft = breakLoopEdge(originalStops, insertAt);
        draftLoop = false;
      } else {
        gestureKind = 'insert';
        draft = [...originalStops]; draftLoop = false;
      }
      $('station-peek').hidden = true;
    } else { gestureKind = null; panning = { x: e.clientX, y: e.clientY }; }
    stage.setPointerCapture(e.pointerId);
    return;
  }
  gestureKind = 'body'; insertAt = null;
  $('station-peek').hidden = true;
  selectedStation = id;
  draftLoop = false;
  const line = controller.getState().lines.find(l => !l.stops.length);
  gestureLine = redrawing ? controller.selectedLine : line?.id ?? null;
  draft = gestureLine === null ? null : [id];
  stage.setPointerCapture(e.pointerId);
  uiAt = 0;
});
stage.addEventListener('pointermove', (e) => {
  if (gesturePointer !== null && e.pointerId !== gesturePointer) return;
  if (pointerStation !== null && Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 8)
    moved = true;
  if (moved && armedEndpoint) disarmEndpoint();
  if (panning) {
    if (placing) suppressCreativeClick = true;
    renderer.pan(e.clientX - panning.x, e.clientY - panning.y);
    if (mobileMap) syncMobileCameraTargets();
    panning = { x: e.clientX, y: e.clientY };
    return;
  }
  if (!draft) return;
  const distance = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
  if (distance > 8) moved = true;
  if (gestureKind === 'loop') {
    // Preview the opened route and the pulled rail tip without editing the authoritative map.
    if (distance > 8 && loopEdge !== null) {
      const rect = stage.getBoundingClientRect();
      const tip = renderer.unproject(e.clientX - rect.left, e.clientY - rect.top);
      if (!tip) return;
      const ghost = copy(controller.getState());
      const base = breakLoopEdge(originalStops, loopEdge)!;
      ghost.stations.push({ ...ghost.stations.find(p => p.id === base.at(-1))!, id: -1, x: tip.x, y: tip.y });
      if (renderer instanceof Mobile3DRenderer) {
        // Mobile preview resolves IDs from its last render; draw an ephemeral
        // deformed rail in the gesture SVG without changing the route cache.
        const start = ghost.stations.find(p => p.id === base.at(-1))!;
        const anchor = renderer.project(start.x, start.y, 0.6);
        const previous = handleLayer.querySelector('[data-loop-tip]');
        previous?.remove();
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('data-loop-tip', '');
        path.setAttribute('d', `M ${anchor.x} ${anchor.y} L ${e.clientX - rect.left} ${e.clientY - rect.top}`);
        path.setAttribute('stroke', LINE_COLORS[gestureLine!]);
        path.setAttribute('stroke-width', '3'); path.setAttribute('stroke-dasharray', '7 5');
        path.setAttribute('fill', 'none'); handleLayer.append(path);
        renderer.showPreview(ghost, base, gestureLine!, safeLoopRelease(loopPoint,
          { x: e.clientX, y: e.clientY }, rect, nearest(e.clientX, e.clientY) !== null));
      } else renderer.showPreview(ghost, [...base, -1], gestureLine!, safeLoopRelease(loopPoint,
        { x: e.clientX, y: e.clientY }, rect, nearest(e.clientX, e.clientY) !== null));
    }
    return;
  }
  if (mobileMap && pointerStation !== null) {
    const edge = 25, box = stage.getBoundingClientRect();
    const dx = e.clientX < box.left + edge ? 12 : e.clientX > box.right - edge ? -12 : 0;
    const dy = e.clientY < box.top + edge ? 12 : e.clientY > box.bottom - edge ? -12 : 0;
    if (dx || dy) { renderer.pan(dx, dy); syncMobileCameraTargets(); }
  }
  const id = nearest(e.clientX, e.clientY);
  if (gestureKind === 'endpoint') {
    if (id === null) {
      if (draftLoop) { draftLoop = false; endpointVisited = null; preview(); }
      drawRouteTip(e); return;
    }
    // Remain latched to the last visited station through blank space when
    // backtracking, but allow a disarmed loop closure to re-arm on re-entry.
    if (id === endpointVisited) { drawRouteTip(e); return; }
    endpointVisited = id;
    if (draftLoop) { draftLoop = false; preview(); }
    const next = endpointStep(originalStops, endpointSide, draft, id);
    if (next) {
      draft = next.stops;
      draftLoop = next.loop;
      preview();
    }
    drawRouteTip(e);
    return;
  }
  if (id === null || id === draft.at(-1)) {
    if (draftLoop) { draftLoop = false; preview(); }
    drawRouteTip(e); return;
  }
  if (gestureKind === 'insert' && insertAt !== null) {
    if (!originalStops.includes(id)) {
      draft = [...originalStops]; draft.splice(insertAt, 0, id); preview();
    }
    return;
  }
  if (id === draft[0] && draft.length >= 3) { draftLoop = true; preview(); drawRouteTip(e); return; }
  if (draft.length > 1 && id === draft.at(-2)) {
    draft.pop(); draftLoop = false; preview(); drawRouteTip(e); return;
  }
  if (draft.includes(id)) { drawRouteTip(e); return; }
  draft.push(id); draftLoop = false; preview(); drawRouteTip(e);
});
function crowdRemaining(crowd: number): string {
  return `拥挤还剩 ${Math.ceil((RULES.crowdTicks - crowd) / RULES.hz)} 秒`;
}
function showStationPeek(id: number): void {
  if (!integrationSurface) {
    const p = controller.getState().stations.find(item => item.id === id);
    if (!p) return;
    selectedStation = id;
    const shapes = SHAPES.map(shape => ({ shape, n: p.queue.filter(q => q.shape === shape).length }))
      .filter(item => item.n).map(item => `${GLYPHS[item.shape]}×${item.n}`).join(' ');
    $('station-peek').textContent = `车站 ${p.id} · 候车 ${p.queue.length} 人${shapes ? `：${shapes}` : ''}${p.crowd ? ` · ${crowdRemaining(p.crowd)}` : ''}`;
    $('station-peek').hidden = false;
    if (!p.interchange && controller.getState().resources.interchanges > 0)
      showContext({ type: 'station', id });
    return;
  }
  selectedStation = id;
  selectedTrain = null;
  $('train-detail').hidden = true;
  delete $('train-detail').dataset.groupStation;
  delete $('train-detail').dataset.groupKey;
  if (stage.getBoundingClientRect().width > 650) { setTab(false); update(); return; }
  setInspector(false);
  const station = controller.getState().stations.find(p => p.id === id);
  if (!station) return;
  const shapes = SHAPES.map(shape => ({ shape, n: station.queue.filter(q => q.shape === shape).length }))
    .filter(item => item.n).map(item => `${GLYPHS[item.shape]}×${item.n}`).join(' ');
  $('station-peek').textContent = `车站 ${station.id} · 候车 ${station.queue.length} 人${shapes ? `：${shapes}` : ''}${station.crowd ? ` · ${crowdRemaining(station.crowd)}` : ''}`;
  $('station-peek').hidden = false;
  update();
  focusPeekStation(id);
}
function focusPeekStation(id: number): void {
  const mobileRenderer = renderer;
  if (!(mobileRenderer instanceof Mobile3DRenderer)) return;
  const station = controller.getState().stations.find(p => p.id === id);
  if (!station) return;
  // The detail strip changes the canvas bounds. Aim the projected roof at a
  // drawable row after each of the next two ResizeObserver frames.
  let remaining = 3;
  const settle = () => {
    if ($('station-peek').hidden || selectedStation !== id || renderer !== mobileRenderer) return;
    const roof = mobileRenderer.project(station.x, station.y, 0.6).y;
    if (roof < 22 || roof > stage.clientHeight - 22) {
      mobileRenderer.centerStationAt(station.x, station.y, Math.max(22, stage.clientHeight / 2));
      syncMobileCameraTargets();
    }
    if (--remaining > 0) requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}
function finishDraw(e: PointerEvent): void {
  if (gesturePointer !== null && gesturePointer !== e.pointerId) return;
  if (gestureKind === 'loop' && loopEdge !== null && gestureLine !== null) {
    const bounds = stage.getBoundingClientRect();
    const point = { x: e.clientX, y: e.clientY };
    if (safeLoopRelease(loopPoint, point, bounds,
        nearest(point.x, point.y) !== null || nearbySegment(point.x, point.y) !== null || passengerUnderPointer(point.x, point.y)) &&
        controller.getState().mode !== 'extreme') {
      const stops = breakLoopEdge(originalStops, loopEdge);
      if (stops) act({ type: 'route', line: gestureLine, stops, loop: false }, '拉开环线轨道。');
    }
  } else if (draft && moved && gestureLine !== null &&
      (gestureKind === 'endpoint' ?
        (draft.length !== originalStops.length || draft.some((id, i) => id !== originalStops[i]) || draftLoop) : draft.length >= 2) &&
      !(gestureKind === 'endpoint' && draftLoop && controller.getState().mode === 'extreme' && originalStops.length) &&
      (gestureKind !== 'insert' || draft.length > originalStops.length) &&
      (gestureKind !== 'body' || draft.length > 1)) {
    const first = !controller.getState().lines.some(l => l.stops.length);
    const stops = gestureKind === 'endpoint' && draft.length < 2 ? [] : draft;
    if (act({ type: 'route', line: gestureLine, stops, loop: draftLoop },
      gestureKind === 'insert' ? '拖动轨道接入新车站。' : '拖拽车站绘制线路。')) {
      redrawing = false;
      if (first) controller.setPaused(false);
    }
  } else if (pointerStation !== null && !moved) {
    if (armedEndpoint) {
      const { line, side } = armedEndpoint;
      const original = controller.getState().lines[line];
      const stops = original && !original.loop
        ? extensionStops(original.stops, side, [pointerStation]) : null;
      if (stops) act({ type: 'route', line, stops, loop: false }, '键盘延长线路。');
      disarmEndpoint();
    } else showStationPeek(pointerStation);
  }
  clearGesture();
  paintHandles();
}
stage.addEventListener('click', (e) => {
  const target = (e.target as Element).closest<HTMLElement>('[data-station]');
  if (!target || pointerStation !== null || panning) return;
  if (e.detail === 0) {
    if (armedEndpoint) {
      const { line, side } = armedEndpoint;
      const original = controller.getState().lines[line];
      const stops = original && !original.loop
        ? extensionStops(original.stops, side, [Number(target.dataset.station)]) : null;
      if (stops) {
        controller.takeControl();
        act({ type: 'route', line, stops, loop: false }, '键盘延长线路。');
      }
      disarmEndpoint();
    } else showStationPeek(Number(target.dataset.station));
  }
});
stage.addEventListener('pointerup', (e) => {
  if (gesturePointer !== null && e.pointerId !== gesturePointer) return;
  panning = null;
  finishDraw(e);
  if (mobileMap) syncMobileCameraTargets();
});
stage.addEventListener('pointercancel', () => {
  panning = null;
  clearGesture();
});
// Two-finger zoom stays independent of route ownership and simulation state.
const pinchPointers = new Map<number, { x: number; y: number }>();
let pinchBaseline: { distance: number; zoom: number } | null = null;
stage.addEventListener('pointerdown', e => {
  if (!mobileMap || e.pointerType !== 'touch') return;
  pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinchPointers.size === 2) {
    panning = null;
    clearGesture();
    gesturePointer = null;
    const [a,b] = [...pinchPointers.values()];
    pinchBaseline = { distance: Math.hypot(a.x-b.x,a.y-b.y), zoom: renderer.getZoom() };
  }
}, {capture:true});
stage.addEventListener('pointermove', e => {
  if (!pinchPointers.has(e.pointerId)) return;
  pinchPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
  if (!pinchBaseline || pinchPointers.size !== 2) return;
  const [a,b] = [...pinchPointers.values()];
  renderer.setZoom(pinchBaseline.zoom * Math.hypot(a.x-b.x,a.y-b.y) / Math.max(1,pinchBaseline.distance));
  syncMobileCameraTargets();
  e.stopImmediatePropagation();
}, {capture:true});
for (const type of ['pointerup','pointercancel'] as const)
  stage.addEventListener(type, e => {
    if (!pinchPointers.delete(e.pointerId)) return;
    if (pinchBaseline) {
      pinchBaseline=null;
      panning=null;
      clearGesture();
      gesturePointer=null;
      e.stopImmediatePropagation();
    }
  }, {capture:true});
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    renderer.setZoom(renderer.getZoom() + (e.deltaY < 0 ? 0.1 : -0.1));
    if (mobileMap) syncMobileCameraTargets();
  },
  { passive: false },
);
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const id = nearest(e.clientX, e.clientY);
  if (id !== null) removeStation(id);
});
function removeStation(id: number): void {
  const l = currentLine(),
    stops = l.stops.filter((p) => p !== id);
  act(
    {
      type: 'route',
      line: l.id,
      stops: stops.length >= 2 ? stops : [],
      loop: l.loop && stops.length >= 3,
    },
    `从 ${l.id + 1} 号线移除 ${id} 站。`,
  );
}

let alertCycle: number[] = [];
let mobileCrowdIndex = 0;
let alertCycleReplayKey: string | null = null;
// Measure the transformed DOM hit box, not its world-space station/track point.
// Revealing first also gives correct dimensions when a prior pan hid the badge.
function mobileBadgeOffstage(badge: HTMLButtonElement, stageBounds: DOMRect): boolean {
  badge.hidden = false;
  const box = badge.getBoundingClientRect();
  return box.right <= stageBounds.left || box.left >= stageBounds.right ||
    box.bottom <= stageBounds.top || box.top >= stageBounds.bottom;
}
function reprojectMobileTargets(): void {
  if (!mobileMap) return;
  const s = controller.getState(), bounds = stage.getBoundingClientRect();
  for (const station of s.stations) {
    const node = nodes.get(station.id);
    if (!node) continue;
    const point = renderer.project(station.x, station.y, 0.6);
    node.style.left = `${point.x}px`;
    node.style.top = `${point.y}px`;
    node.hidden = point.x < -22 || point.x > bounds.width + 22 ||
      point.y < -22 || point.y > bounds.height + 22;
  }
  for (const train of s.trains) {
    const badge = trainLayer.querySelector<HTMLButtonElement>(`[data-train-id="${train.id}"]`);
    if (!badge) continue;
    const point = renderer.projectTrain(train.id);
    if (!point) continue;
    badge.style.left = `${point.x + (train.to === null ? 47 : 0)}px`;
    badge.style.top = `${point.y - (train.to === null ? 42 : 0)}px`;
    const grouped = train.to === null && s.trains.filter(t => t.to === null && t.from === train.from).length > 1;
    badge.hidden = grouped || mobileBadgeOffstage(badge, bounds);
  }
  for (const badge of trainLayer.querySelectorAll<HTMLButtonElement>('[data-train-group]')) {
    const owner = s.stations.find(p => p.id === Number(badge.dataset.trainGroup));
    if (!owner) continue;
    const point = renderer.project(owner.x, owner.y, 0.9);
    badge.style.left = `${point.x}px`;
    badge.style.top = `${point.y}px`;
    badge.hidden = mobileBadgeOffstage(badge, bounds);
  }
}
function syncMobileCameraTargets(): void {
  reprojectMobileTargets();
  paintHandles();
}
stage.addEventListener('keydown', e => {
  // Station and route handles retain their own keyboard behavior. Arrow keys
  // navigate only when the map region itself owns focus.
  if (e.target !== stage || !(renderer instanceof Mobile3DRenderer)) return;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const center = renderer.mapStats().center;
  renderer.centerAt(center.x + (e.key === 'ArrowLeft' ? -80 : e.key === 'ArrowRight' ? 80 : 0),
    center.y + (e.key === 'ArrowUp' ? -80 : e.key === 'ArrowDown' ? 80 : 0));
  syncMobileCameraTargets();
});
function update(): void {
  const { state: s, events, motion } = controller.getRenderSnapshot();
  // A replay seek changes the authoritative snapshot; only a same-snapshot
  // visual reflow may retain the pending list of omitted stations.
  const replayKey = controller.mode === 'replay' ? `${s.tick}:${controller.focusedDecision ?? ''}` : null;
  if (alertCycleReplayKey !== replayKey) {
    alertCycle = [];
    mobileCrowdIndex = 0;
    $('station-peek').hidden = true;
    alertCycleReplayKey = replayKey;
  }
  if (s.phase !== 'playing' || controller.mode === 'replay') hideContext();
  controller.selectedLine = Math.min(controller.selectedLine, s.lines.length - 1);
  lastState = s;
  $('creative-picker').hidden = integrationSurface || s.mode !== 'creative' || controller.mode === 'replay';
  renderer.render(s, controller.selectedLine, events, motion);
  if (mobileMap) syncMobileCameraTargets();
  if (!integrationSurface) {
    $('train-detail').hidden = true;
    $('station-detail').hidden = true;
  }
  const sk = s.stations.map((p) => `${p.id}:${p.shape}`).join(',');
  if (sk !== stationKey) {
    stationKey = sk;
    for (const [id, n] of nodes)
      if (!s.stations.some((p) => p.id === id)) {
        n.remove();
        nodes.delete(id);
      }
    for (const p of s.stations)
      if (!nodes.has(p.id)) {
        const n = document.createElement('button');
        n.className = 'station-label';
        n.dataset.station = String(p.id);
        layer.append(n);
        nodes.set(p.id, n);
      }
  }
  const stageBounds = stage.getBoundingClientRect();
  // Camera projection is the only source of station touch coordinates.
  const positions = s.stations.map((p) => ({ p, point: renderer.project(p.x, p.y, 0.6) }));
  const positionById = new Map(positions.map(({ p, point }) => [p.id, point]));
  const stationaryGroups = new Map<number, typeof s.trains>();
  for (const t of s.trains) if (t.to === null) {
    const group = stationaryGroups.get(t.from) ?? [];
    group.push(t);
    stationaryGroups.set(t.from, group);
  }
  const reservedBadges = s.trains.flatMap((t) => {
    const group = stationaryGroups.get(t.from) ?? [];
    if (t.to === null && group[0]?.id !== t.id) return [];
    const a = s.stations.find((p) => p.id === t.from)!;
    const b = t.to === null ? a : s.stations.find((p) => p.id === t.to)!;
    const position = trackPosition(a, b, t.progress);
    const visual = t.to === null && group.length > 1
      ? renderer.project(a.x, a.y, 0.9)
      : renderer.projectTrain(t.id) ?? renderer.project(position.x, position.y, 0.9);
    const width = stageBounds.width <= 650 ? 44 : 34;
    const height = stageBounds.width <= 650 ? 35 : 25;
    const offset = t.to === null && group.length > 1 ? 1.55 : 0.5;
    return [{ x: visual.x - width / 2, y: visual.y - height * offset, width, height }];
  });
  const placed = mobileMap ? [] : layoutSceneCues(positions.map(({ p, point }) => ({ id: p.id, x: point.x,
    y: point.y, queue: p.queue.length, queueShapes: p.queue.map(q => q.shape),
    crowd: p.crowd, selected: p.id === selectedStation })),
    { width: stageBounds.width, height: stageBounds.height }, reservedBadges);
  const byId = new Map(placed.map((item) => [item.id, item]));
  for (const p of s.stations) {
    const q = positionById.get(p.id)!,
      n = nodes.get(p.id)!;
    n.hidden = mobileMap && (q.x < -22 || q.x > stageBounds.width + 22 || q.y < -22 || q.y > stageBounds.height + 22);
    n.style.left = `${q.x}px`;
    n.style.top = `${q.y}px`;
    n.classList.toggle('selected', p.id === selectedStation);
    n.classList.toggle('crowded', p.queue.length > stationCapacity(p));
    n.setAttribute('aria-label', `${p.id} 号 ${p.shape} 车站，${p.queue.length} 人候车${p.crowd ? `，拥挤还剩 ${Math.ceil((RULES.crowdTicks - p.crowd) / RULES.hz)} 秒` : ''}`);
    // Transparent hit target stays on the station; visible cues render in Canvas2D on mobile.
    if (n.innerHTML) n.innerHTML = '';
  }
  if (mobileMap) {
    $('map-alerts').hidden = true;
    $('map-alerts').dataset.omitted = '';
    // Do not run the desktop collision/fallback layout: every mobile pile is in Canvas2D.
  } else renderer.updateSceneCues(s, placed);
  let fallbackWarnings = 0, fallbackQueues = 0;
  const omittedStationIds = new Set<number>();
  for (const p of s.stations) {
    const layout = byId.get(p.id);
    if (!layout) continue;
    if (layout.warningFallback) fallbackWarnings++;
    if (layout.queueFallback) fallbackQueues++;
    if (layout.warningFallback || layout.queueFallback) omittedStationIds.add(p.id);
  }
  const alerts = $('map-alerts');
  // A captured cycle stays available even if selection temporarily makes all
  // marks fit; the next click still visits its remaining stations.
  alerts.hidden = mobileMap || (fallbackWarnings === 0 && fallbackQueues === 0 && alertCycle.length === 0);
  alerts.dataset.omitted = [...omittedStationIds].join(',');
  // Announce omitted marks and keep the station picker navigable.
  alerts.textContent = [fallbackWarnings ? `⚠ ${fallbackWarnings} 站拥挤` : '',
    fallbackQueues ? `${fallbackQueues} 站候车详情请点站查看` : '',
    alertCycle.length ? `另有 ${alertCycle.length} 站待查看` : ''].filter(Boolean).join(' · ');
  alerts.title = fallbackWarnings ? '点击逐站查看拥挤详情' :
    alertCycle.length ? '点击查看剩余待查看车站' : '点击逐站查看候车详情';
  alerts.setAttribute('aria-label', `${alerts.textContent}，点击逐站查看`);
  const mobileCrowd = $('mobile-crowd-alert');
  if (mobileMap) {
    const crowded = s.stations.filter(p => p.crowd > 0);
    mobileCrowd.hidden = crowded.length === 0;
    mobileCrowd.textContent = mapFirst ? `⚠ ${crowded.length} 站` : `⚠ ${crowded.length} 站拥挤 · ${mobileCrowdIndex ? `${(mobileCrowdIndex - 1) % crowded.length + 1}/${crowded.length} · 下一站 ›` : '逐站定位 ›'}`;
    mobileCrowd.setAttribute('aria-label', `${crowded.length} 座车站拥挤，${mobileCrowdIndex ? `已查看第 ${(mobileCrowdIndex - 1) % crowded.length + 1} 站，点击前往下一站` : '点击逐站查看和定位'}`);
  } else mobileCrowd.hidden = true;
  const activeTrainIds = new Set(s.trains.map((t) => String(t.id)));
  const stationTrains = stationaryGroups;
  const visibleGroups = new Set([...stationTrains].filter(([, group]) => group.length > 1).map(([id]) => String(id)));
  for (const badge of trainLayer.querySelectorAll<HTMLButtonElement>('[data-train-group]')) {
    if (!visibleGroups.has(badge.dataset.trainGroup!)) badge.remove();
    else if (mobileMap) {
      const owner = s.stations.find(p => p.id === Number(badge.dataset.trainGroup));
      if (!owner) continue;
      const point = renderer.project(owner.x, owner.y, 0.9), bounds = stage.getBoundingClientRect();
      badge.style.left = `${point.x}px`;
      badge.style.top = `${point.y}px`;
      badge.hidden = mobileBadgeOffstage(badge, bounds);
    } else badge.hidden = false;
  }
  for (const badge of trainLayer.querySelectorAll<HTMLElement>('[data-train-id]'))
    if (!activeTrainIds.has(badge.dataset.trainId!)) badge.remove();
  for (const t of s.trains) {
    let badge = trainLayer.querySelector<HTMLButtonElement>(`[data-train-id="${t.id}"]`);
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'train-badge';
      badge.dataset.trainId = String(t.id);
      trainLayer.append(badge);
    }
    const a = s.stations.find((p) => p.id === t.from)!,
      b = t.to === null ? a : s.stations.find((p) => p.id === t.to)!,
      position = trackPosition(a, b, t.progress),
      point = renderer.projectTrain(t.id) ?? renderer.project(position.x, position.y, 0.9),
      capacity = RULES.capacity * (1 + t.carriages);
    // A parked train must not cover the station's primary touch/drag target.
    // Keep its own 44px hit target adjacent to, not centered on, the station.
    badge.style.left = `${point.x + (mobileMap && t.to === null ? 47 : 0)}px`;
    badge.style.top = `${point.y - (mobileMap && t.to === null ? 42 : 0)}px`;
    badge.style.setProperty('--line', LINE_COLORS[t.line]);
    badge.textContent = '';
    badge.setAttribute('aria-label', `${t.id} 号列车，${t.passengers.length}/${capacity} 人，点击查看目的地`);
    badge.classList.toggle('full', t.passengers.length >= capacity);
    badge.classList.toggle('train-badge-grouped', t.to === null && (stationTrains.get(t.from)?.length ?? 0) > 1);
    badge.hidden = (t.to === null && (stationTrains.get(t.from)?.length ?? 0) > 1) ||
      (mobileMap && mobileBadgeOffstage(badge, stageBounds));
  }
  for (const [stationId, group] of stationTrains) {
    if (group.length < 2) continue;
    let badge = trainLayer.querySelector<HTMLButtonElement>(`[data-train-group="${stationId}"]`);
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'train-badge train-group-badge';
      badge.dataset.trainGroup = String(stationId);
      trainLayer.append(badge);
    }
    const p = s.stations.find((station) => station.id === stationId)!;
    const q = renderer.project(p.x, p.y, 0.9);
    badge.style.left = `${q.x}px`;
    badge.style.top = `${q.y}px`;
    badge.hidden = mobileMap && mobileBadgeOffstage(badge, stageBounds);
    badge.textContent = '▰';
    badge.setAttribute('aria-label', `${p.id} 号车站有 ${group.length} 辆停靠列车，点击选择`);
  }
  paintHandles();
  if (selectedTrain === null && integrationSurface) {
    const detail = $('train-detail');
    if (detail.dataset.groupStation) {
      const stationId = Number(detail.dataset.groupStation);
      const group = stationTrains.get(stationId) ?? [];
      const key = group.map((t) => `${t.id}:${t.passengers.length}:${t.carriages}`).join(',');
      if (group.length < 2) {
        detail.hidden = true;
        delete detail.dataset.groupStation;
        delete detail.dataset.groupKey;
      } else if (detail.dataset.groupKey !== key) {
        detail.dataset.groupKey = key;
        detail.innerHTML = `<strong>${group.length} 辆停靠列车</strong><button type="button" id="train-detail-close" aria-label="收起列车列表">×</button><div class="train-group-list">${group.map((t) => `<button type="button" data-train-choice="${t.id}" style="--line:${LINE_COLORS[t.line]}">${t.id} 号列车 · ${t.passengers.length}/${RULES.capacity * (1 + t.carriages)}</button>`).join('')}</div>`;
      }
    }
  }
  if (selectedTrain !== null && integrationSurface) {
    const t = s.trains.find((item) => item.id === selectedTrain);
    if (!t) selectedTrain = null;
    const detail = $('train-detail');
    detail.hidden = !t;
    if (t) {
      delete detail.dataset.groupStation;
      delete detail.dataset.groupKey;
      const capacity = RULES.capacity * (1 + t.carriages),
        destinations = SHAPES.map((shape) => ({ shape, count: t.passengers.filter((p) => p.shape === shape).length }))
          .filter((item) => item.count)
          .map((item) => `${GLYPHS[item.shape]} ${item.count}`).join(' · '),
        shapes = t.passengers.map((p) => p.shape).join(','),
        key = JSON.stringify([t.id, capacity, shapes]);
      if (detail.dataset.key !== key) {
        detail.dataset.key = key;
        detail.dataset.shapes = shapes;
        detail.innerHTML = `<strong>▰ ${t.id} 号列车 · ${t.passengers.length}/${capacity} 人</strong><button type="button" id="train-detail-close" aria-label="收起列车详情">×</button><p>${t.passengers.length ? '车上目的地：' + destinations : '当前空车'}</p>`;
      }
    }
  }
  if (performance.now() - uiAt < 100) return;
  uiAt = performance.now();
  if (s.score > lastScore) audio.note([392, 440, 523, 587, 659][s.score % 5], 0.06);
  lastScore = s.score;
  $('score').textContent = String(s.score);
  $('city-name').textContent = CITY_NAMES[s.city];
  $('mode-label').textContent = {
    normal: '经典模式',
    endless: '无尽模式',
    extreme: '极限模式',
    creative: '创意模式',
  }[s.mode];
  const day = Math.floor(s.elapsed / RULES.dayTicks) % 7;
  $('week-label').textContent = `第 ${s.week} 周 · ${DAY_NAMES[day]}`;
  $('day-clock').textContent = DAY_NAMES[day];
  $('day-fill').style.width = `${((s.elapsed % RULES.weekTicks) / RULES.weekTicks) * 100}%`;
  $('clock').textContent = clock(s.tick);
  $('play-pause').textContent = controller.paused ? '▶' : 'Ⅱ';
  $('play-pause').setAttribute('aria-label', controller.paused ? '播放' : '暂停');
  $('map-status').textContent =
    controller.mode === 'replay'
      ? controller.focusedDecision !== null
        ? '决策前现场 · #' + controller.focusedDecision
        : '旅程回放'
      : controller.waiting
        ? '调度员思考中'
        : s.phase === 'over'
          ? '旅程结束'
          : s.phase === 'upgrade'
            ? '每周补给'
            : controller.paused
              ? '暂停 · 自由规划'
              : '小镇营业中';
  $('control-label').textContent =
    controller.mode === 'agent'
      ? '自动调度 · 已记录决策'
      : controller.mode === 'replay'
        ? '回放模式'
        : '手动规划';
  if (integrationSurface) $('agent-toggle').textContent =
    controller.mode === 'agent' ? '接管，自己来规划' : '启动自动调度 ↗';
  const l = s.lines[controller.selectedLine];
  const lk = JSON.stringify([
    s.lines,
    s.trains.map((t) => [t.line, t.retiring]),
    controller.selectedLine,
  ]);
  if (lk !== lineKey) {
    lineKey = lk;
    $('line-list').innerHTML =
      s.lines
        .map(
          (line) =>
            `<button class="line-choice ${line.id === l.id ? 'active' : ''}" data-line="${line.id}" aria-label="${line.id + 1} 号${LINE_NAMES[line.id]}，${line.stops.length} 站" title="${line.id + 1} 号${LINE_NAMES[line.id]} · ${line.stops.length} 站" style="--line:${LINE_COLORS[line.id]}"><i>${line.id + 1}</i><span>${LINE_NAMES[line.id]}<small>${line.stops.length ? `${line.stops.length} 站 · ${s.trains.filter((t) => t.line === line.id).length} 列车` : '等待第一段轨道'}</small></span><b>${line.loop ? '↻' : '↗'}</b></button>`,
        )
        .join('') +
      (s.lines.length < 7 ? '<div class="locked-line">＋ 新线路将在每周补给解锁</div>' : '');
  }
  $('line-chooser').textContent = `${l.id + 1}⌄`;
  if (!$('creative-picker').hidden && !$('creative-picker').childElementCount)
    $('creative-picker').innerHTML = creativeStationPicker();
  $('line-chooser').style.setProperty('--line', LINE_COLORS[l.id]);
  $('line-chooser').setAttribute('aria-label', `当前 ${l.id + 1} 号${LINE_NAMES[l.id]}，选择线路`);
  $('line-dot').style.background = LINE_COLORS[l.id];
  $('line-name').textContent = LINE_NAMES[l.id];
  $('line-length').textContent = l.stops.length ? `${l.stops.length} 站` : '';
  $('route-text').textContent = l.stops.length
    ? l.stops
        .map((id) => {
          const p = s.stations.find((p) => p.id === id)!;
          return `${GLYPHS[p.shape]} ${id}`;
        })
        .join(' — ') + (l.loop ? ' ↻' : '')
    : '从一座车站拖到另一座，画出第一条线路。';
  $('loop-line').textContent = l.loop ? '打开环线' : '闭合环线';
  $('redraw').classList.toggle('armed', redrawing);
  const ts = s.trains.filter((t) => t.line === l.id),
    tk = JSON.stringify(
      ts.map((t) => [t.id, t.carriages, t.passengers.map((p) => p.shape), t.retiring, t.moveTo]),
    );
  if (tk !== trainKey) {
    trainKey = tk;
    $('train-list').innerHTML = ts
      .map(
        (t) =>
          `<div class="train-row"><span><b>▰ ${t.id}</b> <small>${t.passengers.length}/${RULES.capacity * (1 + t.carriages)}${t.retiring ? ' 回库' : t.moveTo ? ' 调动' : ''}</small><span class="train-destinations" aria-label="车上乘客目的地">${t.passengers.length ? SHAPES.map((shape) => ({ shape, count: t.passengers.filter((p) => p.shape === shape).length })).filter((item) => item.count).map((item) => `${GLYPHS[item.shape]}${item.count}`).join(' ') : '空车'}</span></span><div><button data-car="${t.id}" title="加挂车厢">＋</button><button data-uncar="${t.id}" title="拆卸车厢">−</button><button data-move="${t.id}" title="调往下一条已运营线路">⇄</button><button data-retire="${t.id}" title="回收列车">↩</button></div></div>`,
      )
      .join('');
  }
  $('resources').innerHTML =
    `<div><span>▰ 机车</span><b>${s.resources.locomotives}</b></div><div><span>▱ 车厢</span><b>${s.resources.carriages}</b></div><div><span>⌒ 隧道</span><b>${s.resources.tunnels - tunnelsUsed(s)}<small> / ${s.resources.tunnels}</small></b></div><div><span>✦ 枢纽</span><b>${s.resources.interchanges}</b></div>`;
  $('inspector-resources').innerHTML = $('resources').innerHTML;
  const first = !s.lines.some((l) => l.stops.length);
  $('map-hint').hidden = !first || controller.mode === 'replay';
  const p = s.stations.find((p) => p.id === selectedStation),
    dk = JSON.stringify(p);
  $('station-detail').hidden = !integrationSurface || (!p && s.mode !== 'creative');
  const peek = $('station-peek');
  if (!peek.hidden) {
    if (!p) peek.hidden = true;
    else {
      const shapes = SHAPES.map((shape) => ({ shape, n: p.queue.filter((v) => v.shape === shape).length }))
        .filter((item) => item.n).map((item) => `${GLYPHS[item.shape]}×${item.n}`).join(' ');
      peek.textContent = `车站 ${p.id} · 候车 ${p.queue.length} 人${shapes ? `：${shapes}` : ''} · ${p.crowd ? crowdRemaining(p.crowd) : '正常'}`;
    }
  }
  if (p && dk !== detailKey) {
    detailKey = dk;
    const destinations = SHAPES.map((shape) => ({
      shape,
      n: p.queue.filter((v) => v.shape === shape).length,
    })).filter((x) => x.n);
    $('station-detail').innerHTML =
      `<span class="eyebrow">STATION ${p.id.toString().padStart(2, '0')}</span><h3>${GLYPHS[p.shape]} ${p.interchange ? '换乘枢纽' : '小镇车站'}</h3><div class="station-stats"><b>${p.queue.length}<small> / ${stationCapacity(p)} 人候车</small></b><span>${p.crowd ? crowdRemaining(p.crowd) : '秩序良好'}</span></div><p>${destinations.map((v) => `${GLYPHS[v.shape]} × ${v.n}`).join('　') || '还没有等候乘客'}</p><div class="button-pair"><button id="upgrade-station">扩建枢纽</button><button id="remove-station">移出所选线</button></div>${s.mode === 'creative' ? creativeStationPicker() : ''}`;
  }
  if (s.mode === 'creative' && !p && detailKey !== 'creative') {
    detailKey = 'creative';
    $('station-detail').innerHTML =
      `<span class="eyebrow">CREATIVE CITY</span><p>选择站型，再点击空白地面建站。</p>${creativeStationPicker()}`;
  }
  $('station-detail').hidden = !integrationSurface || (!p && s.mode !== 'creative');
  const records = controller.decisions,
    last =
      controller.focusedDecision !== null
        ? records[controller.focusedDecision]
        : controller.mode === 'replay'
          ? records.findLast((d) => d.tick <= s.tick)
          : records.at(-1);
  const dkey = `${records.length}:${controller.mode}:${decisionPage}:${last?.id}`;
  if (dkey !== decisionKey) {
    decisionKey = dkey;
    if (integrationSurface) {
      $('last-decision').innerHTML = last
        ? `<span class="eyebrow">最近一次决策 · ${clock(last.tick)}</span><p>${escape(last.reason || last.action.type)}</p>${!last.result.ok ? `<small class="error">${escape(last.result.message)}</small>` : ''}<button class="text-button" data-decision="${last.id}">查看决策现场 ↗</button>`
        : '';
    }
    $('decision-count').textContent = String(records.length);
    $('decision-list').innerHTML =
      [...records]
        .reverse()
        .slice(decisionPage * 80, (decisionPage + 1) * 80)
        .map(
          (d) =>
            `<button class="decision-row" data-decision="${d.id}"><span>${clock(d.tick)} · ${escape(d.source)}${d.result.ok ? '' : ' · 未执行'}</span><p>${escape(d.reason || d.action.type)}</p></button>`,
        )
        .join('') || '<p class="muted">第一条线路，会是第一条记录。</p>';
  }
  const slider = $<HTMLInputElement>('timeline');
  slider.max = String(Math.max(1, controller.replayDuration));
  slider.value = String(s.tick);
  slider.disabled = controller.mode !== 'replay';
  $('replay-position').textContent = clock(s.tick);
  $('replay-duration').textContent = clock(controller.replayDuration);
  const postgame = $('postgame-replay');
  postgame.hidden = integrationSurface || controller.mode !== 'replay';
  const postSlider = $<HTMLInputElement>('postgame-timeline');
  postSlider.max = String(Math.max(1, controller.replayDuration));
  postSlider.value = String(s.tick);
  $('postgame-play').textContent = controller.paused ? '播放' : '暂停';
  const pk = `${s.phase}:${s.week}:${s.lostStation}:${controller.mode}`;
  if (pk !== phaseKey) {
    phaseKey = pk;
    $('upgrade-panel').hidden = s.phase !== 'upgrade' || controller.mode !== 'human';
    $('game-over').hidden = s.phase !== 'over';
    if (s.phase === 'upgrade')
      $('upgrade-panel').innerHTML =
        `<div class="supply-stamp">✦</div><span class="eyebrow">A NEW WEEK, A LITTLE GIFT</span><h2>第 ${s.week} 周，继续出发。</h2><p>每周免费机车 ×1 已自动入库。从下方两项中任选一项额外补给；选择不会再次领取机车。</p><div class="upgrade-options">${s.upgrades.map((choice) => `<button data-upgrade="${choice}"><b>${choice === 'line' ? '⌁' : choice === 'carriage' ? '▰ ▱' : choice === 'tunnels' ? '⌒ ⌒' : '✦'}</b><strong>${UPGRADE_NAMES[choice]}</strong></button>`).join('')}</div>`;
    if (s.phase === 'over')
      $('game-over').innerHTML =
        `<div class="supply-stamp">♧</div><span class="eyebrow">THANK YOU FOR THE JOURNEY</span><h2>小镇需要休息一会儿。</h2><p>${s.lostStation} 站拥挤过久。这段旅程共送达</p><strong class="final-score">${s.score}<small> 位乘客</small></strong><div class="button-pair"><button id="over-replay">回看这段旅程</button><button id="over-restart" class="primary">相同种子重试 ↗</button><button id="over-new-seed">新种子开局</button></div>`;
  }
}
controller.onChange = update;
controller.capture = () => renderer.capture();
update();
if (shortPhone.matches) setMapFirst(true);
window.matchMedia('(max-width: 650px)').addEventListener('change', event => {
  if (mobileMap === event.matches) return;
  if (!event.matches) setMapFirst(false);
  if (!event.matches && renderer instanceof Mobile3DRenderer) mobileCameraSnapshot = renderer.cameraState();
  renderer.dispose();
  mobileMap = event.matches;
  syncMapKeyboardTarget();
  renderer = mobileMap ? new Mobile3DRenderer(stage, syncMobileCameraTargets) : new MetroRenderer(stage);
  if (mobileMap && shortPhone.matches) renderer.setZoom(normalZoom);
  stationKey = trainKey = detailKey = '';
  update();
  if (mobileMap && shortPhone.matches) setMapFirst(true);
  if (mobileMap && mobileCameraSnapshot && renderer instanceof Mobile3DRenderer) {
    renderer.restoreCamera(mobileCameraSnapshot);
    mobileCameraSnapshot = null;
    syncMobileCameraTargets();
  }
  syncQueueFocusControls();
});
function syncQueueFocusControls():void {
  const canFocus=renderer instanceof Mobile3DRenderer;
  const ready=canFocus && queueBrowserStation!==null;
  for(const id of ['queue-focus-station','queue-focus-pile'] as const) {
    const button=$<HTMLButtonElement>(id);
    button.disabled=!ready;
    button.hidden=!canFocus;
  }
}
$('queue-browser-toggle').onclick = () => {
  const dialog = $<HTMLDialogElement>('queue-browser');
  const stations = controller.getState().stations.filter(station=>station.queue.length);
  $('queue-browser-content').innerHTML = `<h2>各站候车</h2><p>逐站查看真实目的地人数；不会改变线路或乘客。</p><div class="queue-station-list">${stations.map(s=>`<button type="button" data-queue-station="${s.id}">车站 ${s.id} · ${s.queue.length} 人</button>`).join('')}</div><div id="queue-browser-detail" role="status">选择车站查看各目的地。</div>`;
  queueBrowserStation=null;
  syncQueueFocusControls();
  dialog.showModal();
};
let queueBrowserStation: number | null = null;
$('queue-browser-content').addEventListener('click',e=>{
  const button=(e.target as Element).closest<HTMLButtonElement>('[data-queue-station]');
  if(!button)return;
  const station=controller.getState().stations.find(s=>s.id===Number(button.dataset.queueStation));
  if(!station)return;
  queueBrowserStation=station.id;
  for(const b of $('queue-browser-content').querySelectorAll<HTMLButtonElement>('[data-queue-station]')) b.setAttribute('aria-pressed',String(b===button));
  const counts=new Map<Shape,number>();
  for(const passenger of station.queue) counts.set(passenger.shape,(counts.get(passenger.shape)??0)+1);
  $('queue-browser-detail').innerHTML=`<h3>车站 ${station.id} · ${station.queue.length} 人</h3><div class="queue-shapes">${SHAPES.filter(shape=>counts.has(shape)).map(shape=>`<span data-queue-shape="${shape}" data-queue-count="${counts.get(shape)}">${GLYPHS[shape]} ×${counts.get(shape)}</span>`).join('')}</div>`;
  syncQueueFocusControls();
});
function queueBrowserFocus(pile:boolean):void {
  if(!(renderer instanceof Mobile3DRenderer)||queueBrowserStation===null)return;
  const p=renderer.mapStats().bounds.find(p=>p.id===queueBrowserStation);
  if(!p)return;
  $<HTMLDialogElement>('queue-browser').close();
  hideContext();
  if(pile && p.pile) {
    const station=controller.getState().stations.find(s=>s.id===p.id);
    if(!station)return;
    // Grouped WebGL glyphs have fixed CSS-pixel rows, independent of map zoom.
    // Position the roof and entire pile between the 12px target margin and
    // the bottom of the shortest possible drawable stage (with a cue row).
    const groups=renderer.mapStats().queueGroups.find(g=>g.stationId===p.id)?.groups.length??0;
    const rows=Math.floor((groups-1)/2);
    const rowReserve=shortPhone.matches && stage.clientWidth>=500 &&
      !stage.parentElement?.querySelector('.mobile-owner-cue') ? 44 : 0;
    const available=stage.clientHeight-rowReserve;
    // The cue row can reserve 44px between the focus paint and its ResizeObserver.
    // A 20px roof would then land above the stage, re-triggering the cue forever.
    const minRoof=stage.clientWidth<360?64:20, maxRoof=available-56-rows*22;
    const desired=stage.clientWidth<360?minRoof:Math.max(minRoof,Math.min(available/2,maxRoof));
    // Do not zoom below the renderer floor: it cannot compress CSS glyph rows.
    renderer.setZoom(Math.min(renderer.getZoom(),Math.max(.55,(available-68)/(p.pile.y+p.pile.height+8-p.y))));
    renderer.centerStationAt(station.x,station.y,desired);
    const mobileRenderer=renderer;
    // A cue may be added or removed after painting; settle against the actual
    // resized camera and DOM, then reproject hit targets in the same frame.
    let remaining=10;
    const settle=()=>{
      if(renderer!==mobileRenderer || queueBrowserStation!==p.id)return;
      const roof=mobileRenderer.project(station.x,station.y,.6).y;
      const actualGroups=mobileRenderer.mapStats().queueGroups.find(g=>g.stationId===p.id)?.groups??[];
      // A focused owner can be far offscreen when a prior cue changes the stage.
      // Move it back before measuring the pile against the resized viewport.
      if(roof<minRoof || roof>stage.clientHeight-56) {
        mobileRenderer.centerStationAt(station.x,station.y,minRoof);
        syncMobileCameraTargets();
        if(--remaining>0)requestAnimationFrame(settle);
        return;
      }
      const pileBottom=Math.max(0,...actualGroups.map(g=>g.y+8));
      const upper=stage.clientHeight-12-(pileBottom-roof);
      const target=Math.max(minRoof,Math.min(roof,upper));
      if(Math.abs(target-roof)>0.5)mobileRenderer.centerStationAt(station.x,station.y,target);
      syncMobileCameraTargets();
      if(--remaining>0)requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  } else renderer.centerAt(p.x,p.y);
  syncMobileCameraTargets();
}
$('queue-focus-station').onclick=()=>queueBrowserFocus(false);
$('queue-focus-pile').onclick=()=>queueBrowserFocus(true);
$('queue-browser-close').onclick=()=>$<HTMLDialogElement>('queue-browser').close();
$('mobile-crowd-alert').onclick = () => {
  if (!(renderer instanceof Mobile3DRenderer)) return;
  const crowded = controller.getState().stations.filter(p => p.crowd > 0)
    .sort((a,b) => b.crowd - a.crowd || a.id - b.id);
  if (!crowded.length) return;
  const station = crowded[mobileCrowdIndex++ % crowded.length];
  hideContext();
  const mapPoint = renderer.mapStats().bounds.find(p => p.id === station.id);
  if (!mapPoint) return;
  if (mapFirst) renderer.setZoom(Math.max(1.4, renderer.getZoom()));
  // A crowd focus should prioritize the selected station's 44px target over
  // its pile's midpoint; the queue browser provides separate pile focus.
  renderer.centerStationAt(station.x, station.y, Math.max(22, stage.clientHeight / 2));
  syncMobileCameraTargets();
  if (integrationSurface) showStationPeek(station.id);
  // Owner-cue rows and station detail can resize the canvas after this click.
  // Keep the same focused roof inside the final drawable bounds.
  const mobileRenderer = renderer;
  let remaining = 3;
  const settleCrowd = () => {
    if (renderer !== mobileRenderer) return;
    const roof = mobileRenderer.project(station.x, station.y, 0.6).y;
    if (roof < 22 || roof > stage.clientHeight - 22) {
      mobileRenderer.centerStationAt(station.x, station.y, Math.max(22, stage.clientHeight / 2));
      syncMobileCameraTargets();
    }
    if (--remaining > 0) requestAnimationFrame(settleCrowd);
  };
  requestAnimationFrame(settleCrowd);
};
$('map-alerts').onclick = () => {
  const s = controller.getState();
  if (!alertCycle.length) {
    const omitted = new Set(($('map-alerts').dataset.omitted ?? '').split(',').map(Number));
    alertCycle = [...s.stations].filter((p) => omitted.has(p.id))
      .sort((a, b) => b.crowd - a.crowd || b.queue.length - a.queue.length || a.id - b.id)
      .map((p) => p.id);
  }
  const nextId = alertCycle.shift();
  if (nextId === undefined) return;
  selectedStation = nextId;
  setInspector(false);
  const label = nodes.get(nextId);
  if (label) label.focus({ preventScroll: true });
  update();
  const station = controller.getState().stations.find((p) => p.id === nextId);
  if (station) {
    const shapes = SHAPES.map((shape) => ({ shape, n: station.queue.filter((v) => v.shape === shape).length }))
      .filter((item) => item.n).map((item) => `${GLYPHS[item.shape]}×${item.n}`).join(' ');
    $('station-peek').textContent = `车站 ${station.id} · 候车 ${station.queue.length} 人${shapes ? `：${shapes}` : ''} · ${station.crowd ? crowdRemaining(station.crowd) : '正常'}`;
    $('station-peek').hidden = false;
  }
};
$('line-tools-toggle').onclick = () => setLineTools($('line-tools').hidden);
$('line-tools-close').onclick = () => setLineTools(false);
$('tools-toggle').onclick = () => {
  if (!$('inspector').hidden && $('replay-pane').hidden) setInspector(false);
  else setTab(false);
};
$('replay-toggle').onclick = () => {
  if (!$('inspector').hidden && !$('replay-pane').hidden) setInspector(false);
  else setTab(true);
};
$('inspector-close').onclick = () => setInspector(false);
if (integrationSurface) {
  $('agent-observation').onclick = () => {
    controller.setPaused(true);
    $('observation-json').textContent = JSON.stringify(observeState(controller.getState()), null, 2);
    $<HTMLDialogElement>('observation-dialog').showModal();
  };
  $('observation-close').onclick = () => $<HTMLDialogElement>('observation-dialog').close();
}

$('line-list').addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('[data-line]');
  if (b) setLine(Number(b.dataset.line));
});
$('line-chooser').onclick = () => setLineChooser($('line-chooser').getAttribute('aria-expanded') !== 'true');
document.addEventListener('pointerdown', (e) => {
  if (!(e.target as Element).closest('.left-panel')) setLineChooser(false);
});
$('redraw').onclick = () => {
  redrawing = true;
  toast('从任意车站拖起，重新画出整条线路。');
  uiAt = 0;
};
$('loop-line').onclick = () => {
  const l = currentLine();
  act(
    { type: 'route', line: l.id, stops: l.stops, loop: !l.loop },
    l.loop ? '打开环线。' : '闭合为环线。',
  );
};
$('clear-line').onclick = () =>
  act({ type: 'route', line: controller.selectedLine, stops: [] }, '撤销线路，列车到站后回库。');
$('add-train').onclick = () =>
  act({ type: 'addTrain', line: controller.selectedLine }, '为所选线路增派列车。');
$('train-list').addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('button');
  if (!b) return;
  if (b.dataset.car)
    act({ type: 'carriage', train: Number(b.dataset.car), delta: 1 }, '为列车加挂一节车厢。');
  if (b.dataset.uncar)
    act({ type: 'carriage', train: Number(b.dataset.uncar), delta: -1 }, '回收一节空余车厢。');
  if (b.dataset.retire)
    act({ type: 'removeTrain', train: Number(b.dataset.retire) }, '列车将在下一站清客并回库。');
  if (b.dataset.move) {
    const s = controller.getState(),
      others = s.lines.filter((l) => l.stops.length && l.id !== controller.selectedLine);
    if (!others.length) toast('先开通另一条线路，再调动列车。');
    else
      act(
        {
          type: 'moveTrain',
          train: Number(b.dataset.move),
          line: others[0].id,
          station: others[0].stops[0],
        },
        `将列车调往 ${others[0].id + 1} 号线。`,
      );
  }
});
$('play-pause').onclick = () => controller.setPaused(!controller.paused);
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach(
  (b) =>
    (b.onclick = () => {
      controller.setSpeed(Number(b.dataset.speed));
      document
        .querySelectorAll<HTMLButtonElement>('[data-speed]')
        .forEach((e) => {
          e.classList.toggle('active', e === b);
          e.setAttribute('aria-pressed', String(e === b));
        });
    }),
);
if (integrationSurface) {
  $('agent-toggle').onclick = () => {
    if (controller.mode === 'agent') {
      controller.takeControl();
      toast('已接管调度。');
    } else
      try {
        controller.startAgent();
        toast('内置调度策略已接入。');
      } catch (e) {
        toast(String(e));
      }
  };
  $('connect-agent').onclick = () => {
    try {
      controller.connectHttp($<HTMLInputElement>('agent-url').value);
      toast('正在连接 HTTP Agent。');
    } catch (e) {
      toast(String(e));
    }
  };
}
$('tab-dispatch').onclick = () => setTab(false);
$('tab-replay').onclick = () => setTab(true);
$('sound').onclick = async () => {
  $('sound').classList.toggle('sound-on', !(await audio.toggle()));
};
$('zoom-in').onclick = () => { renderer.setZoom(renderer.getZoom() + 0.15); if (mobileMap) syncMobileCameraTargets(); };
$('zoom-out').onclick = () => { renderer.setZoom(renderer.getZoom() - 0.15); if (mobileMap) syncMobileCameraTargets(); };
$('zoom-reset').onclick = () => {
  renderer.resetCamera();
  if (mapFirst && renderer instanceof Mobile3DRenderer && stage.clientWidth <= stage.clientHeight)
    renderer.setZoom(stage.clientWidth < 360 ? 0.55 : 1);
  if (mobileMap) syncMobileCameraTargets();
};
function download(name: string, content: Blob | string): void {
  const url = typeof content === 'string' ? content : URL.createObjectURL(content),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  if (typeof content !== 'string') setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('screenshot').onclick = () => download(`orchard-metro-${Date.now()}.png`, renderer.capture());
const HISTORY = 'orchard-metro.history.v1';
function history(): { name: string; replay: Replay }[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY) || '[]');
  } catch {
    return [];
  }
}
function saveLocal(silent = false): void {
  try {
    const replay = controller.exportReplay(),
      s = controller.getState(),
      items = history();
    items.unshift({ name: `${CITY_NAMES[s.city]} · ${s.score} 人 · ${clock(s.tick)}`, replay });
    localStorage.setItem(HISTORY, JSON.stringify(items.slice(0, 5)));
    if (!silent) toast('已保存在本机浏览器。');
    refreshHistory();
  } catch {
    if (!silent) toast('本机存储空间不足，请导出 JSON。');
  }
}
function refreshHistory(): void {
  $('history-list').innerHTML =
    history()
      .map(
        (item, i) =>
          `<button class="history-row" data-history="${i}" ${item.replay.format !== 'orchard-metro.replay.v6' ? 'disabled title="旧版录像与新版规则不兼容"' : ''}><span>↺ ${escape(item.name)}${item.replay.format !== 'orchard-metro.replay.v6' ? ' · 旧版不可回放' : ''}</span><small>${escape(item.replay.createdAt.slice(0, 16).replace('T', ' '))}</small></button>`,
      )
      .join('') || '<p class="muted">暂时没有保存的旅程。</p>';
}
function replayCurrent(): void {
  try {
    const r = controller.exportReplay();
    saveLocal(true);
    controller.loadReplay(r);
    resetView();
    if (integrationSurface) setTab(true);
    toast('录像已校验。按播放键或拖动时间查看。');
  } catch (e) {
    toast(String(e));
  }
}
$('replay-current').onclick = replayCurrent;
$<HTMLInputElement>('postgame-timeline').oninput = (event) => {
  if (controller.mode !== 'replay') return;
  controller.setPaused(true);
  controller.seek(Number((event.target as HTMLInputElement).value));
};
$('postgame-play').onclick = () => { if (controller.mode === 'replay') controller.setPaused(!controller.paused); };
$('postgame-restart').onclick = () => {
  const s = controller.getState();
  controller.restart({ seed: s.seed, city: s.city, mode: s.mode });
  resetView();
};
$('postgame-new').onclick = () => $<HTMLDialogElement>('settings-dialog').showModal();
$('save-local').onclick = () => saveLocal();
$('refresh-history').onclick = refreshHistory;
$('export-replay').onclick = () =>
  download(
    `orchard-metro-${Date.now()}.json`,
    new Blob([JSON.stringify(controller.exportReplay())], { type: 'application/json' }),
  );
$('import-replay').onclick = () => $<HTMLInputElement>('import-file').click();
$<HTMLInputElement>('import-file').onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error('录像超过 32 MiB');
    const text = await file.text();
    controller.loadReplay(text);
    resetView();
    setTab(true);
    toast('录像校验通过。');
  } catch (error) {
    toast(`导入失败：${String(error)}`);
  }
  input.value = '';
};
$('history-list').onclick = (e) => {
  const b = (e.target as Element).closest<HTMLElement>('[data-history]');
  if (b) {
    try {
      controller.loadReplay(history()[Number(b.dataset.history)].replay);
      resetView();
      toast('本机录像已校验并打开。');
    } catch (e) {
      toast(String(e));
    }
  }
};
$<HTMLInputElement>('timeline').oninput = (e) => {
  const tick = Number((e.target as HTMLInputElement).value);
  controller.setPaused(true);
  controller.seek(tick);
};
function seekBy(ticks: number): void {
  try {
    controller.setPaused(true);
    controller.seek(controller.getState().tick + ticks);
  } catch (e) {
    toast(String(e));
  }
}
$('step-back').onclick = () => seekBy(-5 * RULES.hz);
$('step-forward').onclick = () => seekBy(5 * RULES.hz);
$('decisions-earlier').onclick = () => {
  decisionPage = Math.max(
    0,
    Math.min(Math.floor((controller.decisions.length - 1) / 80), decisionPage + 1),
  );
  uiAt = 0;
};
$('decisions-later').onclick = () => {
  decisionPage = Math.max(0, decisionPage - 1);
  uiAt = 0;
};
$('new-game').onclick = () => {
  $<HTMLDialogElement>('settings-dialog').showModal();
};
$('settings-cancel').onclick = () => $<HTMLDialogElement>('settings-dialog').close();
$('settings-form').onsubmit = (e) => {
  e.preventDefault();
  try {
    const options: Options = {
      seed: Number($<HTMLInputElement>('seed-input').value),
      city: $<HTMLSelectElement>('city-select').value as City,
      mode: $<HTMLSelectElement>('mode-select').value as Mode,
    };
    saveLocal(true);
    controller.restart(options);
    resetView();
    setTab(false, false);
    $<HTMLDialogElement>('settings-dialog').close();
    toast('新旅程准备好了。');
  } catch (error) {
    toast(String(error));
  }
};
$('help').onclick = () => $<HTMLDialogElement>('help-dialog').showModal();
$('help-close').onclick = () => $<HTMLDialogElement>('help-dialog').close();
$('decision-close').onclick = () => $<HTMLDialogElement>('decision-dialog').close();
let placing: Shape | null = null;
$('creative-picker').addEventListener('click', (e) => {
  const target = (e.target as Element).closest<HTMLElement>('[data-station-shape]');
  if (!target) return;
  const shape = target.dataset.stationShape as Shape;
  if (!SHAPES.includes(shape)) return;
  placing = shape;
  toast(`点击地图空白处，建造 ${GLYPHS[shape]} 车站。`);
});
app.addEventListener('click', (e) => {
  const target = (e.target as Element).closest<HTMLElement>('button');
  if (!target) return;
  if (target.dataset.upgrade)
    act({ type: 'upgrade', choice: target.dataset.upgrade as 'line' }, '选择每周补给。');
  if (target.id === 'upgrade-station' && selectedStation !== null)
    act({ type: 'interchange', station: selectedStation }, '扩建候车与换乘空间。');
  if (target.id === 'remove-station' && selectedStation !== null) removeStation(selectedStation);
  if (target.id === 'over-replay') replayCurrent();
  if (target.id === 'over-restart' || target.id === 'over-new-seed') {
    const s = controller.getState();
    saveLocal(true);
    controller.restart({
      seed: target.id === 'over-restart' ? s.seed : (s.seed + 1) >>> 0,
      city: s.city,
      mode: s.mode,
    });
    resetView();
  }
  if (target.dataset.stationShape) {
    const shape = target.dataset.stationShape as Shape;
    if (!SHAPES.includes(shape)) return;
    placing = shape;
    toast(`点击地图空白处，建造 ${GLYPHS[shape]} 车站。`);
  }
  if (target.dataset.decision !== undefined) {
    const index = Number(target.dataset.decision);
    try {
      const d = controller.decisions[index],
        o = controller.observationAtDecision(index);
      controller.setPaused(true);
      $('decision-content').innerHTML =
        `<p><b>${clock(d.tick)}</b> · ${escape(d.source)} · ${d.elapsedMs.toFixed(1)} ms</p><blockquote>${escape(d.reason || '无决策说明')}</blockquote><p>${d.result.ok ? '✓ 已执行' : '未执行'}：${escape(d.result.message)}</p>${d.error ? `<p class="error">${escape(d.error)}</p>` : ''}<p>决策前：${o.state.stations.length} 站，${o.state.trains.length} 列车，${o.state.score} 人送达<br>观察哈希：<code>${hash(o.state)}</code></p>${d.candidates?.length ? `<ul>${d.candidates.map((c) => `<li>${escape(c.label)}：${c.value}</li>`).join('')}</ul>` : ''}<details><summary>操作与当时观察的 JSON</summary><pre>${escape(JSON.stringify({ action: d.action, observation: o }, null, 2))}</pre></details><button class="soft-button full" id="jump-decision">在地图中查看决策前局面</button>`;
      $<HTMLDialogElement>('decision-dialog').showModal();
      $('jump-decision').onclick = () => {
        if (controller.mode !== 'replay') replayCurrent();
        controller.focusDecision(index);
        $<HTMLDialogElement>('decision-dialog').close();
        toast('已还原这条决策执行前的地图，按播放继续查看后续操作。');
      };
    } catch (error) {
      toast(String(error));
    }
  }
});
trainLayer.addEventListener('click', (e) => {
  const target = e.target as Element;
  // Pointerup already inspected the rendered core; a synthesized badge click
  // must not replace its station peek with train detail.
  if (mobileMap && nearestStationCore(e.clientX, e.clientY) !== null) return;
  const group = target.closest<HTMLElement>('[data-train-group]');
  if (group) {
    const hitStation = stationUnderPointer(e.clientX, e.clientY);
    if (hitStation !== null && hitStation !== Number(group.dataset.trainGroup)) return;
    e.stopPropagation();
    if (!integrationSurface) {
      const train = controller.getState().trains.find(t => t.from === Number(group.dataset.trainGroup) && t.to === null);
      if (train) showContext({ type: 'train', id: train.id });
      return;
    }
    $('station-peek').hidden = true;
    selectedStation = null;
    const stationId = Number(group.dataset.trainGroup);
    const trains = controller.getState().trains.filter((t) => t.from === stationId && t.to === null);
    const detail = $('train-detail');
    detail.hidden = false;
    detail.removeAttribute('data-key');
    detail.dataset.groupStation = String(stationId);
    detail.dataset.groupKey = trains.map((t) => `${t.id}:${t.passengers.length}:${t.carriages}`).join(',');
    detail.innerHTML = `<strong>${trains.length} 辆停靠列车</strong><button type="button" id="train-detail-close" aria-label="收起列车列表">×</button><div class="train-group-list">${trains.map((t) => `<button type="button" data-train-choice="${t.id}" style="--line:${LINE_COLORS[t.line]}">${t.id} 号列车 · ${t.passengers.length}/${RULES.capacity * (1 + t.carriages)}</button>`).join('')}</div>`;
    selectedTrain = null;
    return;
  }
  const badge = target.closest<HTMLElement>('[data-train-id]');
  if (!badge) return;
  if (!mobileMap && (nearestStationCore(e.clientX, e.clientY) !== null ||
    stationUnderPointer(e.clientX, e.clientY) !== null)) return;
  e.stopPropagation();
  if (!integrationSurface) {
    showContext({ type: 'train', id: Number(badge.dataset.trainId) });
    return;
  }
  $('station-peek').hidden = true;
  selectedStation = null;
  selectedTrain = Number(badge.dataset.trainId);
  uiAt = 0;
  update();
});
$('train-detail').addEventListener('click', (e) => {
  const choice = (e.target as Element).closest<HTMLElement>('[data-train-choice]');
  if (choice) {
    selectedTrain = Number(choice.dataset.trainChoice);
    $('train-detail').removeAttribute('data-key');
    uiAt = 0;
    update();
    return;
  }
  if (!(e.target as Element).closest('#train-detail-close')) return;
  selectedTrain = null;
  delete $('train-detail').dataset.groupStation;
  delete $('train-detail').dataset.groupKey;
  $('train-detail').hidden = true;
});
stage.addEventListener('click', (e) => {
  if (suppressCreativeClick) { suppressCreativeClick = false; return; }
  if (!placing) return;
  const rect = stage.getBoundingClientRect(),
    localX = e.clientX - rect.left, localY = e.clientY - rect.top,
    p = renderer instanceof Mobile3DRenderer ? renderer.unprojectGround(localX, localY)
      : renderer.unproject(localX, localY);
  if (p) {
    act({ type: 'station', ...p, shape: placing }, '在创意地图中建造新车站。');
    placing = null;
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && armedEndpoint) {
    disarmEndpoint();
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && !integrationSurface && !$('context-actions').hidden) {
    hideContext();
    e.preventDefault();
    return;
  }
  if (
    (e.target as HTMLElement).matches('input,select,textarea') ||
    (e.code === 'Space' && (e.target as HTMLElement).matches('button')) ||
    document.querySelector('dialog[open]')
  )
    return;
  if (e.key.toLowerCase() === 'm' && !e.altKey && !e.ctrlKey && !e.metaKey &&
      !(e.target as HTMLElement).closest('button, [contenteditable="true"]') && shortPhone.matches) {
    e.preventDefault();
    setMapFirst(!mapFirst);
  }
  if (e.code === 'Space') {
    e.preventDefault();
    controller.setPaused(!controller.paused);
  }
  if (/^[1-7]$/.test(e.key) && Number(e.key) <= controller.getState().lines.length)
    setLine(Number(e.key) - 1);
  if (e.key === 'Escape') {
    setLineChooser(false);
    draft = null;
    redrawing = false;
    placing = null;
    selectedTrain = null;
    $('train-detail').hidden = true;
    delete $('train-detail').dataset.groupStation;
    delete $('train-detail').dataset.groupKey;
    renderer.clearPreview();
    setInspector(false);
    setLineTools(false);
  }
});
window.addEventListener('beforeunload', () => {
  if (controller.getState().tick > 0) saveLocal(true);
});
const api = {
  controller,
  observe: () => controller.observe(),
  getState: () => controller.getState(),
  submit: (d: Parameters<MetroController['submit']>[0], source?: string) =>
    controller.submit(d, source),
  step: (n: number) => controller.step(n),
  pause: (v = true) => controller.setPaused(v),
  restart: (o: Options = {}) => {
    controller.restart(o);
    resetView();
  },
  startAgent: (...a: Parameters<MetroController['startAgent']>) => controller.startAgent(...a),
  stopAgent: () => controller.takeControl(),
  connectHttp: (url: string) => controller.connectHttp(url),
  exportReplay: () => controller.exportReplay(),
  loadReplay: (r: Replay | string) => {
    controller.loadReplay(r);
    resetView();
    setTab(true);
  },
  seek: (tick: number) => controller.seek(tick),
  focusDecision: (index: number) => controller.focusDecision(index),
  observationAtDecision: (i: number) => controller.observationAtDecision(i),
  // Capture only the game canvas, with its scene cues, not DOM HUD or AI controls.
  capture: () => renderer.capture(),
  projectStation: (id: number) => {
    const p = controller.getState().stations.find((p) => p.id === id);
    if (!p) throw new Error('车站不存在');
    const point = renderer.project(p.x, p.y, 0.6),
      rect = stage.getBoundingClientRect();
    return { x: point.x + rect.left, y: point.y + rect.top };
  },
  sceneCues: () => renderer.cueStats(),
  mobileMapStats: () => renderer instanceof Mobile3DRenderer ? renderer.mapStats() : null,
  hash: () => hash(controller.getState()),
};
(window as unknown as { metro: typeof api }).metro = api;
