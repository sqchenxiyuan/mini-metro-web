// SPDX-License-Identifier: GPL-3.0-or-later
export type Shape = 'circle' | 'triangle' | 'square' | 'diamond' | 'star' | 'cross' | 'pentagon' | 'egg' | 'gem' | 'wedge';
export type City = 'orchard' | 'harbor' | 'islands';
export type Mode = 'normal' | 'endless' | 'extreme' | 'creative';
export type Upgrade = 'line' | 'carriage' | 'tunnels' | 'interchange';
/** Experimental map-v2 schema; project proposals, not original-game city data. */
export interface MapPoint { x: number; y: number }
export interface MapArea {
  id: string;
  polygon: MapPoint[];
  /** Relative area preference after a shape is selected; NOT a city-wide shape probability. */
  shapeWeights: Partial<{ [K in Shape]: number }>;
  activeDay: number;
  maximum: number;
}
export interface MapSchedule {
  id: string;
  types: Shape[];
  durationDays: number;
  cooldownDays: number;
  randomness: number;
}
export interface MapDefinition {
  id: City;
  rulesVersion: 'orchard-metro.rules.2';
  viewport: { minX: number; maxX: number; minY: number; maxY: number };
  obstacles: MapPoint[][];
  startStations: { x: number; y: number; shape: Shape }[];
  normalShapes: Shape[];
  areas: MapArea[];
  schedules: MapSchedule[];
  separation: number;
  waterMargin: number;
  maxAttempts: number;
  maxRetries: number;
}
export interface MapSpawnEvent {
  rulesVersion: MapDefinition['rulesVersion'];
  mapId: City;
  seed: number;
  tick: number;
  scheduleId: string;
  shape: Shape;
  areaId: string | null;
  position: MapPoint | null;
  attempts: number;
  result: 'spawned' | 'retry' | 'blocked';
  reason?: 'no-area' | 'no-point' | 'maximum' | 'station-limit';
}
export interface MapRun {
  version: MapDefinition['rulesVersion'];
  mapId: City;
  definitionHash: string;
  seed: number;
  rng: number;
  tick: number;
  stations: { x: number; y: number; shape: Shape }[];
  events: MapSpawnEvent[];
  pending: { shape: Shape; scheduleId: string; tick: number; retries: number }[];
  nextBatch: number;
  batchIndex: number;
  blocked: boolean;
}
export interface Options {
  seed?: number;
  city?: City;
  mode?: Mode;
}
export interface Passenger {
  id: number;
  shape: Shape;
  born: number;
  transfers: number;
}
/** Ephemeral simulation notification; never stored in State or replay checkpoints. */
export interface ServiceEvent {
  readonly type: 'arrive' | 'deliver' | 'transferOut' | 'board' | 'depart';
  readonly tick: number;
  /** Zero-based order within this tick, across all trains. */
  readonly sequence: number;
  readonly stationId: number;
  readonly trainId: number;
  readonly lineId: number;
  /** Null for train-level arrive/depart notifications. */
  readonly passengerId: number | null;
  readonly shape: Shape | null;
}
export type ServiceObserver = (event: Readonly<ServiceEvent>) => void;
export interface Station {
  id: number;
  x: number;
  y: number;
  shape: Shape;
  queue: Passenger[];
  crowd: number;
  interchange: boolean;
  born: number;
  nextPassenger: number;
}
export interface Line {
  id: number;
  stops: number[];
  loop: boolean;
}
export interface Train {
  id: number;
  line: number;
  from: number;
  to: number | null;
  progress: number;
  direction: 1 | -1;
  dwell: number;
  /** -1 while finishing the fixed departure padding. */
  serviceTicks?: number;
  /** Authoritative passenger currently moving between this train and its station. */
  transfer?: { passenger: Passenger; direction: 'board' | 'alight'; stationId: number; duration: number; progress: number } | null;
  passengers: Passenger[];
  carriages: number;
  retiring: boolean;
  moveTo: { line: number; station: number } | null;
}
export interface State {
  version: 'orchard-metro.rules.4';
  seed: number;
  rng: number;
  tick: number;
  city: City;
  mode: Mode;
  phase: 'playing' | 'upgrade' | 'over';
  elapsed: number;
  week: number;
  score: number;
  totalSpawned: number;
  totalWait: number;
  nextId: number;
  nextStation: number;
  stations: Station[];
  lines: Line[];
  trains: Train[];
  resources: { locomotives: number; carriages: number; tunnels: number; interchanges: number };
  upgrades: Upgrade[];
  lostStation: number | null;
}
export type Action =
  | { type: 'wait' }
  | { type: 'route'; line: number; stops: number[]; loop?: boolean }
  | { type: 'addTrain'; line: number; station?: number; direction?: 1 | -1 }
  | { type: 'removeTrain'; train: number }
  | { type: 'moveTrain'; train: number; line: number; station: number }
  | { type: 'carriage'; train: number; delta: 1 | -1 }
  | { type: 'interchange'; station: number }
  | { type: 'upgrade'; choice: Upgrade }
  | { type: 'station'; x: number; y: number; shape: Shape };
export interface ActionResult {
  ok: boolean;
  message: string;
}
export interface Candidate {
  label: string;
  value: number;
}
export interface Decision {
  action: Action;
  reason?: string;
  candidates?: Candidate[];
}
export interface Observation {
  protocol: 'orchard-metro.agent.v1';
  tick: number;
  state: State;
  budget: { freeTunnels: number; trainCapacity: number; crowdLimit: number; tickSeconds: number };
}
export interface Record extends Decision {
  id: number;
  tick: number;
  source: string;
  elapsedMs: number;
  observationHash: string;
  afterHash: string;
  result: ActionResult;
  error?: string;
}
export interface Checkpoint {
  tick: number;
  cursor: number;
  state: State;
  hash: string;
}
export interface Replay {
  format: 'orchard-metro.replay.v4';
  createdAt: string;
  options: Required<Options>;
  duration: number;
  decisions: Record[];
  checkpoints: Checkpoint[];
  finalHash: string;
}
export type Policy = (
  observation: Observation,
  signal: AbortSignal,
) => Decision | Promise<Decision>;
