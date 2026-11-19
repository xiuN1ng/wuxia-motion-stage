import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RAW_MOCAP_DIR,
  B_CLEANED_DIR,
  C_TAIBAI_DIR,
  REF_VIDEOS_DIR,
  DRIVE_FOLDER_02C_TAIBAI,
  DRIVE_FILE_05_MASTER,
  TAIBAI_EXPECTED_FILENAMES,
  F3_STRAFE_FILENAMES,
  F3_EXPECTED_FILENAMES,
  F4_EXPECTED_FILENAMES,
  REFERENCE_VIDEO_SPECS,
} from '../helpers/constants.mjs';
import { importBVHLoader } from '../helpers/contract_loader.mjs';
import {
  requireDeliverableFile,
  parseAndAnalyzeStandardBVH,
  parseGenericBVHSummary,
  loadAndNormalizeManifest,
  resolveManifestEntryPath,
  gdriveJson,
  gdriveDownloadReadonly,
  ffprobeVideo,
  sha256File,
  withEphemeralShmDir,
} from '../helpers/bvh_verifier.mjs';

const parsedCache = new Map();
function analyzeBVHFile(absPath, tag) {
  requireDeliverableFile(absPath, tag);
  const stat = fs.statSync(absPath);
  const key = `${absPath}:${stat.mtimeMs}:${stat.size}`;
  if (!parsedCache.has(key)) {
    const text = fs.readFileSync(absPath, 'utf8');
    parsedCache.set(key, parseAndAnalyzeStandardBVH(text, path.basename(absPath)));
  }
  return parsedCache.get(key);
}

// ============================================================================
// Feature F1: Taibai 01b–04 Batch BVH Extraction (7 Happy-Path Tests)
// ============================================================================

test('[T1][F1][T1-F1-01] C_taibai_extracted directory contains all 4 canonical Taibai BVH files', () => {
  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    const abs = path.join(C_TAIBAI_DIR, name);
    const stat = requireDeliverableFile(abs, 'F1');
    assert.ok(stat.size >= 8000, `[F1] Expected ${name} >= 8000 bytes, got ${stat.size}`);
    const head = fs.readFileSync(abs, 'utf8').slice(0, 64).trimStart();
    assert.ok(head.startsWith('HIERARCHY'), `[F1] ${name} must start with HIERARCHY`);
  }
});

test('[T1][F1][T1-F1-02] All 4 Taibai BVH clips satisfy 21-bone cm/ZXY 66-channel contract & Three.js BVHLoader', async () => {
  const BVHLoader = await importBVHLoader();
  const loader = new BVHLoader();
  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    const abs = path.join(C_TAIBAI_DIR, name);
    requireDeliverableFile(abs, 'F1');
    const text = fs.readFileSync(abs, 'utf8');
    const bvh = analyzeBVHFile(abs, 'F1');
    assert.equal(bvh.joints.length, 21);

    const parsed = loader.parse(text);
    const nonEndBones = parsed.skeleton.bones.filter((b) => b.name !== 'ENDSITE');
    assert.equal(parsed.skeleton.bones.length, 26, `${name}: expected 21 joints + 5 ENDSITE = 26`);
    assert.equal(nonEndBones.length, 21, `${name}: expected 21 non-ENDSITE bones`);
  }
});

test('[T1][F1][T1-F1-03] taibai_01b cliff sword-ready stance exhibits grounded feet, cyclic loop closure & combat arm guard', () => {
  const abs = path.join(C_TAIBAI_DIR, 'taibai_01b_崖顶横剑定势_cleaned.bvh');
  const bvh = analyzeBVHFile(abs, 'F1');
  assert.ok(
    bvh.durationSec >= 0.8 && bvh.durationSec <= 1.35,
    `Expected duration in [0.80, 1.35]s, got ${bvh.durationSec.toFixed(3)}s`
  );
  const hipsY = bvh.worldTraj.Hips.map((p) => p.y);
  const minHipsY = Math.min(...hipsY);
  const maxHipsY = Math.max(...hipsY);
  assert.ok(minHipsY >= 62.0 && maxHipsY <= 115.0, `Hips.Y out of upright range: [${minHipsY}, ${maxHipsY}]`);

  const minLFootY = Math.min(...bvh.worldTraj.LeftFoot.map((p) => p.y));
  const minRFootY = Math.min(...bvh.worldTraj.RightFoot.map((p) => p.y));
  assert.ok(minLFootY >= 5.5 && minLFootY <= 13.5, `LeftFoot min Y=${minLFootY}`);
  assert.ok(minRFootY >= 5.5 && minRFootY <= 13.5, `RightFoot min Y=${minRFootY}`);

  assert.ok(bvh.seam.seamPosXZ <= 5.0, `seamPosXZ=${bvh.seam.seamPosXZ} > 5.0cm`);
  assert.ok(bvh.seam.seamPosY <= 5.0, `seamPosY=${bvh.seam.seamPosY} > 5.0cm`);
  assert.ok(bvh.seam.maxUpperSeamDeg <= 8.0, `maxUpperSeamDeg=${bvh.seam.maxUpperSeamDeg} > 8.0°`);

  // Non-T-pose arm guard check: at least one arm joint deviates >= 15 deg from identity on frame 0
  const idQ = bvh.perFrameQuats[0][0].clone().identity();
  const armJointIndices = [6, 7, 10, 11]; // LUpperArm, LForeArm, RUpperArm, RForeArm
  let maxArmDevDeg = 0;
  for (const jIdx of armJointIndices) {
    const q = bvh.perFrameQuats[0][jIdx];
    const deg = 2 * Math.acos(Math.min(1, Math.abs(q.dot(idQ)))) * (180 / Math.PI);
    maxArmDevDeg = Math.max(maxArmDevDeg, deg);
  }
  assert.ok(maxArmDevDeg >= 15.0, `Expected non-T-pose combat arm posture >= 15°, got ${maxArmDevDeg.toFixed(2)}°`);
});

test('[T1][F1][T1-F1-04] taibai_02 Wuhen Jianyi exhibits single-leg knee lift, planted support foot & 6-DoF wrist roll', () => {
  const abs = path.join(C_TAIBAI_DIR, 'taibai_02_无痕剑意_独立提膝云剑_cleaned.bvh');
  const bvh = analyzeBVHFile(abs, 'F1');
  assert.ok(
    bvh.durationSec >= 2.7 && bvh.durationSec <= 3.55,
    `Expected duration in [2.70, 3.55]s, got ${bvh.durationSec.toFixed(3)}s`
  );

  let kneeLiftFrames = 0;
  for (let f = 0; f < bvh.declaredFrames; f++) {
    const ly = bvh.worldTraj.LeftFoot[f].y;
    const ry = bvh.worldTraj.RightFoot[f].y;
    const supportY = Math.min(ly, ry);
    if (Math.abs(ly - ry) >= 15.0 && supportY >= 5.5 && supportY <= 15.5) {
      kneeLiftFrames++;
    }
  }
  const minRequired = Math.ceil(0.3 * bvh.fps);
  assert.ok(
    kneeLiftFrames >= minRequired,
    `Expected >= ${minRequired} single-leg knee-lift frames, got ${kneeLiftFrames}`
  );

  const rHandStdNorm = Math.hypot(...bvh.jointRotStds.RightHand);
  assert.ok(rHandStdNorm >= 4.5, `Expected 6-DoF RightHand rotational std >= 4.5°, got ${rHandStdNorm.toFixed(2)}°`);
});

test('[T1][F1][T1-F1-05] taibai_03 Yuluo Yunfei preserves full ~5.125s duration and multi-slash sword trajectory', () => {
  const abs = path.join(C_TAIBAI_DIR, 'taibai_03_雨落云飞_快剑五连斩_cleaned.bvh');
  const bvh = analyzeBVHFile(abs, 'F1');
  assert.ok(
    bvh.durationSec >= 4.8 && bvh.durationSec <= 5.6,
    `Expected full un-truncated ~5.125s duration in [4.80, 5.60]s, got ${bvh.durationSec.toFixed(3)}s`
  );

  let handPathCm = 0;
  let tipPathCm = 0;
  const tipSpeeds = [];
  for (let f = 1; f < bvh.declaredFrames; f++) {
    handPathCm += bvh.worldTraj.RightHand[f].distanceTo(bvh.worldTraj.RightHand[f - 1]);
    const tipStep = bvh.worldTraj.SwordTip[f].distanceTo(bvh.worldTraj.SwordTip[f - 1]);
    tipPathCm += tipStep;
    tipSpeeds.push(tipStep * bvh.fps);
  }
  assert.ok(handPathCm >= 250.0, `Expected RightHand path >= 250cm, got ${handPathCm.toFixed(1)}cm`);
  assert.ok(tipPathCm >= 450.0, `Expected SwordTip path >= 450cm, got ${tipPathCm.toFixed(1)}cm`);

  // Count local speed peaks separated by >= 0.25s
  const minGap = Math.max(2, Math.round(0.22 * bvh.fps));
  const meanSpd = tipSpeeds.reduce((a, b) => a + b, 0) / tipSpeeds.length;
  const peakIndices = [];
  for (let i = 1; i < tipSpeeds.length - 1; i++) {
    if (tipSpeeds[i] > meanSpd * 0.9 && tipSpeeds[i] >= tipSpeeds[i - 1] && tipSpeeds[i] >= tipSpeeds[i + 1]) {
      if (peakIndices.length === 0 || i - peakIndices[peakIndices.length - 1] >= minGap) {
        peakIndices.push(i);
      }
    }
  }
  assert.ok(peakIndices.length >= 3, `Expected >= 3 slash speed peaks, got ${peakIndices.length}`);

  const minFootY = Math.min(
    ...bvh.worldTraj.LeftFoot.map((p) => p.y),
    ...bvh.worldTraj.RightFoot.map((p) => p.y)
  );
  assert.ok(minFootY >= 5.0, `Ankle penetrated floor: minFootY=${minFootY.toFixed(2)}cm`);
});

test('[T1][F1][T1-F1-06] taibai_04 Feiyan Zhuyue exhibits aerial whirlwind jump apex and safe split landing', () => {
  const abs = path.join(C_TAIBAI_DIR, 'taibai_04_飞燕逐月_腾空旋风跌叉_cleaned.bvh');
  const bvh = analyzeBVHFile(abs, 'F1');
  assert.ok(
    bvh.durationSec >= 1.45 && bvh.durationSec <= 2.2,
    `Expected duration in [1.45, 2.20]s, got ${bvh.durationSec.toFixed(3)}s`
  );

  const hipsY = bvh.worldTraj.Hips.map((p) => p.y);
  const minHipsY = Math.min(...hipsY);
  const maxHipsY = Math.max(...hipsY);
  assert.ok(maxHipsY >= 92.0, `Expected aerial peak Hips.Y >= 92cm, got ${maxHipsY.toFixed(1)}cm`);
  assert.ok(
    maxHipsY - minHipsY >= 22.0,
    `Expected aerial-to-split Hips.Y excursion >= 22cm, got ${(maxHipsY - minHipsY).toFixed(1)}cm`
  );
  assert.ok(minHipsY >= 12.0, `Pelvis sank below floor during split: minHipsY=${minHipsY.toFixed(1)}cm`);

  const maxFootY = Math.max(
    ...bvh.worldTraj.LeftFoot.map((p) => p.y),
    ...bvh.worldTraj.RightFoot.map((p) => p.y)
  );
  assert.ok(maxFootY >= 32.0, `Expected aerial kick foot height >= 32cm, got ${maxFootY.toFixed(1)}cm`);
});

test('[T1][F1][T1-F1-07] MANIFEST.json registers all 4 Taibai clips with accurate cyclic/weapon/header metadata', () => {
  const manifest = loadAndNormalizeManifest();
  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    const abs = path.join(C_TAIBAI_DIR, name);
    const bvh = analyzeBVHFile(abs, 'F1');
    const entry = manifest.find((e) => resolveManifestEntryPath(e.path) === abs);
    assert.ok(entry, `[MANIFEST] Missing entry for ${name}`);
    assert.equal(entry.hasWeapon, true, `[MANIFEST] ${name} must have hasWeapon === true`);
    const expectedCyclic = name.startsWith('taibai_01b');
    assert.equal(entry.cyclic, expectedCyclic, `[MANIFEST] ${name} cyclic mismatch`);
    assert.equal(entry.frames, bvh.declaredFrames, `[MANIFEST] ${name} frames mismatch`);
    assert.ok(Math.abs(entry.fps - bvh.fps) <= 1, `[MANIFEST] ${name} fps mismatch`);
    assert.ok(Math.abs(entry.durationSec - bvh.durationSec) <= 0.06, `[MANIFEST] ${name} durationSec mismatch`);
  }
});

// ============================================================================
// Feature F2: Google Drive 02/C Sync & Master Video Fetch (7 Happy-Path Tests)
// ============================================================================

test('[T1][F2][T1-F2-01] Master video 05 exists locally and matches exact Google Drive byte size (28,448,640 B)', () => {
  const spec05 = REFERENCE_VIDEO_SPECS.find((s) => s.key === '05');
  const abs05 = path.join(REF_VIDEOS_DIR, spec05.file);
  const stat = requireDeliverableFile(abs05, 'F2');
  const driveInfo = gdriveJson(['readonly', 'info', DRIVE_FILE_05_MASTER]);
  assert.equal(stat.size, spec05.bytes, `Expected local 05 size=${spec05.bytes}, got ${stat.size}`);
  assert.equal(stat.size, Number(driveInfo.size), 'Local 05 video size must match Google Drive file size');
});

test('[T1][F2][T1-F2-02] Master video 05 passes ffprobe H.264 1280x720 29.97fps ~75.926s specification', () => {
  const spec05 = REFERENCE_VIDEO_SPECS.find((s) => s.key === '05');
  const abs05 = path.join(REF_VIDEOS_DIR, spec05.file);
  requireDeliverableFile(abs05, 'F2');
  const info = ffprobeVideo(abs05);
  const stream = info.streams?.[0];
  assert.ok(stream, 'ffprobe returned no video stream for 05');
  assert.equal(stream.codec_name, 'h264');
  assert.equal(stream.width, 1280);
  assert.equal(stream.height, 720);
  assert.equal(stream.pix_fmt, 'yuv420p');
  assert.equal(stream.r_frame_rate, '2997/100');
  assert.ok(Number(stream.nb_frames) >= 2240, `Expected >= 2240 frames, got ${stream.nb_frames}`);
  const dur = Number(info.format?.duration);
  assert.ok(dur >= 75.8 && dur <= 76.05, `Expected duration in [75.80, 76.05]s, got ${dur}`);
});

test('[T1][F2][T1-F2-03] Complete 5-video local reference suite (01b, 02, 03, 04, 05) decodes cleanly via ffprobe', () => {
  for (const spec of REFERENCE_VIDEO_SPECS) {
    const abs = path.join(REF_VIDEOS_DIR, spec.file);
    requireDeliverableFile(abs, 'F2');
    const info = ffprobeVideo(abs);
    const stream = info.streams?.[0];
    assert.ok(stream, `Missing video stream in ${spec.file}`);
    assert.equal(stream.codec_name, 'h264', `${spec.file} codec`);
    assert.equal(stream.width, spec.width, `${spec.file} width`);
    assert.equal(stream.height, spec.height, `${spec.file} height`);
    const dur = Number(info.format?.duration);
    assert.ok(
      dur >= spec.durationMin && dur <= spec.durationMax,
      `${spec.file} duration ${dur} outside [${spec.durationMin}, ${spec.durationMax}]`
    );
  }
});

test('[T1][F2][T1-F2-04] Google Drive 02/C (1xxXXnYg3GVk9zAKrQMSuIPG8JjjESu0v) lists all 4 Taibai BVH files', () => {
  const items = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_02C_TAIBAI]);
  assert.ok(Array.isArray(items), 'Expected JSON array from gdrive readonly ls');
  const byName = new Map(items.map((it) => [it.name, it]));
  for (const expectedName of TAIBAI_EXPECTED_FILENAMES) {
    const item = byName.get(expectedName);
    assert.ok(item, `[F2] Missing "${expectedName}" in Google Drive 02/C`);
    assert.ok(typeof item.id === 'string' && item.id.length > 5, `[F2] Invalid Drive file id for ${expectedName}`);
    assert.ok(!Number.isNaN(Date.parse(item.modifiedTime)), `[F2] Invalid modifiedTime for ${expectedName}`);
  }
});

test('[T1][F2][T1-F2-05] Google Drive 02/C Taibai BVH files have non-zero size matching local C_taibai_extracted/', () => {
  const items = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_02C_TAIBAI]);
  const byName = new Map(items.map((it) => [it.name, it]));
  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    const localAbs = path.join(C_TAIBAI_DIR, name);
    const localStat = requireDeliverableFile(localAbs, 'F2');
    const driveItem = byName.get(name);
    assert.ok(driveItem, `[F2] Missing ${name} on Drive 02/C`);
    const driveSize = Number(driveItem.size);
    assert.ok(Number.isInteger(driveSize) && driveSize >= 8000, `[F2] Drive ${name} size=${driveItem.size} < 8000`);
    assert.equal(driveSize, localStat.size, `[F2] Drive size (${driveSize}) != local size (${localStat.size}) for ${name}`);
  }
});

test('[T1][F2][T1-F2-06] Ephemeral readonly download from Drive 02/C is SHA-256 bit-identical to local Taibai BVHs', async () => {
  const items = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_02C_TAIBAI]);
  const byName = new Map(items.map((it) => [it.name, it]));
  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    requireDeliverableFile(path.join(C_TAIBAI_DIR, name), 'F2');
    assert.ok(byName.has(name), `[F2] Drive 02/C missing ${name}`);
  }

  await withEphemeralShmDir('e2e_gdrive', async (shmDir) => {
    for (const name of TAIBAI_EXPECTED_FILENAMES) {
      const localAbs = path.join(C_TAIBAI_DIR, name);
      const dlAbs = path.join(shmDir, name);
      gdriveDownloadReadonly(byName.get(name).id, dlAbs);
      assert.equal(
        sha256File(dlAbs),
        sha256File(localAbs),
        `[F2] SHA-256 mismatch between Drive 02/C and local ${name}`
      );
      const parsed = parseAndAnalyzeStandardBVH(fs.readFileSync(dlAbs, 'utf8'), `Drive:${name}`);
      assert.equal(parsed.joints.length, 21);
    }
  });
});

test('[T1][F2][T1-F2-07] MANIFEST.json Taibai driveFileId fields match live Google Drive 02/C file IDs', () => {
  const manifest = loadAndNormalizeManifest();
  const driveItems = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_02C_TAIBAI]);
  const driveByName = new Map(driveItems.map((it) => [it.name, it]));

  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    const abs = path.join(C_TAIBAI_DIR, name);
    const entry = manifest.find((e) => resolveManifestEntryPath(e.path) === abs);
    assert.ok(entry, `[MANIFEST] Missing entry for ${name}`);
    const driveItem = driveByName.get(name);
    assert.ok(driveItem, `[F2] Missing ${name} in Drive 02/C`);
    if (entry.driveFileId !== undefined && entry.driveFileId !== null && entry.driveFileId !== '') {
      assert.equal(
        entry.driveFileId,
        driveItem.id,
        `[MANIFEST] driveFileId mismatch for ${name}: ${entry.driveFileId} vs ${driveItem.id}`
      );
    }
  }
});

// ============================================================================
// Feature F3: MVP Locomotion & Dodge BVH Expansion (7 Happy-Path Tests)
// ============================================================================

test('[T1][F3][T1-F3-01] B_cleaned_ready/ contains all 11 canonical F3 locomotion & dodge BVH files', () => {
  for (const name of F3_EXPECTED_FILENAMES) {
    const abs = path.join(B_CLEANED_DIR, name);
    const stat = requireDeliverableFile(abs, 'F3');
    assert.ok(stat.size >= 8000, `[F3] Expected ${name} >= 8000 bytes, got ${stat.size}`);
  }
});

test('[T1][F3][T1-F3-02] All 11 F3 BVH files pass 21-bone 60fps (Frame Time 0.016667) structural & numeric validation', () => {
  for (const name of F3_EXPECTED_FILENAMES) {
    const abs = path.join(B_CLEANED_DIR, name);
    const bvh = analyzeBVHFile(abs, 'F3');
    assert.ok(
      Math.abs(bvh.frameTime - 1 / 60) <= 2e-5,
      `[F3] ${name} expected 60fps (0.016667), got ${bvh.frameTime}`
    );
    assert.equal(bvh.fps, 60);
    assert.ok(bvh.declaredFrames >= 24, `[F3] ${name} expected >= 24 frames, got ${bvh.declaredFrames}`);
  }
});

test('[T1][F3][T1-F3-03] 8-way strafe suite (07_wuxia_strafe_{F,B,L,R,FL,FR,BL,BR}) maintains grounded cyclic gait', () => {
  for (const name of F3_STRAFE_FILENAMES) {
    const abs = path.join(B_CLEANED_DIR, name);
    const bvh = analyzeBVHFile(abs, 'F3');
    const hipsY = bvh.worldTraj.Hips.map((p) => p.y);
    assert.ok(Math.min(...hipsY) >= 55.0 && Math.max(...hipsY) <= 115.0, `${name} Hips.Y out of bounds`);

    const minFootY = Math.min(
      ...bvh.worldTraj.LeftFoot.map((p) => p.y),
      ...bvh.worldTraj.RightFoot.map((p) => p.y)
    );
    assert.ok(minFootY >= 5.5 && minFootY <= 12.5, `${name} stance minFootY=${minFootY.toFixed(2)}cm`);
    assert.ok(bvh.seam.seamPosY <= 5.0, `${name} vertical seam=${bvh.seam.seamPosY.toFixed(2)}cm > 5cm`);
    assert.ok(bvh.seam.maxUpperSeamDeg <= 8.0, `${name} upper seam=${bvh.seam.maxUpperSeamDeg.toFixed(2)}° > 8°`);
    assert.ok(bvh.seam.maxLegSeamDeg <= 28.0, `${name} leg seam=${bvh.seam.maxLegSeamDeg.toFixed(2)}° > 28°`);

    const legStd = Math.max(
      Math.hypot(...bvh.jointRotStds.LeftUpLeg),
      Math.hypot(...bvh.jointRotStds.RightUpLeg)
    );
    assert.ok(legStd >= 4.0, `${name} insufficient leg stepping std=${legStd.toFixed(2)}°`);
  }
});

test('[T1][F3][T1-F3-04] 08_wuxia_dash_canglong preserves forward +Z Root Motion burst & sword thrust extension', () => {
  const abs = path.join(B_CLEANED_DIR, '08_wuxia_dash_canglong_苍龙出水突刺_cleaned.bvh');
  const bvh = analyzeBVHFile(abs, 'F3');
  const N = bvh.declaredFrames;
  const hips0 = bvh.worldTraj.Hips[0];
  const hipsEnd = bvh.worldTraj.Hips[N - 1];
  const maxZ = Math.max(...bvh.worldTraj.Hips.map((p) => p.z));

  assert.ok(Math.abs(hips0.x) <= 15.0 && Math.abs(hips0.z) <= 15.0, `Frame 0 not origin-anchored: (${hips0.x}, ${hips0.z})`);
  const dz = hipsEnd.z - hips0.z;
  assert.ok(dz >= 80.0, `Expected forward Root Motion ΔZ >= +80cm, got ${dz.toFixed(1)}cm`);
  assert.ok(hipsEnd.z >= 0.7 * maxZ, `Loop-clean snap-back detected: endZ=${hipsEnd.z.toFixed(1)} vs maxZ=${maxZ.toFixed(1)}`);

  let maxHandReachZ = -Infinity;
  for (let f = 0; f < N; f++) {
    maxHandReachZ = Math.max(maxHandReachZ, bvh.worldTraj.RightHand[f].z - bvh.worldTraj.Hips[f].z);
  }
  assert.ok(maxHandReachZ >= 32.0, `Expected forward sword thrust RightHand-Hips Z >= 32cm, got ${maxHandReachZ.toFixed(1)}cm`);
});

test('[T1][F3][T1-F3-05] 09_wuxia_dodge_roll preserves forward +Z Root Motion, mid-roll inversion & upright recovery', () => {
  const abs = path.join(B_CLEANED_DIR, '09_wuxia_dodge_roll_翻滚闪避_cleaned.bvh');
  const bvh = analyzeBVHFile(abs, 'F3');
  const N = bvh.declaredFrames;
  const dz = bvh.worldTraj.Hips[N - 1].z - bvh.worldTraj.Hips[0].z;
  assert.ok(dz >= 60.0, `Expected forward roll ΔZ >= +60cm, got ${dz.toFixed(1)}cm`);

  const hipsY = bvh.worldTraj.Hips.map((p) => p.y);
  const minHipsY = Math.min(...hipsY);
  assert.ok(minHipsY <= 68.0 && minHipsY >= 8.0, `Expected mid-roll Hips.Y in [8, 68]cm, got ${minHipsY.toFixed(1)}cm`);
  assert.ok(Math.min(...bvh.worldTraj.hipsUpY) <= 0.35, 'Expected mid-roll pelvis tilt/inversion hipsUpY <= 0.35');
  assert.ok(hipsY[N - 1] >= 65.0, `Expected upright recovery Hips.Y[N-1] >= 65cm, got ${hipsY[N - 1].toFixed(1)}cm`);
  assert.ok(bvh.worldTraj.hipsUpY[N - 1] >= 0.65, `Expected upright recovery hipsUpY[N-1] >= 0.65`);
});

test('[T1][F3][T1-F3-06] 10_wuxia_double_jump exhibits airborne vertical apex, dual-foot flight window & clean landing', () => {
  const abs = path.join(B_CLEANED_DIR, '10_wuxia_double_jump_二段轻功跳_cleaned.bvh');
  const bvh = analyzeBVHFile(abs, 'F3');
  const N = bvh.declaredFrames;
  const hipsY = bvh.worldTraj.Hips.map((p) => p.y);
  const maxHipsY = Math.max(...hipsY);

  assert.ok(maxHipsY >= 115.0, `Expected jump apex Hips.Y >= 115cm, got ${maxHipsY.toFixed(1)}cm`);
  assert.ok(maxHipsY - hipsY[0] >= 25.0, `Expected Hips.Y rise >= 25cm, got ${(maxHipsY - hipsY[0]).toFixed(1)}cm`);

  let maxAirRun = 0;
  let curAirRun = 0;
  for (let f = 0; f < N; f++) {
    const minAnkle = Math.min(bvh.worldTraj.LeftFoot[f].y, bvh.worldTraj.RightFoot[f].y);
    if (minAnkle >= 22.0) {
      curAirRun++;
      maxAirRun = Math.max(maxAirRun, curAirRun);
    } else {
      curAirRun = 0;
    }
  }
  assert.ok(maxAirRun >= 5, `Expected >= 5 consecutive dual-foot airborne frames, got ${maxAirRun}`);

  const endMinFootY = Math.min(bvh.worldTraj.LeftFoot[N - 1].y, bvh.worldTraj.RightFoot[N - 1].y);
  assert.ok(endMinFootY >= 5.5 && endMinFootY <= 14.5, `Expected grounded landing foot Y in [5.5, 14.5]cm, got ${endMinFootY.toFixed(1)}cm`);
});

test('[T1][F3][T1-F3-07] A_raw_mocap/ archives real CMU optical mocap provenance files & MANIFEST.json matches F3', async () => {
  const rawFiles = fs.existsSync(RAW_MOCAP_DIR)
    ? fs.readdirSync(RAW_MOCAP_DIR).filter((f) => /^cmu_.*\.bvh$/i.test(f))
    : [];
  assert.ok(
    rawFiles.length > 1,
    `[F3] Expected newly archived cmu_*.bvh provenance files in A_raw_mocap/ beyond baseline cmu_87_01, found: [${rawFiles.join(', ')}]`
  );
  for (const rf of rawFiles) {
    const summary = await parseGenericBVHSummary(fs.readFileSync(path.join(RAW_MOCAP_DIR, rf), 'utf8'), rf);
    assert.ok(summary.frames >= 60, `[F3] Raw CMU file ${rf} expected >= 60 frames, got ${summary.frames}`);
    assert.ok(summary.boneCount >= 21, `[F3] Raw CMU file ${rf} expected >= 21 bones, got ${summary.boneCount}`);
  }

  const manifest = loadAndNormalizeManifest();
  for (const name of F3_EXPECTED_FILENAMES) {
    const abs = path.join(B_CLEANED_DIR, name);
    const bvh = analyzeBVHFile(abs, 'F3');
    const entry = manifest.find((e) => resolveManifestEntryPath(e.path) === abs);
    assert.ok(entry, `[MANIFEST] Missing entry for ${name}`);
    const isStrafe = name.startsWith('07_');
    assert.equal(entry.cyclic, isStrafe, `[MANIFEST] ${name} cyclic mismatch`);
    if (name.startsWith('08_') || name.startsWith('09_')) {
      assert.equal(entry.preserveRootMotion, true, `[MANIFEST] ${name} must have preserveRootMotion === true`);
    }
    assert.equal(entry.frames, bvh.declaredFrames);
    const provStr =
      typeof entry.sourceProvenance === 'string'
        ? entry.sourceProvenance
        : JSON.stringify(entry.sourceProvenance || '');
    assert.ok(provStr.length > 2, `Missing sourceProvenance on ${name}`);
  }
});

// ============================================================================
// Feature F4: MVP Hit-React & Kip-Up BVH Expansion (7 Happy-Path Tests)
// ============================================================================

test('[T1][F4][T1-F4-01] B_cleaned_ready/ contains all 5 canonical F4 hit-react & kip-up BVH files', () => {
  for (const name of F4_EXPECTED_FILENAMES) {
    const abs = path.join(B_CLEANED_DIR, name);
    const stat = requireDeliverableFile(abs, 'F4');
    assert.ok(stat.size >= 8000, `[F4] Expected ${name} >= 8000 bytes, got ${stat.size}`);
  }
});

test('[T1][F4][T1-F4-02] All 5 F4 BVH files pass 21-bone 60fps (Frame Time 0.016667) structural & numeric validation', () => {
  for (const name of F4_EXPECTED_FILENAMES) {
    const abs = path.join(B_CLEANED_DIR, name);
    const bvh = analyzeBVHFile(abs, 'F4');
    assert.ok(Math.abs(bvh.frameTime - 1 / 60) <= 2e-5, `[F4] ${name} expected 60fps`);
    assert.equal(bvh.fps, 60);
    assert.ok(bvh.declaredFrames >= 18);
  }
});

test('[T1][F4][T1-F4-03] 11_hit_light_L and 12_hit_light_R exhibit snappy torso recoil and upright guard recovery', () => {
  for (const name of [
    '11_wuxia_hit_light_L_左轻受击_cleaned.bvh',
    '12_wuxia_hit_light_R_右轻受击_cleaned.bvh',
  ]) {
    const abs = path.join(B_CLEANED_DIR, name);
    const bvh = analyzeBVHFile(abs, 'F4');
    assert.ok(bvh.durationSec >= 0.3 && bvh.durationSec <= 2.2, `${name} duration=${bvh.durationSec}s`);
    assert.ok(Math.min(...bvh.worldTraj.Hips.map((p) => p.y)) >= 55.0, `${name} dropped below standing height`);
    assert.ok(Math.min(...bvh.worldTraj.hipsUpY) >= 0.55, `${name} lost upright orientation`);

    // Measure max upper-torso excursion relative to frame 0 across Spine/Chest/Head
    let maxTorsoDeg = 0;
    for (let f = 1; f < bvh.declaredFrames; f++) {
      for (const jIdx of [1, 2, 4]) {
        const dot = Math.min(1, Math.abs(bvh.perFrameQuats[f][jIdx].dot(bvh.perFrameQuats[0][jIdx])));
        maxTorsoDeg = Math.max(maxTorsoDeg, 2 * Math.acos(dot) * (180 / Math.PI));
      }
    }
    assert.ok(maxTorsoDeg >= 8.0, `${name} expected torso recoil >= 8°, got ${maxTorsoDeg.toFixed(2)}°`);
  }
});

test('[T1][F4][T1-F4-04] 13_wuxia_knockdown transitions cleanly from upright standing to supine floor impact', () => {
  const abs = path.join(B_CLEANED_DIR, '13_wuxia_knockdown_击飞倒地_cleaned.bvh');
  const bvh = analyzeBVHFile(abs, 'F4');
  const N = bvh.declaredFrames;
  const hipsY = bvh.worldTraj.Hips.map((p) => p.y);
  const minHipsY = Math.min(...hipsY);

  assert.ok(hipsY[0] >= 68.0 && bvh.worldTraj.hipsUpY[0] >= 0.7, 'Knockdown must start upright');
  assert.ok(minHipsY <= 45.0, `Expected supine floor impact min(Hips.Y) <= 45cm, got ${minHipsY.toFixed(1)}cm`);
  assert.ok(hipsY[N - 1] <= 48.0, `Expected supine end Hips.Y[N-1] <= 48cm, got ${hipsY[N - 1].toFixed(1)}cm`);
  assert.ok(Math.min(...bvh.worldTraj.hipsUpY) <= 0.5, 'Expected supine tilt hipsUpY <= 0.50');
  assert.ok(minHipsY >= 6.0, `Pelvis penetrated floor: minHipsY=${minHipsY.toFixed(1)}cm`);
});

test('[T1][F4][T1-F4-05] 14_wuxia_kipup launches from supine floor state to grounded upright combat stance', () => {
  const abs = path.join(B_CLEANED_DIR, '14_wuxia_kipup_鲤鱼打挺起身_cleaned.bvh');
  const bvh = analyzeBVHFile(abs, 'F4');
  const N = bvh.declaredFrames;
  const hipsY = bvh.worldTraj.Hips.map((p) => p.y);

  assert.ok(hipsY[0] <= 48.0 && bvh.worldTraj.hipsUpY[0] <= 0.55, 'Kip-up must start low/supine');
  assert.ok(Math.min(...hipsY) >= 6.0, 'Pelvis penetrated floor');
  assert.ok(hipsY[N - 1] >= 68.0 && bvh.worldTraj.hipsUpY[N - 1] >= 0.7, 'Kip-up must finish standing upright');
  assert.ok(
    bvh.worldTraj.LeftFoot[N - 1].y >= 5.5 && bvh.worldTraj.LeftFoot[N - 1].y <= 14.5,
    `LeftFoot final Y=${bvh.worldTraj.LeftFoot[N - 1].y}`
  );
  assert.ok(
    bvh.worldTraj.RightFoot[N - 1].y >= 5.5 && bvh.worldTraj.RightFoot[N - 1].y <= 14.5,
    `RightFoot final Y=${bvh.worldTraj.RightFoot[N - 1].y}`
  );
});

test('[T1][F4][T1-F4-06] 15_wuxia_knockdown_kipup executes full upright -> supine floor valley -> kip-up standing arc', () => {
  const bvh13 = analyzeBVHFile(path.join(B_CLEANED_DIR, '13_wuxia_knockdown_击飞倒地_cleaned.bvh'), 'F4');
  const bvh14 = analyzeBVHFile(path.join(B_CLEANED_DIR, '14_wuxia_kipup_鲤鱼打挺起身_cleaned.bvh'), 'F4');
  const bvh15 = analyzeBVHFile(
    path.join(B_CLEANED_DIR, '15_wuxia_knockdown_kipup_击飞倒地接鲤鱼打挺_cleaned.bvh'),
    'F4'
  );
  const N = bvh15.declaredFrames;
  const hipsY = bvh15.worldTraj.Hips.map((p) => p.y);
  const minHipsY = Math.min(...hipsY);
  const fMin = hipsY.indexOf(minHipsY);

  assert.ok(hipsY[0] >= 68.0 && bvh15.worldTraj.hipsUpY[0] >= 0.7, '15 must start upright');
  assert.ok(minHipsY <= 45.0 && minHipsY >= 6.0, `15 supine valley minHipsY=${minHipsY.toFixed(1)}cm`);
  assert.ok(fMin / N >= 0.1 && fMin / N <= 0.9, `15 valley index ratio=${(fMin / N).toFixed(2)} not interior`);
  assert.ok(Math.min(...bvh15.worldTraj.hipsUpY) <= 0.5, '15 must reach supine orientation');
  assert.ok(hipsY[N - 1] >= 68.0 && bvh15.worldTraj.hipsUpY[N - 1] >= 0.7, '15 must end standing upright');
  assert.ok(
    bvh15.durationSec >= Math.max(bvh13.durationSec, bvh14.durationSec),
    '15 combined clip must be at least as long as 13 and 14 individually'
  );
});

test('[T1][F4][T1-F4-07] Complete 26-clip MANIFEST.json inventory & F4 metadata parity', () => {
  const manifest = loadAndNormalizeManifest();
  assert.equal(manifest.length, 26, `Expected exactly 26 clips in MANIFEST.json, got ${manifest.length}`);

  for (const name of F4_EXPECTED_FILENAMES) {
    const abs = path.join(B_CLEANED_DIR, name);
    const bvh = analyzeBVHFile(abs, 'F4');
    const entry = manifest.find((e) => resolveManifestEntryPath(e.path) === abs);
    assert.ok(entry, `[MANIFEST] Missing entry for ${name}`);
    assert.equal(entry.cyclic, false, `[MANIFEST] ${name} must have cyclic === false`);
    assert.ok(
      typeof entry.archetype === 'string' && /(Hit_Light|Hit_Knockdown|KipUp)/i.test(entry.archetype),
      `[MANIFEST] Unexpected archetype "${entry.archetype}" on ${name}`
    );
    assert.equal(entry.frames, bvh.declaredFrames);
    assert.ok(Math.abs(entry.durationSec - bvh.durationSec) <= 0.06);
  }
});
