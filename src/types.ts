// SPDX-License-Identifier: GPL-3.0-or-later
export type Shape = 'circle' | 'triangle' | 'square' | 'diamond' | 'star' | 'cross';
export type City = 'orchard' | 'harbor' | 'islands';
export type Mode = 'normal' | 'endless' | 'extreme' | 'creative';
export type Upgrade = 'line' | 'carriage' | 'tunnels' | 'interchange';
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
  passengers: Passenger[];
  carriages: number;
  retiring: boolean;
  moveTo: { line: number; station: number } | null;
}
export interface State {
  version: 'orchard-metro.rules.1';
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
  format: 'orchard-metro.replay.v1';
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
