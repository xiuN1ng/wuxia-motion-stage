import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { BONE_DEFS, BONE_IDX, createBoneHierarchy } from '../../src/rig/HumanoidRig.js';
import { exportFramesToBVH } from '../../src/pipeline/BVHExporter.js';
import { resolveMotionProvenance } from '../../src/ui/AssetLibraryCatalog.js';
import {
  createNeutralKeyframe,
  cloneKeyframe,
  getBoneLocalEulerDeg,
  setBoneLocalEulerDeg,
  mirrorKeyframePoseLR,
  snapKeyframeFeetToFloor,
  synthesizeKeyframeClip,
  selectSalientKeyframeIndices,
} from '../../src/keyframe/KeyframeInbetweener.js';
import { KEYFRAME_TEMPLATES } from '../../src/keyframe/KeyframePresets.js';

function assertAllUnitQuats(frames) {
  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i];
    assert.ok(Number.isFinite(fr.rootPos.x + fr.rootPos.y + fr.rootPos.z), `Frame ${i} rootPos non-finite`);
    assert.equal(fr.quats.length, BONE_DEFS.length);
    for (let b = 0; b < fr.quats.length; b++) {
      const q = fr.quats[b];
      assert.ok(Math.abs(q.length() - 1) < 1e-4, `Frame ${i} bone ${b} non-unit quat`);
    }
  }
}

test('KeyframeInbetweener: all built-in Wuxia templates synthesize smooth 60fps clips and export valid 21-bone BVH', () => {
  for (const tpl of KEYFRAME_TEMPLATES) {
    const kfs = tpl.buildKeyframes();
    assert.ok(kfs.length >= 4, `Template ${tpl.id} should have >= 4 keyframes`);

    const res = synthesizeKeyframeClip(kfs, {
      fps: 60,
      mode: 'ai_smart',
      hasWeapon: tpl.hasWeapon,
      cyclic: tpl.cyclic,
    });

    assert.ok(res.cleanFrames.length >= 60, `${tpl.id}: expected >= 60 frames, got ${res.cleanFrames.length}`);
    assert.equal(res.cleanFrames.length, res.linearFrames.length);
    assert.equal(res.cleanFrames.length, res.steppedFrames.length);
    assert.equal(res.keyframeFrameIndices.length, kfs.length);
    assertAllUnitQuats(res.cleanFrames);

    // Smoothness & slip verification
    assert.ok(res.metrics.maxJumpDeg < 38, `${tpl.id}: unexpected jump ${res.metrics.maxJumpDeg} deg`);
    assert.ok(res.metrics.slipRmsCmS < 14, `${tpl.id}: unexpected slip ${res.metrics.slipRmsCmS} cm/s`);

    // Export canonical 21-bone BVH
    const bvh = exportFramesToBVH(res.cleanFrames, 60);
    assert.ok(bvh.includes('HIERARCHY') && bvh.includes('MOTION'));
    assert.equal(/NaN|Infinity|-0\.0000\b/.test(bvh), false);
  }
});

test('KeyframeInbetweener: multi-turn spinTurns (+1 and +2) generates continuous 360° and 720° pelvis yaw spins', () => {
  const measureCumulativeYawDeg = (frames) => {
    const { bones } = createBoneHierarchy();
    const q = new THREE.Quaternion();
    const fwd = new THREE.Vector3();
    let total = 0;
    let prev = null;
    for (const fr of frames) {
      bones[0].position.copy(fr.rootPos);
      for (let b = 0; b < bones.length; b++) bones[b].quaternion.copy(fr.quats[b]);
      bones[0].updateWorldMatrix(true, true);
      bones[BONE_IDX.Hips].getWorldQuaternion(q);
      fwd.set(0, 0, 1).applyQuaternion(q);
      const yaw = Math.atan2(fwd.x, fwd.z);
      if (prev !== null) {
        let d = yaw - prev;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        total += (d * 180) / Math.PI;
      }
      prev = yaw;
    }
    return total;
  };

  const kfA = snapKeyframeFeetToFloor(createNeutralKeyframe({ durationToNext: 0.6, spinTurns: 1 }));
  const kfB = snapKeyframeFeetToFloor(createNeutralKeyframe({ durationToNext: 0.4, spinTurns: 0 }));
  const spin1 = synthesizeKeyframeClip([kfA, kfB], { fps: 60, ikFootLock: 0 });
  const yaw1 = measureCumulativeYawDeg(spin1.cleanFrames);
  assert.ok(Math.abs(yaw1 - 360) < 12, `Expected ~360° spin for spinTurns=1, got ${yaw1.toFixed(1)}°`);

  const kfTwo = cloneKeyframe(kfA, { spinTurns: 2, durationToNext: 0.8 });
  const spin2 = synthesizeKeyframeClip([kfTwo, kfB], { fps: 60, ikFootLock: 0 });
  const yaw2 = measureCumulativeYawDeg(spin2.cleanFrames);
  assert.ok(Math.abs(yaw2 - 720) < 15, `Expected ~720° spin for spinTurns=2, got ${yaw2.toFixed(1)}°`);
});

test('KeyframeInbetweener: puppet bone Euler editing, L/R mirroring, floor snap, salient selector & provenance work cleanly', () => {
  const kf = createNeutralKeyframe({ rootPos: new THREE.Vector3(0.25, 1.35, 0) });
  setBoneLocalEulerDeg(kf, BONE_IDX.RightUpperArm, -24, 38, 42);
  const readBack = getBoneLocalEulerDeg(kf, BONE_IDX.RightUpperArm);
  assert.ok(Math.abs(readBack.x - -24) < 0.2);
  assert.ok(Math.abs(readBack.y - 38) < 0.2);
  assert.ok(Math.abs(readBack.z - 42) < 0.2);

  snapKeyframeFeetToFloor(kf, 0.08);
  assert.ok(kf.rootPos.y < 1.05 && kf.rootPos.y > 0.8, `Unexpected snapped rootPos.y=${kf.rootPos.y}`);

  mirrorKeyframePoseLR(kf);
  assert.ok(Math.abs(kf.rootPos.x - -0.25) < 1e-6);
  const mirroredLeft = getBoneLocalEulerDeg(kf, BONE_IDX.LeftUpperArm);
  assert.ok(Math.abs(mirroredLeft.z - -42) < 0.5, `Mirrored LeftUpperArm Z should negate to -42, got ${mirroredLeft.z}`);

  // Salient keyframe picker picks endpoints and peak inflection frame
  const seq = Array.from({ length: 30 }, (_, i) => {
    const f = createNeutralKeyframe();
    const peak = i === 14 ? 75 : i * 1.5;
    setBoneLocalEulerDeg(f, BONE_IDX.RightUpperArm, 0, peak, 30);
    return { rootPos: f.rootPos, quats: f.quats };
  });
  const picked = selectSalientKeyframeIndices(seq, 4);
  assert.equal(picked[0], 0);
  assert.equal(picked[picked.length - 1], 29);
  assert.equal(picked.includes(14), true, `Expected apex frame 14 in salient indices: ${picked}`);

  const prov = resolveMotionProvenance({ originKind: 'keyframe_synth', clipName: '太白无痕重制' });
  assert.equal(prov.originGroup, 'ai_extracted');
  assert.equal(prov.tagShort, '定格AI补帧');
});
