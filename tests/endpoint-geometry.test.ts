// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

// Given a route terminator, when its reusable geometry is built, then it has
// a solid T roof, physical side walls and both lit surface orientations.
describe('solid route terminators', () => {
  it('has an extruded T silhouette rather than a flat glyph', async () => {
    const { createEndpointGeometry } = await import('../src/endpoint-geometry');
    const geometry = createEndpointGeometry();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.max.x - box.min.x).toBeGreaterThan(17);
    expect(box.max.z - box.min.z).toBeGreaterThan(19);
    expect(box.max.y - box.min.y).toBeCloseTo(1);
    const normal = geometry.getAttribute('normal');
    const roof = Array.from({ length: normal.count }, (_, i) => normal.getY(i)).filter(n => n > .99);
    const walls = Array.from({ length: normal.count }, (_, i) => normal.getY(i)).filter(n => Math.abs(n) < .01);
    expect(roof.length).toBeGreaterThan(6);
    expect(walls.length).toBeGreaterThan(12);
    geometry.dispose();
  });
});
