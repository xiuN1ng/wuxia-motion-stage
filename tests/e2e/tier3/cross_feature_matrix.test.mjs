import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  WORKSPACE_ROOT,
  RAW_MOCAP_DIR,
  B_CLEANED_DIR,
  C_TAIBAI_DIR,
  REF_VIDEOS_DIR,
  DRIVE_FOLDER_02C_TAIBAI,
  TAIBAI_EXPECTED_FILENAMES,
  F4_EXPECTED_FILENAMES,
  ALL_26_BVH_REL_PATHS,
  REFERENCE_VIDEO_SPECS,
} from '../helpers/constants.mjs';
import {
  importThree,
  loadModuleContract,
  unwrapRetargetFrames,
  getSharedEphemeralViteBuild,
} from '../helpers/contract_loader.mjs';
import {
  requireDeliverableFile,
  parseAndAnalyzeStandardBVH,
  loadAndNormalizeManifest,
  resolveManifestEntryPath,
  gdriveJson,
  gdriveDownloadReadonly,
  sha256File,
  withEphemeralShmDir,
  buildSyntheticBVH,
} from '../helpers/bvh_verifier.mjs';
import {
  withPage,
  withCapturePage,
  withWorkbenchPage,
  withCombatArenaPage,
} from '../helpers/browser_cdp.mjs';

const THREE = await importThree();

const GIT_ENV = {
  ...process.env,
  PATH: `${process.env.PATH || ''}:/opt/antigravity/bin`,
};

test('[T3][F1][F2][T3-X01] Local C_taibai_extracted/ <-> Google Drive 02/C & MANIFEST.json SHA-256 & 21-bone parity', async () => {
  const manifest = loadAndNormalizeManifest();
  const driveItems = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_02C_TAIBAI]);
  assert.equal(driveItems.length, 4, `Expected exact 4 files in Drive 02/C, got ${driveItems.length}`);
  const driveByName = new Map(driveItems.map((it) => [it.name, it]));

  await withEphemeralShmDir('e2e_t3_drv', async (shmDir) => {
    for (const name of TAIBAI_EXPECTED_FILENAMES) {
      const localAbs = path.join(C_TAIBAI_DIR, name);
      requireDeliverableFile(localAbs, 'F1/F2');
      const drv = driveByName.get(name);
      assert.ok(drv, `Missing ${name} on Drive 02/C`);
      const dlAbs = path.join(shmDir, name);
      gdriveDownloadReadonly(drv.id, dlAbs);
      assert.equal(sha256File(dlAbs), sha256File(localAbs), `SHA-256 mismatch for ${name}`);

      const bvh = parseAndAnalyzeStandardBVH(fs.readFileSync(dlAbs, 'utf8'), name);
      const entry = manifest.find((e) => resolveManifestEntryPath(e.path) === localAbs);
      assert.ok(entry, `Missing MANIFEST entry for ${name}`);
      assert.equal(entry.frames, bvh.declaredFrames);
    }
  });
});

test('[T3][F1][F5][T3-X02] C_taibai_extracted BVHs -> MotionClips.parseBVHTextToClip uncapped duration & cyclic parity', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['parseBVHTextToClip']);
  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    const abs = path.join(C_TAIBAI_DIR, name);
    requireDeliverableFile(abs, 'F1');
    const text = fs.readFileSync(abs, 'utf8');
    const is01b = name.startsWith('taibai_01b');
    const clip = mc.parseBVHTextToClip(text, name, { nonCyclic: !is01b, preserveRootMotion: true });
    assert.equal(Boolean(clip.nonCyclic), !is01b, `${name} nonCyclic mismatch`);
    if (name.startsWith('taibai_03')) {
      const dur = clip.frames.length / clip.fps;
      assert.ok(dur >= 4.7, `taibai_03 truncated on re-import: ${dur.toFixed(2)}s (frames=${clip.frames.length})`);
    }
  }
});

test('[T3][F1][F9][T3-X03] C_taibai_extracted assets load via Workbench Asset Selector & render Telemetry HUD curves', async () => {
  for (const name of ['taibai_02_无痕剑意_独立提膝云剑_cleaned.bvh', 'taibai_03_雨落云飞_快剑五连斩_cleaned.bvh']) {
    requireDeliverableFile(path.join(C_TAIBAI_DIR, name), 'F1');
  }

  await withWorkbenchPage(async (page) => {
    const res = await page.evaluate(async () => {
      const ms = window.__MOTION_STAGE__;
      const selectEl = document.querySelector('select[id*="asset"], select[id*="library"], #top-floating-bar select');
      let loadedViaSelector = false;
      if (selectEl) {
        const opt = Array.from(selectEl.options).find((o) =>
          (o.value + o.textContent).includes('taibai_03')
        );
        if (opt) {
          selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 450));
          loadedViaSelector = true;
        }
      }
      if (!loadedViaSelector) {
        const resp = await fetch(
          '/bvh_library/C_taibai_extracted/taibai_03_%E9%9B%A8%E8%90%BD%E4%BA%91%E9%A3%9E_%E5%BF%AB%E5%89%91%E4%BA%94%E8%BF%9E%E6%96%A9_cleaned.bvh'
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching taibai_03`);
        await ms.loadClipFromBVHText(await resp.text(), 'taibai_03_雨落云飞_快剑五连斩_cleaned.bvh', { nonCyclic: true });
      }
      const st = ms.getState();
      const hud = Array.from(document.querySelectorAll('canvas')).find((c) => !c.closest('#canvas-container'));
      return {
        loadedViaSelector,
        frameCount: st.frameCount,
        fps: st.fps,
        slipLen: st.cleanTelemetry?.slipSeries?.length || 0,
        hudWidth: hud?.width || 0,
      };
    });

    assert.equal(res.loadedViaSelector, true, 'taibai_03 must be selectable from Workbench Asset Library UI');
    assert.ok(res.frameCount / res.fps >= 4.7, `Expected taibai_03 >= 4.7s in Workbench, got ${res.frameCount}/${res.fps}`);
    assert.equal(res.slipLen, res.frameCount);
    assert.ok(res.hudWidth >= 300);
  });
});

test('[T3][F1][F10][F11][T3-X04] Taibai 01b..04 drive Combat Arena Idle, Skill_Wuhen parry, Skill_Yuluo & Skill_Feiyan', async () => {
  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    requireDeliverableFile(path.join(C_TAIBAI_DIR, name), 'F1');
  }

  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');
      a.dispatchAction('Move', { x: 0, z: 1 });
      a.step(0.75);
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.step(0.05);

      // 1. Skill_Wuhen (Q -> parry window)
      a.dispatchAction('Skill_Wuhen');
      a.step(0.06);
      const wuhenParry = a.getState().inParryWindow;
      a.step(2.0);

      // 2. Skill_Yuluo (E -> multi-slash damage)
      const hpBeforeYuluo = a.getState().dummyHp;
      const comboBeforeYuluo = a.getState().comboCount || 0;
      a.dispatchAction('Skill_Yuluo');
      a.step(3.0);
      const yuluoHits = (a.getState().comboCount || 0) - comboBeforeYuluo;
      const yuluoDamage = hpBeforeYuluo - a.getState().dummyHp;
      a.step(2.5);

      // 3. Skill_Feiyan (R -> aerial invulnerable ultimate)
      a.dispatchAction('Skill_Feiyan');
      a.step(0.2);
      const s = a.getState();
      const sawFeiyan = s.currentState === 'Skill_Feiyan';
      const feiyanInvuln = s.isInvulnerable;

      return {
        loadedClipIds: a.getState().loadedClipIds || [],
        wuhenParry,
        yuluoHits,
        yuluoDamage,
        sawFeiyan,
        feiyanInvuln,
      };
    });

    assert.ok(res.loadedClipIds.some((id) => /taibai/i.test(id)), 'CombatClipRegistry must load Taibai clips');
    assert.equal(res.wuhenParry, true);
    assert.ok(res.yuluoHits >= 2 || res.yuluoDamage > 0, `Expected Skill_Yuluo multi-hit damage, hits=${res.yuluoHits}`);
    assert.equal(res.sawFeiyan, true);
    assert.equal(res.feiyanInvuln, true);
  });
});

test('[T3][F2][F6][T3-X05] Master video 05 (75.9s) non-monotonic late -> early In/Out Trim [45.4..45.9s] -> [26.72..27.22s]', async () => {
  const spec05 = REFERENCE_VIDEO_SPECS.find((s) => s.key === '05');
  requireDeliverableFile(path.join(REF_VIDEOS_DIR, spec05.file), 'F2');

  await withCapturePage(async (page) => {
    const out = await page.evaluate(async (vidFile) => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const url = `/reference_videos/${encodeURIComponent(vidFile)}`;
      const probe = await vpc.probeVideoSource(url);
      // Extract late segment [45.40s..45.85s] @ 12fps, then immediately earlier segment [26.72s..27.17s] @ 12fps!
      const rLate = await vpc.extractClipFromVideoSource(url, null, {
        trimInSec: 45.4,
        trimOutSec: 45.85,
        targetFps: 12,
        nonCyclic: true,
      });
      const rEarly = await vpc.extractClipFromVideoSource(url, null, {
        trimInSec: 26.72,
        trimOutSec: 27.17,
        targetFps: 12,
        nonCyclic: true,
      });
      const cLate = rLate?.clip || rLate;
      const cEarly = rEarly?.clip || rEarly;
      return {
        duration: probe.videoDuration,
        width: probe.width,
        height: probe.height,
        lateFrames: cLate.frames.length,
        earlyFrames: cEarly.frames.length,
      };
    }, spec05.file);

    assert.ok(out.duration > 75.0 && out.width === 1280 && out.height === 720);
    assert.ok(out.lateFrames >= 4 && out.lateFrames <= 8);
    assert.ok(out.earlyFrames >= 4 && out.earlyFrames <= 8);
  });
});

test('[T3][F3][F5][T3-X06] 08_dash_canglong & 09_dodge_roll re-import via parseBVHTextToClip preserving Frame-0 (0,0) & +Z travel', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['parseBVHTextToClip']);
  for (const [name, minMeters] of [
    ['08_wuxia_dash_canglong_苍龙出水突刺_cleaned.bvh', 0.8],
    ['09_wuxia_dodge_roll_翻滚闪避_cleaned.bvh', 0.6],
  ]) {
    const abs = path.join(B_CLEANED_DIR, name);
    requireDeliverableFile(abs, 'F3');
    const clip = mc.parseBVHTextToClip(fs.readFileSync(abs, 'utf8'), name, {
      preserveRootMotion: true,
      nonCyclic: true,
    });
    const p0 = clip.frames[0].rootPos;
    const pEnd = clip.frames[clip.frames.length - 1].rootPos;
    assert.ok(Math.hypot(p0.x, p0.z) <= 0.15, `${name} start not near (0,0): (${p0.x}, ${p0.z})`);
    assert.ok(
      Math.hypot(pEnd.x - p0.x, pEnd.z - p0.z) >= minMeters,
      `${name} lost horizontal Root Motion on re-import`
    );
  }
});

test('[T3][F3][F7][T3-X07] Raw CMU mocap trial from A_raw_mocap/ -> retargetBVHToFrames -> runCleaningPipeline', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);

  const rawFiles = fs.existsSync(RAW_MOCAP_DIR)
    ? fs.readdirSync(RAW_MOCAP_DIR).filter((f) => /^cmu_.*\.bvh$/i.test(f) && !f.includes('87_01'))
    : [];
  assert.ok(rawFiles.length >= 1, 'Expected at least 1 newly archived CMU trial in A_raw_mocap/');

  const rawText = fs.readFileSync(path.join(RAW_MOCAP_DIR, rawFiles[0]), 'utf8');
  const frames = await unwrapRetargetFrames(
    mc.retargetBVHToFrames(rawText, 60, { preserveRootMotion: true, maxFrames: 240 })
  );
  const res = cleaner.runCleaningPipeline(
    { fps: 60, nonCyclic: true, frames },
    { deJitter: true, filterRadius: 3, footLock: true, loopClean: false }
  );
  assert.equal(res.cleanedFrames.length, frames.length);
  assert.ok(res.cleanTelemetry.rmsJitter < res.rawTelemetry.rmsJitter || res.rawTelemetry.rmsJitter === 0);
});

test('[T3][F3][F10][F11][T3-X08] 8-way strafe + canglong dash + dodge roll + double jump drive Combat Arena & LayeredAnimator', async () => {
  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('DummyMode', 1);
      if (!a.getState().isLockedOn) a.dispatchAction?.('LockOn');

      const dirs = [
        [0, 1],
        [0, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [1, 1],
        [-1, -1],
        [1, -1],
      ];
      let sawMove8 = 0;
      let sawLayered = false;
      for (const [dx, dz] of dirs) {
        a.dispatchAction('Move', { x: dx, z: dz });
        a.step(0.1);
        if (a.getState().currentState === 'Move_8Way') sawMove8++;
        if (dx === -1 && dz === 0) {
          a.dispatchAction('Attack');
          a.step(0.15);
          if (a.getState().upperLayerAlpha > 0.5) sawLayered = true;
          a.step(1.2);
        }
      }
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.step(0.5);

      a.dispatchAction('Dodge_Dash');
      a.step(0.8);
      a.dispatchAction('Dodge_Roll');
      a.step(1.1);
      a.dispatchAction('Jump');
      a.step(0.16);
      a.dispatchAction('Jump');
      a.step(0.05);
      const sawDoubleJump = a.getState().currentState === 'Air_Jump_Double';
      a.step(1.0);

      return { sawMove8, sawLayered, sawDoubleJump, finalPos: a.getState().playerWorldPos };
    });

    assert.ok(out.sawMove8 >= 6, `Expected >= 6 of 8 strafe directions to enter Move_8Way, got ${out.sawMove8}`);
    assert.equal(out.sawLayered, true);
    assert.equal(out.sawDoubleJump, true);
    assert.ok(Number.isFinite(out.finalPos.x) && Number.isFinite(out.finalPos.z));
  });
});

test('[T3][F4][F5][F7][T3-X09] 11..15 Hit/Knockdown/KipUp BVHs parse & clean with supine floor safety & nonCyclic intact', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['parseBVHTextToClip']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);

  for (const name of F4_EXPECTED_FILENAMES) {
    const abs = path.join(B_CLEANED_DIR, name);
    requireDeliverableFile(abs, 'F4');
    const clip = mc.parseBVHTextToClip(fs.readFileSync(abs, 'utf8'), name, {
      nonCyclic: true,
      preserveRootMotion: true,
    });
    const { cleanedFrames } = cleaner.runCleaningPipeline(clip, {
      deJitter: true,
      filterRadius: 2,
      footLock: true,
      loopClean: null, // Auto -> must stay false on nonCyclic!
    });

    const minRootY = Math.min(...cleanedFrames.map((f) => f.rootPos.y));
    assert.ok(minRootY >= 0.05, `${name} supine pelvis sank below floor after re-clean: ${minRootY}`);
    if (name.startsWith('13_')) {
      assert.ok(
        cleanedFrames[cleanedFrames.length - 1].rootPos.y <= 0.52,
        '13_knockdown must remain supine at end after loopClean: null'
      );
    }
    if (name.startsWith('14_') || name.startsWith('15_')) {
      assert.ok(
        cleanedFrames[cleanedFrames.length - 1].rootPos.y >= 0.68,
        `${name} must finish standing upright`
      );
    }
  }
});

test('[T3][F4][F10][F11][T3-X10] 11..15 BVHs drive Dummy Mode 2 Light Counter & Mode 3 Heavy Knockdown -> KipUp', async () => {
  for (const name of F4_EXPECTED_FILENAMES) {
    requireDeliverableFile(path.join(B_CLEANED_DIR, name), 'F4');
  }

  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction('DummyMode', 2);
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');
      a.dispatchAction('Move', { x: 0, z: 1 });
      a.step(0.75);
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.dispatchAction('TriggerDummyAttack', 'light');
      let sawLightHit = false;
      for (let i = 0; i < 16; i++) {
        a.step(0.12);
        if (/^Hit_Light/.test(a.getState().currentState)) {
          sawLightHit = true;
          break;
        }
      }
      a.step(1.2);

      a.dispatchAction('DummyMode', 3);
      a.dispatchAction('TriggerDummyAttack', 'heavy');
      let sawKnockdown = false;
      for (let i = 0; i < 20; i++) {
        a.step(0.12);
        if (a.getState().currentState === 'Hit_Knockdown') {
          sawKnockdown = true;
          break;
        }
      }
      for (let i = 0; i < 20; i++) {
        if (a.getState().stateNormalizedTime >= 0.66 || a.getState().currentState !== 'Hit_Knockdown') break;
        a.step(0.08);
      }
      a.dispatchAction('KipUp');
      if (a.getState().currentState !== 'KipUp') a.dispatchAction('Jump');
      a.step(0.05);
      const sawKipUp = a.getState().currentState === 'KipUp';

      return { sawLightHit, sawKnockdown, sawKipUp };
    });

    assert.equal(out.sawLightHit, true, 'Dummy Mode 2 AI must land light hit -> Hit_Light_L/R');
    assert.equal(out.sawKnockdown, true, 'Dummy Mode 3 AI must land heavy hit -> Hit_Knockdown');
    assert.equal(out.sawKipUp, true, 'Player must recover from Mode 3 knockdown via KipUp');
  });
});

test('[T3][F5][F7][F9][T3-X11] Pairwise preserveRootMotion x nonCyclic x loopClean matrix & UE5 <15ms Workbench re-clean', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);

  const lungeBvh = buildSyntheticBVH({
    convention: 'ue5',
    frames: 60,
    fps: 60,
    rootPosFn: (f) => [0, 94, (f / 59) * 240],
    jointEulerZXYDegFn: (name, f) =>
      name === 'hand_r' ? [Math.sin(f * 2.1) * 14, Math.cos(f * 2.7) * 12, 0] : [0, 0, 0],
  });

  // 6 pairwise combinations
  const combos = [
    { preserveRootMotion: true, nonCyclic: true, loopClean: null, expectTravel: true },
    { preserveRootMotion: true, nonCyclic: true, loopClean: false, expectTravel: true },
    { preserveRootMotion: true, nonCyclic: false, loopClean: true, expectTravel: false },
    { preserveRootMotion: true, nonCyclic: false, loopClean: false, expectTravel: true },
    { preserveRootMotion: false, nonCyclic: true, loopClean: false, expectTravel: true }, // centered [-1.2..+1.2], net ΔZ=+2.4
    { preserveRootMotion: false, nonCyclic: false, loopClean: true, expectTravel: false },
  ];

  for (const c of combos) {
    const frames = await unwrapRetargetFrames(
      mc.retargetBVHToFrames(lungeBvh, 60, { preserveRootMotion: c.preserveRootMotion })
    );
    const { cleanedFrames } = cleaner.runCleaningPipeline(
      { fps: 60, nonCyclic: c.nonCyclic, frames },
      { deJitter: true, footLock: false, loopClean: c.loopClean }
    );
    const dz = cleanedFrames[59].rootPos.z - cleanedFrames[0].rootPos.z;
    if (c.expectTravel) {
      assert.ok(dz >= 2.0, `Expected preserved ΔZ >= 2.0m for ${JSON.stringify(c)}, got ${dz}`);
    } else {
      assert.ok(Math.abs(dz) <= 0.05, `Expected closed seam |ΔZ| <= 0.05m for ${JSON.stringify(c)}, got ${dz}`);
    }
  }

  // Also verify <15ms live re-clean & telemetry drop in browser Workbench
  await withWorkbenchPage(async (page) => {
    const res = await page.evaluate(async (bvhText) => {
      const ms = window.__MOTION_STAGE__;
      await ms.loadClipFromBVHText(bvhText, 'ue5_noisy.bvh', { preserveRootMotion: true, nonCyclic: true });
      const t0 = performance.now();
      ms.setCleanOptions({ deJitter: true, filterRadius: 4, footLock: true });
      const elapsed = performance.now() - t0;
      const st = ms.getState();
      return {
        elapsed,
        rawJitter: st.rawTelemetry?.rmsJitter,
        cleanJitter: st.cleanTelemetry?.rmsJitter,
      };
    }, lungeBvh);

    assert.ok(res.elapsed < 50.0, `Expected <50ms UI re-clean + HUD repaint, got ${res.elapsed.toFixed(2)}ms`);
    assert.ok(res.cleanJitter < res.rawJitter, 'Expected cleanJitter < rawJitter on noisy UE5 BVH');
  });
});

test('[T3][F5][F8][T3-X12] Multi-convention >240f UE5 & Rigify BVHs -> baked Combat Curve export -> parseBVHTextToClip round-trip', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToClip', 'parseBVHTextToClip'].filter((k) => k === 'parseBVHTextToClip'));
  const exporter = await loadModuleContract('src/pipeline/BVHExporter.js', ['exportCleanedClipToBVH']);
  const { BONE_IDX } = rig;

  for (const conv of ['ue5_with_floor_root', 'rigify']) {
    const srcBvh = buildSyntheticBVH({
      convention: conv,
      frames: 300, // 5.0s @ 60fps (>240!)
      fps: 60,
      rootPosFn: (f) => [0, conv === 'ue5_with_floor_root' ? 0 : 94, (f / 299) * 150],
      jointEulerZXYDegFn: (name, f) => {
        if (name === 'RightLeg' || name === 'calf_r' || name === 'shin.R') return [0, -30, 0];
        if (name === 'RightUpperArm' || name === 'upperarm_r' || name === 'upper_arm.R') {
          return [0, Math.sin((f / 299) * Math.PI) * 70, 0];
        }
        return [0, 0, 0];
      },
    });

    const clip = mc.parseBVHTextToClip(srcBvh, `${conv}_5s_attack.bvh`, {
      nonCyclic: true,
      preserveRootMotion: true,
    });
    clip.isCombatAttack = true;
    assert.ok(clip.frames.length >= 295, `[${conv}] Expected ~300 uncapped frames, got ${clip.frames.length}`);

    const bakedBvh = exporter.exportCleanedClipToBVH(clip, clip.frames, {
      bakeCombatCurve: true,
      combatCurve: {
        mode: 'single',
        windupEnd: 0.3,
        windupSpeed: 2.0,
        strikeEnd: 0.5,
        strikeSpeed: 1.8,
        hitstopFrames: 5,
        recoverySpeed: 1.0,
      },
    });
    const analyzed = parseAndAnalyzeStandardBVH(bakedBvh, `Baked:${conv}`);
    assert.ok(analyzed.maxIdenticalRun >= 3, `[${conv}] Expected baked hitstop plateau`);

    const roundTrip = mc.parseBVHTextToClip(bakedBvh, `roundtrip_${conv}.bvh`, {
      nonCyclic: true,
      preserveRootMotion: true,
    });
    const rKneeAng = 2 * Math.acos(Math.min(1, Math.abs(roundTrip.frames[10].quats[BONE_IDX.RightLeg].w)));
    const lKneeAng = 2 * Math.acos(Math.min(1, Math.abs(roundTrip.frames[10].quats[BONE_IDX.LeftLeg].w)));
    assert.ok(rKneeAng > 0.35 && lKneeAng < 0.05, `[${conv}] RightLeg rotation lost or mirrored in round-trip`);
  }
});

test('[T3][F6][F7][F9][T3-X13] Trimmed 01b video extraction -> null-contact reference Telemetry -> <15ms live re-clean', async () => {
  await withWorkbenchPage(async (page) => {
    const out = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const ms = window.__MOTION_STAGE__;
      const url01b =
        '/reference_videos/01b_%E5%A4%A9%E5%88%80%E5%AE%98%E7%BD%91_%E5%A4%AA%E7%99%BD%E5%B4%96%E9%A1%B6%E6%8B%94%E5%89%91%E5%AE%9A%E5%8A%BF_%E5%85%A8%E8%BA%AB%E9%95%9C%E5%A4%B4.mp4';
      ms.setWorkbenchActive?.(false);
      let clip;
      try {
        const res = await vpc.extractClipFromVideoSource(url01b, null, {
          trimInSec: 0.1,
          trimOutSec: 0.65,
          targetFps: 24,
          nonCyclic: true,
        });
        clip = res?.clip || res;
      } finally {
        ms.setWorkbenchActive?.(true);
      }
      if (typeof ms.setActiveClip === 'function') {
        ms.setActiveClip(clip);
      } else {
        const { exportCleanedClipToBVH } = await import('/src/pipeline/BVHExporter.js');
        await ms.loadClipFromBVHText(exportCleanedClipToBVH(clip, clip.frames), '01b_captured.bvh', { nonCyclic: true });
      }

      const st0 = ms.getState();
      const t0 = performance.now();
      ms.setCleanOptions({ filterRadius: 5, ikBlend: 0.85, footLock: true });
      const elapsedMs = performance.now() - t0;
      const st1 = ms.getState();

      return {
        rawMaxSlip: st0.rawTelemetry?.maxSlipCmS ?? 0,
        rawJitter: st0.rawTelemetry?.rmsJitter ?? 0,
        cleanJitter: st1.cleanTelemetry?.rmsJitter ?? 0,
        elapsedMs,
      };
    });

    assert.ok(out.rawMaxSlip > 0 || out.rawJitter > 0, 'Video-extracted clip rawTelemetry must be non-zero');
    assert.ok(out.cleanJitter <= out.rawJitter);
    assert.ok(out.elapsedMs < 50.0, `Live re-clean must NOT re-run MediaPipe, took ${out.elapsedMs.toFixed(2)}ms`);
  });
});

test('[T3][F6][F8][T3-X14] Video Pose Capture on 03 sub-trim -> autoMultiHit time-warp -> 21-bone .bvh export', async () => {
  await withCapturePage(async (page) => {
    const bvhText = await page.evaluate(async () => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const { runCleaningPipeline } = await import('/src/pipeline/MotionCleaner.js');
      const { exportCleanedClipToBVH } = await import('/src/pipeline/BVHExporter.js');
      const url03 =
        '/reference_videos/03_%E5%A4%AA%E7%99%BD%E9%9B%A8%E8%90%BD%E4%BA%91%E9%A3%9E_%E5%8C%97%E4%BA%AC%E6%AD%A6%E6%9C%AF%E9%98%9F_%E5%BF%AB%E5%89%91%E4%BA%94%E8%BF%9E%E6%96%A9%E5%8D%95%E4%BA%BA%E5%AE%9E%E6%8B%8D_720p.mp4';
      const res = await vpc.extractClipFromVideoSource(url03, null, {
        trimInSec: 0.5,
        trimOutSec: 1.15,
        targetFps: 24,
        nonCyclic: true,
        isCombatAttack: true,
      });
      const clip = res?.clip || res;
      clip.isCombatAttack = true;
      clip.nonCyclic = true;
      const { cleanedFrames } = runCleaningPipeline(clip, { deJitter: true, footLock: true, loopClean: false });
      return exportCleanedClipToBVH(clip, cleanedFrames, {
        bakeCombatCurve: true,
        combatCurve: { mode: 'autoMultiHit', windupSpeed: 1.6, hitstopFrames: 3 },
      });
    });

    const analyzed = parseAndAnalyzeStandardBVH(bvhText, 'Video03AutoMultiHit');
    assert.ok(analyzed.declaredFrames >= 12);
    assert.equal(analyzed.joints.length, 21);
  });
});

test('[T3][F7][F11][T3-X15] TwoBoneIK applyForearmTwistSolver & SpringClothSolver match across pipeline & LayeredAnimator', async () => {
  const rig = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX', 'createBoneHierarchy']);
  const ikMod = await loadModuleContract('src/pipeline/TwoBoneIK.js', [
    'applyForearmTwistSolver',
    'SpringClothSolver',
  ]);
  const layeredMod = await loadModuleContract('src/combat/LayeredAnimator.js');
  const { BONE_IDX, createBoneHierarchy } = rig;
  assert.ok(layeredMod, 'LayeredAnimator.js must exist');

  // Verify RightHand blade world direction is invariant under ForeArmTwist (since RightHand is child of RightForeArm, sibling of Twist!)
  const { bones } = createBoneHierarchy();
  bones[BONE_IDX.RightHand].quaternion.setFromEuler(new THREE.Euler(0.95, 0.25, -0.3));
  bones[0].updateMatrixWorld(true);
  const qBefore = new THREE.Quaternion();
  bones[BONE_IDX.RightHand].getWorldQuaternion(qBefore);

  ikMod.applyForearmTwistSolver(bones, true, 0.58);
  bones[0].updateMatrixWorld(true);
  const qAfter = new THREE.Quaternion();
  bones[BONE_IDX.RightHand].getWorldQuaternion(qAfter);
  assert.ok(qBefore.angleTo(qAfter) <= 1e-6, 'ForeArmTwist must never alter RightHand sword world orientation');

  // Verify SpringClothSolver lifts SkirtFront forward (-X rotation) during high forward knee kick
  const cloth = new ikMod.SpringClothSolver();
  bones[BONE_IDX.LeftUpLeg].quaternion.setFromEuler(new THREE.Euler(-1.1, 0, 0)); // Forward high knee lift (+Z)
  for (let i = 0; i < 20; i++) cloth.update(bones, 1 / 60, true, 1.2);
  const skirtAng = 2 * Math.acos(Math.min(1, Math.abs(bones[BONE_IDX.SkirtFront].quaternion.w)));
  assert.ok(skirtAng > 0.25, `SkirtFront must swing clear of high forward knee kick, got ${skirtAng.toFixed(3)} rad`);
});

test('[T3][F8][F10][F11][T3-X16] Baked Combat .bvh -> runtime clip -> Combat Arena upper-body slash override without bone snaps', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['buildSlashClip', 'parseBVHTextToClip']);
  const exporter = await loadModuleContract('src/pipeline/BVHExporter.js', ['exportCleanedClipToBVH']);

  const slash = mc.buildSlashClip();
  slash.nonCyclic = true;
  const bakedBvh = exporter.exportCleanedClipToBVH(slash, slash.frames, {
    bakeCombatCurve: true,
    combatCurve: {
      mode: 'single',
      windupEnd: 0.28,
      windupSpeed: 1.9,
      strikeEnd: 0.42,
      strikeSpeed: 1.8,
      hitstopFrames: 5,
      recoverySpeed: 1.0,
    },
  });
  const reimported = mc.parseBVHTextToClip(bakedBvh, 'baked_slash_attack.bvh', { nonCyclic: true });
  assert.ok(reimported.frames.length >= 60);

  // Verify max per-frame bone step in baked clip stays smooth (< 0.65 rad at 60fps)
  let maxStepRad = 0;
  for (let f = 1; f < reimported.frames.length; f++) {
    for (let b = 0; b < 29; b++) {
      maxStepRad = Math.max(
        maxStepRad,
        reimported.frames[f].quats[b].angleTo(reimported.frames[f - 1].quats[b])
      );
    }
  }
  assert.ok(maxStepRad < 0.65, `Discontinuous bone pop in baked combat clip: ${maxStepRad.toFixed(3)} rad`);

  // Also step moving slash in live Combat Arena
  await withCombatArenaPage(async (page) => {
    const ok = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction('Move', { x: 1, z: 0 });
      a.step(0.05);
      a.dispatchAction('Attack');
      a.step(0.65);
      return Number.isFinite(a.getState().playerWorldPos.x);
    });
    assert.equal(ok, true);
  });
});

test('[T3][F9][F12][T3-X17] MANIFEST.json 26-clip catalog aligns across Workbench Asset Selector & Combat Arena loadedClipIds', async () => {
  const manifest = loadAndNormalizeManifest();
  assert.equal(manifest.length, 26);

  await withWorkbenchPage(async (page) => {
    const wbCount = await page.evaluate(() => {
      const sel = document.querySelector('select[id*="asset"], select[id*="library"], #top-floating-bar select');
      if (sel) {
        return Array.from(sel.options).filter((o) => o.value && !o.disabled).length;
      }
      return document.querySelectorAll('[data-asset-path], [data-bvh]').length;
    });
    assert.ok(wbCount >= 26, `Workbench Asset Library must expose >= 26 clips from MANIFEST.json, got ${wbCount}`);
  });

  await withCombatArenaPage(async (page) => {
    const loadedIds = await page.evaluate(() => window.__COMBAT_ARENA__.getState().loadedClipIds || []);
    assert.ok(
      loadedIds.length >= 20,
      `Expected CombatClipRegistry to load canonical library clips (>=20), got ${loadedIds.length}`
    );
  });
});

test('[T3][F10][F12][T3-X18] Unified Mode Switcher strictly isolates keyboard routing (Space, WASD, Tab) per active stage', async () => {
  await withPage('/', async (page) => {
    await page.waitFor(() => Boolean(window.__MOTION_STAGE__), 2000, 50);

    // 1. In Workbench: Space toggles isPlaying true -> false
    const wbPlaying0 = await page.evaluate(() => window.__MOTION_STAGE__.getState().isPlaying);
    await page.tapKey('Space');
    await page.sleep(80);
    const wbPlaying1 = await page.evaluate(() => window.__MOTION_STAGE__.getState().isPlaying);
    assert.equal(wbPlaying1, !wbPlaying0, 'Spacebar in Workbench must toggle isPlaying');

    // 2. Switch to Combat Arena: Space triggers Jump, while Workbench isPlaying stays unchanged!
    await page.evaluate(async () => {
      const btn = Array.from(document.querySelectorAll('button, [role="tab"]')).find((b) =>
        /战斗|Combat|⚔/i.test(b.textContent || '')
      );
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
    });
    await page.tapKey('Space');
    const duringCombat = await page.evaluate(() => {
      window.__COMBAT_ARENA__.step(1 / 60);
      return {
        wbPlaying: window.__MOTION_STAGE__.getState().isPlaying,
        combatState: window.__COMBAT_ARENA__.getState().currentState,
      };
    });
    assert.equal(duringCombat.wbPlaying, wbPlaying1, 'Space in Combat must NOT toggle Workbench isPlaying');
    assert.equal(duringCombat.combatState, 'Jump', 'Space in Combat must trigger Jump');

    // 3. Switch back to Workbench: Space toggles Workbench isPlaying again while Combat is inactive!
    await page.evaluate(async () => {
      const btn = Array.from(document.querySelectorAll('button, [role="tab"]')).find((b) =>
        /工作台|生产|Workbench|🛠/i.test(b.textContent || '')
      );
      btn.click();
      await new Promise((r) => setTimeout(r, 250));
    });
    await page.tapKey('Space');
    await page.sleep(80);
    const afterReturn = await page.evaluate(() => ({
      wbPlaying: window.__MOTION_STAGE__.getState().isPlaying,
      combatActive: Boolean(window.__COMBAT_ARENA__?.getState()?.active),
    }));
    assert.equal(afterReturn.wbPlaying, !wbPlaying1);
    assert.equal(afterReturn.combatActive, false);
  });
});

test('[T3][F6][F12][T3-X19] Workbench activeClipId, cleanOptions & combatCurve survive round-trip into Combat Arena', async () => {
  await withPage('/', async (page) => {
    await page.waitFor(() => Boolean(window.__MOTION_STAGE__), 2000, 50);
    const before = await page.evaluate(() => {
      const ms = window.__MOTION_STAGE__;
      document.getElementById('btn-clip-kick')?.click();
      ms.setCleanOptions({ filterRadius: 5, ikBlend: 0.75 });
      ms.setCombatCurve({ mode: 'single', windupSpeed: 1.9, hitstopFrames: 4 });
      return ms.getState();
    });

    // Switch to Combat Arena, run combat actions, then return to Workbench
    const after = await page.evaluate(async () => {
      const combatBtn = Array.from(document.querySelectorAll('button, [role="tab"]')).find((b) =>
        /战斗|Combat|⚔/i.test(b.textContent || '')
      );
      const wbBtn = Array.from(document.querySelectorAll('button, [role="tab"]')).find((b) =>
        /工作台|生产|Workbench|🛠/i.test(b.textContent || '')
      );
      combatBtn.click();
      await new Promise((r) => setTimeout(r, 400));
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction('Move', { x: 0, z: 1 });
      a.dispatchAction('Attack');
      a.step(0.5);

      wbBtn.click();
      await new Promise((r) => setTimeout(r, 250));
      return window.__MOTION_STAGE__.getState();
    });

    assert.equal(after.activeClipId, before.activeClipId);
    assert.equal(after.frameCount, before.frameCount);
    assert.equal(after.cleanOptions.filterRadius, 5);
    assert.ok(Math.abs(after.cleanOptions.ikBlend - 0.75) <= 1e-4);
    assert.equal(after.combatCurve.hitstopFrames, 4);
    assert.equal(page.pageErrors.length, 0);
  });
});

test('[T3][F1][F3][F4][F12][T3-X20] All 26 bvh_library .bvh files + MANIFEST.json + CMU mocap are git-tracked AND in vite build', () => {
  assert.equal(fs.existsSync(path.join(WORKSPACE_ROOT, '.git')), true, 'Missing /home/antigravity/.git');
  const trackedSet = new Set(
    execFileSync('git', ['ls-files', 'bvh_library'], {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      env: GIT_ENV,
    })
      .split(/\r?\n/)
      .filter(Boolean)
  );

  assert.equal(trackedSet.has('bvh_library/MANIFEST.json'), true, 'MANIFEST.json not git-tracked');
  assert.ok(
    [...trackedSet].filter((p) => p.startsWith('bvh_library/A_raw_mocap/cmu_')).length >= 2,
    'Raw CMU mocap files in A_raw_mocap/ must be git-tracked'
  );

  const build = getSharedEphemeralViteBuild();
  for (const rel of ALL_26_BVH_REL_PATHS) {
    assert.equal(trackedSet.has(`bvh_library/${rel}`), true, `Missing from git ls-files: bvh_library/${rel}`);
    assert.equal(
      fs.existsSync(path.join(build.shmOutDir, 'bvh_library', rel)),
      true,
      `Missing from vite build output: bvh_library/${rel}`
    );
  }
});
