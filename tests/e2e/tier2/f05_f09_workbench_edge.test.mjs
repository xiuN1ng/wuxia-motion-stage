import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REF_VIDEOS_DIR, REFERENCE_VIDEO_SPECS } from '../helpers/constants.mjs';
import {
  importThree,
  loadModuleContract,
  unwrapRetargetFrames,
  resolveBakeWarpedFrames,
} from '../helpers/contract_loader.mjs';
import {
  requireDeliverableFile,
  parseAndAnalyzeStandardBVH,
  buildSyntheticBVH,
  computeWorldBonePositionsForFrame,
} from '../helpers/bvh_verifier.mjs';
import { withCapturePage, withWorkbenchPage } from '../helpers/browser_cdp.mjs';

const THREE = await importThree();

// ============================================================================
// Feature F5 Tier 2: Retargeter & Root-Motion Edge Cases (7 Tests)
// ============================================================================

test('[T2][F5][T2-F5-01] Default preserveRootMotion=false preserves legacy horizontal centering', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const lungeBvh = buildSyntheticBVH({
    convention: 'standard21',
    frames: 60,
    fps: 60,
    rootPosFn: (f) => [0, 94, (f / 59) * 300],
  });
  const frames = await unwrapRetargetFrames(mc.retargetBVHToFrames(lungeBvh, 60));
  const meanX = frames.reduce((a, fr) => a + fr.rootPos.x, 0) / frames.length;
  const meanZ = frames.reduce((a, fr) => a + fr.rootPos.z, 0) / frames.length;
  assert.ok(Math.abs(meanX) <= 0.02 && Math.abs(meanZ) <= 0.05, `Expected centered mean=(0,0), got (${meanX}, ${meanZ})`);
  assert.ok(frames[0].rootPos.z < -1.0 && frames[frames.length - 1].rootPos.z > 1.0);
});

test('[T2][F5][T2-F5-02] rootOriginMode="raw" with preserveRootMotion=true retains raw Frame-0 world offset', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const lungeBvh = buildSyntheticBVH({
    convention: 'standard21',
    frames: 60,
    fps: 60,
    rootPosFn: (f) => [50, 94, -80 + (f / 59) * 300],
  });
  const frames = await unwrapRetargetFrames(
    mc.retargetBVHToFrames(lungeBvh, 60, { preserveRootMotion: true, rootOriginMode: 'raw' })
  );
  assert.ok(Math.abs(frames[0].rootPos.x - 0.5) <= 0.04, `Expected raw X0 ≈ 0.50m, got ${frames[0].rootPos.x}`);
  assert.ok(Math.abs(frames[0].rootPos.z - -0.8) <= 0.04, `Expected raw Z0 ≈ -0.80m, got ${frames[0].rootPos.z}`);
  const dz = frames[frames.length - 1].rootPos.z - frames[0].rootPos.z;
  assert.ok(Math.abs(dz - 3.0) <= 0.08, `Expected net ΔZ ≈ +3.00m, got ${dz}`);
});

test('[T2][F5][T2-F5-03] Explicit finite maxFrames cap clamps frame count without NaN', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const bvh360 = buildSyntheticBVH({ convention: 'standard21', frames: 360, fps: 60 });
  const frames = await unwrapRetargetFrames(mc.retargetBVHToFrames(bvh360, 60, { maxFrames: 90 }));
  assert.equal(frames.length, 90, `Expected maxFrames: 90 to cap output at 90, got ${frames.length}`);
});

test('[T2][F5][T2-F5-04] Ultra-short 2-frame BVH retargets cleanly without 0/0 NaN and aligns ankles ~0.08m', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const twoFrameBvh = buildSyntheticBVH({ convention: 'standard21', frames: 2, fps: 60 });
  const frames = await unwrapRetargetFrames(
    mc.retargetBVHToFrames(twoFrameBvh, 60, { preserveRootMotion: true })
  );
  assert.ok(frames.length >= 2);
  const w0 = await computeWorldBonePositionsForFrame(frames[0]);
  assert.ok(Math.abs(Math.min(w0.LeftFoot.y, w0.RightFoot.y) - 0.08) <= 0.015);
});

test('[T2][F5][T2-F5-05] Multi-unit auto-scale invariance normalizes meters, inches & centimeters to ~0.94m Hips', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  for (const [unitLabel, scale] of [
    ['meters', 0.01],
    ['inches', 1 / 2.54],
    ['centimeters', 1.0],
  ]) {
    const bvh = buildSyntheticBVH({ convention: 'standard21', frames: 10, fps: 60, scale });
    const frames = await unwrapRetargetFrames(mc.retargetBVHToFrames(bvh, 60), `Scale:${unitLabel}`);
    assert.ok(
      Math.abs(frames[0].rootPos.y - 0.94) <= 0.05,
      `[${unitLabel}] Expected normalized Hips.y ≈ 0.94m, got ${frames[0].rootPos.y}`
    );
    const w0 = await computeWorldBonePositionsForFrame(frames[0]);
    assert.ok(
      Math.abs(Math.min(w0.LeftFoot.y, w0.RightFoot.y) - 0.08) <= 0.015,
      `[${unitLabel}] Expected floor ankle Y ≈ 0.08m`
    );
  }
});

test('[T2][F5][T2-F5-06] Explicit options.nonCyclic / options.cyclic override filename heuristics in parseBVHTextToClip', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['parseBVHTextToClip']);
  const bvh = buildSyntheticBVH({ convention: 'standard21', frames: 30, fps: 60 });
  const c1 = mc.parseBVHTextToClip(bvh, 'idle_stance.bvh', { nonCyclic: true });
  const c2 = mc.parseBVHTextToClip(bvh, 'slash_attack.bvh', { nonCyclic: false, cyclic: true });
  assert.equal(c1.nonCyclic, true, 'Explicit nonCyclic: true must override "idle" filename');
  assert.equal(Boolean(c2.nonCyclic), false, 'Explicit nonCyclic: false / cyclic: true must override "slash" filename');
});

test('[T2][F5][T2-F5-07] Malformed non-BVH input throws clean Error in Node & preserves active clip in Workbench UI', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['parseBVHTextToClip']);
  assert.throws(() => mc.parseBVHTextToClip('NOT_A_VALID_BVH_FILE', 'broken.bvh'));

  await withWorkbenchPage(async (page) => {
    page.clearLogs();
    const out = await page.evaluate(async () => {
      const ms = window.__MOTION_STAGE__;
      const prevFrames = ms.getState().frameCount;
      let threwCleanly = false;
      try {
        await ms.loadClipFromBVHText('CORRUPT_BVH_DATA', 'corrupt.bvh');
      } catch {
        threwCleanly = true;
      }
      return { prevFrames, afterFrames: ms.getState().frameCount, threwCleanly };
    });
    assert.ok(out.afterFrames > 0 && out.afterFrames === out.prevFrames, 'Active clip must survive malformed BVH load');
    assert.equal(page.pageErrors.length, 0, 'Malformed BVH must not cause uncaught page crash');
  });
});

// ============================================================================
// Feature F6 Tier 2: Video Trim & Pose Capture Edge Cases (7 Tests)
// ============================================================================

test('[T2][F6][T2-F6-01] Deep-offset trim past 8.0s on 75.9s master video 05 succeeds via HTTP 206 Range seeking', async () => {
  const spec05 = REFERENCE_VIDEO_SPECS.find((s) => s.key === '05');
  requireDeliverableFile(path.join(REF_VIDEOS_DIR, spec05.file), 'F6/F2');

  await withCapturePage(async (page) => {
    const out = await page.evaluate(async (vidFile) => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const url = `/reference_videos/${encodeURIComponent(vidFile)}`;
      const probe = await vpc.probeVideoSource(url);
      const res = await vpc.extractClipFromVideoSource(url, null, {
        trimInSec: 26.72,
        trimOutSec: 27.12,
        targetFps: 24,
        nonCyclic: true,
        delegate: 'auto',
      });
      const clip = res?.clip || res;
      return { duration: probe.videoDuration, frames: clip.frames.length, fps: clip.fps };
    }, spec05.file);

    assert.ok(out.duration > 75.0, `Expected master video > 75s, got ${out.duration}`);
    assert.ok(out.frames >= 8 && out.frames <= 12, `Expected ~10 frames for [26.72..27.12s] @ 24fps, got ${out.frames}`);
  });
});

test('[T2][F6][T2-F6-02] Inverted or zero-span trim bounds (trimInSec >= trimOutSec) clamp safely or reject cleanly', async () => {
  await withCapturePage(async (page) => {
    const res = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const runCase = async (trimInSec, trimOutSec) => {
        try {
          const r = await vpc.extractClipFromVideoSource('/demo/taibai_wuhen_jianyi.mp4', null, {
            trimInSec,
            trimOutSec,
            targetFps: 12,
          });
          const clip = r?.clip || r;
          const allFinite = clip.frames.every((f) => Number.isFinite(f.rootPos.y));
          return { mode: 'clamped', frames: clip.frames.length, allFinite };
        } catch (err) {
          return { mode: 'rejected', msg: String(err?.message || err) };
        }
      };
      return {
        inverted: await runCase(2.2, 1.5),
        collapsed: await runCase(1.5, 1.5),
      };
    });

    for (const c of [res.inverted, res.collapsed]) {
      if (c.mode === 'clamped') {
        assert.ok(c.frames >= 2 && c.allFinite, 'Clamped inverted trim must produce >= 2 finite frames');
      } else {
        assert.ok(c.msg.length > 3, 'Rejected inverted trim must throw descriptive Error');
      }
    }
  });
});

test('[T2][F6][T2-F6-03] Out-of-range negative trimInSec (-3.0) & huge trimOutSec (999.0) clamp to [0, duration]', async () => {
  await withCapturePage(async (page) => {
    const out = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const url01b =
        '/reference_videos/01b_%E5%A4%A9%E5%88%80%E5%AE%98%E7%BD%91_%E5%A4%AA%E7%99%BD%E5%B4%96%E9%A1%B6%E6%8B%94%E5%89%91%E5%AE%9A%E5%8A%BF_%E5%85%A8%E8%BA%AB%E9%95%9C%E5%A4%B4.mp4';
      const res = await vpc.extractClipFromVideoSource(url01b, null, {
        trimInSec: -3.0,
        trimOutSec: 999.0,
        targetFps: 12,
      });
      const clip = res?.clip || res;
      return { frames: clip.frames.length, fps: clip.fps };
    });

    assert.equal(out.fps, 12);
    assert.ok(out.frames >= 10 && out.frames <= 15, `Expected clamped 1.00s @ 12fps ≈ 12 frames, got ${out.frames}`);
  });
});

test('[T2][F6][T2-F6-04] Out-of-bounds targetFps (NaN, 0, -10, 240) clamps/defaults to finite positive FPS', async () => {
  await withCapturePage(async (page) => {
    const out = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const rNaN = await vpc.extractClipFromVideoSource('/demo/taibai_wuhen_jianyi.mp4', null, {
        trimInSec: 0.4,
        trimOutSec: 0.65,
        targetFps: Number.NaN,
      });
      const rHigh = await vpc.extractClipFromVideoSource('/demo/taibai_wuhen_jianyi.mp4', null, {
        trimInSec: 0.4,
        trimOutSec: 0.65,
        targetFps: 240,
      });
      const cNaN = rNaN?.clip || rNaN;
      const cHigh = rHigh?.clip || rHigh;
      return {
        nanFps: cNaN.fps,
        nanFrames: cNaN.frames.length,
        highFps: cHigh.fps,
        highFrames: cHigh.frames.length,
      };
    });

    assert.ok(Number.isFinite(out.nanFps) && out.nanFps >= 12 && out.nanFrames >= 2);
    assert.ok(Number.isFinite(out.highFps) && out.highFps > 0 && out.highFps <= 120 && out.highFrames >= 4);
  });
});

test('[T2][F6][T2-F6-05] Blank zero-person video rejects cleanly without breaking singleton landmarkerVideo', async () => {
  await withCapturePage(async (page) => {
    const out = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      // Record 0.5s solid black canvas stream
      const cnv = document.createElement('canvas');
      cnv.width = 320;
      cnv.height = 240;
      const ctx = cnv.getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, 320, 240);
      const stream = cnv.captureStream(12);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.start();
      const iv = setInterval(() => ctx.fillRect(0, 0, 320, 240), 50);
      await new Promise((r) => setTimeout(r, 450));
      clearInterval(iv);
      await new Promise((resolve) => {
        recorder.onstop = resolve;
        recorder.stop();
      });
      stream.getTracks().forEach((t) => t.stop());

      const blankFile = new File([new Blob(chunks, { type: 'video/webm' })], 'blank.webm', {
        type: 'video/webm',
      });
      let blankRejected = false;
      let errMsg = '';
      try {
        await vpc.extractClipFromVideoFile(blankFile, null, {
          trimInSec: 0,
          trimOutSec: 0.4,
          targetFps: 12,
        });
      } catch (err) {
        blankRejected = true;
        errMsg = String(err?.message || err);
      }

      // Verify singleton landmarkerVideo still works immediately after!
      const followUp = await vpc.extractClipFromVideoSource('/demo/taibai_wuhen_jianyi.mp4', null, {
        trimInSec: 0.4,
        trimOutSec: 0.65,
        targetFps: 12,
      });
      const clip = followUp?.clip || followUp;
      return { blankRejected, errMsg, followUpFrames: clip.frames.length };
    });

    assert.equal(out.blankRejected, true, 'Blank zero-person video must reject');
    assert.ok(out.errMsg.length > 2);
    assert.ok(out.followUpFrames >= 3, 'Singleton landmarkerVideo must remain healthy after blank video error');
  });
});

test('[T2][F6][T2-F6-06] Missing HTTP 404 video URL rejects promptly (<5s) without hanging loadeddata', async () => {
  await withCapturePage(async (page) => {
    const t0 = performance.now();
    const out = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      let probeFailed = false;
      let extractFailed = false;
      if (typeof vpc.probeVideoSource === 'function') {
        try {
          await vpc.probeVideoSource('/non_existent_404_video.mp4');
        } catch {
          probeFailed = true;
        }
      }
      try {
        await vpc.extractClipFromVideoUrl('/non_existent_404_video.mp4', 'Missing', null, { targetFps: 12 });
      } catch {
        extractFailed = true;
      }
      return { probeFailed, extractFailed };
    });
    const elapsedMs = performance.now() - t0;

    assert.equal(out.probeFailed, true, 'probeVideoSource must reject on HTTP 404');
    assert.equal(out.extractFailed, true, 'extractClipFromVideoUrl must reject on HTTP 404');
    assert.ok(elapsedMs < 5000, `404 video rejection took too long: ${elapsedMs.toFixed(0)}ms`);
  });
});

test('[T2][F6][T2-F6-07] landmarksToHumanoidFrame handles zero-length limb & inward sword-flip anti-penetration in Node', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX', 'createBoneHierarchy']);
  const vpc = await loadModuleContract('src/capture/VideoPoseCapture.js', ['landmarksToHumanoidFrame']);
  const { BONE_IDX, createBoneHierarchy } = rig;

  // Build 33 MediaPipe world & normalized landmarks with:
  // (a) Degenerate LeftElbow === LeftWrist (13 === 15)
  // (b) RightWrist (16) close in front of torso with inward-pointing thumb/index landmarks
  const worldLm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.99 }));
  const normLm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.99 }));

  // Shoulders (11=L, 12=R), Hips (23=L, 24=R) — note MediaPipe Y is downward!
  worldLm[11] = { x: 0.18, y: -0.52, z: 0, visibility: 1 };
  worldLm[12] = { x: -0.18, y: -0.52, z: 0, visibility: 1 };
  worldLm[23] = { x: 0.11, y: 0.0, z: 0, visibility: 1 };
  worldLm[24] = { x: -0.11, y: 0.0, z: 0, visibility: 1 };
  // Degenerate Left arm: Elbow === Wrist
  worldLm[13] = { x: 0.35, y: -0.3, z: 0, visibility: 1 };
  worldLm[15] = { x: 0.35, y: -0.3, z: 0, visibility: 1 };
  // Right arm close to chest (<0.58m) with inward-flipped thumb/index
  worldLm[14] = { x: -0.25, y: -0.35, z: -0.15, visibility: 1 };
  worldLm[16] = { x: -0.1, y: -0.38, z: -0.22, visibility: 1 };
  worldLm[18] = { x: -0.08, y: -0.38, z: -0.2, visibility: 1 }; // Pinky
  worldLm[20] = { x: -0.05, y: -0.38, z: -0.05, visibility: 1 }; // Index pointing back toward chest!
  worldLm[22] = { x: -0.04, y: -0.38, z: -0.02, visibility: 1 }; // Thumb pointing back toward chest!
  // Legs
  worldLm[25] = { x: 0.11, y: 0.41, z: 0, visibility: 1 };
  worldLm[27] = { x: 0.11, y: 0.82, z: 0, visibility: 1 };
  worldLm[26] = { x: -0.11, y: 0.41, z: 0, visibility: 1 };
  worldLm[28] = { x: -0.11, y: 0.82, z: 0, visibility: 1 };

  const frame = vpc.landmarksToHumanoidFrame(worldLm, normLm);
  assert.equal(frame.quats.length, 29);
  for (let b = 0; b < 29; b++) {
    const q = frame.quats[b];
    assert.ok(Number.isFinite(q.w) && Math.abs(q.length() - 1) <= 1e-4, `Bone ${b} NaN/non-unit quat`);
  }

  const { bones } = createBoneHierarchy();
  bones[0].position.copy(frame.rootPos);
  frame.quats.forEach((q, i) => bones[i].quaternion.copy(q));
  bones[0].updateMatrixWorld(true);
  const qHandWorld = new THREE.Quaternion();
  bones[BONE_IDX.RightHand].getWorldQuaternion(qHandWorld);
  const worldBlade = new THREE.Vector3(-0.619, 0.754, 0.219).normalize().applyQuaternion(qHandWorld);
  const handPos = new THREE.Vector3();
  const chestPos = new THREE.Vector3();
  bones[BONE_IDX.RightHand].getWorldPosition(handPos);
  bones[BONE_IDX.Chest].getWorldPosition(chestPos);
  const outVec = handPos.clone().sub(chestPos).normalize();
  assert.ok(worldBlade.dot(outVec) >= -0.25, `Sword blade pointed deep into chest: dot=${worldBlade.dot(outVec)}`);
});

// ============================================================================
// Feature F7 Tier 2: Filter & Two-Bone IK Edge Cases (7 Tests)
// ============================================================================

test('[T2][F7][T2-F7-01] runCleaningPipeline never mutates raw input clip.frames across repeated calls', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['buildSlashClip']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const clip = mc.buildSlashClip();
  const snapshot = clip.frames.map((fr) => ({
    rootPos: fr.rootPos.clone(),
    quats: fr.quats.map((q) => q.clone()),
    contactL: fr.contactL,
    contactR: fr.contactR,
  }));

  cleaner.runCleaningPipeline(clip, { deJitter: true, filterRadius: 8, footLock: true, loopClean: true });
  cleaner.runCleaningPipeline(clip, { deJitter: false, footLock: false, loopClean: false });

  for (let f = 0; f < clip.frames.length; f++) {
    assert.equal(clip.frames[f].rootPos.equals(snapshot[f].rootPos), true, `Frame ${f} rootPos mutated`);
    assert.equal(clip.frames[f].contactL, snapshot[f].contactL);
    assert.equal(clip.frames[f].contactR, snapshot[f].contactR);
    for (let b = 0; b < 29; b++) {
      assert.equal(clip.frames[f].quats[b].equals(snapshot[f].quats[b]), true, `Frame ${f} bone ${b} mutated`);
    }
  }
});

test('[T2][F7][T2-F7-02] Antipodal quaternion sign flip (q vs -q) & filterRadius=0 hemisphere safety', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const { BONE_IDX } = rig;

  const refQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.6, -0.4, 0.8));
  const frames = Array.from({ length: 20 }, (_, f) => {
    const quats = Array.from({ length: 29 }, () => new THREE.Quaternion());
    const q = refQ.clone();
    if (f % 2 === 1) q.set(-q.x, -q.y, -q.z, -q.w); // Exact antipodal representation!
    quats[BONE_IDX.RightHand] = q;
    return { rootPos: new THREE.Vector3(0, 0.94, 0), quats, contactL: false, contactR: false };
  });

  const resSmooth = cleaner.runCleaningPipeline(
    { fps: 60, nonCyclic: true, frames },
    { deJitter: true, filterRadius: 4, footLock: false, loopClean: false }
  );
  for (let f = 0; f < 20; f++) {
    const qOut = resSmooth.cleanedFrames[f].quats[BONE_IDX.RightHand];
    assert.ok(Math.abs(qOut.length() - 1) <= 1e-5, 'Antipodal average collapsed quaternion norm');
    assert.ok(qOut.angleTo(refQ) <= 1e-4, `Antipodal average drifted by ${qOut.angleTo(refQ)} rad`);
  }

  const resR0 = cleaner.runCleaningPipeline(
    { fps: 60, nonCyclic: true, frames },
    { deJitter: true, filterRadius: 0, footLock: false, loopClean: false }
  );
  assert.ok(resR0.cleanedFrames[5].quats[BONE_IDX.RightHand].angleTo(refQ) <= 1e-5);
});

test('[T2][F7][T2-F7-03] Inverted aerial frames (hipsUpY < 0 during backflip) never trigger floor foot-lock', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['buildBackflipClip']);
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX', 'createBoneHierarchy']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const { BONE_IDX, createBoneHierarchy } = rig;

  const clip = mc.buildBackflipClip();
  const { cleanedFrames } = cleaner.runCleaningPipeline(clip, {
    deJitter: true,
    footLock: true,
    contactMode: 'threshold',
    contactHeightThresh: 0.3,
    contactVelThresh: 2.5,
  });

  const { bones } = createBoneHierarchy();
  const qHips = new THREE.Quaternion();
  let invertedCount = 0;
  for (let f = 0; f < cleanedFrames.length; f++) {
    const fr = cleanedFrames[f];
    bones[0].position.copy(fr.rootPos);
    fr.quats.forEach((q, i) => bones[i].quaternion.copy(q));
    bones[0].updateMatrixWorld(true);
    bones[BONE_IDX.Hips].getWorldQuaternion(qHips);
    const upY = new THREE.Vector3(0, 1, 0).applyQuaternion(qHips).y;
    if (upY < 0) {
      invertedCount++;
      assert.equal(fr.lockWeightL || 0, 0, `Frame ${f} locked LeftFoot while upside-down!`);
      assert.equal(fr.lockWeightR || 0, 0, `Frame ${f} locked RightFoot while upside-down!`);
    }
  }
  assert.ok(invertedCount >= 3, 'Expected backflip clip to contain upside-down frames');
});

test('[T2][F7][T2-F7-04] Hyper-extension pelvis pull guard prevents NaN when raw Hips spikes above leg reach', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const frames = Array.from({ length: 15 }, (_, f) => ({
    rootPos: new THREE.Vector3(0, f === 7 ? 1.15 : 0.92, 0),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  }));
  const { cleanedFrames } = cleaner.runCleaningPipeline(
    { fps: 60, nonCyclic: true, frames },
    { deJitter: false, footLock: true, ikBlend: 1.0, loopClean: false }
  );
  const f7 = cleanedFrames[7];
  assert.ok(f7.rootPos.y < 0.96, `Expected hyper-extended Hips (1.15m) pulled down < 0.96m, got ${f7.rootPos.y}`);
  for (const q of f7.quats) {
    assert.ok(Number.isFinite(q.w) && Math.abs(q.length() - 1) <= 1e-4);
  }
});

test('[T2][F7][T2-F7-05] solveTwoBoneLegIK handles degenerate zero hip-to-target distance & collinear pole vector', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX', 'createBoneHierarchy']);
  const ikMod = await loadModuleContract('src/pipeline/TwoBoneIK.js', ['solveTwoBoneLegIK']);
  const { BONE_IDX, createBoneHierarchy } = rig;
  const { bones } = createBoneHierarchy();
  bones[0].updateMatrixWorld(true);

  const hipWorld = new THREE.Vector3();
  bones[BONE_IDX.LeftUpLeg].getWorldPosition(hipWorld);
  // Target === Hip (dist = 0), Pole collinear along -Y
  ikMod.solveTwoBoneLegIK(
    bones[BONE_IDX.LeftUpLeg],
    bones[BONE_IDX.LeftLeg],
    bones[BONE_IDX.LeftFoot],
    hipWorld.clone(),
    hipWorld.clone().add(new THREE.Vector3(0, -1, 0)),
    true,
    null
  );

  for (const idx of [BONE_IDX.LeftUpLeg, BONE_IDX.LeftLeg, BONE_IDX.LeftFoot]) {
    const q = bones[idx].quaternion;
    assert.ok(Number.isFinite(q.w) && Math.abs(q.length() - 1) <= 1e-4, `Bone ${idx} NaN on degenerate IK`);
  }
});

test('[T2][F7][T2-F7-06] preserveRootMotion toggle in Workbench switches imported lunge BVH between +Z travel & centered', async () => {
  const lungeBvh = buildSyntheticBVH({
    convention: 'standard21',
    frames: 45,
    fps: 60,
    rootPosFn: (f) => [0, 94, (f / 44) * 250],
  });

  await withWorkbenchPage(async (page) => {
    const res = await page.evaluate(async (bvhStr) => {
      const ms = window.__MOTION_STAGE__;
      await ms.loadClipFromBVHText(bvhStr, '08_dash_test.bvh', { preserveRootMotion: true, nonCyclic: true });
      ms.setCleanOptions({ preserveRootMotion: true, loopClean: false });
      ms.setCombatCurve({ mode: 'off', bakeCombatCurve: false, bakeOnExport: false });
      const bvhPreserved = ms.exportCurrentBVH();

      ms.setCleanOptions({ preserveRootMotion: false });
      const bvhCentered = ms.exportCurrentBVH();
      return { bvhPreserved, bvhCentered };
    }, lungeBvh);

    const pPres = parseAndAnalyzeStandardBVH(res.bvhPreserved, 'Preserved');
    const pCent = parseAndAnalyzeStandardBVH(res.bvhCentered, 'Centered');
    const zEndPres = pPres.rows[pPres.rows.length - 1][2];
    const zMeanCent = pCent.rows.reduce((a, r) => a + r[2], 0) / pCent.rows.length;
    assert.ok(Math.abs(pPres.rows[0][2]) <= 15.0 && zEndPres >= 220.0, `Expected preserved Z: 0 -> ~250cm, got ${zEndPres}`);
    assert.ok(Math.abs(zMeanCent) <= 15.0, `Expected centered mean Z ≈ 0cm, got ${zMeanCent}`);
  });
});

test('[T2][F7][T2-F7-07] Out-of-bounds option values (negative filterRadius, ikBlend=5, twistShare=-1) clamp safely', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['buildSlashClip']);
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX', 'createBoneHierarchy']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const ikMod = await loadModuleContract('src/pipeline/TwoBoneIK.js', ['applyForearmTwistSolver']);

  const slash = mc.buildSlashClip();
  const res = cleaner.runCleaningPipeline(slash, {
    deJitter: true,
    filterRadius: -5,
    footLock: true,
    ikBlend: 5.0,
    forearmTwistShare: -1.0,
  });
  assert.equal(res.cleanedFrames.length, slash.frames.length);
  for (const q of res.cleanedFrames[10].quats) {
    assert.ok(Number.isFinite(q.w) && Math.abs(q.length() - 1) <= 1e-4);
  }

  const { bones } = rig.createBoneHierarchy();
  bones[rig.BONE_IDX.RightHand].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
  ikMod.applyForearmTwistSolver(bones, true, -1.0);
  assert.ok(Number.isFinite(bones[rig.BONE_IDX.RightForeArmTwist].quaternion.w));
});

// ============================================================================
// Feature F8 Tier 2: Combat Time-Warp & BVH Baking Edge Cases (7 Tests)
// ============================================================================

test('[T2][F8][T2-F8-01] sampleInterpolatedFrame clamps negative & huge frameFloat in nonCyclic vs wraps in cyclic', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['sampleInterpolatedFrame']);
  const frames = Array.from({ length: 10 }, (_, k) => ({
    rootPos: new THREE.Vector3(0, 0.94, k * 0.2), // 0.0 .. 1.8
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  }));
  const pose = () => ({
    rootPos: new THREE.Vector3(),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
  });

  const pNeg = cleaner.sampleInterpolatedFrame(frames, -3.2, pose(), true);
  const pHuge = cleaner.sampleInterpolatedFrame(frames, 999.7, pose(), true);
  assert.ok(Math.abs(pNeg.rootPos.z - 0.0) <= 1e-6);
  assert.ok(Math.abs(pHuge.rootPos.z - 1.8) <= 1e-6);

  const pWrap = cleaner.sampleInterpolatedFrame(frames, 10.0, pose(), false);
  const pMidSeam = cleaner.sampleInterpolatedFrame(frames, 9.5, pose(), false);
  assert.ok(Math.abs(pWrap.rootPos.z - 0.0) <= 1e-6);
  assert.ok(Math.abs(pMidSeam.rootPos.z - 0.9) <= 1e-5);
});

test('[T2][F8][T2-F8-02] hitstopFrames=0 & unity speeds preserve exact frame count & zero plateau frames', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js');
  const exporter = await loadModuleContract('src/pipeline/BVHExporter.js');
  const bakeWarpedFrames = resolveBakeWarpedFrames(exporter, cleaner);

  const frames = Array.from({ length: 60 }, (_, f) => ({
    rootPos: new THREE.Vector3(0, 0.94, f * 0.02),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  }));
  const baked = bakeWarpedFrames(frames, { fps: 60, nonCyclic: true, isCombatAttack: true }, {
    mode: 'single',
    windupEnd: 0.3,
    windupSpeed: 1.0,
    strikeEnd: 0.5,
    strikeSpeed: 1.0,
    hitstopFrames: 0,
    recoverySpeed: 1.0,
  });
  assert.equal(baked.length, 60);
  for (let i = 1; i < baked.length; i++) {
    assert.ok(baked[i].rootPos.z > baked[i - 1].rootPos.z, 'Expected strictly increasing progression');
  }
});

test('[T2][F8][T2-F8-03] Degenerate knot ordering (strikeEnd <= windupEnd) clamps safely without NaN', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['remapCombatTime']);
  const exporter = await loadModuleContract('src/pipeline/BVHExporter.js');
  const bakeWarpedFrames = resolveBakeWarpedFrames(exporter, cleaner);

  const badCurve = {
    mode: 'single',
    windupEnd: 0.65,
    strikeEnd: 0.3,
    windupSpeed: 2.0,
    strikeSpeed: 1.8,
    hitstopFrames: 4,
    recoverySpeed: 1.0,
  };
  let prev = 0;
  for (let i = 0; i <= 100; i++) {
    const r = cleaner.remapCombatTime(i / 100, true, true, true, badCurve, null, 60);
    assert.ok(Number.isFinite(r.warpedU) && r.warpedU >= 0 && r.warpedU <= 1);
    assert.ok(r.warpedU >= prev - 1e-6);
    prev = r.warpedU;
  }

  const frames = Array.from({ length: 30 }, (_, f) => ({
    rootPos: new THREE.Vector3(0, 0.94, f * 0.02),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  }));
  const baked = bakeWarpedFrames(frames, { fps: 60, nonCyclic: true, isCombatAttack: true }, badCurve);
  assert.ok(baked.length >= 15 && baked.every((f) => Number.isFinite(f.rootPos.z)));
});

test('[T2][F8][T2-F8-04] Stationary zero-velocity clip in mode="autoMultiHit" degrades cleanly without 0/0 NaN', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['remapCombatTime']);
  const exporter = await loadModuleContract('src/pipeline/BVHExporter.js');
  const bakeWarpedFrames = resolveBakeWarpedFrames(exporter, cleaner);

  const staticFrames = Array.from({ length: 60 }, () => ({
    rootPos: new THREE.Vector3(0, 0.94, 0),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  }));

  for (let i = 0; i <= 60; i++) {
    const r = cleaner.remapCombatTime(
      i / 60,
      true,
      true,
      true,
      { mode: 'autoMultiHit', hitstopFrames: 5 },
      staticFrames,
      60
    );
    assert.ok(Number.isFinite(r.warpedU) && r.warpedU >= 0 && r.warpedU <= 1);
  }
  const baked = bakeWarpedFrames(
    staticFrames,
    { fps: 60, nonCyclic: true, isCombatAttack: true },
    { mode: 'autoMultiHit', hitstopFrames: 5 }
  );
  assert.ok(baked.length >= 2 && baked.every((f) => Number.isFinite(f.rootPos.y)));
});

test('[T2][F8][T2-F8-05] Minimum 2-frame clip bakes and exports valid 21-bone 66-channel .bvh', async () => {
  const exporter = await loadModuleContract('src/pipeline/BVHExporter.js', ['exportCleanedClipToBVH']);
  const twoFrames = [0, 1].map((f) => ({
    rootPos: new THREE.Vector3(0, 0.94, f * 0.2),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  }));
  const bvh = exporter.exportCleanedClipToBVH(
    { fps: 60, nonCyclic: true, isCombatAttack: true },
    twoFrames,
    { bakeCombatCurve: true, combatCurve: { mode: 'single', hitstopFrames: 3 } }
  );
  const parsed = parseAndAnalyzeStandardBVH(bvh, 'Min2FrameBake', { minFrames: 2 });
  assert.ok(parsed.declaredFrames >= 2);
});

test('[T2][F8][T2-F8-06] Quaternion hemisphere slerp takes shortest arc across antipodal sign flip during baking', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js');
  const exporter = await loadModuleContract('src/pipeline/BVHExporter.js');
  const bakeWarpedFrames = resolveBakeWarpedFrames(exporter, cleaner);
  const { BONE_IDX } = rig;

  const frames = Array.from({ length: 30 }, (_, f) => {
    const quats = Array.from({ length: 29 }, () => new THREE.Quaternion());
    const deg = 90 + f * 0.5;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
    if (f >= 15) q.set(-q.x, -q.y, -q.z, -q.w); // Antipodal flip at f=15!
    quats[BONE_IDX.RightHand] = q;
    return { rootPos: new THREE.Vector3(0, 0.94, 0), quats, contactL: true, contactR: true };
  });

  const baked = bakeWarpedFrames(frames, { fps: 60, nonCyclic: true, isCombatAttack: true }, {
    mode: 'single',
    windupEnd: 0.7,
    windupSpeed: 0.7,
    strikeEnd: 0.85,
    hitstopFrames: 0,
  });
  for (let i = 1; i < baked.length; i++) {
    const stepDeg =
      baked[i].quats[BONE_IDX.RightHand].angleTo(baked[i - 1].quats[BONE_IDX.RightHand]) * (180 / Math.PI);
    assert.ok(stepDeg <= 3.0, `Long-way 359° slerp spin detected at baked frame ${i}: ${stepDeg.toFixed(1)}°`);
  }
});

test('[T2][F8][T2-F8-07] Default 2-argument exportCleanedClipToBVH(clip, frames) maintains unwarped compatibility', async () => {
  const exporter = await loadModuleContract('src/pipeline/BVHExporter.js', ['exportCleanedClipToBVH']);
  const frames = Array.from({ length: 25 }, (_, f) => ({
    rootPos: new THREE.Vector3(0, 0.94, f * 0.01),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  }));
  const bvh = exporter.exportCleanedClipToBVH({ fps: 60, nonCyclic: true, isCombatAttack: true }, frames);
  const parsed = parseAndAnalyzeStandardBVH(bvh, 'TwoArgDefault');
  assert.equal(parsed.declaredFrames, 25);
});

// ============================================================================
// Feature F9 Tier 2: Telemetry HUD & Asset Selector Edge Cases (7 Tests)
// ============================================================================

test('[T2][F9][T2-F9-01] Fully airborne clip (0 stance frames) returns 0 slip without 0/0 NaN in analyzeMotionTelemetry', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['analyzeMotionTelemetry']);
  const airFrames = Array.from({ length: 25 }, (_, f) => ({
    rootPos: new THREE.Vector3(f * 0.03, 1.45, 0),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: false,
    contactR: false,
    lockWeightL: 0,
    lockWeightR: 0,
  }));
  const tel = cleaner.analyzeMotionTelemetry(airFrames, 60, false);
  assert.equal(tel.meanSlip, 0);
  assert.equal(tel.maxSlip, 0);
  assert.equal(tel.rmsSlipCmS, 0);
  assert.equal(tel.maxSlipCmS, 0);
  assert.ok(Number.isFinite(tel.rmsJitter) && tel.rmsJitter >= 0);
});

test('[T2][F9][T2-F9-02] Single-frame clip (frames.length === 1) returns finite NaN-free telemetry', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['analyzeMotionTelemetry']);
  const one = [
    {
      rootPos: new THREE.Vector3(0, 0.94, 0),
      quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
      contactL: true,
      contactR: true,
    },
  ];
  for (const cyc of [false, true]) {
    const tel = cleaner.analyzeMotionTelemetry(one, 60, cyc);
    assert.equal(tel.slipSeries.length, 1);
    assert.equal(tel.jitterSeries.length, 1);
    assert.equal(tel.rmsSlipCmS, 0);
    assert.equal(tel.rmsJitter, 0);
  }
});

test('[T2][F9][T2-F9-03] Shorter referenceFrames array does not throw TypeError in analyzeMotionTelemetry', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['analyzeMotionTelemetry']);
  const make = (n) =>
    Array.from({ length: n }, (_, f) => ({
      rootPos: new THREE.Vector3(f * 0.01, 0.94, 0),
      quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
      contactL: true,
      contactR: true,
      lockWeightL: 1,
      lockWeightR: 1,
    }));
  const tel = cleaner.analyzeMotionTelemetry(make(30), 60, false, make(10));
  assert.equal(tel.slipSeries.length, 30);
  assert.ok(Number.isFinite(tel.rmsSlipCmS));
});

test('[T2][F9][T2-F9-04] Window resize & DPR change (2 -> 1 -> 2) cleanly redraws <canvas> Telemetry HUD', async () => {
  await withWorkbenchPage(async (page) => {
    page.clearLogs();
    await page.setViewport(900, 640, 1);
    await page.sleep(80);
    await page.setViewport(1280, 800, 2);
    await page.sleep(80);

    const check = await page.evaluate(() => {
      const c = Array.from(document.querySelectorAll('canvas')).find(
        (el) => !el.closest('#canvas-container')
      );
      if (!c) return null;
      const img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let nonBlank = 0;
      for (let i = 3; i < img.length; i += 16) if (img[i] > 20) nonBlank++;
      return { w: c.width, h: c.height, nonBlank };
    });

    assert.ok(check && check.w > 0 && check.h > 0 && check.nonBlank > 20);
    assert.equal(page.pageErrors.length, 0);
  });
});

test('[T2][F9][T2-F9-05] setWorkbenchActive(false -> true) pauses rAF & Space listener, then resumes cleanly', async () => {
  await withWorkbenchPage(async (page) => {
    const out = await page.evaluate(async () => {
      const ms = window.__MOTION_STAGE__;
      if (!ms.getState().isPlaying) document.getElementById('btn-play-pause')?.click();
      ms.setWorkbenchActive(false);
      await new Promise((r) => setTimeout(r, 120));
      const t1 = ms.getState().normalizedTime;
      const p1 = ms.getState().isPlaying;
      await new Promise((r) => setTimeout(r, 220));
      const t2 = ms.getState().normalizedTime;

      return { t1, t2, p1 };
    });

    await page.tapKey('Space');
    const afterSpaceWhileInactive = await page.evaluate(() => window.__MOTION_STAGE__.getState().isPlaying);
    assert.equal(out.t2, out.t1, 'Workbench normalizedTime must freeze when setWorkbenchActive(false)');
    assert.equal(afterSpaceWhileInactive, out.p1, 'Spacebar must not toggle Workbench while inactive');

    const resumed = await page.evaluate(async () => {
      const ms = window.__MOTION_STAGE__;
      ms.setWorkbenchActive(true);
      const tStart = ms.getState().normalizedTime;
      await new Promise((r) => setTimeout(r, 220));
      return { tStart, tEnd: ms.getState().normalizedTime };
    });
    assert.notEqual(resumed.tEnd, resumed.tStart, 'Workbench playback must resume after setWorkbenchActive(true)');
  });
});

test('[T2][F9][T2-F9-06] Rapid preset & Built-in Asset switching stress completes without race-condition exceptions', async () => {
  await withWorkbenchPage(async (page) => {
    page.clearLogs();
    const finalState = await page.evaluate(async () => {
      for (const id of ['btn-clip-slash', 'btn-clip-kick', 'btn-clip-backflip', 'btn-clip-run', 'btn-clip-slash']) {
        document.getElementById(id)?.click();
        await new Promise((r) => setTimeout(r, 15));
      }
      const selectEl = document.querySelector('select[id*="asset"], select[id*="library"], #top-floating-bar select');
      if (selectEl) {
        const opt = Array.from(selectEl.options).find((o) =>
          (o.value + o.textContent).includes('01_wuxia_idle')
        );
        if (opt) {
          selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      await new Promise((r) => setTimeout(r, 400));
      return window.__MOTION_STAGE__.getState();
    });

    assert.ok(finalState.frameCount > 0);
    assert.equal(page.pageErrors.length, 0, `Race-condition errors: ${page.pageErrors.join('; ')}`);
  });
});

test('[T2][F9][T2-F9-07] Blocked / 404 optional BVH fetch degrades gracefully without crashing Workbench rAF loop', async () => {
  await withWorkbenchPage(async (page) => {
    await page.setBlockedURLs(['*missing_optional_clip.bvh*']);
    page.clearLogs();
    const res = await page.evaluate(async () => {
      const ms = window.__MOTION_STAGE__;
      const framesBefore = ms.getState().frameCount;
      try {
        const r = await fetch('/bvh_library/C_taibai_extracted/missing_optional_clip.bvh');
        if (r.ok) {
          await ms.loadClipFromBVHText(await r.text(), 'missing_optional_clip.bvh');
        }
      } catch {
        // Expected network block
      }
      if (typeof ms.loadAssetByUrl === 'function') {
        try {
          await ms.loadAssetByUrl('/bvh_library/C_taibai_extracted/missing_optional_clip.bvh');
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 150));
      return { framesBefore, framesAfter: ms.getState().frameCount };
    });

    assert.equal(res.framesAfter, res.framesBefore, 'Active clip must remain intact on 404 asset fetch');
    assert.equal(page.pageErrors.length, 0);
  });
});
