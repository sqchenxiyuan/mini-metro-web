// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from 'three';

/** Stage-local CSS pixels, already projected/warped by the owning renderer. */
export interface EndpointHandle {
  readonly key: string;
  readonly line: number;
  readonly x: number;
  readonly y: number;
  readonly owner: Readonly<{ x: number; y: number }>;
}

/** One reusable solid T: local +x points away from its owning station. */
export function createEndpointGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-10, -2.5);
  for (const [x, y] of [[4, -2.5], [4, -10], [9, -10], [9, 10], [4, 10], [4, 2.5], [-10, 2.5]])
    shape.lineTo(x, y);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: .76, bevelEnabled: true, bevelSize: .4, bevelThickness: .12,
    bevelSegments: 1, steps: 1, curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, .12, 0);
  return geometry;
}
