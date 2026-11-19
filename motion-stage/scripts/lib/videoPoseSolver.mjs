import * as THREE from 'three';
import { BONE_DEFS, BONE_IDX, createBoneHierarchy } from '../../src/rig/HumanoidRig.js';
import {
  cloneFrame,
  percentile,
  filterFramesZeroPhase,
  upsampleFramesSlerp,
  closeLoopAndStabilizeRoot,
  lockFeetWithTwoBoneIK,
  applyCapsuleFloorClearance,
  enforceSwordTorsoClearance,
} from './motionPipeline.mjs';

const NUM_BONES = BONE_DEFS.length;

/**
 * Converts MediaPipe 33 worldLandmarks (+x right, +y down, +z away) + 2D normalized landmarks
 * into Three.js right-handed world space (+X left-of-body, +Y up, +Z toward camera)
 * with 6-DoF radial wrist roll calibrated to zBlade = (-0.619, 0.754, 0.219) and chest anti-penetration.
 */
export function landmarksToHumanoidFrame(worldLm, normLm) {
  const P = worldLm.map((p) => new THREE.Vector3(p.x, -p.y, -p.z));

  const { bones } = createBoneHierarchy();
  const quats = Array.from({ length: NUM_BONES }, () => new THREE.Quaternion());

  const vX = new THREE.Vector3();
  const vY = new THREE.Vector3();
  const vZ = new THREE.Vector3();
  const mat = new THREE.Matrix4();
  const qParentInv = new THREE.Quaternion();

  const setBoneWorldQuat = (boneIdx, qWorld) => {
    const b = bones[boneIdx];
    if (boneIdx === 0) {
      b.quaternion.copy(qWorld);
    } else {
      b.parent.getWorldQuaternion(qParentInv).invert();
      b.quaternion.multiplyQuaternions(qParentInv, qWorld);
    }
    b.updateWorldMatrix(false, false);
    quats[boneIdx].copy(b.quaternion);
  };

  // 1. Pelvis / Hips (23 = LeftHip, 24 = RightHip)
  const hipCenter = new THREE.Vector3().addVectors(P[23], P[24]).multiplyScalar(0.5);
  const shCenter = new THREE.Vector3().addVectors(P[11], P[12]).multiplyScalar(0.5);

  vX.subVectors(P[23], P[24]).normalize();
  vY.subVectors(shCenter, hipCenter).normalize();
  vZ.crossVectors(vX, vY);
  if (vZ.lengthSq() < 1e-5) vZ.set(0, 0, 1);
  vZ.normalize();
  vY.crossVectors(vZ, vX).normalize();

  mat.makeBasis(vX, vY, vZ);
  const qHipsWorld = new THREE.Quaternion().setFromRotationMatrix(mat);
  setBoneWorldQuat(BONE_IDX.Hips, qHipsWorld);

  // 2. Spine & Chest (11 = LeftShoulder, 12 = RightShoulder)
  const cX = new THREE.Vector3().subVectors(P[11], P[12]).normalize();
  const cY = new THREE.Vector3().subVectors(shCenter, hipCenter).normalize();
  const cZ = new THREE.Vector3().crossVectors(cX, cY);
  if (cZ.lengthSq() < 1e-5) cZ.copy(vZ);
  cZ.normalize();
  cY.crossVectors(cZ, cX).normalize();
  mat.makeBasis(cX, cY, cZ);
  const qChestWorld = new THREE.Quaternion().setFromRotationMatrix(mat);
  const qSpineWorld = qHipsWorld.clone().slerp(qChestWorld, 0.45);

  setBoneWorldQuat(BONE_IDX.Spine, qSpineWorld);
  setBoneWorldQuat(BONE_IDX.Chest, qChestWorld);

  // 3. Neck & Head (7 = LeftEar, 8 = RightEar, 0 = Nose)
  const earMid = new THREE.Vector3().addVectors(P[7], P[8]).multiplyScalar(0.5);
  const hX = new THREE.Vector3().subVectors(P[7], P[8]).normalize();
  const hZ = new THREE.Vector3().subVectors(P[0], earMid);
  if (hZ.lengthSq() < 1e-5) hZ.copy(cZ);
  hZ.normalize();
  const hY = new THREE.Vector3().crossVectors(hZ, hX).normalize();
  hZ.crossVectors(hX, hY).normalize();
  mat.makeBasis(hX, hY, hZ);
  const qHeadWorld = new THREE.Quaternion().setFromRotationMatrix(mat);
  setBoneWorldQuat(BONE_IDX.Neck, qChestWorld.clone().slerp(qHeadWorld, 0.4));
  setBoneWorldQuat(BONE_IDX.Head, qHeadWorld);

  const restLeft = new THREE.Vector3(1, 0, 0);
  const restRight = new THREE.Vector3(-1, 0, 0);
  const restDown = new THREE.Vector3(0, -1, 0);
  const segDir = new THREE.Vector3();

  const alignLimbSegment = (boneIdx, pStart, pEnd, restVec, fallbackQuat) => {
    segDir.subVectors(pEnd, pStart);
    if (segDir.lengthSq() < 1e-5) {
      setBoneWorldQuat(boneIdx, fallbackQuat);
      return fallbackQuat.clone();
    }
    segDir.normalize();
    const qSwing = new THREE.Quaternion().setFromUnitVectors(restVec, segDir);
    setBoneWorldQuat(boneIdx, qSwing);
    return qSwing;
  };

  // 4A. Left Arm + 6-DoF LeftHand
  bones[BONE_IDX.LeftShoulder].quaternion.identity();
  bones[BONE_IDX.LeftShoulder].updateWorldMatrix(false, false);
  const qLUA = alignLimbSegment(BONE_IDX.LeftUpperArm, P[11], P[13], restLeft, qChestWorld);
  alignLimbSegment(BONE_IDX.LeftForeArm, P[13], P[15], restLeft, qLUA);
  {
    const foreDirL = new THREE.Vector3().subVectors(P[15], P[13]);
    if (foreDirL.lengthSq() < 1e-5) foreDirL.set(1, 0, 0);
    foreDirL.normalize();

    const handDirL = new THREE.Vector3().addVectors(P[17], P[19]).multiplyScalar(0.5).sub(P[15]);
    if (handDirL.lengthSq() < 1e-5) {
      handDirL.copy(foreDirL);
    } else {
      handDirL.normalize().lerp(foreDirL, 0.25).normalize();
    }

    const radialL = new THREE.Vector3()
      .copy(P[19])
      .multiplyScalar(0.6)
      .addScaledVector(P[21], 0.4)
      .sub(P[17]);
    radialL.addScaledVector(handDirL, -radialL.dot(handDirL));
    if (radialL.lengthSq() < 1e-5) {
      radialL.set(0, 1, 0).addScaledVector(handDirL, -handDirL.y);
    }
    if (radialL.lengthSq() < 1e-5) radialL.set(0, 0, 1);
    radialL.normalize();

    const zHandL = new THREE.Vector3().crossVectors(handDirL, radialL).normalize();
    mat.makeBasis(handDirL, radialL, zHandL);
    setBoneWorldQuat(BONE_IDX.LeftHand, new THREE.Quaternion().setFromRotationMatrix(mat));
  }

  // 4B. Right Arm + 6-DoF RightHand calibrated to Wuxia Sword radial grip + Chest Anti-Penetration
  bones[BONE_IDX.RightShoulder].quaternion.identity();
  bones[BONE_IDX.RightShoulder].updateWorldMatrix(false, false);
  const qRUA = alignLimbSegment(BONE_IDX.RightUpperArm, P[12], P[14], restRight, qChestWorld);
  alignLimbSegment(BONE_IDX.RightForeArm, P[14], P[16], restRight, qRUA);
  {
    const foreDirR = new THREE.Vector3().subVectors(P[16], P[14]);
    if (foreDirR.lengthSq() < 1e-5) foreDirR.set(-1, 0, 0);
    foreDirR.normalize();

    const handDirR = new THREE.Vector3().addVectors(P[18], P[20]).multiplyScalar(0.5).sub(P[16]);
    if (handDirR.lengthSq() < 1e-5) {
      handDirR.copy(foreDirR);
    } else {
      handDirR.normalize().lerp(foreDirR, 0.25).normalize();
    }

    const radialR = new THREE.Vector3()
      .copy(P[20])
      .multiplyScalar(0.6)
      .addScaledVector(P[22], 0.4)
      .sub(P[18]);
    radialR.addScaledVector(handDirR, -radialR.dot(handDirR));
    if (radialR.lengthSq() < 1e-5) {
      radialR.set(0, 1, 0).addScaledVector(handDirR, -handDirR.y);
    }
    if (radialR.lengthSq() < 1e-5) radialR.set(0, 0, 1);
    radialR.normalize();

    const torsoCenter = new THREE.Vector3().lerpVectors(hipCenter, shCenter, 0.65);
    const outFromBody = new THREE.Vector3().subVectors(P[16], torsoCenter);
    const outLen = outFromBody.length();
    const outDir = outLen > 1e-4 ? outFromBody.clone().divideScalar(outLen) : cZ.clone();
    const proxW = 1.0 - THREE.MathUtils.smoothstep(outLen, 0.36, 0.68);
    if (proxW > 1e-4) {
      const bladeDir = new THREE.Vector3()
        .copy(handDirR)
        .multiplyScalar(0.619)
        .addScaledVector(radialR, 0.785)
        .normalize();
      const inwardDot = bladeDir.dot(outDir);
      const inwardW = 1.0 - THREE.MathUtils.smoothstep(inwardDot, -0.35, 0.18);
      const guardW = 0.75 * proxW * inwardW;
      if (guardW > 1e-4) {
        const safeOut = outDir.clone().add(new THREE.Vector3(0, 0.45, 0.25));
        safeOut.addScaledVector(handDirR, -safeOut.dot(handDirR));
        if (safeOut.lengthSq() > 1e-4) {
          safeOut.normalize();
          radialR.lerp(safeOut, guardW).addScaledVector(handDirR, -radialR.dot(handDirR));
          if (radialR.lengthSq() > 1e-5) radialR.normalize();
        }
      }
    }

    const eX = handDirR.clone().negate();
    const bPerp = new THREE.Vector3().crossVectors(eX, radialR).normalize();
    const colY = new THREE.Vector3()
      .copy(radialR)
      .multiplyScalar(0.9600)
      .addScaledVector(bPerp, -0.2788)
      .normalize();
    const colZ = new THREE.Vector3().crossVectors(eX, colY).normalize();
    mat.makeBasis(eX, colY, colZ);
    setBoneWorldQuat(BONE_IDX.RightHand, new THREE.Quaternion().setFromRotationMatrix(mat));
  }

  // 5. Left & Right Legs (shared singularity-free pelvis-swing knee-hinge basis matching solveTwoBoneLegIK)
  const solveLegFromLandmarks = (upIdx, loIdx, ftIdx, pHip, pKnee, pAnkle, pHeel, pToe) => {
    const yUpper = new THREE.Vector3().subVectors(pHip, pKnee);
    if (yUpper.lengthSq() < 1e-5) yUpper.copy(vY);
    else yUpper.normalize();

    // Minimal swing from pelvis +vY to thigh yUpper (smooth across standing, kicks, lunges, and splits)
    let qSwingThigh;
    const dotUp = THREE.MathUtils.clamp(vY.dot(yUpper), -1, 1);
    if (dotUp < -0.92) {
      qSwingThigh = new THREE.Quaternion().setFromAxisAngle(vX, -Math.acos(dotUp));
    } else {
      qSwingThigh = new THREE.Quaternion().setFromUnitVectors(vY, yUpper);
    }
    const xBase = vX.clone().applyQuaternion(qSwingThigh).normalize();
    const zBase = new THREE.Vector3().crossVectors(xBase, yUpper).normalize();

    // Stabilize monocular heel->toe forward cue against pelvis forward vZ
    const rawFootFwd = new THREE.Vector3().subVectors(pToe, pHeel);
    const footFwd = vZ.clone();
    if (rawFootFwd.lengthSq() > 1e-5) {
      rawFootFwd.normalize();
      const fwdAgree = THREE.MathUtils.smoothstep(rawFootFwd.dot(vZ), -0.25, 0.35);
      footFwd.lerp(rawFootFwd, fwdAgree * 0.72).normalize();
    }

    // Subtle bounded hip external/internal rotation from knee-bend + foot plane (never flips >33 deg)
    const midHipAnkle = new THREE.Vector3().addVectors(pHip, pAnkle).multiplyScalar(0.5);
    const obsPole = new THREE.Vector3()
      .subVectors(pKnee, midHipAnkle)
      .addScaledVector(footFwd, 0.08);
    obsPole.addScaledVector(yUpper, -obsPole.dot(yUpper));
    const obsLen = obsPole.length();
    const zUpper = zBase.clone();
    if (obsLen > 1e-4) {
      obsPole.divideScalar(obsLen);
      const twistW =
        THREE.MathUtils.smoothstep(obsLen, 0.03, 0.12) *
        THREE.MathUtils.smoothstep(obsPole.dot(zBase), -0.15, 0.35) *
        0.52;
      zUpper.lerp(obsPole, twistW);
      zUpper.addScaledVector(yUpper, -zUpper.dot(yUpper));
      if (zUpper.lengthSq() > 1e-5) zUpper.normalize();
      else zUpper.copy(zBase);
    }
    const xUpper = new THREE.Vector3().crossVectors(yUpper, zUpper).normalize();
    zUpper.crossVectors(xUpper, yUpper).normalize();
    mat.makeBasis(xUpper, yUpper, zUpper);
    const qUp = new THREE.Quaternion().setFromRotationMatrix(mat);
    setBoneWorldQuat(upIdx, qUp);

    // Lower leg shares xUpper knee-hinge axis (zero 180-deg shin twist) with hyperextension clamp
    const yLower = new THREE.Vector3().subVectors(pKnee, pAnkle);
    if (yLower.lengthSq() < 1e-5) yLower.copy(yUpper);
    else yLower.normalize();
    const hyper = yLower.dot(zUpper);
    if (hyper < -0.03) {
      yLower.addScaledVector(zUpper, -hyper - 0.03).normalize();
    }
    const xLower = xUpper.clone().addScaledVector(yLower, -xUpper.dot(yLower));
    if (xLower.lengthSq() < 1e-5) xLower.copy(xUpper);
    else xLower.normalize();
    const zLower = new THREE.Vector3().crossVectors(xLower, yLower).normalize();
    mat.makeBasis(xLower, yLower, zLower);
    const qLo = new THREE.Quaternion().setFromRotationMatrix(mat);
    setBoneWorldQuat(loIdx, qLo);

    // Foot uses shared ankle hinge axis xLower (avoids world-up cross singularity on steep kicks/splits)
    const fZ = zLower.clone().lerp(footFwd, 0.55);
    if (fZ.dot(zLower) < 0.25) {
      fZ.lerp(zLower, 0.65);
    }
    if (fZ.lengthSq() < 1e-5) fZ.copy(zLower);
    else fZ.normalize();
    const fY = new THREE.Vector3().crossVectors(fZ, xLower);
    if (fY.lengthSq() < 1e-5) fY.copy(yLower);
    else fY.normalize();
    const fX = new THREE.Vector3().crossVectors(fY, fZ).normalize();
    fY.crossVectors(fZ, fX).normalize();
    mat.makeBasis(fX, fY, fZ);
    setBoneWorldQuat(ftIdx, new THREE.Quaternion().setFromRotationMatrix(mat));
  };

  solveLegFromLandmarks(
    BONE_IDX.LeftUpLeg,
    BONE_IDX.LeftLeg,
    BONE_IDX.LeftFoot,
    P[23],
    P[25],
    P[27],
    P[29],
    P[31]
  );
  solveLegFromLandmarks(
    BONE_IDX.RightUpLeg,
    BONE_IDX.RightLeg,
    BONE_IDX.RightFoot,
    P[24],
    P[26],
    P[28],
    P[30],
    P[32]
  );

  let rx = 0;
  let ry = 0.94;
  let imgMeta = null;
  if (normLm) {
    const imgHipX = (normLm[23].x + normLm[24].x) * 0.5;
    const imgHipY = (normLm[23].y + normLm[24].y) * 0.5;
    const imgShX = (normLm[11].x + normLm[12].x) * 0.5;
    const imgShY = (normLm[11].y + normLm[12].y) * 0.5;
    const legLenL =
      Math.hypot(normLm[23].x - normLm[25].x, normLm[23].y - normLm[25].y) +
      Math.hypot(normLm[25].x - normLm[27].x, normLm[25].y - normLm[27].y);
    const legLenR =
      Math.hypot(normLm[24].x - normLm[26].x, normLm[24].y - normLm[26].y) +
      Math.hypot(normLm[26].x - normLm[28].x, normLm[26].y - normLm[28].y);
    const lowestAnkleY = Math.max(
      normLm[27].y,
      normLm[28].y,
      normLm[29]?.y ?? normLm[27].y,
      normLm[30]?.y ?? normLm[28].y
    );
    const torsoNorm = Math.hypot(imgShX - imgHipX, imgShY - imgHipY);

    rx = (imgHipX - 0.5) * 1.35;
    ry = 0.94 + (0.55 - imgHipY) * 0.85;
    imgMeta = {
      hipX: imgHipX,
      hipY: imgHipY,
      lowestAnkleY,
      maxLegNorm: Math.max(legLenL, legLenR),
      torsoNorm,
    };
  }

  return {
    rootPos: new THREE.Vector3(rx, ry, 0),
    quats,
    contactL: null,
    contactR: null,
    _imgMeta: imgMeta,
  };
}

function cloneFrameWithMeta(fr) {
  const c = cloneFrame(fr);
  if (fr._imgMeta) {
    c._imgMeta = { ...fr._imgMeta };
  }
  return c;
}

/**
 * Backfills leading undetected frames (e.g. 04 frames 0..1) from the first valid frame
 * and forward-fills any subsequent missed frames so exact native frame count is preserved.
 */
export function backfillMissingFrames(rawSlots) {
  const firstValidIdx = rawSlots.findIndex(Boolean);
  if (firstValidIdx < 0) {
    throw new Error('Zero valid human pose frames detected across video clip');
  }
  const filled = new Array(rawSlots.length);
  for (let i = 0; i < firstValidIdx; i++) {
    filled[i] = cloneFrameWithMeta(rawSlots[firstValidIdx]);
  }
  let lastValid = rawSlots[firstValidIdx];
  for (let i = firstValidIdx; i < rawSlots.length; i++) {
    if (rawSlots[i]) {
      lastValid = rawSlots[i];
      filled[i] = cloneFrameWithMeta(lastValid);
    } else {
      filled[i] = cloneFrameWithMeta(lastValid);
    }
  }
  return filled;
}

/**
 * Mode-aware metric sequence calibration (m2_explorer_1 §2.3):
 * - allowAerial === false (01b, 02, 03): airClearance = 0 (eliminates camera-dolly & perspective levitation).
 * - allowAerial === true (04 Feiyan): detrends diagonal upstage->downstage floor line and gates out
 *   end-of-split carpet bounce via hipY > medianHipY + 0.08 while preserving +0.85m whirlwind jump apex.
 */
export function calibrateVideoSequenceMetrics(
  frames,
  { allowAerial = false, anchorStartXZ = false } = {}
) {
  if (!frames || frames.length === 0) return;
  const N = frames.length;
  const validMeta = frames.map((f) => f._imgMeta).filter(Boolean);
  const { bones } = createBoneHierarchy();
  const pL = new THREE.Vector3();
  const pR = new THREE.Vector3();

  if (validMeta.length < 3) {
    let minFootY = Infinity;
    for (const fr of frames) {
      bones[0].position.copy(fr.rootPos);
      for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(fr.quats[b]);
      bones[0].updateWorldMatrix(true, true);
      bones[BONE_IDX.LeftFoot].getWorldPosition(pL);
      bones[BONE_IDX.RightFoot].getWorldPosition(pR);
      minFootY = Math.min(minFootY, pL.y, pR.y);
      delete fr._imgMeta;
    }
    const yOffset = Number.isFinite(minFootY) ? 0.08 - minFootY : 0;
    for (const fr of frames) fr.rootPos.y += yOffset;
    return;
  }

  const refLegNorm = THREE.MathUtils.clamp(
    percentile(
      validMeta.map((m) => m.maxLegNorm),
      0.75
    ),
    0.16,
    0.68
  );
  const pxPerMeter = refLegNorm / 0.82;
  const centerHipNormX = percentile(
    validMeta.map((m) => m.hipX),
    0.5
  );
  const medianTorsoNorm = Math.max(
    0.08,
    percentile(
      validMeta.map((m) => m.torsoNorm),
      0.5
    )
  );

  const startCount = Math.max(3, Math.min(9, Math.round(N * 0.21)));
  const endStartIdx = Math.max(0, N - Math.max(3, Math.min(12, Math.round(N * 0.28))));
  const gStart = percentile(
    frames
      .slice(0, startCount)
      .map((f) => f._imgMeta?.lowestAnkleY)
      .filter((v) => v !== undefined),
    0.80
  );
  const gEnd = percentile(
    frames
      .slice(endStartIdx)
      .map((f) => f._imgMeta?.lowestAnkleY)
      .filter((v) => v !== undefined),
    0.80
  );
  const medianHipY = percentile(
    validMeta.map((m) => m.hipY),
    0.50
  );

  // Precompute relative foot Y and baseline standing hip normY/ry for two-leg aerial jump-tuck detection
  const relMinFootYs = new Float64Array(N);
  const groundedSamples = [];
  for (let i = 0; i < N; i++) {
    const fr = frames[i];
    bones[0].position.set(0, 0, 0);
    for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(fr.quats[b]);
    bones[0].updateWorldMatrix(true, true);
    bones[BONE_IDX.LeftFoot].getWorldPosition(pL);
    bones[BONE_IDX.RightFoot].getWorldPosition(pR);
    const relMinFootY = Math.min(pL.y, pR.y);
    relMinFootYs[i] = relMinFootY;
    if (fr._imgMeta && relMinFootY <= -0.60) {
      groundedSamples.push({ hipY: fr._imgMeta.hipY, ry: 0.08 - relMinFootY });
    }
  }

  const groundedHipNormY =
    groundedSamples.length > 0
      ? percentile(
          groundedSamples.map((s) => s.hipY),
          0.50
        )
      : medianHipY;
  const groundedRy =
    groundedSamples.length > 0
      ? percentile(
          groundedSamples.map((s) => s.ry),
          0.50
        )
      : 0.88;

  for (let i = 0; i < N; i++) {
    const fr = frames[i];
    const relMinFootY = relMinFootYs[i];

    if (fr._imgMeta) {
      const m = fr._imgMeta;
      const rx = THREE.MathUtils.clamp((m.hipX - centerHipNormX) / pxPerMeter, -1.65, 1.65);
      const rz = THREE.MathUtils.clamp((m.torsoNorm / medianTorsoNorm - 1.0) * 0.9, -0.4, 0.4);

      let ry;
      if (allowAerial) {
        const u = N > 1 ? i / (N - 1) : 0;
        const localGroundY = THREE.MathUtils.lerp(gStart, gEnd, u);
        let airClearance = 0;
        if (m.hipY > medianHipY + 0.08) {
          // Split-landing ground gate: actor is seated/splitting low on carpet
          airClearance = 0;
        } else {
          const rawLift = (localGroundY - m.lowestAnkleY - 0.02) / pxPerMeter;
          const hipLiftGate = THREE.MathUtils.smoothstep(medianHipY - m.hipY, 0.02, 0.12);
          airClearance = THREE.MathUtils.clamp(rawLift * hipLiftGate, 0, 0.85);
        }
        ry = 0.08 + airClearance - relMinFootY;
      } else {
        const baseRy = 0.08 - relMinFootY;
        // Smooth two-leg aerial jump-tuck gate (e.g. taibai_03 spin-kick where both legs tuck near hip height;
        // independent of global hipY drift as performer advances toward camera)
        const tuckGate = THREE.MathUtils.smoothstep(relMinFootY, -0.58, -0.36);
        const jumpRy = Math.max(
          0.78,
          groundedRy + THREE.MathUtils.clamp((groundedHipNormY - m.hipY) / pxPerMeter, -0.06, 0.45)
        );
        ry = Math.max(0.58, THREE.MathUtils.lerp(baseRy, Math.max(baseRy, jumpRy), tuckGate));
      }

      fr.rootPos.set(rx, ry, rz);
    } else {
      fr.rootPos.y = Math.max(allowAerial ? 0.14 : 0.58, 0.08 - relMinFootY);
    }
    delete fr._imgMeta;
  }

  if (anchorStartXZ && frames.length > 0) {
    const x0 = frames[0].rootPos.x;
    const z0 = frames[0].rootPos.z;
    for (const fr of frames) {
      fr.rootPos.x -= x0;
      fr.rootPos.z -= z0;
    }
  }
}

function quatDeg(a, b) {
  const dot = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w));
  return (2 * Math.acos(dot) * 180) / Math.PI;
}

function slerpShortest(a, b, t) {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const tgt = dot < 0 ? new THREE.Quaternion(-b.x, -b.y, -b.z, -b.w) : b;
  return a.clone().slerp(tgt, t).normalize();
}

const ANATOMICAL_JOINTS_19 = [
  BONE_IDX.Hips,
  BONE_IDX.Spine,
  BONE_IDX.Chest,
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
  BONE_IDX.LeftUpLeg,
  BONE_IDX.LeftLeg,
  BONE_IDX.LeftFoot,
  BONE_IDX.RightUpLeg,
  BONE_IDX.RightLeg,
  BONE_IDX.RightFoot,
];

/**
 * Despikes 1..2 frame MediaPipe monocular depth inversions across all 19 anatomical joints at 24fps
 * and bounds 24fps local rotational velocity while preserving full 6-DoF martial-arts flourishes.
 */
export function regularizeVideoJointContinuity24(frames, cyclic = false, maxStep24Deg = 52) {
  if (!frames || frames.length < 3) return frames;
  const N = frames.length;

  for (const b of ANATOMICAL_JOINTS_19) {
    // 1. 1-frame depth-flip outlier despiker
    const start1 = cyclic ? 0 : 1;
    const end1 = cyclic ? N : N - 1;
    for (let i = start1; i < end1; i++) {
      const iPrev = (i - 1 + N) % N;
      const iNext = (i + 1) % N;
      const qPrev = frames[iPrev].quats[b];
      const qCur = frames[i].quats[b];
      const qNext = frames[iNext].quats[b];
      if (quatDeg(qPrev, qCur) > 58 && quatDeg(qCur, qNext) > 58 && quatDeg(qPrev, qNext) < 55) {
        frames[i].quats[b].copy(slerpShortest(qPrev, qNext, 0.5));
      }
    }

    // 2. 2-frame isolated depth-flip outlier despiker
    if (N >= 5) {
      const end2 = cyclic ? N : N - 2;
      for (let i = start1; i < end2; i++) {
        const iPrev = (i - 1 + N) % N;
        const i1 = (i + 1) % N;
        const iNext = (i + 2) % N;
        const qPrev = frames[iPrev].quats[b];
        const q0 = frames[i].quats[b];
        const q1 = frames[i1].quats[b];
        const qNext = frames[iNext].quats[b];
        if (quatDeg(qPrev, q0) > 62 && quatDeg(q1, qNext) > 62 && quatDeg(qPrev, qNext) < 56) {
          frames[i].quats[b].copy(slerpShortest(qPrev, qNext, 1 / 3));
          frames[i1].quats[b].copy(slerpShortest(qPrev, qNext, 2 / 3));
        }
      }
    }

    // 3. Anatomical 24fps angular velocity bound
    const passes = cyclic ? 2 : 1;
    let prevQ = frames[cyclic ? N - 1 : 0].quats[b].clone();
    for (let p = 0; p < passes; p++) {
      const sIdx = cyclic ? 0 : 1;
      for (let i = sIdx; i < N; i++) {
        const curQ = frames[i].quats[b];
        const deg = quatDeg(prevQ, curQ);
        if (deg > maxStep24Deg) {
          curQ.copy(slerpShortest(prevQ, curQ, maxStep24Deg / deg));
        }
        prevQ.copy(curQ);
      }
    }
  }
  return frames;
}

/**
 * Runs complete Order B pipeline on raw MediaPipe per-frame landmark detections:
 * 24fps solve & backfill -> mode-aware metric calibration -> 24fps temporal continuity & zero-phase filter ->
 * hemisphere-aligned slerp/lerp upsample to 60fps -> r=1 60fps polish ->
 * optional cyclic loop closure + Two-Bone IK foot-lock -> capsule & sword clearance.
 */
export function processExtractedVideoSequence(rawDetections, clipConfig) {
  const {
    target60Frames,
    cyclic = false,
    stabilizeInPlace = false,
    preserveRootMotion = true,
    allowAerial = false,
    filterRadius24 = 2,
    contactHeightThresh = 0.155,
    contactVelThresh = 1.05,
    forceBothFeetGrounded = false,
    hasWeapon = true,
  } = clipConfig;

  const rawSlots = rawDetections.map((det) =>
    det && det.worldLm && det.worldLm.length >= 33
      ? landmarksToHumanoidFrame(det.worldLm, det.normLm || null)
      : null
  );

  let filled24 = backfillMissingFrames(rawSlots);
  calibrateVideoSequenceMetrics(filled24, {
    allowAerial,
    anchorStartXZ: preserveRootMotion && !stabilizeInPlace,
  });

  // For cyclic clips (e.g. taibai_01b), close the 24fps boundary seam FIRST so cyclic zero-phase filtering
  // never smears an open-loop start/end pose jump across frames 0..3.
  if (cyclic) {
    filled24 = closeLoopAndStabilizeRoot(filled24, stabilizeInPlace, 0.30, preserveRootMotion);
  }
  regularizeVideoJointContinuity24(filled24, cyclic, cyclic && stabilizeInPlace ? 12 : 44);

  // Order B Stage 1: Zero-phase filter at native 24fps (preserves fast slash/kick peaks)
  const filtered24 = filterFramesZeroPhase(filled24, filterRadius24, cyclic);

  // Order B Stage 2: Upsample to 60fps + r=1 polish
  let frames60 = upsampleFramesSlerp(filtered24, target60Frames);
  frames60 = filterFramesZeroPhase(frames60, cyclic && stabilizeInPlace ? 2 : 1, cyclic);

  // Order B Stage 3: Cyclic loop closure on root & posture before IK
  if (cyclic) {
    frames60 = closeLoopAndStabilizeRoot(frames60, stabilizeInPlace, 0.20, preserveRootMotion);
  }

  // Order B Stage 4: 60fps Analytic Two-Bone IK foot-lock with split-safe minPelvisY guard
  const minPelvisY = allowAerial ? undefined : 0.54;
  frames60 = lockFeetWithTwoBoneIK(frames60, 60, cyclic, {
    contactHeightThresh,
    contactVelThresh,
    forceBothFeetGrounded,
    floorY: 0.08,
    maxRampFrames: 3,
    keepFootFlat: true,
    minPelvisY,
  });

  // Bound 60fps upper-body / limb local steps cleanly before sword clearance
  const calmIdle = cyclic && stabilizeInPlace;
  const maxJointStep60 = calmIdle ? 6.0 : 27.0;
  for (let pass = 0; pass < 28; pass++) {
    let maxV = 0;
    const M = cyclic && frames60.length >= 3 ? frames60.length - 1 : frames60.length;
    const edges = cyclic && frames60.length >= 3 ? M : frames60.length - 1;
    for (const b of ANATOMICAL_JOINTS_19) {
      if (b === BONE_IDX.LeftUpLeg || b === BONE_IDX.LeftLeg || b === BONE_IDX.RightUpLeg || b === BONE_IDX.RightLeg) {
        continue; // Keep exact Two-Bone IK leg lock positions
      }
      for (let e = 0; e < edges; e++) {
        const i0 = e;
        const i1 = cyclic && frames60.length >= 3 ? (e + 1) % M : e + 1;
        const cap = !cyclic && e === edges - 1 ? Math.min(maxJointStep60, 18.0) : maxJointStep60;
        const q0 = frames60[i0].quats[b];
        const q1 = frames60[i1].quats[b];
        const deg = quatDeg(q0, q1);
        if (deg > cap) {
          const v = deg - cap;
          if (v > maxV) maxV = v;
          const frac = 0.52 * (v / deg);
          const n0 = slerpShortest(q0, q1, frac);
          const n1 = slerpShortest(q1, q0, frac);
          q0.copy(n0);
          q1.copy(n1);
        }
      }
      if (cyclic && frames60.length >= 3) {
        frames60[frames60.length - 1].quats[b].copy(frames60[0].quats[b]);
      }
    }
    if (maxV < 1e-3) break;
  }

  // Order B Stage 5: 21-bone capsule floor clearance + Wuxia greatsword torso & head/neck clearance
  frames60 = applyCapsuleFloorClearance(frames60, { cyclic });
  if (hasWeapon) {
    frames60 = enforceSwordTorsoClearance(frames60, 0.245, cyclic, { calmIdle });
  }
  if (cyclic) {
    // Close upper-body seam if sword clearance adjusted RightHand, then re-lock feet for 0.00cm/s slip
    frames60 = closeLoopAndStabilizeRoot(frames60, false, 0.12, preserveRootMotion);
    frames60 = lockFeetWithTwoBoneIK(frames60, 60, cyclic, {
      contactHeightThresh,
      contactVelThresh,
      forceBothFeetGrounded,
      floorY: 0.08,
      maxRampFrames: 3,
      keepFootFlat: true,
      minPelvisY,
    });
  }

  return frames60;
}
