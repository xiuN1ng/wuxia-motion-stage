import * as THREE from 'three';
import { BONE_DEFS, BONE_IDX } from '../rig/HumanoidRig.js';
import { applyForearmTwistSolver, SpringClothSolver } from '../pipeline/TwoBoneIK.js';

const NUM_BONES = BONE_DEFS.length; // 29

export const STANDARD_21_BONE_NAMES = Object.freeze([
  'Hips',
  'Spine',
  'Chest',
  'Neck',
  'Head',
  'LeftShoulder',
  'LeftUpperArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightUpperArm',
  'RightForeArm',
  'RightHand',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToe',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToe',
]);

/**
 * Exact 29-bone Upper Override Weight Mask derived dynamically via `BONE_IDX`.
 * - Lower Base (9): Hips (0) + Legs (15..22) = 0.00
 * - Upper Feather (2): Spine (1) = 0.55, Chest (2) = 0.85
 * - Upper Full (10): Neck (3), Head (4), Left/RightShoulder..Hand (5..7, 9, 10..12, 14) = 1.00
 * - Aux Twist (8, 13) & Cloth (23..28) = 0.00 (computed post-blend)
 */
export const UPPER_BONE_WEIGHTS = (() => {
  const w = new Float32Array(NUM_BONES);
  w[BONE_IDX.Spine] = 0.55;
  w[BONE_IDX.Chest] = 0.85;
  for (const idx of [
    BONE_IDX.Neck,
    BONE_IDX.Head,
    BONE_IDX.LeftShoulder,
    BONE_IDX.LeftUpperArm,
    BONE_IDX.LeftForeArm,
    BONE_IDX.LeftHand,
    BONE_IDX.RightShoulder,
    BONE_IDX.RightUpperArm,
    BONE_IDX.RightForeArm,
    BONE_IDX.RightHand,
  ]) {
    w[idx] = 1.0;
  }
  return w;
})();

export function getBoneLayerWeightsMap() {
  const out = {};
  for (const name of STANDARD_21_BONE_NAMES) {
    out[name] = Number(UPPER_BONE_WEIGHTS[BONE_IDX[name]].toFixed(2));
  }
  return out;
}

export function allocatePoseBuffer() {
  return {
    rootPos: new THREE.Vector3(0, 0.94, 0),
    quats: Array.from({ length: NUM_BONES }, () => new THREE.Quaternion()),
  };
}

export function copyPoseBuffer(dst, src) {
  dst.rootPos.copy(src.rootPos);
  for (let i = 0; i < NUM_BONES; i++) {
    dst.quats[i].copy(src.quats[i]);
  }
  return dst;
}

export function canonicalizeQuatHemisphere(q) {
  const flip =
    q.w < 0 ||
    (q.w === 0 && (q.y < 0 || (q.y === 0 && (q.x < 0 || (q.x === 0 && q.z < 0)))));
  if (flip) {
    q.set(-q.x, -q.y, -q.z, -q.w);
  }
  if (q.x === 0) q.x = 0;
  if (q.y === 0) q.y = 0;
  if (q.z === 0) q.z = 0;
  if (q.w === 0) q.w = 0;
  return q;
}

export function slerpPoseBuffers(poseA, poseB, alpha, outPose) {
  const safeAlpha = Number.isFinite(alpha) ? alpha : 0;
  const t = THREE.MathUtils.clamp(safeAlpha, 0, 1);
  outPose.rootPos.lerpVectors(poseA.rootPos, poseB.rootPos, t);
  for (let i = 0; i < NUM_BONES; i++) {
    outPose.quats[i].copy(poseA.quats[i]).slerp(poseB.quats[i], t);
  }
  return outPose;
}

// Module-level zero-GC math scratchpad
const _idQuat = new THREE.Quaternion();
const _yawLower = new THREE.Quaternion();
const _yawUpper = new THREE.Quaternion();
const _qCounter = new THREE.Quaternion();
const _qStepSpine = new THREE.Quaternion();
const _qStepChestWorld = new THREE.Quaternion();
const _qStepChestLocal = new THREE.Quaternion();
const _qSpineBlend = new THREE.Quaternion();
const _qChestBlend = new THREE.Quaternion();
const _qInvSpine = new THREE.Quaternion();

/**
 * Extracts pure Y-axis (`(0, 1, 0)`) twist quaternion normalized to `w >= 0` hemisphere.
 */
export function extractYawQuat(q, out = new THREE.Quaternion()) {
  const len = Math.hypot(q.y, q.w);
  if (!Number.isFinite(len) || len < 1e-6) return out.identity();
  const sign = q.w < 0 || (q.w === 0 && q.y < 0) ? -1 : 1;
  return out.set(0, (q.y * sign) / len || 0, 0, (q.w * sign) / len || 0);
}

/**
 * Self-contained `nonCyclic`-safe normalized clip sampler (`u in [0, 1]`).
 * Never wraps `u = 1.0` back to frame `0` on one-shot clips.
 */
export function sampleClipNormalized(frames, u, nonCyclic, outPose) {
  const N = frames ? frames.length : 0;
  if (N === 0) return outPose;
  if (N === 1) {
    outPose.rootPos.copy(frames[0].rootPos);
    for (let i = 0; i < NUM_BONES; i++) {
      outPose.quats[i].copy(frames[0].quats[i]);
    }
    return outPose;
  }

  const safeU = Number.isFinite(u) ? u : 0;
  let f0;
  let f1;
  let alpha;
  if (nonCyclic) {
    const cu = THREE.MathUtils.clamp(safeU, 0, 1);
    const t = cu * (N - 1);
    f0 = Math.min(N - 1, Math.floor(t));
    f1 = Math.min(N - 1, f0 + 1);
    alpha = t - f0;
  } else {
    const wu = ((safeU % 1) + 1) % 1;
    const t = wu * N;
    f0 = Math.floor(t) % N;
    f1 = (f0 + 1) % N;
    alpha = t - Math.floor(t);
  }

  const a = frames[f0];
  const b = frames[f1];
  outPose.rootPos.lerpVectors(a.rootPos, b.rootPos, alpha);
  for (let i = 0; i < NUM_BONES; i++) {
    outPose.quats[i].copy(a.quats[i]).slerp(b.quats[i], alpha);
  }
  return outPose;
}

/**
 * Blends Upper Body Override pose over Lower Body Base pose with exact
 * conjugated `premultiply` pelvis counter-yaw compensation (55% on Spine + 45% conjugated on Chest).
 */
export function blendUpperOverLowerWithCounterYaw(basePose, upperPose, upperAlpha, outPose) {
  const safeUpperAlpha = Number.isFinite(upperAlpha) ? upperAlpha : 0;
  outPose.rootPos.copy(basePose.rootPos);
  if (safeUpperAlpha <= 1e-5) {
    for (let i = 0; i < NUM_BONES; i++) {
      outPose.quats[i].copy(basePose.quats[i]);
    }
    return outPose;
  }

  const clampedAlpha = THREE.MathUtils.clamp(safeUpperAlpha, 0, 1);
  for (let i = 0; i < NUM_BONES; i++) {
    const effW = UPPER_BONE_WEIGHTS[i] * clampedAlpha;
    if (effW <= 1e-5) {
      outPose.quats[i].copy(basePose.quats[i]);
    } else {
      outPose.quats[i].copy(basePose.quats[i]).slerp(upperPose.quats[i], effW);
    }
  }

  // Pelvis Counter-Yaw Compensation: qCounter = inv(yaw(lower.Hips)) * yaw(upper.Hips)
  extractYawQuat(basePose.quats[BONE_IDX.Hips], _yawLower);
  extractYawQuat(upperPose.quats[BONE_IDX.Hips], _yawUpper);
  _qCounter.copy(_yawLower).invert().multiply(_yawUpper);
  canonicalizeQuatHemisphere(_qCounter);

  // Fast exit when lower & upper Hips have identical Y-yaw (exact identity preservation)
  if (Math.abs(_qCounter.y) <= 1e-7) {
    return outPose;
  }

  _qSpineBlend.copy(outPose.quats[BONE_IDX.Spine]);
  _qChestBlend.copy(outPose.quats[BONE_IDX.Chest]);

  _qStepSpine.copy(_idQuat).slerp(_qCounter, 0.55 * clampedAlpha);
  _qStepChestWorld.copy(_idQuat).slerp(_qCounter, 0.45 * clampedAlpha);

  // Conjugate Chest's 45% step by inv(_qSpineBlend) so both steps rotate strictly around Hips vertical Y-axis!
  _qInvSpine.copy(_qSpineBlend).invert();
  _qStepChestLocal.multiplyQuaternions(_qInvSpine, _qStepChestWorld).multiply(_qSpineBlend);

  outPose.quats[BONE_IDX.Spine].multiplyQuaternions(_qStepSpine, _qSpineBlend);
  outPose.quats[BONE_IDX.Chest].multiplyQuaternions(_qStepChestLocal, _qChestBlend);
  return outPose;
}

export class LayeredAnimator {
  /**
   * @param {object} rig Result of `buildCharacterRig()` (`{ bones, rootGroup, ... }`)
   * @param {THREE.Group} [worldGroup] World transform container holding `(worldPos, playerYaw)`
   * @param {object} [clipRegistry] `CombatClipRegistry` instance
   */
  constructor(rig, worldGroup = null, clipRegistry = null) {
    this.rig = rig;
    this.bones = rig.bones;
    this.worldGroup = worldGroup || rig.rootGroup;
    this.clipRegistry = clipRegistry;

    // Independent per-character SpringClothSolver (NEVER shared with EnemyDummy!)
    this.clothSolver = new SpringClothSolver();

    this.baseClipId = null;
    this.baseFadeElapsed = 0;
    this.baseFadeDuration = 0;

    this.upperClipId = null;
    this.upperFadeElapsed = 0;
    this.upperFadeDuration = 0;
    this.upperLayerAlpha = 0;

    this._hasInitializedPose = false;
    this._hasUpperPose = false;

    // Pre-allocated zero-GC pose buffers
    this._baseCurrPose = allocatePoseBuffer();
    this._baseFromPose = allocatePoseBuffer();
    this._baseOutPose = allocatePoseBuffer();

    this._upperCurrPose = allocatePoseBuffer();
    this._upperFromPose = allocatePoseBuffer();
    this._upperOutPose = allocatePoseBuffer();
    this._lastUpperPose = allocatePoseBuffer();

    this._finalPose = allocatePoseBuffer();
  }

  setClipRegistry(registry) {
    this.clipRegistry = registry;
  }

  resetCloth() {
    this.clothSolver.reset(this.bones);
    this.worldGroup.updateMatrixWorld(true);
  }

  reset() {
    this.baseClipId = null;
    this.baseFadeElapsed = 0;
    this.baseFadeDuration = 0;
    this.upperClipId = null;
    this.upperFadeElapsed = 0;
    this.upperFadeDuration = 0;
    this.upperLayerAlpha = 0;
    this._hasInitializedPose = false;
    this._hasUpperPose = false;
    this.clothSolver.reset(this.bones);
  }

  /**
   * Evaluates Base + Upper Override crossfades, applies conjugated pelvis counter-yaw,
   * commits to `bones`, runs `applyForearmTwistSolver` (58% roll) & 360° `SpringClothSolver`,
   * and updates `worldGroup.matrixWorld`.
   */
  evaluate(dt, params = {}) {
    const safeParams = params && typeof params === 'object' ? params : {};
    const {
      baseClip: explicitBaseClip = null,
      baseClipId = 'taibai_01b',
      baseNormalizedTime = 0,
      baseCrossfadeSec = 0.10,
      upperClip: explicitUpperClip = null,
      upperClipId = null,
      upperNormalizedTime = 0,
      upperCrossfadeSec = 0.06,
      targetUpperAlpha = 0,
      forceUpperAlpha = undefined,
      worldPos = { x: 0, y: 0, z: 0 },
      playerYaw = 0,
      worldVelXZ = { x: 0, z: 0 },
      inHitstop = false,
      simTimeSec = 0,
      clothEnabled = true,
      twistEnabled = true,
    } = safeParams;

    const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const animDt = inHitstop ? 0 : safeDt;

    const safeBaseNormU = Number.isFinite(baseNormalizedTime) ? baseNormalizedTime : 0;
    const safeBaseCrossfade =
      Number.isFinite(baseCrossfadeSec) && baseCrossfadeSec > 0 ? baseCrossfadeSec : 0;
    const safeUpperNormU = Number.isFinite(upperNormalizedTime) ? upperNormalizedTime : 0;
    const safeUpperCrossfade =
      Number.isFinite(upperCrossfadeSec) && upperCrossfadeSec > 0 ? upperCrossfadeSec : 0;
    const safeTargetUpperAlpha = Number.isFinite(targetUpperAlpha)
      ? THREE.MathUtils.clamp(targetUpperAlpha, 0, 1)
      : 0;
    const hasFiniteForceUpperAlpha =
      typeof forceUpperAlpha === 'number' && Number.isFinite(forceUpperAlpha);

    const safeWorldX = Number.isFinite(worldPos?.x) ? worldPos.x : 0;
    const safeWorldY = Number.isFinite(worldPos?.y) ? worldPos.y : 0;
    const safeWorldZ = Number.isFinite(worldPos?.z) ? worldPos.z : 0;
    const safePlayerYaw = Number.isFinite(playerYaw) ? playerYaw : 0;
    const safeVelX = Number.isFinite(worldVelXZ?.x) ? worldVelXZ.x : 0;
    const safeVelZ = Number.isFinite(worldVelXZ?.z) ? worldVelXZ.z : 0;
    const safeSimTimeSec = Number.isFinite(simTimeSec) ? simTimeSec : 0;

    // Self-heal internal timers/alpha if ever mutated externally to non-finite
    if (!Number.isFinite(this.upperLayerAlpha)) this.upperLayerAlpha = 0;
    if (!Number.isFinite(this.baseFadeElapsed)) this.baseFadeElapsed = 0;
    if (!Number.isFinite(this.baseFadeDuration)) this.baseFadeDuration = 0;
    if (!Number.isFinite(this.upperFadeElapsed)) this.upperFadeElapsed = 0;
    if (!Number.isFinite(this.upperFadeDuration)) this.upperFadeDuration = 0;

    // 1. Resolve & crossfade Base Layer
    const baseClip = explicitBaseClip || (this.clipRegistry ? this.clipRegistry.getClip(baseClipId) : null);
    const resolvedBaseId = baseClip?.id || baseClipId;

    if (this._hasInitializedPose && resolvedBaseId !== this.baseClipId) {
      // Snapshot currently displayed pose if exiting upper override, else base pose
      const snapSrc =
        safeTargetUpperAlpha <= 1e-4 && this.upperLayerAlpha > 0.05
          ? this._finalPose
          : this._baseOutPose;
      copyPoseBuffer(this._baseFromPose, snapSrc);
      this.baseFadeElapsed = 0;
      this.baseFadeDuration = safeBaseCrossfade;
    }
    this.baseClipId = resolvedBaseId;

    if (baseClip && baseClip.frames.length > 0) {
      sampleClipNormalized(
        baseClip.frames,
        safeBaseNormU,
        Boolean(baseClip.nonCyclic),
        this._baseCurrPose
      );
    }

    if (this.baseFadeDuration > 1e-5 && this.baseFadeElapsed < this.baseFadeDuration) {
      this.baseFadeElapsed = Math.min(this.baseFadeDuration, this.baseFadeElapsed + animDt);
      const t = this.baseFadeElapsed / this.baseFadeDuration;
      const smoothT = t * t * (3 - 2 * t);
      slerpPoseBuffers(this._baseFromPose, this._baseCurrPose, smoothT, this._baseOutPose);
    } else {
      copyPoseBuffer(this._baseOutPose, this._baseCurrPose);
    }

    // 2. Ramp `upperLayerAlpha` & evaluate Upper Override Layer
    if (hasFiniteForceUpperAlpha) {
      this.upperLayerAlpha = THREE.MathUtils.clamp(forceUpperAlpha, 0, 1);
    } else if (safeTargetUpperAlpha > this.upperLayerAlpha) {
      this.upperLayerAlpha = Math.min(safeTargetUpperAlpha, this.upperLayerAlpha + animDt / 0.10);
    } else if (safeTargetUpperAlpha < this.upperLayerAlpha) {
      this.upperLayerAlpha = Math.max(safeTargetUpperAlpha, this.upperLayerAlpha - animDt / 0.18);
    }

    const upperClip =
      explicitUpperClip ||
      (upperClipId && this.clipRegistry ? this.clipRegistry.getClip(upperClipId) : null);
    const resolvedUpperId = upperClip ? upperClip.id || upperClipId : null;

    if (upperClip && upperClip.frames.length > 0) {
      if (this._hasUpperPose && this.upperClipId && resolvedUpperId !== this.upperClipId) {
        copyPoseBuffer(this._upperFromPose, this._upperOutPose);
        this.upperFadeElapsed = 0;
        this.upperFadeDuration = safeUpperCrossfade;
      }
      this.upperClipId = resolvedUpperId;

      sampleClipNormalized(
        upperClip.frames,
        safeUpperNormU,
        upperClip.nonCyclic !== undefined ? Boolean(upperClip.nonCyclic) : true,
        this._upperCurrPose
      );

      if (this.upperFadeDuration > 1e-5 && this.upperFadeElapsed < this.upperFadeDuration) {
        this.upperFadeElapsed = Math.min(this.upperFadeDuration, this.upperFadeElapsed + animDt);
        const t = this.upperFadeElapsed / this.upperFadeDuration;
        const smoothT = t * t * (3 - 2 * t);
        slerpPoseBuffers(this._upperFromPose, this._upperCurrPose, smoothT, this._upperOutPose);
      } else {
        copyPoseBuffer(this._upperOutPose, this._upperCurrPose);
      }

      copyPoseBuffer(this._lastUpperPose, this._upperOutPose);
      this._hasUpperPose = true;
    } else {
      this.upperClipId = null;
    }

    // 3. Upper/Lower Masked Slerp + Conjugated Pelvis Counter-Yaw
    if (this.upperLayerAlpha > 1e-5 && this._hasUpperPose) {
      blendUpperOverLowerWithCounterYaw(
        this._baseOutPose,
        this._lastUpperPose,
        this.upperLayerAlpha,
        this._finalPose
      );
    } else {
      copyPoseBuffer(this._finalPose, this._baseOutPose);
    }

    this._hasInitializedPose = true;

    // 4. Commit to World Container & Skeleton Bones (6-Step Anti-Double-Root-Motion Order)
    this.worldGroup.position.set(safeWorldX, safeWorldY, safeWorldZ);
    this.worldGroup.rotation.set(0, safePlayerYaw, 0);

    // Local Hips holds vertical height + subtle cyclic gait sway (non-cyclic clips already have x=0, z=0)
    this.bones[BONE_IDX.Hips].position.set(
      this._finalPose.rootPos.x,
      this._finalPose.rootPos.y,
      this._finalPose.rootPos.z
    );
    for (let i = 0; i <= BONE_IDX.RightToe; i++) {
      if (i === BONE_IDX.LeftForeArmTwist || i === BONE_IDX.RightForeArmTwist) continue;
      const q = this.bones[i].quaternion.copy(this._finalPose.quats[i]);
      canonicalizeQuatHemisphere(q);
      this._finalPose.quats[i].copy(q);
    }

    if (inHitstop) {
      this.bones[BONE_IDX.RightForeArm].rotation.z += Math.sin(safeSimTimeSec * 95) * 0.022;
      canonicalizeQuatHemisphere(this.bones[BONE_IDX.RightForeArm].quaternion);
    }

    // 5. Post-blend ForeArm Twist (58% wrist roll)
    applyForearmTwistSolver(this.bones, twistEnabled);
    canonicalizeQuatHemisphere(this.bones[BONE_IDX.LeftForeArmTwist].quaternion);
    canonicalizeQuatHemisphere(this.bones[BONE_IDX.RightForeArmTwist].quaternion);

    // 6. Post-blend 360° Yaw-Invariant SpringClothSolver (skip during hitstop / safeDt <= 1e-6)
    if (clothEnabled && !inHitstop && safeDt > 1e-6) {
      const localForwardSpeed =
        safeVelX * Math.sin(safePlayerYaw) + safeVelZ * Math.cos(safePlayerYaw);
      const syntheticForwardSpeed = localForwardSpeed - safeVelZ;
      this.clothSolver.update(this.bones, safeDt, true, syntheticForwardSpeed);
    } else if (!clothEnabled) {
      this.clothSolver.update(this.bones, 0.016, false, 0);
    }

    // Mandatory trailing matrix sync so SkinnedMesh & swordGroup anchors reflect updated bones/cloth
    this.worldGroup.updateMatrixWorld(true);

    return this._finalPose;
  }
}
