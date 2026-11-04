// SPDX-License-Identifier: GPL-3.0-or-later
import { SHAPES } from './rules';
import type { Shape } from './types';
import { stationOutline } from './renderer';

const NAMES: Record<Shape, string> = {
  circle: '圆形', triangle: '三角形', square: '方形',
  diamond: '菱形', star: '星形', cross: '十字形',
  pentagon: '五边形', egg: '蛋形', gem: '宝石形', wedge: '楔形',
};

function shapeIcon(shape: Shape): string {
  const path = stationOutline(shape, 1).getPoints(32)
    .map((point) => `${(point.x * 12 + 16).toFixed(2)},${(16 - point.y * 12).toFixed(2)}`)
    .join(' ');
  return `<svg data-shape-icon="${shape}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><polygon points="${path}" fill="currentColor"/></svg>`;
}

/** Creative mode is a choice, not a fixed station-count cycle. */
export function creativeStationPicker(): string {
  return `<div class="shape-row creative-shapes" aria-label="选择车站形状">${SHAPES.map(
    (shape) => `<button type="button" data-station-shape="${shape}" title="${NAMES[shape]}" aria-label="建造${NAMES[shape]}车站">${shapeIcon(shape)}</button>`,
  ).join('')}</div>`;
}
