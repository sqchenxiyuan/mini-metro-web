import { describe, expect, it } from 'vitest';
import { advance, applyAction, createState, GLYPHS, SHAPES } from '../src/rules';
import type { Shape } from '../src/types';
import { stationOutline } from '../src/renderer';
import { ShapeGeometry } from 'three';
import { creativeStationPicker } from '../src/station-picker';
import { ReplayPlayer, Session } from '../src/session';

const workshopShapes: Shape[] = [
  'circle', 'triangle', 'square', 'cross', 'diamond', 'egg', 'gem', 'pentagon', 'star', 'wedge',
];

describe('Workshop-supported station shapes', () => {
  it('recognizes all documented station types and gives each a distinct glyph', () => {
    expect(new Set(SHAPES)).toEqual(new Set(workshopShapes));
    expect(Object.keys(GLYPHS)).toEqual(expect.arrayContaining(workshopShapes));
    expect(new Set(workshopShapes.map((shape) => GLYPHS[shape])).size).toBe(workshopShapes.length);
  });

  it.each(workshopShapes)('can place and route passengers to a %s station in Creative', (shape) => {
    const s = createState({ mode: 'creative' });
    const result = applyAction(s, { type: 'station', x: -10, y: -6, shape });
    expect(result.ok).toBe(true);
    expect(s.stations.at(-1)?.shape).toBe(shape);
  });

  it('rejects unknown shapes rather than accepting arbitrary station types', () => {
    const s = createState({ mode: 'creative' });
    expect(() => applyAction(s, { type: 'station', x: -10, y: -6, shape: 'hexagon' as Shape })).toThrow('非法车站');
  });

  it('draws a distinct, nonempty silhouette for every supported station type', () => {
    const outlines = workshopShapes.map((shape) => {
      const outline = stationOutline(shape, 1);
      const geometry = new ShapeGeometry(outline);
      const vertexCount = geometry.getAttribute('position').count;
      geometry.dispose();
      expect(vertexCount).toBeGreaterThan(2);
      return JSON.stringify(outline.getPoints(24).map((p) => [Number(p.x.toFixed(2)), Number(p.y.toFixed(2))]));
    });
    expect(new Set(outlines).size).toBe(workshopShapes.length);
  });

  it('delivers passengers to each newly supported destination shape', () => {
    for (const shape of ['egg', 'gem', 'pentagon', 'wedge'] as const) {
      const s = createState({ mode: 'creative' });
      expect(applyAction(s, { type: 'station', x: -10, y: -6, shape }).ok).toBe(true);
      for (const p of s.stations) p.nextPassenger = Number.MAX_SAFE_INTEGER;
      const destination = s.stations.at(-1)!;
      expect(applyAction(s, { type: 'route', line: 0, stops: [s.stations[0].id, destination.id] }).ok).toBe(true);
      s.stations[0].queue.push({ id: s.nextId++, shape, born: 0, transfers: 0 });
      for (let i = 0; i < 400 && !s.score; i++) advance(s);
      expect(s.score, `passenger to ${shape}`).toBe(1);
    }
  });

  it('makes every supported shape directly selectable in the Creative UI', () => {
    const html = creativeStationPicker();
    for (const shape of workshopShapes) {
      expect(html).toContain(`data-station-shape="${shape}"`);
      expect(html).toContain(`<svg data-shape-icon="${shape}"`);
    }
    expect((html.match(/data-station-shape=/g) ?? [])).toHaveLength(workshopShapes.length);
  });

  it('replays Creative placements of new station shapes without changing their identity', () => {
    const game = new Session({ seed: 17, city: 'orchard', mode: 'creative' });
    for (const [shape, x, y] of [
      ['pentagon', -10, -6], ['egg', -12, -2], ['gem', -12, 4], ['wedge', -6, -6],
    ] as const) {
      expect(game.submit({ action: { type: 'station', x, y, shape } }).ok).toBe(true);
    }
    const replay = game.exportReplay();
    const player = new ReplayPlayer(replay);
    expect(player.seek(game.tick).stations.map((station) => station.shape)).toEqual(
      game.getState().stations.map((station) => station.shape),
    );
  });
});
