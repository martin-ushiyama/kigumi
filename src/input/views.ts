import * as THREE from 'three';

export type ViewPreset = 'top' | 'front' | 'side';

/** The minimal contract from OrbitControls that the view-preset calculation needs — just target (flagged in review) */
export interface OrbitTarget {
  target: THREE.Vector3;
}

export interface ViewPresetOpts {
  camera: THREE.PerspectiveCamera;
  controls: OrbitTarget;
  getFocus: () => { center: THREE.Vector3; radius: number } | null;
}

/**
 * Snaps instantly to a view preset (top / front / side).
 * OrbitControls recalculates spherical coordinates from camera.position - target every
 * frame, so directly rewriting the position is enough to take effect on the next
 * update(). Exactly at the pole (straight down) azimuth becomes undefined, so a tiny Z
 * offset is added.
 */
export function applyViewPreset(preset: ViewPreset, opts: ViewPresetOpts): void {
  const { camera, controls, getFocus } = opts;
  const focus = getFocus();
  const target = focus ? focus.center : controls.target.clone();
  const dist = focus
    ? Math.max(8, focus.radius * 2.4)
    : Math.max(4, camera.position.distanceTo(controls.target));

  controls.target.copy(target);
  const EPS = dist * 0.001;
  if (preset === 'top') camera.position.set(target.x, target.y + dist, target.z + EPS);
  else if (preset === 'front') camera.position.set(target.x, target.y, target.z + dist);
  else camera.position.set(target.x + dist, target.y, target.z);
  camera.up.set(0, 1, 0);
}
