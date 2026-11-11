// SPDX-License-Identifier: GPL-3.0-or-later
import { tunnelsUsed } from './rules';
import type { State } from './types';
import type { ResourceKind } from './resource-drag';

/** Newly authored outlines; no original-game artwork is bundled. */
export const RESOURCE_ICONS = {
  locomotive: '<path d="M5 8h12l6 6v5H5z M8 8V5h7v3 M17 9v5h5 M3 19h22"/><circle cx="9" cy="21" r="2"/><circle cx="20" cy="21" r="2"/>',
  carriage: '<rect x="4" y="8" width="21" height="11" rx="2"/><path d="M9 8v11 M20 8v11 M1 14h3 M25 14h3"/><circle cx="9" cy="21" r="2"/><circle cx="20" cy="21" r="2"/>',
  tunnels: '<path d="M4 23V14a10 10 0 0 1 20 0v9 M9 23v-9a5 5 0 0 1 10 0v9 M2 23h9 M17 23h9"/>',
  interchanges: '<circle cx="14" cy="14" r="10"/><circle cx="14" cy="14" r="5"/>',
};
export function resourceIcon(kind: keyof typeof RESOURCE_ICONS): string {
  return `<svg viewBox="0 0 28 28" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${RESOURCE_ICONS[kind]}</svg>`;
}
const NAMES = { locomotive: '机车', carriage: '车厢', tunnels: '隧道', interchanges: '枢纽' };
/** Create once; update text/attributes in place so pointer capture and focus survive ticks. */
export function createResourceUI(tray: HTMLElement, passive: HTMLElement) {
  for (const kind of ['locomotive', 'carriage', 'tunnels', 'interchanges'] as const) {
    const item = document.createElement(kind === 'locomotive' || kind === 'carriage' ? 'button' : 'span');
    item.className = 'resource-stock';
    item.dataset.stock = kind;
    if (item instanceof HTMLButtonElement) { item.type = 'button'; item.dataset.resource = kind; item.setAttribute('aria-pressed', 'false'); }
    item.innerHTML = `${resourceIcon(kind)}<b>0</b><small>${NAMES[kind]}</small>`;
    tray.append(item);
  }
  return {
    update(state: State, replay: boolean, armed: ResourceKind | null): void {
      const counts = { locomotive: state.resources.locomotives, carriage: state.resources.carriages,
        tunnels: state.resources.tunnels - tunnelsUsed(state), interchanges: state.resources.interchanges };
      for (const item of tray.querySelectorAll<HTMLElement>('[data-stock]')) {
        const kind = item.dataset.stock as keyof typeof counts, count = counts[kind];
        item.querySelector('b')!.textContent = String(count);
        item.classList.toggle('empty', count < 1);
        const label = `${NAMES[kind]} ${count}${kind === 'tunnels' ? `，共 ${state.resources.tunnels}` : ''}`;
        item.title = label + (item instanceof HTMLButtonElement ? '；拖到地图，或按 Enter 后选择目标' : '（数量）');
        item.setAttribute('aria-label', item.title);
        if (item instanceof HTMLButtonElement) {
          item.disabled = replay || state.phase !== 'playing' || count < 1;
          item.setAttribute('aria-pressed', String(kind === armed));
        }
      }
      // Inspector has no duplicate active stock buttons or capture owners.
      passive.textContent = `机车 ${counts.locomotive} · 车厢 ${counts.carriage} · 隧道 ${counts.tunnels}/${state.resources.tunnels} · 枢纽 ${counts.interchanges}`;
    },
  };
}
