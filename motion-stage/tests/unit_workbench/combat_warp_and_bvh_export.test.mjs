import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { BONE_DEFS, BONE_IDX } from '../../src/rig/HumanoidRig.js';
import { buildSlashClip, retargetBVHToFrames } from '../../src/anim/MotionClips.js';
import {
  DEFAULT_COMBAT_CURVE,
  remapCombatTime,
  detectStrikePeaks,
  sampleInterpolatedFrame,
  bakeWarpedFrames,
  runCleaningPipeline,
} from '../../src/pipeline/MotionCleaner.js';
import {
  bakeWarpedFrames as bakeFromExporter,
  exportCleanedClipToBVH,
  EXPORT_BONE_INDICES,
} from '../../src/pipeline/BVHExporter.js';

test('F8: remapCombatTime maintains strict monotonicity and [0, 1] boundary invariants across all modes', () => {
  assert.equal(bakeWarpedFrames, bakeFromExporter);
  assert.ok('windupEnd' in DEFAULT_COMBAT_CURVE && 'hitstopFrames' in DEFAULT_COMBAT_CURVE);

  const slash = buildSlashClip();
  const modes = [
    { label: 'off', isAttack: true, nonCyclic: false, opts: { mode: 'off' } },
    { label: 'auto-cyclic-gait', isAttack: false, nonCyclic: false, opts: { mode: 'auto' } },
    { label: 'auto-noncyclic', isAttack: false, nonCyclic: true, opts: { mode: 'auto' } },
    { label: 'single-default', isAttack: true, nonCyclic: true, opts: { mode: 'single', hitstopFrames: 5 } },
    {
      label: 'adversarial-inverted-knots',
      isAttack: true,
      nonCyclic: true,
      opts: { mode: 'single', windupEnd: 0.82, strikeEnd: 0.25, windupSpeed: 2.5, hitstopFrames: 6 },
    },
    {
      label: 'autoMultiHit',
      isAttack: true,
      nonCyclic: true,
      opts: { mode: 'autoMultiHit', hitstopFrames: 4 },
    },
  ];

  for (const cfg of modes) {
    const start = remapCombatTime(0, cfg.isAttack, true, cfg.nonCyclic, cfg.opts, slash.frames, 60);
    const end = remapCombatTime(1, cfg.isAttack, true, cfg.nonCyclic, cfg.opts, slash.frames, 60);
    assert.equal(start.warpedU, 0, `${cfg.label}: warpedU(0) !== 0`);
    assert.equal(end.warpedU, 1, `${cfg.label}: warpedU(1) !== 1`);

    let prev = 0;
    let sawHitstop = false;
    for (let i = 0; i <= 500; i++) {
      const u = i / 500;
      const { warpedU, inHitstop } = remapCombatTime(
        u,
        cfg.isAttack,
        true,
        cfg.nonCyclic,
        cfg.opts,
        slash.frames,
        60
      );
      assert.ok(Number.isFinite(warpedU) && warpedU >= 0 && warpedU <= 1);
      assert.ok(
        warpedU + 1e-12 >= prev,
        `${cfg.label}: non-monotonic at u=${u} (${warpedU} < ${prev})`
      );
      if (inHitstop) sawHitstop = true;
      prev = warpedU;
    }

    if (cfg.opts.mode === 'single' && cfg.opts.hitstopFrames > 0) {
      assert.equal(sawHitstop, true, `${cfg.label}: expected hitstop freeze plateau`);
    }
  }
});

test('F8: detectStrikePeaks identifies multi-hit combo velocity maxima and caches via WeakMap', () => {
  // Synthesize 90 frames @ 30fps with 3 distinct explosive right-arm slashes at frames 18, 45, 72
  const frames = [];
  for (let f = 0; f < 90; f++) {
    let angle = 0;
    for (const center of [18, 45, 72]) {
      const d = (f - center) / 3.0;
      angle += Math.exp(-0.5 * d * d) * 1.8;
    }
    const quats = Array.from({ length: BONE_DEFS.length }, () => new THREE.Quaternion());
    quats[BONE_IDX.RightUpperArm].setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    frames.push({
      rootPos: new THREE.Vector3(0, 0.94, 0),
      quats,
      contactL: true,
      contactR: true,
    });
  }

  const peaks1 = detectStrikePeaks(frames, 30);
  const peaks2 = detectStrikePeaks(frames, 30);
  assert.equal(peaks1, peaks2, 'Expected WeakMap cache hit on identical frames array');
  assert.ok(peaks1.length >= 3, `Expected >= 3 strike peaks, got ${peaks1.length}: ${peaks1}`);
});

test('F8: sampleInterpolatedFrame clamps nonCyclic end boundary without wrapping back to frame 0', () => {
  const slash = buildSlashClip();
  const frames = slash.frames.slice(0, 10).map((fr, idx) => ({
    rootPos: new THREE.Vector3(idx * 0.5, 0.94, idx * 1.0),
    quats: fr.quats.map((q) => q.clone()),
    contactL: true,
    contactR: true,
  }));

  const out = {
    rootPos: new THREE.Vector3(),
    quats: Array.from({ length: BONE_DEFS.length }, () => new THREE.Quaternion()),
  };

  // At frameFloat = 9.0 (N - 1) and 10.0 (N), nonCyclic MUST stay at frame 9 (z = 9.0), never wrap to z = 0
  sampleInterpolatedFrame(frames, 9.0, out, true);
  assert.ok(Math.abs(out.rootPos.z - 9.0) < 1e-6);

  sampleInterpolatedFrame(frames, 10.0, out, true);
  assert.ok(Math.abs(out.rootPos.z - 9.0) < 1e-6);

  // Midpoint interpolation check at 4.5 -> z = 4.5, unit quaternions normalized
  sampleInterpolatedFrame(frames, 4.5, out, true);
  assert.ok(Math.abs(out.rootPos.z - 4.5) < 1e-6);
  for (const q of out.quats) {
    assert.ok(Math.abs(q.length() - 1) < 1e-6);
  }
});

test('F8 & Contract 1: bakeWarpedFrames and exportCleanedClipToBVH produce valid 21-bone 66-channel BVH with zero -0.0000/NaN', () => {
  const slash = buildSlashClip();
  const { cleanedFrames } = runCleaningPipeline(slash);
  const nonCyclicClip = {
    ...slash,
    isCombatAttack: false, // Also verify 'auto' resolves to 'single' when explicitly baking custom/video clips!
    nonCyclic: true,
  };

  // 1. Identity curve preserves exact frame count
  const identityBaked = bakeWarpedFrames(cleanedFrames, nonCyclicClip, {
    mode: 'single',
    windupSpeed: 1.0,
    strikeSpeed: 1.0,
    hitstopFrames: 0,
    recoverySpeed: 1.0,
  });
  assert.equal(identityBaked.length, cleanedFrames.length);

  // 2. Compressed windup + 8-frame hitstop
  const fastNoStop = bakeWarpedFrames(cleanedFrames, nonCyclicClip, {
    mode: 'auto',
    windupEnd: 0.30,
    windupSpeed: 2.0,
    strikeEnd: 0.45,
    strikeSpeed: 2.0,
    hitstopFrames: 0,
    recoverySpeed: 1.0,
  });
  const fastWithStop = bakeWarpedFrames(cleanedFrames, nonCyclicClip, {
    mode: 'auto',
    windupEnd: 0.30,
    windupSpeed: 2.0,
    strikeEnd: 0.45,
    strikeSpeed: 2.0,
    hitstopFrames: 8,
    recoverySpeed: 1.0,
  });

  assert.ok(fastNoStop.length < cleanedFrames.length, 'Windup/strike speed > 1 should compress frame count');
  assert.equal(fastWithStop.length - fastNoStop.length, 8, '8 hitstop frames @ 60fps should add exact 8 frames');
  const hitstopFramesFound = fastWithStop.filter((fr) => fr.inHitstop).length;
  assert.ok(hitstopFramesFound >= 7, `Expected >= 7 frozen hitstop frames, got ${hitstopFramesFound}`);

  // Inject -0 and unnormalized/NaN edge-case values on a clone to test BVH numerical sanitizer
  const adversarialFrames = cleanedFrames.map((fr) => ({
    rootPos: new THREE.Vector3(-0, fr.rootPos.y, -1e-9),
    quats: fr.quats.map((q) => q.clone()),
  }));
  adversarialFrames[0].quats[BONE_IDX.LeftToe] = new THREE.Quaternion(NaN, 0, 0, 1);

  const bvhText = exportCleanedClipToBVH(nonCyclicClip, adversarialFrames, {
    bakeCombatCurve: true,
    combatCurve: {
      mode: 'single',
      windupEnd: 0.28,
      windupSpeed: 1.8,
      strikeEnd: 0.42,
      strikeSpeed: 1.8,
      hitstopFrames: 6,
      recoverySpeed: 1.0,
    },
  });

  assert.equal(bvhText.includes('-0.0000'), false, 'BVH must never contain -0.0000');
  assert.equal(bvhText.includes('NaN'), false, 'BVH must never contain NaN');
  assert.equal(bvhText.includes('Infinity'), false, 'BVH must never contain Infinity');

  // Verify 21 joints, 66 channels, exact Frames count
  const rootMatches = bvhText.match(/^\s*ROOT\s+\w+/gm) || [];
  const jointMatches = bvhText.match(/^\s*JOINT\s+\w+/gm) || [];
  assert.equal(rootMatches.length, 1);
  assert.equal(jointMatches.length, 20);
  assert.equal(EXPORT_BONE_INDICES.size, 21);

  const motionIdx = bvhText.indexOf('\nMOTION\n');
  assert.ok(motionIdx > 0);
  const motionLines = bvhText
    .slice(motionIdx + 1)
    .trim()
    .split('\n');
  assert.equal(motionLines[0], 'MOTION');
  const declaredFrames = Number.parseInt(motionLines[1].replace('Frames:', '').trim(), 10);
  const dataRows = motionLines.slice(3);
  assert.equal(dataRows.length, declaredFrames);

  for (const row of dataRows) {
    const tokens = row.trim().split(/\s+/);
    assert.equal(tokens.length, 66, `Expected 66 channels per frame, got ${tokens.length}`);
    for (const tok of tokens) {
      assert.ok(Number.isFinite(Number(tok)), `Non-finite BVH token: ${tok}`);
    }
  }

  // Round-trip exported BVH back through retargetBVHToFrames
  const roundTrip = retargetBVHToFrames(bvhText, 60, { preserveRootMotion: true });
  assert.equal(roundTrip.length, declaredFrames);
});
