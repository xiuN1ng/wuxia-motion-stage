import * as THREE from 'three';
import { BONE_DEFS, BONE_IDX, createBoneHierarchy } from '../rig/HumanoidRig.js';
import { solveTwoBoneLegIK, applyForearmTwistSolver } from './TwoBoneIK.js';

const NUM_BONES = BONE_DEFS.length;

export const DEFAULT_CLEAN_OPTIONS = {
  deJitter: true,
  filterRadius: 3,
  filterSigma: null,
  footLock: true,
  contactMode: 'auto', // 'auto' | 'threshold'
  contactHeightThresh: 0.155,
  contactVelThresh: 0.92,
  ikBlend: 1.0,
  floorY: 0.08,
  stanceRampRatio: 0.18,
  pelvisPullWeight: 0.85,
  keepFootFlat: true,
  loopClean: null, // null => !clip.nonCyclic
  seamRatio: 0.20,
  stabilizeInPlace: null, // null => Boolean(clip.stabilizeInPlace)
  preserveRootMotion: null, // null => Boolean(clip.preserveRootMotion)
  forearmTwistShare: 0.58,
};

export const DEFAULT_COMBAT_CURVE = {
  mode: 'auto', // 'auto' | 'off' | 'single' | 'autoMultiHit'
  windupEnd: 0.28,
  windupSpeed: 1.60,
  strikeEnd: 0.40,
  strikeSpeed: 1.80,
  hitstopFrames: 4,
  recoverySpeed: 1.00,
  bakeOnExport: true,
};

function finiteOr(val, fallback) {
  if (val === null || val === undefined || val === '' || typeof val === 'boolean') {
    return fallback;
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function sanitizeVec3(dst, src, fallbackY = 0.94) {
  if (!src) {
    return dst.set(0, fallbackY, 0);
  }
  const x = Number.isFinite(src.x) ? src.x : 0;
  const y = Number.isFinite(src.y) ? src.y : fallbackY;
  const z = Number.isFinite(src.z) ? src.z : 0;
  return dst.set(x, y, z);
}

export function sanitizeUnitQuat(dst, src) {
  if (!src || !Number.isFinite(src.x + src.y + src.z + src.w)) {
    return dst.set(0, 0, 0, 1);
  }
  const lenSq = src.x * src.x + src.y * src.y + src.z * src.z + src.w * src.w;
  if (!Number.isFinite(lenSq)) {
    const maxAbs = Math.max(Math.abs(src.x), Math.abs(src.y), Math.abs(src.z), Math.abs(src.w));
    if (maxAbs > 0 && Number.isFinite(maxAbs)) {
      return dst.set(src.x / maxAbs, src.y / maxAbs, src.z / maxAbs, src.w / maxAbs).normalize();
    }
    return dst.set(0, 0, 0, 1);
  }
  if (lenSq < 1e-12) {
    return dst.set(0, 0, 0, 1);
  }
  if (Math.abs(lenSq - 1) > 1e-6) {
    const invLen = 1 / Math.sqrt(lenSq);
    return dst.set(src.x * invLen, src.y * invLen, src.z * invLen, src.w * invLen);
  }
  return dst.set(src.x, src.y, src.z, src.w);
}

const VALID_COMBAT_MODES = new Set(['auto', 'off', 'single', 'autoMultiHit']);

export function sanitizeCombatCurveOptions(raw = {}, prev = DEFAULT_COMBAT_CURVE) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const p = prev && typeof prev === 'object' ? prev : DEFAULT_COMBAT_CURVE;

  const mode = VALID_COMBAT_MODES.has(r.mode)
    ? r.mode
    : VALID_COMBAT_MODES.has(p.mode)
      ? p.mode
      : DEFAULT_COMBAT_CURVE.mode;

  const fbWindEnd = THREE.MathUtils.clamp(
    finiteOr(p.windupEnd, DEFAULT_COMBAT_CURVE.windupEnd),
    0.02,
    0.90
  );
  const windupEnd = THREE.MathUtils.clamp(finiteOr(r.windupEnd, fbWindEnd), 0.02, 0.90);

  const fbStrikeEnd = THREE.MathUtils.clamp(
    finiteOr(p.strikeEnd, DEFAULT_COMBAT_CURVE.strikeEnd),
    0.04,
    0.98
  );
  const rawStrikeEnd = finiteOr(r.strikeEnd, fbStrikeEnd);
  const strikeEnd = THREE.MathUtils.clamp(
    Math.max(windupEnd + 0.02, rawStrikeEnd),
    windupEnd + 0.02,
    0.98
  );

  const sanitizeSpeed = (val, prevVal, defVal) => {
    const fbRaw = finiteOr(prevVal, defVal);
    const fb = fbRaw > 0 ? THREE.MathUtils.clamp(fbRaw, 0.1, 10.0) : defVal;
    const n = finiteOr(val, fb);
    return n > 0 ? THREE.MathUtils.clamp(n, 0.1, 10.0) : fb;
  };

  const windupSpeed = sanitizeSpeed(r.windupSpeed, p.windupSpeed, DEFAULT_COMBAT_CURVE.windupSpeed);
  const strikeSpeed = sanitizeSpeed(r.strikeSpeed, p.strikeSpeed, DEFAULT_COMBAT_CURVE.strikeSpeed);
  const recoverySpeed = sanitizeSpeed(
    r.recoverySpeed,
    p.recoverySpeed,
    DEFAULT_COMBAT_CURVE.recoverySpeed
  );

  const fbHitstop = Math.round(
    THREE.MathUtils.clamp(finiteOr(p.hitstopFrames, DEFAULT_COMBAT_CURVE.hitstopFrames), 0, 60)
  );
  const hitstopFrames = Math.round(
    THREE.MathUtils.clamp(finiteOr(r.hitstopFrames, fbHitstop), 0, 60)
  );

  const bakeOnExport =
    r.bakeOnExport !== undefined && r.bakeOnExport !== null
      ? Boolean(r.bakeOnExport)
      : Boolean(p.bakeOnExport ?? DEFAULT_COMBAT_CURVE.bakeOnExport);

  return {
    mode,
    windupEnd,
    windupSpeed,
    strikeEnd,
    strikeSpeed,
    hitstopFrames,
    recoverySpeed,
    bakeOnExport,
  };
}

function cloneFrame(src) {
  return {
    rootPos: src.rootPos.clone(),
    quats: src.quats.map((q) => q.clone()),
    contactL: src.contactL ?? null,
    contactR: src.contactR ?? null,
    anchorL: src.anchorL ? src.anchorL.clone() : null,
    anchorR: src.anchorR ? src.anchorR.clone() : null,
    lockWeightL: src.lockWeightL || 0,
    lockWeightR: src.lockWeightR || 0,
  };
}

function cloneSanitizedFrame(src) {
  const rootPos = new THREE.Vector3();
  sanitizeVec3(rootPos, src?.rootPos, 0.94);
  const quats = Array.from({ length: NUM_BONES }, (_, i) => {
    const q = new THREE.Quaternion();
    sanitizeUnitQuat(q, src?.quats?.[i]);
    return q;
  });
  return {
    rootPos,
    quats,
    contactL: src?.contactL ?? null,
    contactR: src?.contactR ?? null,
    anchorL: src?.anchorL ? sanitizeVec3(new THREE.Vector3(), src.anchorL, 0.08) : null,
    anchorR: src?.anchorR ? sanitizeVec3(new THREE.Vector3(), src.anchorR, 0.08) : null,
    lockWeightL: Number.isFinite(src?.lockWeightL) ? src.lockWeightL : 0,
    lockWeightR: Number.isFinite(src?.lockWeightR) ? src.lockWeightR : 0,
  };
}

// Reusable module-level scratch bone hierarchies & topological kinematic chains (<10ms re-clean)
let _ikScratchRig = null;
let _telemetryScratchRig = null;
let _twistScratchRig = null;
let _peakScratchRig = null;

function getIkScratchBones() {
  if (!_ikScratchRig) _ikScratchRig = createBoneHierarchy();
  return _ikScratchRig.bones;
}

function getTelemetryScratchBones() {
  if (!_telemetryScratchRig) _telemetryScratchRig = createBoneHierarchy();
  return _telemetryScratchRig.bones;
}

function getTwistScratchBones() {
  if (!_twistScratchRig) _twistScratchRig = createBoneHierarchy();
  return _twistScratchRig.bones;
}

function getPeakScratchBones() {
  if (!_peakScratchRig) _peakScratchRig = createBoneHierarchy();
  return _peakScratchRig.bones;
}

const LEG_CHAIN_INDICES = [
  BONE_IDX.Hips,
  BONE_IDX.LeftUpLeg,
  BONE_IDX.LeftLeg,
  BONE_IDX.LeftFoot,
  BONE_IDX.RightUpLeg,
  BONE_IDX.RightLeg,
  BONE_IDX.RightFoot,
];

const TELEMETRY_CHAIN_INDICES = [
  BONE_IDX.Hips,
  BONE_IDX.Spine,
  BONE_IDX.Chest,
  BONE_IDX.RightShoulder,
  BONE_IDX.RightUpperArm,
  BONE_IDX.RightForeArm,
  BONE_IDX.RightHand,
  BONE_IDX.LeftUpLeg,
  BONE_IDX.LeftLeg,
  BONE_IDX.LeftFoot,
  BONE_IDX.RightUpLeg,
  BONE_IDX.RightLeg,
  BONE_IDX.RightFoot,
];

const PEAK_CHAIN_INDICES = [
  BONE_IDX.Hips,
  BONE_IDX.Spine,
  BONE_IDX.Chest,
  BONE_IDX.RightShoulder,
  BONE_IDX.RightUpperArm,
  BONE_IDX.RightForeArm,
  BONE_IDX.RightHand,
  BONE_IDX.RightUpLeg,
  BONE_IDX.RightLeg,
  BONE_IDX.RightFoot,
];

function applyChainToBones(frame, bones, chainIndices) {
  bones[0].position.copy(frame.rootPos);
  bones[0].quaternion.copy(frame.quats[0]);
  bones[0].updateMatrix();
  bones[0].matrixWorld.copy(bones[0].matrix);

  for (let k = 1; k < chainIndices.length; k++) {
    const idx = chainIndices[k];
    const b = bones[idx];
    b.quaternion.copy(frame.quats[idx]);
    b.updateMatrix();
    b.matrixWorld.multiplyMatrices(b.parent.matrixWorld, b.matrix);
  }
}

/**
 * Gaussian zero-phase (forward + backward) quaternion & root filter.
 */
function filterFramesZeroPhase(frames, radius, cyclic = true, filterSigma = null, mutateInPlace = false) {
  if (!frames || frames.length === 0) return [];
  const N = frames.length;
  const r = Math.max(0, Math.round(finiteOr(radius, 3)));
  if (r <= 0 || N < 3) {
    return mutateInPlace ? frames : frames.map(cloneFrame);
  }

  const sigma =
    filterSigma !== null &&
    filterSigma !== undefined &&
    Number.isFinite(Number(filterSigma)) &&
    Number(filterSigma) > 0
      ? Math.max(1e-3, Number(filterSigma))
      : Math.max(0.85, r * 0.52);

  const K = 2 * r + 1;
  const kArr = new Int32Array(K);
  const wArr = new Float64Array(K);
  let wSum = 0;
  for (let i = 0; i < K; i++) {
    const k = i - r;
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kArr[i] = k;
    wArr[i] = w;
    wSum += w;
  }
  for (let i = 0; i < K; i++) {
    wArr[i] /= wSum;
  }

  const sampleIdx = (f, k) =>
    cyclic ? (((f + k) % N) + N) % N : Math.max(0, Math.min(N - 1, f + k));

  const mid = frames.map(cloneFrame);
  const dst = mutateInPlace ? frames : frames.map(cloneFrame);

  const runPass = (input, output) => {
    for (let f = 0; f < N; f++) {
      const out = output[f];
      let rx = 0;
      let ry = 0;
      let rz = 0;
      for (let i = 0; i < K; i++) {
        const w = wArr[i];
        const p = input[sampleIdx(f, kArr[i])].rootPos;
        rx += p.x * w;
        ry += p.y * w;
        rz += p.z * w;
      }
      out.rootPos.set(rx, ry, rz);

      const refQuats = input[f].quats;
      const outQuats = out.quats;
      for (let b = 0; b < NUM_BONES; b++) {
        const ref = refQuats[b];
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let sw = 0;
        for (let i = 0; i < K; i++) {
          const w = wArr[i];
          const q = input[sampleIdx(f, kArr[i])].quats[b];
          const sign = ref.x * q.x + ref.y * q.y + ref.z * q.z + ref.w * q.w < 0 ? -w : w;
          sx += q.x * sign;
          sy += q.y * sign;
          sz += q.z * sign;
          sw += q.w * sign;
        }
        outQuats[b].set(sx, sy, sz, sw).normalize();
      }
    }
  };

  runPass(frames, mid);
  runPass(mid, dst);
  return dst;
}

/**
 * Closes loop seam discontinuity and optionally dampens treadmill root wander.
 * When `preserveRootMotion` is true, horizontal X/Z translation is never dampened or pulled back to frame 0.
 */
function closeLoopAndStabilizeRoot(
  frames,
  stabilizeInPlace = false,
  seamRatio = 0.20,
  preserveRootMotion = false,
  mutateInPlace = false,
  cyclic = true
) {
  if (!frames || frames.length === 0) return [];
  const N = frames.length;
  const out = mutateInPlace ? frames : frames.map(cloneFrame);
  if (N < 2) return out;

  if (stabilizeInPlace && !preserveRootMotion) {
    for (let f = 0; f < N; f++) {
      out[f].rootPos.x *= 0.16;
      out[f].rootPos.z *= 0.16;
    }
  }

  const ratio = THREE.MathUtils.clamp(finiteOr(seamRatio, 0.20), 0, 0.95);
  if (ratio <= 0) return out;

  const seamWindow = Math.min(N - 1, Math.max(1, Math.round(N * ratio)));
  const first = out[0];
  const last = out[N - 1];

  const posGap = new THREE.Vector3().subVectors(first.rootPos, last.rootPos);
  if (preserveRootMotion && !cyclic) {
    posGap.x = 0;
    posGap.z = 0;
  }

  const rotGaps = new Array(NUM_BONES);
  const invLast = new THREE.Quaternion();
  for (let b = 0; b < NUM_BONES; b++) {
    invLast.copy(last.quats[b]).invert();
    const dq = new THREE.Quaternion().multiplyQuaternions(invLast, first.quats[b]);
    if (dq.w < 0) {
      dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    }
    rotGaps[b] = dq;
  }

  const idQ = new THREE.Quaternion();
  const patchQ = new THREE.Quaternion();

  for (let i = 0; i < seamWindow; i++) {
    const f = N - seamWindow + i;
    const t = (i + 1) / seamWindow;
    const alpha = t * t * (3 - 2 * t);

    out[f].rootPos.addScaledVector(posGap, alpha);
    for (let b = 0; b < NUM_BONES; b++) {
      patchQ.copy(idQ).slerp(rotGaps[b], alpha);
      out[f].quats[b].multiply(patchQ).normalize();
    }
  }

  return out;
}

const _worldUp = new THREE.Vector3(0, 1, 0);
const _yawQScratch = new THREE.Quaternion();
const _yawFwdScratch = new THREE.Vector3();

function extractFlatFootYawQuat(footBone, hipsBone) {
  footBone.getWorldQuaternion(_yawQScratch);
  _yawFwdScratch.set(0, 0, 1).applyQuaternion(_yawQScratch);
  _yawFwdScratch.y = 0;
  if (_yawFwdScratch.lengthSq() < 1e-4) {
    hipsBone.getWorldQuaternion(_yawQScratch);
    _yawFwdScratch.set(0, 0, 1).applyQuaternion(_yawQScratch);
    _yawFwdScratch.y = 0;
  }
  if (_yawFwdScratch.lengthSq() < 1e-5) {
    return new THREE.Quaternion();
  }
  _yawFwdScratch.normalize();
  const yaw = Math.atan2(_yawFwdScratch.x, _yawFwdScratch.z);
  return new THREE.Quaternion().setFromAxisAngle(_worldUp, yaw);
}

/**
 * Detects stance intervals, plants world ankle anchors at `floorY` with preserved stance toe yaw,
 * and solves Analytic Two-Bone IK with anatomical knee poles to eliminate foot skating.
 */
function lockFeetWithTwoBoneIK(frames, fps, cyclic = true, options = {}) {
  if (!frames || frames.length === 0) return [];
  const N = frames.length;
  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : 60;
  const forceThreshold = options.contactMode === 'threshold';
  const hThresh = Number.isFinite(Number(options.contactHeightThresh))
    ? Number(options.contactHeightThresh)
    : 0.155;
  const vThresh = Number.isFinite(Number(options.contactVelThresh))
    ? Number(options.contactVelThresh)
    : 0.92;
  const floorY = Number.isFinite(Number(options.floorY)) ? Number(options.floorY) : 0.08;
  const stanceRampRatio = Number.isFinite(Number(options.stanceRampRatio))
    ? THREE.MathUtils.clamp(Number(options.stanceRampRatio), 0, 0.49)
    : 0.18;
  const ikBlend = Number.isFinite(Number(options.ikBlend))
    ? THREE.MathUtils.clamp(Number(options.ikBlend), 0, 1)
    : 1.0;
  const pelvisPullWeight = Number.isFinite(Number(options.pelvisPullWeight))
    ? THREE.MathUtils.clamp(Number(options.pelvisPullWeight), 0, 1)
    : 0.85;
  const keepFootFlat = options.keepFootFlat !== undefined ? Boolean(options.keepFootFlat) : true;

  const out = frames;
  const bones = getIkScratchBones();

  const rawAnkleL = new Array(N);
  const rawAnkleR = new Array(N);
  const rawKneeL = new Array(N);
  const rawKneeR = new Array(N);
  const rawFootYawL = new Array(N);
  const rawFootYawR = new Array(N);
  const hipsUpY = new Float64Array(N);

  const tmp = new THREE.Vector3();
  const qHips = new THREE.Quaternion();

  for (let f = 0; f < N; f++) {
    applyChainToBones(out[f], bones, LEG_CHAIN_INDICES);
    bones[BONE_IDX.LeftFoot].getWorldPosition(tmp);
    rawAnkleL[f] = tmp.clone();
    bones[BONE_IDX.RightFoot].getWorldPosition(tmp);
    rawAnkleR[f] = tmp.clone();

    bones[BONE_IDX.LeftLeg].getWorldPosition(tmp);
    rawKneeL[f] = tmp.clone();
    bones[BONE_IDX.RightLeg].getWorldPosition(tmp);
    rawKneeR[f] = tmp.clone();

    rawFootYawL[f] = extractFlatFootYawQuat(bones[BONE_IDX.LeftFoot], bones[BONE_IDX.Hips]);
    rawFootYawR[f] = extractFlatFootYawQuat(bones[BONE_IDX.RightFoot], bones[BONE_IDX.Hips]);

    bones[BONE_IDX.Hips].getWorldQuaternion(qHips);
    tmp.set(0, 1, 0).applyQuaternion(qHips);
    hipsUpY[f] = tmp.y;
  }

  for (let f = 0; f < N; f++) {
    const refIdx = cyclic ? (f - 1 + N) % N : f > 0 ? f - 1 : Math.min(1, N - 1);
    if (forceThreshold || out[f].contactL === null || out[f].contactL === undefined) {
      const spdL = rawAnkleL[f].distanceTo(rawAnkleL[refIdx]) * safeFps;
      out[f].contactL = hipsUpY[f] > 0.35 && rawAnkleL[f].y < hThresh && spdL < vThresh;
    }
    if (forceThreshold || out[f].contactR === null || out[f].contactR === undefined) {
      const spdR = rawAnkleR[f].distanceTo(rawAnkleR[refIdx]) * safeFps;
      out[f].contactR = hipsUpY[f] > 0.35 && rawAnkleR[f].y < hThresh && spdR < vThresh;
    }
  }

  const buildStanceTargets = (isLeft) => {
    const rawPts = isLeft ? rawAnkleL : rawAnkleR;
    const rawYaws = isLeft ? rawFootYawL : rawFootYawR;
    const flags = out.map((fr) => Boolean(isLeft ? fr.contactL : fr.contactR));
    const allLocked = flags.length > 0 && flags.every(Boolean);

    const anchors = new Array(N).fill(null);
    const yawQuats = new Array(N).fill(null);
    const weights = new Float32Array(N);

    if (allLocked) {
      const avg = new THREE.Vector3();
      const avgFwd = new THREE.Vector3();
      const fTmp = new THREE.Vector3();
      rawPts.forEach((p, idx) => {
        avg.add(p);
        fTmp.set(0, 0, 1).applyQuaternion(rawYaws[idx]);
        avgFwd.add(fTmp);
      });
      avg.divideScalar(N);
      avg.y = floorY;
      const meanYaw = avgFwd.lengthSq() > 1e-5 ? Math.atan2(avgFwd.x, avgFwd.z) : 0;
      const meanYawQ = new THREE.Quaternion().setFromAxisAngle(_worldUp, meanYaw);
      for (let f = 0; f < N; f++) {
        anchors[f] = avg.clone();
        yawQuats[f] = meanYawQ.clone();
        weights[f] = 1.0;
      }
      return { anchors, yawQuats, weights };
    }

    let startOffset = 0;
    if (cyclic) {
      while (startOffset < N && flags[startOffset]) {
        startOffset++;
      }
    }

    let step = 0;
    while (step < N) {
      const idx = (startOffset + step) % N;
      if (!flags[idx]) {
        step++;
        continue;
      }
      let segEndStep = step;
      while (segEndStep + 1 < N && flags[(startOffset + segEndStep + 1) % N]) {
        segEndStep++;
      }
      const segLen = segEndStep - step + 1;
      const midIdx = (startOffset + Math.floor((step + segEndStep) * 0.5)) % N;
      const planted = new THREE.Vector3(rawPts[midIdx].x, floorY, rawPts[midIdx].z);
      const plantedYaw = rawYaws[midIdx].clone();
      const ramp =
        stanceRampRatio <= 0
          ? 0
          : Math.min(Math.max(1, Math.floor(segLen * 0.5)), Math.max(1, Math.round(segLen * stanceRampRatio)));

      for (let s = step; s <= segEndStep; s++) {
        const k = (startOffset + s) % N;
        anchors[k] = planted.clone();
        yawQuats[k] = plantedYaw.clone();
        if (ramp <= 0) {
          weights[k] = 1.0;
        } else {
          const inW = Math.min(1, (s - step + 1) / ramp);
          const outW = Math.min(1, (segEndStep - s + 1) / ramp);
          weights[k] = THREE.MathUtils.smoothstep(Math.min(inW, outW), 0, 1);
        }
      }
      step = segEndStep + 1;
    }
    return { anchors, yawQuats, weights };
  };

  const stanceL = buildStanceTargets(true);
  const stanceR = buildStanceTargets(false);

  const blendTarget = new THREE.Vector3();
  const poleL = new THREE.Vector3();
  const poleR = new THREE.Vector3();
  const hipPos = new THREE.Vector3();
  const midLeg = new THREE.Vector3();
  const kneeDir = new THREE.Vector3();
  const toeFwd = new THREE.Vector3();
  const maxLegReach = 0.805;

  const computeAnatomicalPole = (upLegBone, rawKnee, rawAnkle, footYawQ, outPole) => {
    upLegBone.getWorldPosition(hipPos);
    midLeg.addVectors(hipPos, rawAnkle).multiplyScalar(0.5);
    kneeDir.subVectors(rawKnee, midLeg);
    toeFwd.set(0, 0, 1).applyQuaternion(footYawQ);
    kneeDir.addScaledVector(toeFwd, 0.28);
    if (kneeDir.lengthSq() < 1e-4) {
      kneeDir.copy(toeFwd);
    }
    kneeDir.normalize();
    outPole.copy(hipPos).addScaledVector(kneeDir, 0.95);
  };

  const targetL = new THREE.Vector3();
  const targetR = new THREE.Vector3();
  const origUp = new THREE.Quaternion();
  const origLo = new THREE.Quaternion();
  const origFt = new THREE.Quaternion();

  for (let f = 0; f < N; f++) {
    const fr = out[f];
    const wL = stanceL.weights[f];
    const wR = stanceR.weights[f];
    const upright = hipsUpY[f] > 0.30;

    // Store pure stance weights (unscaled by ikBlend) so telemetry evaluates identical stance intervals
    fr.lockWeightL = wL;
    fr.lockWeightR = wR;
    fr.anchorL = stanceL.anchors[f];
    fr.anchorR = stanceR.anchors[f];

    if (ikBlend <= 0) {
      continue;
    }

    targetL.copy(rawAnkleL[f]);
    if (upright) targetL.y = Math.max(floorY, targetL.y);
    if (wL > 0 && fr.anchorL) {
      blendTarget.lerpVectors(targetL, fr.anchorL, wL);
      targetL.copy(blendTarget);
    }

    targetR.copy(rawAnkleR[f]);
    if (upright) targetR.y = Math.max(floorY, targetR.y);
    if (wR > 0 && fr.anchorR) {
      blendTarget.lerpVectors(targetR, fr.anchorR, wR);
      targetR.copy(blendTarget);
    }

    applyChainToBones(fr, bones, LEG_CHAIN_INDICES);
    if (pelvisPullWeight > 0) {
      if (wL > 0.2) {
        bones[BONE_IDX.LeftUpLeg].getWorldPosition(hipPos);
        const distL = hipPos.distanceTo(targetL);
        if (distL > maxLegReach) {
          fr.rootPos.y -= (distL - maxLegReach) * pelvisPullWeight * wL * ikBlend;
          applyChainToBones(fr, bones, LEG_CHAIN_INDICES);
        }
      }
      if (wR > 0.2) {
        bones[BONE_IDX.RightUpLeg].getWorldPosition(hipPos);
        const distR = hipPos.distanceTo(targetR);
        if (distR > maxLegReach) {
          fr.rootPos.y -= (distR - maxLegReach) * pelvisPullWeight * wR * ikBlend;
          applyChainToBones(fr, bones, LEG_CHAIN_INDICES);
        }
      }
    }

    const floorPenL = upright && rawAnkleL[f].y < floorY;
    if (wL > 0.001 || floorPenL) {
      const yawQL = stanceL.yawQuats[f] || rawFootYawL[f];
      computeAnatomicalPole(bones[BONE_IDX.LeftUpLeg], rawKneeL[f], rawAnkleL[f], yawQL, poleL);

      origUp.copy(fr.quats[BONE_IDX.LeftUpLeg]);
      origLo.copy(fr.quats[BONE_IDX.LeftLeg]);
      origFt.copy(fr.quats[BONE_IDX.LeftFoot]);

      solveTwoBoneLegIK(
        bones[BONE_IDX.LeftUpLeg],
        bones[BONE_IDX.LeftLeg],
        bones[BONE_IDX.LeftFoot],
        targetL,
        poleL,
        keepFootFlat,
        yawQL
      );

      const blend = Math.max(wL, floorPenL ? 1 : 0) * ikBlend;
      fr.quats[BONE_IDX.LeftUpLeg].copy(origUp).slerp(bones[BONE_IDX.LeftUpLeg].quaternion, blend).normalize();
      fr.quats[BONE_IDX.LeftLeg].copy(origLo).slerp(bones[BONE_IDX.LeftLeg].quaternion, blend).normalize();
      fr.quats[BONE_IDX.LeftFoot].copy(origFt).slerp(bones[BONE_IDX.LeftFoot].quaternion, blend).normalize();
    }

    const floorPenR = upright && rawAnkleR[f].y < floorY;
    if (wR > 0.001 || floorPenR) {
      const yawQR = stanceR.yawQuats[f] || rawFootYawR[f];
      computeAnatomicalPole(bones[BONE_IDX.RightUpLeg], rawKneeR[f], rawAnkleR[f], yawQR, poleR);

      origUp.copy(fr.quats[BONE_IDX.RightUpLeg]);
      origLo.copy(fr.quats[BONE_IDX.RightLeg]);
      origFt.copy(fr.quats[BONE_IDX.RightFoot]);

      solveTwoBoneLegIK(
        bones[BONE_IDX.RightUpLeg],
        bones[BONE_IDX.RightLeg],
        bones[BONE_IDX.RightFoot],
        targetR,
        poleR,
        keepFootFlat,
        yawQR
      );

      const blend = Math.max(wR, floorPenR ? 1 : 0) * ikBlend;
      fr.quats[BONE_IDX.RightUpLeg].copy(origUp).slerp(bones[BONE_IDX.RightUpLeg].quaternion, blend).normalize();
      fr.quats[BONE_IDX.RightLeg].copy(origLo).slerp(bones[BONE_IDX.RightLeg].quaternion, blend).normalize();
      fr.quats[BONE_IDX.RightFoot].copy(origFt).slerp(bones[BONE_IDX.RightFoot].quaternion, blend).normalize();
    }
  }

  return out;
}

/**
 * Evaluates frame-by-frame stance foot slip speed (m/s & cm/s) and wrist/ankle jitter.
 * Supports optional `referenceFrames` so raw clips without pre-populated `contactL/R`
 * evaluate over identical stance intervals as cleaned frames, plus kinematic auto-contact fallback.
 */
export function analyzeMotionTelemetry(frames, fps, cyclic = true, referenceFrames = null) {
  if (!frames || frames.length === 0) {
    return {
      slipSeries: new Float32Array(0),
      slipSeriesCmS: new Float32Array(0),
      jitterSeries: new Float32Array(0),
      combinedError: new Float32Array(0),
      stanceLSeries: new Uint8Array(0),
      stanceRSeries: new Uint8Array(0),
      meanSlip: 0,
      maxSlip: 0,
      meanSlipCmS: 0,
      rmsSlipCmS: 0,
      maxSlipCmS: 0,
      meanJitter: 0,
      maxJitter: 0,
      rmsJitter: 0,
    };
  }

  const N = frames.length;
  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : 60;
  const bones = getTelemetryScratchBones();

  const ankleLx = new Float64Array(N);
  const ankleLy = new Float64Array(N);
  const ankleLz = new Float64Array(N);
  const ankleRx = new Float64Array(N);
  const ankleRy = new Float64Array(N);
  const ankleRz = new Float64Array(N);
  const handRx = new Float64Array(N);
  const handRy = new Float64Array(N);
  const handRz = new Float64Array(N);
  const hipsUpY = new Float64Array(N);

  const tmp = new THREE.Vector3();
  const qHips = new THREE.Quaternion();

  for (let f = 0; f < N; f++) {
    applyChainToBones(frames[f], bones, TELEMETRY_CHAIN_INDICES);
    bones[BONE_IDX.LeftFoot].getWorldPosition(tmp);
    ankleLx[f] = tmp.x;
    ankleLy[f] = tmp.y;
    ankleLz[f] = tmp.z;

    bones[BONE_IDX.RightFoot].getWorldPosition(tmp);
    ankleRx[f] = tmp.x;
    ankleRy[f] = tmp.y;
    ankleRz[f] = tmp.z;

    bones[BONE_IDX.RightHand].getWorldPosition(tmp);
    handRx[f] = tmp.x;
    handRy[f] = tmp.y;
    handRz[f] = tmp.z;

    bones[BONE_IDX.Hips].getWorldQuaternion(qHips);
    tmp.set(0, 1, 0).applyQuaternion(qHips);
    hipsUpY[f] = tmp.y;
  }

  const hasRef = Array.isArray(referenceFrames) && referenceFrames.length > 0;
  const M = hasRef ? referenceFrames.length : N;
  const mapRefIdx = (idx) =>
    M === N ? idx : Math.min(M - 1, Math.max(0, Math.round((idx / Math.max(1, N - 1)) * (M - 1))));

  const smoothLx = new Float64Array(N);
  const smoothLy = new Float64Array(N);
  const smoothLz = new Float64Array(N);
  const smoothRx = new Float64Array(N);
  const smoothRy = new Float64Array(N);
  const smoothRz = new Float64Array(N);
  const inv3 = 1 / 3;

  for (let f = 0; f < N; f++) {
    const p = cyclic ? (f - 1 + N) % N : Math.max(0, f - 1);
    const n = cyclic ? (f + 1) % N : Math.min(N - 1, f + 1);
    smoothLx[f] = (ankleLx[p] + ankleLx[f] + ankleLx[n]) * inv3;
    smoothLy[f] = (ankleLy[p] + ankleLy[f] + ankleLy[n]) * inv3;
    smoothLz[f] = (ankleLz[p] + ankleLz[f] + ankleLz[n]) * inv3;
    smoothRx[f] = (ankleRx[p] + ankleRx[f] + ankleRx[n]) * inv3;
    smoothRy[f] = (ankleRy[p] + ankleRy[f] + ankleRy[n]) * inv3;
    smoothRz[f] = (ankleRz[p] + ankleRz[f] + ankleRz[n]) * inv3;
  }

  const autoContactL = new Uint8Array(N);
  const autoContactR = new Uint8Array(N);
  for (let f = 0; f < N; f++) {
    const refPrev = cyclic ? (f - 1 + N) % N : f > 0 ? f - 1 : Math.min(1, N - 1);
    const spdL =
      Math.hypot(
        smoothLx[f] - smoothLx[refPrev],
        smoothLy[f] - smoothLy[refPrev],
        smoothLz[f] - smoothLz[refPrev]
      ) * safeFps;
    const spdR =
      Math.hypot(
        smoothRx[f] - smoothRx[refPrev],
        smoothRy[f] - smoothRy[refPrev],
        smoothRz[f] - smoothRz[refPrev]
      ) * safeFps;
    autoContactL[f] = hipsUpY[f] > 0.35 && smoothLy[f] < 0.165 && spdL < 1.15 ? 1 : 0;
    autoContactR[f] = hipsUpY[f] > 0.35 && smoothRy[f] < 0.165 && spdR < 1.15 ? 1 : 0;
  }

  const slipSeries = new Float32Array(N);
  const slipSeriesCmS = new Float32Array(N);
  const jitterSeries = new Float32Array(N);
  const combinedError = new Float32Array(N);
  const stanceLSeries = new Uint8Array(N);
  const stanceRSeries = new Uint8Array(N);

  let sumSlip = 0;
  let maxSlip = 0;
  let sumSlipCmSSq = 0;
  let sumJitter = 0;
  let maxJitter = 0;
  let sumJitterSq = 0;

  for (let f = 0; f < N; f++) {
    const prev = cyclic ? (f - 1 + N) % N : Math.max(0, f - 1);
    const next = cyclic ? (f + 1) % N : Math.min(N - 1, f + 1);

    const refCur = hasRef ? referenceFrames[mapRefIdx(f)] : frames[f];
    const refPrev = hasRef ? referenceFrames[mapRefIdx(prev)] : frames[prev];

    let plantedL;
    if ((refCur.lockWeightL || 0) > 0 || (refPrev.lockWeightL || 0) > 0) {
      plantedL = (refCur.lockWeightL || 0) > 0.92 && (refPrev.lockWeightL || 0) > 0.92;
    } else if (refCur.contactL !== null && refCur.contactL !== undefined) {
      plantedL = Boolean(refCur.contactL && refPrev.contactL);
    } else {
      plantedL = Boolean(autoContactL[f] && autoContactL[prev]);
    }

    let plantedR;
    if ((refCur.lockWeightR || 0) > 0 || (refPrev.lockWeightR || 0) > 0) {
      plantedR = (refCur.lockWeightR || 0) > 0.92 && (refPrev.lockWeightR || 0) > 0.92;
    } else if (refCur.contactR !== null && refCur.contactR !== undefined) {
      plantedR = Boolean(refCur.contactR && refPrev.contactR);
    } else {
      plantedR = Boolean(autoContactR[f] && autoContactR[prev]);
    }

    stanceLSeries[f] =
      (refCur.lockWeightL || 0) > 0.5 ||
      (refCur.contactL !== null && refCur.contactL !== undefined
        ? Boolean(refCur.contactL)
        : Boolean(autoContactL[f]))
        ? 1
        : 0;
    stanceRSeries[f] =
      (refCur.lockWeightR || 0) > 0.5 ||
      (refCur.contactR !== null && refCur.contactR !== undefined
        ? Boolean(refCur.contactR)
        : Boolean(autoContactR[f]))
        ? 1
        : 0;

    let slip = 0;
    let activeCount = 0;
    if (plantedL && prev !== f) {
      slip += Math.hypot(ankleLx[f] - ankleLx[prev], ankleLz[f] - ankleLz[prev]) * safeFps;
      activeCount++;
    }
    if (plantedR && prev !== f) {
      slip += Math.hypot(ankleRx[f] - ankleRx[prev], ankleRz[f] - ankleRz[prev]) * safeFps;
      activeCount++;
    }
    if (activeCount > 0) slip /= activeCount;

    const accHand =
      Math.hypot(
        handRx[next] + handRx[prev] - 2 * handRx[f],
        handRy[next] + handRy[prev] - 2 * handRy[f],
        handRz[next] + handRz[prev] - 2 * handRz[f]
      ) *
      safeFps *
      0.85;
    const accFoot =
      Math.hypot(
        ankleLx[next] + ankleLx[prev] - 2 * ankleLx[f],
        ankleLy[next] + ankleLy[prev] - 2 * ankleLy[f],
        ankleLz[next] + ankleLz[prev] - 2 * ankleLz[f]
      ) *
      safeFps *
      0.85;

    const jitter = N > 1 ? (accHand + accFoot) * 0.5 : 0;
    const slipCmS = slip * 100;

    slipSeries[f] = slip;
    slipSeriesCmS[f] = slipCmS;
    jitterSeries[f] = jitter;
    combinedError[f] = slip * 1.4 + jitter * 0.22;

    sumSlip += slip;
    if (slip > maxSlip) maxSlip = slip;
    sumSlipCmSSq += slipCmS * slipCmS;

    sumJitter += jitter;
    if (jitter > maxJitter) maxJitter = jitter;
    sumJitterSq += jitter * jitter;
  }

  const meanSlip = sumSlip / N;
  const meanSlipCmS = meanSlip * 100;
  const rmsSlipCmS = Math.sqrt(sumSlipCmSSq / N);
  const maxSlipCmS = maxSlip * 100;
  const meanJitter = sumJitter / N;
  const rmsJitter = Math.sqrt(sumJitterSq / N);

  return {
    slipSeries,
    slipSeriesCmS,
    jitterSeries,
    combinedError,
    stanceLSeries,
    stanceRSeries,
    meanSlip,
    maxSlip,
    meanSlipCmS,
    rmsSlipCmS,
    maxSlipCmS,
    meanJitter,
    maxJitter,
    rmsJitter,
  };
}

/**
 * Full parameterized AI Motion Cleaning Pipeline (`F7` + `F9`).
 */
export function runCleaningPipeline(clip, options = {}) {
  const rawCfg = { ...DEFAULT_CLEAN_OPTIONS, ...(options || {}) };
  const cyclic = !Boolean(clip?.nonCyclic);
  const fps = Number.isFinite(Number(clip?.fps)) && Number(clip.fps) > 0 ? Number(clip.fps) : 60;

  const preserveRootMotion =
    rawCfg.preserveRootMotion !== null && rawCfg.preserveRootMotion !== undefined
      ? Boolean(rawCfg.preserveRootMotion)
      : Boolean(clip?.preserveRootMotion);

  const loopClean =
    rawCfg.loopClean !== null && rawCfg.loopClean !== undefined
      ? Boolean(rawCfg.loopClean)
      : cyclic;

  const stabilizeInPlace = preserveRootMotion
    ? false
    : rawCfg.stabilizeInPlace !== null && rawCfg.stabilizeInPlace !== undefined
      ? Boolean(rawCfg.stabilizeInPlace)
      : Boolean(clip?.stabilizeInPlace);

  const filterRadius = THREE.MathUtils.clamp(Math.round(finiteOr(rawCfg.filterRadius, 3)), 0, 60);

  let filterSigma = null;
  if (rawCfg.filterSigma !== null && rawCfg.filterSigma !== undefined && rawCfg.filterSigma !== '') {
    const sigNum = Number(rawCfg.filterSigma);
    filterSigma = Number.isFinite(sigNum)
      ? THREE.MathUtils.clamp(sigNum, 0.1, 20.0)
      : Number(Math.max(0.85, filterRadius * 0.52).toFixed(2));
  }

  const forearmTwistShare = THREE.MathUtils.clamp(finiteOr(rawCfg.forearmTwistShare, 0.58), 0, 1);

  const appliedOptions = {
    deJitter: Boolean(rawCfg.deJitter),
    filterRadius,
    filterSigma,
    footLock: Boolean(rawCfg.footLock),
    contactMode: rawCfg.contactMode === 'threshold' ? 'threshold' : 'auto',
    contactHeightThresh: THREE.MathUtils.clamp(finiteOr(rawCfg.contactHeightThresh, 0.155), 0.005, 1.0),
    contactVelThresh: THREE.MathUtils.clamp(finiteOr(rawCfg.contactVelThresh, 0.92), 0.01, 20.0),
    ikBlend: THREE.MathUtils.clamp(finiteOr(rawCfg.ikBlend, 1.0), 0, 1),
    floorY: THREE.MathUtils.clamp(finiteOr(rawCfg.floorY, 0.08), -2.0, 2.0),
    stanceRampRatio: THREE.MathUtils.clamp(finiteOr(rawCfg.stanceRampRatio, 0.18), 0, 0.49),
    pelvisPullWeight: THREE.MathUtils.clamp(finiteOr(rawCfg.pelvisPullWeight, 0.85), 0, 1),
    keepFootFlat:
      rawCfg.keepFootFlat !== undefined && rawCfg.keepFootFlat !== null
        ? Boolean(rawCfg.keepFootFlat)
        : true,
    loopClean,
    seamRatio: THREE.MathUtils.clamp(finiteOr(rawCfg.seamRatio, 0.20), 0, 0.95),
    stabilizeInPlace,
    preserveRootMotion,
    forearmTwistShare,
  };

  const srcFrames = Array.isArray(clip?.frames) ? clip.frames : [];
  let current = srcFrames.map(cloneFrame);

  // Stage 1: Bidirectional Zero-Phase Low-Pass Filter
  if (appliedOptions.deJitter && appliedOptions.filterRadius > 0) {
    current = filterFramesZeroPhase(
      current,
      appliedOptions.filterRadius,
      cyclic && appliedOptions.loopClean,
      appliedOptions.filterSigma,
      true
    );
  }

  // Stage 2: Loop Seam + Root Stabilization (protects horizontal trajectory when preserveRootMotion is true on nonCyclic clips)
  if (appliedOptions.loopClean) {
    current = closeLoopAndStabilizeRoot(
      current,
      appliedOptions.stabilizeInPlace,
      appliedOptions.seamRatio,
      appliedOptions.preserveRootMotion,
      true,
      cyclic
    );
  }

  // Stage 3: Foot Contact Detection + Analytic Two-Bone IK Locking
  if (appliedOptions.footLock) {
    current = lockFeetWithTwoBoneIK(current, fps, cyclic, appliedOptions);
  }

  // Stage 4: Forearm Swing-Twist Roll Distribution (aux bones 8 & 13)
  if (current.length > 0) {
    const twistBones = getTwistScratchBones();
    for (let f = 0; f < current.length; f++) {
      const fr = current[f];
      twistBones[BONE_IDX.LeftHand].quaternion.copy(fr.quats[BONE_IDX.LeftHand]);
      twistBones[BONE_IDX.RightHand].quaternion.copy(fr.quats[BONE_IDX.RightHand]);
      applyForearmTwistSolver(twistBones, true, appliedOptions.forearmTwistShare);
      fr.quats[BONE_IDX.LeftForeArmTwist].copy(twistBones[BONE_IDX.LeftForeArmTwist].quaternion);
      fr.quats[BONE_IDX.RightForeArmTwist].copy(twistBones[BONE_IDX.RightForeArmTwist].quaternion);
    }
  }

  const rawTelemetry = analyzeMotionTelemetry(srcFrames, fps, cyclic, current);
  const cleanTelemetry = analyzeMotionTelemetry(current, fps, cyclic, current);

  return {
    cleanedFrames: current,
    rawTelemetry,
    cleanTelemetry,
    appliedOptions,
  };
}

const _strikePeakCache = new WeakMap();

/**
 * Pure-Node-safe FK distal strike velocity peak detector for `autoMultiHit` mode (e.g. 5-slash Yuluo).
 * Cached per `frames` array via WeakMap.
 */
export function detectStrikePeaks(frames, fps = 60) {
  if (!Array.isArray(frames) || frames.length < 6) return [];
  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : 60;

  const cached = _strikePeakCache.get(frames);
  if (cached && cached.length === frames.length && Math.abs(cached.fps - safeFps) < 1e-3) {
    return cached.peaks;
  }

  const N = frames.length;
  const bones = getPeakScratchBones();
  const handX = new Float64Array(N);
  const handY = new Float64Array(N);
  const handZ = new Float64Array(N);
  const footX = new Float64Array(N);
  const footY = new Float64Array(N);
  const footZ = new Float64Array(N);
  const tmp = new THREE.Vector3();

  for (let f = 0; f < N; f++) {
    applyChainToBones(frames[f], bones, PEAK_CHAIN_INDICES);
    bones[BONE_IDX.RightHand].getWorldPosition(tmp);
    handX[f] = tmp.x;
    handY[f] = tmp.y;
    handZ[f] = tmp.z;
    bones[BONE_IDX.RightFoot].getWorldPosition(tmp);
    footX[f] = tmp.x;
    footY[f] = tmp.y;
    footZ[f] = tmp.z;
  }

  const rawSpd = new Float32Array(N);
  for (let f = 1; f < N; f++) {
    const vHand = Math.hypot(handX[f] - handX[f - 1], handY[f] - handY[f - 1], handZ[f] - handZ[f - 1]) * safeFps;
    const vFoot = Math.hypot(footX[f] - footX[f - 1], footY[f] - footY[f - 1], footZ[f] - footZ[f - 1]) * safeFps;
    rawSpd[f] = Math.max(vHand, vFoot * 0.85);
  }
  rawSpd[0] = rawSpd[1];

  const smoothSpd = new Float32Array(N);
  for (let f = 0; f < N; f++) {
    const p = Math.max(0, f - 1);
    const n = Math.min(N - 1, f + 1);
    smoothSpd[f] = 0.25 * rawSpd[p] + 0.5 * rawSpd[f] + 0.25 * rawSpd[n];
  }

  const sorted = Array.from(smoothSpd).sort((a, b) => a - b);
  const p78 = sorted[Math.min(N - 1, Math.floor((N - 1) * 0.78))];
  const thresh = Math.max(0.8, p78);
  const minSepFrames = Math.max(3, Math.round(0.24 * safeFps));

  const candidates = [];
  for (let f = 2; f < N - 2; f++) {
    const v = smoothSpd[f];
    if (v >= thresh && v >= smoothSpd[f - 1] && v > smoothSpd[f + 1]) {
      candidates.push({ f, v });
    }
  }

  // Greedy non-maximum suppression by speed so dominant strikes win within minSepFrames
  candidates.sort((a, b) => b.v - a.v);
  const chosenFrames = [];
  for (const cand of candidates) {
    if (chosenFrames.every((cf) => Math.abs(cf - cand.f) >= minSepFrames)) {
      chosenFrames.push(cand.f);
    }
    if (chosenFrames.length >= 6) break;
  }
  chosenFrames.sort((a, b) => a - b);

  const peaks = chosenFrames.map((fPeak) => {
    const fImpact = Math.min(N - 2, fPeak + 1);
    return THREE.MathUtils.clamp(fImpact / Math.max(1, N - 1), 0.06, 0.94);
  });

  _strikePeakCache.set(frames, { length: N, fps: safeFps, peaks });
  return peaks;
}

function buildPiecewiseCombatSchedule(mode, cfg, frames, safeFps, nonCyclic) {
  const N = Array.isArray(frames) ? frames.length : 0;
  const srcSpanSec = N > 1 ? (nonCyclic ? N - 1 : N) / safeFps : 1.0;

  const s1 = THREE.MathUtils.clamp(
    Number.isFinite(Number(cfg.windupEnd)) ? Number(cfg.windupEnd) : 0.28,
    0.02,
    0.90
  );
  const rawS2 = Number.isFinite(Number(cfg.strikeEnd)) ? Number(cfg.strikeEnd) : 0.40;
  const s2 = THREE.MathUtils.clamp(Math.max(s1 + 0.02, rawS2), s1 + 0.02, 0.98);

  const kWind = THREE.MathUtils.clamp(Number(cfg.windupSpeed) > 0 ? Number(cfg.windupSpeed) : 1.60, 0.1, 10.0);
  const kStrike = THREE.MathUtils.clamp(Number(cfg.strikeSpeed) > 0 ? Number(cfg.strikeSpeed) : 1.80, 0.1, 10.0);
  const kRecov = THREE.MathUtils.clamp(
    Number(cfg.recoverySpeed) > 0 ? Number(cfg.recoverySpeed) : 1.00,
    0.1,
    10.0
  );
  const hFrames = THREE.MathUtils.clamp(
    Number.isFinite(Number(cfg.hitstopFrames)) ? Number(cfg.hitstopFrames) : 4,
    0,
    60
  );
  const hitstopSec = hFrames / safeFps;

  const segments = [];

  if (mode === 'autoMultiHit') {
    const peaks = detectStrikePeaks(frames, safeFps);
    if (peaks.length > 0) {
      let prevS = 0;
      for (const p of peaks) {
        if (p <= prevS + 0.02) continue;
        const span = p - prevS;
        const cleaveSpan = Math.min(0.10, span * 0.45);
        const cleaveStart = Math.max(prevS + 0.005, p - cleaveSpan);

        const dCoil = ((cleaveStart - prevS) * srcSpanSec) / kWind;
        if (dCoil > 1e-6) {
          segments.push({ s0: prevS, s1: cleaveStart, dur: dCoil, isHitstop: false });
        }
        const dStrike = ((p - cleaveStart) * srcSpanSec) / kStrike;
        if (dStrike > 1e-6) {
          segments.push({ s0: cleaveStart, s1: p, dur: dStrike, isHitstop: false });
        }
        if (hitstopSec > 0) {
          segments.push({ s0: p, s1: p, dur: hitstopSec, isHitstop: true });
        }
        prevS = p;
      }
      if (prevS < 1.0) {
        const dTail = ((1.0 - prevS) * srcSpanSec) / kRecov;
        segments.push({ s0: prevS, s1: 1.0, dur: Math.max(1e-6, dTail), isHitstop: false });
      }
    }
  }

  // Default / fallback 'single' mode
  if (segments.length === 0) {
    const d1 = (s1 * srcSpanSec) / kWind;
    const d2 = ((s2 - s1) * srcSpanSec) / kStrike;
    const d3 = ((1.0 - s2) * srcSpanSec) / kRecov;

    segments.push({ s0: 0, s1, dur: d1, isHitstop: false });
    segments.push({ s0: s1, s1: s2, dur: d2, isHitstop: false });
    if (hitstopSec > 0) {
      segments.push({ s0: s2, s1: s2, dur: hitstopSec, isHitstop: true });
    }
    segments.push({ s0: s2, s1: 1.0, dur: d3, isHitstop: false });
  }

  let totalDur = 0;
  for (const seg of segments) {
    seg.t0 = totalDur;
    totalDur += seg.dur;
    seg.t1 = totalDur;
  }

  return {
    segments,
    srcSpanSec,
    warpedDurationSec: Math.max(1e-5, totalDur),
  };
}

export function computeCombatWarpSchedule(clip = {}, curveOptions = {}, frames = null) {
  const cfg = { ...DEFAULT_COMBAT_CURVE, ...(curveOptions || {}) };
  const targetFrames = frames || clip?.frames || null;
  const safeFps = Number.isFinite(Number(clip?.fps)) && Number(clip.fps) > 0 ? Number(clip.fps) : 60;
  const nonCyclic = Boolean(clip?.nonCyclic);
  const N = Array.isArray(targetFrames) ? targetFrames.length : 0;
  const srcSpanSec = N > 1 ? (nonCyclic ? N - 1 : N) / safeFps : 1.0;

  let mode = cfg.mode || 'auto';
  if (mode === 'off') {
    return { mode: 'off', segments: [], srcSpanSec, warpedDurationSec: srcSpanSec };
  }
  if (mode === 'auto') {
    mode = clip?.isCombatAttack ? 'single' : 'off';
    if (mode === 'off') {
      return { mode: 'off', segments: [], srcSpanSec, warpedDurationSec: srcSpanSec };
    }
  }

  return {
    mode,
    ...buildPiecewiseCombatSchedule(mode, cfg, targetFrames, safeFps, nonCyclic),
  };
}

function evaluateScheduleAtU(schedule, uClamped) {
  if (uClamped <= 0) return { warpedU: 0, inHitstop: false };
  if (uClamped >= 1) return { warpedU: 1, inHitstop: false };

  const tau = uClamped * schedule.warpedDurationSec;
  for (let i = 0; i < schedule.segments.length; i++) {
    const seg = schedule.segments[i];
    const isLast = i === schedule.segments.length - 1;
    if (tau < seg.t1 || isLast) {
      if (seg.isHitstop) {
        return { warpedU: seg.s0, inHitstop: true };
      }
      const localT = seg.dur > 1e-8 ? THREE.MathUtils.clamp((tau - seg.t0) / seg.dur, 0, 1) : 1;
      const warpedU = THREE.MathUtils.clamp(seg.s0 + localT * (seg.s1 - seg.s0), 0, 1);
      return { warpedU, inHitstop: false };
    }
  }

  return { warpedU: 1, inHitstop: false };
}

/**
 * Stage 4: Non-linear Combat Time-Warping & Hitstop Curve (`F8`).
 * Maps uniform normalized time `u` in `[0, 1]` -> `{ warpedU, inHitstop }` with strict monotonicity.
 */
export function remapCombatTime(
  u,
  isCombatAttack,
  enabled = true,
  nonCyclic = false,
  curveOptions = {},
  frames = null,
  fps = 60
) {
  const uClamped = Number.isFinite(Number(u)) ? THREE.MathUtils.clamp(Number(u), 0, 1) : 0;
  const cfg = { ...DEFAULT_COMBAT_CURVE, ...(curveOptions || {}) };

  if (!enabled || cfg.mode === 'off') {
    return { warpedU: uClamped, inHitstop: false };
  }

  let effectiveMode = cfg.mode || 'auto';
  if (effectiveMode === 'auto') {
    if (isCombatAttack) {
      effectiveMode = 'single';
    } else if (nonCyclic) {
      return { warpedU: uClamped, inHitstop: false };
    } else {
      // Cyclic gait rhythm: clamp instead of `% 1` so warpedU(0) === 0, warpedU(1) === 1, and derivative >= 0.648 > 0
      const snappy = THREE.MathUtils.clamp(uClamped + 0.028 * Math.sin(uClamped * Math.PI * 4), 0, 1);
      return { warpedU: snappy, inHitstop: false };
    }
  }

  if (uClamped <= 0) return { warpedU: 0, inHitstop: false };
  if (uClamped >= 1) return { warpedU: 1, inHitstop: false };

  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : 60;
  const schedule = buildPiecewiseCombatSchedule(effectiveMode, cfg, frames, safeFps, Boolean(nonCyclic));
  return evaluateScheduleAtU(schedule, uClamped);
}

/**
 * Prebuilds a reusable `(u) => { warpedU, inHitstop }` remapper for 120-sample TelemetryHUD curves
 * so piecewise schedules are constructed only once per state update instead of 120x per redraw.
 */
export function createCombatTimeRemapper(clip = {}, curveOptions = {}, frames = null) {
  const cfg = { ...DEFAULT_COMBAT_CURVE, ...(curveOptions || {}) };
  const isCombatAttack = Boolean(clip?.isCombatAttack);
  const nonCyclic = Boolean(clip?.nonCyclic);
  const safeFps = Number.isFinite(Number(clip?.fps)) && Number(clip.fps) > 0 ? Number(clip.fps) : 60;
  const targetFrames = frames || clip?.frames || null;

  if (cfg.mode === 'off') {
    return (u) => {
      const uc = Number.isFinite(Number(u)) ? THREE.MathUtils.clamp(Number(u), 0, 1) : 0;
      return { warpedU: uc, inHitstop: false };
    };
  }

  let effectiveMode = cfg.mode || 'auto';
  if (effectiveMode === 'auto') {
    if (isCombatAttack) {
      effectiveMode = 'single';
    } else if (nonCyclic) {
      return (u) => {
        const uc = Number.isFinite(Number(u)) ? THREE.MathUtils.clamp(Number(u), 0, 1) : 0;
        return { warpedU: uc, inHitstop: false };
      };
    } else {
      return (u) => {
        const uc = Number.isFinite(Number(u)) ? THREE.MathUtils.clamp(Number(u), 0, 1) : 0;
        const snappy = THREE.MathUtils.clamp(uc + 0.028 * Math.sin(uc * Math.PI * 4), 0, 1);
        return { warpedU: snappy, inHitstop: false };
      };
    }
  }

  const schedule = buildPiecewiseCombatSchedule(effectiveMode, cfg, targetFrames, safeFps, nonCyclic);
  return (u) => {
    const uc = Number.isFinite(Number(u)) ? THREE.MathUtils.clamp(Number(u), 0, 1) : 0;
    return evaluateScheduleAtU(schedule, uc);
  };
}

const _sampPosA = new THREE.Vector3();
const _sampPosB = new THREE.Vector3();
const _sampQuatA = new THREE.Quaternion();
const _sampQuatB = new THREE.Quaternion();

/**
 * Interpolates between discrete frames at fractional index `frameFloat`.
 * Clamps `[0, N - 1]` when `nonCyclic === true` so final frame never wraps back to frame 0,
 * and sanitizes/normalizes both endpoint root positions & quaternions prior to `lerp`/`slerp`.
 */
export function sampleInterpolatedFrame(frames, frameFloat, outPose, nonCyclic = false) {
  if (!frames || frames.length === 0) {
    return outPose;
  }
  const N = frames.length;
  if (N === 1) {
    const only = frames[0];
    sanitizeVec3(outPose.rootPos, only?.rootPos, 0.94);
    for (let i = 0; i < NUM_BONES; i++) {
      sanitizeUnitQuat(outPose.quats[i], only?.quats?.[i]);
    }
    outPose.lockWeightL = Number.isFinite(only?.lockWeightL) ? only.lockWeightL : 0;
    outPose.lockWeightR = Number.isFinite(only?.lockWeightR) ? only.lockWeightR : 0;
    outPose.anchorL = only?.anchorL || null;
    outPose.anchorR = only?.anchorR || null;
    outPose.contactL = only?.contactL ?? null;
    outPose.contactR = only?.contactR ?? null;
    return outPose;
  }

  const safeFloat = Number.isFinite(Number(frameFloat)) ? Number(frameFloat) : 0;
  let f0;
  let f1;
  let alpha;

  if (nonCyclic) {
    const clamped = THREE.MathUtils.clamp(safeFloat, 0, N - 1);
    f0 = Math.min(N - 1, Math.floor(clamped));
    f1 = Math.min(N - 1, f0 + 1);
    alpha = clamped - f0;
  } else {
    const fl = Math.floor(safeFloat);
    f0 = ((fl % N) + N) % N;
    f1 = (f0 + 1) % N;
    alpha = safeFloat - fl;
  }

  const a = frames[f0];
  const b = frames[f1];

  sanitizeVec3(_sampPosA, a?.rootPos, 0.94);
  sanitizeVec3(_sampPosB, b?.rootPos, 0.94);
  outPose.rootPos.lerpVectors(_sampPosA, _sampPosB, alpha);

  for (let i = 0; i < NUM_BONES; i++) {
    sanitizeUnitQuat(_sampQuatA, a?.quats?.[i]);
    sanitizeUnitQuat(_sampQuatB, b?.quats?.[i]);
    outPose.quats[i].copy(_sampQuatA).slerp(_sampQuatB, alpha).normalize();
  }

  const lwAL = Number.isFinite(a?.lockWeightL) ? a.lockWeightL : 0;
  const lwBL = Number.isFinite(b?.lockWeightL) ? b.lockWeightL : 0;
  const lwAR = Number.isFinite(a?.lockWeightR) ? a.lockWeightR : 0;
  const lwBR = Number.isFinite(b?.lockWeightR) ? b.lockWeightR : 0;

  outPose.lockWeightL = THREE.MathUtils.lerp(lwAL, lwBL, alpha);
  outPose.lockWeightR = THREE.MathUtils.lerp(lwAR, lwBR, alpha);
  outPose.anchorL = a?.anchorL || b?.anchorL || null;
  outPose.anchorR = a?.anchorR || b?.anchorR || null;
  outPose.contactL = alpha < 0.5 ? (a?.contactL ?? null) : (b?.contactL ?? null);
  outPose.contactR = alpha < 0.5 ? (a?.contactR ?? null) : (b?.contactR ?? null);
  return outPose;
}

/**
 * Computes exact baked frame count in `O(1)` without cloning or slerping frame arrays.
 */
export function computeBakedFrameCount(frames, clip = {}, curveOptions = {}) {
  if (!Array.isArray(frames) || frames.length === 0) return 0;
  if (frames.length === 1) return 1;

  const cfg = { ...DEFAULT_COMBAT_CURVE, ...(curveOptions || {}) };
  if (cfg.mode === 'off') {
    return frames.length;
  }

  const effectiveMode = cfg.mode === 'auto' ? 'single' : cfg.mode;
  const effectiveCfg = { ...cfg, mode: effectiveMode };

  const safeFps = Number.isFinite(Number(clip?.fps)) && Number(clip.fps) > 0 ? Number(clip.fps) : 60;
  const nonCyclic = Boolean(clip?.nonCyclic);

  const schedule = buildPiecewiseCombatSchedule(effectiveMode, effectiveCfg, frames, safeFps, nonCyclic);
  return nonCyclic
    ? Math.max(2, Math.round(schedule.warpedDurationSec * safeFps) + 1)
    : Math.max(2, Math.round(schedule.warpedDurationSec * safeFps));
}

/**
 * Resamples `frames` through the combat time-warp & hitstop schedule via quaternion `slerp` + root `lerp`
 * so exported `.bvh` files carry baked wind-up compression and impact freeze frames at uniform `clip.fps`.
 */
export function bakeWarpedFrames(frames, clip = {}, curveOptions = {}) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  if (frames.length === 1) return [cloneSanitizedFrame(frames[0])];

  const cfg = { ...DEFAULT_COMBAT_CURVE, ...(curveOptions || {}) };
  if (cfg.mode === 'off') {
    return frames.map(cloneSanitizedFrame);
  }

  // When baking is explicitly requested, 'auto' resolves to 'single' even on custom/video clips
  const effectiveMode = cfg.mode === 'auto' ? 'single' : cfg.mode;
  const effectiveCfg = { ...cfg, mode: effectiveMode };

  const safeFps = Number.isFinite(Number(clip?.fps)) && Number(clip.fps) > 0 ? Number(clip.fps) : 60;
  const nonCyclic = Boolean(clip?.nonCyclic);

  const schedule = buildPiecewiseCombatSchedule(effectiveMode, effectiveCfg, frames, safeFps, nonCyclic);
  const outCount = nonCyclic
    ? Math.max(2, Math.round(schedule.warpedDurationSec * safeFps) + 1)
    : Math.max(2, Math.round(schedule.warpedDurationSec * safeFps));

  const span = nonCyclic ? frames.length - 1 : frames.length;
  const baked = new Array(outCount);

  for (let k = 0; k < outCount; k++) {
    const u = nonCyclic ? k / Math.max(1, outCount - 1) : k / outCount;
    const { warpedU, inHitstop } = evaluateScheduleAtU(schedule, u);
    const outFrame = {
      rootPos: new THREE.Vector3(0, 0.94, 0),
      quats: Array.from({ length: NUM_BONES }, () => new THREE.Quaternion()),
      contactL: null,
      contactR: null,
      anchorL: null,
      anchorR: null,
      lockWeightL: 0,
      lockWeightR: 0,
      inHitstop: false,
    };
    sampleInterpolatedFrame(frames, warpedU * span, outFrame, nonCyclic);
    if (outFrame.anchorL) {
      outFrame.anchorL = sanitizeVec3(new THREE.Vector3(), outFrame.anchorL, 0.08);
    }
    if (outFrame.anchorR) {
      outFrame.anchorR = sanitizeVec3(new THREE.Vector3(), outFrame.anchorR, 0.08);
    }
    outFrame.inHitstop = inHitstop;
    baked[k] = outFrame;
  }

  // Prevent high-speed (>1.0x) windup/strike compression on uncleaned raw clips from creating >0.65 rad pops
  const maxRate = Math.max(
    Number(effectiveCfg.windupSpeed) || 1,
    Number(effectiveCfg.strikeSpeed) || 1,
    Number(effectiveCfg.recoverySpeed) || 1
  );
  if (maxRate > 1.01 && outCount >= 3) {
    const maxStepRad = 0.54;
    const qMidA = new THREE.Quaternion();
    const qMidB = new THREE.Quaternion();
    const qTarget = new THREE.Quaternion();
    for (let pass = 0; pass < 8; pass++) {
      let anyClamped = false;
      for (let k = 1; k < outCount; k++) {
        if (baked[k].inHitstop || baked[k - 1].inHitstop) continue;
        for (let b = 0; b < NUM_BONES; b++) {
          const q0 = baked[k - 1].quats[b];
          const q1 = baked[k].quats[b];
          const dotRaw = q0.x * q1.x + q0.y * q1.y + q0.z * q1.z + q0.w * q1.w;
          const absDot = Math.min(1, Math.abs(dotRaw));
          const ang = 2 * Math.acos(absDot);
          if (ang > maxStepRad) {
            anyClamped = true;
            const frac = 0.52 * ((ang - maxStepRad) / ang);
            qTarget.copy(q1);
            if (dotRaw < 0) qTarget.set(-q1.x, -q1.y, -q1.z, -q1.w);
            qMidA.copy(q0).slerp(qTarget, frac).normalize();
            qMidB.copy(qTarget).slerp(q0, frac).normalize();
            q0.copy(qMidA);
            q1.copy(qMidB);
          }
        }
      }
      if (!anyClamped) break;
    }
  }

  return baked;
}
