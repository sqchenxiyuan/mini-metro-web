// SPDX-License-Identifier: GPL-3.0-or-later
import './style.css';
import './minimal.css';
import { MetroController } from './browser';
import { MetroRenderer } from './renderer';
import { creativeStationPicker } from './station-picker';
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
  segments,
  stationCapacity,
  trackPoints,
  tunnelsUsed,
} from './rules';
import { dispatcherPolicy } from './agent';
import type { Action, City, Mode, Options, Replay, Shape, State } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header class="topbar">
  <span class="brand" aria-hidden="true"></span>
  <div class="city-heading"><strong id="city-name">河湾新城</strong><span id="mode-label">经典模式</span></div>
  <div class="score-block"><span class="score-icon">♧</span><div><strong id="score">0</strong><span>已送达乘客</span></div></div>
  <div class="header-actions"><button id="new-game" class="text-button">新局</button><button id="tools-toggle" class="text-button" aria-expanded="false" aria-controls="inspector">调度</button><button id="replay-toggle" class="text-button" aria-expanded="false" aria-controls="inspector">回放</button><button id="help" class="icon-button" title="游玩说明">?</button></div>
</header>
<main class="workspace">
  <aside class="left-panel">
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
    <div id="stage"><div id="station-layer"></div></div>
    <div class="map-tools"><button id="zoom-out" title="缩小">−</button><button id="zoom-reset" title="恢复视野">⌂</button><button id="zoom-in" title="放大">＋</button><button id="screenshot" title="保存地图截图">▧</button></div>
    <div id="map-hint" class="map-hint"><span>拖过车站，连起第一条线路。</span><button id="sample-route">示范 ↗</button></div>
    <div id="toast" role="status"></div>
    <div id="upgrade-panel" class="floating-overlay" hidden></div>
    <div id="game-over" class="floating-overlay" hidden></div>
  </section>
  <aside id="inspector" class="right-panel" hidden aria-label="调度与回放">
    <div class="tabs"><button id="tab-dispatch" class="active">调度</button><button id="tab-replay">回放</button><button id="inspector-close" class="text-button" aria-label="收起面板">×</button></div>
    <section id="dispatch-pane">
      <div id="station-detail" class="station-detail" hidden></div>
      <div class="agent-controls"><div class="section-heading"><span>自动调度</span><span class="agent-tag">AGENT</span></div><p>内置启发式策略。操作与公开决策说明自动记入回放。</p><button id="agent-toggle" class="primary full">启动自动调度 ↗</button><details><summary>连接 HTTP Agent</summary><input id="agent-url" value="http://127.0.0.1:8789/decide" aria-label="Agent 地址"/><button id="connect-agent" class="soft-button full">连接并运行</button><small>发送完整状态，包含车站、线路、列车、资源及随机数和内部计时。等待回复时冻结游戏时钟。</small></details><button id="agent-observation" class="text-button">查看 Agent 收到的数据 ↗</button></div>
      <div id="last-decision" class="last-decision"></div>
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
<dialog id="settings-dialog"><form id="settings-form"><span class="eyebrow">LET'S BUILD A LITTLE CITY</span><h2>开始一段新旅程</h2><label>目的地<select id="city-select"><option value="orchard">河湾新城 · 蜿蜒的单河城市</option><option value="harbor">东岸港湾 · 城市东侧的河湾</option><option value="islands">双子群岛 · 两条河流，三片陆地</option></select></label><label>模式<select id="mode-select"><option value="normal">经典 · 拥挤过久将结束旅程</option><option value="endless">无尽 · 保留需求，没有拥挤失败</option><option value="extreme">极限 · 线路只能从端点延长</option><option value="creative">创意 · 充足资源，可手动建站</option></select></label><label>地图种子<input id="seed-input" type="number" min="0" max="4294967295" value="420"/></label><div class="button-pair"><button type="button" id="settings-cancel">再逛一会儿</button><button class="primary" type="submit">出发 ↗</button></div></form></dialog>
<dialog id="help-dialog"><span class="eyebrow">A POCKET GUIDE</span><h2>地铁乘车指南</h2><ol><li>乘客的形状就是目的地。把不同形状的车站连起来；列车会自动接送和换乘。</li><li>选左侧线路，再从车站拖到另一站。可以连续拖过多站；从端点继续延长，拖回起点闭合环线。</li><li>点“重画线路”重新规划。右键车站可将它移出所选线路；也可在右侧移除。旧路段的列车会先到站再清客。</li><li>每台列车 6 个座位，每节车厢增加 6 个。调度栏可增派、加挂、回收列车或调往别的线路。</li><li>每段跨河连接消耗隧道。车站超过 6 人开始计时，持续 45 秒将结束旅程；减少到 6 人以下，计时会逐渐恢复。枢纽容量为 18 人。</li><li>空格暂停，1–7 选线。每周免费获得一台机车，再选一项补给。可随时暂停规划。</li><li>“旅程回放”支持导入、导出、拖动时间和重建决策前的局面。Agent 决策说明是控制器提供的公开摘要。</li></ol><p class="muted">Mini Metro 核心玩法的独立重建；3 张原创地图、原创程序化画面与音效。原版城市数据及精确节奏未对齐，验证边界见随附 FIDELITY.md。</p><button id="help-close" class="primary full">开始规划</button></dialog>
<dialog id="decision-dialog"><span class="eyebrow">AT THE MOMENT OF DECISION</span><h2>决策现场</h2><div id="decision-content"></div><button id="decision-close" class="primary full">返回旅程</button></dialog>
<dialog id="observation-dialog"><h2>Agent 当前观察</h2><p>这是实际接口的完整 JSON。包含内部状态，并非只看屏幕。HTTP 回复 action，游戏校验并执行。</p><pre id="observation-json"></pre><button id="observation-close" class="primary full">关闭</button></dialog>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage'),
  layer = $('station-layer'),
  controller = new MetroController(),
  renderer = new MetroRenderer(stage),
  audio = new MetroAudio();
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
  nodes.forEach((n) => n.remove());
  nodes.clear();
  stationKey = lineKey = trainKey = detailKey = decisionKey = phaseKey = '';
  selectedStation = null;
  draft = null;
  decisionPage = 0;
  renderer.clearPreview();
  renderer.resetCamera();
  setLineTools(false);
  setInspector(false);
  const creative = controller.getState().mode === 'creative';
  $('station-detail').innerHTML = creative
    ? `<span class="eyebrow">CREATIVE CITY</span><p>选择站型，再点击空白地面建站。</p>${creativeStationPicker()}`
    : '<span class="eyebrow">STATION NOTES</span><p>点一下车站，查看等候乘客<br>和它连接的线路。</p>';
  detailKey = creative ? 'creative' : '';
}
function setInspector(open: boolean): void {
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
function setLine(id: number): void {
  controller.selectedLine = id;
  redrawing = false;
  draft = null;
  renderer.clearPreview();
  uiAt = 0;
}
function nearest(clientX: number, clientY: number): number | null {
  const rect = stage.getBoundingClientRect();
  let best = 30,
    result: number | null = null;
  for (const p of lastState.stations) {
    const q = renderer.project(p.x, p.y, 0.5),
      d = Math.hypot(q.x - (clientX - rect.left), q.y - (clientY - rect.top));
    if (d < best) {
      best = d;
      result = p.id;
    }
  }
  return result;
}
function currentLine() {
  return controller.getState().lines[controller.selectedLine];
}
function preview(): void {
  if (!draft) return;
  const s = controller.getState();
  const valid =
    draft.length < 2 ||
    applyAction(copy(s), {
      type: 'route',
      line: controller.selectedLine,
      stops: draft,
      loop: draftLoop,
    }).ok;
  renderer.showPreview(s, draftLoop ? [...draft, draft[0]] : draft, controller.selectedLine, valid);
}
let panning: { x: number; y: number } | null = null;
let pointerStation: number | null = null;
let insertAt: number | null = null,
  originalStops: number[] = [];
function nearbySegment(x: number, y: number): number | null {
  const s = controller.getState(),
    l = s.lines[controller.selectedLine],
    rect = stage.getBoundingClientRect();
  let best = 12,
    result: number | null = null;
  for (const [index, [a, b]] of segments(l).entries()) {
    const points = trackPoints(
      s.stations.find((p) => p.id === a)!,
      s.stations.find((p) => p.id === b)!,
    ).map((p) => renderer.project(p.x, p.y, 0.43));
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1],
        q = points[i],
        dx = q.x - p.x,
        dy = q.y - p.y,
        t = Math.max(
          0,
          Math.min(
            1,
            ((x - rect.left - p.x) * dx + (y - rect.top - p.y) * dy) / (dx * dx + dy * dy),
          ),
        );
      const d = Math.hypot(x - rect.left - p.x - dx * t, y - rect.top - p.y - dy * t);
      if (d < best) {
        best = d;
        result = index + 1;
      }
    }
  }
  return result;
}
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || controller.mode === 'replay') return;
  const label = (e.target as Element).closest<HTMLElement>('[data-station]');
  const id = label ? Number(label.dataset.station) : nearest(e.clientX, e.clientY);
  pointerStation = id;
  if (id === null) {
    insertAt = nearbySegment(e.clientX, e.clientY);
    if (insertAt !== null && !redrawing) {
      controller.takeControl();
      originalStops = [...currentLine().stops];
      draft = [...originalStops];
      draftLoop = currentLine().loop;
      dragStart = { x: e.clientX, y: e.clientY };
      moved = false;
    } else panning = { x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
    return;
  }
  insertAt = null;
  controller.takeControl();
  selectedStation = id;
  dragStart = { x: e.clientX, y: e.clientY };
  moved = false;
  draftLoop = false;
  const line = currentLine();
  if (!redrawing && !line.loop && line.stops.length && line.stops.at(-1) === id)
    draft = [...line.stops];
  else if (!redrawing && !line.loop && line.stops[0] === id) draft = [...line.stops].reverse();
  else if (!redrawing && line.stops.length) {
    draft = null;
    toast('从线路端点延长；要改走向，请先点“重画线路”。');
  } else draft = [id];
  stage.setPointerCapture(e.pointerId);
  uiAt = 0;
});
stage.addEventListener('pointermove', (e) => {
  if (pointerStation !== null && Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 8)
    moved = true;
  if (panning) {
    renderer.pan(e.clientX - panning.x, e.clientY - panning.y);
    panning = { x: e.clientX, y: e.clientY };
    return;
  }
  if (!draft) return;
  if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 8) moved = true;
  const id = nearest(e.clientX, e.clientY);
  if (id === null || id === draft.at(-1)) return;
  if (insertAt !== null) {
    if (!originalStops.includes(id)) {
      draft = [...originalStops];
      draft.splice(insertAt, 0, id);
      preview();
    }
    return;
  }
  if (id === draft[0] && draft.length >= 3) {
    draftLoop = true;
    preview();
    return;
  }
  if (draft.length > 1 && id === draft.at(-2)) {
    draft.pop();
    draftLoop = false;
    preview();
    return;
  }
  if (draft.includes(id)) return;
  draft.push(id);
  draftLoop = false;
  preview();
});
function finishDraw(): void {
  if (pointerStation !== null && !moved) setTab(false);
  if (draft && moved && draft.length >= 2) {
    const first = !controller.getState().lines.some((l) => l.stops.length);
    if (
      act(
        { type: 'route', line: controller.selectedLine, stops: draft, loop: draftLoop },
        insertAt === null ? '拖拽车站绘制线路。' : '拖动轨道接入新车站。',
      )
    ) {
      redrawing = false;
      if (first) controller.setPaused(false);
    }
  }
  draft = null;
  insertAt = null;
  pointerStation = null;
  renderer.clearPreview();
}
stage.addEventListener('pointerup', () => {
  panning = null;
  finishDraw();
});
stage.addEventListener('pointercancel', () => {
  panning = null;
  draft = null;
  pointerStation = null;
  renderer.clearPreview();
});
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    renderer.setZoom(renderer.getZoom() + (e.deltaY < 0 ? 0.1 : -0.1));
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

function update(): void {
  const s = controller.getState();
  controller.selectedLine = Math.min(controller.selectedLine, s.lines.length - 1);
  lastState = s;
  renderer.render(s, controller.selectedLine);
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
  for (const p of s.stations) {
    const q = renderer.project(p.x, p.y, 0.6),
      n = nodes.get(p.id)!;
    n.style.left = `${q.x}px`;
    n.style.top = `${q.y}px`;
    n.classList.toggle('selected', p.id === selectedStation);
    n.classList.toggle('crowded', p.queue.length > stationCapacity(p));
    n.style.setProperty('--crowd', `${(p.crowd / RULES.crowdTicks) * 100}%`);
    n.setAttribute('aria-label', `${p.id} 号 ${p.shape} 车站，${p.queue.length} 人候车`);
    const content = `<span class="station-tag">${GLYPHS[p.shape]} <small>${p.id}</small>${p.interchange ? ' ✦' : ''}</span>${
      p.queue.length
        ? `<span class="passengers">${p.queue
            .slice(0, 8)
            .map((v) => `<i class="shape-${v.shape}">${GLYPHS[v.shape]}</i>`)
            .join('')}${p.queue.length > 8 ? `<b>+${p.queue.length - 8}</b>` : ''}</span>`
        : ''
    }${p.crowd > 0 ? `<span class="crowd-bar"><i></i></span>` : ''}`;
    if (n.innerHTML !== content) n.innerHTML = content;
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
  $('agent-toggle').textContent =
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
      ts.map((t) => [t.id, t.carriages, t.passengers.length, t.retiring, t.moveTo]),
    );
  if (tk !== trainKey) {
    trainKey = tk;
    $('train-list').innerHTML = ts
      .map(
        (t) =>
          `<div class="train-row"><span><b>▰ ${t.id}</b> <small>${t.passengers.length}/${6 * (1 + t.carriages)}${t.retiring ? ' 回库' : t.moveTo ? ' 调动' : ''}</small></span><div><button data-car="${t.id}" title="加挂车厢">＋</button><button data-uncar="${t.id}" title="拆卸车厢">−</button><button data-move="${t.id}" title="调往下一条已运营线路">⇄</button><button data-retire="${t.id}" title="回收列车">↩</button></div></div>`,
      )
      .join('');
  }
  $('resources').innerHTML =
    `<div><span>▰ 机车</span><b>${s.resources.locomotives}</b></div><div><span>▱ 车厢</span><b>${s.resources.carriages}</b></div><div><span>⌒ 隧道</span><b>${s.resources.tunnels - tunnelsUsed(s)}<small> / ${s.resources.tunnels}</small></b></div><div><span>✦ 枢纽</span><b>${s.resources.interchanges}</b></div>`;
  const first = !s.lines.some((l) => l.stops.length);
  $('map-hint').hidden = !first || controller.mode === 'replay';
  const p = s.stations.find((p) => p.id === selectedStation),
    dk = JSON.stringify(p);
  $('station-detail').hidden = !p && s.mode !== 'creative';
  if (p && dk !== detailKey) {
    detailKey = dk;
    const destinations = SHAPES.map((shape) => ({
      shape,
      n: p.queue.filter((v) => v.shape === shape).length,
    })).filter((x) => x.n);
    $('station-detail').innerHTML =
      `<span class="eyebrow">STATION ${p.id.toString().padStart(2, '0')}</span><h3>${GLYPHS[p.shape]} ${p.interchange ? '换乘枢纽' : '小镇车站'}</h3><div class="station-stats"><b>${p.queue.length}<small> / ${stationCapacity(p)} 人候车</small></b><span>${p.crowd ? `拥挤 ${Math.ceil(p.crowd / 20)} 秒` : '秩序良好'}</span></div><p>${destinations.map((v) => `${GLYPHS[v.shape]} × ${v.n}`).join('　') || '还没有等候乘客'}</p><div class="button-pair"><button id="upgrade-station">扩建枢纽</button><button id="remove-station">移出所选线</button></div>${s.mode === 'creative' ? '<button id="create-station" class="soft-button full">＋ 在空白处建站</button>' : ''}`;
  }
  if (s.mode === 'creative' && !p && detailKey !== 'creative') {
    detailKey = 'creative';
    $('station-detail').innerHTML =
      `<span class="eyebrow">CREATIVE CITY</span><p>选择站型，再点击空白地面建站。</p>${creativeStationPicker()}`;
  }
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
    $('last-decision').innerHTML = last
      ? `<span class="eyebrow">最近一次决策 · ${clock(last.tick)}</span><p>${escape(last.reason || last.action.type)}</p>${!last.result.ok ? `<small class="error">${escape(last.result.message)}</small>` : ''}<button class="text-button" data-decision="${last.id}">查看决策现场 ↗</button>`
      : '';
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
  const pk = `${s.phase}:${s.week}:${s.lostStation}:${controller.mode}`;
  if (pk !== phaseKey) {
    phaseKey = pk;
    $('upgrade-panel').hidden = s.phase !== 'upgrade' || controller.mode !== 'human';
    $('game-over').hidden = s.phase !== 'over';
    if (s.phase === 'upgrade')
      $('upgrade-panel').innerHTML =
        `<div class="supply-stamp">✦</div><span class="eyebrow">A NEW WEEK, A LITTLE GIFT</span><h2>第 ${s.week} 周，继续出发。</h2><p>一台新机车已入库。再为小镇挑一份补给：</p><div class="upgrade-options">${s.upgrades.map((choice) => `<button data-upgrade="${choice}"><b>${choice === 'line' ? '⌁' : choice === 'carriage' ? '▰ ▱' : choice === 'tunnels' ? '⌒ ⌒' : '✦'}</b><strong>${UPGRADE_NAMES[choice]}</strong></button>`).join('')}</div>`;
    if (s.phase === 'over')
      $('game-over').innerHTML =
        `<div class="supply-stamp">♧</div><span class="eyebrow">THANK YOU FOR THE JOURNEY</span><h2>小镇需要休息一会儿。</h2><p>${s.lostStation} 站拥挤过久。这段旅程共送达</p><strong class="final-score">${s.score}<small> 位乘客</small></strong><div class="button-pair"><button id="over-replay">回看这段旅程</button><button id="over-restart" class="primary">相同种子重试 ↗</button><button id="over-new-seed">新种子开局</button></div>`;
  }
}
controller.onChange = update;
controller.capture = () => renderer.capture();
update();
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
$('agent-observation').onclick = () => {
  controller.setPaused(true);
  $('observation-json').textContent = JSON.stringify(observeState(controller.getState()), null, 2);
  $<HTMLDialogElement>('observation-dialog').showModal();
};
$('observation-close').onclick = () => $<HTMLDialogElement>('observation-dialog').close();

$('line-list').addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('[data-line]');
  if (b) setLine(Number(b.dataset.line));
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
$('sample-route').onclick = () => {
  const r = controller.submit(dispatcherPolicy(controller.observe()), 'demo');
  if (r.ok) controller.setPaused(false);
  toast(r.message);
};
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
$('tab-dispatch').onclick = () => setTab(false);
$('tab-replay').onclick = () => setTab(true);
$('sound').onclick = async () => {
  $('sound').classList.toggle('sound-on', !(await audio.toggle()));
};
$('zoom-in').onclick = () => renderer.setZoom(renderer.getZoom() + 0.15);
$('zoom-out').onclick = () => renderer.setZoom(renderer.getZoom() - 0.15);
$('zoom-reset').onclick = () => renderer.resetCamera();
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
          `<button class="history-row" data-history="${i}"><span>↺ ${escape(item.name)}</span><small>${escape(item.replay.createdAt.slice(0, 16).replace('T', ' '))}</small></button>`,
      )
      .join('') || '<p class="muted">暂时没有保存的旅程。</p>';
}
function replayCurrent(): void {
  try {
    const r = controller.exportReplay();
    saveLocal(true);
    controller.loadReplay(r);
    resetView();
    setTab(true);
    toast('录像已校验。按播放键或拖动时间查看。');
  } catch (e) {
    toast(String(e));
  }
}
$('replay-current').onclick = replayCurrent;
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
  controller.setPaused(true);
  controller.seek(Number((e.target as HTMLInputElement).value));
};
function seekBy(ticks: number): void {
  try {
    controller.setPaused(true);
    controller.seek(controller.getState().tick + ticks);
  } catch (e) {
    toast(String(e));
  }
}
$('step-back').onclick = () => seekBy(-100);
$('step-forward').onclick = () => seekBy(100);
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
stage.addEventListener('click', (e) => {
  if (!placing) return;
  const rect = stage.getBoundingClientRect(),
    p = renderer.unproject(e.clientX - rect.left, e.clientY - rect.top);
  if (p) {
    act({ type: 'station', ...p, shape: placing }, '在创意地图中建造新车站。');
    placing = null;
  }
});
window.addEventListener('keydown', (e) => {
  if (
    (e.target as HTMLElement).matches('input,select,textarea') ||
    document.querySelector('dialog[open]')
  )
    return;
  if (e.code === 'Space') {
    e.preventDefault();
    controller.setPaused(!controller.paused);
  }
  if (/^[1-7]$/.test(e.key) && Number(e.key) <= controller.getState().lines.length)
    setLine(Number(e.key) - 1);
  if (e.key === 'Escape') {
    draft = null;
    redrawing = false;
    placing = null;
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
  capture: () => renderer.capture(),
  projectStation: (id: number) => {
    const p = controller.getState().stations.find((p) => p.id === id);
    if (!p) throw new Error('车站不存在');
    const point = renderer.project(p.x, p.y, 0.6),
      rect = stage.getBoundingClientRect();
    return { x: point.x + rect.left, y: point.y + rect.top };
  },
  hash: () => hash(controller.getState()),
};
(window as unknown as { metro: typeof api }).metro = api;
