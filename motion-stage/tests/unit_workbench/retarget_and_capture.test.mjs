import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

import { BONE_DEFS, BONE_IDX } from '../../src/rig/HumanoidRig.js';
import { EXPORT_BONE_INDICES, exportCleanedClipToBVH } from '../../src/pipeline/BVHExporter.js';
import {
  BVH_TARGET_CANDIDATES,
  normalizeBVHBoneName,
  retargetBVHToFrames,
  parseBVHTextToClip,
  buildSlashClip,
} from '../../src/anim/MotionClips.js';
import {
  isSoftwareWebGL,
  resolvePreferredDelegate,
  advanceMonotonicVideoTimestampMs,
  getLastVideoTimestampMs,
  resolveTrimSamplingPlan,
  normalizeVideoUrlCallArgs,
  landmarksToHumanoidFrame,
  calibrateVideoSequenceMetrics,
} from '../../src/capture/VideoPoseCapture.js';

const BVH_READY_DIR = '/home/antigravity/bvh_library/B_cleaned_ready';

function matchesCandidate(boneIdx, rawBoneName) {
  const clean = normalizeBVHBoneName(rawBoneName);
  const entry = BVH_TARGET_CANDIDATES.find(([idx]) => idx === boneIdx);
  if (!entry) return false;
  return entry[1].some((rx) => rx.test(clean));
}

test('F5: BVH_TARGET_CANDIDATES covers all 21 standard bones and fixes RightLeg calf_r regex', () => {
  assert.equal(BVH_TARGET_CANDIDATES.length, 21);
  const candidateIdxSet = new Set(BVH_TARGET_CANDIDATES.map(([idx]) => idx));
  assert.equal(candidateIdxSet.size, 21);
  for (const expIdx of EXPORT_BONE_INDICES) {
    assert.ok(candidateIdxSet.has(expIdx), `Missing bone index ${expIdx} (${BONE_DEFS[expIdx].name})`);
  }

  // RightLeg (20) must match calf_r / shin.R / RightLowerLeg and NEVER match calf_l
  assert.equal(matchesCandidate(BONE_IDX.RightLeg, 'calf_r'), true);
  assert.equal(matchesCandidate(BONE_IDX.RightLeg, 'DEF-shin.R'), true);
  assert.equal(matchesCandidate(BONE_IDX.RightLeg, 'mixamorig:RightLeg'), true);
  assert.equal(matchesCandidate(BONE_IDX.RightLeg, 'RightLowerLeg'), true);
  assert.equal(matchesCandidate(BONE_IDX.RightLeg, 'calf_l'), false);
  assert.equal(matchesCandidate(BONE_IDX.RightLeg, 'DEF-shin.L'), false);

  // LeftToe (18) & RightToe (22) mappings across UE5, Mixamo, Unity, Rigify
  assert.equal(matchesCandidate(BONE_IDX.LeftToe, 'ball_l'), true);
  assert.equal(matchesCandidate(BONE_IDX.LeftToe, 'mixamorig:LeftToeBase'), true);
  assert.equal(matchesCandidate(BONE_IDX.LeftToe, 'LeftToes'), true);
  assert.equal(matchesCandidate(BONE_IDX.LeftToe, 'DEF-toe.L'), true);
  assert.equal(matchesCandidate(BONE_IDX.RightToe, 'ball_r'), true);
  assert.equal(matchesCandidate(BONE_IDX.RightToe, 'mixamorig:RightToeBase'), true);
  assert.equal(matchesCandidate(BONE_IDX.RightToe, 'RightToes'), true);
  assert.equal(matchesCandidate(BONE_IDX.RightToe, 'DEF-toe.R'), true);

  // Rigify underscore arm names (upper_arm.L -> upper_arm_l, forearm.R -> forearm_r)
  assert.equal(matchesCandidate(BONE_IDX.LeftUpperArm, 'DEF-upper_arm.L'), true);
  assert.equal(matchesCandidate(BONE_IDX.LeftForeArm, 'DEF-forearm.L'), true);
  assert.equal(matchesCandidate(BONE_IDX.RightUpperArm, 'ORG-upper_arm.R'), true);
  assert.equal(matchesCandidate(BONE_IDX.RightForeArm, 'ORG-forearm.R'), true);
});

test('F5: retargetBVHToFrames satisfies dual Array + Object contract and exact 60fps round-trip frame counts', () => {
  const expectedCounts = [
    ['01_wuxia_idle_待机呼吸_cleaned.bvh', 108],
    ['02_wuxia_run_疾跑轻功_cleaned.bvh', 52],
    ['03_wuxia_sword_combo_剑术连斩去穿模_cleaned.bvh', 82],
    ['04_wuxia_tornado_kick_旋风回旋踢_cleaned.bvh', 113],
    ['05_wuxia_front_kick_正蹬破防踢_cleaned.bvh', 87],
    ['06_wuxia_backflip_原地后空翻_cleaned.bvh', 72],
  ];

  for (const [fileName, expectedFrames] of expectedCounts) {
    const bvhText = fs.readFileSync(path.join(BVH_READY_DIR, fileName), 'utf8');
    const res = retargetBVHToFrames(bvhText, 60);

    // Contract 3: returns Frame[]
    assert.equal(Array.isArray(res), true);
    assert.equal(res.length, expectedFrames, `${fileName} dropped frames on 60fps re-import`);

    // Legacy / internal destructuring compatibility: { frames, totalFrames, fps }
    const { frames, totalFrames, fps } = res;
    assert.equal(frames, res);
    assert.equal(totalFrames, expectedFrames);
    assert.equal(fps, 60);
    assert.equal(frames[0].quats.length, 29);
  }
});

test('F5: retargetBVHToFrames lifts 240-frame cap, preserves Root Motion, and protects airborne clips', () => {
  const slash = buildSlashClip();
  // Create a 320-frame lunging clip moving +3.20m forward along +Z
  const longFrames = [];
  for (let i = 0; i < 320; i++) {
    const src = slash.frames[i % slash.frames.length];
    longFrames.push({
      rootPos: new THREE.Vector3(0.5, 0.94, 1.0 + (i / 319) * 3.2),
      quats: src.quats.map((q) => q.clone()),
      contactL: false,
      contactR: false,
    });
  }
  const longBvh = exportCleanedClipToBVH({ fps: 60 }, longFrames);

  // 1. Uncapped > 240 frames + preserveRootMotion: true (anchored at start X/Z = 0)
  const preserved = retargetBVHToFrames(longBvh, 60, {
    preserveRootMotion: true,
    rootOriginMode: 'start',
  });
  assert.equal(preserved.length, 320);
  assert.ok(Math.abs(preserved[0].rootPos.x) < 1e-4);
  assert.ok(Math.abs(preserved[0].rootPos.z) < 1e-4);
  assert.ok(Math.abs(preserved[319].rootPos.z - 3.2) < 1e-3, `Expected +3.2m Z lunge, got ${preserved[319].rootPos.z}`);

  // 2. Centered mode (preserveRootMotion: false) centers mean X/Z around 0
  const centered = retargetBVHToFrames(longBvh, 60, { preserveRootMotion: false });
  const meanZ = centered.reduce((s, fr) => s + fr.rootPos.z, 0) / centered.length;
  assert.ok(Math.abs(meanZ) < 1e-3);

  // 3. Explicit maxFrames cap works when requested
  const capped = retargetBVHToFrames(longBvh, 60, { maxFrames: 120 });
  assert.equal(capped.length, 120);

  // 4. Airborne canonical BVH keeps mid-air altitude without getting pulled down to 0.08m
  const airFrames = slash.frames.slice(0, 20).map((fr) => ({
    rootPos: new THREE.Vector3(0, 1.55, 0),
    quats: fr.quats.map(() => new THREE.Quaternion()),
    contactL: false,
    contactR: false,
  }));
  const airBvh = exportCleanedClipToBVH({ fps: 60 }, airFrames);
  const reAir = retargetBVHToFrames(airBvh, 60, { preserveRootMotion: true });
  assert.ok(reAir[0].rootPos.y > 1.45, `Airborne clip was pulled down: rootPos.y=${reAir[0].rootPos.y}`);
});

test('F5: UE5 ROOT root -> JOINT pelvis + spine_01..03 hierarchy maps pelvis and spine_03 accurately', () => {
  const ue5Bvh = `HIERARCHY
ROOT root
{
  OFFSET 0.0000 0.0000 0.0000
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT pelvis
  {
    OFFSET 0.0000 94.0000 0.0000
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT spine_01
    {
      OFFSET 0.0000 14.0000 0.0000
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT spine_02
      {
        OFFSET 0.0000 11.0000 0.0000
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT spine_03
        {
          OFFSET 0.0000 11.0000 0.0000
          CHANNELS 3 Zrotation Xrotation Yrotation
          End Site
          {
            OFFSET 0.0000 10.0000 0.0000
          }
        }
      }
    }
    JOINT thigh_l
    {
      OFFSET 10.5000 -4.0000 0.0000
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT calf_l
      {
        OFFSET 0.0000 -41.0000 0.0000
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT foot_l
        {
          OFFSET 0.0000 -41.0000 0.0000
          CHANNELS 3 Zrotation Xrotation Yrotation
          End Site
          {
            OFFSET 0.0000 0.0000 6.0000
          }
        }
      }
    }
    JOINT thigh_r
    {
      OFFSET -10.5000 -4.0000 0.0000
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT calf_r
      {
        OFFSET 0.0000 -41.0000 0.0000
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT foot_r
        {
          OFFSET 0.0000 -41.0000 0.0000
          CHANNELS 3 Zrotation Xrotation Yrotation
          End Site
          {
            OFFSET 0.0000 0.0000 6.0000
          }
        }
      }
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.016667
0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 45 0 0 0 0 0 0 0 0 0 0 0 0 -30 0 0 0 0 0
0 0 120 0 0 0 0 0 0 0 0 0 0 0 0 0 0 45 0 0 0 0 0 0 0 0 0 0 0 0 -30 0 0 0 0 0
`;
  const frames = retargetBVHToFrames(ue5Bvh, 60, { preserveRootMotion: true });
  assert.equal(frames.length, 2);
  // Root forward motion of 120cm = 1.20m preserved
  assert.ok(Math.abs(frames[1].rootPos.z - 1.2) < 1e-2);
  // spine_03 (45 deg yaw) mapped to Chest (index 2), NOT spine_02 (0 deg)
  const chestAngle = 2 * Math.acos(Math.min(1, Math.abs(frames[0].quats[BONE_IDX.Chest].w)));
  assert.ok(chestAngle > 0.6, `Expected spine_03 rotation on Chest, got ${chestAngle} rad`);
  // calf_r (-30 deg) mapped to RightLeg (20), while calf_l (0 deg) stayed identity on LeftLeg (16)
  const rLegAngle = 2 * Math.acos(Math.min(1, Math.abs(frames[0].quats[BONE_IDX.RightLeg].w)));
  const lLegAngle = 2 * Math.acos(Math.min(1, Math.abs(frames[0].quats[BONE_IDX.LeftLeg].w)));
  assert.ok(rLegAngle > 0.4, `Expected calf_r rotation on RightLeg, got ${rLegAngle} rad`);
  assert.ok(lLegAngle < 1e-3, `Expected identity on LeftLeg, got ${lLegAngle} rad`);
});

test('F5: parseBVHTextToClip auto-detects cyclic vs nonCyclic filenames and defaults preserveRootMotion=true', () => {
  const bvhText = fs.readFileSync(
    path.join(BVH_READY_DIR, '01_wuxia_idle_待机呼吸_cleaned.bvh'),
    'utf8'
  );

  const idleClip = parseBVHTextToClip(bvhText, '01_wuxia_idle_待机呼吸_cleaned.bvh');
  assert.equal(idleClip.nonCyclic, false);
  assert.equal(idleClip.preserveRootMotion, true);
  assert.equal(idleClip.rawBVHText, bvhText);

  const strafeClip = parseBVHTextToClip(bvhText, '07_wuxia_strafe_FL_左前垫步_cleaned.bvh');
  assert.equal(strafeClip.nonCyclic, false);

  const taibai01b = parseBVHTextToClip(bvhText, 'taibai_01b_崖顶横剑定势_cleaned.bvh');
  assert.equal(taibai01b.nonCyclic, false);
  assert.equal(taibai01b.hasWeapon, true);

  const dashClip = parseBVHTextToClip(bvhText, '08_wuxia_dash_canglong_苍龙出水突刺_cleaned.bvh');
  assert.equal(dashClip.nonCyclic, true);
  assert.equal(dashClip.hasWeapon, true);
  assert.equal(dashClip.isCombatAttack, true);

  const customClip = parseBVHTextToClip(bvhText, 'Custom.bvh');
  assert.equal(customClip.nonCyclic, true);
});

test('F6: VideoPoseCapture delegate detection, monotonic timestamps, trim plan & polymorphic args', () => {
  // Node environment -> software fallback ('CPU')
  assert.equal(isSoftwareWebGL(), true);
  assert.equal(resolvePreferredDelegate('auto'), 'CPU');
  assert.equal(resolvePreferredDelegate('CPU'), 'CPU');
  assert.equal(resolvePreferredDelegate('GPU'), 'GPU');

  // Monotonic timestamp watermark across backward re-trims
  const ts1 = advanceMonotonicVideoTimestampMs(50.0);
  const ts2 = advanceMonotonicVideoTimestampMs(52.5);
  const tsAfterRewind = advanceMonotonicVideoTimestampMs(0.0);
  assert.ok(ts2 > ts1);
  assert.ok(tsAfterRewind > ts2, `Re-trimmed 0.0s timestamp (${tsAfterRewind}) must exceed prior (${ts2})`);
  assert.equal(getLastVideoTimestampMs(), tsAfterRewind);

  // Trim sampling plan: full 5.125s on video 03 without old 8s/truncation issues, plus 75.9s master video 05 slice
  const plan03 = resolveTrimSamplingPlan(5.125, { targetFps: 24 });
  assert.equal(plan03.trimIn, 0);
  assert.equal(plan03.trimOut, 5.125);
  assert.equal(plan03.totalSamples, 123);

  const plan05 = resolveTrimSamplingPlan(75.9, {
    trimInSec: 26.72,
    trimOutSec: 31.77,
    targetFps: 60,
  });
  assert.equal(plan05.sampleFps, 60);
  assert.ok(Math.abs(plan05.spanSec - 5.05) < 1e-6);
  assert.equal(plan05.totalSamples, 303);

  // Polymorphic argument normalization for extractClipFromVideoUrl
  const cb = () => {};
  const styleLegacy = normalizeVideoUrlCallArgs(['/a.webm', '/a.mp4'], { id: 'demo', hasWeapon: false }, cb);
  assert.deepEqual(styleLegacy.urls, ['/a.webm', '/a.mp4']);
  assert.equal(styleLegacy.clipId, 'demo');
  assert.equal(styleLegacy.hasWeapon, false);
  assert.equal(styleLegacy.onProgress, cb);

  const styleContract = normalizeVideoUrlCallArgs('/reference_videos/03.mp4', 'taibai_03', cb, {
    targetFps: 30,
    trimInSec: 0.5,
  });
  assert.deepEqual(styleContract.urls, ['/reference_videos/03.mp4']);
  assert.equal(styleContract.clipId, 'taibai_03');
  assert.equal(styleContract.onProgress, cb);
  assert.equal(styleContract.options.targetFps, 30);
});

test('F6: landmarksToHumanoidFrame & calibrateVideoSequenceMetrics produce grounded 29-bone poses', () => {
  const makeSyntheticLandmarks = (hipShiftX = 0) => {
    const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
    // Shoulders (11 L, 12 R), Hips (23 L, 24 R) in MediaPipe coords (+y is down)
    world[0] = { x: 0, y: -0.62, z: -0.08 }; // Nose
    world[7] = { x: 0.07, y: -0.60, z: 0 };
    world[8] = { x: -0.07, y: -0.60, z: 0 };
    world[11] = { x: 0.18, y: -0.42, z: 0 };
    world[12] = { x: -0.18, y: -0.42, z: 0 };
    world[13] = { x: 0.42, y: -0.42, z: 0 };
    world[14] = { x: -0.42, y: -0.42, z: 0 };
    world[15] = { x: 0.66, y: -0.42, z: 0 };
    world[16] = { x: -0.66, y: -0.42, z: 0 };
    world[17] = { x: 0.74, y: -0.43, z: 0 };
    world[19] = { x: 0.74, y: -0.41, z: -0.02 };
    world[21] = { x: 0.72, y: -0.39, z: -0.03 };
    world[18] = { x: -0.74, y: -0.43, z: 0 };
    world[20] = { x: -0.74, y: -0.41, z: -0.02 };
    world[22] = { x: -0.72, y: -0.39, z: -0.03 };
    world[23] = { x: 0.11, y: 0.0, z: 0 };
    world[24] = { x: -0.11, y: 0.0, z: 0 };
    world[25] = { x: 0.11, y: 0.41, z: -0.02 };
    world[26] = { x: -0.11, y: 0.41, z: -0.02 };
    world[27] = { x: 0.11, y: 0.82, z: 0 };
    world[28] = { x: -0.11, y: 0.82, z: 0 };
    world[29] = { x: 0.11, y: 0.84, z: 0.03 };
    world[30] = { x: -0.11, y: 0.84, z: 0.03 };
    world[31] = { x: 0.11, y: 0.84, z: -0.10 };
    world[32] = { x: -0.11, y: 0.84, z: -0.10 };

    const norm = world.map((p) => ({
      x: 0.5 + hipShiftX + p.x * 0.45,
      y: 0.5 + p.y * 0.45,
      z: p.z,
    }));
    return { world, norm };
  };

  const seq = [-0.06, -0.02, 0.02, 0.06].map((dx) => {
    const { world, norm } = makeSyntheticLandmarks(dx);
    return landmarksToHumanoidFrame(world, norm);
  });

  calibrateVideoSequenceMetrics(seq);

  for (const fr of seq) {
    assert.equal(fr._imgMeta, undefined);
    assert.equal(fr.quats.length, 29);
    assert.ok(Number.isFinite(fr.rootPos.x) && Number.isFinite(fr.rootPos.y) && Number.isFinite(fr.rootPos.z));
    for (const q of fr.quats) {
      assert.ok(Math.abs(q.length() - 1) < 1e-4);
    }
  }
  assert.ok(seq[3].rootPos.x > seq[0].rootPos.x, 'Horizontal stride metric calibration should preserve +X translation');
});
