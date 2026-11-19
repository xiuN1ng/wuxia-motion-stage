import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { BONE_IDX, createBoneHierarchy } from '../../src/rig/HumanoidRig.js';
import { buildSlashClip, buildKickClip, buildRunClip } from '../../src/anim/MotionClips.js';
import { applyForearmTwistSolver } from '../../src/pipeline/TwoBoneIK.js';
import {
  DEFAULT_CLEAN_OPTIONS,
  runCleaningPipeline,
  analyzeMotionTelemetry,
} from '../../src/pipeline/MotionCleaner.js';

test('F7: DEFAULT_CLEAN_OPTIONS exposes all required pipeline parameters and cleans < 15ms', () => {
  const requiredKeys = [
    'deJitter',
    'filterRadius',
    'filterSigma',
    'footLock',
    'contactMode',
    'contactHeightThresh',
    'contactVelThresh',
    'ikBlend',
    'floorY',
    'stanceRampRatio',
    'pelvisPullWeight',
    'keepFootFlat',
    'loopClean',
    'seamRatio',
    'stabilizeInPlace',
    'preserveRootMotion',
    'forearmTwistShare',
  ];
  for (const k of requiredKeys) {
    assert.ok(k in DEFAULT_CLEAN_OPTIONS, `Missing ${k} in DEFAULT_CLEAN_OPTIONS`);
  }

  const slash = buildSlashClip();
  // Warm-up JIT once, then measure synchronous re-clean latency
  runCleaningPipeline(slash);
  const t0 = performance.now();
  const res = runCleaningPipeline(slash);
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 35, `Expected fast synchronous cleaning, took ${elapsedMs.toFixed(2)}ms`);
  assert.equal(res.cleanedFrames.length, slash.totalFrames);
  assert.ok(res.cleanTelemetry.rmsSlipCmS < res.rawTelemetry.rmsSlipCmS * 0.15);
  assert.ok(res.cleanTelemetry.rmsJitter < res.rawTelemetry.rmsJitter);
});

test('F7: filterRadius=0 exact bypass, filterRadius > N cyclic safety, and short-clip seam safety', () => {
  const slash = buildSlashClip();

  // filterRadius: 0 must NOT fallback to 3 (exact bypass when footLock & loopClean are false)
  const bypass = runCleaningPipeline(slash, {
    deJitter: true,
    filterRadius: 0,
    footLock: false,
    loopClean: false,
  });
  assert.equal(bypass.appliedOptions.filterRadius, 0);
  for (let f = 0; f < slash.frames.length; f++) {
    assert.ok(bypass.cleanedFrames[f].rootPos.distanceTo(slash.frames[f].rootPos) < 1e-7);
    assert.equal(
      bypass.cleanedFrames[f].quats[BONE_IDX.RightHand].equals(
        slash.frames[f].quats[BONE_IDX.RightHand]
      ),
      true
    );
  }

  // Short 4-frame cyclic clip with filterRadius: 8 (> N) and loopClean: true must never index negative frames
  const shortClip = {
    ...slash,
    totalFrames: 4,
    frames: slash.frames.slice(0, 4),
  };
  const shortRes = runCleaningPipeline(shortClip, {
    deJitter: true,
    filterRadius: 8,
    filterSigma: 1.8,
    loopClean: true,
    seamRatio: 0.25,
    footLock: true,
  });
  assert.equal(shortRes.cleanedFrames.length, 4);
  for (const fr of shortRes.cleanedFrames) {
    assert.ok(Number.isFinite(fr.rootPos.x) && Number.isFinite(fr.rootPos.y) && Number.isFinite(fr.rootPos.z));
  }
});

test('F7: preserveRootMotion protects forward X/Z trajectory even when loopClean & stabilizeInPlace are enabled', () => {
  const run = buildRunClip();
  const lungeFrames = run.frames.map((fr, idx) => ({
    rootPos: new THREE.Vector3(0.4 * (idx / (run.frames.length - 1)), fr.rootPos.y, 2.5 * (idx / (run.frames.length - 1))),
    quats: fr.quats.map((q) => q.clone()),
    contactL: false,
    contactR: false,
  }));
  const lungeClip = {
    ...run,
    nonCyclic: true,
    preserveRootMotion: true,
    stabilizeInPlace: true,
    frames: lungeFrames,
  };

  const res = runCleaningPipeline(lungeClip, {
    deJitter: false,
    footLock: false,
    loopClean: true,
    preserveRootMotion: true,
  });
  const last = res.cleanedFrames[res.cleanedFrames.length - 1];
  assert.ok(Math.abs(last.rootPos.z - 2.5) < 1e-5, `Expected Z=2.5m preserved, got ${last.rootPos.z}`);
  assert.ok(Math.abs(last.rootPos.x - 0.4) < 1e-5, `Expected X=0.4m preserved, got ${last.rootPos.x}`);
});

test('F7: ikBlend=0 produces bit-exact zero alteration while partial ikBlend=0.5 scales IK smoothly', () => {
  const slash = buildSlashClip();

  const noLock = runCleaningPipeline(slash, {
    deJitter: false,
    loopClean: false,
    footLock: false,
  });
  const zeroBlend = runCleaningPipeline(slash, {
    deJitter: false,
    loopClean: false,
    footLock: true,
    ikBlend: 0.0,
  });
  const halfBlend = runCleaningPipeline(slash, {
    deJitter: false,
    loopClean: false,
    footLock: true,
    ikBlend: 0.5,
  });
  const fullBlend = runCleaningPipeline(slash, {
    deJitter: false,
    loopClean: false,
    footLock: true,
    ikBlend: 1.0,
  });

  // ikBlend = 0 must leave rootPos and leg quaternions bit-exact with footLock = false
  for (let f = 0; f < slash.frames.length; f++) {
    assert.ok(zeroBlend.cleanedFrames[f].rootPos.distanceTo(noLock.cleanedFrames[f].rootPos) < 1e-7);
    assert.equal(
      zeroBlend.cleanedFrames[f].quats[BONE_IDX.LeftUpLeg].equals(
        noLock.cleanedFrames[f].quats[BONE_IDX.LeftUpLeg]
      ),
      true
    );
  }

  // Telemetry slip must decrease monotonically: ikBlend 0.0 > ikBlend 0.5 > ikBlend 1.0
  assert.ok(
    zeroBlend.cleanTelemetry.rmsSlipCmS > halfBlend.cleanTelemetry.rmsSlipCmS,
    `Expected ikBlend=0 slip (${zeroBlend.cleanTelemetry.rmsSlipCmS}) > ikBlend=0.5 (${halfBlend.cleanTelemetry.rmsSlipCmS})`
  );
  assert.ok(
    halfBlend.cleanTelemetry.rmsSlipCmS > fullBlend.cleanTelemetry.rmsSlipCmS,
    `Expected ikBlend=0.5 slip (${halfBlend.cleanTelemetry.rmsSlipCmS}) > ikBlend=1.0 (${fullBlend.cleanTelemetry.rmsSlipCmS})`
  );
  assert.ok(fullBlend.cleanTelemetry.rmsSlipCmS < 1.0);
});

test('F7: floorY, contactMode threshold override, and forearmTwistShare work accurately', () => {
  const slash = buildSlashClip();
  const customFloor = 0.13;
  const resFloor = runCleaningPipeline(slash, {
    deJitter: false,
    loopClean: false,
    footLock: true,
    floorY: customFloor,
  });

  const { bones } = createBoneHierarchy();
  const ankleL = new THREE.Vector3();
  bones[0].position.copy(resFloor.cleanedFrames[10].rootPos);
  for (let i = 0; i < bones.length; i++) {
    bones[i].quaternion.copy(resFloor.cleanedFrames[10].quats[i]);
  }
  bones[0].updateWorldMatrix(true, true);
  bones[BONE_IDX.LeftFoot].getWorldPosition(ankleL);
  assert.ok(Math.abs(ankleL.y - customFloor) < 0.015, `Expected LeftFoot near floorY=${customFloor}, got ${ankleL.y}`);

  // contactMode: 'threshold' with ultra-low height threshold (0.01m) disables stance locking on preset
  const strictThresh = runCleaningPipeline(slash, {
    deJitter: false,
    loopClean: false,
    footLock: true,
    contactMode: 'threshold',
    contactHeightThresh: 0.01,
  });
  assert.equal(strictThresh.cleanedFrames[10].lockWeightL, 0);

  // Forearm twist solver share (0.0 vs 0.58 vs 1.0)
  bones[BONE_IDX.RightHand].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 0.5);
  applyForearmTwistSolver(bones, true, 0.0);
  assert.ok(bones[BONE_IDX.RightForeArmTwist].quaternion.angleTo(new THREE.Quaternion()) < 1e-6);

  applyForearmTwistSolver(bones, true, 0.58);
  const ang58 = 2 * Math.acos(Math.min(1, Math.abs(bones[BONE_IDX.RightForeArmTwist].quaternion.w)));
  assert.ok(Math.abs(ang58 - Math.PI * 0.5 * 0.58) < 1e-3);

  applyForearmTwistSolver(bones, true, 1.0);
  const ang100 = 2 * Math.acos(Math.min(1, Math.abs(bones[BONE_IDX.RightForeArmTwist].quaternion.w)));
  assert.ok(Math.abs(ang100 - Math.PI * 0.5) < 1e-3);
});

test('F9: analyzeMotionTelemetry resolves null-contact raw clips and handles 0/1-frame & length-mismatch safely', () => {
  const kick = buildKickClip();
  // Strip contactL/contactR to null (simulating raw video or external BVH clip)
  const nullContactFrames = kick.frames.map((fr) => ({
    rootPos: fr.rootPos.clone(),
    quats: fr.quats.map((q) => q.clone()),
    contactL: null,
    contactR: null,
  }));

  // 1. Standalone 3-arg call uses kinematic auto-contact fallback (non-zero slip!)
  const standaloneTel = analyzeMotionTelemetry(nullContactFrames, kick.fps, false);
  assert.ok(standaloneTel.rmsSlipCmS > 5.0, `Expected non-zero standalone slip, got ${standaloneTel.rmsSlipCmS}`);
  assert.ok(standaloneTel.maxSlipCmS >= standaloneTel.rmsSlipCmS);
  assert.equal(standaloneTel.slipSeries.length, nullContactFrames.length);
  assert.equal(standaloneTel.slipSeriesCmS.length, nullContactFrames.length);

  // 2. Full pipeline passes cleaned referenceFrames so Raw vs Clean compare over identical stance intervals
  const pipe = runCleaningPipeline({ ...kick, frames: nullContactFrames });
  assert.ok(pipe.rawTelemetry.rmsSlipCmS > 10.0);
  assert.ok(pipe.cleanTelemetry.rmsSlipCmS < pipe.rawTelemetry.rmsSlipCmS * 0.25);

  // 3. Mismatched referenceFrames length never throws or produces NaN
  const shorterRef = pipe.cleanedFrames.slice(0, 40);
  const mismatchTel = analyzeMotionTelemetry(nullContactFrames, 60, false, shorterRef);
  assert.ok(Number.isFinite(mismatchTel.rmsSlipCmS));
  assert.ok(Number.isFinite(mismatchTel.rmsJitter));

  // 4. Empty (0-frame) and 1-frame clips return finite zeros without NaN or -Infinity
  const emptyTel = analyzeMotionTelemetry([], 60, true);
  assert.equal(emptyTel.rmsSlipCmS, 0);
  assert.equal(emptyTel.maxSlipCmS, 0);
  assert.equal(emptyTel.rmsJitter, 0);

  const singleTel = analyzeMotionTelemetry([nullContactFrames[0]], 0, false);
  assert.equal(singleTel.rmsSlipCmS, 0);
  assert.equal(singleTel.rmsJitter, 0);
});
