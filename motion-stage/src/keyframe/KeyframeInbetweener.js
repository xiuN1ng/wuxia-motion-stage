import * as THREE from 'three';
import { BONE_DEFS, BONE_IDX, createBoneHierarchy } from '../rig/HumanoidRig.js';
import {
  DEFAULT_CLEAN_OPTIONS,
  sanitizeVec3,
  sanitizeUnitQuat,
  runCleaningPipeline,
  analyzeMotionTelemetry,
} from '../pipeline/MotionCleaner.js';

const NUM_BONES = BONE_DEFS.length;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const BLADE_LOCAL_DIR = new THREE.Vector3(-0.619, 0.754, 0.219).normalize();

export const EDITABLE_BONE_GROUPS = [
  { idx: BONE_IDX.Hips, shortLabel: '骨盆', group: 'core' },
  { idx: BONE_IDX.Spine, shortLabel: '腰腹', group: 'core' },
  { idx: BONE_IDX.Chest, shortLabel: '胸腔', group: 'core' },
  { idx: BONE_IDX.Neck, shortLabel: '颈部', group: 'core' },
  { idx: BONE_IDX.Head, shortLabel: '头部', group: 'core' },
  { idx: BONE_IDX.RightShoulder, shortLabel: '右锁骨', group: 'rightArm' },
  { idx: BONE_IDX.RightUpperArm, shortLabel: '右大臂', group: 'rightArm' },
  { idx: BONE_IDX.RightForeArm, shortLabel: '右小臂', group: 'rightArm' },
  { idx: BONE_IDX.RightHand, shortLabel: '右手剑', group: 'rightArm' },
  { idx: BONE_IDX.LeftShoulder, shortLabel: '左锁骨', group: 'leftArm' },
  { idx: BONE_IDX.LeftUpperArm, shortLabel: '左大臂', group: 'leftArm' },
  { idx: BONE_IDX.LeftForeArm, shortLabel: '左小臂', group: 'leftArm' },
  { idx: BONE_IDX.LeftHand, shortLabel: '左手诀', group: 'leftArm' },
  { idx: BONE_IDX.LeftUpLeg, shortLabel: '左大腿', group: 'legs' },
  { idx: BONE_IDX.LeftLeg, shortLabel: '左小腿', group: 'legs' },
  { idx: BONE_IDX.LeftFoot, shortLabel: '左脚踝', group: 'legs' },
  { idx: BONE_IDX.RightUpLeg, shortLabel: '右大腿', group: 'legs' },
  { idx: BONE_IDX.RightLeg, shortLabel: '右小腿', group: 'legs' },
  { idx: BONE_IDX.RightFoot, shortLabel: '右脚踝', group: 'legs' },
];

// Proximal-to-distal biomechanical phase offsets: positive leads, negative whips/lags
const BONE_KINETIC_PHASE = (() => {
  const arr = new Float64Array(NUM_BONES);
  arr[BONE_IDX.Hips] = 0.055;
  arr[BONE_IDX.Spine] = 0.025;
  arr[BONE_IDX.Chest] = 0.0;
  arr[BONE_IDX.Neck] = 0.02;
  arr[BONE_IDX.Head] = 0.035;
  arr[BONE_IDX.LeftShoulder] = -0.02;
  arr[BONE_IDX.LeftUpperArm] = -0.05;
  arr[BONE_IDX.LeftForeArm] = -0.08;
  arr[BONE_IDX.LeftHand] = -0.105;
  arr[BONE_IDX.RightShoulder] = -0.02;
  arr[BONE_IDX.RightUpperArm] = -0.055;
  arr[BONE_IDX.RightForeArm] = -0.085;
  arr[BONE_IDX.RightHand] = -0.115;
  arr[BONE_IDX.LeftUpLeg] = -0.015;
  arr[BONE_IDX.LeftLeg] = -0.045;
  arr[BONE_IDX.LeftFoot] = -0.065;
  arr[BONE_IDX.LeftToe] = -0.075;
  arr[BONE_IDX.RightUpLeg] = -0.015;
  arr[BONE_IDX.RightLeg] = -0.045;
  arr[BONE_IDX.RightFoot] = -0.065;
  arr[BONE_IDX.RightToe] = -0.075;
  return arr;
})();

const MIRROR_BONE_PAIRS = [
  [BONE_IDX.LeftShoulder, BONE_IDX.RightShoulder],
  [BONE_IDX.LeftUpperArm, BONE_IDX.RightUpperArm],
  [BONE_IDX.LeftForeArm, BONE_IDX.RightForeArm],
  [BONE_IDX.LeftForeArmTwist, BONE_IDX.RightForeArmTwist],
  [BONE_IDX.LeftHand, BONE_IDX.RightHand],
  [BONE_IDX.LeftUpLeg, BONE_IDX.RightUpLeg],
  [BONE_IDX.LeftLeg, BONE_IDX.RightLeg],
  [BONE_IDX.LeftFoot, BONE_IDX.RightFoot],
  [BONE_IDX.LeftToe, BONE_IDX.RightToe],
];

const CENTER_BONES = [
  BONE_IDX.Hips,
  BONE_IDX.Spine,
  BONE_IDX.Chest,
  BONE_IDX.Neck,
  BONE_IDX.Head,
];

export const DEFAULT_INBETWEEN_OPTIONS = {
  fps: 60,
  mode: 'ai_smart', // 'ai_smart' | 'linear' | 'stepped'
  splineTension: 0.18, // 0 = full C1 Squad, 1 = piecewise slerp
  kineticChainLag: 0.85, // 0..1.4 biomechanical whip strength
  anticipationSink: 0.65, // 0..1.2 martial stance sink / aerial boost
  ikFootLock: 0.88, // 0..1 Two-Bone IK ground lock blend
  hasWeapon: true,
  cyclic: false,
  antiPenetration: true,
};

let _kfSeqCounter = 1;

export function createNeutralKeyframe(overrides = {}) {
  const rootPos = new THREE.Vector3(0, 0.94, 0);
  if (overrides.rootPos) {
    sanitizeVec3(rootPos, overrides.rootPos, 0.94);
  }
  const quats = Array.from({ length: NUM_BONES }, (_, idx) => {
    const q = new THREE.Quaternion();
    if (overrides.quats?.[idx]) {
      sanitizeUnitQuat(q, overrides.quats[idx]);
    }
    return q;
  });

  return {
    id: overrides.id || `kf_${_kfSeqCounter++}`,
    label: overrides.label || `关键帧 ${_kfSeqCounter - 1}`,
    durationToNext: THREE.MathUtils.clamp(Number(overrides.durationToNext) || 0.38, 0.08, 3.0),
    holdSec: THREE.MathUtils.clamp(Number(overrides.holdSec) || 0, 0, 0.6),
    spinTurns: THREE.MathUtils.clamp(Math.round(Number(overrides.spinTurns) || 0), -3, 3),
    easing: ['wuxia_snap', 'charge_slash', 'smooth', 'linear'].includes(overrides.easing)
      ? overrides.easing
      : 'wuxia_snap',
    sourceTimeSec:
      overrides.sourceTimeSec !== null &&
      overrides.sourceTimeSec !== undefined &&
      Number.isFinite(Number(overrides.sourceTimeSec))
        ? Number(overrides.sourceTimeSec)
        : null,
    thumbnailDataUrl: typeof overrides.thumbnailDataUrl === 'string' ? overrides.thumbnailDataUrl : null,
    rootPos,
    quats,
  };
}

export function cloneKeyframe(kf, overrides = {}) {
  return createNeutralKeyframe({
    ...kf,
    id: overrides.id || `kf_${_kfSeqCounter++}`,
    label: overrides.label ?? kf?.label ?? '关键帧副本',
    rootPos: kf?.rootPos ? kf.rootPos.clone() : new THREE.Vector3(0, 0.94, 0),
    quats: Array.isArray(kf?.quats) ? kf.quats.map((q) => q.clone()) : undefined,
    ...overrides,
  });
}

const _tmpEuler = new THREE.Euler(0, 0, 0, 'ZXY');

export function getBoneLocalEulerDeg(kf, boneIdx) {
  const safeIdx = THREE.MathUtils.clamp(Math.trunc(Number(boneIdx) || 0), 0, NUM_BONES - 1);
  const q = sanitizeUnitQuat(new THREE.Quaternion(), kf?.quats?.[safeIdx]);
  _tmpEuler.setFromQuaternion(q, 'ZXY');
  return {
    x: +(_tmpEuler.x * RAD2DEG).toFixed(1),
    y: +(_tmpEuler.y * RAD2DEG).toFixed(1),
    z: +(_tmpEuler.z * RAD2DEG).toFixed(1),
  };
}

export function setBoneLocalEulerDeg(kf, boneIdx, xDeg, yDeg, zDeg) {
  if (!kf || !Array.isArray(kf.quats)) return kf;
  const safeIdx = THREE.MathUtils.clamp(Math.trunc(Number(boneIdx) || 0), 0, NUM_BONES - 1);
  const rx = (Number.isFinite(Number(xDeg)) ? Number(xDeg) : 0) * DEG2RAD;
  const ry = (Number.isFinite(Number(yDeg)) ? Number(yDeg) : 0) * DEG2RAD;
  const rz = (Number.isFinite(Number(zDeg)) ? Number(zDeg) : 0) * DEG2RAD;
  _tmpEuler.set(rx, ry, rz, 'ZXY');
  if (!kf.quats[safeIdx]) kf.quats[safeIdx] = new THREE.Quaternion();
  kf.quats[safeIdx].setFromEuler(_tmpEuler).normalize();
  return kf;
}

/**
 * Mirrors a keyframe left <-> right across the sagittal YZ plane (`x -> -x`).
 * Reflection of rotation vector `(rx, ry, rz)` across YZ plane negates `ry` and `rz` (`(-x, y, z, -w)` -> `(x, -y, -z, w)`).
 */
export function mirrorKeyframePoseLR(kf) {
  if (!kf || !Array.isArray(kf.quats)) return kf;
  kf.rootPos.x = -kf.rootPos.x;
  kf.spinTurns = -(kf.spinTurns || 0);

  const reflectQuatX = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w).normalize();

  for (const idx of CENTER_BONES) {
    kf.quats[idx].copy(reflectQuatX(kf.quats[idx]));
  }
  for (const [lIdx, rIdx] of MIRROR_BONE_PAIRS) {
    const newL = reflectQuatX(kf.quats[rIdx]);
    const newR = reflectQuatX(kf.quats[lIdx]);
    kf.quats[lIdx].copy(newL);
    kf.quats[rIdx].copy(newR);
  }
  return kf;
}

/**
 * Adjusts `kf.rootPos.y` so the lowest foot/toe rests cleanly on `floorY` (default `0.08m` ankle height).
 */
export function snapKeyframeFeetToFloor(kf, floorY = 0.08) {
  if (!kf) return kf;
  const { bones } = createBoneHierarchy();
  bones[0].position.copy(kf.rootPos);
  for (let b = 0; b < NUM_BONES; b++) {
    if (kf.quats[b]) bones[b].quaternion.copy(kf.quats[b]);
  }
  bones[0].updateWorldMatrix(true, true);

  const p = new THREE.Vector3();
  let minAnkleY = Infinity;
  for (const bIdx of [BONE_IDX.LeftFoot, BONE_IDX.RightFoot]) {
    bones[bIdx].getWorldPosition(p);
    minAnkleY = Math.min(minAnkleY, p.y);
  }
  if (Number.isFinite(minAnkleY)) {
    kf.rootPos.y = THREE.MathUtils.clamp(kf.rootPos.y + (floorY - minAnkleY), 0.35, 2.2);
  }
  return kf;
}

// --- Pure Math Helpers on SO(3) for Shoemake SQUAD Splines ---

function quatLog(q, outVec3) {
  const vx = q.x;
  const vy = q.y;
  const vz = q.z;
  const w = THREE.MathUtils.clamp(q.w, -1, 1);
  const sinHalf = Math.hypot(vx, vy, vz);
  if (sinHalf < 1e-8) {
    return outVec3.set(0, 0, 0);
  }
  const theta = Math.atan2(sinHalf, w);
  const scale = theta / sinHalf;
  return outVec3.set(vx * scale, vy * scale, vz * scale);
}

function quatExp(vec3, outQuat) {
  const theta = vec3.length();
  if (theta < 1e-8) {
    return outQuat.set(0, 0, 0, 1);
  }
  const s = Math.sin(theta) / theta;
  return outQuat.set(vec3.x * s, vec3.y * s, vec3.z * s, Math.cos(theta)).normalize();
}

function computeSquadControlQuat(qPrev, qCurr, qNext, tension = 0.18) {
  const qInv = qCurr.clone().invert();
  const relNext = qInv.clone().multiply(qNext);
  if (relNext.w < 0) relNext.set(-relNext.x, -relNext.y, -relNext.z, -relNext.w);
  const relPrev = qInv.clone().multiply(qPrev);
  if (relPrev.w < 0) relPrev.set(-relPrev.x, -relPrev.y, -relPrev.z, -relPrev.w);

  const logNext = quatLog(relNext, new THREE.Vector3());
  const logPrev = quatLog(relPrev, new THREE.Vector3());

  // Auto-clamp tangent at sharp pose reversals (when prev & next lie on the same side of qCurr)
  let clampScale = 1 - THREE.MathUtils.clamp(tension, 0, 1);
  const lenPrev = logPrev.length();
  const lenNext = logNext.length();
  if (lenPrev > 1e-5 && lenNext > 1e-5) {
    const cosTurn = logPrev.dot(logNext) / (lenPrev * lenNext);
    if (cosTurn > 0) {
      clampScale *= 1 - cosTurn * 0.85;
    }
  }

  const sum = logNext.add(logPrev).multiplyScalar(-0.25 * clampScale);
  sum.clampLength(0, 0.35);
  const expTerm = quatExp(sum, new THREE.Quaternion());
  const ctrl = sanitizeUnitQuat(new THREE.Quaternion(), qCurr.clone().multiply(expTerm));
  if (ctrl.dot(qCurr) < 0) ctrl.set(-ctrl.x, -ctrl.y, -ctrl.z, -ctrl.w);
  return ctrl;
}

function evalSquad(q0, q1, a0, a1, u, outQuat) {
  const uc = THREE.MathUtils.clamp(u, 0, 1);
  const q1Aligned = q0.dot(q1) < 0 ? new THREE.Quaternion(-q1.x, -q1.y, -q1.z, -q1.w) : q1;
  let a0Safe = a0.dot(q0) < 0 ? new THREE.Quaternion(-a0.x, -a0.y, -a0.z, -a0.w) : a0;
  let a1Safe = a1.dot(q1Aligned) < 0 ? new THREE.Quaternion(-a1.x, -a1.y, -a1.z, -a1.w) : a1;

  // Prevent wide-angle antipodal tangent branch flip mid-segment
  if (a0Safe.dot(a1Safe) < 0.2) {
    a0Safe = q0;
    a1Safe = q1Aligned;
  }

  const slerpP = q0.clone().slerp(q1Aligned, uc);
  const slerpA = a0Safe.clone().slerp(a1Safe, uc);
  return sanitizeUnitQuat(outQuat, slerpP.slerp(slerpA, 2 * uc * (1 - uc)));
}

function evalCatmullRomScalar(p0, p1, p2, p3, u, alpha = 0.5) {
  const t = THREE.MathUtils.clamp(u, 0, 1);
  const m1 = (1 - alpha) * 0.5 * (p2 - p0);
  const m2 = (1 - alpha) * 0.5 * (p3 - p1);
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p1 +
    (t3 - 2 * t2 + t) * m1 +
    (-2 * t3 + 3 * t2) * p2 +
    (t3 - t2) * m2
  );
}

/**
 * Non-linear martial arts segment timing warp s(u): [0, 1] -> [0, 1]
 */
export function remapSegmentMartialTiming(u, easing = 'wuxia_snap') {
  const x = THREE.MathUtils.clamp(Number(u) || 0, 0, 1);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (easing === 'linear') return x;
  if (easing === 'smooth') {
    return x * x * (3 - 2 * x);
  }
  if (easing === 'charge_slash') {
    // C-infinity smooth asymmetric Beta-like S-curve: deliberate coil -> crisp strike -> smooth settle (peak slope ~2.05)
    const a = Math.pow(x, 2.25);
    const b = Math.pow(1 - x, 1.45);
    return a / (a + b);
  }
  // Default 'wuxia_snap': smooth coil -> brisk whip -> clean settle (peak slope ~1.75)
  const a = Math.pow(x, 1.65);
  const b = Math.pow(1 - x, 1.55);
  return a / (a + b);
}

function enforceSwordBodyClearanceInPlace(frames) {
  const { bones } = createBoneHierarchy();
  const handPos = new THREE.Vector3();
  const chestPos = new THREE.Vector3();
  const headPos = new THREE.Vector3();
  const qHandW = new THREE.Quaternion();
  const bladeDir = new THREE.Vector3();
  const closestPt = new THREE.Vector3();
  const pushAxis = new THREE.Vector3();
  const qDeflect = new THREE.Quaternion();

  for (const fr of frames) {
    bones[0].position.copy(fr.rootPos);
    for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(fr.quats[b]);
    bones[0].updateWorldMatrix(true, true);

    bones[BONE_IDX.RightHand].getWorldPosition(handPos);
    bones[BONE_IDX.RightHand].getWorldQuaternion(qHandW);
    bones[BONE_IDX.Chest].getWorldPosition(chestPos);
    bones[BONE_IDX.Head].getWorldPosition(headPos);

    bladeDir.copy(BLADE_LOCAL_DIR).applyQuaternion(qHandW).normalize();

    for (const [center, radius] of [
      [chestPos, 0.19],
      [headPos, 0.17],
    ]) {
      const toCenter = center.clone().sub(handPos);
      const tProj = THREE.MathUtils.clamp(toCenter.dot(bladeDir), 0.08, 0.92);
      closestPt.copy(handPos).addScaledVector(bladeDir, tProj);
      const dist = closestPt.distanceTo(center);
      if (dist < radius && dist > 1e-5) {
        const outNormal = closestPt.clone().sub(center).divideScalar(dist);
        pushAxis.crossVectors(bladeDir, outNormal);
        if (pushAxis.lengthSq() > 1e-6) {
          pushAxis.normalize();
          const angle = Math.min(0.65, ((radius - dist) / Math.max(0.18, tProj)) * 1.15);
          qDeflect.setFromAxisAngle(pushAxis, angle);
          qHandW.premultiply(qDeflect).normalize();
          const qParentInv = new THREE.Quaternion();
          bones[BONE_IDX.RightHand].parent.getWorldQuaternion(qParentInv).invert();
          fr.quats[BONE_IDX.RightHand].multiplyQuaternions(qParentInv, qHandW).normalize();
          bones[BONE_IDX.RightHand].quaternion.copy(fr.quats[BONE_IDX.RightHand]);
          bones[BONE_IDX.RightHand].updateWorldMatrix(true, false);
          bladeDir.copy(BLADE_LOCAL_DIR).applyQuaternion(qHandW).normalize();
        }
      }
    }
  }
}

function computeSmoothnessMetrics(frames, fps = 60, cyclic = false) {
  if (!frames || frames.length < 2) {
    return {
      totalFrames: frames?.length || 0,
      durationSec: 0,
      maxJumpDeg: 0,
      meanVelDegPerSec: 0,
      slipRmsCmS: 0,
      jitterRms: 0,
      grade: 'S',
      gradeLabel: 'S级 · 丝滑连贯',
    };
  }

  const checkBones = [
    BONE_IDX.Hips,
    BONE_IDX.Spine,
    BONE_IDX.Chest,
    BONE_IDX.Head,
    BONE_IDX.LeftUpperArm,
    BONE_IDX.LeftForeArm,
    BONE_IDX.RightUpperArm,
    BONE_IDX.RightForeArm,
    BONE_IDX.LeftUpLeg,
    BONE_IDX.LeftLeg,
    BONE_IDX.RightUpLeg,
    BONE_IDX.RightLeg,
  ];

  let maxJumpDeg = 0;
  let sumJumpDeg = 0;
  let pairs = 0;
  for (let i = 1; i < frames.length; i++) {
    let frameMax = 0;
    for (const b of checkBones) {
      const d = Math.min(1, Math.abs(frames[i - 1].quats[b].dot(frames[i].quats[b])));
      const deg = 2 * Math.acos(d) * RAD2DEG;
      if (deg > maxJumpDeg) maxJumpDeg = deg;
      if (deg > frameMax) frameMax = deg;
    }
    sumJumpDeg += frameMax;
    pairs++;
  }

  const tel = analyzeMotionTelemetry(frames, fps, cyclic);
  const slipRmsCmS = +Number(tel.rmsSlipCmS || 0).toFixed(1);
  const jitterRms = +Number(tel.rmsJitter || 0).toFixed(3);
  const roundedJump = +maxJumpDeg.toFixed(1);

  let grade = 'S';
  let gradeLabel = 'S级 · 行云流水';
  if (roundedJump > 42 || slipRmsCmS > 18) {
    grade = 'B';
    gradeLabel = 'B级 · 建议拉长过渡时长';
  } else if (roundedJump > 26 || slipRmsCmS > 10) {
    grade = 'A';
    gradeLabel = 'A级 · 劲道干脆';
  }

  return {
    totalFrames: frames.length,
    durationSec: +((frames.length - 1) / fps).toFixed(2),
    maxJumpDeg: roundedJump,
    meanVelDegPerSec: +((sumJumpDeg / Math.max(1, pairs)) * fps).toFixed(0),
    slipRmsCmS,
    jitterRms,
    grade,
    gradeLabel,
    slipSeries: Array.from(tel.slipSeries || []),
    jitterSeries: Array.from(tel.jitterSeries || []),
  };
}

/**
 * Core AI Smart Keyframe In-Betweener:
 * Synthesizes a 60fps 29-bone clip from 2+ stop-motion keyframes, returning:
 * - `cleanFrames`: AI smart in-betweened + Two-Bone IK foot-locked + anti-penetration 60fps frames
 * - `linearFrames`: Naive piecewise linear slerp frames (for comparison)
 * - `steppedFrames`: Pure stop-motion hold frames (for stop-motion vs AI comparison)
 * - `keyframeFrameIndices`: Exact frame index `[0..totalFrames-1]` where each keyframe lands
 * - `metrics`: Completeness & smoothness verification report
 */
export function synthesizeKeyframeClip(rawKeyframes = [], rawOptions = {}) {
  const opts = { ...DEFAULT_INBETWEEN_OPTIONS, ...(rawOptions || {}) };
  const fps = THREE.MathUtils.clamp(Math.round(Number(opts.fps) || 60), 24, 120);
  const cyclic = Boolean(opts.cyclic);

  const kfs = (Array.isArray(rawKeyframes) && rawKeyframes.length > 0
    ? rawKeyframes
    : [createNeutralKeyframe({ label: '起始定势' })]
  ).map((k, idx) =>
    createNeutralKeyframe({
      ...k,
      id: k.id || `kf_${idx + 1}`,
      label: k.label || `关键帧 #${idx + 1}`,
    })
  );

  if (kfs.length === 1) {
    const single = kfs[0];
    const frames = Array.from({ length: 30 }, () => ({
      rootPos: single.rootPos.clone(),
      quats: single.quats.map((q) => q.clone()),
      contactL: true,
      contactR: true,
    }));
    const clip = {
      id: opts.clipId || 'keyframe_synth',
      name: opts.clipName || '定格关键帧合成招式',
      fps,
      totalFrames: frames.length,
      duration: (frames.length - 1) / fps,
      nonCyclic: !cyclic,
      preserveRootMotion: true,
      hasWeapon: Boolean(opts.hasWeapon),
      isCombatAttack: true,
      originKind: 'keyframe_synth',
      frames,
    };
    return {
      clip,
      cleanFrames: frames,
      linearFrames: frames.map((f) => ({
        rootPos: f.rootPos.clone(),
        quats: f.quats.map((q) => q.clone()),
      })),
      steppedFrames: frames.map((f) => ({
        rootPos: f.rootPos.clone(),
        quats: f.quats.map((q) => q.clone()),
      })),
      keyframeFrameIndices: [0],
      metrics: computeSmoothnessMetrics(frames, fps, cyclic),
    };
  }

  // Ensure consistent quaternion hemisphere across consecutive keyframes per bone
  const alignedQuats = kfs.map((kf) => kf.quats.map((q) => sanitizeUnitQuat(new THREE.Quaternion(), q)));
  const K = kfs.length;
  for (let i = 1; i < K; i++) {
    for (let b = 0; b < NUM_BONES; b++) {
      if (alignedQuats[i][b].dot(alignedQuats[i - 1][b]) < 0) {
        const q = alignedQuats[i][b];
        q.set(-q.x, -q.y, -q.z, -q.w);
      }
    }
  }

  // Precompute Shoemake SQUAD tangent control quaternions per keyframe & bone
  const tension = THREE.MathUtils.clamp(Number(opts.splineTension) || 0.18, 0, 1);
  const squadTangents = Array.from({ length: K }, (_, i) => {
    const iPrev = cyclic ? (i - 1 + K) % K : Math.max(0, i - 1);
    const iNext = cyclic ? (i + 1) % K : Math.min(K - 1, i + 1);
    return Array.from({ length: NUM_BONES }, (__, b) => {
      if (!cyclic && (i === 0 || i === K - 1)) {
        return alignedQuats[i][b].clone();
      }
      return computeSquadControlQuat(
        alignedQuats[iPrev][b],
        alignedQuats[i][b],
        alignedQuats[iNext][b],
        tension
      );
    });
  });

  const segmentCount = cyclic ? K : K - 1;
  const aiRawFrames = [];
  const linearFrames = [];
  const steppedFrames = [];
  const keyframeFrameIndices = [];

  const lagStrength = THREE.MathUtils.clamp(Number(opts.kineticChainLag) ?? 0.85, 0, 1.4);
  const sinkStrength = THREE.MathUtils.clamp(Number(opts.anticipationSink) ?? 0.65, 0, 1.2);
  const qSpin = new THREE.Quaternion();

  for (let seg = 0; seg < segmentCount; seg++) {
    const i0 = seg;
    const i1 = (seg + 1) % K;
    const iPrev = cyclic ? (seg - 1 + K) % K : Math.max(0, seg - 1);
    const iNext = cyclic ? (seg + 2) % K : Math.min(K - 1, seg + 2);

    const kf0 = kfs[i0];
    const kf1 = kfs[i1];
    keyframeFrameIndices.push(aiRawFrames.length);

    // Optional pose hold (hitstop / dramatic freeze) on kf0
    const holdFrames = seg === 0 ? 0 : Math.round(kf0.holdSec * fps);
    for (let h = 0; h < holdFrames; h++) {
      aiRawFrames.push({
        rootPos: kf0.rootPos.clone(),
        quats: alignedQuats[i0].map((q) => q.clone()),
        contactL: null,
        contactR: null,
      });
      linearFrames.push({
        rootPos: kf0.rootPos.clone(),
        quats: alignedQuats[i0].map((q) => q.clone()),
      });
      steppedFrames.push({
        rootPos: kf0.rootPos.clone(),
        quats: alignedQuats[i0].map((q) => q.clone()),
      });
    }

    const spanFrames = Math.max(3, Math.round(kf0.durationToNext * fps));
    const isLastSeg = seg === segmentCount - 1 && !cyclic;
    const sampleLimit = isLastSeg ? spanFrames : spanFrames - 1;

    // Estimate rotational magnitude of this transition to scale anticipation knee-sink
    const hipsArcRad =
      2 * Math.acos(Math.min(1, Math.abs(alignedQuats[i0][BONE_IDX.Hips].dot(alignedQuats[i1][BONE_IDX.Hips])))) +
      Math.abs(kf0.spinTurns) * Math.PI * 2;
    const chestArcRad =
      2 * Math.acos(Math.min(1, Math.abs(alignedQuats[i0][BONE_IDX.Chest].dot(alignedQuats[i1][BONE_IDX.Chest]))));
    const motionIntensity = THREE.MathUtils.clamp((hipsArcRad + chestArcRad) / 2.2, 0, 1);

    const isAerialSeg =
      kf0.rootPos.y > 1.04 || kf1.rootPos.y > 1.04 || Math.abs(kf0.spinTurns) >= 1;

    for (let s = 0; s <= sampleLimit; s++) {
      const uRaw = s / spanFrames;
      const uTimed = remapSegmentMartialTiming(uRaw, kf0.easing);

      // 1. Stepped stop-motion frame
      const stepSrc = uRaw < 0.999 ? i0 : i1;
      steppedFrames.push({
        rootPos: kfs[stepSrc].rootPos.clone(),
        quats: alignedQuats[stepSrc].map((q) => q.clone()),
      });

      // 2. Naive linear frame
      const linRoot = kf0.rootPos.clone().lerp(kf1.rootPos, uRaw);
      const linQuats = Array.from({ length: NUM_BONES }, (_, b) =>
        sanitizeUnitQuat(new THREE.Quaternion(), alignedQuats[i0][b].clone().slerp(alignedQuats[i1][b], uRaw))
      );
      linearFrames.push({ rootPos: linRoot, quats: linQuats });

      // 3. AI Smart Wuxia In-betweened frame
      const rx = evalCatmullRomScalar(
        kfs[iPrev].rootPos.x,
        kf0.rootPos.x,
        kf1.rootPos.x,
        kfs[iNext].rootPos.x,
        uTimed,
        0.45
      );
      const rz = evalCatmullRomScalar(
        kfs[iPrev].rootPos.z,
        kf0.rootPos.z,
        kf1.rootPos.z,
        kfs[iNext].rootPos.z,
        uTimed,
        0.45
      );
      let ry = THREE.MathUtils.lerp(kf0.rootPos.y, kf1.rootPos.y, uTimed);
      if (isAerialSeg) {
        const boost = (0.08 + 0.06 * Math.min(2, Math.abs(kf0.spinTurns))) * Math.max(0.5, sinkStrength);
        ry += 4 * uRaw * (1 - uRaw) * boost;
      } else {
        // Subtle martial stance coil dip mid-transition
        ry -= Math.sin(Math.PI * uTimed) * 0.028 * motionIntensity * sinkStrength;
      }

      const uSpin = uRaw * uRaw * (3 - 2 * uRaw);
      const aiQuats = Array.from({ length: NUM_BONES }, (_, b) => {
        const phaseShift = BONE_KINETIC_PHASE[b] * lagStrength;
        const uBone = THREE.MathUtils.clamp(uTimed + phaseShift * Math.sin(Math.PI * uTimed), 0, 1);
        const qOut = evalSquad(
          alignedQuats[i0][b],
          alignedQuats[i1][b],
          squadTangents[i0][b],
          squadTangents[i1][b],
          uBone,
          new THREE.Quaternion()
        );
        if (b === BONE_IDX.Hips && kf0.spinTurns !== 0) {
          const spinAngle = kf0.spinTurns * Math.PI * 2 * uSpin;
          qSpin.setFromAxisAngle(WORLD_UP, spinAngle);
          qOut.premultiply(qSpin).normalize();
        }
        return qOut;
      });

      aiRawFrames.push({
        rootPos: new THREE.Vector3(rx, ry, rz),
        quats: aiQuats,
        contactL: null,
        contactR: null,
      });
    }
  }

  if (!cyclic) {
    keyframeFrameIndices[K - 1] = aiRawFrames.length - 1;
  }

  // Enforce quaternion hemisphere continuity across full synthesized sequence
  for (const seq of [aiRawFrames, linearFrames]) {
    for (let i = 1; i < seq.length; i++) {
      for (let b = 0; b < NUM_BONES; b++) {
        if (seq[i].quats[b].dot(seq[i - 1].quats[b]) < 0) {
          const q = seq[i].quats[b];
          q.set(-q.x, -q.y, -q.z, -q.w);
        }
      }
    }
  }

  let cleanFrames;
  if (opts.mode === 'stepped') {
    cleanFrames = steppedFrames.map((f) => ({
      rootPos: f.rootPos.clone(),
      quats: f.quats.map((q) => q.clone()),
      contactL: false,
      contactR: false,
    }));
  } else if (opts.mode === 'linear') {
    cleanFrames = linearFrames.map((f) => ({
      rootPos: f.rootPos.clone(),
      quats: f.quats.map((q) => q.clone()),
      contactL: false,
      contactR: false,
    }));
  } else {
    // Run physics-guided Two-Bone IK foot lock + gentle smoothing + sword torso clearance
    const rawClipForClean = {
      id: opts.clipId || 'keyframe_synth',
      name: opts.clipName || '定格关键帧合成招式',
      fps,
      totalFrames: aiRawFrames.length,
      duration: Math.max(0.05, (aiRawFrames.length - 1) / fps),
      nonCyclic: !cyclic,
      preserveRootMotion: true,
      hasWeapon: Boolean(opts.hasWeapon),
      isCombatAttack: true,
      frames: aiRawFrames,
    };

    const ikBlend = THREE.MathUtils.clamp(Number(opts.ikFootLock) ?? 0.88, 0, 1);
    const cleaned = runCleaningPipeline(rawClipForClean, {
      ...DEFAULT_CLEAN_OPTIONS,
      enableSmoothing: true,
      filterRadius: 2,
      filterSigma: 1.15,
      enableFootIK: ikBlend > 0.01,
      ikBlend,
      flattenFoot: true,
      contactMode: 'auto',
      contactHeightThresh: 0.145,
      contactVelThresh: 1.05,
      loopClean: cyclic,
      stabilizeInPlace: false,
      preserveRootMotion: true,
      forearmTwistShare: 0.58,
    });
    cleanFrames = cleaned.cleanedFrames;

    if (opts.hasWeapon && opts.antiPenetration !== false) {
      enforceSwordBodyClearanceInPlace(cleanFrames);
    }
  }

  const clip = {
    id: opts.clipId || 'keyframe_synth',
    name: opts.clipName || '定格关键帧合成招式',
    fps,
    totalFrames: cleanFrames.length,
    duration: Math.max(0.05, (cleanFrames.length - 1) / fps),
    nonCyclic: !cyclic,
    preserveRootMotion: true,
    hasWeapon: Boolean(opts.hasWeapon),
    isCombatAttack: true,
    originKind: 'keyframe_synth',
    frames: cleanFrames,
  };

  const metrics = computeSmoothnessMetrics(cleanFrames, fps, cyclic);

  return {
    clip,
    cleanFrames,
    linearFrames,
    steppedFrames,
    keyframeFrameIndices,
    metrics,
  };
}

/**
 * Automatically selects `targetCount` salient keyframe indices from a captured sequence
 * (always keeping frame 0 and frame N-1, plus interior pose-inflection / angular-extremum peaks).
 */
export function selectSalientKeyframeIndices(frames = [], targetCount = 5) {
  const N = Array.isArray(frames) ? frames.length : 0;
  if (N === 0) return [];
  const want = THREE.MathUtils.clamp(Math.round(Number(targetCount) || 5), 2, Math.min(12, N));
  if (N <= want) {
    return Array.from({ length: N }, (_, i) => i);
  }

  const keyBones = [
    BONE_IDX.Hips,
    BONE_IDX.Chest,
    BONE_IDX.RightUpperArm,
    BONE_IDX.RightForeArm,
    BONE_IDX.LeftUpperArm,
    BONE_IDX.LeftUpLeg,
    BONE_IDX.RightUpLeg,
  ];

  // Score each interior frame by pose novelty vs neighbors (inflection / apex salience)
  const salience = new Float64Array(N);
  for (let i = 1; i < N - 1; i++) {
    let score = 0;
    const prev = frames[Math.max(0, i - 2)];
    const curr = frames[i];
    const next = frames[Math.min(N - 1, i + 2)];
    for (const b of keyBones) {
      const qP = prev.quats?.[b];
      const qC = curr.quats?.[b];
      const qN = next.quats?.[b];
      if (!qP || !qC || !qN) continue;
      const d1 = 2 * Math.acos(Math.min(1, Math.abs(qP.dot(qC))));
      const d2 = 2 * Math.acos(Math.min(1, Math.abs(qC.dot(qN))));
      const chord = 2 * Math.acos(Math.min(1, Math.abs(qP.dot(qN))));
      // Turning / apex bonus `(d1 + d2 - chord)` + motion energy
      score += (d1 + d2 - chord) * 1.8 + (d1 + d2) * 0.35;
    }
    score += Math.abs((curr.rootPos?.y || 0.94) - 0.94) * 1.5;
    salience[i] = score;
  }

  const chosen = [0, N - 1];
  const minGap = Math.max(2, Math.floor(N / (want * 1.45)));

  while (chosen.length < want) {
    let bestIdx = -1;
    let bestVal = -1;
    for (let i = 1; i < N - 1; i++) {
      if (chosen.some((c) => Math.abs(c - i) < minGap)) continue;
      if (salience[i] > bestVal) {
        bestVal = salience[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0) {
      // Fallback evenly spaced
      for (let i = 1; i < N - 1; i++) {
        if (!chosen.includes(i)) {
          bestIdx = i;
          break;
        }
      }
    }
    if (bestIdx < 0) break;
    chosen.push(bestIdx);
  }

  return chosen.sort((a, b) => a - b);
}
