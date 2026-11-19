import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { BONE_IDX, buildCharacterRig } from '../../src/rig/HumanoidRig.js';
import {
  CANONICAL_HIERARCHY_SHA256,
  CANONICAL_HIERARCHY_LINE_COUNT,
  CANONICAL_HIERARCHY_BYTE_LENGTH,
  JOINT_ORDER_21,
} from './bvhSerializer.mjs';
import {
  DRIVE_FOLDER_02C_ID,
  IMMUTABLE_B_CLEANED_01_06,
  IMMUTABLE_A_RAW_BASELINE,
  REFERENCE_VIDEOS_SPEC,
  CLIP_CATALOG_26,
} from './manifestCatalog.mjs';

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function segmentToPointDistCm(a, b, p) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ap = new THREE.Vector3().subVectors(p, a);
  const lenSq = ab.lengthSq();
  if (lenSq < 1e-8) return a.distanceTo(p);
  const t = THREE.MathUtils.clamp(ap.dot(ab) / lenSq, 0, 1);
  const closest = new THREE.Vector3().copy(a).addScaledVector(ab, t);
  return closest.distanceTo(p);
}

export function wrapAngleDeg(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

export function angularDiffDeg(aDeg, bDeg) {
  return Math.abs(wrapAngleDeg(aDeg - bDeg));
}

/**
 * Parses and validates canonical 21-bone BVH structure, returning parsed header & channel data
 * plus forward-kinematics telemetry across all frames.
 */
export function inspectCanonicalBVHText(bvhText, fileLabel = 'clip.bvh') {
  const errors = [];

  if (bvhText.includes('\r')) {
    errors.push(`${fileLabel}: contains CRLF (\\r) line endings`);
  }
  if (!bvhText.endsWith('\n') || bvhText.endsWith('\n\n')) {
    errors.push(`${fileLabel}: must end with a single trailing LF newline`);
  }

  const allLines = bvhText.slice(0, -1).split('\n');
  if (allLines.length < CANONICAL_HIERARCHY_LINE_COUNT + 4) {
    errors.push(`${fileLabel}: insufficient total lines (${allLines.length})`);
    return { ok: false, errors };
  }

  const hierarchyText = allLines.slice(0, CANONICAL_HIERARCHY_LINE_COUNT).join('\n');
  const hierarchyBytes = Buffer.byteLength(hierarchyText, 'utf8');
  const hierarchySha256 = sha256Buffer(Buffer.from(hierarchyText, 'utf8'));

  if (hierarchyBytes !== CANONICAL_HIERARCHY_BYTE_LENGTH) {
    errors.push(
      `${fileLabel}: HIERARCHY byte length ${hierarchyBytes} !== ${CANONICAL_HIERARCHY_BYTE_LENGTH}`
    );
  }
  if (hierarchySha256 !== CANONICAL_HIERARCHY_SHA256) {
    errors.push(`${fileLabel}: HIERARCHY SHA-256 ${hierarchySha256} !== ${CANONICAL_HIERARCHY_SHA256}`);
  }

  if (allLines[126] !== 'MOTION') {
    errors.push(`${fileLabel}: line 127 must be 'MOTION', got '${allLines[126]}'`);
  }

  const framesMatch = /^Frames: ([1-9]\d*)$/.exec(allLines[127] || '');
  if (!framesMatch) {
    errors.push(`${fileLabel}: invalid Frames line '${allLines[127]}'`);
  }
  const declaredFrames = framesMatch ? Number(framesMatch[1]) : 0;

  const ftMatch = /^Frame Time: (0\.\d{6})$/.exec(allLines[128] || '');
  if (!ftMatch) {
    errors.push(`${fileLabel}: invalid Frame Time line '${allLines[128]}'`);
  }
  const frameTime = ftMatch ? Number(ftMatch[1]) : 0;
  const fps = frameTime > 0 ? Math.round(1 / frameTime) : 0;

  const dataLines = allLines.slice(129);
  if (dataLines.length !== declaredFrames) {
    errors.push(`${fileLabel}: declared Frames=${declaredFrames} !== motion lines=${dataLines.length}`);
  }
  if (declaredFrames < 20) {
    errors.push(`${fileLabel}: frame count ${declaredFrames} < minimum 20`);
  }

  const numTokenRe = /^-?\d+\.\d{4}$/;
  const rows = [];
  for (let i = 0; i < dataLines.length; i++) {
    const tokens = dataLines[i].split(' ');
    if (tokens.length !== 66) {
      errors.push(`${fileLabel}: motion line ${i} has ${tokens.length} channels (expected 66)`);
      break;
    }
    const vals = new Float64Array(66);
    for (let c = 0; c < 66; c++) {
      if (!numTokenRe.test(tokens[c])) {
        errors.push(`${fileLabel}: motion line ${i} col ${c} invalid format '${tokens[c]}'`);
        break;
      }
      const v = Number(tokens[c]);
      if (!Number.isFinite(v)) {
        errors.push(`${fileLabel}: motion line ${i} col ${c} non-finite`);
        break;
      }
      if (c >= 3 && (v < -180.0001 || v > 180.0001)) {
        errors.push(`${fileLabel}: motion line ${i} col ${c} rotation out of [-180,180]: ${v}`);
        break;
      }
      vals[c] = v;
    }
    if (errors.length > 0) break;
    rows.push(vals);
  }

  // Verify Three.js BVHLoader round-trip parseability
  let bvhParsed = null;
  try {
    bvhParsed = new BVHLoader().parse(bvhText);
    if (bvhParsed.skeleton.bones.length !== 26) {
      errors.push(
        `${fileLabel}: BVHLoader skeleton.bones.length=${bvhParsed.skeleton.bones.length} !== 26`
      );
    }
    if (bvhParsed.clip.tracks.length !== 42) {
      errors.push(`${fileLabel}: BVHLoader clip.tracks.length=${bvhParsed.clip.tracks.length} !== 42`);
    }
  } catch (err) {
    errors.push(`${fileLabel}: BVHLoader.parse threw ${err.message}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Forward Kinematics evaluation across all frames (in centimeters)
  const rig = buildCharacterRig();
  const { bones, swordGroup } = rig;
  const { tipAnchor, baseAnchor } = swordGroup.userData;
  const euler = new THREE.Euler(0, 0, 0, 'ZXY');
  const deg2rad = Math.PI / 180;
  const rad2deg = 180 / Math.PI;
  const jointNames21 = JOINT_ORDER_21.map(
    (bIdx) => Object.keys(BONE_IDX).find((k) => BONE_IDX[k] === bIdx) || `Bone${bIdx}`
  );

  const N = rows.length;
  const hipsPosCm = [];
  const footLCm = [];
  const footRCm = [];
  const kneeLCm = [];
  const kneeRCm = [];
  const chestPosCm = [];
  const neckPosCm = [];
  const headPosCm = [];
  const hipsUpY = new Float64Array(N);
  const chestFwdZ = new Float64Array(N);
  const chestYawDeg = new Float64Array(N);
  const swordTipCm = [];
  const minBoneYPerFrameCm = new Float64Array(N);

  let minSwordTorsoDistCm = Infinity;
  let minSwordNeckHeadDistCm = Infinity;
  let maxSwordTipSpeedMS = 0;
  let maxSwordTipStepCm = 0;
  let maxStepRootJumpCm = 0;
  let maxKneeStep3DCm = 0;
  let maxLocalJointStepDeg = 0;
  let maxLocalJointStepInfo = '';
  let maxKneeStepDeg = 0;

  const pTmp = new THREE.Vector3();
  const pBase = new THREE.Vector3();
  const pTip = new THREE.Vector3();
  const pHips = new THREE.Vector3();
  const pSpine = new THREE.Vector3();
  const pChest = new THREE.Vector3();
  const pNeck = new THREE.Vector3();
  const pHead = new THREE.Vector3();
  const qWorld = new THREE.Quaternion();
  const frameQuats21 = [];

  // Track joint channel ranges to reject frozen/T-pose dummies
  const chanMin = new Float64Array(66).fill(Infinity);
  const chanMax = new Float64Array(66).fill(-Infinity);

  for (let f = 0; f < N; f++) {
    const r = rows[f];
    for (let c = 0; c < 66; c++) {
      if (r[c] < chanMin[c]) chanMin[c] = r[c];
      if (r[c] > chanMax[c]) chanMax[c] = r[c];
    }

    bones[0].position.set(r[0] * 0.01, r[1] * 0.01, r[2] * 0.01);
    const qList = [];
    for (let j = 0; j < 21; j++) {
      const bIdx = JOINT_ORDER_21[j];
      const zRad = r[3 + j * 3] * deg2rad;
      const xRad = r[3 + j * 3 + 1] * deg2rad;
      const yRad = r[3 + j * 3 + 2] * deg2rad;
      euler.set(xRad, yRad, zRad, 'ZXY');
      bones[bIdx].quaternion.setFromEuler(euler);
      qList.push(bones[bIdx].quaternion.clone());
    }
    frameQuats21.push(qList);

    if (f > 0) {
      const prevQList = frameQuats21[f - 1];
      for (let j = 0; j < 21; j++) {
        const dot = Math.min(1, Math.abs(qList[j].dot(prevQList[j])));
        const stepDeg = 2 * Math.acos(dot) * rad2deg;
        if (stepDeg > maxLocalJointStepDeg) {
          maxLocalJointStepDeg = stepDeg;
          maxLocalJointStepInfo = `${jointNames21[j]}@${f}`;
        }
        const bIdx = JOINT_ORDER_21[j];
        if (bIdx === BONE_IDX.LeftLeg || bIdx === BONE_IDX.RightLeg) {
          if (stepDeg > maxKneeStepDeg) maxKneeStepDeg = stepDeg;
        }
      }
    }

    bones[0].updateWorldMatrix(true, true);
    swordGroup.updateWorldMatrix(true, true);

    let minBoneY = Infinity;
    for (const bIdx of JOINT_ORDER_21) {
      bones[bIdx].getWorldPosition(pTmp);
      const yCm = pTmp.y * 100;
      if (yCm < minBoneY) minBoneY = yCm;
    }
    minBoneYPerFrameCm[f] = minBoneY;

    bones[BONE_IDX.Hips].getWorldPosition(pHips);
    bones[BONE_IDX.Spine].getWorldPosition(pSpine);
    bones[BONE_IDX.Chest].getWorldPosition(pChest);
    bones[BONE_IDX.Neck].getWorldPosition(pNeck);
    bones[BONE_IDX.Head].getWorldPosition(pHead);

    hipsPosCm.push(pHips.clone().multiplyScalar(100));
    chestPosCm.push(pChest.clone().multiplyScalar(100));
    neckPosCm.push(pNeck.clone().multiplyScalar(100));
    headPosCm.push(pHead.clone().multiplyScalar(100));

    bones[BONE_IDX.LeftLeg].getWorldPosition(pTmp);
    kneeLCm.push(pTmp.clone().multiplyScalar(100));
    bones[BONE_IDX.RightLeg].getWorldPosition(pTmp);
    kneeRCm.push(pTmp.clone().multiplyScalar(100));

    if (f > 0) {
      const stepCm = hipsPosCm[f].distanceTo(hipsPosCm[f - 1]);
      if (stepCm > maxStepRootJumpCm) maxStepRootJumpCm = stepCm;
      const kStepCm = Math.max(
        kneeLCm[f].distanceTo(kneeLCm[f - 1]),
        kneeRCm[f].distanceTo(kneeRCm[f - 1])
      );
      if (kStepCm > maxKneeStep3DCm) maxKneeStep3DCm = kStepCm;
    }

    bones[BONE_IDX.LeftFoot].getWorldPosition(pTmp);
    footLCm.push(pTmp.clone().multiplyScalar(100));
    bones[BONE_IDX.RightFoot].getWorldPosition(pTmp);
    footRCm.push(pTmp.clone().multiplyScalar(100));

    bones[BONE_IDX.Hips].getWorldQuaternion(qWorld);
    pTmp.set(0, 1, 0).applyQuaternion(qWorld);
    hipsUpY[f] = pTmp.y;

    bones[BONE_IDX.Chest].getWorldQuaternion(qWorld);
    pTmp.set(0, 0, 1).applyQuaternion(qWorld);
    pTmp.y = 0;
    if (pTmp.lengthSq() > 1e-6) pTmp.normalize();
    chestFwdZ[f] = pTmp.z;
    chestYawDeg[f] = (Math.atan2(pTmp.x, pTmp.z) * 180) / Math.PI;

    baseAnchor.getWorldPosition(pBase);
    tipAnchor.getWorldPosition(pTip);
    swordTipCm.push(pTip.clone().multiplyScalar(100));

    if (f > 0) {
      const tipStepCm = swordTipCm[f].distanceTo(swordTipCm[f - 1]);
      if (tipStepCm > maxSwordTipStepCm) maxSwordTipStepCm = tipStepCm;
      const spdMS = tipStepCm * 0.01 * fps;
      if (spdMS > maxSwordTipSpeedMS) maxSwordTipSpeedMS = spdMS;
    }

    const dTorsoCm =
      Math.min(
        segmentToPointDistCm(pBase, pTip, pHips),
        segmentToPointDistCm(pBase, pTip, pSpine),
        segmentToPointDistCm(pBase, pTip, pChest)
      ) * 100;
    if (dTorsoCm < minSwordTorsoDistCm) minSwordTorsoDistCm = dTorsoCm;

    const dNeckHeadCm =
      Math.min(
        segmentToPointDistCm(pBase, pTip, pNeck),
        segmentToPointDistCm(pBase, pTip, pHead)
      ) * 100;
    if (dNeckHeadCm < minSwordNeckHeadDistCm) minSwordNeckHeadDistCm = dNeckHeadCm;
  }

  let endJointStepDeg = 0;
  let endHipsStepCm = 0;
  if (N >= 2) {
    endHipsStepCm = hipsPosCm[N - 1].distanceTo(hipsPosCm[N - 2]);
    for (let j = 0; j < 21; j++) {
      const dot = Math.min(1, Math.abs(frameQuats21[N - 1][j].dot(frameQuats21[N - 2][j])));
      const stepDeg = 2 * Math.acos(dot) * rad2deg;
      if (stepDeg > endJointStepDeg) endJointStepDeg = stepDeg;
    }
  }
  const minHipsYCm = Math.min(...hipsPosCm.map((p) => p.y));

  let activeJointCount = 0;
  for (let j = 0; j < 21; j++) {
    const span = Math.max(
      chanMax[3 + j * 3] - chanMin[3 + j * 3],
      chanMax[3 + j * 3 + 1] - chanMin[3 + j * 3 + 1],
      chanMax[3 + j * 3 + 2] - chanMin[3 + j * 3 + 2]
    );
    if (span > 1.5) activeJointCount++;
  }

  // Cyclic seam metrics between frame 0 and frame N-1
  const rootSeamCm = hipsPosCm[0].distanceTo(hipsPosCm[N - 1]);
  const rootYSeamCm = Math.abs(hipsPosCm[0].y - hipsPosCm[N - 1].y);
  let maxJointSeamDeg = 0;
  for (let j = 0; j < 21; j++) {
    const dot = Math.min(1, Math.abs(frameQuats21[0][j].dot(frameQuats21[N - 1][j])));
    const angDeg = 2 * Math.acos(dot) * rad2deg;
    if (angDeg > maxJointSeamDeg) maxJointSeamDeg = angDeg;
  }

  // Interior locked stance slip:
  // - All non-treadmill clips evaluate unfiltered locked stance slip (catches >45 cm/s skating!)
  // - Treadmill strafe/run clips exclude intentional constant belt sweep (>45 cm/s)
  let slipAllSqSum = 0;
  let slipAllSamples = 0;
  let slipTreadSqSum = 0;
  let slipTreadSamples = 0;
  for (let f = 2; f < N - 1; f++) {
    if (hipsUpY[f] > 0.40) {
      const lLocked =
        Math.abs(footLCm[f - 2].y - 8.0) <= 0.12 &&
        Math.abs(footLCm[f - 1].y - 8.0) <= 0.12 &&
        Math.abs(footLCm[f].y - 8.0) <= 0.12 &&
        Math.abs(footLCm[f + 1].y - 8.0) <= 0.12;
      if (lLocked) {
        const vCmS = Math.hypot(footLCm[f].x - footLCm[f - 1].x, footLCm[f].z - footLCm[f - 1].z) * fps;
        slipAllSqSum += vCmS * vCmS;
        slipAllSamples++;
        if (vCmS < 45) {
          slipTreadSqSum += vCmS * vCmS;
          slipTreadSamples++;
        }
      }
      const rLocked =
        Math.abs(footRCm[f - 2].y - 8.0) <= 0.12 &&
        Math.abs(footRCm[f - 1].y - 8.0) <= 0.12 &&
        Math.abs(footRCm[f].y - 8.0) <= 0.12 &&
        Math.abs(footRCm[f + 1].y - 8.0) <= 0.12;
      if (rLocked) {
        const vCmS = Math.hypot(footRCm[f].x - footRCm[f - 1].x, footRCm[f].z - footRCm[f - 1].z) * fps;
        slipAllSqSum += vCmS * vCmS;
        slipAllSamples++;
        if (vCmS < 45) {
          slipTreadSqSum += vCmS * vCmS;
          slipTreadSamples++;
        }
      }
    }
  }
  const interiorStanceRmsSlipAllCmS = slipAllSamples > 0 ? Math.sqrt(slipAllSqSum / slipAllSamples) : 0;
  const interiorStanceRmsSlipTreadmillCmS =
    slipTreadSamples > 0 ? Math.sqrt(slipTreadSqSum / slipTreadSamples) : 0;
  const isLabelTreadmill = /^(02_wuxia_run|07_wuxia_strafe_)/.test(fileLabel);
  const interiorStanceRmsSlipCmS = isLabelTreadmill
    ? interiorStanceRmsSlipTreadmillCmS
    : interiorStanceRmsSlipAllCmS;

  // Stance foot optical flow azimuth for treadmill locomotion (atan2(-stanceFootVel.x, -stanceFootVel.z))
  let flowSumX = 0;
  let flowSumZ = 0;
  const activeEnd = Math.max(2, Math.floor(N * 0.80));
  for (let f = 1; f < activeEnd; f++) {
    const lGrounded = footLCm[f].y <= 8.35 && footLCm[f - 1].y <= 8.35;
    const rGrounded = footRCm[f].y <= 8.35 && footRCm[f - 1].y <= 8.35;
    if (lGrounded && (!rGrounded || footLCm[f].y <= footRCm[f].y)) {
      flowSumX += -(footLCm[f].x - footLCm[f - 1].x);
      flowSumZ += -(footLCm[f].z - footLCm[f - 1].z);
    }
    if (rGrounded && (!lGrounded || footRCm[f].y <= footLCm[f].y)) {
      flowSumX += -(footRCm[f].x - footRCm[f - 1].x);
      flowSumZ += -(footRCm[f].z - footRCm[f - 1].z);
    }
  }
  const stanceOpticalFlowDeg =
    Math.hypot(flowSumX, flowSumZ) > 1e-4 ? (Math.atan2(flowSumX, flowSumZ) * 180) / Math.PI : 0;

  return {
    ok: true,
    errors,
    frames: declaredFrames,
    frameTime,
    fps,
    durationSec: +(declaredFrames / fps).toFixed(3),
    hierarchySha256,
    activeJointCount,
    hipsPosCm,
    footLCm,
    footRCm,
    kneeLCm,
    kneeRCm,
    chestPosCm,
    neckPosCm,
    headPosCm,
    hipsUpY,
    chestFwdZ,
    chestYawDeg,
    swordTipCm,
    minBoneYCm: Math.min(...minBoneYPerFrameCm),
    minHipsYCm,
    minSwordTorsoDistCm,
    minSwordNeckHeadDistCm,
    maxSwordTipSpeedMS,
    maxSwordTipStepCm,
    maxStepRootJumpCm,
    maxKneeStep3DCm,
    maxLocalJointStepDeg,
    maxLocalJointStepInfo,
    maxKneeStepDeg,
    endJointStepDeg,
    endHipsStepCm,
    rootSeamCm,
    rootYSeamCm,
    maxJointSeamDeg,
    interiorStanceRmsSlipCmS,
    interiorStanceRmsSlipAllCmS,
    interiorStanceRmsSlipTreadmillCmS,
    stanceOpticalFlowDeg,
  };
}

const TARGET_STRAFE_AZIMUTH = {
  F: 0,
  B: 180,
  L: 90,
  R: -90,
  FL: 45,
  FR: -45,
  BL: 135,
  BR: -135,
};

/**
 * Enforces Category C physical & action-specific kinematic assertions on a parsed clip.
 */
export function verifyClipKinematics(entry, fk) {
  const errs = [];
  const label = entry.fileName;
  const N = fk.frames;

  if (fk.activeJointCount < 6) {
    errs.push(`${label}: degenerate/static clip (activeJointCount=${fk.activeJointCount} < 6)`);
  }

  for (let f = 0; f < N; f++) {
    const h = fk.hipsPosCm[f];
    if (h.x < -800 || h.x > 800 || h.z < -800 || h.z > 800 || h.y < 8.0 || h.y > 240.0) {
      errs.push(`${label}: frame ${f} Hips out of world bounds (${h.x.toFixed(1)}, ${h.y.toFixed(1)}, ${h.z.toFixed(1)})`);
      break;
    }
    if (fk.hipsUpY[f] > 0.40) {
      const minFoot = Math.min(fk.footLCm[f].y, fk.footRCm[f].y);
      if (minFoot < 7.50) {
        errs.push(`${label}: frame ${f} upright foot penetrated floor (${minFoot.toFixed(2)} cm < 7.50 cm)`);
        break;
      }
    }
    const minTorso = Math.min(fk.hipsPosCm[f].y, fk.chestPosCm[f].y, fk.headPosCm[f].y);
    if (minTorso < 5.0) {
      errs.push(`${label}: frame ${f} torso/head penetrated floor (${minTorso.toFixed(2)} cm < 5.0 cm)`);
      break;
    }
  }

  const isLegacyReadOnly = /^0[1-6]_/.test(entry.fileName);
  const minAllowedBoneY = isLegacyReadOnly ? -2.0 : 0.0;
  if (fk.minBoneYCm < minAllowedBoneY) {
    errs.push(`${label}: bone penetrated below floor bound (${fk.minBoneYCm.toFixed(2)} cm < ${minAllowedBoneY} cm)`);
  }

  const isTreadmill = entry.archetype === 'Loco_Strafe_8Way' || entry.id === 'wuxia_02_run';
  const stanceSlip = isTreadmill
    ? fk.interiorStanceRmsSlipTreadmillCmS
    : fk.interiorStanceRmsSlipAllCmS;
  if (stanceSlip > 2.0) {
    errs.push(`${label}: interior stance RMS slip ${stanceSlip.toFixed(3)} cm/s > 2.0 cm/s`);
  }

  // Strict 1-frame rotational, 3D knee, sword-tip, and Head/Neck/Torso clearance gates across all 20 M2 clips
  if (!isLegacyReadOnly) {
    if (fk.maxKneeStepDeg > 45.0) {
      errs.push(`${label}: 1-frame knee step ${fk.maxKneeStepDeg.toFixed(2)}° > 45.0°`);
    }
    const maxAllowedLocalStep = entry.id === 'taibai_01b_idle_combat' ? 18.0 : 50.0;
    if (fk.maxLocalJointStepDeg > maxAllowedLocalStep) {
      errs.push(
        `${label}: 1-frame local joint step ${fk.maxLocalJointStepDeg.toFixed(2)}° (${fk.maxLocalJointStepInfo}) > ${maxAllowedLocalStep.toFixed(1)}°`
      );
    }
    if (!entry.cyclic) {
      if (fk.endJointStepDeg > 25.0) {
        errs.push(`${label}: non-cyclic final-frame joint step ${fk.endJointStepDeg.toFixed(2)}° > 25.0°`);
      }
      if (fk.endHipsStepCm > 10.0) {
        errs.push(`${label}: non-cyclic final-frame Hips step ${fk.endHipsStepCm.toFixed(2)} cm > 10.0 cm`);
      }
    }
    if (fk.maxKneeStep3DCm > 26.0) {
      errs.push(`${label}: 1-frame 3D knee step ${fk.maxKneeStep3DCm.toFixed(2)} cm > 26.0 cm`);
    }
    const maxAllowedTipStep = entry.id === 'taibai_01b_idle_combat' ? 18.0 : 70.0;
    if (fk.maxSwordTipStepCm > maxAllowedTipStep) {
      errs.push(
        `${label}: 1-frame SwordTip step ${fk.maxSwordTipStepCm.toFixed(2)} cm > ${maxAllowedTipStep.toFixed(1)} cm`
      );
    }
    if (fk.minSwordNeckHeadDistCm < 20.0) {
      errs.push(
        `${label}: Sword blade encroached Neck/Head (${fk.minSwordNeckHeadDistCm.toFixed(2)} cm < 20.0 cm)`
      );
    }
    if (fk.minSwordTorsoDistCm < 22.0) {
      errs.push(
        `${label}: Sword blade encroached Torso (${fk.minSwordTorsoDistCm.toFixed(2)} cm < 22.0 cm)`
      );
    }
  }

  if (entry.cyclic) {
    if (fk.rootSeamCm > 1.0) {
      errs.push(`${label}: cyclic root seam ${fk.rootSeamCm.toFixed(2)} cm > 1.0 cm`);
    }
    if (fk.rootYSeamCm > 3.5) {
      errs.push(`${label}: cyclic Hips.y seam ${fk.rootYSeamCm.toFixed(2)} cm > 3.5 cm`);
    }
    // Legacy read-only 02_wuxia_run has a 1-frame running gait step (19.51°) between f51 and f0; all new cyclic clips require <= 12.0°
    const maxAllowedJointSeam = isLegacyReadOnly ? 22.0 : 12.0;
    if (fk.maxJointSeamDeg > maxAllowedJointSeam) {
      errs.push(`${label}: cyclic max joint seam ${fk.maxJointSeamDeg.toFixed(2)}° > ${maxAllowedJointSeam}°`);
    }
  }

  // Action-specific assertions
  if (entry.archetype === 'Loco_Strafe_8Way') {
    const targetDeg = TARGET_STRAFE_AZIMUTH[entry.direction];
    const diffDeg = angularDiffDeg(fk.stanceOpticalFlowDeg, targetDeg);
    if (diffDeg > 20.0) {
      errs.push(
        `${label}: stance foot optical flow ${fk.stanceOpticalFlowDeg.toFixed(1)}° deviates ${diffDeg.toFixed(1)}° (>20°) from ${entry.direction} (${targetDeg}°)`
      );
    }
    const meanChestFwdZ = fk.chestFwdZ.reduce((a, b) => a + b, 0) / N;
    if (meanChestFwdZ < 0.65) {
      errs.push(`${label}: Chest forward dot(+Z) ${meanChestFwdZ.toFixed(2)} < 0.65`);
    }
    if (fk.minSwordTorsoDistCm < 22.0) {
      errs.push(`${label}: sword clearance ${fk.minSwordTorsoDistCm.toFixed(1)} cm < 22.0 cm`);
    }
  } else if (entry.id === 'wuxia_08_dash_canglong') {
    const dz = fk.hipsPosCm[N - 1].z - fk.hipsPosCm[0].z;
    const dx = Math.abs(fk.hipsPosCm[N - 1].x - fk.hipsPosCm[0].x);
    const earlyZ = fk.hipsPosCm[Math.min(6, N - 1)].z - fk.hipsPosCm[0].z;
    const maxTipExt = Math.max(...fk.swordTipCm.map((p, i) => p.z - fk.hipsPosCm[i].z));
    if (dz < 140) errs.push(`${label}: forward +Z lunge ${dz.toFixed(1)} cm < 140 cm`);
    if (dx > 20) errs.push(`${label}: lateral drift |dX|=${dx.toFixed(1)} cm > 20 cm`);
    if (earlyZ < 5.0) errs.push(`${label}: sluggish startup in first 6 frames (${earlyZ.toFixed(1)} cm < 5 cm)`);
    if (maxTipExt < 85) errs.push(`${label}: max SwordTip +Z extension ${maxTipExt.toFixed(1)} cm < 85 cm`);
    if (fk.minSwordTorsoDistCm < 22) errs.push(`${label}: minSwordTorsoDist ${fk.minSwordTorsoDistCm.toFixed(1)} cm < 22 cm`);
  } else if (entry.id === 'wuxia_09_dodge_roll') {
    const dz = fk.hipsPosCm[N - 1].z - fk.hipsPosCm[0].z;
    const minUp = Math.min(...fk.hipsUpY);
    if (dz < 120) errs.push(`${label}: forward roll +Z ${dz.toFixed(1)} cm < 120 cm`);
    if (minUp > 0.20) errs.push(`${label}: roll failed to invert (minHipsUpY=${minUp.toFixed(2)} > 0.20)`);
    if (fk.hipsUpY[N - 1] < 0.80) errs.push(`${label}: roll failed to recover upright (${fk.hipsUpY[N - 1].toFixed(2)})`);
  } else if (entry.id === 'wuxia_10_double_jump') {
    const maxHipY = Math.max(...fk.hipsPosCm.map((p) => p.y));
    const maxBothFeetY = Math.max(...fk.footLCm.map((p, i) => Math.min(p.y, fk.footRCm[i].y)));
    if (maxHipY < 135 || maxHipY > 185) {
      errs.push(`${label}: double jump apex Hips.y ${maxHipY.toFixed(1)} cm outside [135, 185] cm`);
    }
    if (maxBothFeetY < 35) {
      errs.push(`${label}: airborne feet tuck ${maxBothFeetY.toFixed(1)} cm < 35 cm`);
    }
    if (fk.hipsUpY[N - 1] < 0.85) errs.push(`${label}: landing not upright (${fk.hipsUpY[N - 1].toFixed(2)})`);
  } else if (entry.id === 'wuxia_11_hit_light_L') {
    const dx = fk.hipsPosCm[N - 1].x - fk.hipsPosCm[0].x;
    const minZ = Math.min(...fk.hipsPosCm.map((p) => p.z - fk.hipsPosCm[0].z));
    if (dx > -15) errs.push(`${label}: left-hit recoil dX ${dx.toFixed(1)} cm > -15 cm`);
    if (minZ > -8) errs.push(`${label}: backward stagger minZ ${minZ.toFixed(1)} cm > -8 cm`);
    if (fk.hipsUpY[N - 1] < 0.85) errs.push(`${label}: recovery not upright`);
  } else if (entry.id === 'wuxia_12_hit_light_R') {
    const dx = fk.hipsPosCm[N - 1].x - fk.hipsPosCm[0].x;
    const minZ = Math.min(...fk.hipsPosCm.map((p) => p.z - fk.hipsPosCm[0].z));
    if (dx < 15) errs.push(`${label}: right-hit recoil dX ${dx.toFixed(1)} cm < +15 cm`);
    if (minZ > -8) errs.push(`${label}: backward stagger minZ ${minZ.toFixed(1)} cm > -8 cm`);
    if (fk.hipsUpY[N - 1] < 0.85) errs.push(`${label}: recovery not upright`);
  } else if (entry.id === 'wuxia_13_knockdown') {
    const dz = fk.hipsPosCm[N - 1].z - fk.hipsPosCm[0].z;
    const minHipY = Math.min(...fk.hipsPosCm.map((p) => p.y));
    if (fk.hipsUpY[0] < 0.80 || fk.hipsPosCm[0].y < 75) errs.push(`${label}: did not start upright`);
    if (dz > -80) errs.push(`${label}: knockdown backward dZ ${dz.toFixed(1)} cm > -80 cm`);
    if (minHipY > 38) errs.push(`${label}: knockdown minHipY ${minHipY.toFixed(1)} cm > 38 cm`);
    if (fk.hipsUpY[N - 1] >= 0.45) errs.push(`${label}: end hipsUpY ${fk.hipsUpY[N - 1].toFixed(2)} >= 0.45`);
  } else if (entry.id === 'wuxia_14_kipup') {
    if (fk.hipsUpY[0] >= 0.45 || fk.hipsPosCm[0].y > 38) {
      errs.push(`${label}: did not start supine (hipsUpY[0]=${fk.hipsUpY[0].toFixed(2)}, hipY=${fk.hipsPosCm[0].y.toFixed(1)})`);
    }
    if (fk.hipsUpY[N - 1] <= 0.85 || fk.hipsPosCm[N - 1].y < 78) {
      errs.push(`${label}: did not finish upright (hipsUpY[end]=${fk.hipsUpY[N - 1].toFixed(2)}, hipY=${fk.hipsPosCm[N - 1].y.toFixed(1)})`);
    }
  } else if (entry.id === 'wuxia_15_knockdown_kipup') {
    const minHipY = Math.min(...fk.hipsPosCm.map((p) => p.y));
    const minUp = Math.min(...fk.hipsUpY);
    if (fk.hipsUpY[0] < 0.80) errs.push(`${label}: did not start upright`);
    if (minHipY > 38 || minUp >= 0.40) errs.push(`${label}: did not reach supine mid-clip`);
    if (fk.hipsUpY[N - 1] <= 0.85 || fk.hipsPosCm[N - 1].y < 78) errs.push(`${label}: did not finish upright`);
    if (fk.maxStepRootJumpCm > 8.0) {
      errs.push(`${label}: max frame-to-frame root step ${fk.maxStepRootJumpCm.toFixed(2)} cm > 8.0 cm`);
    }
  } else if (entry.id === 'taibai_01b_idle_combat') {
    if (fk.durationSec < 0.85 || fk.durationSec > 1.25) errs.push(`${label}: duration ${fk.durationSec}s out of range`);
    if (Math.min(...fk.hipsUpY) < 0.80) errs.push(`${label}: hipsUpY dipped below 0.80`);
    const maxFoot = Math.max(...fk.footLCm.map((p, i) => Math.max(p.y, fk.footRCm[i].y)));
    if (maxFoot > 12.0) errs.push(`${label}: feet floated (${maxFoot.toFixed(1)} cm > 12 cm)`);
    if (fk.minSwordTorsoDistCm < 22) errs.push(`${label}: sword clipped body (${fk.minSwordTorsoDistCm.toFixed(1)} cm)`);
  } else if (entry.id === 'taibai_02_wuhen') {
    if (fk.durationSec < 2.85 || fk.durationSec > 3.40) errs.push(`${label}: duration ${fk.durationSec}s out of range`);
    const maxFootSep = Math.max(...fk.footLCm.map((p, i) => Math.abs(p.y - fk.footRCm[i].y)));
    if (maxFootSep < 22.0) errs.push(`${label}: knee-lift foot separation ${maxFootSep.toFixed(1)} cm < 22 cm`);
    if (fk.minSwordTorsoDistCm < 22) errs.push(`${label}: sword clipped body (${fk.minSwordTorsoDistCm.toFixed(1)} cm)`);
  } else if (entry.id === 'taibai_03_yuluo') {
    if (fk.durationSec < 4.85 || fk.durationSec > 5.40 || fk.frames < 290) {
      errs.push(`${label}: truncated duration ${fk.durationSec}s (${fk.frames} frames < 290 @60fps)`);
    }
    if (fk.minHipsYCm < 50.0) {
      errs.push(`${label}: pelvis collapsed during aerial jump-kick (minHipsY=${fk.minHipsYCm.toFixed(1)} cm < 50.0 cm)`);
    }
    if (fk.maxSwordTipSpeedMS < 6.0) {
      errs.push(`${label}: peak SwordTip speed ${fk.maxSwordTipSpeedMS.toFixed(2)} m/s < 6.0 m/s`);
    }
    if (fk.minSwordTorsoDistCm < 22.0) {
      errs.push(`${label}: sword clipped torso (${fk.minSwordTorsoDistCm.toFixed(1)} cm < 22 cm)`);
    }
  } else if (entry.id === 'taibai_04_feiyan') {
    if (fk.durationSec < 1.55 || fk.durationSec > 2.05) errs.push(`${label}: duration ${fk.durationSec}s out of range`);
    const hipYs = fk.hipsPosCm.map((p) => p.y);
    const maxHipY = Math.max(...hipYs);
    const minHipY = Math.min(...hipYs);
    if (maxHipY - minHipY < 35.0) {
      errs.push(`${label}: Hips.y range ${(maxHipY - minHipY).toFixed(1)} cm < 35 cm`);
    }
    if (minHipY > 75.0) {
      errs.push(`${label}: split landing min(Hips.y) ${minHipY.toFixed(1)} cm > 75 cm`);
    }
  }

  return errs;
}

export function queryDriveFolder02CJson() {
  const out = execFileSync('gdrive', ['readonly', 'ls', DRIVE_FOLDER_02C_ID, '--json'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(out.trim() || '[]');
  if (!Array.isArray(parsed)) {
    throw new Error('gdrive readonly ls did not return a JSON array');
  }
  return parsed;
}

/**
 * Full 6-category verification suite across workspace BVH library, raw sources, videos, MANIFEST.json, and Drive 02/C.
 */
export function verifyEntireLibrary({
  workspaceRoot = '/home/antigravity',
  checkManifest = true,
  checkDrive = true,
} = {}) {
  const errors = [];
  const clipReports = [];

  const bvhRoot = path.join(workspaceRoot, 'bvh_library');
  const rawDir = path.join(bvhRoot, 'A_raw_mocap');
  const cleanDir = path.join(bvhRoot, 'B_cleaned_ready');
  const taibaiDir = path.join(bvhRoot, 'C_taibai_extracted');
  const videoDir = path.join(workspaceRoot, 'reference_videos');

  // Category A: Immutable baselines
  for (const item of IMMUTABLE_B_CLEANED_01_06) {
    const fp = path.join(cleanDir, item.fileName);
    if (!fs.existsSync(fp)) {
      errors.push(`Category A: missing immutable ${item.fileName}`);
      continue;
    }
    const buf = fs.readFileSync(fp);
    if (buf.length !== item.bytes) {
      errors.push(`Category A: ${item.fileName} bytes ${buf.length} !== ${item.bytes}`);
    }
    const hash = sha256Buffer(buf);
    if (hash !== item.sha256) {
      errors.push(`Category A: ${item.fileName} SHA-256 mismatch (${hash})`);
    }
  }

  for (const item of IMMUTABLE_A_RAW_BASELINE) {
    const fp = path.join(rawDir, item.fileName);
    if (!fs.existsSync(fp)) {
      errors.push(`Category A: missing raw baseline ${item.fileName}`);
      continue;
    }
    const buf = fs.readFileSync(fp);
    if (buf.length !== item.bytes || sha256Buffer(buf) !== item.sha256) {
      errors.push(`Category A: raw baseline ${item.fileName} modified`);
    }
  }

  for (const v of REFERENCE_VIDEOS_SPEC) {
    const fp = path.join(videoDir, v.fileName);
    if (!fs.existsSync(fp)) {
      errors.push(`Category D: missing reference video ${v.fileName}`);
      continue;
    }
    const st = fs.statSync(fp);
    if (st.size !== v.bytes) {
      errors.push(`Category D: video ${v.fileName} bytes ${st.size} !== ${v.bytes}`);
    }
    const hash = sha256File(fp);
    if (hash !== v.sha256) {
      errors.push(`Category D: video ${v.fileName} SHA-256 mismatch`);
    }
  }

  // Category B & C: Inventory, Canonical Format, and Forward Kinematics across all 26 clips
  const actualB = fs.existsSync(cleanDir) ? fs.readdirSync(cleanDir).filter((f) => f.endsWith('.bvh')).sort() : [];
  const actualC = fs.existsSync(taibaiDir) ? fs.readdirSync(taibaiDir).filter((f) => f.endsWith('.bvh')).sort() : [];
  if (actualB.length !== 22) {
    errors.push(`Category B: B_cleaned_ready has ${actualB.length} .bvh files (expected 22)`);
  }
  if (actualC.length !== 4) {
    errors.push(`Category B: C_taibai_extracted has ${actualC.length} .bvh files (expected 4)`);
  }

  const fkById = new Map();
  for (const entry of CLIP_CATALOG_26) {
    const fp = path.join(bvhRoot, entry.folder, entry.fileName);
    if (!fs.existsSync(fp)) {
      errors.push(`Category B: missing expected clip ${entry.folder}/${entry.fileName}`);
      continue;
    }
    const buf = fs.readFileSync(fp);
    const text = buf.toString('utf8');
    const fk = inspectCanonicalBVHText(text, entry.fileName);
    if (!fk.ok) {
      errors.push(...fk.errors);
      continue;
    }
    if (fk.fps !== 60) {
      errors.push(`Category B: ${entry.fileName} fps=${fk.fps} (expected 60)`);
    }
    const kinErrs = verifyClipKinematics(entry, fk);
    errors.push(...kinErrs);

    const isTreadmill = entry.archetype === 'Loco_Strafe_8Way' || entry.id === 'wuxia_02_run';
    const stanceSlip = isTreadmill
      ? fk.interiorStanceRmsSlipTreadmillCmS
      : fk.interiorStanceRmsSlipAllCmS;

    fkById.set(entry.id, fk);
    clipReports.push({
      id: entry.id,
      folder: entry.folder,
      fileName: entry.fileName,
      bytes: buf.length,
      sha256: sha256Buffer(buf),
      frames: fk.frames,
      fps: fk.fps,
      durationSec: fk.durationSec,
      rootSeamCm: +fk.rootSeamCm.toFixed(3),
      stanceOpticalFlowDeg: +fk.stanceOpticalFlowDeg.toFixed(1),
      minBoneYCm: +fk.minBoneYCm.toFixed(2),
      minHipsYCm: +fk.minHipsYCm.toFixed(1),
      minSwordTorsoDistCm: +fk.minSwordTorsoDistCm.toFixed(1),
      minSwordNeckHeadDistCm: +fk.minSwordNeckHeadDistCm.toFixed(1),
      maxLocalJointStepDeg: +fk.maxLocalJointStepDeg.toFixed(1),
      maxKneeStepDeg: +fk.maxKneeStepDeg.toFixed(1),
      maxKneeStep3DCm: +fk.maxKneeStep3DCm.toFixed(1),
      maxSwordTipStepCm: +fk.maxSwordTipStepCm.toFixed(1),
      endJointStepDeg: +fk.endJointStepDeg.toFixed(1),
      interiorStanceRmsSlipCmS: +stanceSlip.toFixed(4),
    });
  }

  // Opposite-sign check between 11_hit_L and 12_hit_R
  const hitL = fkById.get('wuxia_11_hit_light_L');
  const hitR = fkById.get('wuxia_12_hit_light_R');
  if (hitL && hitR) {
    const dxL = hitL.hipsPosCm[hitL.frames - 1].x - hitL.hipsPosCm[0].x;
    const dxR = hitR.hipsPosCm[hitR.frames - 1].x - hitR.hipsPosCm[0].x;
    if (!(dxL < -15 && dxR > 15)) {
      errors.push(`Category C: 11_hit_L (${dxL.toFixed(1)}cm) and 12_hit_R (${dxR.toFixed(1)}cm) fail opposite lateral recoil`);
    }
  }

  // Category D: Raw CMU provenance checks, string contract & forbidden trial ban
  const rawFiles = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.bvh')) : [];
  for (const rf of rawFiles) {
    if (/24_01|87_02|124_/.test(rf)) {
      errors.push(`Category D: forbidden CMU trial found in A_raw_mocap: ${rf}`);
    }
  }
  for (const entry of CLIP_CATALOG_26) {
    if (typeof entry.sourceProvenance !== 'string' || entry.sourceProvenance.length <= 10) {
      errors.push(`Category D: catalog entry ${entry.id} sourceProvenance must be a descriptive string (>10 chars)`);
    }
    const provDetail = entry.sourceProvenanceDetail;
    if (!provDetail || typeof provDetail !== 'object' || typeof provDetail.rawAsset !== 'string') {
      errors.push(`Category D: catalog entry ${entry.id} missing sourceProvenanceDetail object`);
      continue;
    }
    if (provDetail.type === 'optical_mocap_cmu') {
      const rawFp = path.join(workspaceRoot, provDetail.rawAsset);
      if (!fs.existsSync(rawFp)) {
        errors.push(`Category D: missing raw CMU asset ${provDetail.rawAsset}`);
        continue;
      }
      const rawStat = fs.statSync(rawFp);
      if (rawStat.size < 10240) {
        errors.push(`Category D: raw CMU asset too small (${rawStat.size} B): ${rawFp}`);
      }
      const rawHead = fs.readFileSync(rawFp, 'utf8').slice(0, 8192);
      const isPreExistingBaseline = provDetail.rawAsset.endsWith('cmu_87_01_tornado_kick.bvh');
      if (!isPreExistingBaseline && !/Frame Time:\s*0?\.008333/.test(rawHead)) {
        errors.push(`Category D: raw CMU asset ${provDetail.rawAsset} is not 120fps`);
      }
    }
  }

  // Category E & F: MANIFEST.json and Google Drive 02/C sync (including live SHA-256 content check)
  let manifestData = null;
  if (checkManifest) {
    const manifestPath = path.join(bvhRoot, 'MANIFEST.json');
    if (!fs.existsSync(manifestPath)) {
      errors.push('Category E: missing /home/antigravity/bvh_library/MANIFEST.json');
    } else {
      manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifestData.totalClips !== 26 || !Array.isArray(manifestData.clips) || manifestData.clips.length !== 26) {
        errors.push(`Category E: MANIFEST.json totalClips/clips.length !== 26`);
      } else {
        const ids = new Set();
        const names = new Set();
        const paths = new Set();
        for (const c of manifestData.clips) {
          ids.add(c.id);
          names.add(c.fileName);
          paths.add(c.path);
          if (typeof c.sourceProvenance !== 'string' || c.sourceProvenance.length <= 10) {
            errors.push(
              `Category E: MANIFEST clip ${c.id} sourceProvenance must be a descriptive string (>10 chars)`
            );
          }
          if (!c.sourceProvenanceDetail || typeof c.sourceProvenanceDetail !== 'object') {
            errors.push(`Category E: MANIFEST clip ${c.id} missing sourceProvenanceDetail object`);
          }
          if (!c.path.startsWith('/bvh_library/')) {
            errors.push(`Category E: clip ${c.id} path '${c.path}' must start with /bvh_library/`);
          }
          const diskPath = path.join(workspaceRoot, c.path.slice(1));
          if (!fs.existsSync(diskPath)) {
            errors.push(`Category E: clip ${c.id} path missing on disk: ${diskPath}`);
            continue;
          }
          const buf = fs.readFileSync(diskPath);
          if (buf.length !== c.bytes || sha256Buffer(buf) !== c.sha256) {
            errors.push(`Category E: clip ${c.id} bytes/sha256 mismatch against disk`);
          }
          const rep = clipReports.find((r) => r.id === c.id);
          if (rep && (rep.frames !== c.frames || rep.fps !== c.fps || rep.durationSec !== c.durationSec)) {
            errors.push(`Category E: clip ${c.id} frames/fps/durationSec mismatch`);
          }
          if (c.folder === 'C_taibai_extracted') {
            if (!c.driveFileId || String(c.driveFileId).length < 20) {
              errors.push(`Category E: Taibai clip ${c.id} missing valid driveFileId`);
            }
            const expectedPrefix = c.fileName.split('_').slice(0, 2).join('_');
            if (typeof c.label !== 'string' || !c.label.includes(expectedPrefix)) {
              errors.push(`Category E: Taibai clip ${c.id} label "${c.label}" missing canonical prefix "${expectedPrefix}"`);
            }
          }
        }
        if (ids.size !== 26 || names.size !== 26 || paths.size !== 26) {
          errors.push('Category E: duplicate id, fileName, or path in MANIFEST.json');
        }
      }
    }
  }

  let driveItems = null;
  if (checkDrive) {
    let shmVerifyDir = null;
    try {
      driveItems = queryDriveFolder02CJson();
      if (driveItems.length !== 4) {
        errors.push(`Category F: Google Drive 02/C has ${driveItems.length} items (expected exact 4 Taibai .bvh files)`);
      }
      shmVerifyDir = fs.mkdtempSync('/dev/shm/ms_verify_drive_');
      fs.chmodSync(shmVerifyDir, 0o700);

      const expectedTaibai = CLIP_CATALOG_26.filter((c) => c.folder === 'C_taibai_extracted');
      for (const exp of expectedTaibai) {
        const matches = driveItems.filter((it) => it.name === exp.fileName);
        if (matches.length !== 1) {
          errors.push(`Category F: Drive 02/C expected 1 entry for ${exp.fileName}, found ${matches.length}`);
          continue;
        }
        const item = matches[0];
        const localPath = path.join(taibaiDir, exp.fileName);
        const localBuf = fs.readFileSync(localPath);
        const localSha = sha256Buffer(localBuf);
        if (Number(item.size) !== localBuf.length) {
          errors.push(`Category F: Drive 02/C ${exp.fileName} size ${item.size} !== local ${localBuf.length}`);
        }
        const dlPath = path.join(shmVerifyDir, exp.fileName);
        execFileSync('gdrive', ['readonly', 'download', item.id, '--out', dlPath], { stdio: 'pipe' });
        const remoteSha = sha256File(dlPath);
        if (remoteSha !== localSha) {
          errors.push(
            `Category F: Drive 02/C ${exp.fileName} SHA-256 (${remoteSha}) !== local SHA-256 (${localSha})`
          );
        }
        if (manifestData) {
          const mc = manifestData.clips.find((c) => c.fileName === exp.fileName);
          if (mc && mc.driveFileId !== item.id) {
            errors.push(`Category F: MANIFEST driveFileId ${mc.driveFileId} !== Drive 02/C id ${item.id}`);
          }
        }
      }
    } catch (err) {
      errors.push(`Category F: failed to query/verify Drive 02/C: ${err.message}`);
    } finally {
      if (shmVerifyDir) {
        try {
          fs.rmSync(shmVerifyDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    clipReports,
    driveItems,
  };
}
