// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  Action,
  ActionResult,
  City,
  Line,
  Options,
  Passenger,
  ServiceObserver,
  Shape,
  State,
  Station,
  Train,
  Upgrade,
} from './types';

export const RULES = Object.freeze({
  hz: 50,
  dayTicks: 600,
  weekTicks: 4200,
  capacity: 6,
  crowdLimit: 6,
  crowdTicks: 2250,
  speed: 2.9,
  maxStations: 48,
  maxLines: 7,
  maxTrains: 32,
  maxCarriages: 3,
});
export const SHAPES: Shape[] = ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'pentagon', 'egg', 'gem', 'wedge'];
export const GLYPHS: Record<Shape, string> = {
  circle: '●',
  triangle: '▲',
  square: '■',
  diamond: '◆',
  star: '★',
  cross: '✚',
  pentagon: '⬟',
  egg: '⬭',
  gem: '⬡',
  wedge: '◢',
};
export const LINE_COLORS = [
  '#e98391',
  '#dcb654',
  '#57b6bb',
  '#a38bcd',
  '#7eb48f',
  '#ce87b5',
  '#799fc9',
];
export const CITY_NAMES: Record<City, string> = {
  orchard: '河湾新城',
  harbor: '东岸港湾',
  islands: '双子群岛',
};
export const UPGRADE_NAMES: Record<Upgrade, string> = {
  line: '新线路',
  carriage: '车厢 ×2',
  tunnels: '隧道 ×2',
  interchange: '换乘枢纽',
};
export function copy<T>(v: T): T {
  return structuredClone(v);
}
export function hash(v: unknown): string {
  const text = JSON.stringify(v);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}
export function random(s: State): number {
  let x = s.rng;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s.rng = x >>> 0;
  return s.rng / 4294967296;
}
export function riverX(city: City, y: number, river = 0): number {
  const wave = Math.sin(y * 0.27) * 1.35;
  return city === 'islands'
    ? (river ? 6 : -5) + wave * 0.6
    : city === 'harbor'
      ? 5 + wave - y * 0.27
      : wave + y * 0.16;
}
export function riverCount(city: City): number {
  return city === 'islands' ? 2 : 1;
}
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
/** A subway-map segment: axis-aligned plus a 45 degree diagonal. */
export function trackPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number }[] {
  if (a.x > b.x || (a.x === b.x && a.y > b.y)) return trackPoints(b, a).reverse();
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const bend =
    Math.abs(dx) > Math.abs(dy)
      ? { x: b.x - Math.sign(dx) * Math.abs(dy), y: a.y }
      : { x: a.x, y: b.y - Math.sign(dy) * Math.abs(dx) };
  return distance(a, bend) < 0.001 || distance(b, bend) < 0.001 ? [a, b] : [a, bend, b];
}
export function trackLength(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const p = trackPoints(a, b);
  return p.slice(1).reduce((n, v, i) => n + distance(p[i], v), 0);
}
export function trackPosition(
  a: { x: number; y: number },
  b: { x: number; y: number },
  progress: number,
): { x: number; y: number; angle: number } {
  const p = trackPoints(a, b);
  let remaining = trackLength(a, b) * progress;
  for (let i = 1; i < p.length; i++) {
    const d = distance(p[i - 1], p[i]);
    if (remaining <= d || i === p.length - 1) {
      const t = d ? Math.min(1, remaining / d) : 0;
      return {
        x: p[i - 1].x + (p[i].x - p[i - 1].x) * t,
        y: p[i - 1].y + (p[i].y - p[i - 1].y) * t,
        angle: Math.atan2(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y),
      };
    }
    remaining -= d;
  }
  return { ...a, angle: 0 };
}
export function station(s: State, id: number): Station {
  const result = s.stations.find((p) => p.id === id);
  if (!result) throw new Error(`车站 ${id} 不存在`);
  return result;
}
export function segments(line: Line): [number, number][] {
  const result: [number, number][] = [];
  for (let i = 1; i < line.stops.length; i++) result.push([line.stops[i - 1], line.stops[i]]);
  if (line.loop && line.stops.length >= 3) result.push([line.stops.at(-1)!, line.stops[0]]);
  return result;
}
export function crossings(s: State, a: number, b: number): number {
  const points = trackPoints(station(s, a), station(s, b));
  let n = 0;
  for (let r = 0; r < riverCount(s.city); r++) {
    let prev = points[0].x > riverX(s.city, points[0].y, r);
    for (let segment = 1; segment < points.length; segment++) {
      const p = points[segment - 1],
        q = points[segment];
      for (let i = 1; i <= 32; i++) {
        const t = i / 32,
          side = p.x + (q.x - p.x) * t > riverX(s.city, p.y + (q.y - p.y) * t, r);
        if (side !== prev) n++;
        prev = side;
      }
    }
  }
  return n;
}
export function tunnelsUsed(s: State): number {
  const seen = new Set<string>();
  let total = 0;
  const add = (line: number, a: number, b: number) => {
    const key = `${line}:${Math.min(a, b)}:${Math.max(a, b)}`;
    if (!seen.has(key)) {
      seen.add(key);
      total += crossings(s, a, b);
    }
  };
  for (const line of s.lines) for (const [a, b] of segments(line)) add(line.id, a, b);
  // Deleted track stays reserved until its final train reaches a station.
  for (const t of s.trains) if (t.to !== null) add(t.line, t.from, t.to);
  return total;
}
export function stationCapacity(p: Station): number {
  return p.interchange ? 18 : RULES.crowdLimit;
}
function addStation(s: State, x: number, y: number, shape: Shape): Station {
  const p: Station = {
    id: s.nextId++,
    x,
    y,
    shape,
    queue: [],
    crowd: 0,
    interchange: false,
    born: s.elapsed,
    nextPassenger: s.elapsed + 200 + Math.floor(random(s) * 250),
  };
  s.stations.push(p);
  return p;
}
export function createState(options: Options = {}): State {
  const seed = options.seed ?? 420,
    city = options.city ?? 'orchard',
    mode = options.mode ?? 'normal';
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !['orchard', 'harbor', 'islands'].includes(city) ||
    !['normal', 'endless', 'extreme', 'creative'].includes(mode)
  )
    throw new Error('非法开局参数');
  const s: State = {
    version: 'orchard-metro.rules.4',
    seed,
    rng: seed || 1,
    tick: 0,
    city,
    mode,
    phase: 'playing',
    elapsed: 0,
    week: 1,
    score: 0,
    totalSpawned: 0,
    totalWait: 0,
    nextId: 1,
    nextStation: 1050,
    stations: [],
    lines: [],
    trains: [],
    resources: {
      locomotives: mode === 'creative' ? 24 : 3,
      carriages: mode === 'creative' ? 30 : 0,
      tunnels: mode === 'creative' ? 99 : city === 'islands' ? 3 : 2,
      interchanges: mode === 'creative' ? 12 : 0,
    },
    upgrades: [],
    lostStation: null,
  };
  for (let i = 0; i < (mode === 'creative' ? 7 : 3); i++)
    s.lines.push({ id: i, stops: [], loop: false });
  addStation(s, -7, 1, 'circle');
  addStation(s, -3, -3, 'triangle');
  addStation(s, 3, 2, 'square');
  return s;
}
export function normalizeAction(value: Action): Action {
  if (!value || typeof value !== 'object') throw new Error('action 必须是对象');
  const id = (v: number) => {
    if (!Number.isInteger(v) || v < 0 || v > 1e8) throw new Error('非法编号');
    return v;
  };
  switch (value.type) {
    case 'wait':
      return { type: 'wait' };
    case 'route':
      if (
        !Array.isArray(value.stops) ||
        value.stops.length > RULES.maxStations ||
        (value.loop !== undefined && typeof value.loop !== 'boolean')
      )
        throw new Error('非法线路');
      return {
        type: 'route',
        line: id(value.line),
        stops: value.stops.map(id),
        loop: value.loop ?? false,
      };
    case 'addTrain':
      if (value.direction !== undefined && value.direction !== 1 && value.direction !== -1)
        throw new Error('非法行车方向');
      return {
        type: 'addTrain',
        line: id(value.line),
        ...(value.station !== undefined ? { station: id(value.station) } : {}),
        ...(value.direction ? { direction: value.direction } : {}),
      };
    case 'removeTrain':
      return { type: 'removeTrain', train: id(value.train) };
    case 'moveTrain':
      return {
        type: 'moveTrain',
        train: id(value.train),
        line: id(value.line),
        station: id(value.station),
      };
    case 'carriage':
      if (value.delta !== 1 && value.delta !== -1) throw new Error('delta 必须为 ±1');
      return { type: 'carriage', train: id(value.train), delta: value.delta };
    case 'interchange':
      return { type: 'interchange', station: id(value.station) };
    case 'upgrade':
      if (!['line', 'carriage', 'tunnels', 'interchange'].includes(value.choice))
        throw new Error('非法补给');
      return { type: 'upgrade', choice: value.choice };
    case 'station':
      if (
        !Number.isFinite(value.x) ||
        !Number.isFinite(value.y) ||
        Math.abs(value.x) > 16 ||
        Math.abs(value.y) > 10 ||
        !SHAPES.includes(value.shape)
      )
        throw new Error('非法车站');
      return { type: 'station', x: value.x, y: value.y, shape: value.shape };
    default:
      throw new Error('未知 action.type');
  }
}
function newTrain(s: State, line: Line, at = line.stops[0], direction: 1 | -1 = 1): Train {
  const t: Train = {
    id: s.nextId++,
    line: line.id,
    from: at,
    to: null,
    progress: 0,
    direction,
    dwell: 3,
    serviceTicks: 0,
    transfer: null,
    passengers: [],
    carriages: 0,
    retiring: false,
    moveTo: null,
  };
  s.trains.push(t);
  s.resources.locomotives--;
  return t;
}
function nextStop(
  line: Line,
  from: number,
  direction: 1 | -1,
): { id: number; direction: 1 | -1 } | null {
  const i = line.stops.indexOf(from),
    n = line.stops.length;
  if (i < 0 || n < 2) return null;
  if (!line.loop && (i + direction < 0 || i + direction >= n)) direction = direction === 1 ? -1 : 1;
  return { id: line.stops[(i + direction + n) % n], direction };
}
function unload(s: State, t: Train, emit?: (type: 'deliver' | 'transferOut', t: Train, passenger: Passenger) => void): void {
  const p = station(s, t.from);
  if (t.transfer) {
    // A train being withdrawn cannot take an in-flight rider out of the world.
    // Complete boarding into this train before unloading everyone at the stop.
    if (t.transfer.direction === 'board') t.passengers.push(t.transfer.passenger);
    else {
      const passenger = t.transfer.passenger;
      if (passenger.shape === p.shape) {
        s.score++;
        s.totalWait += s.elapsed - passenger.born;
        emit?.('deliver', t, passenger);
      } else {
        passenger.transfers++;
        p.queue.push(passenger);
        emit?.('transferOut', t, passenger);
      }
    }
    t.transfer = null;
  }
  for (const passenger of t.passengers) {
    if (passenger.shape === p.shape) {
      s.score++;
      s.totalWait += s.elapsed - passenger.born;
      emit?.('deliver', t, passenger);
    } else {
      passenger.transfers++;
      p.queue.push(passenger);
      emit?.('transferOut', t, passenger);
    }
  }
  t.passengers = [];
}
export function applyAction(s: State, raw: Action): ActionResult {
  const a = normalizeAction(raw),
    ok = (message: string): ActionResult => ({ ok: true, message }),
    no = (message: string): ActionResult => ({ ok: false, message });
  if (s.phase === 'over') return no('本局已结束');
  if (a.type === 'wait') return ok('等待');
  if (s.phase === 'upgrade' && a.type !== 'upgrade') return no('请先选择本周补给');
  if (a.type === 'upgrade') {
    if (s.phase !== 'upgrade' || !s.upgrades.includes(a.choice)) return no('该补给当前不可选');
    if (a.choice === 'line') s.lines.push({ id: s.lines.length, stops: [], loop: false });
    if (a.choice === 'carriage') s.resources.carriages += 2;
    if (a.choice === 'tunnels') s.resources.tunnels += 2;
    if (a.choice === 'interchange') s.resources.interchanges++;
    s.upgrades = [];
    s.phase = 'playing';
    return ok(`获得${UPGRADE_NAMES[a.choice]}`);
  }
  if (a.type === 'route') {
    const line = s.lines.find((l) => l.id === a.line);
    if (!line) return no('线路尚未解锁');
    if (
      a.stops.length === 1 ||
      new Set(a.stops).size !== a.stops.length ||
      a.stops.some((id) => !s.stations.some((p) => p.id === id)) ||
      (a.loop && a.stops.length < 3)
    )
      return no('线路需经过至少两座不同车站；环线至少三站');
    if (s.mode === 'extreme' && line.stops.length) {
      const start = a.stops.indexOf(line.stops[0]);
      if (line.loop || start < 0 || line.stops.some((id, i) => a.stops[start + i] !== id))
        return no('极限模式只能从端点延长线路');
    }
    const candidate = copy(s);
    Object.assign(candidate.lines[a.line], { stops: a.stops, loop: a.loop ?? false });
    if (tunnelsUsed(candidate) > s.resources.tunnels)
      return no('隧道不足；旧跨河轨道上的列车到站后才释放隧道');
    line.stops = [...a.stops];
    line.loop = a.loop ?? false;
    if (!line.stops.length)
      for (const t of s.trains.filter((t) => t.line === line.id)) t.retiring = true;
    if (
      line.stops.length &&
      !s.trains.some((t) => t.line === line.id && !t.retiring) &&
      s.resources.locomotives > 0 &&
      s.trains.length < RULES.maxTrains
    )
      newTrain(s, line);
    return ok(line.stops.length ? '线路已更新' : '线路已撤销，列车到站后回收');
  }
  if (a.type === 'addTrain') {
    const line = s.lines.find((l) => l.id === a.line);
    if (
      !line ||
      line.stops.length < 2 ||
      (a.station !== undefined && !line.stops.includes(a.station))
    )
      return no('请选择线路上的车站');
    if (s.resources.locomotives <= 0 || s.trains.length >= RULES.maxTrains)
      return no('没有空闲机车');
    newTrain(s, line, a.station ?? line.stops[0], a.direction ?? 1);
    return ok('列车已出库');
  }
  if (a.type === 'interchange') {
    const p = s.stations.find((p) => p.id === a.station);
    if (!p || p.interchange || s.resources.interchanges <= 0)
      return no('没有可用枢纽，或该站已经升级');
    p.interchange = true;
    s.resources.interchanges--;
    return ok('枢纽扩建完成，候车容量提升至 18');
  }
  if (a.type === 'station') {
    if (s.mode !== 'creative') return no('仅创意模式可手动建站');
    if (
      s.stations.length >= RULES.maxStations ||
      s.stations.some((p) => distance(p, a) < 2) ||
      Array.from({ length: riverCount(s.city) }, (_, r) =>
        Math.abs(a.x - riverX(s.city, a.y, r)),
      ).some((d) => d < 1.5)
    )
      return no('车站需建在陆地，且间距至少 2');
    addStation(s, a.x, a.y, a.shape);
    return ok('车站已建成');
  }
  const t = s.trains.find((t) => t.id === a.train);
  if (!t || t.retiring || t.moveTo) return no('列车不存在或正在回收调度');
  if (a.type === 'removeTrain') {
    t.retiring = true;
    return ok('列车将在下一站清客并回库');
  }
  if (a.type === 'moveTrain') {
    const l = s.lines.find((l) => l.id === a.line);
    if (!l || !l.stops.includes(a.station) || l.stops.length < 2) return no('目标线路或车站不可用');
    t.moveTo = { line: a.line, station: a.station };
    return ok('列车将在下一站清客后调往目标站');
  }
  if (a.type === 'carriage') {
    if (a.delta === 1) {
      if (!s.resources.carriages || t.carriages >= RULES.maxCarriages)
        return no('车厢不足，或已达到三节上限');
      t.carriages++;
      s.resources.carriages--;
      return ok('加挂车厢，增加 6 个座位');
    }
    if (t.carriages <= 0 || t.passengers.length + Number(t.transfer?.direction === 'board') > t.carriages * RULES.capacity)
      return no('无车厢，或乘客过多，暂时无法拆卸');
    t.carriages--;
    s.resources.carriages++;
    return ok('车厢已回收');
  }
  return no('无效操作');
}

interface Edge {
  to: number;
  line: number;
  cost: number;
}
export interface Route {
  cost: number;
  line: number;
  next: number;
}
function graph(s: State, loopDirection?: { line: number; direction: 1 | -1 }): Map<number, Edge[]> {
  const g = new Map<number, Edge[]>(s.stations.map((p) => [p.id, []]));
  for (const l of s.lines) {
    // A loop has travel direction; a geometric shortcut against it is not serviceable.
    const directions = loopDirection?.line === l.id
      ? new Set([loopDirection.direction])
      : new Set(s.trains.filter((t) => t.line === l.id && !t.retiring && !t.moveTo)
        .map((t) => t.direction));
    if (!directions.size) continue;
    for (const [a, b] of segments(l)) {
      const cost = trackLength(station(s, a), station(s, b)) / RULES.speed + 0.7;
      if (!l.loop || directions.has(1)) g.get(a)!.push({ to: b, line: l.id, cost });
      if (!l.loop || directions.has(-1)) g.get(b)!.push({ to: a, line: l.id, cost });
    }
  }
  return g;
}
/** Dijkstra on (station, last line); transfer cost favors staying aboard. */
export function findRoute(
  s: State,
  from: number,
  destination: Shape,
  currentLine = -1,
  g = graph(s),
): Route | null {
  if (station(s, from).shape === destination) return { cost: 0, line: currentLine, next: from };
  const pending = [{ at: from, line: currentLine, cost: 0, firstLine: -1, next: -1 }],
    best = new Map<string, number>();
  while (pending.length) {
    pending.sort((a, b) => a.cost - b.cost || a.at - b.at || a.line - b.line);
    const n = pending.shift()!,
      key = `${n.at}:${n.line}`;
    if ((best.get(key) ?? Infinity) <= n.cost) continue;
    best.set(key, n.cost);
    if (station(s, n.at).shape === destination)
      return { cost: n.cost, line: n.firstLine, next: n.next };
    for (const e of g.get(n.at) ?? []) {
      const cost = n.cost + e.cost + (n.line === e.line ? 0 : 3);
      if (cost < (best.get(`${e.to}:${e.line}`) ?? Infinity))
        pending.push({
          at: e.to,
          line: e.line,
          cost,
          firstLine: n.firstLine < 0 ? e.line : n.firstLine,
          next: n.next < 0 ? e.to : n.next,
        });
    }
  }
  return null;
}
function service(s: State, t: Train, next: number, g: Map<number, Edge[]>): number {
  const p = station(s, t.from);
  // At a loop stop, boarding is evaluated for this train's direction, not
  // the shorter reverse trip offered by a different train on the same line.
  const localGraph = s.lines[t.line]?.loop ? graph(s, { line: t.line, direction: t.direction }) : g;
  const cache = new Map<string, Route | null>();
  const route = (shape: Shape, line: number) => {
    const key = `${shape}:${line}`;
    if (!cache.has(key)) cache.set(key, findRoute(s, p.id, shape, line, localGraph));
    return cache.get(key);
  };
  for (let i = 0; i < t.passengers.length; i++) {
    const passenger = t.passengers[i];
    if (passenger.shape === p.shape) {
      t.passengers.splice(i, 1);
      t.transfer = { passenger, direction: 'alight', stationId: p.id,
        duration: p.interchange ? 4 : 6, progress: 0 };
      return 1;
    }
    const r = route(passenger.shape, t.line);
    if (r && r.line === t.line && r.next === next) continue;
    t.passengers.splice(i, 1);
    t.transfer = { passenger, direction: 'alight', stationId: p.id,
      duration: p.interchange ? 4 : 6, progress: 0 };
    return 1;
  }
  if (t.passengers.length >= RULES.capacity * (1 + t.carriages)) return 0;
  for (let i = 0; i < p.queue.length; i++) {
    const passenger = p.queue[i];
    const r = route(passenger.shape, -1);
    if (!r || r.line !== t.line || r.next !== next) continue;
    p.queue.splice(i, 1);
    t.transfer = { passenger, direction: 'board', stationId: p.id,
      duration: p.interchange ? 4 : 6, progress: 0 };
    return 1;
  }
  return 0;
}
function spawnStation(s: State): void {
  if (s.stations.length >= RULES.maxStations) return;
  const range = Math.min(1, 0.48 + (s.elapsed / RULES.weekTicks) * 0.12);
  for (let attempt = 0; attempt < 160; attempt++) {
    const x = Math.round((random(s) * 2 - 1) * 15.5 * range * 10) / 10,
      y = Math.round((random(s) * 2 - 1) * 9.3 * range * 10) / 10;
    if (
      s.stations.some((p) => distance(p, { x, y }) < 2.65) ||
      Array.from({ length: riverCount(s.city) }, (_, r) => Math.abs(x - riverX(s.city, y, r))).some(
        (d) => d < 1.65,
      )
    )
      continue;
    const count = s.stations.length;
    const shape: Shape =
      count === 7
        ? 'diamond'
        : count === 13
          ? 'star'
          : count === 19
            ? 'cross'
            : random(s) < 0.52
              ? 'circle'
              : random(s) < 0.7
                ? 'triangle'
                : 'square';
    addStation(s, x, y, shape);
    return;
  }
}
export function advance(s: State, observer?: ServiceObserver): boolean {
  if (s.phase !== 'playing') return false;
  s.tick++;
  s.elapsed++;
  let sequence = 0;
  const emit = observer ? (type: 'arrive' | 'deliver' | 'transferOut' | 'board' | 'depart', t: Train, passenger?: Passenger) => {
    observer({ type, tick: s.tick, sequence: sequence++, stationId: t.from,
      trainId: t.id, lineId: t.line, passengerId: passenger?.id ?? null,
      shape: passenger?.shape ?? null });
  } : undefined;
  if (s.elapsed >= s.nextStation && s.mode !== 'creative') {
    spawnStation(s);
    s.nextStation = s.elapsed + 850 + Math.floor(random(s) * 500);
  }
  const available = [...new Set(s.stations.map((p) => p.shape))];
  for (const p of s.stations) {
    if (s.elapsed >= p.nextPassenger) {
      const shapes = available.filter((shape) => shape !== p.shape);
      if (shapes.length && p.queue.length < 160) {
        const shape = shapes[Math.floor(random(s) * shapes.length)];
        p.queue.push({ id: s.nextId++, shape, born: s.elapsed, transfers: 0 });
        s.totalSpawned++;
      }
      p.nextPassenger =
        s.elapsed + Math.max(100, Math.floor((275 + random(s) * 400) / (1 + (s.week - 1) * 0.12)));
    }
  }
  let g: Map<number, Edge[]> | null = null;
  const retired: number[] = [];
  for (const t of s.trains) {
    if (t.transfer) {
      const moving = t.transfer;
      moving.progress++;
      if (moving.progress <= moving.duration) continue;
      const target = station(s, moving.stationId);
      if (moving.direction === 'board') {
        t.passengers.push(moving.passenger);
        emit?.('board', t, moving.passenger);
      } else if (moving.passenger.shape === target.shape) {
        s.score++;
        s.totalWait += s.elapsed - moving.passenger.born;
        emit?.('deliver', t, moving.passenger);
      } else {
        moving.passenger.transfers++;
        target.queue.push(moving.passenger);
        emit?.('transferOut', t, moving.passenger);
      }
      t.transfer = null;
      t.dwell = 0;
      if (t.retiring) {
        unload(s, t, emit);
        s.resources.locomotives++;
        s.resources.carriages += t.carriages;
        retired.push(t.id);
      } else if (t.moveTo) {
        unload(s, t, emit);
        const target = t.moveTo;
        t.moveTo = null;
        const dest = s.lines.find((line) => line.id === target.line);
        if (dest?.stops.includes(target.station)) {
          t.line = target.line;
          t.from = target.station;
          t.direction = 1;
        } else t.retiring = true;
      }
      // Keep the next rider's transfer on a later tick.
      continue;
    }
    if (t.to !== null) {
      const d = Math.max(0.1, trackLength(station(s, t.from), station(s, t.to)));
      t.progress = Math.min(1, t.progress + RULES.speed / RULES.hz / d);
      if (t.progress < 1) continue;
      t.from = t.to;
      t.to = null;
      t.progress = 0;
      t.dwell = 0;
      t.serviceTicks = 0;
      emit?.('arrive', t);
    }
    if (t.retiring) {
      unload(s, t, emit);
      s.resources.locomotives++;
      s.resources.carriages += t.carriages;
      retired.push(t.id);
      continue;
    }
    if (t.moveTo) {
      unload(s, t, emit);
      const target = t.moveTo;
      t.moveTo = null;
      const dest = s.lines.find((l) => l.id === target.line);
      if (dest?.stops.includes(target.station)) {
        t.line = target.line;
        t.from = target.station;
        t.direction = 1;
      } else {
        t.retiring = true;
        continue;
      }
    }
    const l = s.lines[t.line];
    if (!l || l.stops.length < 2) {
      t.retiring = true;
      continue;
    }
    if (!l.stops.includes(t.from)) {
      // Finish old hop, unload at the removed station, then recover the empty train.
      unload(s, t, emit);
      s.resources.locomotives++;
      s.resources.carriages += t.carriages;
      retired.push(t.id);
      continue;
    }
    const next = nextStop(l, t.from, t.direction)!;
    t.direction = next.direction;
    if (t.dwell > 0) t.dwell--;
    if (t.dwell > 0) continue;
    if (t.serviceTicks === -1) {
      t.serviceTicks = 0;
      emit?.('depart', t);
      t.to = next.id;
      t.progress = 0;
      t.dwell = 0;
      continue;
    }
    g ??= graph(s);
    if (service(s, t, next.id, g)) {
      t.dwell = station(s, t.from).interchange ? 3 : 5;
    } else {
      t.serviceTicks = -1;
      t.dwell = 18;
    }
  }
  if (retired.length) s.trains = s.trains.filter((t) => !retired.includes(t.id));
  for (const p of s.stations) {
    if (p.queue.length > stationCapacity(p)) p.crowd = Math.min(RULES.crowdTicks, p.crowd + 1);
    else p.crowd = Math.max(0, p.crowd - 2);
    if (p.crowd >= RULES.crowdTicks && s.mode !== 'endless' && s.mode !== 'creative') {
      s.phase = 'over';
      s.lostStation = p.id;
    }
  }
  if (s.phase === 'playing' && s.elapsed % RULES.weekTicks === 0) {
    s.week++;
    s.resources.locomotives++;
    if (s.mode !== 'creative') {
      const choices: Upgrade[] = ['carriage', 'tunnels', 'interchange'];
      if (s.lines.length < RULES.maxLines) choices.push('line');
      const primary: Upgrade =
        s.lines.length < RULES.maxLines && s.week % 2 === 0 ? 'line' : 'carriage';
      const others = choices.filter((x) => x !== primary);
      s.upgrades = [primary, others[Math.floor(random(s) * others.length)]];
      s.phase = 'upgrade';
    }
  }
  return true;
}
