import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

import { BONE_DEFS, BONE_IDX, createBoneHierarchy } from '../../src/rig/HumanoidRig.js';
import {
  retargetBVHToFrames,
  parseBVHTextToClip,
  buildSlashClip,
} from '../../src/anim/MotionClips.js';
import {
  solveTwoBoneLegIK,
  SpringClothSolver,
} from '../../src/pipeline/TwoBoneIK.js';
import { landmarksToHumanoidFrame } from '../../src/capture/VideoPoseCapture.js';
import {
  DEFAULT_CLEAN_OPTIONS,
  DEFAULT_COMBAT_CURVE,
  sanitizeCombatCurveOptions,
  runCleaningPipeline,
  sampleInterpolatedFrame,
  computeBakedFrameCount,
  bakeWarpedFrames,
  createCombatTimeRemapper,
  remapCombatTime,
} from '../../src/pipeline/MotionCleaner.js';
import { createWorkbenchPanel } from '../../src/ui/WorkbenchPanel.js';

const BVH_READY_DIR = '/home/antigravity/bvh_library/B_cleaned_ready';

function assertUnitQuat(q, label = 'quat') {
  assert.ok(
    Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w),
    `${label} has non-finite component: (${q.x}, ${q.y}, ${q.z}, ${q.w})`
  );
  const len = q.length();
  assert.ok(Math.abs(len - 1) < 1e-5, `${label} is not unit length: len=${len}`);
}

test('Challenger Fix #1: Mixamo colon-prefixed & Rigify dot-suffixed .bvh retarget with zero PropertyBinding warnings', () => {
  const mixamoBvh = `HIERARCHY
ROOT mixamorig:Hips
{
  OFFSET 0.0000 94.0000 0.0000
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT mixamorig:Spine
  {
    OFFSET 0.0000 12.0000 0.0000
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT mixamorig:Spine2
    {
      OFFSET 0.0000 16.0000 0.0000
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT mixamorig:RightShoulder
      {
        OFFSET -6.0000 12.0000 0.0000
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT mixamorig:RightArm
        {
          OFFSET -12.0000 0.0000 0.0000
          CHANNELS 3 Zrotation Xrotation Yrotation
          JOINT mixamorig:RightForeArm
          {
            OFFSET -26.0000 0.0000 0.0000
            CHANNELS 3 Zrotation Xrotation Yrotation
            JOINT mixamorig:RightHand
            {
              OFFSET -24.0000 0.0000 0.0000
              CHANNELS 3 Zrotation Xrotation Yrotation
              End Site
              {
                OFFSET -10.0000 0.0000 0.0000
              }
            }
          }
        }
      }
    }
  }
  JOINT mixamorig:LeftUpLeg
  {
    OFFSET 10.5000 -4.0000 0.0000
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT mixamorig:LeftLeg
    {
      OFFSET 0.0000 -41.0000 0.0000
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT mixamorig:LeftFoot
      {
        OFFSET 0.0000 -41.0000 0.0000
        CHANNELS 3 Zrotation Xrotation Yrotation
        End Site
        {
          OFFSET 0.0000 0.0000 8.0000
        }
      }
    }
  }
  JOINT mixamorig:RightUpLeg
  {
    OFFSET -10.5000 -4.0000 0.0000
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT mixamorig:RightLeg
    {
      OFFSET 0.0000 -41.0000 0.0000
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT mixamorig:RightFoot
      {
        OFFSET 0.0000 -41.0000 0.0000
        CHANNELS 3 Zrotation Xrotation Yrotation
        End Site
        {
          OFFSET 0.0000 0.0000 8.0000
        }
      }
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.016667
0 94 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
0 94 110 0 0 0 0 0 0 0 0 38 0 0 0 -55 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -48 0 0 0 0
`;

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };

  let frames;
  try {
    frames = retargetBVHToFrames(mixamoBvh, 60, { preserveRootMotion: true });
  } finally {
    console.warn = origWarn;
  }

  const bindingWarnings = warnings.filter((w) => w.includes('PropertyBinding'));
  assert.deepEqual(bindingWarnings, [], `Unexpected THREE.PropertyBinding warnings: ${bindingWarnings.join('; ')}`);
  assert.equal(frames.length, 2);

  // Verify root translation (+110cm -> ~1.10m) and non-identity Mixamo joint rotations
  assert.ok(frames[1].rootPos.z > 0.9, `Expected Mixamo +Z root motion > 0.9m, got ${frames[1].rootPos.z}`);

  const chestAng = 2 * Math.acos(Math.min(1, Math.abs(frames[1].quats[BONE_IDX.Chest].w)));
  const rArmAng = 2 * Math.acos(Math.min(1, Math.abs(frames[1].quats[BONE_IDX.RightUpperArm].w)));
  const rLegAng = 2 * Math.acos(Math.min(1, Math.abs(frames[1].quats[BONE_IDX.RightLeg].w)));

  assert.ok(chestAng > 0.45, `Expected Mixamo Spine2 rotation on Chest, got ${chestAng}`);
  assert.ok(rArmAng > 0.65, `Expected Mixamo RightArm rotation on RightUpperArm, got ${rArmAng}`);
  assert.ok(rLegAng > 0.55, `Expected Mixamo RightLeg rotation on RightLeg, got ${rLegAng}`);
});

test('Challenger Fix #2: sampleInterpolatedFrame & bakeWarpedFrames sanitize zero, NaN, scaled, and overflow quaternions & rootPos', () => {
  const slash = buildSlashClip();
  const adversarial = slash.frames.slice(0, 8).map((fr, idx) => ({
    rootPos:
      idx === 2
        ? new THREE.Vector3(NaN, Infinity, -Infinity)
        : fr.rootPos.clone(),
    quats: fr.quats.map((q) => q.clone()),
    lockWeightL: idx === 2 ? NaN : 0.5,
    lockWeightR: idx === 3 ? Infinity : 0.25,
    anchorL: idx === 2 ? new THREE.Vector3(NaN, 0.08, Infinity) : null,
    anchorR: null,
  }));

  // Inject adversarial quaternions across multiple bones and frames
  adversarial[0].quats[BONE_IDX.Hips] = new THREE.Quaternion(0, 0, 0, 0);
  adversarial[1].quats[BONE_IDX.RightUpperArm] = new THREE.Quaternion(NaN, 0, Infinity, 1);
  adversarial[2].quats[BONE_IDX.LeftLeg] = new THREE.Quaternion(0.05, 0, 0, 0.05); // unnormalized 0.07x
  adversarial[3].quats[BONE_IDX.RightHand] = new THREE.Quaternion(4.0, -4.0, 4.0, 4.0); // unnormalized 8x
  adversarial[4].quats[BONE_IDX.Chest] = new THREE.Quaternion(1e200, 0, 0, 1e200); // lenSq overflow

  const pose = {
    rootPos: new THREE.Vector3(),
    quats: Array.from({ length: BONE_DEFS.length }, () => new THREE.Quaternion()),
  };

  // 1-frame and multi-frame fractional interpolation
  sampleInterpolatedFrame([adversarial[0]], 0, pose, true);
  assert.ok(Number.isFinite(pose.rootPos.x + pose.rootPos.y + pose.rootPos.z));
  pose.quats.forEach((q, i) => assertUnitQuat(q, `1-frame q[${i}]`));

  for (const ff of [0, 0.4, 1.5, 2.35, 3.7, 7.0, NaN]) {
    sampleInterpolatedFrame(adversarial, ff, pose, true);
    assert.ok(Number.isFinite(pose.rootPos.x + pose.rootPos.y + pose.rootPos.z));
    assert.ok(Number.isFinite(pose.lockWeightL) && Number.isFinite(pose.lockWeightR));
    pose.quats.forEach((q, i) => assertUnitQuat(q, `sample(${ff}) q[${i}]`));
  }

  // bakeWarpedFrames across 1-frame, mode='off', and mode='single'
  for (const [src, mode] of [
    [[adversarial[0]], 'single'],
    [adversarial, 'off'],
    [adversarial, 'single'],
  ]) {
    const baked = bakeWarpedFrames(src, { fps: 60, nonCyclic: true }, { mode, hitstopFrames: 3 });
    assert.ok(baked.length >= 1);
    for (let f = 0; f < baked.length; f++) {
      const fr = baked[f];
      assert.ok(Number.isFinite(fr.rootPos.x + fr.rootPos.y + fr.rootPos.z), `baked[${f}].rootPos non-finite`);
      if (fr.anchorL) {
        assert.ok(Number.isFinite(fr.anchorL.x + fr.anchorL.y + fr.anchorL.z));
      }
      fr.quats.forEach((q, i) => assertUnitQuat(q, `baked(${mode})[${f}].quats[${i}]`));
    }
  }
});

test('Challenger Fix #3: parseBVHTextToClip cyclic regex anchors ASCII tokens on non-letter boundaries', () => {
  const bvhText = fs.readFileSync(
    path.join(BVH_READY_DIR, '01_wuxia_idle_待机呼吸_cleaned.bvh'),
    'utf8'
  );

  // Substring false-positive traps MUST remain nonCyclic === true
  for (const nonCyclicName of [
    'drunk_sword_slash.bvh',
    'grunt_hit_react.bvh',
    'handstand_flip.bvh',
    'overrun_combo.bvh',
    'bystander_knockdown.bvh',
    'walkway_ambush_slash.bvh',
  ]) {
    const clip = parseBVHTextToClip(bvhText, nonCyclicName);
    assert.equal(clip.nonCyclic, true, `${nonCyclicName} was misclassified as cyclic`);
  }

  // Genuine cyclic filenames MUST resolve to nonCyclic === false
  for (const cyclicName of [
    '01_wuxia_idle_待机呼吸_cleaned.bvh',
    '02_wuxia_run_疾跑轻功_cleaned.bvh',
    '07_wuxia_strafe_BR_右后垫步_cleaned.bvh',
    '07_wuxia_strafe_B_后撤步_cleaned.bvh',
    'taibai_01b_崖顶横剑定势_cleaned.bvh',
    'idle.bvh',
    'run_01.bvh',
    'walk-loop.bvh',
  ]) {
    const clip = parseBVHTextToClip(bvhText, cyclicName);
    assert.equal(clip.nonCyclic, false, `${cyclicName} should be detected as cyclic`);
  }
});

test('Challenger Fix #4: solveTwoBoneLegIK eliminates collinear (0, 0, +-1) pole singularity across full S^2 sphere', () => {
  const { bones } = createBoneHierarchy();
  bones[0].position.set(0, 0.94, 0);
  bones[0].updateWorldMatrix(true, true);

  const hipPos = new THREE.Vector3();
  bones[BONE_IDX.LeftUpLeg].getWorldPosition(hipPos);

  // Exact L1*sqrt(2) = 0.41 * 1.41421356 = 0.57982756m along +Z and -Z where old fallback collapsed _kPos === _aPos!
  const criticalDist = 0.41 * Math.SQRT2;
  const criticalCases = [
    {
      label: '+Z critical collinear',
      target: hipPos.clone().add(new THREE.Vector3(0, 0, criticalDist)),
      pole: hipPos.clone().add(new THREE.Vector3(0, 0, 1)),
    },
    {
      label: '-Z critical collinear',
      target: hipPos.clone().add(new THREE.Vector3(0, 0, -criticalDist)),
      pole: hipPos.clone().add(new THREE.Vector3(0, 0, -1)),
    },
    {
      label: 'zero pole vector',
      target: hipPos.clone().add(new THREE.Vector3(0, 0, criticalDist)),
      pole: hipPos.clone(),
    },
    {
      label: 'coincident hip==target',
      target: hipPos.clone(),
      pole: hipPos.clone(),
    },
    {
      label: 'NaN pole fallback',
      target: hipPos.clone().add(new THREE.Vector3(0, -0.72, 0.15)),
      pole: new THREE.Vector3(NaN, Infinity, 0),
    },
  ];

  const solvedAnkle = new THREE.Vector3();
  for (const tc of criticalCases) {
    bones[BONE_IDX.LeftUpLeg].quaternion.identity();
    bones[BONE_IDX.LeftLeg].quaternion.identity();
    bones[BONE_IDX.LeftFoot].quaternion.identity();

    solveTwoBoneLegIK(
      bones[BONE_IDX.LeftUpLeg],
      bones[BONE_IDX.LeftLeg],
      bones[BONE_IDX.LeftFoot],
      tc.target,
      tc.pole,
      true
    );

    assertUnitQuat(bones[BONE_IDX.LeftUpLeg].quaternion, `${tc.label} UpLeg`);
    assertUnitQuat(bones[BONE_IDX.LeftLeg].quaternion, `${tc.label} Leg`);
    assertUnitQuat(bones[BONE_IDX.LeftFoot].quaternion, `${tc.label} Foot`);

    bones[BONE_IDX.LeftFoot].getWorldPosition(solvedAnkle);
    assert.ok(Number.isFinite(solvedAnkle.x + solvedAnkle.y + solvedAnkle.z));
    if (tc.label.includes('critical')) {
      assert.ok(
        solvedAnkle.distanceTo(tc.target) < 1e-3,
        `${tc.label}: ankle missed target (${solvedAnkle.distanceTo(tc.target)})`
      );
    }
  }

  // Full sphere sweep with collinear poles
  for (let i = 0; i < 64; i++) {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / 64);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const dir = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi)
    );
    const tgt = hipPos.clone().addScaledVector(dir, criticalDist);
    const collinearPole = hipPos.clone().addScaledVector(dir, 1.0);

    solveTwoBoneLegIK(
      bones[BONE_IDX.RightUpLeg],
      bones[BONE_IDX.RightLeg],
      bones[BONE_IDX.RightFoot],
      tgt,
      collinearPole,
      true
    );
    assertUnitQuat(bones[BONE_IDX.RightUpLeg].quaternion, `S2[${i}] UpLeg`);
    assertUnitQuat(bones[BONE_IDX.RightLeg].quaternion, `S2[${i}] Leg`);
    assertUnitQuat(bones[BONE_IDX.RightFoot].quaternion, `S2[${i}] Foot`);
  }
});

test('Challenger Fix #5: SpringClothSolver.update guards zero, negative, and non-finite dt & speed', () => {
  const { bones } = createBoneHierarchy();
  const solver = new SpringClothSolver();
  solver.reset(bones);

  const adversarialDts = [0.016, 0, -0.5, -100, NaN, Infinity, -Infinity, undefined, null, 'bad', 0.016];
  for (const badDt of adversarialDts) {
    bones[0].position.z += 0.05;
    solver.update(bones, badDt, true, NaN);

    for (const idx of [
      BONE_IDX.SkirtFront,
      BONE_IDX.SkirtBack,
      BONE_IDX.Cape01,
      BONE_IDX.Cape02,
      BONE_IDX.Cape03,
      BONE_IDX.Cape04,
    ]) {
      assertUnitQuat(bones[idx].quaternion, `Cloth bone ${idx} after dt=${String(badDt)}`);
    }
  }
});

test('Challenger Fix #6: landmarksToHumanoidFrame produces finite unit quaternions on all-zero, coincident, and NaN landmarks', () => {
  const zeroLm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  const sameLm = Array.from({ length: 33 }, () => ({ x: 0.35, y: -0.4, z: 0.2 }));
  const collinearZLm = Array.from({ length: 33 }, (_, i) => ({ x: 0, y: 0, z: i * 0.03 }));
  const nanLm = Array.from({ length: 33 }, (_, i) =>
    i % 2 === 0 ? { x: NaN, y: Infinity, z: -Infinity } : { x: 0, y: 0, z: 0 }
  );

  for (const [label, lm] of [
    ['all-zero', zeroLm],
    ['coincident', sameLm],
    ['collinear-Z', collinearZLm],
    ['partial-NaN', nanLm],
  ]) {
    const frame = landmarksToHumanoidFrame(lm, lm);
    assert.ok(
      Number.isFinite(frame.rootPos.x + frame.rootPos.y + frame.rootPos.z),
      `${label}: rootPos non-finite`
    );
    assert.equal(frame.quats.length, 29);
    frame.quats.forEach((q, idx) => assertUnitQuat(q, `${label} quats[${idx}]`));
  }
});

test('Challenger Fix #7 & #8: option sanitizers, custom targetFps retarget preservation, and WorkbenchPanel step=0.01', () => {
  const slash = buildSlashClip();

  // 1. runCleaningPipeline sanitizes NaN / Infinity / out-of-range options while keeping auto-sigma null when null
  const autoSigmaRes = runCleaningPipeline(slash, { filterSigma: null });
  assert.equal(autoSigmaRes.appliedOptions.filterSigma, null);

  const nanCleanRes = runCleaningPipeline(slash, {
    filterRadius: NaN,
    filterSigma: NaN,
    contactHeightThresh: NaN,
    contactVelThresh: Infinity,
    ikBlend: NaN,
    floorY: -Infinity,
    stanceRampRatio: 99,
    pelvisPullWeight: -3,
    seamRatio: Infinity,
    forearmTwistShare: NaN,
  });
  for (const key of Object.keys(DEFAULT_CLEAN_OPTIONS)) {
    const val = nanCleanRes.appliedOptions[key];
    if (typeof val === 'number') {
      assert.ok(Number.isFinite(val), `appliedOptions.${key} is not finite: ${val}`);
    }
  }
  assert.ok(Number.isFinite(nanCleanRes.appliedOptions.filterSigma));

  // 2. sanitizeCombatCurveOptions enforces windupEnd < strikeEnd and finite clamped speeds/frames
  const sanitizedCurve = sanitizeCombatCurveOptions({
    mode: 'invalid_mode',
    windupEnd: 0.88,
    strikeEnd: 0.15,
    windupSpeed: -5,
    strikeSpeed: NaN,
    hitstopFrames: Infinity,
    recoverySpeed: 0,
  });
  assert.equal(sanitizedCurve.mode, DEFAULT_COMBAT_CURVE.mode);
  assert.ok(sanitizedCurve.windupEnd < sanitizedCurve.strikeEnd);
  for (const [k, v] of Object.entries(sanitizedCurve)) {
    if (typeof v === 'number') {
      assert.ok(Number.isFinite(v) && v >= 0, `combatCurve.${k} invalid: ${v}`);
    }
  }

  // 3. parseBVHTextToClip preserves custom targetFps=30 across preserveRootMotion re-retarget
  const bvh05 = fs.readFileSync(
    path.join(BVH_READY_DIR, '05_wuxia_front_kick_正蹬破防踢_cleaned.bvh'),
    'utf8'
  );
  const clip30 = parseBVHTextToClip(bvh05, '05_custom30.bvh', { targetFps: 30, preserveRootMotion: true });
  assert.equal(clip30.fps, 30);
  assert.equal(clip30.totalFrames, 44);
  assert.equal(clip30.retargetOptions.targetFps, 30);

  const reparsed30 = parseBVHTextToClip(clip30.rawBVHText, clip30.sourceFileName, {
    ...clip30.retargetOptions,
    preserveRootMotion: false,
  });
  assert.equal(reparsed30.fps, 30);
  assert.equal(reparsed30.totalFrames, 44);

  // 4. Verify WorkbenchPanel.js uses step="0.01" on #rng-ik-blend and #rng-forearm-twist
  const panelSrc = fs.readFileSync(
    path.resolve('/home/antigravity/motion-stage/src/ui/WorkbenchPanel.js'),
    'utf8'
  );
  assert.match(panelSrc, /id="rng-ik-blend"[^>]*step="0\.01"/);
  assert.match(panelSrc, /id="rng-forearm-twist"[^>]*step="0\.01"/);
  void createWorkbenchPanel;
});

test('Challenger Fix #9: computeBakedFrameCount is bit-exact with bakeWarpedFrames and runCleaningPipeline runs < 15ms', () => {
  const slash = buildSlashClip();
  const { cleanedFrames } = runCleaningPipeline(slash);

  const configs = [
    { clip: { fps: 60, nonCyclic: false }, curve: { mode: 'off' } },
    { clip: { fps: 60, nonCyclic: false }, curve: { mode: 'single', windupSpeed: 1.75, hitstopFrames: 5 } },
    { clip: { fps: 60, nonCyclic: true }, curve: { mode: 'auto', windupSpeed: 1.6, strikeSpeed: 1.9, hitstopFrames: 6 } },
    { clip: { fps: 30, nonCyclic: true }, curve: { mode: 'autoMultiHit', hitstopFrames: 4 } },
  ];

  assert.equal(computeBakedFrameCount([], { fps: 60, nonCyclic: true }, { mode: 'single' }), 0);
  assert.equal(
    computeBakedFrameCount([cleanedFrames[0]], { fps: 60, nonCyclic: true }, { mode: 'single' }),
    1
  );

  for (const { clip, curve } of configs) {
    const fastCount = computeBakedFrameCount(cleanedFrames, clip, curve);
    const fullBaked = bakeWarpedFrames(cleanedFrames, clip, curve);
    assert.equal(fastCount, fullBaked.length, `Mismatch for mode=${curve.mode}, nonCyclic=${clip.nonCyclic}`);

    // Verify createCombatTimeRemapper matches remapCombatTime identically
    const fastRemap = createCombatTimeRemapper(
      { ...clip, isCombatAttack: true },
      curve,
      cleanedFrames
    );
    for (const u of [0, 0.15, 0.32, 0.5, 0.77, 1]) {
      const a = fastRemap(u);
      const b = remapCombatTime(u, true, true, clip.nonCyclic, curve, cleanedFrames, clip.fps);
      assert.ok(Math.abs(a.warpedU - b.warpedU) < 1e-12);
      assert.equal(a.inHitstop, b.inHitstop);
    }
  }

  // Benchmark warmed synchronous runCleaningPipeline on 113-frame tornado kick (< 15ms target)
  const tornadoBvh = fs.readFileSync(
    path.join(BVH_READY_DIR, '04_wuxia_tornado_kick_旋风回旋踢_cleaned.bvh'),
    'utf8'
  );
  const tornadoClip = parseBVHTextToClip(tornadoBvh, '04_wuxia_tornado_kick_旋风回旋踢_cleaned.bvh');

  // JIT warm-up
  for (let i = 0; i < 4; i++) {
    runCleaningPipeline(tornadoClip, { ikBlend: 0.5 + i * 0.1 });
  }

  const samples = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    runCleaningPipeline(tornadoClip, {
      filterRadius: 3,
      ikBlend: 0.2 + i * 0.08,
      forearmTwistShare: 0.58,
    });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const medianMs = samples[Math.floor(samples.length / 2)];
  assert.ok(
    medianMs < 15.0,
    `Expected synchronous 113-frame re-clean median < 15ms, got ${medianMs.toFixed(2)}ms`
  );
});

test('Challenger Fix #10: index.html carries data-workbench-ui on #workbench-drawer and #source-pip', () => {
  const html = fs.readFileSync(
    path.resolve('/home/antigravity/motion-stage/index.html'),
    'utf8'
  );
  for (const id of [
    'canvas-container',
    'source-pip',
    'workbench-drawer',
    'telemetry-hud',
    'split-labels',
    'drop-overlay',
    'bottom-dock',
  ]) {
    const tagMatch = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
    assert.ok(tagMatch, `Missing #${id} in index.html`);
    assert.match(
      tagMatch[0],
      /\bdata-workbench-ui\b/,
      `#${id} tag is missing direct data-workbench-ui attribute: ${tagMatch[0]}`
    );
  }
});
