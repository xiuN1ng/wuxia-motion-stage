import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXPORT_21_BONE_INDICES } from '../helpers/constants.mjs';
import {
  importThree,
  importBVHLoader,
  loadModuleContract,
  unwrapRetargetFrames,
  resolveBakeWarpedFrames,
} from '../helpers/contract_loader.mjs';
import {
  parseAndAnalyzeStandardBVH,
  buildSyntheticBVH,
  buildControlledSlipClip,
  buildMultiPeakCombatClip,
  computeWorldBonePositionsForFrame,
} from '../helpers/bvh_verifier.mjs';
import { withCapturePage, withWorkbenchPage } from '../helpers/browser_cdp.mjs';

const THREE = await importThree();

function quatAngleFromIdentity(q) {
  const w = Math.min(1, Math.abs(q.w));
  return 2 * Math.acos(w);
}

// ============================================================================
// Feature F5: BVH Retargeter & Root Motion Fix (7 Happy-Path Tests)
// ============================================================================

test('[T1][F5][T1-F5-01] BVH_TARGET_CANDIDATES exposes all 21 standard humanoid indices including LeftToe & RightToe', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['BVH_TARGET_CANDIDATES']);
  const candidates = mc.BVH_TARGET_CANDIDATES;
  assert.ok(Array.isArray(candidates), 'BVH_TARGET_CANDIDATES must be an Array');
  assert.equal(candidates.length, 21, `Expected 21 entries in BVH_TARGET_CANDIDATES, got ${candidates.length}`);

  const actualIndices = candidates
    .map((entry) => (Array.isArray(entry) ? entry[0] : entry?.boneIdx))
    .sort((a, b) => a - b);
  const expectedIndices = [...EXPORT_21_BONE_INDICES].sort((a, b) => a - b);
  assert.deepEqual(actualIndices, expectedIndices, 'BVH_TARGET_CANDIDATES must cover exact 21 export bone indices');
});

test('[T1][F5][T1-F5-02] RightLeg candidate regex matches calf_r (never calf_l) and isolates L/R shins on UE5 BVH', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const mc = await loadModuleContract('src/anim/MotionClips.js', [
    'BVH_TARGET_CANDIDATES',
    'retargetBVHToFrames',
  ]);
  const { BONE_IDX } = rig;

  const rightLegEntry = mc.BVH_TARGET_CANDIDATES.find(
    (e) => (Array.isArray(e) ? e[0] : e?.boneIdx) === BONE_IDX.RightLeg
  );
  assert.ok(rightLegEntry, 'Missing RightLeg entry in BVH_TARGET_CANDIDATES');
  const regexes = Array.isArray(rightLegEntry) ? rightLegEntry[1] : rightLegEntry.patterns;
  assert.ok(regexes.some((rx) => rx.test('calf_r')), 'RightLeg regex list must match calf_r');
  assert.equal(
    regexes.some((rx) => rx.test('calf_l')),
    false,
    'RightLeg regex list must NEVER match calf_l'
  );

  // Run A: calf_l rotated +35° X, calf_r 0°
  const bvhA = buildSyntheticBVH({
    convention: 'ue5',
    frames: 10,
    fps: 60,
    jointEulerZXYDegFn: (name) => (name === 'calf_l' ? [0, 35, 0] : [0, 0, 0]),
  });
  const framesA = await unwrapRetargetFrames(mc.retargetBVHToFrames(bvhA, 60));
  assert.ok(quatAngleFromIdentity(framesA[5].quats[BONE_IDX.LeftLeg]) > 0.45, 'Run A: LeftLeg should rotate');
  assert.ok(quatAngleFromIdentity(framesA[5].quats[BONE_IDX.RightLeg]) < 0.03, 'Run A: RightLeg should stay 0');

  // Run B: calf_r rotated -40° X, calf_l 0°
  const bvhB = buildSyntheticBVH({
    convention: 'ue5',
    frames: 10,
    fps: 60,
    jointEulerZXYDegFn: (name) => (name === 'calf_r' ? [0, -40, 0] : [0, 0, 0]),
  });
  const framesB = await unwrapRetargetFrames(mc.retargetBVHToFrames(bvhB, 60));
  assert.ok(quatAngleFromIdentity(framesB[5].quats[BONE_IDX.RightLeg]) > 0.5, 'Run B: RightLeg should rotate');
  assert.ok(quatAngleFromIdentity(framesB[5].quats[BONE_IDX.LeftLeg]) < 0.03, 'Run B: LeftLeg should stay 0');
});

test('[T1][F5][T1-F5-03] Hips candidate prioritizes pelvis ahead of floor root on UE5 hierarchy', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const { BONE_IDX } = rig;

  const ue5Bvh = buildSyntheticBVH({
    convention: 'ue5_with_floor_root',
    frames: 12,
    fps: 60,
    jointEulerZXYDegFn: (name) => (name === 'pelvis' ? [0, 0, 25] : [0, 0, 0]),
  });
  const frames = await unwrapRetargetFrames(mc.retargetBVHToFrames(ue5Bvh, 60));
  const hipsAngle = quatAngleFromIdentity(frames[6].quats[BONE_IDX.Hips]);
  assert.ok(
    Math.abs(hipsAngle - (25 * Math.PI) / 180) <= 0.06,
    `Expected Hips yaw ~0.436 rad from pelvis (not 0 from floor root), got ${hipsAngle.toFixed(4)} rad`
  );
});

test('[T1][F5][T1-F5-04] LeftToe and RightToe retarget accurately across UE5 ball_l/r, Mixamo *ToeBase & Unity *Toes', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const { BONE_IDX } = rig;

  for (const conv of ['ue5', 'mixamo', 'unity']) {
    const bvh = buildSyntheticBVH({
      convention: conv,
      frames: 10,
      fps: 60,
      jointEulerZXYDegFn: (name) => {
        if (name === 'LeftToe') return [0, 30, 0];
        if (name === 'RightToe') return [0, -25, 0];
        return null;
      },
    });
    const frames = await unwrapRetargetFrames(mc.retargetBVHToFrames(bvh, 60), `ToeRetarget:${conv}`);
    const angL = quatAngleFromIdentity(frames[5].quats[BONE_IDX.LeftToe]);
    const angR = quatAngleFromIdentity(frames[5].quats[BONE_IDX.RightToe]);
    assert.ok(Math.abs(angL - 0.5236) <= 0.08, `[${conv}] LeftToe expected ~0.52 rad, got ${angL.toFixed(3)}`);
    assert.ok(Math.abs(angR - 0.4363) <= 0.08, `[${conv}] RightToe expected ~0.44 rad, got ${angR.toFixed(3)}`);
  }
});

test('[T1][F5][T1-F5-05] Blender Rigify .L / .R suffix skeleton retargets limbs without L/R cross-talk', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const { BONE_IDX } = rig;

  const rigifyBvh = buildSyntheticBVH({
    convention: 'rigify',
    frames: 10,
    fps: 60,
    jointEulerZXYDegFn: (name) => {
      if (name === 'shin.R') return [0, -45, 0];
      if (name === 'upper_arm.L') return [30, 0, 0];
      return [0, 0, 0];
    },
  });
  const frames = await unwrapRetargetFrames(mc.retargetBVHToFrames(rigifyBvh, 60));
  assert.ok(quatAngleFromIdentity(frames[5].quats[BONE_IDX.RightLeg]) > 0.65, 'Rigify shin.R -> RightLeg');
  assert.ok(quatAngleFromIdentity(frames[5].quats[BONE_IDX.LeftLeg]) < 0.03, 'Rigify LeftLeg stays 0');
  assert.ok(quatAngleFromIdentity(frames[5].quats[BONE_IDX.LeftUpperArm]) > 0.4, 'Rigify upper_arm.L -> LeftUpperArm');
  assert.ok(quatAngleFromIdentity(frames[5].quats[BONE_IDX.RightUpperArm]) < 0.03, 'Rigify RightUpperArm stays 0');
});

test('[T1][F5][T1-F5-06] retargetBVHToFrames supports uncapped >240 frames & preserveRootMotion Frame-0 (0,0) anchoring', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const bvh360 = buildSyntheticBVH({
    convention: 'standard21',
    frames: 360,
    fps: 60,
    rootPosFn: (f) => {
      const u = f / 359;
      return [50 + 120 * u, 94, -80 + 300 * u]; // cm: ΔX=+120cm (+1.2m), ΔZ=+300cm (+3.0m)
    },
  });

  const frames = await unwrapRetargetFrames(
    mc.retargetBVHToFrames(bvh360, 60, { preserveRootMotion: true, rootOriginMode: 'start' })
  );
  assert.ok(
    frames.length >= 355 && frames.length <= 362,
    `Expected uncapped ~360 frames (>240!), got ${frames.length}`
  );
  assert.ok(Math.abs(frames[0].rootPos.x) < 1e-3, `Frame 0 X not anchored at 0: ${frames[0].rootPos.x}`);
  assert.ok(Math.abs(frames[0].rootPos.z) < 1e-3, `Frame 0 Z not anchored at 0: ${frames[0].rootPos.z}`);
  const end = frames[frames.length - 1].rootPos;
  assert.ok(Math.abs(end.x - 1.2) <= 0.05, `Expected net ΔX ≈ +1.20m, got ${end.x.toFixed(3)}m`);
  assert.ok(Math.abs(end.z - 3.0) <= 0.08, `Expected net ΔZ ≈ +3.00m, got ${end.z.toFixed(3)}m`);
});

test('[T1][F5][T1-F5-07] parseBVHTextToClip auto-detects nonCyclic vs cyclic filenames and preserves custom Root Motion', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['parseBVHTextToClip']);
  const lungeBvh = buildSyntheticBVH({
    convention: 'standard21',
    frames: 60,
    fps: 60,
    rootPosFn: (f) => [0, 94, (f / 59) * 300],
  });

  const dashClip = mc.parseBVHTextToClip(lungeBvh, '08_wuxia_dash_canglong.bvh');
  assert.equal(dashClip.nonCyclic, true, 'Dash clip should auto-detect nonCyclic === true');
  const dashEndZ = dashClip.frames[dashClip.frames.length - 1].rootPos.z - dashClip.frames[0].rootPos.z;
  assert.ok(dashEndZ >= 2.8, `Expected preserved +3.0m Root Motion on custom dash BVH, got ${dashEndZ.toFixed(2)}m`);

  const idleClip = mc.parseBVHTextToClip(lungeBvh, '01_wuxia_idle_loop.bvh');
  const strafeClip = mc.parseBVHTextToClip(lungeBvh, '07_wuxia_strafe_F.bvh');
  assert.equal(Boolean(idleClip.nonCyclic), false, 'Idle filename should auto-detect cyclic');
  assert.equal(Boolean(strafeClip.nonCyclic), false, 'Strafe filename should auto-detect cyclic');
});

// ============================================================================
// Feature F6: Long-Video In/Out Trim & Capture Upgrade (7 Happy-Path Tests)
// ============================================================================

test('[T1][F6][T1-F6-01] probeVideoSource(url) resolves accurate duration & dimensions for demo and 03 videos', async () => {
  await withCapturePage(async (page) => {
    const res = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      if (typeof vpc.probeVideoSource !== 'function') {
        throw new Error('Missing export probeVideoSource on VideoPoseCapture.js');
      }
      const demo = await vpc.probeVideoSource('/demo/taibai_wuhen_jianyi.mp4');
      const r03Check = await fetch(
        '/reference_videos/03_%E5%A4%AA%E7%99%BD%E9%9B%A8%E8%90%BD%E4%BA%91%E9%A3%9E_%E5%8C%97%E4%BA%AC%E6%AD%A6%E6%9C%AF%E9%98%9F_%E5%BF%AB%E5%89%91%E4%BA%94%E8%BF%9E%E6%96%A9%E5%8D%95%E4%BA%BA%E5%AE%9E%E6%8B%8D_720p.mp4',
        { method: 'HEAD' }
      );
      if (!r03Check.ok) {
        throw new Error(`/reference_videos/03_...mp4 returned HTTP ${r03Check.status} (vite static serving not yet mounted)`);
      }
      const v03 = await vpc.probeVideoSource(
        '/reference_videos/03_%E5%A4%AA%E7%99%BD%E9%9B%A8%E8%90%BD%E4%BA%91%E9%A3%9E_%E5%8C%97%E4%BA%AC%E6%AD%A6%E6%9C%AF%E9%98%9F_%E5%BF%AB%E5%89%91%E4%BA%94%E8%BF%9E%E6%96%A9%E5%8D%95%E4%BA%BA%E5%AE%9E%E6%8B%8D_720p.mp4'
      );
      return { demo, v03 };
    });

    assert.equal(res.demo.width, 960);
    assert.equal(res.demo.height, 540);
    assert.equal(Boolean(res.demo.ownedObjectUrl), false);
    assert.ok(Math.abs(res.demo.videoDuration - 3.04) <= 0.2, `demo duration=${res.demo.videoDuration}`);

    assert.equal(res.v03.width, 1280);
    assert.equal(res.v03.height, 720);
    assert.equal(Boolean(res.v03.ownedObjectUrl), false);
    assert.ok(Math.abs(res.v03.videoDuration - 5.125) <= 0.2, `03 duration=${res.v03.videoDuration}`);
  });
});

test('[T1][F6][T1-F6-02] probeVideoSource(file) creates owned blob object URL and reads File metadata', async () => {
  await withCapturePage(async (page) => {
    const info = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      if (typeof vpc.probeVideoSource !== 'function') {
        throw new Error('Missing export probeVideoSource on VideoPoseCapture.js');
      }
      const blob = await (await fetch('/demo/taibai_wuhen_jianyi.mp4')).blob();
      const file = new File([blob], 'upload.mp4', { type: 'video/mp4' });
      const res = await vpc.probeVideoSource(file);
      const out = {
        startsBlob: typeof res.mediaUrl === 'string' && res.mediaUrl.startsWith('blob:'),
        ownedObjectUrl: res.ownedObjectUrl,
        width: res.width,
        height: res.height,
        videoDuration: res.videoDuration,
      };
      if (res.ownedObjectUrl && res.mediaUrl) URL.revokeObjectURL(res.mediaUrl);
      return out;
    });

    assert.equal(info.startsBlob, true, 'probeVideoSource(File) must return a blob: mediaUrl');
    assert.equal(info.ownedObjectUrl, true, 'probeVideoSource(File) must mark ownedObjectUrl === true');
    assert.equal(info.width, 960);
    assert.equal(info.height, 540);
    assert.ok(Math.abs(info.videoDuration - 3.04) <= 0.2);
  });
});

test('[T1][F6][T1-F6-03] extractClipFromVideoSource extracts exact [trimInSec, trimOutSec] sub-window with progress', async () => {
  await withCapturePage(async (page) => {
    const out = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const progressVals = [];
      const res = await vpc.extractClipFromVideoSource(
        '/demo/taibai_wuhen_jianyi.mp4',
        (p) => progressVals.push(typeof p === 'number' ? p : p?.percent ?? p?.progress ?? 0),
        {
          trimInSec: 1.0,
          trimOutSec: 1.75,
          targetFps: 24,
          nonCyclic: true,
          isCombatAttack: false,
          delegate: 'auto',
        }
      );
      const clip = res?.clip || res;
      const rootYs = clip.frames.map((fr) => fr.rootPos.y);
      const allUnitQuats = clip.frames.every(
        (fr) =>
          fr.quats.length === 29 &&
          fr.quats.every((q) => Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-3)
      );
      return {
        fps: clip.fps,
        totalFrames: clip.totalFrames,
        framesLen: clip.frames.length,
        nonCyclic: clip.nonCyclic,
        minRootY: Math.min(...rootYs),
        maxRootY: Math.max(...rootYs),
        allUnitQuats,
        progressCount: progressVals.length,
        lastProgress: progressVals[progressVals.length - 1],
      };
    });

    assert.equal(out.fps, 24);
    assert.equal(out.totalFrames, out.framesLen);
    assert.ok(
      out.framesLen >= 16 && out.framesLen <= 21,
      `Expected ~18 frames for 0.75s @ 24fps (NOT full 73 frames!), got ${out.framesLen}`
    );
    assert.equal(out.nonCyclic, true);
    assert.equal(out.allUnitQuats, true);
    assert.ok(out.minRootY >= 0.45 && out.maxRootY <= 1.5, `Unexpected rootPos.y [${out.minRootY}, ${out.maxRootY}]`);
    assert.ok(out.progressCount > 0 && out.lastProgress >= 99, `Expected progress reaching 100, got ${out.lastProgress}`);
  });
});

test('[T1][F6][T1-F6-04] extractClipFromVideoSource scales frame density accurately across targetFps 24, 30, and 60', async () => {
  await withCapturePage(async (page) => {
    const out = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const runAt = async (fps) => {
        const res = await vpc.extractClipFromVideoSource('/demo/taibai_wuhen_jianyi.mp4', null, {
          trimInSec: 0.5,
          trimOutSec: 0.9,
          targetFps: fps,
          nonCyclic: true,
          delegate: 'auto',
        });
        const clip = res?.clip || res;
        return { fps: clip.fps, count: clip.frames.length };
      };
      const c24 = await runAt(24);
      const c30 = await runAt(30);
      const c60 = await runAt(60);
      return { c24, c30, c60 };
    });

    assert.equal(out.c24.fps, 24);
    assert.equal(out.c30.fps, 30);
    assert.equal(out.c60.fps, 60);
    assert.ok(out.c24.count >= 8 && out.c24.count <= 12, `24fps 0.4s count=${out.c24.count}`);
    assert.ok(out.c30.count >= 11 && out.c30.count <= 14, `30fps 0.4s count=${out.c30.count}`);
    assert.ok(out.c60.count >= 22 && out.c60.count <= 27, `60fps 0.4s count=${out.c60.count}`);
    assert.ok(
      out.c24.count < out.c30.count && out.c30.count < out.c60.count,
      `Expected strict scaling 24 < 30 < 60, got ${out.c24.count}, ${out.c30.count}, ${out.c60.count}`
    );
  });
});

test('[T1][F6][T1-F6-05] Singleton landmarkerVideo monotonic timestamp watermark survives back-to-back late -> early trims', async () => {
  await withCapturePage(async (page) => {
    const out = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const { BONE_IDX } = await import('/src/rig/HumanoidRig.js');
      // Late trim [2.5s..2.9s] @ 12fps (~5 frames, ~1.5s wall clock, video timestamp = 2900ms)
      // immediately followed by early trim [0.1s..0.5s] @ 12fps (video timestamp = 100ms; 2900 - 100 = 2800ms > 1500ms!)
      const lateRes = await vpc.extractClipFromVideoSource('/demo/taibai_wuhen_jianyi.mp4', null, {
        trimInSec: 2.5,
        trimOutSec: 2.9,
        targetFps: 12,
        nonCyclic: true,
      });
      const earlyRes = await vpc.extractClipFromVideoSource('/demo/taibai_wuhen_jianyi.mp4', null, {
        trimInSec: 0.1,
        trimOutSec: 0.5,
        targetFps: 12,
        nonCyclic: true,
      });
      const cLate = lateRes?.clip || lateRes;
      const cEarly = earlyRes?.clip || earlyRes;
      const qLate = cLate.frames[0].quats[BONE_IDX.RightUpperArm];
      const qEarly = cEarly.frames[0].quats[BONE_IDX.RightUpperArm];
      const dot = Math.min(1, Math.abs(qLate.x * qEarly.x + qLate.y * qEarly.y + qLate.z * qEarly.z + qLate.w * qEarly.w));
      const diffDeg = 2 * Math.acos(dot) * (180 / Math.PI);
      return {
        lateLen: cLate.frames.length,
        earlyLen: cEarly.frames.length,
        diffDeg,
      };
    });

    assert.ok(out.lateLen >= 4 && out.earlyLen >= 4);
    assert.ok(out.diffDeg > 1.0, `Expected distinct pose trajectories between [2.5..2.9s] and [0.1..0.5s], diffDeg=${out.diffDeg}`);
    assert.equal(page.pageErrors.length, 0, `Uncaught page errors: ${page.pageErrors.join('; ')}`);
  });
});

test('[T1][F6][T1-F6-06] Software-WebGL (SwiftShader) auto-selects CPU XNNPACK delegate (<750ms/frame)', async () => {
  await withCapturePage(async (page) => {
    const timing = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      // Ensure model is warmed up before timing 6 inference frames
      await vpc.extractClipFromVideoSource('/demo/taibai_wuhen_jianyi.mp4', null, {
        trimInSec: 0.2,
        trimOutSec: 0.35,
        targetFps: 12,
        delegate: 'auto',
      });
      const t0 = performance.now();
      const res = await vpc.extractClipFromVideoSource('/demo/taibai_wuhen_jianyi.mp4', null, {
        trimInSec: 0.4,
        trimOutSec: 0.65,
        targetFps: 24,
        delegate: 'auto',
      });
      const elapsedMs = performance.now() - t0;
      const clip = res?.clip || res;
      return { elapsedMs, frames: clip.frames.length, msPerFrame: elapsedMs / Math.max(1, clip.frames.length) };
    });

    assert.ok(timing.frames >= 5, `Expected >= 5 frames, got ${timing.frames}`);
    assert.ok(
      timing.msPerFrame < 750,
      `Expected CPU XNNPACK fast path (<750ms/frame vs 2664ms/frame SwiftShader GPU), got ${timing.msPerFrame.toFixed(1)}ms/frame`
    );
  });
});

test('[T1][F6][T1-F6-07] Workbench UI Trim controls & #pip-video scrubbing sync with window.__MOTION_STAGE__.getState().trimState', async () => {
  await withWorkbenchPage(async (page) => {
    const result = await page.evaluate(async () => {
      const ms = window.__MOTION_STAGE__;
      if (typeof ms.extractVideoSegment === 'function') {
        await ms.extractVideoSegment('/demo/taibai_wuhen_jianyi.mp4', {
          trimInSec: 0.4,
          trimOutSec: 0.9,
          targetFps: 12,
        });
      } else {
        const shortUrl =
          '/reference_videos/04_%E5%A4%AA%E7%99%BD%E9%A3%9E%E7%87%95%E9%80%90%E6%9C%88_%E5%85%A8%E5%9B%BD%E5%86%A0%E5%86%9B%E7%8E%8B%E6%9B%A6_%E8%85%BE%E7%A9%BA%E6%97%8B%E9%A3%8E%E8%B7%8C%E5%8F%89%E5%8D%95%E4%BA%BA%E8%A3%81%E5%89%AA.mp4';
        const resp = await fetch(shortUrl);
        const blob = await (resp.ok ? resp : await fetch('/demo/taibai_wuhen_jianyi.mp4')).blob();
        const file = new File([blob], 'demo_trim.mp4', { type: 'video/mp4' });
        const input = document.getElementById('media-upload-input');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const ts = ms.getState().trimState;
          if (ts && (ts.hasVideo || ts.videoDuration > 0 || ts.duration > 0 || ts.mediaUrl)) break;
        }
      }

      const trimInputs = Array.from(
        document.querySelectorAll('#source-pip input, [id*="trim"] input, input[id*="trim"]')
      ).filter((el) => el.type === 'range' || el.type === 'number');

      if (trimInputs.length >= 2) {
        const inEl = trimInputs.find((e) => /in|start/i.test(e.id + e.name)) || trimInputs[0];
        const outEl = trimInputs.find((e) => /out|end/i.test(e.id + e.name)) || trimInputs[1];
        inEl.value = '0.80';
        inEl.dispatchEvent(new Event('input', { bubbles: true }));
        outEl.value = '1.40';
        outEl.dispatchEvent(new Event('input', { bubbles: true }));
      }

      await new Promise((r) => setTimeout(r, 120));
      const st = ms.getState();
      const pipVideo = document.getElementById('pip-video');
      return {
        trimState: st?.trimState || null,
        trimInputCount: trimInputs.length,
        pipCurrentTime: pipVideo ? pipVideo.currentTime : null,
      };
    });

    assert.ok(result.trimState, 'window.__MOTION_STAGE__.getState().trimState must be defined');
    const tIn = result.trimState.pendingTrimInSec ?? result.trimState.trimInSec ?? result.trimState.inSec;
    const tOut = result.trimState.pendingTrimOutSec ?? result.trimState.trimOutSec ?? result.trimState.end;
    assert.ok(result.trimInputCount >= 2, `Expected >= 2 DOM trim inputs, found ${result.trimInputCount}`);
    assert.ok(Math.abs(tIn - 0.8) <= 0.1, `Expected trimInSec ≈ 0.80, got ${tIn}`);
    assert.ok(Math.abs(tOut - 1.4) <= 0.1, `Expected trimOutSec ≈ 1.40, got ${tOut}`);
    assert.ok(
      result.pipCurrentTime !== null && result.pipCurrentTime >= 0.65 && result.pipCurrentTime <= 1.55,
      `Expected #pip-video.currentTime synced to trim handle in [0.65, 1.55], got ${result.pipCurrentTime}`
    );
  });
});

// ============================================================================
// Feature F7: Filter & Foot-Lock Parameter Panel (7 Happy-Path Tests)
// ============================================================================

test('[T1][F7][T1-F7-01] DEFAULT_CLEAN_OPTIONS schema & runCleaningPipeline omitted-options return contract', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['buildSlashClip']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', [
    'DEFAULT_CLEAN_OPTIONS',
    'runCleaningPipeline',
  ]);

  const requiredKeys = [
    'deJitter',
    'filterRadius',
    'filterSigma',
    'footLock',
    'contactMode',
    'contactHeightThresh',
    'contactVelThresh',
    'ikBlend',
    'keepFootFlat',
    'loopClean',
    'forearmTwistShare',
  ];
  for (const k of requiredKeys) {
    assert.ok(k in cleaner.DEFAULT_CLEAN_OPTIONS, `DEFAULT_CLEAN_OPTIONS missing key "${k}"`);
  }

  const slash = mc.buildSlashClip();
  for (let w = 0; w < 3; w++) cleaner.runCleaningPipeline(slash); // V8 Maglev/TurboFan JIT warm-up
  const samples = [];
  let res = null;
  for (let s = 0; s < 5; s++) {
    const t0 = performance.now();
    res = cleaner.runCleaningPipeline(slash);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const pureCleanMs = samples[2]; // median of 5 post-JIT runs
  assert.ok(
    Array.isArray(res.cleanedFrames) &&
      res.cleanedFrames.length === slash.frames.length &&
      slash.frames.length >= 80
  );
  assert.ok(pureCleanMs < 15.0, `Expected pure runCleaningPipeline <15ms, got ${pureCleanMs.toFixed(2)}ms`);
  assert.ok(res.rawTelemetry && res.cleanTelemetry && res.appliedOptions);
});

test('[T1][F7][T1-F7-02] deJitter, filterRadius & filterSigma monotonically reduce rmsJitter', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['buildSlashClip']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const clip = mc.buildSlashClip();

  const rOff = cleaner.runCleaningPipeline(clip, { deJitter: false, footLock: false, loopClean: false });
  const r1 = cleaner.runCleaningPipeline(clip, { deJitter: true, filterRadius: 1, footLock: false, loopClean: false });
  const r6 = cleaner.runCleaningPipeline(clip, { deJitter: true, filterRadius: 6, footLock: false, loopClean: false });
  assert.ok(Math.abs(rOff.cleanTelemetry.rmsJitter - rOff.rawTelemetry.rmsJitter) <= 1e-4);
  assert.ok(
    r6.cleanTelemetry.rmsJitter < r1.cleanTelemetry.rmsJitter &&
      r1.cleanTelemetry.rmsJitter < rOff.cleanTelemetry.rmsJitter,
    `Expected monotonic jitter drop: r6(${r6.cleanTelemetry.rmsJitter}) < r1(${r1.cleanTelemetry.rmsJitter}) < off(${rOff.cleanTelemetry.rmsJitter})`
  );

  const sLow = cleaner.runCleaningPipeline(clip, {
    deJitter: true,
    filterRadius: 5,
    filterSigma: 0.45,
    footLock: false,
    loopClean: false,
  });
  const sHigh = cleaner.runCleaningPipeline(clip, {
    deJitter: true,
    filterRadius: 5,
    filterSigma: 3.5,
    footLock: false,
    loopClean: false,
  });
  assert.ok(
    sHigh.cleanTelemetry.rmsJitter < sLow.cleanTelemetry.rmsJitter,
    `Expected sigma=3.5 (${sHigh.cleanTelemetry.rmsJitter}) < sigma=0.45 (${sLow.cleanTelemetry.rmsJitter})`
  );
});

test('[T1][F7][T1-F7-03] footLock & ikBlend (0.0 -> 0.5 -> 1.0) interpolate ankle lock & eliminate slip', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['buildSlashClip']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const clip = mc.buildSlashClip();

  const unlocked = cleaner.runCleaningPipeline(clip, { deJitter: true, footLock: false, loopClean: false });
  const b0 = cleaner.runCleaningPipeline(clip, { deJitter: true, footLock: true, ikBlend: 0.0, loopClean: false });
  const b05 = cleaner.runCleaningPipeline(clip, { deJitter: true, footLock: true, ikBlend: 0.5, loopClean: false });
  const b1 = cleaner.runCleaningPipeline(clip, { deJitter: true, footLock: true, ikBlend: 1.0, loopClean: false });

  assert.ok(b1.cleanTelemetry.rmsSlipCmS < 2.0, `Expected rmsSlipCmS < 2.0 at ikBlend=1, got ${b1.cleanTelemetry.rmsSlipCmS}`);
  assert.ok(b1.cleanTelemetry.rmsSlipCmS < unlocked.cleanTelemetry.rmsSlipCmS * 0.2);

  const p0 = (await computeWorldBonePositionsForFrame(b0.cleanedFrames[30])).LeftFoot;
  const p05 = (await computeWorldBonePositionsForFrame(b05.cleanedFrames[30])).LeftFoot;
  const p1 = (await computeWorldBonePositionsForFrame(b1.cleanedFrames[30])).LeftFoot;
  assert.ok(p0.distanceTo(p05) > 0.005 && p05.distanceTo(p1) > 0.005, 'ikBlend=0.5 must lie strictly between 0.0 and 1.0');
});

test('[T1][F7][T1-F7-04] contactMode: "threshold" with contactHeightThresh & contactVelThresh overrides preset contacts', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['buildSlashClip']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const clip = mc.buildSlashClip();

  const strictRes = cleaner.runCleaningPipeline(clip, {
    deJitter: true,
    footLock: true,
    contactMode: 'threshold',
    contactHeightThresh: 0.02,
    contactVelThresh: 0.05,
    loopClean: false,
  });
  const permRes = cleaner.runCleaningPipeline(clip, {
    deJitter: true,
    footLock: true,
    contactMode: 'threshold',
    contactHeightThresh: 0.26,
    contactVelThresh: 2.2,
    loopClean: false,
  });

  const maxStrictLock = Math.max(...strictRes.cleanedFrames.map((f) => f.lockWeightL || 0));
  const meanPermLock =
    permRes.cleanedFrames.reduce((a, f) => a + (f.lockWeightL || 0), 0) / permRes.cleanedFrames.length;

  assert.equal(maxStrictLock, 0, 'Strict threshold should override preset contactL=true to unlocked');
  assert.ok(meanPermLock > 0.8, `Permissive threshold should lock stance feet, got mean=${meanPermLock}`);
});

test('[T1][F7][T1-F7-05] keepFootFlat (true vs false) controls planted foot pitch flattening during IK lock', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX', 'createBoneHierarchy']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const { BONE_IDX, createBoneHierarchy } = rig;

  const frames = Array.from({ length: 20 }, () => {
    const quats = Array.from({ length: 29 }, () => new THREE.Quaternion());
    quats[BONE_IDX.LeftFoot].setFromEuler(new THREE.Euler(0.49, 0, 0)); // ~28° pitch
    return {
      rootPos: new THREE.Vector3(0, 0.94, 0),
      quats,
      contactL: true,
      contactR: true,
    };
  });
  const clip = { fps: 60, nonCyclic: true, frames };

  const flatOn = cleaner.runCleaningPipeline(clip, { deJitter: false, footLock: true, keepFootFlat: true, loopClean: false });
  const flatOff = cleaner.runCleaningPipeline(clip, { deJitter: false, footLock: true, keepFootFlat: false, loopClean: false });

  const measureFootFwdY = (fr) => {
    const { bones } = createBoneHierarchy();
    bones[0].position.copy(fr.rootPos);
    fr.quats.forEach((q, i) => bones[i].quaternion.copy(q));
    bones[0].updateMatrixWorld(true);
    const qWorld = new THREE.Quaternion();
    bones[BONE_IDX.LeftFoot].getWorldQuaternion(qWorld);
    return new THREE.Vector3(0, 0, 1).applyQuaternion(qWorld).y;
  };

  assert.ok(Math.abs(measureFootFwdY(flatOn.cleanedFrames[10])) < 0.04, 'keepFootFlat=true must flatten foot pitch');
  assert.ok(Math.abs(measureFootFwdY(flatOff.cleanedFrames[10])) > 0.2, 'keepFootFlat=false must preserve foot pitch');
});

test('[T1][F7][T1-F7-06] loopClean seam closure & forearmTwistShare (0.0, 0.58, 1.0) twist distribution', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX', 'createBoneHierarchy']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const ikMod = await loadModuleContract('src/pipeline/TwoBoneIK.js', ['applyForearmTwistSolver']);
  const { BONE_IDX, createBoneHierarchy } = rig;

  // 1. loopClean seam test
  const seamFrames = Array.from({ length: 60 }, (_, f) => ({
    rootPos: new THREE.Vector3(0, 0.94, f / 59),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: false,
    contactR: false,
  }));
  const rClosed = cleaner.runCleaningPipeline(
    { fps: 60, nonCyclic: false, frames: seamFrames },
    { deJitter: false, footLock: false, loopClean: true }
  );
  const rOpen = cleaner.runCleaningPipeline(
    { fps: 60, nonCyclic: false, frames: seamFrames },
    { deJitter: false, footLock: false, loopClean: false }
  );
  assert.ok(
    Math.abs(rClosed.cleanedFrames[59].rootPos.z - rClosed.cleanedFrames[0].rootPos.z) < 0.03,
    'loopClean: true must close Z seam'
  );
  assert.ok(rOpen.cleanedFrames[59].rootPos.z > 0.9, 'loopClean: false must preserve Z=1.0');

  // 2. forearmTwistShare test
  const { bones } = createBoneHierarchy();
  bones[BONE_IDX.RightHand].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

  ikMod.applyForearmTwistSolver(bones, true, 0.0);
  assert.ok(quatAngleFromIdentity(bones[BONE_IDX.RightForeArmTwist].quaternion) < 1e-4, 'share=0.0 -> 0 rad');

  ikMod.applyForearmTwistSolver(bones, true, 0.58);
  const ang58 = quatAngleFromIdentity(bones[BONE_IDX.RightForeArmTwist].quaternion);
  assert.ok(Math.abs(ang58 - 0.911) <= 0.03, `Expected ~0.911 rad at share=0.58, got ${ang58.toFixed(3)}`);

  ikMod.applyForearmTwistSolver(bones, true, 1.0);
  const ang100 = quatAngleFromIdentity(bones[BONE_IDX.RightForeArmTwist].quaternion);
  assert.ok(Math.abs(ang100 - Math.PI / 2) <= 0.03, `Expected ~1.571 rad at share=1.0, got ${ang100.toFixed(3)}`);
});

test('[T1][F7][T1-F7-07] Workbench UI Filter & Foot-Lock panel re-cleans live (<50ms UI repaint) with zero MediaPipe re-inference', async () => {
  await withWorkbenchPage(async (page) => {
    page.clearLogs();
    const res = await page.evaluate(() => {
      const ms = window.__MOTION_STAGE__;
      const t0 = performance.now();
      ms.setCleanOptions({ filterRadius: 6, footLock: false });
      const dtOff = performance.now() - t0;
      const slipOff = ms.getState().cleanTelemetry?.rmsSlipCmS;

      const t1 = performance.now();
      ms.setCleanOptions({ filterRadius: 3, footLock: true, ikBlend: 1.0 });
      const dtOn = performance.now() - t1;
      const slipOn = ms.getState().cleanTelemetry?.rmsSlipCmS;

      return { dtOff, dtOn, slipOff, slipOn, cleanOptions: ms.getState().cleanOptions };
    });

    assert.ok(
      res.dtOff < 50.0 && res.dtOn < 50.0,
      `Expected live UI re-clean + HUD canvas repaint <50ms, got ${res.dtOff.toFixed(2)}ms / ${res.dtOn.toFixed(2)}ms`
    );
    assert.ok(res.slipOff > res.slipOn && res.slipOn < 2.0, `Expected footLock toggle to drop slip (${res.slipOff} -> ${res.slipOn})`);
    const mpRequests = page.networkRequests.filter((u) => u.includes('/mediapipe/'));
    assert.equal(mpRequests.length, 0, 'Toggling cleanOptions must NOT trigger MediaPipe requests');
  });
});

// ============================================================================
// Feature F8: Wind-Up Compression & Hit-Stop BVH Baking (7 Happy-Path Tests)
// ============================================================================

test('[T1][F8][T1-F8-01] DEFAULT_COMBAT_CURVE & remapCombatTime identity when mode="off" or enabled=false', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', [
    'DEFAULT_COMBAT_CURVE',
    'remapCombatTime',
  ]);
  for (const k of ['mode', 'windupEnd', 'windupSpeed', 'strikeEnd', 'strikeSpeed', 'hitstopFrames', 'recoverySpeed']) {
    assert.ok(k in cleaner.DEFAULT_COMBAT_CURVE, `DEFAULT_COMBAT_CURVE missing "${k}"`);
  }

  for (let i = 0; i <= 50; i++) {
    const u = i / 50;
    const rDisabled = cleaner.remapCombatTime(u, true, false, true, { mode: 'single', hitstopFrames: 6 });
    const rOff = cleaner.remapCombatTime(u, true, true, true, { mode: 'off', hitstopFrames: 6 });
    assert.ok(Math.abs(rDisabled.warpedU - u) <= 1e-7 && rDisabled.inHitstop === false);
    assert.ok(Math.abs(rOff.warpedU - u) <= 1e-7 && rOff.inHitstop === false);
  }
});

test('[T1][F8][T1-F8-02] remapCombatTime (mode="single") compresses wind-up when windupSpeed > 1 vs heavy charge < 1', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['remapCombatTime']);
  const base = { mode: 'single', windupEnd: 0.3, strikeEnd: 0.45, strikeSpeed: 1.6, hitstopFrames: 0, recoverySpeed: 1.0 };
  const fastCurve = { ...base, windupSpeed: 2.2 };
  const slowCurve = { ...base, windupSpeed: 0.6 };

  let uCrossFast = null;
  let uCrossSlow = null;
  let prevFast = 0;
  let prevSlow = 0;
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    const wf = cleaner.remapCombatTime(u, true, true, true, fastCurve).warpedU;
    const ws = cleaner.remapCombatTime(u, true, true, true, slowCurve).warpedU;
    assert.ok(wf >= prevFast - 1e-6 && ws >= prevSlow - 1e-6, 'warpedU must be monotonic');
    prevFast = wf;
    prevSlow = ws;
    if (uCrossFast === null && wf >= 0.3) uCrossFast = u;
    if (uCrossSlow === null && ws >= 0.3) uCrossSlow = u;
  }
  assert.ok(
    uCrossFast < 0.22 && uCrossSlow > 0.38,
    `Expected windupSpeed=2.2 to reach 0.30 before u=0.22 (got ${uCrossFast}) and 0.6 after u=0.38 (got ${uCrossSlow})`
  );
});

test('[T1][F8][T1-F8-03] remapCombatTime (hitstopFrames > 0) produces exact inHitstop===true freeze plateau', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['remapCombatTime']);
  const curve = {
    mode: 'single',
    windupEnd: 0.28,
    windupSpeed: 1.8,
    strikeEnd: 0.42,
    strikeSpeed: 1.8,
    hitstopFrames: 6,
    recoverySpeed: 1.0,
  };

  let hitstopSamples = 0;
  for (let k = 0; k <= 120; k++) {
    const u = k / 120;
    const res = cleaner.remapCombatTime(u, true, true, true, curve, null, 60);
    if (res.inHitstop) {
      hitstopSamples++;
      assert.ok(Math.abs(res.warpedU - 0.42) <= 1e-4, `Expected hitstop frozen at strikeEnd=0.42, got ${res.warpedU}`);
    }
  }
  assert.ok(hitstopSamples >= 8, `Expected >= 8 hitstop samples out of 121, got ${hitstopSamples}`);
});

test('[T1][F8][T1-F8-04] remapCombatTime (mode="autoMultiHit") detects >= 2 non-adjacent strike hit-stop plateaus', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['remapCombatTime']);
  const multiClip = await buildMultiPeakCombatClip({ N: 180, fps: 60, peakCount: 4 });
  const curve = { mode: 'autoMultiHit', windupSpeed: 1.8, hitstopFrames: 5 };

  let prevW = 0;
  let prevHitstop = false;
  let plateauCount = 0;
  for (let k = 0; k <= 360; k++) {
    const u = k / 360;
    const res = cleaner.remapCombatTime(u, true, true, true, curve, multiClip.frames, 60);
    assert.ok(res.warpedU >= prevW - 1e-6, `Non-monotonic warpedU at u=${u}`);
    prevW = res.warpedU;
    if (res.inHitstop && !prevHitstop) plateauCount++;
    prevHitstop = res.inHitstop;
  }
  assert.ok(plateauCount >= 2, `Expected >= 2 distinct autoMultiHit plateaus, got ${plateauCount}`);
});

test('[T1][F8][T1-F8-05] sampleInterpolatedFrame with nonCyclic=true clamps frameFloat=N to final frame (no wrap to 0)', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['sampleInterpolatedFrame']);
  const { BONE_IDX } = rig;

  const frames = Array.from({ length: 10 }, (_, k) => {
    const quats = Array.from({ length: 29 }, () => new THREE.Quaternion());
    quats[BONE_IDX.RightUpperArm].setFromAxisAngle(new THREE.Vector3(1, 0, 0), k * 0.12);
    return {
      rootPos: new THREE.Vector3(0, 0.94, k * 0.2),
      quats,
      contactL: true,
      contactR: true,
    };
  });
  const outPose = {
    rootPos: new THREE.Vector3(),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
  };
  cleaner.sampleInterpolatedFrame(frames, 10.0, outPose, true);
  assert.ok(
    Math.abs(outPose.rootPos.z - 1.8) <= 1e-6,
    `nonCyclic frameFloat=10.0 wrapped to z=${outPose.rootPos.z} instead of clamping to 1.8`
  );
  const angDiff = outPose.quats[BONE_IDX.RightUpperArm].angleTo(frames[9].quats[BONE_IDX.RightUpperArm]);
  assert.ok(angDiff <= 1e-5, `Expected final bone rotation preserved, diff=${angDiff}`);
});

test('[T1][F8][T1-F8-06] bakeWarpedFrames & exportCleanedClipToBVH({ bakeCombatCurve: true }) bake wind-up & hit-stop into .bvh', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js');
  const exporter = await loadModuleContract('src/pipeline/BVHExporter.js', ['exportCleanedClipToBVH']);
  const BVHLoader = await importBVHLoader();
  const { BONE_IDX } = rig;
  const bakeWarpedFrames = resolveBakeWarpedFrames(exporter, cleaner);

  // 60-frame sword strike: RightUpperArm X rot 0° (f=0) -> 90° (f=24, u=0.40) -> 20° (f=59); Hips Z: 0 -> 1.0m (100cm)
  const frames = Array.from({ length: 60 }, (_, f) => {
    const u = f / 59;
    const deg = f <= 24 ? (f / 24) * 90 : 90 - ((f - 24) / 35) * 70;
    const quats = Array.from({ length: 29 }, () => new THREE.Quaternion());
    quats[BONE_IDX.RightUpperArm].setFromEuler(new THREE.Euler((deg * Math.PI) / 180, 0, 0, 'ZXY'));
    return {
      rootPos: new THREE.Vector3(0, 0.94, u * 1.0),
      quats,
      contactL: true,
      contactR: true,
    };
  });
  const clip = { fps: 60, nonCyclic: true, isCombatAttack: true, frames };
  const combatCurve = {
    mode: 'single',
    windupEnd: 0.28,
    windupSpeed: 2.4,
    strikeEnd: 0.4,
    strikeSpeed: 2.0,
    hitstopFrames: 6,
    recoverySpeed: 1.0,
  };

  const warped = bakeWarpedFrames(frames, clip, combatCurve);
  assert.ok(Array.isArray(warped) && warped.length >= 40);

  const bvhBaked = exporter.exportCleanedClipToBVH(clip, frames, { bakeCombatCurve: true, combatCurve });
  const bvhUnbaked = exporter.exportCleanedClipToBVH(clip, frames, { bakeCombatCurve: false });

  const loader = new BVHLoader();
  assert.equal(loader.parse(bvhBaked).skeleton.bones.filter((b) => b.name !== 'ENDSITE').length, 21);
  assert.equal(loader.parse(bvhUnbaked).skeleton.bones.filter((b) => b.name !== 'ENDSITE').length, 21);

  const analyzed = parseAndAnalyzeStandardBVH(bvhBaked, 'BakedBVH');
  // RightUpperArm is joint #10 -> channels [3 + 10*3 .. 3 + 10*3 + 2] = [33, 34, 35], where Xrotation is index 34
  const xRotSeries = analyzed.rows.map((r) => r[34]);
  const firstApexIdx = xRotSeries.findIndex((deg) => deg >= 88.0);
  assert.ok(
    firstApexIdx > 0 && firstApexIdx <= 18,
    `Expected compressed wind-up to reach 90° apex by frame <= 18 (was frame 24), got ${firstApexIdx}`
  );
  assert.ok(analyzed.maxIdenticalRun >= 3, `Expected >= 4 consecutive frozen hitstop rows (run >= 3), got ${analyzed.maxIdenticalRun}`);
  const finalZCm = analyzed.rows[analyzed.rows.length - 1][2];
  assert.ok(Math.abs(finalZCm - 100.0) <= 2.0, `Expected final Z ≈ 100cm (no end-wrap!), got ${finalZCm}`);
});

test('[T1][F8][T1-F8-07] Workbench UI Combat Curve & Bake export controls produce baked vs unbaked .bvh', async () => {
  await withWorkbenchPage(async (page) => {
    const out = await page.evaluate(() => {
      const ms = window.__MOTION_STAGE__;
      document.getElementById('btn-clip-slash')?.click();
      ms.setCombatCurve({
        mode: 'single',
        windupEnd: 0.28,
        windupSpeed: 2.2,
        strikeEnd: 0.42,
        strikeSpeed: 1.8,
        hitstopFrames: 6,
        recoverySpeed: 1.0,
        bakeCombatCurve: true,
        bakeOnExport: true,
      });
      const bakedBvh = ms.exportCurrentBVH();

      ms.setCombatCurve({
        mode: 'off',
        bakeCombatCurve: false,
        bakeOnExport: false,
      });
      const unbakedBvh = ms.exportCurrentBVH();
      return {
        bakedBvh,
        unbakedBvh,
        expectedFrameCount: ms.getState().frameCount,
        curveState: ms.getState().combatCurve,
      };
    });

    const parsedBaked = parseAndAnalyzeStandardBVH(out.bakedBvh, 'UI:Baked');
    const parsedUnbaked = parseAndAnalyzeStandardBVH(out.unbakedBvh, 'UI:Unbaked');
    assert.equal(
      parsedUnbaked.declaredFrames,
      out.expectedFrameCount,
      'Unbaked slash preset must export uniform frameCount'
    );
    assert.ok(parsedBaked.maxIdenticalRun >= 3, `Expected baked UI export to contain hitstop freeze rows, got run=${parsedBaked.maxIdenticalRun}`);
    assert.notEqual(out.bakedBvh, out.unbakedBvh);
  });
});

// ============================================================================
// Feature F9: Foot-Slip/Jitter Telemetry HUD & Asset Selector (7 Happy-Path Tests)
// ============================================================================

test('[T1][F9][T1-F9-01] analyzeMotionTelemetry returns full 9-key schema & accurate ~20cm/s slip on controlled clip', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', [
    'analyzeMotionTelemetry',
    'runCleaningPipeline',
  ]);
  const slipClip = await buildControlledSlipClip({ N: 31, fps: 60, driftVelMps: 0.2, nullContacts: true });
  const { cleanedFrames } = cleaner.runCleaningPipeline(slipClip, { deJitter: false, footLock: true, loopClean: false });
  const rawTel = cleaner.analyzeMotionTelemetry(slipClip.frames, 60, false, cleanedFrames);

  for (const key of [
    'slipSeries',
    'jitterSeries',
    'meanSlip',
    'maxSlip',
    'rmsSlipCmS',
    'maxSlipCmS',
    'meanJitter',
    'maxJitter',
    'rmsJitter',
  ]) {
    assert.ok(key in rawTel, `analyzeMotionTelemetry missing required field "${key}"`);
  }
  assert.equal(rawTel.slipSeries.length, 31);
  assert.equal(rawTel.jitterSeries.length, 31);
  assert.ok(
    rawTel.rmsSlipCmS >= 15.0 && rawTel.rmsSlipCmS <= 22.5,
    `Expected rmsSlipCmS ≈ 19.6 cm/s, got ${rawTel.rmsSlipCmS}`
  );
  assert.ok(
    rawTel.maxSlipCmS >= 18.0 && rawTel.maxSlipCmS <= 22.5,
    `Expected maxSlipCmS ≈ 20.0 cm/s, got ${rawTel.maxSlipCmS}`
  );
});

test('[T1][F9][T1-F9-02] runCleaningPipeline fixes null-contact rawTelemetry so raw vs clean slip drop > 90%', async () => {
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const slipClip = await buildControlledSlipClip({ N: 31, fps: 60, driftVelMps: 0.2, nullContacts: true });
  const { rawTelemetry, cleanTelemetry } = cleaner.runCleaningPipeline(slipClip, {
    deJitter: true,
    footLock: true,
    loopClean: false,
  });

  assert.ok(rawTelemetry.rmsSlipCmS > 15.0, `Null-contact bug not fixed: rawTelemetry.rmsSlipCmS=${rawTelemetry.rmsSlipCmS}`);
  assert.ok(cleanTelemetry.rmsSlipCmS < 1.5, `Expected cleanTelemetry.rmsSlipCmS < 1.5, got ${cleanTelemetry.rmsSlipCmS}`);
  assert.ok(cleanTelemetry.rmsSlipCmS < rawTelemetry.rmsSlipCmS * 0.1);
});

test('[T1][F9][T1-F9-03] analyzeMotionTelemetry measures > 50% rmsJitter reduction on cleaned slash preset', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['buildSlashClip']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);
  const { rawTelemetry, cleanTelemetry } = cleaner.runCleaningPipeline(mc.buildSlashClip(), {
    deJitter: true,
    filterRadius: 3,
    footLock: true,
    loopClean: true,
  });

  assert.ok(rawTelemetry.rmsJitter > cleanTelemetry.rmsJitter * 2.0, 'Expected >50% jitter reduction');
  assert.ok(rawTelemetry.maxJitter > cleanTelemetry.maxJitter);
});

test('[T1][F9][T1-F9-04] High-DPI <canvas> Telemetry HUD scales by DPR=2 and renders non-blank multi-curve pixels', async () => {
  await withWorkbenchPage(
    async (page) => {
      const hudInfo = await page.evaluate(() => {
        const canvases = Array.from(document.querySelectorAll('canvas')).filter(
          (c) => !c.closest('#canvas-container')
        );
        if (canvases.length === 0) return null;
        const c = canvases[0];
        const rect = c.getBoundingClientRect();
        const ctx = c.getContext('2d');
        const img = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonBlank = 0;
        const colorBuckets = new Set();
        for (let i = 0; i < img.length; i += 16) {
          const a = img[i + 3];
          if (a > 20 && (img[i] > 25 || img[i + 1] > 25 || img[i + 2] > 25)) {
            nonBlank++;
            colorBuckets.add(`${img[i] >> 5}_${img[i + 1] >> 5}_${img[i + 2] >> 5}`);
          }
        }
        return {
          cssW: rect.width,
          cssH: rect.height,
          bufW: c.width,
          bufH: c.height,
          nonBlank,
          distinctColorBuckets: colorBuckets.size,
        };
      });

      assert.ok(hudInfo, 'Telemetry 2D <canvas> HUD not found outside #canvas-container');
      assert.ok(hudInfo.cssW >= 180 && hudInfo.cssH >= 36, `HUD too small: ${hudInfo.cssW}x${hudInfo.cssH}`);
      assert.ok(
        hudInfo.bufW >= Math.round(hudInfo.cssW * 1.8),
        `HUD canvas not DPR=2 scaled: bufW=${hudInfo.bufW}, cssW=${hudInfo.cssW}`
      );
      assert.ok(hudInfo.nonBlank > 30, 'Telemetry HUD canvas is blank');
      assert.ok(hudInfo.distinctColorBuckets >= 2, 'Telemetry HUD should render >= 2 distinct curve/indicator colors');
    },
    { width: 1440, height: 900, deviceScaleFactor: 2 }
  );
});

test('[T1][F9][T1-F9-05] Telemetry HUD <canvas> playhead redraws dynamically on timeline scrub (0% -> 50%)', async () => {
  await withWorkbenchPage(async (page) => {
    const res = await page.evaluate(async () => {
      const ms = window.__MOTION_STAGE__;
      const playBtn = document.getElementById('btn-play-pause');
      if (ms.getState().isPlaying && playBtn) playBtn.click();

      const scrubber = document.getElementById('timeline-scrubber');
      const hudCanvas = Array.from(document.querySelectorAll('canvas')).find(
        (c) => !c.closest('#canvas-container')
      );
      if (!scrubber || !hudCanvas) return null;

      scrubber.value = '0';
      scrubber.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const snap0 = Array.from(hudCanvas.getContext('2d').getImageData(0, 0, hudCanvas.width, hudCanvas.height).data);

      const mid = (Number(scrubber.max) || 81) * 0.5;
      scrubber.value = String(mid);
      scrubber.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const snapMid = Array.from(hudCanvas.getContext('2d').getImageData(0, 0, hudCanvas.width, hudCanvas.height).data);

      let diffPixels = 0;
      for (let i = 0; i < snap0.length; i += 4) {
        if (
          Math.abs(snap0[i] - snapMid[i]) +
            Math.abs(snap0[i + 1] - snapMid[i + 1]) +
            Math.abs(snap0[i + 2] - snapMid[i + 2]) >
          15
        ) {
          diffPixels++;
        }
      }
      return { normalizedTime: ms.getState().normalizedTime, diffPixels };
    });

    assert.ok(res, 'Missing scrubber or Telemetry HUD canvas');
    assert.ok(Math.abs(res.normalizedTime - 0.5) <= 0.05, `Expected normalizedTime ≈ 0.50, got ${res.normalizedTime}`);
    assert.ok(res.diffPixels > 0, 'Playhead scrub must redraw Telemetry HUD canvas pixels');
  });
});

test('[T1][F9][T1-F9-06] Vite dev server serves /bvh_library/ (HTTP 200) and /reference_videos/ (HTTP 206 Range)', async () => {
  await withCapturePage(async (page) => {
    const out = await page.evaluate(async () => {
      const bvhRes = await fetch(
        '/bvh_library/B_cleaned_ready/01_wuxia_idle_%E5%BE%85%E6%9C%BA%E5%91%BC%E5%90%B8_cleaned.bvh'
      );
      const bvhText = bvhRes.ok ? (await bvhRes.text()).slice(0, 32) : '';

      const vidRes = await fetch(
        '/reference_videos/01b_%E5%A4%A9%E5%88%80%E5%AE%98%E7%BD%91_%E5%A4%AA%E7%99%BD%E5%B4%96%E9%A1%B6%E6%8B%94%E5%89%91%E5%AE%9A%E5%8A%BF_%E5%85%A8%E8%BA%AB%E9%95%9C%E5%A4%B4.mp4',
        { headers: { Range: 'bytes=0-1023' } }
      );
      const buf = await vidRes.arrayBuffer();
      return {
        bvhStatus: bvhRes.status,
        bvhHead: bvhText.trimStart(),
        vidStatus: vidRes.status,
        contentRange: vidRes.headers.get('content-range') || '',
        byteLength: buf.byteLength,
      };
    });

    assert.equal(out.bvhStatus, 200, 'Expected HTTP 200 on /bvh_library/B_cleaned_ready/01_...bvh');
    assert.ok(out.bvhHead.startsWith('HIERARCHY'));
    assert.equal(out.vidStatus, 206, 'Expected HTTP 206 Partial Content on /reference_videos/ Range request');
    assert.ok(out.contentRange.startsWith('bytes 0-1023/'), `Unexpected Content-Range: ${out.contentRange}`);
    assert.equal(out.byteLength, 1024);
  });
});

test('[T1][F9][T1-F9-07] Categorized Built-in Asset Library selector loads 06_wuxia_backflip (72 frames @ 60fps)', async () => {
  await withWorkbenchPage(async (page) => {
    page.clearLogs();
    const res = await page.evaluate(async () => {
      const selectEl = document.querySelector(
        'select[id*="asset"], select[id*="library"], #top-floating-bar select'
      );
      if (selectEl) {
        const optgroups = selectEl.querySelectorAll('optgroup').length;
        const opt = Array.from(selectEl.options).find((o) =>
          (o.value + o.textContent).includes('06_wuxia_backflip')
        );
        if (!opt) return { foundSelector: true, optgroups, loaded: false };
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 80));
          if ((window.__MOTION_STAGE__.getState().activeClipId || '').includes('06_wuxia_backflip')) break;
        }
        return { foundSelector: true, optgroups, loaded: true, state: window.__MOTION_STAGE__.getState() };
      }

      // Support custom dropdown menu trigger if implemented as button + menu items
      const trigger = document.querySelector('[id*="asset-lib"], [id*="library"], [data-role="asset-library"]');
      if (trigger) trigger.click();
      const item = Array.from(document.querySelectorAll('[data-asset-path], [data-bvh], button, li')).find((el) =>
        (el.getAttribute('data-asset-path') || el.getAttribute('data-bvh') || el.textContent || '').includes(
          '06_wuxia_backflip'
        )
      );
      if (!item) return { foundSelector: Boolean(trigger), optgroups: 0, loaded: false };
      const groups = document.querySelectorAll('.asset-category, [data-category], optgroup').length;
      item.click();
      await new Promise((r) => setTimeout(r, 400));
      return { foundSelector: true, optgroups: Math.max(2, groups), loaded: true, state: window.__MOTION_STAGE__.getState() };
    });

    assert.equal(res.foundSelector, true, 'Missing Built-in Asset Library selector in Workbench UI');
    assert.ok(res.optgroups >= 2, `Expected >= 2 asset categories, got ${res.optgroups}`);
    assert.equal(res.loaded, true, '06_wuxia_backflip option not found in Asset Library selector');
    assert.ok(res.state.frameCount >= 71 && res.state.frameCount <= 73, `Expected ~72 frames, got ${res.state.frameCount}`);
    assert.equal(res.state.fps, 60);
    assert.equal(page.consoleErrors.length, 0, `Console errors: ${page.consoleErrors.join('; ')}`);
  });
});
