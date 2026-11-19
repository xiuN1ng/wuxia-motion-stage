import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildCharacterRig, BONE_IDX } from '../../src/rig/HumanoidRig.js';
import {
  LayeredAnimator,
  UPPER_BONE_WEIGHTS,
  STANDARD_21_BONE_NAMES,
  getBoneLayerWeightsMap,
  allocatePoseBuffer,
  sampleClipNormalized,
  blendUpperOverLowerWithCounterYaw,
} from '../../src/combat/LayeredAnimator.js';
import { EnemyDummy } from '../../src/combat/EnemyDummy.js';

function quatAngleDiffRad(a, b) {
  const dot = Math.min(1, Math.abs(a.dot(b)));
  return 2 * Math.acos(dot);
}

describe('LayeredAnimator (F11a — 21-Bone Spine/Chest Feathered Blending & Counter-Yaw)', () => {
  it('defines exact 21-bone Upper Override weights (Lower=0, Spine=0.55, Chest=0.85, Upper=1.0)', () => {
    const map = getBoneLayerWeightsMap();
    assert.equal(Object.keys(map).length, 21);
    assert.equal(STANDARD_21_BONE_NAMES.length, 21);

    for (const lowerName of [
      'Hips',
      'LeftUpLeg',
      'LeftLeg',
      'LeftFoot',
      'LeftToe',
      'RightUpLeg',
      'RightLeg',
      'RightFoot',
      'RightToe',
    ]) {
      assert.equal(map[lowerName], 0.0);
      assert.equal(UPPER_BONE_WEIGHTS[BONE_IDX[lowerName]], 0.0);
    }

    assert.ok(Math.abs(UPPER_BONE_WEIGHTS[BONE_IDX.Spine] - 0.55) < 1e-6);
    assert.ok(Math.abs(UPPER_BONE_WEIGHTS[BONE_IDX.Chest] - 0.85) < 1e-6);

    for (const upperName of [
      'Neck',
      'Head',
      'LeftShoulder',
      'LeftUpperArm',
      'LeftForeArm',
      'LeftHand',
      'RightShoulder',
      'RightUpperArm',
      'RightForeArm',
      'RightHand',
    ]) {
      assert.equal(map[upperName], 1.0);
      assert.equal(UPPER_BONE_WEIGHTS[BONE_IDX[upperName]], 1.0);
    }

    // Auxiliary twist & cloth bones remain 0 in mask (driven post-blend)
    for (const auxIdx of [
      BONE_IDX.LeftForeArmTwist,
      BONE_IDX.RightForeArmTwist,
      BONE_IDX.SkirtFront,
      BONE_IDX.SkirtBack,
      BONE_IDX.Cape01,
      BONE_IDX.Cape02,
      BONE_IDX.Cape03,
      BONE_IDX.Cape04,
    ]) {
      assert.equal(UPPER_BONE_WEIGHTS[auxIdx], 0.0);
    }
  });

  it('produces exact 0% lower, 55% Spine, 85% Chest, and 100% upper slerps when pelvis yaw matches', () => {
    const basePose = allocatePoseBuffer();
    const upperPose = allocatePoseBuffer();
    const outPose = allocatePoseBuffer();

    basePose.rootPos.set(0.02, 0.91, -0.01);
    upperPose.rootPos.set(0.50, 0.78, 0.80);

    // Distinct rotations on legs, spine, chest, and arms (with identical Hips yaw = 0)
    basePose.quats[BONE_IDX.LeftUpLeg].setFromEuler(new THREE.Euler(-0.65, 0.1, 0));
    upperPose.quats[BONE_IDX.LeftUpLeg].setFromEuler(new THREE.Euler(0.45, -0.2, 0));

    basePose.quats[BONE_IDX.Spine].setFromEuler(new THREE.Euler(0.10, 0, 0));
    upperPose.quats[BONE_IDX.Spine].setFromEuler(new THREE.Euler(0.70, 0, 0.25));

    basePose.quats[BONE_IDX.Chest].setFromEuler(new THREE.Euler(-0.15, 0, 0));
    upperPose.quats[BONE_IDX.Chest].setFromEuler(new THREE.Euler(0.55, 0, -0.30));

    basePose.quats[BONE_IDX.RightUpperArm].setFromEuler(new THREE.Euler(0.2, -0.3, -0.9));
    upperPose.quats[BONE_IDX.RightUpperArm].setFromEuler(new THREE.Euler(-0.8, 0.6, -0.2));

    blendUpperOverLowerWithCounterYaw(basePose, upperPose, 1.0, outPose);

    // RootPos & Legs = 100% Base
    assert.ok(outPose.rootPos.distanceTo(basePose.rootPos) < 1e-6);
    assert.ok(quatAngleDiffRad(outPose.quats[BONE_IDX.LeftUpLeg], basePose.quats[BONE_IDX.LeftUpLeg]) < 1e-6);

    // Spine = exact 0.55 slerp
    const expectedSpine = basePose.quats[BONE_IDX.Spine].clone().slerp(upperPose.quats[BONE_IDX.Spine], 0.55);
    assert.ok(quatAngleDiffRad(outPose.quats[BONE_IDX.Spine], expectedSpine) < 1e-6);

    // Chest = exact 0.85 slerp
    const expectedChest = basePose.quats[BONE_IDX.Chest].clone().slerp(upperPose.quats[BONE_IDX.Chest], 0.85);
    assert.ok(quatAngleDiffRad(outPose.quats[BONE_IDX.Chest], expectedChest) < 1e-6);

    // RightUpperArm = 100% Upper
    assert.ok(
      quatAngleDiffRad(outPose.quats[BONE_IDX.RightUpperArm], upperPose.quats[BONE_IDX.RightUpperArm]) < 1e-6
    );
  });

  it('cancels lower-pelvis yaw wobble on pitched cleaves with zero roll distortion via conjugated premultiply', () => {
    const rig = buildCharacterRig();
    rig.setSkinningVisualState('prod', false);

    // Upper sword cleave pitches Spine forward 40 deg while upper Hips yaw is +18 deg
    const upperPose = allocatePoseBuffer();
    upperPose.quats[BONE_IDX.Hips].setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(18), 0, 'YXZ'));
    const pitch40 = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(THREE.MathUtils.degToRad(40), 0, 0, 'YXZ')
    );
    upperPose.quats[BONE_IDX.Spine].copy(pitch40);
    upperPose.quats[BONE_IDX.Chest].identity();

    // Base stride swings lower Hips to -35 deg yaw (53 deg yaw discrepancy!) with identical Spine pitch
    const basePose = allocatePoseBuffer();
    basePose.quats[BONE_IDX.Hips].setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(-35), 0, 'YXZ'));
    basePose.quats[BONE_IDX.Spine].copy(pitch40);
    basePose.quats[BONE_IDX.Chest].identity();

    const outPose = allocatePoseBuffer();
    blendUpperOverLowerWithCounterYaw(basePose, upperPose, 1.0, outPose);

    // Evaluate world Chest orientation of pure Upper pose vs Blended pose
    for (let i = 0; i <= 2; i++) rig.bones[i].quaternion.copy(upperPose.quats[i]);
    rig.rootGroup.updateMatrixWorld(true);
    const qChestTarget = new THREE.Quaternion();
    rig.bones[BONE_IDX.Chest].getWorldQuaternion(qChestTarget);

    for (let i = 0; i <= 2; i++) rig.bones[i].quaternion.copy(outPose.quats[i]);
    rig.rootGroup.updateMatrixWorld(true);
    const qChestBlended = new THREE.Quaternion();
    rig.bones[BONE_IDX.Chest].getWorldQuaternion(qChestBlended);

    const errDeg = THREE.MathUtils.radToDeg(quatAngleDiffRad(qChestTarget, qChestBlended));
    assert.ok(errDeg < 0.01, `Expected < 0.01 deg Chest world error (zero roll distortion), got ${errDeg} deg`);
  });

  it('clamps nonCyclic clips at u = 1.0 without wrapping back to frame 0', () => {
    const f0 = allocatePoseBuffer();
    const f1 = allocatePoseBuffer();
    f0.rootPos.set(0, 0.94, 0);
    f1.rootPos.set(0, 0.22, 0);
    f1.quats[BONE_IDX.Hips].setFromEuler(new THREE.Euler(-1.4, 0, 0));

    const out = allocatePoseBuffer();
    sampleClipNormalized([f0, f1], 1.0, true, out);
    assert.ok(Math.abs(out.rootPos.y - 0.22) < 1e-6);
    assert.ok(quatAngleDiffRad(out.quats[BONE_IDX.Hips], f1.quats[BONE_IDX.Hips]) < 1e-6);
  });

  it('applies 58% forearm twist roll, 360-degree yaw-invariant cloth billowing, and full EnemyDummy isolation', () => {
    const playerRig = buildCharacterRig();
    playerRig.setSkinningVisualState('prod', false);
    const playerGroup = new THREE.Group();
    playerGroup.add(playerRig.rootGroup);

    const dummy = new EnemyDummy(null);
    assert.notEqual(playerRig.mesh.material, dummy.rig.mesh.material);
    assert.notEqual(playerRig.mesh.geometry, dummy.rig.mesh.geometry);
    assert.equal(dummy.rig.mesh.material.emissiveIntensity, 0.0);

    // Build a 2-frame test clip with 60 deg X-twist on RightHand
    const frameA = allocatePoseBuffer();
    frameA.quats[BONE_IDX.RightHand].setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(60), 0, 0));
    const testClip = { id: 'twist_test', frames: [frameA, frameA], nonCyclic: false };

    const animatorYaw0 = new LayeredAnimator(playerRig, playerGroup, null);
    for (let step = 0; step < 30; step++) {
      animatorYaw0.evaluate(1 / 60, {
        baseClip: testClip,
        baseNormalizedTime: 0,
        worldPos: { x: 0, y: 0, z: step * 0.1 },
        playerYaw: 0,
        worldVelXZ: { x: 0, z: 6.0 },
      });
    }

    // Verify 58% forearm X-roll on RightForeArmTwist (0.58 * 60 = 34.8 deg)
    const expectedTwist = new THREE.Quaternion().slerp(frameA.quats[BONE_IDX.RightHand], 0.58);
    assert.ok(
      quatAngleDiffRad(playerRig.bones[BONE_IDX.RightForeArmTwist].quaternion, expectedTwist) < 1e-5
    );
    const capePitchYaw0 = playerRig.bones[BONE_IDX.Cape01].rotation.x;
    assert.ok(capePitchYaw0 > 0.35, `Expected forward sprint cape billow > 0.35 rad, got ${capePitchYaw0}`);

    // Now sprint forward facing -Z (yaw = Math.PI, worldVelXZ.z = -6.0 m/s): cape MUST still billow backward!
    animatorYaw0.reset();
    for (let step = 0; step < 30; step++) {
      animatorYaw0.evaluate(1 / 60, {
        baseClip: testClip,
        baseNormalizedTime: 0,
        worldPos: { x: 0, y: 0, z: -step * 0.1 },
        playerYaw: Math.PI,
        worldVelXZ: { x: 0, z: -6.0 },
      });
    }
    const capePitchYawPi = playerRig.bones[BONE_IDX.Cape01].rotation.x;
    assert.ok(
      capePitchYawPi > 0.35 && Math.abs(capePitchYawPi - capePitchYaw0) < 0.08,
      `Expected yaw-invariant cape pitch at yaw=PI (${capePitchYawPi} vs ${capePitchYaw0})`
    );
  });

  it('survives evaluate(NaN), evaluate(±Infinity), and non-finite params during active crossfade without poisoning upperLayerAlpha or transforms', () => {
    const rig = buildCharacterRig();
    rig.setSkinningVisualState('prod', false);
    const wg = new THREE.Group();
    wg.add(rig.rootGroup);

    const fIdle = allocatePoseBuffer();
    const fStrafe = allocatePoseBuffer();
    fStrafe.rootPos.set(0.03, 0.90, -0.02);
    fStrafe.quats[BONE_IDX.Hips].setFromEuler(new THREE.Euler(0, 0.35, 0));
    fStrafe.quats[BONE_IDX.LeftUpLeg].setFromEuler(new THREE.Euler(-0.5, 0, 0));

    const fSlash = allocatePoseBuffer();
    fSlash.quats[BONE_IDX.Spine].setFromEuler(new THREE.Euler(0.45, 0.2, 0));
    fSlash.quats[BONE_IDX.RightUpperArm].setFromEuler(new THREE.Euler(-0.9, 0.4, -0.3));

    const idleClip = { id: 'taibai_01b', frames: [fIdle, fIdle], nonCyclic: false };
    const strafeClip = { id: '07_strafe_R', frames: [fStrafe, fStrafe], nonCyclic: false };
    const slashClip = { id: 'combo_1', frames: [fSlash, fSlash], nonCyclic: true };

    const anim = new LayeredAnimator(rig, wg, null);
    anim.evaluate(1 / 60, { baseClip: idleClip, baseNormalizedTime: 0 });
    // Trigger active base crossfade + upper override ramp
    anim.evaluate(1 / 60, {
      baseClip: strafeClip,
      baseNormalizedTime: 0.05,
      baseCrossfadeSec: 0.15,
      upperClip: slashClip,
      upperNormalizedTime: 0.05,
      targetUpperAlpha: 1.0,
    });
    const alphaBefore = anim.upperLayerAlpha;
    assert.ok(alphaBefore > 0 && Number.isFinite(alphaBefore));

    // Fuzz with NaN, Infinity, -Infinity dt and all non-finite params during active crossfade!
    for (const badDt of [NaN, Infinity, -Infinity, -0.25, 0]) {
      anim.evaluate(badDt, {
        baseClip: strafeClip,
        baseNormalizedTime: NaN,
        baseCrossfadeSec: Infinity,
        upperClip: slashClip,
        upperNormalizedTime: -Infinity,
        upperCrossfadeSec: NaN,
        targetUpperAlpha: NaN,
        forceUpperAlpha: NaN,
        worldPos: { x: NaN, y: Infinity, z: -Infinity },
        playerYaw: NaN,
        worldVelXZ: { x: NaN, z: Infinity },
        inHitstop: false,
        simTimeSec: NaN,
      });

      assert.ok(
        Number.isFinite(anim.upperLayerAlpha) && anim.upperLayerAlpha >= 0 && anim.upperLayerAlpha <= 1,
        `upperLayerAlpha corrupted on dt=${badDt}: ${anim.upperLayerAlpha}`
      );
      for (const comp of rig.bones[BONE_IDX.Hips].position.toArray()) {
        assert.ok(Number.isFinite(comp), `Hips.position became non-finite on dt=${badDt}`);
      }
      for (let b = 0; b < rig.bones.length; b++) {
        const q = rig.bones[b].quaternion;
        assert.ok(
          Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w),
          `Bone ${b} quaternion corrupted on dt=${badDt}`
        );
        assert.ok(Math.abs(q.length() - 1) < 1e-4, `Bone ${b} quaternion not unit length`);
        for (const el of rig.bones[b].matrixWorld.elements) {
          assert.ok(Number.isFinite(el), `Bone ${b} matrixWorld element non-finite on dt=${badDt}`);
        }
      }
    }

    // Verify upperLayerAlpha is NOT permanently stuck and ramps cleanly to 1.0 on subsequent valid ticks
    for (let k = 0; k < 10; k++) {
      anim.evaluate(1 / 60, {
        baseClip: strafeClip,
        baseNormalizedTime: 0.2 + k * 0.05,
        upperClip: slashClip,
        upperNormalizedTime: 0.2 + k * 0.05,
        targetUpperAlpha: 1.0,
      });
    }
    assert.equal(anim.upperLayerAlpha, 1.0);
  });

  it('maintains 0 bone and cloth discrepancy across all 29 bones under baseClip and upperClip antipodal negation (q -> -q)', () => {
    const buildTestRigAndAnim = () => {
      const r = buildCharacterRig();
      r.setSkinningVisualState('prod', false);
      const wg = new THREE.Group();
      wg.add(r.rootGroup);
      return { rig: r, anim: new LayeredAnimator(r, wg, null) };
    };

    const makeFrame = (seed) => {
      const f = allocatePoseBuffer();
      f.rootPos.set(0.02 * seed, 0.92, -0.01 * seed);
      f.quats[BONE_IDX.Hips].setFromEuler(new THREE.Euler(0.05, -0.42 * seed, 0.03, 'YXZ'));
      f.quats[BONE_IDX.Spine].setFromEuler(new THREE.Euler(0.32, 0.28 * seed, -0.1, 'YXZ'));
      f.quats[BONE_IDX.Chest].setFromEuler(new THREE.Euler(0.24, -0.35 * seed, 0.12, 'YXZ'));
      f.quats[BONE_IDX.RightHand].setFromEuler(new THREE.Euler(0.8 * seed, 0.2, -0.15));
      f.quats[BONE_IDX.LeftHand].setFromEuler(new THREE.Euler(-0.65 * seed, -0.1, 0.2));
      f.quats[BONE_IDX.LeftUpLeg].setFromEuler(new THREE.Euler(-0.55 * seed, 0.08, 0));
      f.quats[BONE_IDX.LeftLeg].setFromEuler(new THREE.Euler(0.75 * Math.abs(seed), 0, 0));
      f.quats[BONE_IDX.RightUpLeg].setFromEuler(new THREE.Euler(0.48 * seed, -0.08, 0));
      return f;
    };

    const negateFrame = (src) => {
      const dst = allocatePoseBuffer();
      dst.rootPos.copy(src.rootPos);
      for (let i = 0; i < dst.quats.length; i++) {
        const q = src.quats[i];
        dst.quats[i].set(-q.x, -q.y, -q.z, -q.w);
      }
      return dst;
    };

    const b0 = makeFrame(0.6);
    const b1 = makeFrame(1.0);
    // Include an exact w === 0 (180 deg Y-rotation) frame to test tie-breaking hemisphere invariance too
    const b2 = makeFrame(-0.5);
    b2.quats[BONE_IDX.Hips].set(0, 1, 0, 0);

    const u0 = makeFrame(-0.8);
    const u1 = makeFrame(0.9);

    const posBaseClip = { id: 'base_pos', frames: [b0, b1, b2], nonCyclic: false };
    const negBaseClip = {
      id: 'base_pos',
      frames: [negateFrame(b0), negateFrame(b1), negateFrame(b2)],
      nonCyclic: false,
    };
    const posUpperClip = { id: 'upper_pos', frames: [u0, u1], nonCyclic: true };
    const negUpperClip = { id: 'upper_pos', frames: [negateFrame(u0), u1], nonCyclic: true };

    const { rig: rigPos, anim: animPos } = buildTestRigAndAnim();
    const { rig: rigNeg, anim: animNeg } = buildTestRigAndAnim();

    // Hold performance.now deterministic per tick so TwoBoneIK's windFlutter uses identical timestamps
    const origNow = performance.now.bind(performance);
    let syntheticNowMs = 1000;
    performance.now = () => syntheticNowMs;
    try {
      for (let step = 0; step < 18; step++) {
        syntheticNowMs = 1000 + step * 16.667;
        const commonParams = {
          baseNormalizedTime: (step * 0.13) % 1,
          upperNormalizedTime: Math.min(1, step * 0.08),
          targetUpperAlpha: step < 10 ? 1.0 : 0.0, // exercises both pure base and blended upper+base!
          worldPos: { x: step * 0.04, y: 0, z: step * 0.09 },
          playerYaw: 0.4,
          worldVelXZ: { x: 1.5, z: 5.2 },
          clothEnabled: true,
          twistEnabled: true,
        };
        animPos.evaluate(1 / 60, { ...commonParams, baseClip: posBaseClip, upperClip: posUpperClip });
        animNeg.evaluate(1 / 60, { ...commonParams, baseClip: negBaseClip, upperClip: negUpperClip });

        let maxQuatDiff = 0;
        let maxMatDiff = 0;
        for (let b = 0; b < 29; b++) {
          const qa = rigPos.bones[b].quaternion;
          const qb = rigNeg.bones[b].quaternion;
          maxQuatDiff = Math.max(
            maxQuatDiff,
            Math.abs(qa.x - qb.x),
            Math.abs(qa.y - qb.y),
            Math.abs(qa.z - qb.z),
            Math.abs(qa.w - qb.w)
          );
          const ma = rigPos.bones[b].matrixWorld.elements;
          const mb = rigNeg.bones[b].matrixWorld.elements;
          for (let e = 0; e < 16; e++) {
            maxMatDiff = Math.max(maxMatDiff, Math.abs(ma[e] - mb[e]));
          }
        }
        assert.ok(
          maxQuatDiff < 1e-12 && maxMatDiff < 1e-12,
          `Step ${step} antipodal q -> -q discrepancy: maxQuatDiff=${maxQuatDiff}, maxMatDiff=${maxMatDiff}`
        );
      }
    } finally {
      performance.now = origNow;
    }
  });
});
