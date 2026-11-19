import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { BONE_DEFS, BONE_IDX, createBoneHierarchy, buildCharacterRig } from '../../src/rig/HumanoidRig.js';

export const NUM_BONES = BONE_DEFS.length;
const _worldUp = new THREE.Vector3(0, 1, 0);

export function emptyFrame() {
  return {
    rootPos: new THREE.Vector3(0, 0.94, 0),
    quats: Array.from({ length: NUM_BONES }, () => new THREE.Quaternion()),
    contactL: null,
    contactR: null,
    lockWeightL: 0,
    lockWeightR: 0,
  };
}

export function cloneFrame(src) {
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

export function applyFrameToBones(frame, bones) {
  bones[0].position.copy(frame.rootPos);
  for (let i = 0; i < NUM_BONES; i++) {
    bones[i].quaternion.copy(frame.quats[i]);
  }
  bones[0].updateWorldMatrix(true, true);
}

export function percentile(values, q) {
  if (!values || !values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = THREE.MathUtils.clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return THREE.MathUtils.lerp(sorted[lo], sorted[hi], pos - lo);
}

/**
 * Closed-form Analytic Two-Bone Leg IK Solver (Hip -> Knee -> Ankle)
 * Guarantees forward knee hinge in pole plane with zero shin roll.
 */
export function solveTwoBoneLegIK(
  upLegBone,
  legBone,
  footBone,
  targetWorldPos,
  poleWorldPos,
  keepFootFlat = true,
  characterYawQuat = null
) {
  const L1 = legBone.position.length(); // 0.41m
  const L2 = footBone.position.length(); // 0.41m

  const hPos = new THREE.Vector3();
  const dVec = new THREE.Vector3();
  const uAxis = new THREE.Vector3();
  const poleVec = new THREE.Vector3();
  const fAxis = new THREE.Vector3();
  const kPos = new THREE.Vector3();
  const aPos = new THREE.Vector3();
  const xUpper = new THREE.Vector3();
  const yUpper = new THREE.Vector3();
  const zUpper = new THREE.Vector3();
  const yLower = new THREE.Vector3();
  const zLower = new THREE.Vector3();
  const basisMat = new THREE.Matrix4();
  const parentQuat = new THREE.Quaternion();
  const qWorldUpper = new THREE.Quaternion();
  const qWorldLower = new THREE.Quaternion();
  const qWorldFoot = new THREE.Quaternion();
  const invQuat = new THREE.Quaternion();

  upLegBone.parent.updateWorldMatrix(true, false);
  upLegBone.updateWorldMatrix(false, false);
  upLegBone.getWorldPosition(hPos);

  dVec.subVectors(targetWorldPos, hPos);
  const rawDist = dVec.length();
  const minDist = Math.abs(L1 - L2) + 0.015;
  const maxDist = (L1 + L2) * 0.996;
  const d = THREE.MathUtils.clamp(rawDist, minDist, maxDist);

  if (rawDist < 1e-5) {
    uAxis.set(0, -1, 0);
  } else {
    uAxis.copy(dVec).divideScalar(rawDist);
  }

  poleVec.subVectors(poleWorldPos, hPos);
  const proj = poleVec.dot(uAxis);
  fAxis.copy(poleVec).addScaledVector(uAxis, -proj);
  if (fAxis.lengthSq() < 1e-6) {
    fAxis.set(0, 0, 1);
  } else {
    fAxis.normalize();
  }

  const cosAlpha = THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

  kPos.copy(hPos).addScaledVector(uAxis, L1 * cosAlpha).addScaledVector(fAxis, L1 * sinAlpha);
  aPos.copy(hPos).addScaledVector(uAxis, d);

  yUpper.subVectors(hPos, kPos).normalize();
  xUpper.crossVectors(yUpper, fAxis);
  if (xUpper.lengthSq() < 1e-6) {
    xUpper.set(1, 0, 0);
  } else {
    xUpper.normalize();
  }
  zUpper.crossVectors(xUpper, yUpper).normalize();

  basisMat.makeBasis(xUpper, yUpper, zUpper);
  qWorldUpper.setFromRotationMatrix(basisMat);

  upLegBone.parent.getWorldQuaternion(parentQuat);
  invQuat.copy(parentQuat).invert();
  upLegBone.quaternion.multiplyQuaternions(invQuat, qWorldUpper);

  yLower.subVectors(kPos, aPos).normalize();
  zLower.crossVectors(xUpper, yLower).normalize();

  basisMat.makeBasis(xUpper, yLower, zLower);
  qWorldLower.setFromRotationMatrix(basisMat);

  invQuat.copy(qWorldUpper).invert();
  legBone.quaternion.multiplyQuaternions(invQuat, qWorldLower);

  if (keepFootFlat) {
    if (characterYawQuat) {
      qWorldFoot.copy(characterYawQuat);
    } else {
      qWorldFoot.identity();
    }
    invQuat.copy(qWorldLower).invert();
    footBone.quaternion.multiplyQuaternions(invQuat, qWorldFoot);
  }

  upLegBone.updateWorldMatrix(false, true);
}

/**
 * Swing-Twist Decomposition around local X-axis (forearm longitudinal roll axis).
 */
export function applyForearmTwistSolver(bones, enabled = true, twistShare = 0.58) {
  const share = THREE.MathUtils.clamp(
    Number.isFinite(Number(twistShare)) ? Number(twistShare) : 0.58,
    0,
    1
  );
  const idQuat = new THREE.Quaternion();
  const twistQuat = new THREE.Quaternion();
  const pairs = [
    [BONE_IDX.LeftHand, BONE_IDX.LeftForeArmTwist],
    [BONE_IDX.RightHand, BONE_IDX.RightForeArmTwist],
  ];

  for (const [handIdx, twistIdx] of pairs) {
    const twistBone = bones[twistIdx];
    if (!enabled) {
      twistBone.quaternion.identity();
      continue;
    }
    const q = bones[handIdx].quaternion;
    const len = Math.hypot(q.x, q.w);
    if (len < 1e-6) {
      twistBone.quaternion.identity();
      continue;
    }
    let tx = q.x / len;
    let tw = q.w / len;
    if (tw < 0) {
      tx = -tx;
      tw = -tw;
    }
    twistQuat.set(tx, 0, 0, tw);
    twistBone.quaternion.copy(idQuat).slerp(twistQuat, share);
  }
}

/**
 * Bidirectional zero-phase Gaussian quaternion & root filter with antipodal hemisphere alignment.
 */
export function filterFramesZeroPhase(frames, radius = 3, cyclic = true, filterSigma = null) {
  if (!frames || frames.length === 0) return [];
  const N = frames.length;
  const r = Number.isFinite(Number(radius)) ? Math.max(0, Math.round(Number(radius))) : 3;
  if (r <= 0 || N < 3) {
    return frames.map(cloneFrame);
  }

  const sigma =
    filterSigma !== null &&
    filterSigma !== undefined &&
    Number.isFinite(Number(filterSigma)) &&
    Number(filterSigma) > 0
      ? Math.max(1e-3, Number(filterSigma))
      : Math.max(0.85, r * 0.52);

  const weights = [];
  let wSum = 0;
  for (let k = -r; k <= r; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    weights.push({ k, w });
    wSum += w;
  }
  for (const item of weights) {
    item.w /= wSum;
  }

  const sampleIdx = (f, k) =>
    cyclic ? (((f + k) % N) + N) % N : Math.max(0, Math.min(N - 1, f + k));

  const pass = (input) =>
    input.map((cur, f) => {
      const out = cloneFrame(cur);
      out.rootPos.set(0, 0, 0);
      for (const { k, w } of weights) {
        out.rootPos.addScaledVector(input[sampleIdx(f, k)].rootPos, w);
      }

      for (let b = 0; b < NUM_BONES; b++) {
        const ref = input[f].quats[b];
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let sw = 0;
        for (const { k, w } of weights) {
          const q = input[sampleIdx(f, k)].quats[b];
          const sign = ref.x * q.x + ref.y * q.y + ref.z * q.z + ref.w * q.w < 0 ? -w : w;
          sx += q.x * sign;
          sy += q.y * sign;
          sz += q.z * sign;
          sw += q.w * sign;
        }
        out.quats[b].set(sx, sy, sz, sw).normalize();
      }
      return out;
    });

  return pass(pass(frames));
}

/**
 * Hemisphere-aligned Quaternion.slerp + Vector3.lerpVectors frame resampler (e.g. 24fps -> 60fps).
 */
export function upsampleFramesSlerp(frames, targetCount) {
  if (!frames || frames.length === 0) return [];
  const M = frames.length;
  const N = Math.max(2, Math.round(targetCount));
  if (M === 1) {
    return Array.from({ length: N }, () => cloneFrame(frames[0]));
  }
  const out = [];
  const tmpQ1 = new THREE.Quaternion();
  for (let f = 0; f < N; f++) {
    const u = f / (N - 1);
    const srcPos = u * (M - 1);
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(M - 1, i0 + 1);
    const alpha = srcPos - i0;

    const fr0 = frames[i0];
    const fr1 = frames[i1];
    const dst = emptyFrame();
    dst.rootPos.lerpVectors(fr0.rootPos, fr1.rootPos, alpha);
    for (let b = 0; b < NUM_BONES; b++) {
      const q0 = fr0.quats[b];
      const q1 = fr1.quats[b];
      if (q0.dot(q1) < 0) {
        tmpQ1.set(-q1.x, -q1.y, -q1.z, -q1.w);
      } else {
        tmpQ1.copy(q1);
      }
      dst.quats[b].copy(q0).slerp(tmpQ1, alpha).normalize();
    }
    out.push(dst);
  }
  return out;
}

/**
 * C1 smoothstep inertialization loop seam closure.
 */
export function closeLoopAndStabilizeRoot(
  frames,
  stabilizeInPlace = false,
  seamRatio = 0.20,
  preserveRootMotion = false
) {
  if (!frames || frames.length === 0) return [];
  const N = frames.length;
  const out = frames.map(cloneFrame);
  if (N < 2) return out;

  if (stabilizeInPlace && !preserveRootMotion) {
    for (let f = 0; f < N; f++) {
      out[f].rootPos.x *= 0.16;
      out[f].rootPos.z *= 0.16;
    }
  }

  const ratio = THREE.MathUtils.clamp(
    Number.isFinite(Number(seamRatio)) ? Number(seamRatio) : 0.20,
    0,
    0.95
  );
  if (ratio <= 0) return out;

  const seamWindow = Math.min(N - 1, Math.max(1, Math.round(N * ratio)));
  const first = out[0];
  const last = out[N - 1];

  const posGap = new THREE.Vector3().subVectors(first.rootPos, last.rootPos);
  if (preserveRootMotion) {
    posGap.x = 0;
    posGap.z = 0;
  }

  const rotGaps = [];
  const invLast = new THREE.Quaternion();
  for (let b = 0; b < NUM_BONES; b++) {
    invLast.copy(last.quats[b]).invert();
    const dq = new THREE.Quaternion().multiplyQuaternions(invLast, first.quats[b]);
    if (dq.w < 0) {
      dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    }
    rotGaps.push(dq);
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

function slerpShortestInto(dst, qFrom, qTo, alpha) {
  if (alpha <= 0) {
    return dst.copy(qFrom);
  }
  if (alpha >= 1) {
    return dst.copy(qTo).normalize();
  }
  const dot = qFrom.x * qTo.x + qFrom.y * qTo.y + qFrom.z * qTo.z + qFrom.w * qTo.w;
  if (dot < 0) {
    const neg = new THREE.Quaternion(-qTo.x, -qTo.y, -qTo.z, -qTo.w);
    return dst.copy(qFrom).slerp(neg, alpha).normalize();
  }
  return dst.copy(qFrom).slerp(qTo, alpha).normalize();
}

function quatAngleRad(a, b) {
  const dot = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w));
  return 2 * Math.acos(dot);
}

/**
 * Symmetric geodesic pairwise angular-step limiter on S^3.
 * Monotonically contracts any 1-frame local joint rotation step exceeding maxStepDeg
 * while preserving exact cyclic loop closure (frames[N-1] === frames[0]) or soft non-cyclic tail.
 */
export function limitBoneLocalStepSequence(frames, boneIndices, maxStepDeg = 36.0, cyclic = false) {
  if (!frames || frames.length < 2 || !boneIndices || boneIndices.length === 0) return frames;
  const N = frames.length;
  const maxRad = (Math.max(1.0, Number(maxStepDeg) || 36.0) * Math.PI) / 180;
  const endCapRad = Math.min(maxRad, (20.0 * Math.PI) / 180);
  const M = cyclic && N >= 3 ? N - 1 : N;
  const qTmp0 = new THREE.Quaternion();
  const qTmp1 = new THREE.Quaternion();

  for (const bIdx of boneIndices) {
    if (cyclic && N >= 3) {
      frames[N - 1].quats[bIdx].copy(frames[0].quats[bIdx]);
    }
    for (let iter = 0; iter < 36; iter++) {
      let maxViol = 0;
      const edgeCount = cyclic && N >= 3 ? M : N - 1;
      for (let e = 0; e < edgeCount; e++) {
        const i0 = e;
        const i1 = cyclic && N >= 3 ? (e + 1) % M : e + 1;
        const cap = !cyclic && e === N - 2 ? endCapRad : maxRad;
        const q0 = frames[i0].quats[bIdx];
        const q1 = frames[i1].quats[bIdx];
        const ang = quatAngleRad(q0, q1);
        if (ang > cap) {
          const viol = ang - cap;
          if (viol > maxViol) maxViol = viol;
          const frac = 0.52 * (viol / ang);
          slerpShortestInto(qTmp0, q0, q1, frac);
          slerpShortestInto(qTmp1, q1, q0, frac);
          q0.copy(qTmp0);
          q1.copy(qTmp1);
        }
      }
      if (cyclic && N >= 3) {
        frames[N - 1].quats[bIdx].copy(frames[0].quats[bIdx]);
      }
      if (maxViol < 1e-4) break;
    }
  }
  return frames;
}

function extractFlatFootYawQuat(footBone, hipsBone, prevFwdXZ = null) {
  const qFoot = new THREE.Quaternion();
  const qHips = new THREE.Quaternion();
  footBone.getWorldQuaternion(qFoot);
  hipsBone.getWorldQuaternion(qHips);

  const hipsFwd3D = new THREE.Vector3(0, 0, 1).applyQuaternion(qHips);
  const hipsXZ = new THREE.Vector3(hipsFwd3D.x, 0, hipsFwd3D.z);
  if (hipsXZ.lengthSq() < 0.08 && prevFwdXZ && prevFwdXZ.lengthSq() > 1e-5) {
    hipsXZ.copy(prevFwdXZ);
  } else if (hipsXZ.lengthSq() > 1e-6) {
    hipsXZ.normalize();
  } else {
    hipsXZ.set(0, 0, 1);
  }
  if (prevFwdXZ && prevFwdXZ.lengthSq() > 1e-5 && hipsXZ.dot(prevFwdXZ) < -0.25) {
    hipsXZ.copy(prevFwdXZ);
  }

  const footFwd3D = new THREE.Vector3(0, 0, 1).applyQuaternion(qFoot);
  const footHorizLen = Math.hypot(footFwd3D.x, footFwd3D.z);
  const footXZ =
    footHorizLen > 1e-4
      ? new THREE.Vector3(footFwd3D.x / footHorizLen, 0, footFwd3D.z / footHorizLen)
      : hipsXZ.clone();

  // Guard against steep toe pitch (>50 deg) reversing horizontal (x,z) projection by 180 deg
  const pitchWeight = THREE.MathUtils.smoothstep(footHorizLen, 0.42, 0.82);
  const hemiWeight = THREE.MathUtils.smoothstep(footXZ.dot(hipsXZ), -0.20, 0.28);
  const wFoot = pitchWeight * hemiWeight;

  const blendedXZ = hipsXZ.clone().lerp(footXZ, wFoot);
  if (prevFwdXZ && prevFwdXZ.lengthSq() > 1e-5 && wFoot < 0.35) {
    blendedXZ.lerp(prevFwdXZ, 0.45 * (1 - wFoot / 0.35));
  }
  if (blendedXZ.lengthSq() < 1e-6) {
    blendedXZ.set(0, 0, 1);
  } else {
    blendedXZ.normalize();
  }
  if (prevFwdXZ) {
    prevFwdXZ.copy(blendedXZ);
  }
  const yaw = Math.atan2(blendedXZ.x, blendedXZ.z);
  return new THREE.Quaternion().setFromAxisAngle(_worldUp, yaw);
}

/**
 * Stance contact detector + Analytic Two-Bone Leg IK foot-lock with split-safe minPelvisY floor guard,
 * smooth non-stance floor-penetration ramp, decoupled flat-foot blend, and thigh-aligned pole continuity.
 */
export function lockFeetWithTwoBoneIK(frames, fps = 60, cyclic = true, options = {}) {
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
    : 0.24;
  const maxRampFrames =
    options.maxRampFrames !== undefined && Number.isFinite(Number(options.maxRampFrames))
      ? Math.max(0, Math.round(Number(options.maxRampFrames)))
      : 3;
  const ikBlend = Number.isFinite(Number(options.ikBlend))
    ? THREE.MathUtils.clamp(Number(options.ikBlend), 0, 1)
    : 1.0;
  const pelvisPullWeight = Number.isFinite(Number(options.pelvisPullWeight))
    ? THREE.MathUtils.clamp(Number(options.pelvisPullWeight), 0, 1)
    : 0.85;
  const keepFootFlat = options.keepFootFlat !== undefined ? Boolean(options.keepFootFlat) : true;

  const out = frames.map(cloneFrame);
  const { bones } = createBoneHierarchy();

  const rawAnkleL = [];
  const rawAnkleR = [];
  const rawKneeL = [];
  const rawKneeR = [];
  const rawFootYawL = [];
  const rawFootYawR = [];
  const hipsUpY = [];

  const tmp = new THREE.Vector3();
  const qHips = new THREE.Quaternion();
  const prevFwdL = new THREE.Vector3();
  const prevFwdR = new THREE.Vector3();

  for (let f = 0; f < N; f++) {
    applyFrameToBones(out[f], bones);
    bones[BONE_IDX.LeftFoot].getWorldPosition(tmp);
    rawAnkleL.push(tmp.clone());
    bones[BONE_IDX.RightFoot].getWorldPosition(tmp);
    rawAnkleR.push(tmp.clone());

    bones[BONE_IDX.LeftLeg].getWorldPosition(tmp);
    rawKneeL.push(tmp.clone());
    bones[BONE_IDX.RightLeg].getWorldPosition(tmp);
    rawKneeR.push(tmp.clone());

    rawFootYawL.push(extractFlatFootYawQuat(bones[BONE_IDX.LeftFoot], bones[BONE_IDX.Hips], prevFwdL));
    rawFootYawR.push(extractFlatFootYawQuat(bones[BONE_IDX.RightFoot], bones[BONE_IDX.Hips], prevFwdR));

    bones[BONE_IDX.Hips].getWorldQuaternion(qHips);
    tmp.set(0, 1, 0).applyQuaternion(qHips);
    hipsUpY.push(tmp.y);
  }

  for (let f = 0; f < N; f++) {
    if (options.forceBothFeetGrounded) {
      out[f].contactL = true;
      out[f].contactR = true;
      continue;
    }
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

  // Morphological hysteresis: bridge short <=5-frame velocity jitter gaps while foot remains low,
  // and prune isolated interior 1-2 frame false contact blips while preserving genuine start/end touchdowns.
  const regularizeContactFlags = (isLeft) => {
    if (options.forceBothFeetGrounded || N < 6) return;
    const rawPts = isLeft ? rawAnkleL : rawAnkleR;
    const flags = out.map((fr) => Boolean(isLeft ? fr.contactL : fr.contactR));

    // 1. Bridge short false gaps (1..5 frames) when foot stays near floor
    let i = 0;
    while (i < N) {
      if (flags[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < N && !flags[j]) j++;
      const gapLen = j - i;
      const hasLeftSupport = i > 0 && flags[i - 1];
      const hasRightSupport = j < N && flags[j];
      if (hasLeftSupport && hasRightSupport && gapLen <= 5) {
        let staysLow = true;
        for (let k = i; k < j; k++) {
          if (hipsUpY[k] <= 0.35 || rawPts[k].y > hThresh + 0.04) {
            staysLow = false;
            break;
          }
        }
        if (staysLow) {
          for (let k = i; k < j; k++) flags[k] = true;
        }
      }
      i = j;
    }

    // 2. Prune isolated interior 1-2 frame contact blips (never prune genuine clip-start or clip-end stance)
    i = 0;
    while (i < N) {
      if (!flags[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < N && flags[j]) j++;
      const isClipBoundary = i === 0 || j === N;
      if (j - i <= 2 && !isClipBoundary) {
        for (let k = i; k < j; k++) flags[k] = false;
      }
      i = j;
    }

    for (let f = 0; f < N; f++) {
      if (isLeft) out[f].contactL = flags[f];
      else out[f].contactR = flags[f];
    }
  };

  regularizeContactFlags(true);
  regularizeContactFlags(false);

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

    const effMaxRamp = maxRampFrames <= 0 ? 0 : Math.max(4, maxRampFrames);

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

      const atNonCyclicStart = !cyclic && idx === 0;
      const atNonCyclicEnd = !cyclic && (startOffset + segEndStep) === N - 1;

      const ramp =
        stanceRampRatio <= 0 || effMaxRamp <= 0
          ? 0
          : Math.min(
              effMaxRamp,
              Math.max(1, Math.floor(segLen * (atNonCyclicStart || atNonCyclicEnd ? 0.85 : 0.45))),
              Math.max(2, Math.round(segLen * stanceRampRatio))
            );

      for (let s = step; s <= segEndStep; s++) {
        const k = (startOffset + s) % N;
        anchors[k] = planted.clone();
        yawQuats[k] = plantedYaw.clone();
        if (ramp <= 0) {
          weights[k] = 1.0;
        } else {
          const inW = atNonCyclicStart ? 1.0 : Math.min(1, (s - step + 0.5) / (ramp + 0.5));
          const outW = atNonCyclicEnd ? 1.0 : Math.min(1, (segEndStep - s + 0.5) / (ramp + 0.5));
          weights[k] = THREE.MathUtils.smoothstep(Math.min(inW, outW), 0, 1);
        }
      }

      // Smoothly taper 4 extra frames beyond non-cyclic standing-start liftoff or landing entry
      if (atNonCyclicStart && !atNonCyclicEnd && ramp > 0) {
        for (let extra = 1; extra <= 4; extra++) {
          const k = segEndStep + extra;
          if (k < N && !flags[k]) {
            const upTaper = THREE.MathUtils.smoothstep(hipsUpY[k], 0.18, 0.48);
            if (upTaper > 0) {
              anchors[k] = planted.clone();
              yawQuats[k] = plantedYaw.clone();
              weights[k] = THREE.MathUtils.smoothstep(1 - extra / 5, 0, 1) * upTaper * weights[segEndStep];
            }
          }
        }
      }
      if (atNonCyclicEnd && !atNonCyclicStart && ramp > 0) {
        for (let extra = 1; extra <= 4; extra++) {
          const k = idx - extra;
          if (k >= 0 && !flags[k]) {
            const upTaper = THREE.MathUtils.smoothstep(hipsUpY[k], 0.18, 0.48);
            if (upTaper > 0) {
              anchors[k] = planted.clone();
              yawQuats[k] = plantedYaw.clone();
              weights[k] = THREE.MathUtils.smoothstep(1 - extra / 5, 0, 1) * upTaper * weights[idx];
            }
          }
        }
      }

      step = segEndStep + 1;
    }
    return { anchors, yawQuats, weights };
  };

  const stanceL = buildStanceTargets(true);
  const stanceR = buildStanceTargets(false);

  // Smooth continuous floor-penetration weights (replaces binary floorPen ? 1 : 0 snap)
  const rawPenL = new Float64Array(N);
  const rawPenR = new Float64Array(N);
  for (let f = 0; f < N; f++) {
    const upGate = THREE.MathUtils.smoothstep(hipsUpY[f], 0.34, 0.60);
    rawPenL[f] = upGate * THREE.MathUtils.smoothstep(floorY + 0.025 - rawAnkleL[f].y, 0.0, 0.030);
    rawPenR[f] = upGate * THREE.MathUtils.smoothstep(floorY + 0.025 - rawAnkleR[f].y, 0.0, 0.030);
  }
  const penKernel = [0.12, 0.23, 0.30, 0.23, 0.12];
  const penWL = new Float64Array(N);
  const penWR = new Float64Array(N);
  for (let f = 0; f < N; f++) {
    let sL = 0;
    let sR = 0;
    for (let k = -2; k <= 2; k++) {
      const idx = cyclic ? (((f + k) % N) + N) % N : Math.max(0, Math.min(N - 1, f + k));
      sL += rawPenL[idx] * penKernel[k + 2];
      sR += rawPenR[idx] * penKernel[k + 2];
    }
    // Guarantee hard floor non-penetration when genuinely upright and below swingClearY
    const hardUp = hipsUpY[f] > 0.40;
    const swingClearY = floorY + 0.0035;
    penWL[f] = hardUp && rawAnkleL[f].y < swingClearY ? 1.0 : Math.max(rawPenL[f] * 0.7, sL);
    penWR[f] = hardUp && rawAnkleR[f].y < swingClearY ? 1.0 : Math.max(rawPenR[f] * 0.7, sR);
  }

  const blendTarget = new THREE.Vector3();
  const poleL = new THREE.Vector3();
  const poleR = new THREE.Vector3();
  const prevPoleDirL = new THREE.Vector3();
  const prevPoleDirR = new THREE.Vector3();
  const hipPos = new THREE.Vector3();
  const midLeg = new THREE.Vector3();
  const kneeDir = new THREE.Vector3();
  const uLegTmp = new THREE.Vector3();
  const zOrigUpper = new THREE.Vector3();
  const qOrigUpperWorld = new THREE.Quaternion();
  const maxLegReach = 0.805;

  const computeAnatomicalPole = (upLegBone, rawKnee, targetAnkle, rawAnkle, prevPoleDir, outPole) => {
    upLegBone.getWorldPosition(hipPos);
    upLegBone.getWorldQuaternion(qOrigUpperWorld);
    zOrigUpper.set(0, 0, 1).applyQuaternion(qOrigUpperWorld).normalize();

    uLegTmp.subVectors(targetAnkle, hipPos);
    if (uLegTmp.lengthSq() < 1e-6) uLegTmp.set(0, -1, 0);
    else uLegTmp.normalize();

    // Project thigh's existing +Z forward knee vector perpendicular to uLegTmp (exact zero-roll match when straight)
    const thighFwd = zOrigUpper.clone().addScaledVector(uLegTmp, -zOrigUpper.dot(uLegTmp));
    if (thighFwd.lengthSq() > 1e-5) thighFwd.normalize();
    else thighFwd.set(0, 0, 1);

    midLeg.addVectors(hipPos, rawAnkle).multiplyScalar(0.5);
    kneeDir.subVectors(rawKnee, midLeg);
    kneeDir.addScaledVector(uLegTmp, -kneeDir.dot(uLegTmp));
    const bendLen = kneeDir.length();
    if (bendLen > 1e-4) {
      kneeDir.divideScalar(bendLen);
      const bendW =
        THREE.MathUtils.smoothstep(bendLen, 0.025, 0.11) *
        THREE.MathUtils.smoothstep(kneeDir.dot(thighFwd), -0.25, 0.30);
      thighFwd.lerp(kneeDir, bendW * 0.65);
    }

    if (prevPoleDir.lengthSq() > 1e-5) {
      const prevProj = prevPoleDir.clone().addScaledVector(uLegTmp, -prevPoleDir.dot(uLegTmp));
      if (prevProj.lengthSq() > 1e-5) {
        prevProj.normalize();
        if (thighFwd.dot(prevProj) < 0) {
          thighFwd.copy(prevProj);
        } else {
          thighFwd.lerp(prevProj, 0.22);
        }
      }
    }

    if (thighFwd.lengthSq() < 1e-5) thighFwd.set(0, 0, 1);
    else thighFwd.normalize();

    prevPoleDir.copy(thighFwd);
    outPole.copy(hipPos).addScaledVector(thighFwd, 0.95);
  };

  const swingClearYM = floorY + 0.0035;
  for (let f = 0; f < N; f++) {
    const fr = out[f];
    const wL = stanceL.weights[f];
    const wR = stanceR.weights[f];
    const uprightGate = THREE.MathUtils.smoothstep(hipsUpY[f], 0.30, 0.52);

    fr.lockWeightL = wL;
    fr.lockWeightR = wR;
    fr.anchorL = stanceL.anchors[f];
    fr.anchorR = stanceR.anchors[f];

    if (ikBlend <= 0) continue;

    const targetL = rawAnkleL[f].clone();
    if (uprightGate > 0 && targetL.y < swingClearYM) {
      targetL.y = THREE.MathUtils.lerp(targetL.y, swingClearYM, uprightGate);
    }
    if (wL > 0 && fr.anchorL) {
      if (wL >= 0.999) {
        targetL.copy(fr.anchorL);
      } else {
        blendTarget.lerpVectors(targetL, fr.anchorL, wL);
        const minRampY = floorY + Math.max(0.0025, 0.0045 * Math.pow(1 - wL, 0.35));
        if (uprightGate > 0.5 && blendTarget.y < minRampY) {
          blendTarget.y = minRampY;
        }
        targetL.copy(blendTarget);
      }
    }

    const targetR = rawAnkleR[f].clone();
    if (uprightGate > 0 && targetR.y < swingClearYM) {
      targetR.y = THREE.MathUtils.lerp(targetR.y, swingClearYM, uprightGate);
    }
    if (wR > 0 && fr.anchorR) {
      if (wR >= 0.999) {
        targetR.copy(fr.anchorR);
      } else {
        blendTarget.lerpVectors(targetR, fr.anchorR, wR);
        const minRampY = floorY + Math.max(0.0025, 0.0045 * Math.pow(1 - wR, 0.35));
        if (uprightGate > 0.5 && blendTarget.y < minRampY) {
          blendTarget.y = minRampY;
        }
        targetR.copy(blendTarget);
      }
    }

    applyFrameToBones(fr, bones);
    if (pelvisPullWeight > 0) {
      const minPelvisY = Number.isFinite(Number(options.minPelvisY))
        ? Number(options.minPelvisY)
        : hipsUpY[f] > 0.30
          ? 0.42
          : 0.14;
      for (const [upIdx, tgt, w] of [
        [BONE_IDX.LeftUpLeg, targetL, wL],
        [BONE_IDX.RightUpLeg, targetR, wR],
      ]) {
        if (w > 0.2) {
          bones[upIdx].getWorldPosition(hipPos);
          const dist = hipPos.distanceTo(tgt);
          if (dist > maxLegReach) {
            fr.rootPos.y = Math.max(
              minPelvisY,
              fr.rootPos.y - (dist - maxLegReach) * pelvisPullWeight * w * ikBlend
            );
            applyFrameToBones(fr, bones);
          }
        }
      }
    }

    const legBlendL = Math.max(wL, penWL[f]) * ikBlend;
    const footBlendL = (keepFootFlat ? wL : 0) * ikBlend;
    if (legBlendL > 0.001) {
      const yawQL = stanceL.yawQuats[f] || rawFootYawL[f];
      computeAnatomicalPole(
        bones[BONE_IDX.LeftUpLeg],
        rawKneeL[f],
        targetL,
        rawAnkleL[f],
        prevPoleDirL,
        poleL
      );

      const origUp = fr.quats[BONE_IDX.LeftUpLeg].clone();
      const origLo = fr.quats[BONE_IDX.LeftLeg].clone();
      const origFt = fr.quats[BONE_IDX.LeftFoot].clone();

      solveTwoBoneLegIK(
        bones[BONE_IDX.LeftUpLeg],
        bones[BONE_IDX.LeftLeg],
        bones[BONE_IDX.LeftFoot],
        targetL,
        poleL,
        keepFootFlat,
        yawQL
      );

      slerpShortestInto(fr.quats[BONE_IDX.LeftUpLeg], origUp, bones[BONE_IDX.LeftUpLeg].quaternion, legBlendL);
      slerpShortestInto(fr.quats[BONE_IDX.LeftLeg], origLo, bones[BONE_IDX.LeftLeg].quaternion, legBlendL);
      slerpShortestInto(fr.quats[BONE_IDX.LeftFoot], origFt, bones[BONE_IDX.LeftFoot].quaternion, footBlendL);
    } else {
      applyFrameToBones(fr, bones);
      bones[BONE_IDX.LeftUpLeg].getWorldQuaternion(qOrigUpperWorld);
      prevPoleDirL.set(0, 0, 1).applyQuaternion(qOrigUpperWorld).normalize();
    }

    const legBlendR = Math.max(wR, penWR[f]) * ikBlend;
    const footBlendR = (keepFootFlat ? wR : 0) * ikBlend;
    if (legBlendR > 0.001) {
      const yawQR = stanceR.yawQuats[f] || rawFootYawR[f];
      computeAnatomicalPole(
        bones[BONE_IDX.RightUpLeg],
        rawKneeR[f],
        targetR,
        rawAnkleR[f],
        prevPoleDirR,
        poleR
      );

      const origUp = fr.quats[BONE_IDX.RightUpLeg].clone();
      const origLo = fr.quats[BONE_IDX.RightLeg].clone();
      const origFt = fr.quats[BONE_IDX.RightFoot].clone();

      solveTwoBoneLegIK(
        bones[BONE_IDX.RightUpLeg],
        bones[BONE_IDX.RightLeg],
        bones[BONE_IDX.RightFoot],
        targetR,
        poleR,
        keepFootFlat,
        yawQR
      );

      slerpShortestInto(fr.quats[BONE_IDX.RightUpLeg], origUp, bones[BONE_IDX.RightUpLeg].quaternion, legBlendR);
      slerpShortestInto(fr.quats[BONE_IDX.RightLeg], origLo, bones[BONE_IDX.RightLeg].quaternion, legBlendR);
      slerpShortestInto(fr.quats[BONE_IDX.RightFoot], origFt, bones[BONE_IDX.RightFoot].quaternion, footBlendR);
    } else {
      applyFrameToBones(fr, bones);
      bones[BONE_IDX.RightUpLeg].getWorldQuaternion(qOrigUpperWorld);
      prevPoleDirR.set(0, 0, 1).applyQuaternion(qOrigUpperWorld).normalize();
    }

    bones[BONE_IDX.LeftHand].quaternion.copy(fr.quats[BONE_IDX.LeftHand]);
    bones[BONE_IDX.RightHand].quaternion.copy(fr.quats[BONE_IDX.RightHand]);
    applyForearmTwistSolver(bones, true, 0.58);
    fr.quats[BONE_IDX.LeftForeArmTwist].copy(bones[BONE_IDX.LeftForeArmTwist].quaternion);
    fr.quats[BONE_IDX.RightForeArmTwist].copy(bones[BONE_IDX.RightForeArmTwist].quaternion);
  }

  // Leaf ankle step limiter: preserves exact Ankle world coordinates (0.00cm/s slip) while eliminating >34° liftoff/landing ankle snaps
  const maxAnkleStepDeg = cyclic && options.forceBothFeetGrounded ? 12.0 : 34.0;
  limitBoneLocalStepSequence(out, [BONE_IDX.LeftFoot, BONE_IDX.RightFoot], maxAnkleStepDeg, cyclic);

  return out;
}

export const FLOOR_BOUNDS_M = [
  [BONE_IDX.Hips, 0.155],
  [BONE_IDX.Spine, 0.155],
  [BONE_IDX.Chest, 0.165],
  [BONE_IDX.Head, 0.155],
  [BONE_IDX.LeftShoulder, 0.130],
  [BONE_IDX.RightShoulder, 0.130],
  [BONE_IDX.LeftForeArm, 0.050],
  [BONE_IDX.RightForeArm, 0.050],
  [BONE_IDX.LeftHand, 0.045],
  [BONE_IDX.RightHand, 0.045],
  [BONE_IDX.LeftLeg, 0.075],
  [BONE_IDX.RightLeg, 0.075],
  [BONE_IDX.LeftFoot, 0.080],
  [BONE_IDX.RightFoot, 0.080],
  [BONE_IDX.LeftToe, 0.030],
  [BONE_IDX.RightToe, 0.030],
];

/**
 * 21-bone body-capsule floor non-penetration pass.
 * Leaves normal upright IK stance (Ankle Y = 0.080m, Toe Y = 0.030m) untouched while
 * preventing hands, forearms, toes, pelvis, chest, or head from penetrating y < 0.
 */
export function applyCapsuleFloorClearance(frames, options = {}) {
  if (!frames || frames.length === 0) return [];
  const cyclic = Boolean(options.cyclic);
  const bounds = options.bounds || FLOOR_BOUNDS_M;
  const smoothRadius = options.smoothRadius ?? 4;
  const N = frames.length;
  const out = frames.map(cloneFrame);
  const { bones } = createBoneHierarchy();
  const pos = new THREE.Vector3();
  const reqLift = new Float64Array(N);

  for (let f = 0; f < N; f++) {
    applyFrameToBones(out[f], bones);
    let req = 0;
    for (const [bIdx, minH] of bounds) {
      bones[bIdx].getWorldPosition(pos);
      if (minH - pos.y > req) {
        req = minH - pos.y;
      }
    }
    reqLift[f] = req > 2e-4 ? req : 0;
  }

  const sigma = Math.max(0.9, smoothRadius * 0.55);
  const kernel = [];
  let wSum = 0;
  for (let k = -smoothRadius; k <= smoothRadius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push({ k, w });
    wSum += w;
  }
  for (const item of kernel) item.w /= wSum;

  const finalLift = new Float64Array(N);
  for (let f = 0; f < N; f++) {
    let sm = 0;
    for (const { k, w } of kernel) {
      const idx = cyclic ? (((f + k) % N) + N) % N : Math.max(0, Math.min(N - 1, f + k));
      sm += reqLift[idx] * w;
    }
    finalLift[f] =
      (out[f].lockWeightL > 0.85 || out[f].lockWeightR > 0.85) && reqLift[f] === 0
        ? 0
        : Math.max(reqLift[f], sm);
  }

  if (cyclic && N >= 2) {
    const endLift = Math.max(finalLift[0], finalLift[N - 1]);
    finalLift[0] = endLift;
    finalLift[N - 1] = endLift;
  }

  for (let f = 0; f < N; f++) {
    if (finalLift[f] > 0) {
      out[f].rootPos.y += finalLift[f];
    }
  }

  return out;
}

function segmentToPointDist(a, b, p) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ap = new THREE.Vector3().subVectors(p, a);
  const lenSq = ab.lengthSq();
  if (lenSq < 1e-8) return a.distanceTo(p);
  const t = THREE.MathUtils.clamp(ap.dot(ab) / lenSq, 0, 1);
  const closest = new THREE.Vector3().copy(a).addScaledVector(ab, t);
  return closest.distanceTo(p);
}

function buildTangentBasis(unitAxis, outT1, outT2) {
  const ref = Math.abs(unitAxis.y) < 0.85 ? _worldUp : new THREE.Vector3(1, 0, 0);
  outT1.crossVectors(ref, unitAxis).normalize();
  outT2.crossVectors(unitAxis, outT1).normalize();
}

/**
 * Ensures the RightHand Greatsword blade segment [SwordBase, SwordTip] maintains
 * safe clearance from Hips/Spine/Chest AND Neck/Head capsules and does not stab underground,
 * while guaranteeing strict 1-frame local RightHand & 3D SwordTip continuity via bidirectional
 * open-air anchored cone search and neighbor-aware safety-projected geodesic relaxation.
 */
export function enforceSwordTorsoClearance(frames, minClearanceM = 0.24, cyclic = false, options = {}) {
  if (!frames || frames.length === 0) return [];
  const N = frames.length;
  const out = frames.map(cloneFrame);
  const rig = buildCharacterRig();
  const { bones, swordGroup } = rig;
  const { tipAnchor, baseAnchor } = swordGroup.userData;

  swordGroup.updateMatrix();
  const baseLocalInHand = baseAnchor.position.clone().applyMatrix4(swordGroup.matrix);
  const tipLocalInHand = tipAnchor.position.clone().applyMatrix4(swordGroup.matrix);
  const zBladeLocal = new THREE.Vector3().subVectors(tipLocalInHand, baseLocalInHand).normalize();

  const reqTorsoM = Math.max(0.235, Number(minClearanceM) || 0.24);
  const reqHeadM = Math.max(0.215, reqTorsoM * 0.88);
  const reqTipYM = 0.055;
  const softPad = 0.045;

  const pHipsArr = new Array(N);
  const pSpineArr = new Array(N);
  const pChestArr = new Array(N);
  const pNeckArr = new Array(N);
  const pHeadArr = new Array(N);
  const pHandArr = new Array(N);
  const qForeWorldArr = new Array(N);
  const qForeInvArr = new Array(N);
  const qRawHandWorldArr = new Array(N);
  const qRawHandInvArr = new Array(N);

  let maxHandPosStepM = 0;
  for (let f = 0; f < N; f++) {
    applyFrameToBones(out[f], bones);
    pHipsArr[f] = bones[BONE_IDX.Hips].getWorldPosition(new THREE.Vector3());
    pSpineArr[f] = bones[BONE_IDX.Spine].getWorldPosition(new THREE.Vector3());
    pChestArr[f] = bones[BONE_IDX.Chest].getWorldPosition(new THREE.Vector3());
    pNeckArr[f] = bones[BONE_IDX.Neck].getWorldPosition(new THREE.Vector3());
    pHeadArr[f] = bones[BONE_IDX.Head].getWorldPosition(new THREE.Vector3());
    pHandArr[f] = bones[BONE_IDX.RightHand].getWorldPosition(new THREE.Vector3());
    if (f > 0) {
      const hs = pHandArr[f].distanceTo(pHandArr[f - 1]);
      if (hs > maxHandPosStepM) maxHandPosStepM = hs;
    }
    qForeWorldArr[f] = bones[BONE_IDX.RightForeArm].getWorldQuaternion(new THREE.Quaternion());
    qForeInvArr[f] = qForeWorldArr[f].clone().invert();
    qRawHandWorldArr[f] = bones[BONE_IDX.RightHand].getWorldQuaternion(new THREE.Quaternion());
    qRawHandInvArr[f] = qRawHandWorldArr[f].clone().invert();
  }

  const calmIdle = Boolean(options.calmIdle) || (cyclic && maxHandPosStepM < 0.035);
  const maxLocalStepRad = ((options.maxLocalStepDeg || (calmIdle ? 9.5 : 44.0)) * Math.PI) / 180;
  const maxTipStepM = options.maxTipStepM || (calmIdle ? 0.13 : 0.56);
  const endCapRad = Math.min(maxLocalStepRad, (19.0 * Math.PI) / 180);

  const pBase = new THREE.Vector3();
  const pTip = new THREE.Vector3();

  const evalHandWorld = (f, candWorld) => {
    pBase.copy(baseLocalInHand).applyQuaternion(candWorld).add(pHandArr[f]);
    pTip.copy(tipLocalInHand).applyQuaternion(candWorld).add(pHandArr[f]);
    const dTorso = Math.min(
      segmentToPointDist(pBase, pTip, pHipsArr[f]),
      segmentToPointDist(pBase, pTip, pSpineArr[f]),
      segmentToPointDist(pBase, pTip, pChestArr[f])
    );
    const dHead = Math.min(
      segmentToPointDist(pBase, pTip, pNeckArr[f]),
      segmentToPointDist(pBase, pTip, pHeadArr[f])
    );
    const margin = Math.min(
      dTorso - reqTorsoM,
      dHead - reqHeadM,
      (pTip.y - reqTipYM) * 1.25
    );
    return { dTorso, dHead, tipY: pTip.y, margin, tipX: pTip.x, tipZ: pTip.z };
  };

  // Early exit only if every frame clears body/floor AND already satisfies 1-frame local & SwordTip step limits
  let anyNearViolation = false;
  let prevRawTip = null;
  for (let f = 0; f < N; f++) {
    const chk = evalHandWorld(f, qRawHandWorldArr[f]);
    if (chk.margin < softPad * 0.5) {
      anyNearViolation = true;
      break;
    }
    if (f > 0) {
      const lStep = quatAngleRad(out[f].quats[BONE_IDX.RightHand], out[f - 1].quats[BONE_IDX.RightHand]);
      const tStep = Math.hypot(chk.tipX - prevRawTip.x, chk.tipY - prevRawTip.y, chk.tipZ - prevRawTip.z);
      if (lStep > maxLocalStepRad * 0.92 || tStep > maxTipStepM * 0.92) {
        anyNearViolation = true;
        break;
      }
    }
    prevRawTip = { x: chk.tipX, y: chk.tipY, z: chk.tipZ };
  }
  if (!anyNearViolation) {
    return out;
  }

  const coneRadList = [2, 4, 7, 10, 14, 19, 25, 32, 42, 54, 68, 85, 105, 128].map(
    (deg) => (deg * Math.PI) / 180
  );
  const relaxConeRadList = [2, 4, 7, 11, 16, 22, 30, 42, 58, 78].map(
    (deg) => (deg * Math.PI) / 180
  );
  const rollOffsetsRad = [-22, -10, 10, 22].map((deg) => (deg * Math.PI) / 180);
  const azCos = [];
  const azSin = [];
  const NUM_AZ = 16;
  for (let a = 0; a < NUM_AZ; a++) {
    const phi = (a * 2 * Math.PI) / NUM_AZ;
    azCos.push(Math.cos(phi));
    azSin.push(Math.sin(phi));
  }

  const idQuat = new THREE.Quaternion();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const dirCand = new THREE.Vector3();
  const bRaw = new THREE.Vector3();
  const bPrev = new THREE.Vector3();
  const qSwing = new THREE.Quaternion();
  const qRoll = new THREE.Quaternion();
  const qCand = new THREE.Quaternion();
  const qCandRolled = new THREE.Quaternion();
  const qCandLocal = new THREE.Quaternion();
  const qCandDelta = new THREE.Quaternion();

  const M = cyclic && N >= 3 ? N - 1 : N;

  // Find cleanest open-air anchor frame fBest so sequential propagation never starts trapped
  let fBest = 0;
  let bestAnchorMargin = -Infinity;
  for (let f = 0; f < M; f++) {
    const m = evalHandWorld(f, qRawHandWorldArr[f]).margin;
    if (m > bestAnchorMargin) {
      bestAnchorMargin = m;
      fBest = f;
    }
  }

  const solveSingleFrame = (f, refWorld, refLocal, refTip, prevDelta) => {
    const rawW = qRawHandWorldArr[f];
    const rawInv = qRawHandInvArr[f];

    let bestValidWorld = null;
    let bestValidCost = Infinity;
    let bestFallbackWorld = rawW.clone();
    let bestFallbackScore = -Infinity;

    const considerCandidate = (candW) => {
      const chk = evalHandWorld(f, candW);
      qCandLocal.multiplyQuaternions(qForeInvArr[f], candW).normalize();
      const worldStep = refWorld ? quatAngleRad(candW, refWorld) : 0;
      const localStep = refLocal ? quatAngleRad(qCandLocal, refLocal) : 0;
      const tipStep = refTip
        ? Math.hypot(chk.tipX - refTip.x, chk.tipY - refTip.y, chk.tipZ - refTip.z)
        : 0;

      const fbScore = chk.margin - 0.25 * localStep - 0.25 * tipStep;
      if (fbScore > bestFallbackScore) {
        bestFallbackScore = fbScore;
        bestFallbackWorld.copy(candW);
      }
      if (chk.margin < 0) return;

      const devRad = quatAngleRad(candW, rawW);
      qCandDelta.multiplyQuaternions(candW, rawInv).normalize();
      const deltaStep = prevDelta ? quatAngleRad(qCandDelta, prevDelta) : 0;
      const softPen = Math.max(0, 0.020 - chk.margin) * 4.5;
      const localEx = refLocal ? Math.max(0, localStep - maxLocalStepRad * 0.86) : 0;
      const tipEx = refTip ? Math.max(0, tipStep - maxTipStepM * 0.86) : 0;

      const cost =
        0.85 * devRad * devRad +
        2.5 * deltaStep * deltaStep +
        6.0 * worldStep * worldStep +
        14.0 * localStep * localStep +
        10.0 * tipStep * tipStep +
        softPen * softPen +
        420.0 * localEx * localEx +
        480.0 * tipEx * tipEx;

      if (cost < bestValidCost) {
        bestValidCost = cost;
        if (!bestValidWorld) bestValidWorld = candW.clone();
        else bestValidWorld.copy(candW);
      }
    };

    considerCandidate(rawW);
    if (prevDelta && quatAngleRad(prevDelta, idQuat) > 1e-4) {
      for (const decay of [0.0, 0.2, 0.45, 0.7, 0.9]) {
        slerpShortestInto(qCandDelta, prevDelta, idQuat, decay);
        qCand.multiplyQuaternions(qCandDelta, rawW).normalize();
        considerCandidate(qCand);
      }
    }
    if (refWorld) {
      for (const alpha of [0.0, 0.15, 0.32, 0.5, 0.7, 0.88]) {
        slerpShortestInto(qCand, refWorld, rawW, alpha);
        considerCandidate(qCand);
      }
    }

    bRaw.copy(zBladeLocal).applyQuaternion(rawW).normalize();
    for (const upAlpha of [0.04, 0.08, 0.15, 0.25, 0.4, 0.6]) {
      dirCand.copy(bRaw).lerp(_worldUp, upAlpha);
      if (dirCand.lengthSq() > 1e-6) {
        dirCand.normalize();
        qSwing.setFromUnitVectors(bRaw, dirCand);
        qCand.multiplyQuaternions(qSwing, rawW).normalize();
        considerCandidate(qCand);
      }
    }

    // Search cones around BOTH [bPrev, refWorld] (zero axial roll flip!) and [bRaw, rawW]
    const searchBases = [];
    if (refWorld) {
      bPrev.copy(zBladeLocal).applyQuaternion(refWorld).normalize();
      searchBases.push([bPrev.clone(), refWorld, true]);
    }
    searchBases.push([bRaw.clone(), rawW, false]);

    for (const [baseDir, baseQuat, withAxialRolls] of searchBases) {
      buildTangentBasis(baseDir, t1, t2);
      if (withAxialRolls) {
        for (const rRad of rollOffsetsRad) {
          qRoll.setFromAxisAngle(baseDir, rRad);
          qCandRolled.multiplyQuaternions(qRoll, baseQuat).normalize();
          considerCandidate(qCandRolled);
        }
      }
      for (const theta of coneRadList) {
        const cT = Math.cos(theta);
        const sT = Math.sin(theta);
        for (let a = 0; a < NUM_AZ; a++) {
          dirCand
            .copy(baseDir)
            .multiplyScalar(cT)
            .addScaledVector(t1, sT * azCos[a])
            .addScaledVector(t2, sT * azSin[a])
            .normalize();
          qSwing.setFromUnitVectors(baseDir, dirCand);
          qCand.multiplyQuaternions(qSwing, baseQuat).normalize();
          considerCandidate(qCand);
        }
      }
    }

    return bestValidWorld || bestFallbackWorld;
  };

  const worldSeq = new Array(N);
  const localSeq = new Array(N);
  const tipSeq = new Array(N);

  const commitFrame = (f, wQuat) => {
    worldSeq[f] = wQuat.clone();
    localSeq[f] = new THREE.Quaternion().multiplyQuaternions(qForeInvArr[f], wQuat).normalize();
    const chk = evalHandWorld(f, wQuat);
    tipSeq[f] = new THREE.Vector3(chk.tipX, chk.tipY, chk.tipZ);
  };

  // Initialize anchor frame fBest and propagate forward & backward
  commitFrame(fBest, solveSingleFrame(fBest, null, null, null, null));

  if (cyclic && N >= 3) {
    let curDelta = new THREE.Quaternion().multiplyQuaternions(worldSeq[fBest], qRawHandInvArr[fBest]).normalize();
    for (let pass = 0; pass < 2; pass++) {
      for (let s = 1; s <= M; s++) {
        const f = (fBest + s) % M;
        const prev = (f - 1 + M) % M;
        const chosen = solveSingleFrame(f, worldSeq[prev], localSeq[prev], tipSeq[prev], curDelta);
        commitFrame(f, chosen);
        curDelta.multiplyQuaternions(chosen, qRawHandInvArr[f]).normalize();
      }
    }
  } else {
    let fwdDelta = new THREE.Quaternion().multiplyQuaternions(worldSeq[fBest], qRawHandInvArr[fBest]).normalize();
    for (let f = fBest + 1; f < M; f++) {
      const chosen = solveSingleFrame(f, worldSeq[f - 1], localSeq[f - 1], tipSeq[f - 1], fwdDelta);
      commitFrame(f, chosen);
      fwdDelta.multiplyQuaternions(chosen, qRawHandInvArr[f]).normalize();
    }
    let bwdDelta = new THREE.Quaternion().multiplyQuaternions(worldSeq[fBest], qRawHandInvArr[fBest]).normalize();
    for (let f = fBest - 1; f >= 0; f--) {
      const chosen = solveSingleFrame(f, worldSeq[f + 1], localSeq[f + 1], tipSeq[f + 1], bwdDelta);
      commitFrame(f, chosen);
      bwdDelta.multiplyQuaternions(chosen, qRawHandInvArr[f]).normalize();
    }
  }

  // Neighbor-aware safety-projected geodesic relaxation (both local & world space so 3D SwordTip step stays strictly bounded)
  const qMidLocal = new THREE.Quaternion();
  const qDesLocal = new THREE.Quaternion();
  const qDesWorld = new THREE.Quaternion();
  const qMidWorld = new THREE.Quaternion();
  const bDes = new THREE.Vector3();
  const bMidW = new THREE.Vector3();
  const bCur = new THREE.Vector3();

  if (M >= 3) {
    for (let iter = 0; iter < 36; iter++) {
      const forwardOrder = iter % 2 === 0;
      for (let idx = 0; idx < M; idx++) {
        const f = forwardOrder ? idx : M - 1 - idx;
        const iPrev = cyclic && N >= 3 ? (f - 1 + M) % M : f > 0 ? f - 1 : -1;
        const iNext = cyclic && N >= 3 ? (f + 1) % M : f < M - 1 ? f + 1 : -1;

        const capPrev = !cyclic && f === M - 1 ? endCapRad : maxLocalStepRad;
        const capNext = !cyclic && f === M - 2 ? endCapRad : maxLocalStepRad;

        const curStepPrev = iPrev >= 0 ? quatAngleRad(localSeq[f], localSeq[iPrev]) : 0;
        const curStepNext = iNext >= 0 ? quatAngleRad(localSeq[f], localSeq[iNext]) : 0;
        const curTipPrev = iPrev >= 0 ? tipSeq[f].distanceTo(tipSeq[iPrev]) : 0;
        const curTipNext = iNext >= 0 ? tipSeq[f].distanceTo(tipSeq[iNext]) : 0;

        const hasTipViol = curTipPrev > maxTipStepM * 0.94 || curTipNext > maxTipStepM * 0.94;
        const hasEdgeViol =
          curStepPrev > capPrev * 0.94 ||
          curStepNext > capNext * 0.94 ||
          hasTipViol;

        if (iPrev >= 0 && iNext >= 0) {
          slerpShortestInto(qMidLocal, localSeq[iPrev], localSeq[iNext], 0.5);
          slerpShortestInto(qDesLocal, localSeq[f], qMidLocal, hasEdgeViol ? 0.85 : 0.38);
          slerpShortestInto(qMidWorld, worldSeq[iPrev], worldSeq[iNext], 0.5);
        } else {
          const nb = iPrev >= 0 ? iPrev : iNext;
          if (nb < 0) continue;
          slerpShortestInto(qDesLocal, localSeq[f], localSeq[nb], hasEdgeViol ? 0.50 : 0.16);
          slerpShortestInto(qMidWorld, worldSeq[f], worldSeq[nb], hasEdgeViol ? 0.50 : 0.16);
        }
        qDesWorld.multiplyQuaternions(qForeWorldArr[f], qDesLocal).normalize();

        let bestW = worldSeq[f].clone();
        let bestScore = Infinity;

        const evalRelaxCand = (candW) => {
          const chk = evalHandWorld(f, candW);
          if (chk.margin < 0) return;
          qCandLocal.multiplyQuaternions(qForeInvArr[f], candW).normalize();
          const desErr = hasTipViol
            ? quatAngleRad(candW, qMidWorld)
            : quatAngleRad(qCandLocal, qDesLocal);
          const sPrev = iPrev >= 0 ? quatAngleRad(qCandLocal, localSeq[iPrev]) : 0;
          const sNext = iNext >= 0 ? quatAngleRad(qCandLocal, localSeq[iNext]) : 0;
          const tPrev = iPrev >= 0
            ? Math.hypot(chk.tipX - tipSeq[iPrev].x, chk.tipY - tipSeq[iPrev].y, chk.tipZ - tipSeq[iPrev].z)
            : 0;
          const tNext = iNext >= 0
            ? Math.hypot(chk.tipX - tipSeq[iNext].x, chk.tipY - tipSeq[iNext].y, chk.tipZ - tipSeq[iNext].z)
            : 0;
          const exL = Math.max(0, sPrev - capPrev) + Math.max(0, sNext - capNext);
          const exT = Math.max(0, tPrev - maxTipStepM) + Math.max(0, tNext - maxTipStepM);
          const score =
            desErr * desErr +
            2.2 * (sPrev * sPrev + sNext * sNext) +
            2.8 * (tPrev * tPrev + tNext * tNext) +
            460.0 * exL * exL +
            560.0 * exT * exT;
          if (score < bestScore) {
            bestScore = score;
            bestW.copy(candW);
          }
        };

        evalRelaxCand(worldSeq[f]);
        evalRelaxCand(qDesWorld);
        evalRelaxCand(qMidWorld);
        for (const a of [0.25, 0.5, 0.75]) {
          slerpShortestInto(qCand, worldSeq[f], qDesWorld, a);
          evalRelaxCand(qCand);
          slerpShortestInto(qCand, worldSeq[f], qMidWorld, a);
          evalRelaxCand(qCand);
        }

        if (evalHandWorld(f, qDesWorld).margin < 0 || evalHandWorld(f, qMidWorld).margin < 0 || hasEdgeViol) {
          bDes.copy(zBladeLocal).applyQuaternion(qDesWorld).normalize();
          bMidW.copy(zBladeLocal).applyQuaternion(qMidWorld).normalize();
          bCur.copy(zBladeLocal).applyQuaternion(worldSeq[f]).normalize();
          for (const [baseDir, baseQ] of [
            [bMidW, qMidWorld],
            [bDes, qDesWorld],
            [bCur, worldSeq[f]],
          ]) {
            buildTangentBasis(baseDir, t1, t2);
            for (const rRad of rollOffsetsRad) {
              qRoll.setFromAxisAngle(baseDir, rRad);
              qCandRolled.multiplyQuaternions(qRoll, baseQ).normalize();
              evalRelaxCand(qCandRolled);
            }
            for (const theta of relaxConeRadList) {
              const cT = Math.cos(theta);
              const sT = Math.sin(theta);
              for (let a = 0; a < NUM_AZ; a++) {
                dirCand
                  .copy(baseDir)
                  .multiplyScalar(cT)
                  .addScaledVector(t1, sT * azCos[a])
                  .addScaledVector(t2, sT * azSin[a])
                  .normalize();
                qSwing.setFromUnitVectors(baseDir, dirCand);
                qCand.multiplyQuaternions(qSwing, baseQ).normalize();
                evalRelaxCand(qCand);
              }
            }
          }
        }

        commitFrame(f, bestW);
      }
    }
  }

  if (cyclic && N >= 3) {
    worldSeq[N - 1] = worldSeq[0].clone();
    localSeq[N - 1] = localSeq[0].clone();
    tipSeq[N - 1] = tipSeq[0].clone();
  }

  for (let f = 0; f < N; f++) {
    out[f].quats[BONE_IDX.RightHand].copy(localSeq[f]);
    bones[BONE_IDX.LeftHand].quaternion.copy(out[f].quats[BONE_IDX.LeftHand]);
    bones[BONE_IDX.RightHand].quaternion.copy(out[f].quats[BONE_IDX.RightHand]);
    applyForearmTwistSolver(bones, true, 0.58);
    out[f].quats[BONE_IDX.LeftForeArmTwist].copy(bones[BONE_IDX.LeftForeArmTwist].quaternion);
    out[f].quats[BONE_IDX.RightForeArmTwist].copy(bones[BONE_IDX.RightForeArmTwist].quaternion);
  }

  if (!options._pass || options._pass < 2) {
    let maxActualTipStep = 0;
    for (let f = 1; f < N; f++) {
      const d = tipSeq[f].distanceTo(tipSeq[f - 1]);
      if (d > maxActualTipStep) maxActualTipStep = d;
    }
    if (maxActualTipStep > maxTipStepM) {
      return enforceSwordTorsoClearance(out, minClearanceM, cyclic, {
        ...options,
        _pass: (options._pass || 1) + 1,
      });
    }
  }

  return out;
}

export function normalizeBVHBoneName(rawName = '') {
  return String(rawName)
    .replace(/^.*:/, '')
    .trim()
    .replace(/^(DEF-|ORG-)/i, '')
    .replace(/\.(l|r)$/i, (_, side) => `_${side.toLowerCase()}`);
}

export const BVH_TARGET_CANDIDATES_21 = [
  [BONE_IDX.Hips, [/^(hip|hips|pelvis)$/i, /^root$/i]],
  [BONE_IDX.Spine, [/^(abdomen|spine|spine_01|spine01)$/i, /^lowerback$/i]],
  [
    BONE_IDX.Chest,
    [
      /^(chest|upperchest|upper_chest|spine2|spine_03|spine03|spine_04|spine04|upperback|thorax)$/i,
      /^(spine1|spine_02|spine02)$/i,
    ],
  ],
  [BONE_IDX.Neck, [/^(neck1|neck_01|neck01)$/i, /^neck$/i]],
  [BONE_IDX.Head, [/^(head|head_01|head01)$/i]],
  [
    BONE_IDX.LeftShoulder,
    [/^(lcollar|leftshoulder|left_shoulder|l_shoulder|shoulder_l|l_clavicle|clavicle_l|leftclavicle|left_clavicle)$/i],
  ],
  [
    BONE_IDX.LeftUpperArm,
    [/^(lshldr|leftarm|left_arm|leftupperarm|left_upper_?arm|l_upper_?arm|upper_?arm_l|arm_l|l_arm)$/i],
  ],
  [
    BONE_IDX.LeftForeArm,
    [/^(lforearm|leftforearm|left_forearm|leftlowerarm|left_lower_?arm|l_forearm|forearm_l|l_lower_?arm|lower_?arm_l)$/i],
  ],
  [
    BONE_IDX.LeftHand,
    [/^(lhand|lefthand|left_hand|l_hand|hand_l|lwrist|leftwrist|wrist_l|l_wrist)$/i],
  ],
  [
    BONE_IDX.RightShoulder,
    [/^(rcollar|rightshoulder|right_shoulder|r_shoulder|shoulder_r|r_clavicle|clavicle_r|rightclavicle|right_clavicle)$/i],
  ],
  [
    BONE_IDX.RightUpperArm,
    [/^(rshldr|rightarm|right_arm|rightupperarm|right_upper_?arm|r_upper_?arm|upper_?arm_r|arm_r|r_arm)$/i],
  ],
  [
    BONE_IDX.RightForeArm,
    [/^(rforearm|rightforearm|right_forearm|rightlowerarm|right_lower_?arm|r_forearm|forearm_r|r_lower_?arm|lower_?arm_r)$/i],
  ],
  [
    BONE_IDX.RightHand,
    [/^(rhand|righthand|right_hand|r_hand|hand_r|rwrist|rightwrist|wrist_r|r_wrist)$/i],
  ],
  [
    BONE_IDX.LeftUpLeg,
    [/^(lthigh|leftupleg|left_up_?leg|leftupperleg|left_upper_?leg|upper_?leg_l|l_upper_?leg|leftthigh|left_thigh|l_thigh|thigh_l|l_upleg|upleg_l)$/i],
  ],
  [
    BONE_IDX.LeftLeg,
    [/^(lshin|leftleg|left_leg|leftlowerleg|left_lower_?leg|lower_?leg_l|l_lower_?leg|leftcalf|left_calf|leftshin|left_shin|l_calf|calf_l|l_leg|leg_l|shin_l|l_shin)$/i],
  ],
  [
    BONE_IDX.LeftFoot,
    [/^(lfoot|leftfoot|left_foot|l_foot|foot_l|lankle|leftankle|ankle_l|l_ankle)$/i],
  ],
  [
    BONE_IDX.LeftToe,
    [/^(ltoe|lefttoe|left_toe|lefttoebase|left_toe_?base|lefttoes|l_toe|toe_l|l_ball|ball_l|toebase_l|l_toebase)$/i],
  ],
  [
    BONE_IDX.RightUpLeg,
    [/^(rthigh|rightupleg|right_up_?leg|rightupperleg|right_upper_?leg|upper_?leg_r|r_upper_?leg|rightthigh|right_thigh|r_thigh|thigh_r|r_upleg|upleg_r)$/i],
  ],
  [
    BONE_IDX.RightLeg,
    [/^(rshin|rightleg|right_leg|rightlowerleg|right_lower_?leg|lower_?leg_r|r_lower_?leg|rightcalf|right_calf|rightshin|right_shin|r_calf|calf_r|r_leg|leg_r|shin_r|r_shin)$/i],
  ],
  [
    BONE_IDX.RightFoot,
    [/^(rfoot|rightfoot|right_foot|r_foot|foot_r|rankle|rightankle|ankle_r|r_ankle)$/i],
  ],
  [
    BONE_IDX.RightToe,
    [/^(rtoe|righttoe|right_toe|righttoebase|right_toe_?base|righttoes|r_toe|toe_r|r_ball|ball_r|toebase_r|r_toebase)$/i],
  ],
];

const LIMB_ALIGNMENT_PAIRS = [
  [BONE_IDX.LeftUpperArm, BONE_IDX.LeftForeArm],
  [BONE_IDX.LeftForeArm, BONE_IDX.LeftHand],
  [BONE_IDX.RightUpperArm, BONE_IDX.RightForeArm],
  [BONE_IDX.RightForeArm, BONE_IDX.RightHand],
  [BONE_IDX.LeftUpLeg, BONE_IDX.LeftLeg],
  [BONE_IDX.LeftLeg, BONE_IDX.LeftFoot],
  [BONE_IDX.LeftFoot, BONE_IDX.LeftToe],
  [BONE_IDX.RightUpLeg, BONE_IDX.RightLeg],
  [BONE_IDX.RightLeg, BONE_IDX.RightFoot],
  [BONE_IDX.RightFoot, BONE_IDX.RightToe],
];

/**
 * Uncapped 120fps CMU slice retargeter to 60fps HumanoidRig frames.
 * Enforces start120 >= 1 to exclude cgspeed synthetic frame 0 T-pose.
 */
export function retargetBVHSliceTo60(
  bvhText,
  {
    start120 = 1,
    end120 = null,
    speedScale = 1.0,
    targetFps = 60,
    groundMode = 'upright8th', // 'upright8th' | 'minBody' | 'none'
  } = {}
) {
  if (start120 < 1) {
    throw new Error(`start120 (${start120}) must be >= 1 to exclude cgspeed synthetic frame 0`);
  }
  const loader = new BVHLoader();
  const { clip, skeleton } = loader.parse(bvhText);
  const times = clip.tracks[0]?.times;
  if (!times || times.length < 3) {
    throw new Error('Invalid BVH clip: insufficient keyframe times');
  }
  const srcFrameTime = times[1] - times[0];
  const maxSrcIdx = times.length - 1;
  const sIdx = Math.min(maxSrcIdx - 1, Math.max(1, Math.round(start120)));
  const eIdx = Math.min(maxSrcIdx, Math.max(sIdx + 1, end120 !== null ? Math.round(end120) : maxSrcIdx));

  const cleanBones = skeleton.bones.map((b) => ({
    bone: b,
    cleanName: normalizeBVHBoneName(b.name),
  }));

  const srcByDst = new Array(NUM_BONES).fill(null);
  const usedBones = new Set();
  for (const [dstIdx, regexList] of BVH_TARGET_CANDIDATES_21) {
    for (const regex of regexList) {
      const match = cleanBones.find((entry) => !usedBones.has(entry.bone) && regex.test(entry.cleanName));
      if (match) {
        srcByDst[dstIdx] = match.bone;
        usedBones.add(match.bone);
        break;
      }
    }
  }

  const bvhRoot = skeleton.bones[0];
  bvhRoot.updateWorldMatrix(true, true);

  const { bones: dstBones } = createBoneHierarchy();
  dstBones[0].updateWorldMatrix(true, true);

  const pParentSrc = new THREE.Vector3();
  const pChildSrc = new THREE.Vector3();
  const pParentDst = new THREE.Vector3();
  const pChildDst = new THREE.Vector3();
  const uSrcRest = new THREE.Vector3();
  const uDstRest = new THREE.Vector3();

  const qAlign = new Array(NUM_BONES).fill(null);
  for (const [pIdx, cIdx] of LIMB_ALIGNMENT_PAIRS) {
    const sParent = srcByDst[pIdx];
    const sChild = srcByDst[cIdx];
    if (sParent && sChild) {
      sParent.getWorldPosition(pParentSrc);
      sChild.getWorldPosition(pChildSrc);
      uSrcRest.subVectors(pChildSrc, pParentSrc);

      dstBones[pIdx].getWorldPosition(pParentDst);
      dstBones[cIdx].getWorldPosition(pChildDst);
      uDstRest.subVectors(pChildDst, pParentDst);

      if (uSrcRest.lengthSq() > 1e-6 && uDstRest.lengthSq() > 1e-6) {
        uSrcRest.normalize();
        uDstRest.normalize();
        qAlign[pIdx] = new THREE.Quaternion().setFromUnitVectors(uDstRest, uSrcRest);
      }
    }
  }

  let srcLegLen = 0;
  if (srcByDst[BONE_IDX.LeftUpLeg] && srcByDst[BONE_IDX.LeftLeg] && srcByDst[BONE_IDX.LeftFoot]) {
    srcByDst[BONE_IDX.LeftUpLeg].getWorldPosition(pParentSrc);
    srcByDst[BONE_IDX.LeftLeg].getWorldPosition(pChildSrc);
    srcLegLen += pParentSrc.distanceTo(pChildSrc);
    srcByDst[BONE_IDX.LeftFoot].getWorldPosition(pParentSrc);
    srcLegLen += pChildSrc.distanceTo(pParentSrc);
  }
  const posScale = srcLegLen > 1e-4 ? 0.82 / srcLegLen : 0.0564;
  const srcHips = srcByDst[BONE_IDX.Hips] || bvhRoot;

  const mixer = new THREE.AnimationMixer(bvhRoot);
  const action = mixer.clipAction(clip);
  action.play();

  const sliceDurationSec = (eIdx - sIdx) * srcFrameTime;
  const totalFrames = Math.max(2, Math.round((sliceDurationSec / speedScale) * targetFps));

  const tmpSrcHips = new THREE.Vector3();
  const qWorldSrc = new THREE.Quaternion();
  const qWorldParent = new THREE.Quaternion();
  const tmpFootL = new THREE.Vector3();
  const tmpFootR = new THREE.Vector3();
  const tmpHipsQ = new THREE.Quaternion();
  const tmpUp = new THREE.Vector3();

  const frames = [];
  const uprightAnkleYs = [];
  let minAnkleAnyY = Infinity;
  let minTorsoAnyY = Infinity;

  for (let f = 0; f < totalFrames; f++) {
    const u = totalFrames > 1 ? f / (totalFrames - 1) : 0;
    const t = (sIdx + u * (eIdx - sIdx)) * srcFrameTime;
    mixer.setTime(t);
    bvhRoot.updateWorldMatrix(true, true);

    srcHips.getWorldPosition(tmpSrcHips);
    const frame = emptyFrame();
    frame.rootPos.set(tmpSrcHips.x * posScale, tmpSrcHips.y * posScale, tmpSrcHips.z * posScale);
    dstBones[0].position.copy(frame.rootPos);

    for (let b = 0; b < NUM_BONES; b++) {
      const srcBone = srcByDst[b];
      if (srcBone) {
        srcBone.getWorldQuaternion(qWorldSrc);
        if (qAlign[b]) {
          qWorldSrc.multiply(qAlign[b]);
        }
        if (b === 0) {
          dstBones[0].quaternion.copy(qWorldSrc);
        } else {
          dstBones[b].parent.getWorldQuaternion(qWorldParent);
          dstBones[b].quaternion.copy(qWorldParent).invert().multiply(qWorldSrc);
        }
      } else {
        dstBones[b].quaternion.identity();
      }
      dstBones[b].updateWorldMatrix(false, false);
      frame.quats[b].copy(dstBones[b].quaternion);
    }

    dstBones[0].updateWorldMatrix(true, true);
    dstBones[BONE_IDX.LeftFoot].getWorldPosition(tmpFootL);
    dstBones[BONE_IDX.RightFoot].getWorldPosition(tmpFootR);
    dstBones[BONE_IDX.Hips].getWorldQuaternion(tmpHipsQ);
    tmpUp.set(0, 1, 0).applyQuaternion(tmpHipsQ);

    const lowAnkle = Math.min(tmpFootL.y, tmpFootR.y);
    minAnkleAnyY = Math.min(minAnkleAnyY, lowAnkle);
    if (tmpUp.y > 0.75) {
      uprightAnkleYs.push(lowAnkle);
    }

    dstBones[BONE_IDX.Chest].getWorldPosition(tmpUp);
    minTorsoAnyY = Math.min(minTorsoAnyY, frame.rootPos.y, tmpUp.y);

    frames.push(frame);
  }

  let yShift = 0;
  if (groundMode === 'upright8th') {
    if (uprightAnkleYs.length >= 4) {
      yShift = 0.08 - percentile(uprightAnkleYs, 0.08);
    } else if (Number.isFinite(minAnkleAnyY)) {
      yShift = 0.08 - minAnkleAnyY;
    }
  } else if (groundMode === 'minBody') {
    yShift = Number.isFinite(minTorsoAnyY) ? 0.175 - minTorsoAnyY : 0;
  }

  if (yShift !== 0) {
    for (const fr of frames) {
      fr.rootPos.y += yShift;
    }
  }

  return frames;
}
