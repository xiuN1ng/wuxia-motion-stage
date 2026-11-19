#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { BONE_IDX, createBoneHierarchy } from '../src/rig/HumanoidRig.js';
import {
  NUM_BONES,
  cloneFrame,
  emptyFrame,
  applyFrameToBones,
  filterFramesZeroPhase,
  upsampleFramesSlerp,
  closeLoopAndStabilizeRoot,
  lockFeetWithTwoBoneIK,
  applyCapsuleFloorClearance,
  enforceSwordTorsoClearance,
  retargetBVHSliceTo60,
} from './lib/motionPipeline.mjs';
import { serializeFramesToBVH } from './lib/bvhSerializer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOTION_STAGE_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(MOTION_STAGE_ROOT, '..');
const RAW_MOCAP_DIR = path.join(WORKSPACE_ROOT, 'bvh_library', 'A_raw_mocap');
const CLEAN_READY_DIR = path.join(WORKSPACE_ROOT, 'bvh_library', 'B_cleaned_ready');

const CMU_BASE_URL = 'https://raw.githubusercontent.com/una-dinosauria/cmu-mocap/master/data';

// 12 verified 120fps CMU optical mocap trials (ZERO forbidden 24_01, 87_02, or 124_* trials)
export const CMU_RAW_SOURCES = [
  { key: '143_32', remote: '143/143_32.bvh', localFile: 'cmu_143_32_walk_fwd.bvh' },
  { key: '143_39', remote: '143/143_39.bvh', localFile: 'cmu_143_39_walk_back.bvh' },
  { key: '141_33', remote: '141/141_33.bvh', localFile: 'cmu_141_33_sidestep_dianbu.bvh' },
  { key: '141_32', remote: '141/141_32.bvh', localFile: 'cmu_141_32_oblique_step.bvh' },
  { key: '143_40', remote: '143/143_40.bvh', localFile: 'cmu_143_40_lateral_cross.bvh' },
  { key: '49_04', remote: '049/49_04.bvh', localFile: 'cmu_49_04_run_leap_lunge.bvh' },
  { key: '90_34', remote: '090/90_34.bvh', localFile: 'cmu_90_34_forward_roll.bvh' },
  { key: '83_62', remote: '083/83_62.bvh', localFile: 'cmu_83_62_air_spin_jump360.bvh' },
  { key: '144_07', remote: '144/144_07.bvh', localFile: 'cmu_144_07_left_block_recoil.bvh' },
  { key: '144_26', remote: '144/144_26.bvh', localFile: 'cmu_144_26_right_block_recoil.bvh' },
  { key: '90_18', remote: '090/90_18.bvh', localFile: 'cmu_90_18_rugpull_knockdown.bvh' },
  { key: '140_08', remote: '140/140_08.bvh', localFile: 'cmu_140_08_supine_getup.bvh' },
];

const _worldUp = new THREE.Vector3(0, 1, 0);

function downloadUrlText(url) {
  return new Promise((resolve, reject) => {
    const get = (targetUrl, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error(`Too many redirects fetching ${url}`));
        return;
      }
      https
        .get(targetUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            get(new URL(res.headers.location, targetUrl).toString(), redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} fetching ${targetUrl}`));
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        })
        .on('error', reject);
    };
    get(url);
  });
}

export async function ensureCmuRawSources(rawDir = RAW_MOCAP_DIR, quiet = false) {
  fs.mkdirSync(rawDir, { recursive: true });
  const cache = new Map();

  for (const src of CMU_RAW_SOURCES) {
    if (/^(24_01|87_02|124_)/.test(src.key)) {
      throw new Error(`Forbidden CMU trial encountered: ${src.key}`);
    }
    const localPath = path.join(rawDir, src.localFile);
    let text;
    if (fs.existsSync(localPath) && fs.statSync(localPath).size > 10240) {
      text = fs.readFileSync(localPath, 'utf8');
    } else {
      const url = `${CMU_BASE_URL}/${src.remote}`;
      if (!quiet) console.log(`[produce_mvp_bvh] Downloading ${url} -> ${src.localFile}`);
      text = await downloadUrlText(url);
      if (!text.includes('HIERARCHY') || !text.includes('MOTION')) {
        throw new Error(`Downloaded ${src.remote} is not a valid BVH file`);
      }
      fs.writeFileSync(localPath, text, 'utf8');
    }
    cache.set(src.key, { ...src, localPath, text });
  }

  return cache;
}

function slerpHemisphere(qBase, qTarget, alpha) {
  const tgt = qBase.dot(qTarget) < 0
    ? new THREE.Quaternion(-qTarget.x, -qTarget.y, -qTarget.z, -qTarget.w)
    : qTarget;
  return qBase.clone().slerp(tgt, alpha).normalize();
}

const TAIBAI_GUARD_LOCAL = {
  [BONE_IDX.RightShoulder]: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.02, -0.05, 0.03)),
  [BONE_IDX.RightUpperArm]: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.183, 0.264, 1.210)),
  [BONE_IDX.RightForeArm]: new THREE.Quaternion().setFromEuler(new THREE.Euler(1.229, 0.196, -1.409)),
  [BONE_IDX.RightHand]: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.757, -0.547, 0.945)),
  [BONE_IDX.LeftShoulder]: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.02, 0.05, -0.03)),
  [BONE_IDX.LeftUpperArm]: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.226, -0.305, -1.272)),
  [BONE_IDX.LeftForeArm]: new THREE.Quaternion().setFromEuler(new THREE.Euler(1.787, 0.159, 1.774)),
  [BONE_IDX.LeftHand]: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.030, 0.186, -0.091)),
};

function applyTaibaiArmGuard(frames, weight = 0.80, { cyclicStrideSway = false } = {}) {
  const N = frames.length;
  for (let f = 0; f < N; f++) {
    const fr = frames[f];
    for (const [bStr, qGuard] of Object.entries(TAIBAI_GUARD_LOCAL)) {
      const b = Number(bStr);
      fr.quats[b].copy(slerpHemisphere(fr.quats[b], qGuard, weight));
    }
    if (cyclicStrideSway && N > 2) {
      const phase = (f / (N - 1)) * Math.PI * 2;
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      fr.quats[BONE_IDX.Spine].multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.028 * c, 0.042 * s, 0.018 * s))
      ).normalize();
      fr.quats[BONE_IDX.Chest].multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.032 * c, 0.048 * s, -0.020 * s))
      ).normalize();
      fr.quats[BONE_IDX.LeftUpperArm].multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.055 * s, -0.040 * c, 0.032 * c))
      ).normalize();
      fr.quats[BONE_IDX.RightUpperArm].multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.045 * s, 0.038 * c, -0.028 * c))
      ).normalize();
      fr.quats[BONE_IDX.RightHand].multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.035 * c, -0.028 * s, 0.025 * s))
      ).normalize();
    }
  }
}

/**
 * Rotates world trajectory (endPos - startPos) around +Y to exact targetDeg (0° = +Z, +90° = +X)
 * and anchors Frame 0 horizontal X/Z at (0, 0).
 */
function alignTrajectoryToAzimuth(frames, targetDeg) {
  const N = frames.length;
  const p0 = frames[0].rootPos.clone();
  const pEnd = frames[N - 1].rootPos.clone();
  const dx = pEnd.x - p0.x;
  const dz = pEnd.z - p0.z;
  const curRad = Math.atan2(dx, dz);
  const tgtRad = (targetDeg * Math.PI) / 180;
  const qRotY = new THREE.Quaternion().setFromAxisAngle(_worldUp, tgtRad - curRad);

  for (const fr of frames) {
    fr.rootPos.x -= p0.x;
    fr.rootPos.z -= p0.z;
    fr.rootPos.applyQuaternion(qRotY);
    fr.quats[BONE_IDX.Hips].premultiply(qRotY).normalize();
  }
}

/**
 * Rotates entire clip around +Y so Frame 0 Hips horizontal forward vector aligns with +Z (0°),
 * and anchors Frame 0 horizontal X/Z at (0, 0).
 */
function alignStartFacingToPlusZ(frames, refFrameIdx = 0) {
  const p0 = frames[0].rootPos.clone();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(frames[refFrameIdx].quats[BONE_IDX.Hips]);
  fwd.y = 0;
  const startYaw = fwd.lengthSq() > 1e-6 ? Math.atan2(fwd.x, fwd.z) : 0;
  const qRotY = new THREE.Quaternion().setFromAxisAngle(_worldUp, -startYaw);

  for (const fr of frames) {
    fr.rootPos.x -= p0.x;
    fr.rootPos.z -= p0.z;
    fr.rootPos.applyQuaternion(qRotY);
    fr.quats[BONE_IDX.Hips].premultiply(qRotY).normalize();
  }
}

/**
 * 4-Step Cyclic 8-Way Treadmill Strafe Builder (m2_exp2 §2.2):
 * 1. Align world movement vector to exact targetDeg.
 * 2. Clamp pelvis yaw within ±10° of +Z while preserving world leg directions, orient Spine/Chest/Head to +Z,
 *    and blend Wuxia Taibai sword guard with cyclic stride counter-sway.
 * 3. Filter & lock feet in world mocap space (y = 8.0cm).
 * 4. Subtract linear treadmill displacement & apply C1 loop closure (seam = 0.00cm).
 */
function buildStrafeClip(rawText, { start120, end120, speedScale, targetDeg }) {
  let frames = retargetBVHSliceTo60(rawText, {
    start120,
    end120,
    speedScale,
    groundMode: 'upright8th',
  });

  // Step 1: Align world movement trajectory to exact compass azimuth
  alignTrajectoryToAzimuth(frames, targetDeg);

  // Step 2: Trim pelvis yaw toward +Z while preserving world leg orientations, orient torso to +Z, apply sword guard
  const { bones } = createBoneHierarchy();
  const qWorldLUp = new THREE.Quaternion();
  const qWorldRUp = new THREE.Quaternion();
  const qWorldSpine = new THREE.Quaternion();
  const qWorldChest = new THREE.Quaternion();
  const qWorldNeck = new THREE.Quaternion();
  const qWorldHead = new THREE.Quaternion();
  const qWorldHips = new THREE.Quaternion();
  const qParentInv = new THREE.Quaternion();

  for (const fr of frames) {
    applyFrameToBones(fr, bones);
    bones[BONE_IDX.Hips].getWorldQuaternion(qWorldHips);
    bones[BONE_IDX.LeftUpLeg].getWorldQuaternion(qWorldLUp);
    bones[BONE_IDX.RightUpLeg].getWorldQuaternion(qWorldRUp);
    bones[BONE_IDX.Spine].getWorldQuaternion(qWorldSpine);
    bones[BONE_IDX.Chest].getWorldQuaternion(qWorldChest);
    bones[BONE_IDX.Neck].getWorldQuaternion(qWorldNeck);
    bones[BONE_IDX.Head].getWorldQuaternion(qWorldHead);

    const hipsFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qWorldHips);
    hipsFwd.y = 0;
    const hipsYaw = hipsFwd.lengthSq() > 1e-5 ? Math.atan2(hipsFwd.x, hipsFwd.z) : 0;
    const clampedHipsYaw = THREE.MathUtils.clamp(hipsYaw, -0.17, 0.17);
    const qHipsFix = new THREE.Quaternion().setFromAxisAngle(_worldUp, clampedHipsYaw - hipsYaw);
    const qHipsTrimmed = qHipsFix.clone().multiply(qWorldHips).normalize();

    bones[BONE_IDX.Hips].quaternion.copy(qHipsTrimmed);
    bones[BONE_IDX.Hips].updateWorldMatrix(false, false);
    fr.quats[BONE_IDX.Hips].copy(qHipsTrimmed);

    // Keep exact world leg stepping directions
    qParentInv.copy(qHipsTrimmed).invert();
    fr.quats[BONE_IDX.LeftUpLeg].multiplyQuaternions(qParentInv, qWorldLUp).normalize();
    fr.quats[BONE_IDX.RightUpLeg].multiplyQuaternions(qParentInv, qWorldRUp).normalize();

    // Rotate Spine, Chest, Neck, Head around +Y so Chest & Head face +Z locked-on target
    const chestFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qWorldChest);
    chestFwd.y = 0;
    const chestYaw = chestFwd.lengthSq() > 1e-5 ? Math.atan2(chestFwd.x, chestFwd.z) : 0;
    const qSpineFix = new THREE.Quaternion().setFromAxisAngle(_worldUp, -chestYaw * 0.52);
    const qChestFix = new THREE.Quaternion().setFromAxisAngle(_worldUp, -chestYaw * 0.92);

    const qSpineNewWorld = qSpineFix.multiply(qWorldSpine).normalize();
    const qChestNewWorld = qChestFix.multiply(qWorldChest).normalize();

    const headFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qWorldHead);
    headFwd.y = 0;
    const headYaw = headFwd.lengthSq() > 1e-5 ? Math.atan2(headFwd.x, headFwd.z) : 0;
    const qNeckFix = new THREE.Quaternion().setFromAxisAngle(_worldUp, -headYaw * 0.65);
    const qHeadFix = new THREE.Quaternion().setFromAxisAngle(_worldUp, -headYaw * 0.95);
    const qNeckNewWorld = qNeckFix.multiply(qWorldNeck).normalize();
    const qHeadNewWorld = qHeadFix.multiply(qWorldHead).normalize();

    bones[BONE_IDX.Spine].quaternion.copy(qHipsTrimmed).invert().multiply(qSpineNewWorld).normalize();
    bones[BONE_IDX.Spine].updateWorldMatrix(false, false);
    fr.quats[BONE_IDX.Spine].copy(bones[BONE_IDX.Spine].quaternion);

    bones[BONE_IDX.Chest].quaternion.copy(qSpineNewWorld).invert().multiply(qChestNewWorld).normalize();
    bones[BONE_IDX.Chest].updateWorldMatrix(false, false);
    fr.quats[BONE_IDX.Chest].copy(bones[BONE_IDX.Chest].quaternion);

    bones[BONE_IDX.Neck].quaternion.copy(qChestNewWorld).invert().multiply(qNeckNewWorld).normalize();
    bones[BONE_IDX.Neck].updateWorldMatrix(false, false);
    fr.quats[BONE_IDX.Neck].copy(bones[BONE_IDX.Neck].quaternion);

    bones[BONE_IDX.Head].quaternion.copy(qNeckNewWorld).invert().multiply(qHeadNewWorld).normalize();
    bones[BONE_IDX.Head].updateWorldMatrix(false, false);
    fr.quats[BONE_IDX.Head].copy(bones[BONE_IDX.Head].quaternion);
  }

  applyTaibaiArmGuard(frames, 0.82, { cyclicStrideSway: true });

  // Step 3: World-space zero-phase smoothing + Analytic Two-Bone IK foot-lock
  frames = filterFramesZeroPhase(frames, 2, false);
  frames = lockFeetWithTwoBoneIK(frames, 60, false, {
    contactHeightThresh: 0.155,
    contactVelThresh: 0.95,
    floorY: 0.08,
    maxRampFrames: 3,
    keepFootFlat: true,
  });

  // Step 4: Treadmill linear horizontal de-trend + C1 loop closure (0.00 cm seam)
  const N = frames.length;
  const x0 = frames[0].rootPos.x;
  const z0 = frames[0].rootPos.z;
  const dx = frames[N - 1].rootPos.x - x0;
  const dz = frames[N - 1].rootPos.z - z0;
  for (let f = 0; f < N; f++) {
    const u = f / (N - 1);
    frames[f].rootPos.x -= x0 + u * dx;
    frames[f].rootPos.z -= z0 + u * dz;
  }

  frames = closeLoopAndStabilizeRoot(frames, false, 0.20, false);
  frames = applyCapsuleFloorClearance(frames, { cyclic: true });
  frames = enforceSwordTorsoClearance(frames, 0.30, true);
  frames = closeLoopAndStabilizeRoot(frames, false, 0.12, false);

  return frames;
}

/**
 * 08_wuxia_dash_canglong (49_04 [132, 246], 57f @ 60fps):
 * Burst forward lunge along +Z with chambered coil -> +Z sword spear thrust -> guard recovery.
 */
function buildDashCanglongClip(rawText) {
  let frames = retargetBVHSliceTo60(rawText, {
    start120: 132,
    end120: 246,
    speedScale: 1.0,
    groundMode: 'upright8th',
  });
  alignTrajectoryToAzimuth(frames, 0);

  const N = frames.length;
  const { bones } = createBoneHierarchy();
  const zBladeLocal = new THREE.Vector3(-0.619, 0.754, 0.219).normalize();
  const thrustBladeWorld = new THREE.Vector3(0.0, 0.03, 0.9995).normalize();
  const qThrustHandWorld = new THREE.Quaternion().setFromUnitVectors(zBladeLocal, thrustBladeWorld);

  const qChamberRUA = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.32, -0.35, 0.85));
  const qChamberRFA = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.45, 0.85, 0.20));
  const qChamberRH = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0.25, 0.30));

  const qThrustRUA = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.08, 1.18, 0.18));
  const qThrustRFA = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.04, 0.12, 0.02));

  const qCounterLUA = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, -0.48, -0.78));
  const qCounterLFA = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, -0.65, 0.15));

  for (let f = 0; f < N; f++) {
    const u = f / (N - 1);
    const fr = frames[f];

    // Orient Spine & Chest toward +Z, adding +Y shoulder-forward thrust twist during strike
    const thrustEnv =
      u < 0.14
        ? 0
        : u < 0.34
          ? THREE.MathUtils.smoothstep(u, 0.14, 0.34)
          : u < 0.74
            ? 1.0
            : 1.0 - THREE.MathUtils.smoothstep(u, 0.74, 0.96);

    const coilEnv = u < 0.20 ? Math.sin((u / 0.20) * Math.PI) : 0;

    const spineYaw = 0.22 * thrustEnv - 0.14 * coilEnv;
    const chestYaw = 0.26 * thrustEnv - 0.16 * coilEnv;
    const shYaw = 0.22 * thrustEnv;

    fr.quats[BONE_IDX.Spine].multiply(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.10 * thrustEnv, spineYaw, 0))
    ).normalize();
    fr.quats[BONE_IDX.Chest].multiply(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12 * thrustEnv, chestYaw, 0))
    ).normalize();
    fr.quats[BONE_IDX.RightShoulder].copy(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, shYaw, -0.05 * thrustEnv))
    );

    // Blend Right & Left arms across coil -> thrust -> guard
    let rua = slerpHemisphere(fr.quats[BONE_IDX.RightUpperArm], TAIBAI_GUARD_LOCAL[BONE_IDX.RightUpperArm], 0.78);
    let rfa = slerpHemisphere(fr.quats[BONE_IDX.RightForeArm], TAIBAI_GUARD_LOCAL[BONE_IDX.RightForeArm], 0.78);
    let rh = slerpHemisphere(fr.quats[BONE_IDX.RightHand], TAIBAI_GUARD_LOCAL[BONE_IDX.RightHand], 0.80);

    if (coilEnv > 0.01) {
      rua = slerpHemisphere(rua, qChamberRUA, coilEnv * 0.85);
      rfa = slerpHemisphere(rfa, qChamberRFA, coilEnv * 0.85);
      rh = slerpHemisphere(rh, qChamberRH, coilEnv * 0.85);
    }
    if (thrustEnv > 0.01) {
      rua = slerpHemisphere(rua, qThrustRUA, thrustEnv * 0.94);
      rfa = slerpHemisphere(rfa, qThrustRFA, thrustEnv * 0.94);
    }

    fr.quats[BONE_IDX.RightUpperArm].copy(rua);
    fr.quats[BONE_IDX.RightForeArm].copy(rfa);
    fr.quats[BONE_IDX.RightHand].copy(rh);

    const luaBase = slerpHemisphere(fr.quats[BONE_IDX.LeftUpperArm], TAIBAI_GUARD_LOCAL[BONE_IDX.LeftUpperArm], 0.75);
    const lfaBase = slerpHemisphere(fr.quats[BONE_IDX.LeftForeArm], TAIBAI_GUARD_LOCAL[BONE_IDX.LeftForeArm], 0.75);
    fr.quats[BONE_IDX.LeftUpperArm].copy(slerpHemisphere(luaBase, qCounterLUA, thrustEnv * 0.85));
    fr.quats[BONE_IDX.LeftForeArm].copy(slerpHemisphere(lfaBase, qCounterLFA, thrustEnv * 0.85));
    fr.quats[BONE_IDX.LeftHand].copy(TAIBAI_GUARD_LOCAL[BONE_IDX.LeftHand]);

    if (thrustEnv > 0.05) {
      applyFrameToBones(fr, bones);
      const qForeWorld = new THREE.Quaternion();
      bones[BONE_IDX.RightForeArm].getWorldQuaternion(qForeWorld);
      const qLocalThrustHand = qForeWorld.invert().multiply(qThrustHandWorld).normalize();
      fr.quats[BONE_IDX.RightHand].copy(
        slerpHemisphere(fr.quats[BONE_IDX.RightHand], qLocalThrustHand, thrustEnv * 0.95)
      );
    }
  }

  frames = filterFramesZeroPhase(frames, 2, false);
  frames = lockFeetWithTwoBoneIK(frames, 60, false, {
    contactHeightThresh: 0.145,
    contactVelThresh: 0.90,
    floorY: 0.08,
    maxRampFrames: 3,
    keepFootFlat: true,
  });
  frames = applyCapsuleFloorClearance(frames, { cyclic: false });
  frames = enforceSwordTorsoClearance(frames, 0.28);

  return frames;
}

/**
 * 09_wuxia_dodge_roll (90_34 [296, 512], speedScale 1.35 -> 80f @ 60fps):
 * Complete 360-degree forward somersault roll along +Z with full 21-bone floor capsule protection.
 */
function buildDodgeRollClip(rawText) {
  let frames = retargetBVHSliceTo60(rawText, {
    start120: 296,
    end120: 512,
    speedScale: 1.35,
    groundMode: 'upright8th',
  });
  alignTrajectoryToAzimuth(frames, 0);

  frames = filterFramesZeroPhase(frames, 2, false);
  frames = lockFeetWithTwoBoneIK(frames, 60, false, {
    contactHeightThresh: 0.15,
    contactVelThresh: 0.90,
    floorY: 0.08,
    maxRampFrames: 4,
    keepFootFlat: true,
  });
  frames = applyCapsuleFloorClearance(frames, { cyclic: false });

  return frames;
}

/**
 * 10_wuxia_double_jump (83_62 [168, 330], speedScale 1.08 -> 75f @ 60fps):
 * Upright 360-degree Qinggong aerial spin-jump with +12cm apex parabola boost and sword guard.
 */
function buildDoubleJumpClip(rawText) {
  let frames = retargetBVHSliceTo60(rawText, {
    start120: 168,
    end120: 330,
    speedScale: 1.08,
    groundMode: 'upright8th',
  });
  alignStartFacingToPlusZ(frames, 0);

  const N = frames.length;
  for (let f = 0; f < N; f++) {
    const u = f / (N - 1);
    if (u >= 0.22 && u <= 0.74) {
      const phase = ((u - 0.22) / (0.74 - 0.22)) * Math.PI;
      const boost = 0.12 * Math.pow(Math.sin(phase), 2);
      frames[f].rootPos.y += boost;
    }
  }

  applyTaibaiArmGuard(frames, 0.65);
  frames = filterFramesZeroPhase(frames, 2, false);
  frames = lockFeetWithTwoBoneIK(frames, 60, false, {
    contactHeightThresh: 0.145,
    contactVelThresh: 0.90,
    floorY: 0.08,
    maxRampFrames: 4,
    keepFootFlat: true,
  });
  frames = applyCapsuleFloorClearance(frames, { cyclic: false });
  frames = enforceSwordTorsoClearance(frames, 0.26);

  return frames;
}

/**
 * 11_wuxia_hit_light_L (144_07 [180, 268], 44f) & 12_wuxia_hit_light_R (144_26 [180, 268], 44f):
 * Opposite-sign lateral & backward stagger impulse with snappy recovery to Wuxia sword guard.
 */
function buildHitLightClip(rawText, isLeftHit) {
  let frames = retargetBVHSliceTo60(rawText, {
    start120: 180,
    end120: 268,
    speedScale: 1.0,
    groundMode: 'upright8th',
  });
  alignStartFacingToPlusZ(frames, 0);

  const N = frames.length;
  // Hit on Left (+X) recoils toward Right (-X) & Back (-Z), twisting Chest +Y;
  // Hit on Right (-X) recoils toward Left (+X) & Back (-Z), twisting Chest -Y.
  const sideSign = isLeftHit ? 1 : -1;

  const curEndX = frames[N - 1].rootPos.x;
  const curEndZ = frames[N - 1].rootPos.z;
  const targetNetX = isLeftHit ? Math.min(curEndX, -0.24) : Math.max(curEndX, 0.24);
  const targetNetZ = Math.min(curEndZ, -0.15);
  const extraX = targetNetX - curEndX;
  const extraZ = targetNetZ - curEndZ;

  for (let f = 0; f < N; f++) {
    const u = f / (N - 1);
    const stepShift = THREE.MathUtils.smoothstep(u, 0.05, 0.58);
    frames[f].rootPos.x += extraX * stepShift;
    frames[f].rootPos.z += extraZ * stepShift;

    // Sharp hit-flinch impulse peaking at u ~ 0.22 and recovering cleanly to 0 by u = 0.92
    let imp = 0;
    if (u >= 0.03 && u <= 0.92) {
      if (u < 0.22) {
        imp = THREE.MathUtils.smoothstep(u, 0.03, 0.22);
      } else {
        imp = 1.0 - THREE.MathUtils.smoothstep(u, 0.22, 0.92);
      }
    }

    const qSpineImpulse = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-0.18 * imp, sideSign * 0.24 * imp, -sideSign * 0.14 * imp)
    );
    const qChestImpulse = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-0.22 * imp, sideSign * 0.30 * imp, -sideSign * 0.16 * imp)
    );
    const qHeadImpulse = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-0.16 * imp, sideSign * 0.18 * imp, -sideSign * 0.10 * imp)
    );

    frames[f].quats[BONE_IDX.Spine].multiply(qSpineImpulse).normalize();
    frames[f].quats[BONE_IDX.Chest].multiply(qChestImpulse).normalize();
    frames[f].quats[BONE_IDX.Head].multiply(qHeadImpulse).normalize();
  }

  applyTaibaiArmGuard(frames, 0.58);
  frames = filterFramesZeroPhase(frames, 2, false);
  frames = lockFeetWithTwoBoneIK(frames, 60, false, {
    contactHeightThresh: 0.145,
    contactVelThresh: 0.88,
    floorY: 0.08,
    maxRampFrames: 3,
    keepFootFlat: true,
  });
  frames = applyCapsuleFloorClearance(frames, { cyclic: false });
  frames = enforceSwordTorsoClearance(frames, 0.26);

  return frames;
}

/**
 * 13_wuxia_knockdown (90_18 [64, 208], 72f @ 60fps):
 * Heavy impact backward -Z launch arc -> supine floor settle with capsule clearance.
 */
function buildKnockdownClip(rawText) {
  let frames = retargetBVHSliceTo60(rawText, {
    start120: 64,
    end120: 208,
    speedScale: 1.0,
    groundMode: 'upright8th',
  });
  alignStartFacingToPlusZ(frames, 0);

  const N = frames.length;
  const curEndZ = frames[N - 1].rootPos.z;
  const targetEndZ = -1.16; // -116 cm backward knockback along -Z
  const extraZ = targetEndZ - curEndZ;

  for (let f = 0; f < N; f++) {
    const u = f / (N - 1);
    const zCurve = THREE.MathUtils.smoothstep(u, 0.06, 0.68);
    frames[f].rootPos.z += extraZ * zCurve - (u > 0.06 && u < 0.68 ? 0 : 0);

    if (u >= 0.08 && u <= 0.46) {
      const arcPhase = ((u - 0.08) / (0.46 - 0.08)) * Math.PI;
      frames[f].rootPos.y += 0.16 * Math.sin(arcPhase);
    }
  }

  // Re-anchor frame 0 X/Z to exact (0,0)
  const x0 = frames[0].rootPos.x;
  const z0 = frames[0].rootPos.z;
  for (const fr of frames) {
    fr.rootPos.x -= x0;
    fr.rootPos.z -= z0;
  }

  frames = filterFramesZeroPhase(frames, 2, false);
  frames = lockFeetWithTwoBoneIK(frames, 60, false, {
    contactHeightThresh: 0.145,
    contactVelThresh: 0.85,
    floorY: 0.08,
    maxRampFrames: 3,
    keepFootFlat: true,
  });
  frames = applyCapsuleFloorClearance(frames, { cyclic: false });

  return frames;
}

/**
 * 14_wuxia_kipup (140_08 supine [186, 234] + stand [570, 684], 72f @ 60fps):
 * Supine knee-chamber tuck -> explosive 鲤鱼打挺 back-arch + leg-whip ballistic pop -> upright stance (+Z).
 */
function buildKipUpClip(rawText) {
  // Part A: Supine chambering on floor ([0..15] = 16 frames)
  const rawSupine = retargetBVHSliceTo60(rawText, {
    start120: 186,
    end120: 234,
    speedScale: 1.5,
    groundMode: 'minBody',
  });
  const supine16 = upsampleFramesSlerp(rawSupine, 16);

  // Orient supine actor so torso head->hips->feet aligns along -Z -> +Z (feet toward +Z, back on floor)
  {
    const { bones } = createBoneHierarchy();
    applyFrameToBones(supine16[0], bones);
    const pHead = new THREE.Vector3();
    const pHips = new THREE.Vector3();
    bones[BONE_IDX.Head].getWorldPosition(pHead);
    bones[BONE_IDX.Hips].getWorldPosition(pHips);
    // Vector from Head to Hips should point toward +Z so rising forward faces +Z
    const headToHips = new THREE.Vector3().subVectors(pHips, pHead);
    headToHips.y = 0;
    const curAz = headToHips.lengthSq() > 1e-5 ? Math.atan2(headToHips.x, headToHips.z) : 0;
    const qRot = new THREE.Quaternion().setFromAxisAngle(_worldUp, -curAz);
    const p0 = supine16[0].rootPos.clone();
    for (let i = 0; i < supine16.length; i++) {
      const fr = supine16[i];
      fr.rootPos.x -= p0.x;
      fr.rootPos.z -= p0.z;
      fr.rootPos.applyQuaternion(qRot);
      fr.quats[BONE_IDX.Hips].premultiply(qRot).normalize();

      // Progressive knee-chamber tuck on [4..15] before the explosive whip
      const chamber = THREE.MathUtils.smoothstep(i / 15, 0.2, 1.0);
      const qTuckUp = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.95 * chamber, 0, 0));
      const qTuckLo = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.15 * chamber, 0, 0));
      fr.quats[BONE_IDX.LeftUpLeg].multiply(qTuckUp).normalize();
      fr.quats[BONE_IDX.RightUpLeg].multiply(qTuckUp).normalize();
      fr.quats[BONE_IDX.LeftLeg].multiply(qTuckLo).normalize();
      fr.quats[BONE_IDX.RightLeg].multiply(qTuckLo).normalize();
    }
  }

  // Part C: Crouch landing to upright Wuxia combat stance ([36..71] = 36 frames)
  const rawStand = retargetBVHSliceTo60(rawText, {
    start120: 570,
    end120: 684,
    speedScale: 1.58,
    groundMode: 'upright8th',
  });
  const stand36 = upsampleFramesSlerp(rawStand, 36);
  // Align final upright facing to +Z
  alignStartFacingToPlusZ(stand36, stand36.length - 1);

  // Shift stand36 horizontal origin so landing occurs +18cm forward (+Z) from supine chamber
  const endSupX = supine16[15].rootPos.x;
  const endSupZ = supine16[15].rootPos.z;
  const standStartX = stand36[0].rootPos.x;
  const standStartZ = stand36[0].rootPos.z;
  for (let i = 0; i < stand36.length; i++) {
    stand36[i].rootPos.x += endSupX - standStartX;
    stand36[i].rootPos.z += endSupZ + 0.18 - standStartZ;
    const guardBlend = THREE.MathUtils.smoothstep(i / 35, 0.25, 0.95) * 0.75;
    for (const [bStr, qGuard] of Object.entries(TAIBAI_GUARD_LOCAL)) {
      const b = Number(bStr);
      stand36[i].quats[b].copy(slerpHemisphere(stand36[i].quats[b], qGuard, guardBlend));
    }
  }

  // Part B: Explosive 20-frame 鲤鱼打挺 ballistic arch-whip bridge ([16..35])
  const whip20 = [];
  const pStart = supine16[15].rootPos;
  const pLand = stand36[0].rootPos;
  for (let i = 0; i < 20; i++) {
    const w = (i + 1) / 21;
    const s = w * w * (3 - 2 * w);
    const fr = emptyFrame();
    fr.rootPos.lerpVectors(pStart, pLand, s);
    // Ballistic kip-up pop arc (+26cm at apex)
    fr.rootPos.y += 0.26 * Math.sin(w * Math.PI);

    for (let b = 0; b < NUM_BONES; b++) {
      fr.quats[b].copy(slerpHemisphere(supine16[15].quats[b], stand36[0].quats[b], s));
    }

    // Back-arch hyperextension + leg whip snap peaking mid-flight
    const arch = Math.sin(w * Math.PI);
    fr.quats[BONE_IDX.Spine].multiply(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.36 * arch, 0, 0))
    ).normalize();
    fr.quats[BONE_IDX.Chest].multiply(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.32 * arch, 0, 0))
    ).normalize();
    const whipSnap = Math.sin(Math.min(1, w * 1.25) * Math.PI);
    fr.quats[BONE_IDX.LeftUpLeg].multiply(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.42 * whipSnap, 0, 0))
    ).normalize();
    fr.quats[BONE_IDX.RightUpLeg].multiply(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.42 * whipSnap, 0, 0))
    ).normalize();

    whip20.push(fr);
  }

  let frames = [...supine16, ...whip20, ...stand36]; // 16 + 20 + 36 = 72 frames
  frames = filterFramesZeroPhase(frames, 2, false);
  frames = lockFeetWithTwoBoneIK(frames, 60, false, {
    contactHeightThresh: 0.15,
    contactVelThresh: 0.90,
    floorY: 0.08,
    maxRampFrames: 2,
    keepFootFlat: true,
  });
  frames = applyCapsuleFloorClearance(frames, { cyclic: false });

  return frames;
}

/**
 * 15_wuxia_knockdown_kipup (156f @ 60fps = 2.60s):
 * Seamless C1-continuous splice of 13_knockdown (72f) + 12f supine floor beat + 14_kipup (72f).
 */
function buildKnockdownKipupCombined(knockdownFrames, kipupFrames) {
  const kd = knockdownFrames.map(cloneFrame);
  const lastKd = kd[kd.length - 1];
  const firstKu = kipupFrames[0];

  const shiftX = lastKd.rootPos.x - firstKu.rootPos.x;
  const shiftZ = lastKd.rootPos.z - firstKu.rootPos.z;

  const kuShifted = kipupFrames.map((fr) => {
    const c = cloneFrame(fr);
    c.rootPos.x += shiftX;
    c.rootPos.z += shiftZ;
    return c;
  });

  const beatCount = 12;
  const beatFrames = [];
  const kuTarget0 = kuShifted[0];
  for (let i = 0; i < beatCount; i++) {
    const t = (i + 1) / (beatCount + 1);
    const alpha = t * t * (3 - 2 * t);
    const fr = emptyFrame();
    fr.rootPos.lerpVectors(lastKd.rootPos, kuTarget0.rootPos, alpha);
    for (let b = 0; b < NUM_BONES; b++) {
      fr.quats[b].copy(slerpHemisphere(lastKd.quats[b], kuTarget0.quats[b], alpha));
    }
    beatFrames.push(fr);
  }

  const combined = [...kd, ...beatFrames, ...kuShifted]; // 72 + 12 + 72 = 156 frames

  // Smooth strictly across the supine seam window [66..90] so knockdown & kipup peaks stay 100% crisp
  const smoothedAll = filterFramesZeroPhase(combined, 2, false);
  for (let f = 66; f <= 90; f++) {
    const w =
      f < 72
        ? THREE.MathUtils.smoothstep(f, 66, 72)
        : f > 84
          ? 1 - THREE.MathUtils.smoothstep(f, 84, 90)
          : 1.0;
    combined[f].rootPos.lerp(smoothedAll[f].rootPos, w);
    for (let b = 0; b < NUM_BONES; b++) {
      combined[f].quats[b].copy(slerpHemisphere(combined[f].quats[b], smoothedAll[f].quats[b], w));
    }
  }

  return applyCapsuleFloorClearance(combined, { cyclic: false });
}

export async function runProduceMvpBvh({
  rawDir = RAW_MOCAP_DIR,
  outDir = CLEAN_READY_DIR,
  quiet = false,
} = {}) {
  const t0 = performance.now();
  fs.mkdirSync(outDir, { recursive: true });
  const rawMap = await ensureCmuRawSources(rawDir, quiet);

  const specs = [
    {
      fileName: '07_wuxia_strafe_F_前垫步_cleaned.bvh',
      build: () =>
        buildStrafeClip(rawMap.get('143_32').text, {
          start120: 36,
          end120: 112,
          speedScale: 0.85,
          targetDeg: 0,
        }),
    },
    {
      fileName: '07_wuxia_strafe_B_后撤步_cleaned.bvh',
      build: () =>
        buildStrafeClip(rawMap.get('143_39').text, {
          start120: 945,
          end120: 1021,
          speedScale: 0.92,
          targetDeg: 180,
        }),
    },
    {
      fileName: '07_wuxia_strafe_L_左垫步_cleaned.bvh',
      build: () =>
        buildStrafeClip(rawMap.get('141_33').text, {
          start120: 663,
          end120: 803,
          speedScale: 1.05,
          targetDeg: 90,
        }),
    },
    {
      fileName: '07_wuxia_strafe_R_右垫步_cleaned.bvh',
      build: () =>
        buildStrafeClip(rawMap.get('141_33').text, {
          start120: 150,
          end120: 306,
          speedScale: 1.05,
          targetDeg: -90,
        }),
    },
    {
      fileName: '07_wuxia_strafe_FL_左前垫步_cleaned.bvh',
      build: () =>
        buildStrafeClip(rawMap.get('141_32').text, {
          start120: 684,
          end120: 756,
          speedScale: 0.85,
          targetDeg: 45,
        }),
    },
    {
      fileName: '07_wuxia_strafe_FR_右前垫步_cleaned.bvh',
      build: () =>
        buildStrafeClip(rawMap.get('141_32').text, {
          start120: 321,
          end120: 405,
          speedScale: 0.95,
          targetDeg: -45,
        }),
    },
    {
      fileName: '07_wuxia_strafe_BL_左后垫步_cleaned.bvh',
      build: () =>
        buildStrafeClip(rawMap.get('143_40').text, {
          start120: 338,
          end120: 414,
          speedScale: 0.95,
          targetDeg: 135,
        }),
    },
    {
      fileName: '07_wuxia_strafe_BR_右后垫步_cleaned.bvh',
      build: () =>
        buildStrafeClip(rawMap.get('143_40').text, {
          start120: 668,
          end120: 750,
          speedScale: 0.95,
          targetDeg: -135,
        }),
    },
    {
      fileName: '08_wuxia_dash_canglong_苍龙出水突刺_cleaned.bvh',
      build: () => buildDashCanglongClip(rawMap.get('49_04').text),
    },
    {
      fileName: '09_wuxia_dodge_roll_翻滚闪避_cleaned.bvh',
      build: () => buildDodgeRollClip(rawMap.get('90_34').text),
    },
    {
      fileName: '10_wuxia_double_jump_二段轻功跳_cleaned.bvh',
      build: () => buildDoubleJumpClip(rawMap.get('83_62').text),
    },
    {
      fileName: '11_wuxia_hit_light_L_左轻受击_cleaned.bvh',
      build: () => buildHitLightClip(rawMap.get('144_07').text, true),
    },
    {
      fileName: '12_wuxia_hit_light_R_右轻受击_cleaned.bvh',
      build: () => buildHitLightClip(rawMap.get('144_26').text, false),
    },
  ];

  const outputs = [];
  for (const spec of specs) {
    if (/^0[1-6]_/.test(spec.fileName)) {
      throw new Error(`Refusing to touch immutable 01..06 baseline file: ${spec.fileName}`);
    }
    const frames = spec.build();
    const bvhText = serializeFramesToBVH(frames, 60);
    const outPath = path.join(outDir, spec.fileName);
    fs.writeFileSync(outPath, bvhText, 'utf8');
    outputs.push({ fileName: spec.fileName, outPath, frames: frames.length, bytes: Buffer.byteLength(bvhText) });
    if (!quiet) {
      console.log(`  -> Wrote ${spec.fileName} (${frames.length}f @60fps, ${(frames.length / 60).toFixed(3)}s)`);
    }
  }

  // Build #14 (13_knockdown), #15 (14_kipup), and #16 (15_knockdown_kipup)
  const knockdownFrames = buildKnockdownClip(rawMap.get('90_18').text);
  const kipupFrames = buildKipUpClip(rawMap.get('140_08').text);
  const combinedFrames = buildKnockdownKipupCombined(knockdownFrames, kipupFrames);

  for (const [fileName, frames] of [
    ['13_wuxia_knockdown_击飞倒地_cleaned.bvh', knockdownFrames],
    ['14_wuxia_kipup_鲤鱼打挺起身_cleaned.bvh', kipupFrames],
    ['15_wuxia_knockdown_kipup_击飞倒地接鲤鱼打挺_cleaned.bvh', combinedFrames],
  ]) {
    const bvhText = serializeFramesToBVH(frames, 60);
    const outPath = path.join(outDir, fileName);
    fs.writeFileSync(outPath, bvhText, 'utf8');
    outputs.push({ fileName, outPath, frames: frames.length, bytes: Buffer.byteLength(bvhText) });
    if (!quiet) {
      console.log(`  -> Wrote ${fileName} (${frames.length}f @60fps, ${(frames.length / 60).toFixed(3)}s)`);
    }
  }

  if (!quiet) {
    console.log(
      `[produce_mvp_bvh] Produced ${outputs.length} Wuxia MVP BVH clips in ${((performance.now() - t0) / 1000).toFixed(2)}s.`
    );
  }

  return outputs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runProduceMvpBvh().catch((err) => {
    console.error('[produce_mvp_bvh] FATAL:', err);
    process.exit(1);
  });
}
