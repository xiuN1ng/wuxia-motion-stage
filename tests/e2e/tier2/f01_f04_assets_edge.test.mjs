import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BVH_LIBRARY_ROOT,
  RAW_MOCAP_DIR,
  B_CLEANED_DIR,
  C_TAIBAI_DIR,
  REF_VIDEOS_DIR,
  DRIVE_FOLDER_01_VIDEOS,
  DRIVE_FOLDER_02B_CLEANED,
  DRIVE_FOLDER_02C_TAIBAI,
  BASELINE_01_06_SPECS,
  TAIBAI_EXPECTED_FILENAMES,
  F3_STRAFE_FILENAMES,
  ALL_22_B_CLEANED_FILENAMES,
  REFERENCE_VIDEO_SPECS,
} from '../helpers/constants.mjs';
import {
  requireDeliverableFile,
  parseAndAnalyzeStandardBVH,
  loadAndNormalizeManifest,
  resolveManifestEntryPath,
  gdriveJson,
  ffmpegDecodeCheck,
  sha256File,
} from '../helpers/bvh_verifier.mjs';

const parsedCache = new Map();
function analyzeBVHFile(absPath, tag) {
  requireDeliverableFile(absPath, tag);
  const stat = fs.statSync(absPath);
  const key = `${absPath}:${stat.mtimeMs}:${stat.size}`;
  if (!parsedCache.has(key)) {
    parsedCache.set(key, parseAndAnalyzeStandardBVH(fs.readFileSync(absPath, 'utf8'), path.basename(absPath)));
  }
  return parsedCache.get(key);
}

// ============================================================================
// Feature F1 Tier 2: Boundary, Corner & Anti-Degeneracy Guards (7 Tests)
// ============================================================================

test('[T2][F1][T2-F1-01] Anti-T-pose & anti-MediaPipe-dropout frozen-frame guard across taibai_01b..04', () => {
  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    const bvh = analyzeBVHFile(path.join(C_TAIBAI_DIR, name), 'F1');
    assert.ok(bvh.maxIdenticalRun <= 15, `${name} frozen-frame dropout run=${bvh.maxIdenticalRun} > 15`);
    assert.ok(bvh.uniqueTransitionRatio >= 0.75, `${name} transition ratio=${bvh.uniqueTransitionRatio.toFixed(2)} < 0.75`);
    assert.ok(bvh.activeRotChs >= 10, `${name} active rotation channels=${bvh.activeRotChs} < 10`);
    const minSumStd = name.startsWith('taibai_01b') ? 8.0 : 80.0;
    assert.ok(bvh.sumRotStd >= minSumStd, `${name} sumRotStd=${bvh.sumRotStd.toFixed(1)}° < ${minSumStd}°`);
  }
});

test('[T2][F1][T2-F1-02] taibai_03 anti-240-frame / anti-4.0s-compression boundary guard', () => {
  const bvh03 = analyzeBVHFile(path.join(C_TAIBAI_DIR, 'taibai_03_雨落云飞_快剑五连斩_cleaned.bvh'), 'F1');
  assert.ok(bvh03.durationSec >= 4.8, `taibai_03 truncated to ${bvh03.durationSec.toFixed(3)}s (< 4.80s)`);
  assert.ok(Math.abs(bvh03.durationSec - 5.125) <= 0.48, `taibai_03 duration drift: ${bvh03.durationSec.toFixed(3)}s`);
  if (bvh03.fps >= 55) {
    assert.ok(bvh03.declaredFrames >= 288, `60fps taibai_03 must have >= 288 frames (>240 cap!), got ${bvh03.declaredFrames}`);
  } else {
    assert.ok(bvh03.declaredFrames >= 115, `24fps taibai_03 must have >= 115 frames, got ${bvh03.declaredFrames}`);
  }
});

test('[T2][F1][T2-F1-03] Strict auxiliary-bone exclusion & zero Hips rest OFFSET double-counting on taibai_01b..04', () => {
  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    const bvh = analyzeBVHFile(path.join(C_TAIBAI_DIR, name), 'F1');
    assert.deepEqual(bvh.joints[0].offset, [0, 0, 0], `${name} ROOT Hips header OFFSET must be 0 0 0`);
    const y0 = bvh.rows[0][1];
    assert.ok(y0 >= 50.0 && y0 <= 135.0, `${name} frame-0 Yposition=${y0}cm suggests scale/offset double-counting`);
  }
});

test('[T2][F1][T2-F1-04] 6-DoF sword-blade anti-chest-penetration guard across all 4 Taibai sword clips', () => {
  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    const bvh = analyzeBVHFile(path.join(C_TAIBAI_DIR, name), 'F1');
    let minTipChestCm = Infinity;
    for (let f = 0; f < bvh.declaredFrames; f++) {
      minTipChestCm = Math.min(minTipChestCm, bvh.worldTraj.SwordTip[f].distanceTo(bvh.worldTraj.Chest[f]));
    }
    assert.ok(
      minTipChestCm >= 12.0,
      `${name} SwordTip pierced Chest safety envelope: minDist=${minTipChestCm.toFixed(2)}cm < 12cm`
    );
    const maxHandChStd = Math.max(...bvh.jointRotStds.RightHand);
    assert.ok(maxHandChStd >= 1.2, `${name} RightHand has near-zero 6-DoF variance (${maxHandChStd.toFixed(2)}°)`);
  }
});

test('[T2][F1][T2-F1-05] taibai_04 split-landing knee singularity & subterranean ankle clamp guard', () => {
  const bvh04 = analyzeBVHFile(path.join(C_TAIBAI_DIR, 'taibai_04_飞燕逐月_腾空旋风跌叉_cleaned.bvh'), 'F1');
  let maxKneeStepDeg = 0;
  for (let f = 1; f < bvh04.declaredFrames; f++) {
    for (const jIdx of [14, 18]) {
      const dot = Math.min(1, Math.abs(bvh04.perFrameQuats[f][jIdx].dot(bvh04.perFrameQuats[f - 1][jIdx])));
      maxKneeStepDeg = Math.max(maxKneeStepDeg, 2 * Math.acos(dot) * (180 / Math.PI));
    }
  }
  assert.ok(maxKneeStepDeg <= 75.0, `taibai_04 knee gimbal/IK pop detected: ${maxKneeStepDeg.toFixed(1)}° in 1 frame`);
  const minAnkleY = Math.min(
    ...bvh04.worldTraj.LeftFoot.map((p) => p.y),
    ...bvh04.worldTraj.RightFoot.map((p) => p.y)
  );
  assert.ok(minAnkleY >= 5.0, `taibai_04 foot sank underground: ${minAnkleY.toFixed(2)}cm`);
});

test('[T2][F1][T2-F1-06] taibai_02 asymmetric single-leg stance lock: planted foot locked while raised foot free', () => {
  const bvh02 = analyzeBVHFile(path.join(C_TAIBAI_DIR, 'taibai_02_无痕剑意_独立提膝云剑_cleaned.bvh'), 'F1');
  const plantedSpeeds = [];
  let maxRaisedY = 0;

  for (let f = 1; f < bvh02.declaredFrames; f++) {
    const lCur = bvh02.worldTraj.LeftFoot[f];
    const rCur = bvh02.worldTraj.RightFoot[f];
    maxRaisedY = Math.max(maxRaisedY, lCur.y, rCur.y);
    if (Math.abs(lCur.y - rCur.y) >= 15.0) {
      if (lCur.y < rCur.y) {
        const lPrev = bvh02.worldTraj.LeftFoot[f - 1];
        plantedSpeeds.push(Math.hypot(lCur.x - lPrev.x, lCur.z - lPrev.z) * bvh02.fps);
      } else {
        const rPrev = bvh02.worldTraj.RightFoot[f - 1];
        plantedSpeeds.push(Math.hypot(rCur.x - rPrev.x, rCur.z - rPrev.z) * bvh02.fps);
      }
    }
  }
  assert.ok(plantedSpeeds.length >= 6, 'Expected knee-raise frames to measure planted foot speed');
  const meanPlantedSpd = plantedSpeeds.reduce((a, b) => a + b, 0) / plantedSpeeds.length;
  assert.ok(meanPlantedSpd <= 20.0, `Planted support foot skated during taibai_02: ${meanPlantedSpd.toFixed(2)} cm/s`);
  assert.ok(maxRaisedY >= 23.0, `Lifted knee foot was erroneously pinned to floor: maxRaisedY=${maxRaisedY.toFixed(1)}cm`);
});

test('[T2][F1][T2-F1-07] Non-cyclic final-frame wrap-snap guard on taibai_02, taibai_03, and taibai_04', () => {
  for (const name of TAIBAI_EXPECTED_FILENAMES.slice(1)) {
    const bvh = analyzeBVHFile(path.join(C_TAIBAI_DIR, name), 'F1');
    const N = bvh.declaredFrames;
    const endHipsStep = bvh.worldTraj.Hips[N - 1].distanceTo(bvh.worldTraj.Hips[N - 2]);
    assert.ok(endHipsStep <= 15.0, `${name} final-frame Hips wrap snap: ${endHipsStep.toFixed(2)}cm`);

    let maxEndJointStepDeg = 0;
    for (let j = 0; j < 21; j++) {
      const dot = Math.min(1, Math.abs(bvh.perFrameQuats[N - 1][j].dot(bvh.perFrameQuats[N - 2][j])));
      maxEndJointStepDeg = Math.max(maxEndJointStepDeg, 2 * Math.acos(dot) * (180 / Math.PI));
    }
    assert.ok(maxEndJointStepDeg <= 35.0, `${name} final-frame joint wrap snap: ${maxEndJointStepDeg.toFixed(1)}°`);
  }
});

// ============================================================================
// Feature F2 Tier 2: Cloud Sync Non-Deletion, Decode & Invariance Guards (7 Tests)
// ============================================================================

test('[T2][F2][T2-F2-01] Google Drive 02/C strict zero-duplicate count guard (exact 4 unique files)', () => {
  const driveFiles = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_02C_TAIBAI]);
  assert.equal(
    driveFiles.length,
    4,
    `[F2] Expected EXACTLY 4 files in non-deletable Drive 02/C, got ${driveFiles.length}: [${driveFiles.map((f) => f.name).join(', ')}]`
  );
  const uniqueNames = new Set(driveFiles.map((f) => f.name));
  assert.equal(uniqueNames.size, 4, '[F2] Duplicate filenames detected in Drive 02/C');
});

test('[T2][F2][T2-F2-02] Google Drive 02/C capabilities & zero-trashed-items guard', () => {
  const caps = gdriveJson([
    'readonly',
    'capabilities',
    DRIVE_FOLDER_02C_TAIBAI,
    '--filter',
    'canEdit,canAddChildren,canDeleteChildren,canTrashChildren,canRename',
  ]);
  assert.equal(caps.canAddChildren, true);
  assert.equal(caps.canEdit, true);
  assert.equal(caps.canDeleteChildren, false);

  const trashed = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_02C_TAIBAI, '--trashed']);
  assert.equal(trashed.length, 0, `Expected 0 trashed items in Drive 02/C, found ${trashed.length}`);
});

test('[T2][F2][T2-F2-03] Google Drive 02/C Unicode NFC filename & minimum payload guard', () => {
  const driveFiles = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_02C_TAIBAI]);
  assert.equal(driveFiles.length, 4, 'Drive 02/C must contain the 4 Taibai BVH files');
  for (const item of driveFiles) {
    assert.equal(item.name, item.name.normalize('NFC'), `Non-NFC filename on Drive: ${item.name}`);
    assert.ok(item.name.endsWith('_cleaned.bvh'), `Unexpected suffix on Drive: ${item.name}`);
    assert.ok(Number(item.size) >= 8000, `Truncated/empty upload on Drive: ${item.name} (${item.size} B)`);
  }
});

test('[T2][F2][T2-F2-04] Master video 05 tail-frame decode integrity guard at t = 74.5s (anti-truncated download)', () => {
  const spec05 = REFERENCE_VIDEO_SPECS.find((s) => s.key === '05');
  const abs05 = path.join(REF_VIDEOS_DIR, spec05.file);
  requireDeliverableFile(abs05, 'F2');
  const stderr = ffmpegDecodeCheck(abs05, 74.5, 1);
  assert.equal(stderr.trim(), '', `ffmpeg tail decode error at 74.5s: ${stderr}`);
});

test('[T2][F2][T2-F2-05] Master video 05 random-access keyframe seek decode at 26.72s & 45.40s crop timestamps', () => {
  const spec05 = REFERENCE_VIDEO_SPECS.find((s) => s.key === '05');
  const abs05 = path.join(REF_VIDEOS_DIR, spec05.file);
  requireDeliverableFile(abs05, 'F2');
  assert.equal(ffmpegDecodeCheck(abs05, 26.72, 2).trim(), '', 'Seek decode failed at 26.72s (Yuluo start)');
  assert.equal(ffmpegDecodeCheck(abs05, 45.4, 2).trim(), '', 'Seek decode failed at 45.40s (Feiyan start)');
});

test('[T2][F2][T2-F2-06] Baseline local reference videos 01b, 02, 03, 04 retain exact byte sizes', () => {
  for (const spec of REFERENCE_VIDEO_SPECS.filter((s) => s.baselinePresent)) {
    const abs = path.join(REF_VIDEOS_DIR, spec.file);
    const stat = requireDeliverableFile(abs, 'F2');
    assert.equal(stat.size, spec.bytes, `Baseline reference video ${spec.file} was mutated (${stat.size} != ${spec.bytes})`);
  }
});

test('[T2][F2][T2-F2-07] Upstream Google Drive shared folders (01 Videos & 02/B Cleaned BVHs) remain unmutated', () => {
  const vList = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_01_VIDEOS]);
  const bList = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_02B_CLEANED]);
  assert.equal(vList.length, 8, `Upstream Drive 01 folder item count changed (${vList.length} != 8)`);
  assert.equal(bList.length, 6, `Upstream Drive 02/B folder item count changed (${bList.length} != 6)`);
});

// ============================================================================
// Feature F3 Tier 2: Baseline Immutability, Provenance & Kinematic Guards (7 Tests)
// ============================================================================

test('[T2][F3][T2-F3-01] Immutable baseline 01..06 in B_cleaned_ready/ preserve exact SHA-256 digests & byte sizes', () => {
  for (const spec of BASELINE_01_06_SPECS) {
    const abs = path.join(B_CLEANED_DIR, spec.file);
    const stat = requireDeliverableFile(abs, 'F3');
    assert.equal(stat.size, spec.bytes, `Baseline ${spec.file} byte size mutated`);
    assert.equal(sha256File(abs), spec.sha256, `Baseline ${spec.file} SHA-256 digest mutated`);
  }
});

test('[T2][F3][T2-F3-02] Anti-bogus CMU provenance guard: bans 24_01 nursery rhyme & 87_02 static T-pose', () => {
  const bannedPattern = /(^|[^0-9])(0?24_0?1|0?87_0?2)([^0-9]|$)|024\//i;
  const rawFiles = fs.existsSync(RAW_MOCAP_DIR) ? fs.readdirSync(RAW_MOCAP_DIR) : [];
  for (const rf of rawFiles) {
    assert.equal(bannedPattern.test(rf), false, `Forbidden hallucinated CMU trial in A_raw_mocap: ${rf}`);
  }

  const manifest = loadAndNormalizeManifest();
  for (const entry of manifest) {
    const prov =
      typeof entry.sourceProvenance === 'string'
        ? entry.sourceProvenance
        : JSON.stringify(entry.sourceProvenance || '');
    assert.equal(
      bannedPattern.test(prov),
      false,
      `MANIFEST entry "${entry.id}" cites forbidden hallucinated CMU trial: "${prov}"`
    );
  }
});

test('[T2][F3][T2-F3-03] Mutual distinctness across all 28 pairs of 07_wuxia_strafe_{F,B,L,R,FL,FR,BL,BR}', () => {
  const hashes = new Set();
  const signatures = [];

  for (const name of F3_STRAFE_FILENAMES) {
    const abs = path.join(B_CLEANED_DIR, name);
    const bvh = analyzeBVHFile(abs, 'F3');
    hashes.add(sha256File(abs));

    // Build kinematic signature from Hips + LeftFoot + RightFoot mean/delta vectors
    const N = bvh.declaredFrames;
    const dHips = bvh.worldTraj.Hips[N - 1].clone().sub(bvh.worldTraj.Hips[0]);
    let meanRelFootX = 0;
    let meanRelFootZ = 0;
    for (let f = 1; f < N; f++) {
      meanRelFootX += bvh.worldTraj.LeftFoot[f].x - bvh.worldTraj.LeftFoot[0].x;
      meanRelFootZ += bvh.worldTraj.LeftFoot[f].z - bvh.worldTraj.LeftFoot[0].z;
    }
    meanRelFootX /= N - 1;
    meanRelFootZ /= N - 1;
    signatures.push({ name, vec: [dHips.x, dHips.z, meanRelFootX, meanRelFootZ, ...bvh.jointRotStds.LeftUpLeg] });
  }

  assert.equal(hashes.size, 8, 'All 8 directional strafe BVH files must have distinct SHA-256 hashes');
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      let sq = 0;
      for (let k = 0; k < signatures[i].vec.length; k++) {
        sq += (signatures[i].vec[k] - signatures[j].vec[k]) ** 2;
      }
      assert.ok(
        Math.sqrt(sq) > 1.5,
        `Strafe clips ${signatures[i].name} and ${signatures[j].name} are kinematically indistinguishable`
      );
    }
  }
});

test('[T2][F3][T2-F3-04] 8-way strafe lock-on forward-hemisphere combat facing guard (+Z Chest orientation)', () => {
  for (const name of F3_STRAFE_FILENAMES) {
    const bvh = analyzeBVHFile(path.join(B_CLEANED_DIR, name), 'F3');
    const meanChestFwdZ =
      bvh.worldTraj.chestFwdZ.reduce((a, b) => a + b, 0) / bvh.worldTraj.chestFwdZ.length;
    assert.ok(
      meanChestFwdZ >= 0.25,
      `${name} turned back on locked target: mean(chestFwdZ)=${meanChestFwdZ.toFixed(3)} < 0.25`
    );
  }
});

test('[T2][F3][T2-F3-05] 08_wuxia_dash_canglong anti-avgZ-centering & anti-rubberband snap-back guard', () => {
  const bvh = analyzeBVHFile(path.join(B_CLEANED_DIR, '08_wuxia_dash_canglong_苍龙出水突刺_cleaned.bvh'), 'F3');
  const zSeries = bvh.worldTraj.Hips.map((p) => p.z);
  const z0 = zSeries[0];
  const zEnd = zSeries[zSeries.length - 1];
  const zMax = Math.max(...zSeries);

  assert.ok(Math.abs(z0) <= 15.0, `Dash Z[0]=${z0.toFixed(1)}cm shows avgZ centering shifted start backward`);
  assert.ok(zEnd >= 80.0, `Dash Z[N-1]=${zEnd.toFixed(1)}cm < +80cm`);
  assert.ok(zEnd >= zMax - 25.0, `Dash rubberbanded backward at end: zEnd=${zEnd.toFixed(1)} vs zMax=${zMax.toFixed(1)}`);
});

test('[T2][F3][T2-F3-06] 09_wuxia_dodge_roll inversion foot-unlock & head floor-safety guard', () => {
  const bvh = analyzeBVHFile(path.join(B_CLEANED_DIR, '09_wuxia_dodge_roll_翻滚闪避_cleaned.bvh'), 'F3');
  const maxFootY = Math.max(
    ...bvh.worldTraj.LeftFoot.map((p) => p.y),
    ...bvh.worldTraj.RightFoot.map((p) => p.y)
  );
  assert.ok(maxFootY >= 30.0, `Feet remained pinned to floor during roll: maxFootY=${maxFootY.toFixed(1)}cm`);

  const minHeadY = Math.min(...bvh.worldTraj.Head.map((p) => p.y));
  assert.ok(minHeadY >= 4.0, `Head plunged below floor during roll: minHeadY=${minHeadY.toFixed(1)}cm`);
});

test('[T2][F3][T2-F3-07] 10_wuxia_double_jump anti-rigid-translation & knee-flexion articulation guard', () => {
  const bvh = analyzeBVHFile(path.join(B_CLEANED_DIR, '10_wuxia_double_jump_二段轻功跳_cleaned.bvh'), 'F3');
  const lKneeStd = Math.hypot(...bvh.jointRotStds.LeftLeg);
  const rKneeStd = Math.hypot(...bvh.jointRotStds.RightLeg);
  assert.ok(lKneeStd >= 6.0 && rKneeStd >= 6.0, `Double jump lacks real knee articulation: L=${lKneeStd.toFixed(1)}°, R=${rKneeStd.toFixed(1)}°`);
  assert.ok(bvh.sumRotStd >= 90.0, `Double jump sumRotStd=${bvh.sumRotStd.toFixed(1)}° < 90°`);
  assert.ok(bvh.maxIdenticalRun <= 8, `Double jump frozen run=${bvh.maxIdenticalRun} > 8`);
});

// ============================================================================
// Feature F4 Tier 2: Hit-React Symmetry, Supine Floor & Bijection Guards (7 Tests)
// ============================================================================

test('[T2][F4][T2-F4-01] 11_hit_light_L & 12_hit_light_R anti-dance & front-loaded impact impulse guard', () => {
  for (const name of [
    '11_wuxia_hit_light_L_左轻受击_cleaned.bvh',
    '12_wuxia_hit_light_R_右轻受击_cleaned.bvh',
  ]) {
    const bvh = analyzeBVHFile(path.join(B_CLEANED_DIR, name), 'F4');
    assert.ok(bvh.durationSec >= 0.3 && bvh.durationSec <= 2.2);
    assert.ok(bvh.maxIdenticalRun <= 10);
    assert.ok(bvh.sumRotStd >= 35.0, `${name} sumRotStd=${bvh.sumRotStd.toFixed(1)}° < 35°`);

    // Peak upper-body angular velocity should occur within first 75% of clip
    let peakIdx = 1;
    let peakStep = 0;
    for (let f = 1; f < bvh.declaredFrames; f++) {
      let stepSum = 0;
      for (const jIdx of [1, 2, 3, 4]) {
        const dot = Math.min(1, Math.abs(bvh.perFrameQuats[f][jIdx].dot(bvh.perFrameQuats[f - 1][jIdx])));
        stepSum += 2 * Math.acos(dot);
      }
      if (stepSum > peakStep) {
        peakStep = stepSum;
        peakIdx = f;
      }
    }
    assert.ok(
      peakIdx / bvh.declaredFrames <= 0.78,
      `${name} peak recoil occurred too late at u=${(peakIdx / bvh.declaredFrames).toFixed(2)}`
    );
  }
});

test('[T2][F4][T2-F4-02] Bilateral opposition guard between 11_wuxia_hit_light_L and 12_wuxia_hit_light_R', () => {
  const absL = path.join(B_CLEANED_DIR, '11_wuxia_hit_light_L_左轻受击_cleaned.bvh');
  const absR = path.join(B_CLEANED_DIR, '12_wuxia_hit_light_R_右轻受击_cleaned.bvh');
  const bvhL = analyzeBVHFile(absL, 'F4');
  const bvhR = analyzeBVHFile(absR, 'F4');

  assert.notEqual(sha256File(absL), sha256File(absR), '11_L and 12_R must not be identical files');

  const signedPeak = (arr) => {
    let best = 0;
    for (const v of arr) {
      if (Math.abs(v) > Math.abs(best)) best = v;
    }
    return best;
  };
  const dChestXL = signedPeak(bvhL.worldTraj.Chest.map((p) => p.x - bvhL.worldTraj.Chest[0].x));
  const dChestXR = signedPeak(bvhR.worldTraj.Chest.map((p) => p.x - bvhR.worldTraj.Chest[0].x));
  const rollL = signedPeak(bvhL.worldTraj.chestRollX.map((v) => v - bvhL.worldTraj.chestRollX[0]));
  const rollR = signedPeak(bvhR.worldTraj.chestRollX.map((v) => v - bvhR.worldTraj.chestRollX[0]));

  assert.ok(
    dChestXL * dChestXR < 0 || rollL * rollR < 0 || Math.abs(dChestXL - dChestXR) >= 4.0,
    `11_L and 12_R lack bilateral lateral opposition: dChestX=(${dChestXL.toFixed(2)}, ${dChestXR.toFixed(2)}), roll=(${rollL.toFixed(3)}, ${rollR.toFixed(3)})`
  );
});

test('[T2][F4][T2-F4-03] Supine pelvis & chest floor non-penetration guard across 13, 14, and 15', () => {
  for (const name of [
    '13_wuxia_knockdown_击飞倒地_cleaned.bvh',
    '14_wuxia_kipup_鲤鱼打挺起身_cleaned.bvh',
    '15_wuxia_knockdown_kipup_击飞倒地接鲤鱼打挺_cleaned.bvh',
  ]) {
    const bvh = analyzeBVHFile(path.join(B_CLEANED_DIR, name), 'F4');
    const minHipsY = Math.min(...bvh.worldTraj.Hips.map((p) => p.y));
    const minChestY = Math.min(...bvh.worldTraj.Chest.map((p) => p.y));
    assert.ok(minHipsY >= 6.0, `${name} Hips sank underground: minHipsY=${minHipsY.toFixed(2)}cm`);
    assert.ok(minChestY >= 5.0, `${name} Chest sank underground: minChestY=${minChestY.toFixed(2)}cm`);
  }
});

test('[T2][F4][T2-F4-04] 13_wuxia_knockdown non-cyclic stay-supine guard (never rubberbands back to standing)', () => {
  const bvh13 = analyzeBVHFile(path.join(B_CLEANED_DIR, '13_wuxia_knockdown_击飞倒地_cleaned.bvh'), 'F4');
  const N = bvh13.declaredFrames;
  const y0 = bvh13.worldTraj.Hips[0].y;
  const yEnd = bvh13.worldTraj.Hips[N - 1].y;
  assert.ok(y0 - yEnd >= 28.0, `13_knockdown failed to drop supine: y0=${y0.toFixed(1)}, yEnd=${yEnd.toFixed(1)}`);
  assert.ok(yEnd <= 48.0, `13_knockdown looped back to standing: yEnd=${yEnd.toFixed(1)}cm > 48cm`);
});

test('[T2][F4][T2-F4-05] 14_wuxia_kipup clean grounded two-foot landing & anti-end-wrap guard', () => {
  const bvh14 = analyzeBVHFile(path.join(B_CLEANED_DIR, '14_wuxia_kipup_鲤鱼打挺起身_cleaned.bvh'), 'F4');
  const N = bvh14.declaredFrames;
  const y0 = bvh14.worldTraj.Hips[0].y;
  const yEnd = bvh14.worldTraj.Hips[N - 1].y;
  assert.ok(yEnd - y0 >= 28.0, `14_kipup failed to rise from supine: y0=${y0.toFixed(1)}, yEnd=${yEnd.toFixed(1)}`);

  const endStep = bvh14.worldTraj.Hips[N - 1].distanceTo(bvh14.worldTraj.Hips[N - 2]);
  assert.ok(endStep <= 12.0, `14_kipup wrapped back to supine on final frame: step=${endStep.toFixed(2)}cm`);
});

test('[T2][F4][T2-F4-06] 15_wuxia_knockdown_kipup internal C0/C1 splice-continuity guard', () => {
  const bvh15 = analyzeBVHFile(
    path.join(B_CLEANED_DIR, '15_wuxia_knockdown_kipup_击飞倒地接鲤鱼打挺_cleaned.bvh'),
    'F4'
  );
  let maxHipsStepCm = 0;
  let maxJointStepDeg = 0;
  for (let f = 1; f < bvh15.declaredFrames; f++) {
    maxHipsStepCm = Math.max(maxHipsStepCm, bvh15.worldTraj.Hips[f].distanceTo(bvh15.worldTraj.Hips[f - 1]));
    for (let j = 0; j < 21; j++) {
      const dot = Math.min(1, Math.abs(bvh15.perFrameQuats[f][j].dot(bvh15.perFrameQuats[f - 1][j])));
      maxJointStepDeg = Math.max(maxJointStepDeg, 2 * Math.acos(dot) * (180 / Math.PI));
    }
  }
  assert.ok(maxHipsStepCm <= 18.0, `Hard splice teleport in 15_knockdown_kipup: maxHipsStep=${maxHipsStepCm.toFixed(2)}cm`);
  assert.ok(maxJointStepDeg <= 55.0, `Hard joint pop in 15_knockdown_kipup: maxJointStep=${maxJointStepDeg.toFixed(1)}°`);
});

test('[T2][F4][T2-F4-07] Strict 26-file disk <-> MANIFEST.json bijection & zero-orphan / zero-temp-file guard', () => {
  const manifest = loadAndNormalizeManifest();
  assert.equal(manifest.length, 26);

  const ids = new Set(manifest.map((e) => e.id));
  assert.equal(ids.size, 26, 'All 26 MANIFEST.json IDs must be unique');

  const manifestAbsPaths = new Set(manifest.map((e) => resolveManifestEntryPath(e.path)));
  assert.equal(manifestAbsPaths.size, 26);

  const bFiles = fs.readdirSync(B_CLEANED_DIR);
  const cFiles = fs.readdirSync(C_TAIBAI_DIR);
  for (const f of [...bFiles, ...cFiles, ...fs.readdirSync(BVH_LIBRARY_ROOT)]) {
    assert.equal(/\.(tmp|bak|part|swp)$/i.test(f), false, `Leftover temp file in bvh_library: ${f}`);
  }

  const diskAbsPaths = new Set([
    ...bFiles.filter((f) => f.endsWith('.bvh')).map((f) => path.join(B_CLEANED_DIR, f)),
    ...cFiles.filter((f) => f.endsWith('.bvh')).map((f) => path.join(C_TAIBAI_DIR, f)),
  ]);
  assert.equal(bFiles.filter((f) => f.endsWith('.bvh')).length, ALL_22_B_CLEANED_FILENAMES.length);
  assert.equal(cFiles.filter((f) => f.endsWith('.bvh')).length, TAIBAI_EXPECTED_FILENAMES.length);
  assert.deepEqual([...diskAbsPaths].sort(), [...manifestAbsPaths].sort());
});
