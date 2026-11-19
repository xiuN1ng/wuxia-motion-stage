import * as THREE from 'three';

function wrapAngleRad(a) {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
}

export class CombatCamera {
  constructor(width = 1280, height = 720) {
    const safeAspect = Math.max(1, width) / Math.max(1, height);
    this.camera = new THREE.PerspectiveCamera(44, safeAspect, 0.1, 72);

    this.orbitYaw = 0; // 0 = camera sits at -Z looking along +Z
    this.orbitPitch = 0.33;
    this.distance = 4.75;

    this.focusPos = new THREE.Vector3(0, 1.08, 0.6);
    this.currentCamPos = new THREE.Vector3(0, 2.45, -4.4);
    this._desiredFocus = new THREE.Vector3();
    this._desiredCamPos = new THREE.Vector3();

    this.shakeTimer = 0;
    this.shakeDuration = 0.14;
    this.shakeMagnitude = 0;
    this.simTime = 0;

    this.snapImmediate({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1.65 }, false);
  }

  setAspect(width, height) {
    const w = Math.max(1, width || 1280);
    const h = Math.max(1, height || 720);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  rotateOrbit(deltaYaw, deltaPitch) {
    this.orbitYaw = wrapAngleRad(this.orbitYaw - deltaYaw);
    this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + deltaPitch, 0.10, 0.88);
  }

  zoom(deltaDistance) {
    this.distance = THREE.MathUtils.clamp(this.distance + deltaDistance, 3.1, 7.8);
  }

  addShake(intensity = 0.08, durationSec = 0.14) {
    this.shakeMagnitude = Math.max(this.shakeMagnitude, intensity);
    this.shakeDuration = Math.max(0.05, durationSec);
    this.shakeTimer = this.shakeDuration;
  }

  /**
   * Returns camera's horizontal look-forward yaw (`0` = `+Z`, `+PI/2` = `+X`).
   */
  getPlanarForwardYaw() {
    const dx = this.focusPos.x - this.currentCamPos.x;
    const dz = this.focusPos.z - this.currentCamPos.z;
    if (Math.hypot(dx, dz) < 1e-4) return this.orbitYaw;
    return Math.atan2(dx, dz);
  }

  snapImmediate(playerPos, dummyPos, isLockedOn) {
    this._computeTargets(playerPos, dummyPos, isLockedOn, 1.0);
    this.focusPos.copy(this._desiredFocus);
    this.currentCamPos.copy(this._desiredCamPos);
    this.camera.position.copy(this.currentCamPos);
    this.camera.lookAt(this.focusPos);
  }

  _computeTargets(playerPos, dummyPos, isLockedOn, dampAlpha) {
    let effDist = this.distance;
    let effPitch = this.orbitPitch;

    if (isLockedOn && dummyPos) {
      const dx = dummyPos.x - playerPos.x;
      const dz = dummyPos.z - playerPos.z;
      const sep = Math.hypot(dx, dz);
      // Over-the-right-shoulder dueling framing (+9 deg offset) so neither fighter occludes blade arcs
      const lockYaw = (sep > 1e-4 ? Math.atan2(dx, dz) : this.orbitYaw) + 0.16;
      const diff = wrapAngleRad(lockYaw - this.orbitYaw);
      this.orbitYaw = wrapAngleRad(this.orbitYaw + diff * dampAlpha);

      effDist = THREE.MathUtils.clamp(sep * 0.58 + 3.65, 4.15, 6.85);
      effPitch = 0.34;

      this._desiredFocus.set(
        THREE.MathUtils.lerp(playerPos.x, dummyPos.x, 0.38),
        THREE.MathUtils.lerp(playerPos.y || 0, dummyPos.y || 0, 0.25) + 1.06,
        THREE.MathUtils.lerp(playerPos.z, dummyPos.z, 0.38)
      );
    } else {
      this._desiredFocus.set(
        playerPos.x,
        (playerPos.y || 0) * 0.65 + 1.08,
        playerPos.z
      );
    }

    const horizDist = Math.cos(effPitch) * effDist;
    const vertHeight = Math.sin(effPitch) * effDist;

    this._desiredCamPos.set(
      this._desiredFocus.x - Math.sin(this.orbitYaw) * horizDist,
      Math.max(0.45, this._desiredFocus.y + vertHeight * 0.78),
      this._desiredFocus.z - Math.cos(this.orbitYaw) * horizDist
    );
  }

  update(dt, playerPos, dummyPos, isLockedOn = false) {
    const safeDt = Math.max(0, Math.min(dt, 0.1));
    this.simTime += safeDt;

    const damp = safeDt > 0 ? 1 - Math.exp(-12 * safeDt) : 1.0;
    this._computeTargets(playerPos, dummyPos, isLockedOn, damp);

    this.focusPos.lerp(this._desiredFocus, damp);
    this.currentCamPos.lerp(this._desiredCamPos, damp);

    this.camera.position.copy(this.currentCamPos);

    if (this.shakeTimer > 0) {
      this.shakeTimer = Math.max(0, this.shakeTimer - safeDt);
      const decay = this.shakeTimer / this.shakeDuration;
      const amp = this.shakeMagnitude * decay;
      this.camera.position.x += Math.sin(this.simTime * 67) * amp;
      this.camera.position.y += Math.cos(this.simTime * 83) * amp * 0.75;
      if (this.shakeTimer <= 0) {
        this.shakeMagnitude = 0;
      }
    }

    this.camera.lookAt(this.focusPos);
  }
}
