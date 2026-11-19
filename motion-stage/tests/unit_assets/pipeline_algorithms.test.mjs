import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BONE_IDX, createBoneHierarchy, buildCharacterRig } from '../../src/rig/HumanoidRig.js';
import {
  emptyFrame,
  cloneFrame,
  applyFrameToBones,
  upsampleFramesSlerp,
  applyCapsuleFloorClearance,
  enforceSwordTorsoClearance,
  lockFeetWithTwoBoneIK,
  retargetBVHSliceTo60,
} from '../../scripts/lib/motionPipeline.mjs';
import {
  landmarksToHumanoidFrame,
  backfillMissingFrames,
  calibrateVideoSequenceMetrics,
  regularizeVideoJointContinuity24,
} from '../../scripts/lib/videoPoseSolver.mjs';
import { startEphemeralAssetServer } from '../../scripts/batch_extract.mjs';

test('Ephemeral asset HTTP server supports 200, HTTP 206 Range slicing, 416, and blocks path traversal', async () => {
  const srv = await startEphemeralAssetServer();
  try {
    const htmlResp = await fetch(`${srv.origin}/extract.html`);
    assert.equal(htmlResp.status, 200);
    const html = await htmlResp.text();
    assert.ok(html.includes('importmap'));

    // Path traversal attempt must return 403/404, never expose parent files
    const travResp = await fetch(`${srv.origin}/node_modules/../../package.json`);
    assert.ok(travResp.status === 403 || travResp.status === 404);

    // HTTP 206 Partial Content byte range on reference video
    const videoUrl = `${srv.origin}/reference_videos/${encodeURIComponent(
      '01b_天刀官网_太白崖顶拔剑定势_全身镜头.mp4'
    )}`;
    const rangeResp = await fetch(videoUrl, { headers: { Range: 'bytes=0-15' } });
    assert.equal(rangeResp.status, 206);
    assert.match(rangeResp.headers.get('content-range') || '', /^bytes 0-15\/1225590$/);
    const bytes = new Uint8Array(await rangeResp.arrayBuffer());
    assert.equal(bytes.byteLength, 16);

    // Out-of-bounds range returns 416
    const badRange = await fetch(videoUrl, { headers: { Range: 'bytes=99999999-999999999' } });
    assert.equal(badRange.status, 416);
  } finally {
    await srv.close();
  }
});

test('Pipeline algorithms: cgspeed frame-0 guard, capsule clearance, sword Head/Neck clearance, and temporal continuity', () => {
  assert.throws(
    () => retargetBVHSliceTo60('HIERARCHY\n', { start120: 0, end120: 10 }),
    /start120 .* must be >= 1/
  );

  // Capsule floor clearance lifts subterranean pelvis above >= 15.5cm
  const lowFrame = emptyFrame();
  lowFrame.rootPos.set(0, 0.02, 0);
  const lifted = applyCapsuleFloorClearance([lowFrame, lowFrame, lowFrame]);
  assert.ok(lifted[1].rootPos.y >= 0.154, `Expected lifted Hips.y >= 0.155m, got ${lifted[1].rootPos.y}`);

  // Sword clearance protects both Torso AND Head/Neck without 1-frame pole-flipping
  const seq = Array.from({ length: 12 }, (_, i) => {
    const fr = emptyFrame();
    fr.quats[BONE_IDX.RightUpperArm].setFromEuler(new THREE.Euler(0.25, 1.15 + 0.02 * Math.sin(i), 0.35));
    fr.quats[BONE_IDX.RightForeArm].setFromEuler(new THREE.Euler(0.1, 1.05, 0));
    fr.quats[BONE_IDX.RightHand].setFromEuler(new THREE.Euler(0.3, 1.1 + (i % 2 === 0 ? 0.03 : -0.03), 0));
    return fr;
  });
  const safeSeq = enforceSwordTorsoClearance(seq, 0.245, true);
  assert.equal(safeSeq.length, 12);

  const { bones, swordGroup } = buildCharacterRig();
  let maxHandStepDeg = 0;
  for (let i = 0; i < safeSeq.length; i++) {
    applyFrameToBones(safeSeq[i], bones);
    swordGroup.updateWorldMatrix(true, true);
    const pBase = swordGroup.userData.baseAnchor.getWorldPosition(new THREE.Vector3());
    const pTip = swordGroup.userData.tipAnchor.getWorldPosition(new THREE.Vector3());
    const pHead = bones[BONE_IDX.Head].getWorldPosition(new THREE.Vector3());
    const pNeck = bones[BONE_IDX.Neck].getWorldPosition(new THREE.Vector3());
    const ab = new THREE.Vector3().subVectors(pTip, pBase);
    const segDist = (pt) => {
      const t = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(pt, pBase).dot(ab) / ab.lengthSq(), 0, 1);
      return pBase.clone().addScaledVector(ab, t).distanceTo(pt);
    };
    assert.ok(segDist(pHead) >= 0.21, `Sword impaled Head: ${segDist(pHead)}`);
    assert.ok(segDist(pNeck) >= 0.21, `Sword impaled Neck: ${segDist(pNeck)}`);
    if (i > 0) {
      const dot = Math.min(1, Math.abs(safeSeq[i].quats[BONE_IDX.RightHand].dot(safeSeq[i - 1].quats[BONE_IDX.RightHand])));
      maxHandStepDeg = Math.max(maxHandStepDeg, (2 * Math.acos(dot) * 180) / Math.PI);
    }
  }
  assert.ok(maxHandStepDeg <= 20.0, `Expected smooth RightHand trajectory <= 20°, got ${maxHandStepDeg.toFixed(2)}°`);

  // Hemisphere-aligned slerp upsampling preserves unit quaternions across antipodal sign flips
  const fA = emptyFrame();
  const fB = emptyFrame();
  fB.quats[0].set(-0, -0, -0, -1);
  const up = upsampleFramesSlerp([fA, fB], 10);
  assert.equal(up.length, 10);
  for (const fr of up) {
    assert.ok(Math.abs(fr.quats[0].length() - 1) < 1e-6);
  }
});

test('Video pose solver: 24fps spike regularizer, non-stance IK foot decoupling, and two-leg aerial jump-tuck gate', () => {
  // 1. 24fps outlier despiker removes a 1-frame 140° MediaPipe wrist flip
  const seq24 = Array.from({ length: 7 }, () => emptyFrame());
  seq24[3].quats[BONE_IDX.RightHand].setFromAxisAngle(new THREE.Vector3(0, 1, 0), (140 * Math.PI) / 180);
  regularizeVideoJointContinuity24(seq24, false);
  const residualFlipDeg =
    (2 * Math.acos(Math.min(1, Math.abs(seq24[3].quats[BONE_IDX.RightHand].dot(seq24[2].quats[BONE_IDX.RightHand])))) * 180) /
    Math.PI;
  assert.ok(residualFlipDeg < 2.0, `Expected despiked RightHand residual < 2°, got ${residualFlipDeg.toFixed(2)}°`);

  // 2. lockFeetWithTwoBoneIK does not snap pitched Foot flat on non-stance 2mm floor-penetration dip
  const swingSeq = Array.from({ length: 8 }, (_, f) => {
    const fr = emptyFrame();
    // Foot pitched 55° during swing while ankle dips slightly near floorY=0.08m on frame 4
    fr.rootPos.set(0, f === 4 ? 0.935 : 0.96, f * 0.06);
    fr.quats[BONE_IDX.LeftFoot].setFromAxisAngle(new THREE.Vector3(1, 0, 0), (55 * Math.PI) / 180);
    fr.contactL = false;
    fr.contactR = false;
    return fr;
  });
  const ikSeq = lockFeetWithTwoBoneIK(swingSeq, 60, false, { keepFootFlat: true });
  const footStep4Deg =
    (2 * Math.acos(Math.min(1, Math.abs(ikSeq[4].quats[BONE_IDX.LeftFoot].dot(ikSeq[3].quats[BONE_IDX.LeftFoot])))) * 180) /
    Math.PI;
  assert.ok(footStep4Deg < 5.0, `Expected non-stance foot rotation step < 5°, got ${footStep4Deg.toFixed(2)}°`);

  // 3. calibrateVideoSequenceMetrics keeps standing frames grounded & lifts two-leg aerial jump-tuck
  const worldLm = Array.from({ length: 33 }, (_, idx) => ({
    x: idx % 2 === 0 ? -0.15 : 0.15,
    y: idx >= 27 ? 0.80 : idx >= 23 ? 0.0 : -0.5,
    z: 0,
  }));
  const normLm = Array.from({ length: 33 }, (_, idx) => ({
    x: 0.5,
    y: idx >= 27 ? 0.85 : idx >= 23 ? 0.52 : 0.27,
    z: 0,
  }));
  const standPose = landmarksToHumanoidFrame(worldLm, normLm);
  const tuckPose = cloneFrame(standPose);
  // Flex both hips & knees so both ankles tuck near hip height (relMinFootY > -0.35m) while 2D hip rises
  tuckPose.quats[BONE_IDX.LeftUpLeg].setFromAxisAngle(new THREE.Vector3(1, 0, 0), -1.65);
  tuckPose.quats[BONE_IDX.RightUpLeg].setFromAxisAngle(new THREE.Vector3(1, 0, 0), -1.65);
  tuckPose.quats[BONE_IDX.LeftLeg].setFromAxisAngle(new THREE.Vector3(1, 0, 0), 2.35);
  tuckPose.quats[BONE_IDX.RightLeg].setFromAxisAngle(new THREE.Vector3(1, 0, 0), 2.35);
  tuckPose._imgMeta = { ...standPose._imgMeta, hipY: 0.36, lowestAnkleY: 0.45 };

  const calSeq = backfillMissingFrames([
    cloneFrame(standPose),
    cloneFrame(standPose),
    tuckPose,
    cloneFrame(standPose),
  ]);
  // Preserve _imgMeta across cloned frames
  calSeq[0]._imgMeta = { ...standPose._imgMeta };
  calSeq[1]._imgMeta = { ...standPose._imgMeta };
  calSeq[3]._imgMeta = { ...standPose._imgMeta };

  calibrateVideoSequenceMetrics(calSeq, { allowAerial: false, anchorStartXZ: true });
  const { bones } = createBoneHierarchy();
  applyFrameToBones(calSeq[0], bones);
  const pFoot = new THREE.Vector3();
  bones[BONE_IDX.LeftFoot].getWorldPosition(pFoot);
  assert.ok(Math.abs(pFoot.y - 0.08) < 0.02, `Standing foot should be at 8cm, got ${pFoot.y}`);
  assert.ok(calSeq[2].rootPos.y >= 0.85, `Expected aerial jump-tuck Hips.y >= 0.85m, got ${calSeq[2].rootPos.y}`);
});
