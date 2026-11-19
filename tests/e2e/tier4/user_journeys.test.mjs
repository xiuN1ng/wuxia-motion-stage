import fs from 'node:fs';
import http from 'node:http';
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
  ALL_26_BVH_REL_PATHS,
  REFERENCE_VIDEO_SPECS,
  EXPECTED_BONE_LAYER_WEIGHTS,
} from '../helpers/constants.mjs';
import {
  loadModuleContract,
  unwrapRetargetFrames,
  readBoneLayerWeight,
  getSharedEphemeralViteBuild,
} from '../helpers/contract_loader.mjs';
import {
  requireDeliverableFile,
  parseAndAnalyzeStandardBVH,
  loadAndNormalizeManifest,
  gdriveJson,
  buildSyntheticBVH,
} from '../helpers/bvh_verifier.mjs';
import {
  withPage,
  withWorkbenchPage,
  withCombatArenaPage,
} from '../helpers/browser_cdp.mjs';

const GIT_ENV = {
  ...process.env,
  PATH: `${process.env.PATH || ''}:/opt/antigravity/bin`,
};

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bvh': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      let relPath = decodeURIComponent(reqUrl.pathname);
      if (relPath === '/') relPath = '/index.html';
      const safePath = path.resolve(rootDir, `.${relPath}`);
      if (!safePath.startsWith(rootDir) || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      const stat = fs.statSync(safePath);
      const ext = path.extname(safePath).toLowerCase();
      const mime = MIME_MAP[ext] || 'application/octet-stream';
      const range = req.headers.range;
      if (range && range.startsWith('bytes=')) {
        const [sStr, eStr] = range.slice(6).split('-');
        const start = Number(sStr) || 0;
        const end = eStr ? Math.min(stat.size - 1, Number(eStr)) : stat.size - 1;
        res.writeHead(206, {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(safePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Content-Length': stat.size,
        });
        fs.createReadStream(safePath).pipe(res);
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

// ============================================================================
// Tier 4: 10 Complete Real-World E2E User Journeys (F1–F12)
// ============================================================================

test('[T4][F2][F5][F6][F7][F8][F9][T4-E2E-01] Master Wushu Video (05) Sub-Clip Trim -> Clean -> Bake -> Engine BVH Journey', async () => {
  const spec05 = REFERENCE_VIDEO_SPECS.find((s) => s.key === '05');
  requireDeliverableFile(path.join(REF_VIDEOS_DIR, spec05.file), 'F2');
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['parseBVHTextToClip']);

  await withWorkbenchPage(async (page) => {
    const out = await page.evaluate(async (vidFile) => {
      const vpc = await import('/src/capture/VideoPoseCapture.js');
      const { exportCleanedClipToBVH } = await import('/src/pipeline/BVHExporter.js');
      const ms = window.__MOTION_STAGE__;
      const url = `/reference_videos/${encodeURIComponent(vidFile)}`;

      const probe = await vpc.probeVideoSource(url);
      ms.setWorkbenchActive?.(false);
      let clip;
      try {
        const res = await vpc.extractClipFromVideoSource(url, null, {
          trimInSec: 45.4,
          trimOutSec: 46.05,
          targetFps: 24,
          nonCyclic: true,
          isCombatAttack: true,
          delegate: 'auto',
        });
        clip = res?.clip || res;
      } finally {
        ms.setWorkbenchActive?.(true);
      }
      clip.isCombatAttack = true;
      clip.nonCyclic = true;

      if (typeof ms.setActiveClip === 'function') {
        ms.setActiveClip(clip);
      } else {
        await ms.loadClipFromBVHText(exportCleanedClipToBVH(clip, clip.frames), '05_subclip.bvh', {
          nonCyclic: true,
          preserveRootMotion: true,
        });
      }

      const t0 = performance.now();
      ms.setCleanOptions({ deJitter: true, filterRadius: 4, footLock: true, ikBlend: 1.0, loopClean: false });
      const cleanMs = performance.now() - t0;

      ms.setCombatCurve({
        mode: 'single',
        windupEnd: 0.3,
        windupSpeed: 1.8,
        strikeEnd: 0.5,
        strikeSpeed: 1.7,
        hitstopFrames: 4,
        recoverySpeed: 1.0,
        bakeCombatCurve: true,
        bakeOnExport: true,
      });
      const exportedBvh = ms.exportCurrentBVH();
      const st = ms.getState();
      return {
        videoDuration: probe.videoDuration,
        cleanMs,
        rawJitter: st.rawTelemetry?.rmsJitter ?? 0,
        cleanJitter: st.cleanTelemetry?.rmsJitter ?? 0,
        exportedBvh,
      };
    }, spec05.file);

    assert.ok(out.videoDuration > 75.0);
    assert.ok(out.cleanMs < 50.0, `Expected instant <50ms UI re-clean, got ${out.cleanMs.toFixed(2)}ms`);
    assert.ok(out.cleanJitter <= out.rawJitter);

    const analyzed = parseAndAnalyzeStandardBVH(out.exportedBvh, 'Master05SubClipBaked');
    assert.equal(analyzed.joints.length, 21);
    assert.ok(analyzed.maxIdenticalRun >= 2, 'Expected baked hit-stop plateau in exported .bvh');

    const reimported = mc.parseBVHTextToClip(out.exportedBvh, '05_feiyan_baked.bvh', { nonCyclic: true });
    assert.equal(reimported.frames.length, analyzed.declaredFrames);
  });
});

test('[T4][F1][F2][F5][F9][F12][T4-E2E-02] Taibai 4-Signature-Skill Archive, Drive 02/C Sync & Live Workbench View-Mode Audit', async () => {
  for (const s of REFERENCE_VIDEO_SPECS.slice(0, 4)) {
    requireDeliverableFile(path.join(REF_VIDEOS_DIR, s.file), 'F2');
  }
  const driveItems = gdriveJson(['readonly', 'ls', DRIVE_FOLDER_02C_TAIBAI]);
  assert.equal(driveItems.length, 4);
  const driveMap = new Map(driveItems.map((d) => [d.name, d]));

  for (const name of TAIBAI_EXPECTED_FILENAMES) {
    const abs = path.join(C_TAIBAI_DIR, name);
    const st = requireDeliverableFile(abs, 'F1');
    const bvh = parseAndAnalyzeStandardBVH(fs.readFileSync(abs, 'utf8'), name);
    assert.equal(Number(driveMap.get(name)?.size), st.size);
    if (name.startsWith('taibai_03')) assert.ok(bvh.durationSec >= 4.8);
    if (name.startsWith('taibai_04')) assert.ok(Math.min(...bvh.worldTraj.Hips.map((p) => p.y)) >= 12.0);
  }

  await withWorkbenchPage(async (page) => {
    page.clearLogs();
    const audit = await page.evaluate(async (names) => {
      const ms = window.__MOTION_STAGE__;
      const loadedCounts = [];
      for (const name of names) {
        const resp = await fetch(`/bvh_library/C_taibai_extracted/${encodeURIComponent(name)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${name}`);
        await ms.loadClipFromBVHText(await resp.text(), name, {
          nonCyclic: !name.startsWith('taibai_01b'),
          preserveRootMotion: true,
        });
        loadedCounts.push(ms.getState().frameCount);
      }

      // Cycle clean -> raw -> split & toggle weapon
      document.getElementById('mode-split')?.click();
      await new Promise((r) => setTimeout(r, 80));
      const splitVisible = !document.getElementById('split-labels')?.hidden;

      document.getElementById('mode-raw')?.click();
      await new Promise((r) => setTimeout(r, 50));
      document.getElementById('mode-clean')?.click();
      await new Promise((r) => setTimeout(r, 50));
      const splitHidden = Boolean(document.getElementById('split-labels')?.hidden);

      const weaponBtn = document.getElementById('btn-toggle-weapon');
      const pressed0 = weaponBtn?.getAttribute('aria-pressed');
      weaponBtn?.click();
      const pressed1 = weaponBtn?.getAttribute('aria-pressed');
      weaponBtn?.click();

      return { loadedCounts, splitVisible, splitHidden, pressed0, pressed1 };
    }, TAIBAI_EXPECTED_FILENAMES);

    assert.equal(audit.loadedCounts.length, 4);
    assert.ok(audit.loadedCounts.every((c) => c >= 18));
    assert.equal(audit.splitVisible, true);
    assert.equal(audit.splitHidden, true);
    assert.notEqual(audit.pressed0, audit.pressed1);
    assert.equal(page.pageErrors.length, 0);
    assert.deepEqual(page.httpErrors, []);
  });
});

test('[T4][F3][F4][F5][F7][F12][T4-E2E-03] CMU & UE5 Retargeting + Full 26-Clip Library Kinematic Audit', async () => {
  const mc = await loadModuleContract('src/anim/MotionClips.js', ['retargetBVHToFrames']);
  const cleaner = await loadModuleContract('src/pipeline/MotionCleaner.js', ['runCleaningPipeline']);

  const rawCmuFiles = fs.existsSync(RAW_MOCAP_DIR)
    ? fs.readdirSync(RAW_MOCAP_DIR).filter((f) => /^cmu_.*\.bvh$/i.test(f))
    : [];
  assert.ok(rawCmuFiles.length >= 2, 'Expected archived CMU raw mocap provenance files');
  for (const rf of rawCmuFiles) {
    assert.equal(/(0?24_0?1|0?87_0?2)/i.test(rf), false, `Forbidden CMU trial: ${rf}`);
  }

  // Retarget >4s UE5 lunge trial
  const ue5Long = buildSyntheticBVH({
    convention: 'ue5_with_floor_root',
    frames: 270,
    fps: 60,
    rootPosFn: (f) => [0, 0, (f / 269) * 260],
    jointEulerZXYDegFn: (name) => (name === 'calf_r' ? [0, -25, 0] : [0, 0, 0]),
  });
  const ue5Frames = await unwrapRetargetFrames(
    mc.retargetBVHToFrames(ue5Long, 60, { preserveRootMotion: true, maxFrames: Infinity })
  );
  assert.ok(ue5Frames.length >= 265);
  const cleanedUe5 = cleaner.runCleaningPipeline(
    { fps: 60, nonCyclic: true, frames: ue5Frames },
    { deJitter: true, footLock: true, loopClean: false }
  );
  assert.ok(cleanedUe5.cleanedFrames[cleanedUe5.cleanedFrames.length - 1].rootPos.z >= 2.3);

  // Full 26-clip production audit
  const manifest = loadAndNormalizeManifest();
  assert.equal(manifest.length, 26);
  for (const rel of ALL_26_BVH_REL_PATHS) {
    const abs = path.join(WORKSPACE_ROOT, 'bvh_library', rel);
    requireDeliverableFile(abs, '26ClipAudit');
    const bvh = parseAndAnalyzeStandardBVH(fs.readFileSync(abs, 'utf8'), rel);
    assert.equal(bvh.joints.length, 21);
    if (rel.includes('08_wuxia_dash')) assert.ok(bvh.worldTraj.Hips[bvh.declaredFrames - 1].z >= 80.0);
    if (rel.includes('09_wuxia_dodge_roll')) assert.ok(bvh.worldTraj.Hips[bvh.declaredFrames - 1].z >= 60.0);
    if (rel.includes('10_wuxia_double_jump')) assert.ok(Math.max(...bvh.worldTraj.Hips.map((p) => p.y)) >= 115.0);
    if (rel.includes('14_wuxia_kipup') || rel.includes('15_wuxia_knockdown_kipup')) {
      assert.ok(bvh.worldTraj.Hips[bvh.declaredFrames - 1].y >= 68.0);
    }
  }
});

test('[T4][F3][F10][F11][T4-E2E-04] Wuxia Roguelike Lock-On 8-Way Strafe + Moving Slash + 3-Hit Combo Journey', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');

      a.dispatchAction('Move', { x: 0, z: 1 });
      a.step(0.75);
      const hp0 = a.getState().dummyHp;

      a.dispatchAction('Move', { x: -1, z: 0 });
      a.step(0.1);
      a.dispatchAction('Attack');
      let peakAlpha = 0;
      let weightsSnapshot = null;

      for (let i = 0; i < 20; i++) {
        a.step(0.05);
        const s = a.getState();
        peakAlpha = Math.max(peakAlpha, s.upperLayerAlpha || 0);
        if (!weightsSnapshot && s.boneLayerWeights) weightsSnapshot = s.boneLayerWeights;
        if (s.canComboChain && s.currentState === 'Attack_Combo_1') {
          a.dispatchAction('Attack');
          break;
        }
      }

      let sawCombo2 = false;
      for (let i = 0; i < 20; i++) {
        a.step(0.05);
        const s = a.getState();
        if (s.currentState === 'Attack_Combo_2') sawCombo2 = true;
        if (s.canComboChain && s.currentState === 'Attack_Combo_2') {
          a.dispatchAction('Move', { x: 0, z: 0 });
          a.dispatchAction('Attack');
          break;
        }
      }

      let sawCombo3 = false;
      let maxHitstop = 0;
      for (let i = 0; i < 20; i++) {
        a.step(0.05);
        const s = a.getState();
        if (s.currentState === 'Attack_Combo_3') sawCombo3 = true;
        maxHitstop = Math.max(maxHitstop, s.hitstopRemainingMs || 0);
      }

      const end = a.getState();
      return {
        hp0,
        hpEnd: end.dummyHp,
        comboCount: end.comboCount,
        peakAlpha,
        weightsSnapshot,
        sawCombo2,
        sawCombo3,
        maxHitstop,
      };
    });

    assert.ok(res.peakAlpha > 0.8, `Expected moving slash upperLayerAlpha > 0.80, got ${res.peakAlpha}`);
    assert.equal(res.sawCombo2, true);
    assert.equal(res.sawCombo3, true);
    assert.ok(res.hpEnd < res.hp0 && res.comboCount >= 2, `Expected multi-hit combo damage (${res.hp0} -> ${res.hpEnd})`);
    assert.ok(res.maxHitstop > 0);
    for (const spec of EXPECTED_BONE_LAYER_WEIGHTS) {
      const w = readBoneLayerWeight(res.weightsSnapshot, spec.name, spec.rigIdx);
      assert.ok(Math.abs(w - spec.weight) <= 0.02);
    }
  });
});

test('[T4][F1][F10][F11][T4-E2E-05] Sparring Duel Part 1: Light Counter AI -> Skill_Wuhen Parry & Evade_Backflip Breakout', async () => {
  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 2);
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');

      a.dispatchAction('Skill_Wuhen');
      a.step(0.08);
      const inParry = a.getState().inParryWindow;
      for (const act of ['IncomingHit', 'TakeHit']) {
        a.dispatchAction(act, { type: 'light', side: 'L', damage: 12 });
      }
      a.step(0.05);
      const deflectedCleanly = !a.getState().currentState.startsWith('Hit_');
      a.step(2.5);

      a.dispatchAction('TriggerDummyAttack', 'light');
      let tookLight = false;
      for (let i = 0; i < 16; i++) {
        a.step(0.12);
        if (/^Hit_Light/.test(a.getState().currentState)) {
          tookLight = true;
          break;
        }
      }
      a.dispatchAction('Evade_Backflip');
      a.step(0.03);
      const brokeOut = a.getState().currentState === 'Evade_Backflip' && a.getState().isInvulnerable;

      a.step(1.3);
      for (const act of ['IncomingHit', 'TakeHit']) {
        a.dispatchAction(act, { type: 'light', side: 'R', damage: 12 });
        if (/^Hit_Light/.test(a.getState().currentState)) break;
      }
      if (!/^Hit_Light/.test(a.getState().currentState)) {
        a.dispatchAction('TriggerDummyAttack', 'light');
        for (let i = 0; i < 12 && !/^Hit_Light/.test(a.getState().currentState); i++) a.step(0.1);
      }
      a.dispatchAction('Evade_Backflip');
      a.step(0.03);
      const blockedByCooldown = /^Hit_Light/.test(a.getState().currentState);

      return { inParry, deflectedCleanly, tookLight, brokeOut, blockedByCooldown };
    });

    assert.equal(out.inParry, true);
    assert.equal(out.deflectedCleanly, true);
    assert.equal(out.tookLight, true);
    assert.equal(out.brokeOut, true);
    assert.equal(out.blockedByCooldown, true);
  });
});

test('[T4][F1][F3][F4][F10][F11][T4-E2E-06] Sparring Duel Part 2: Heavy Knockdown -> KipUp -> Kick -> Yuluo -> Dash-Cancel -> Feiyan', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 3);
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');
      a.dispatchAction('Move', { x: 0, z: 1 });
      a.step(0.75);
      a.dispatchAction('Move', { x: 0, z: 0 });

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
      a.step(1.6);

      a.dispatchAction?.('DummyMode', 1);
      a.dispatchAction('Move', { x: 0, z: 1 });
      a.step(0.65);
      a.dispatchAction('Move', { x: 0, z: 0 });
      const poiseBefore = a.getState().dummyPoise;

      a.dispatchAction('Skill_Kick');
      a.step(0.1);
      const sawKick = a.getState().currentState === 'Skill_Kick';
      a.step(1.0);
      const poiseAfterKick = a.getState().dummyPoise;
      a.step(0.6);

      a.dispatchAction('Skill_Yuluo');
      a.step(0.75);
      const wasYuluo = a.getState().currentState === 'Skill_Yuluo';
      a.dispatchAction('Dodge_Dash');
      a.step(0.05);
      const dashCanceled = a.getState().currentState === 'Dodge_Dash';
      a.step(0.9);

      a.dispatchAction('Skill_Feiyan');
      a.step(0.05);
      const sawFeiyan = a.getState().currentState === 'Skill_Feiyan';

      return {
        sawKnockdown,
        sawKipUp,
        sawKick,
        poiseBefore,
        poiseAfterKick,
        wasYuluo,
        dashCanceled,
        sawFeiyan,
      };
    });

    assert.equal(res.sawKnockdown, true);
    assert.equal(res.sawKipUp, true);
    assert.equal(res.sawKick, true);
    assert.ok(res.poiseAfterKick < res.poiseBefore || res.poiseAfterKick === 0, 'Skill_Kick must reduce/break dummyPoise');
    assert.equal(res.wasYuluo, true);
    assert.equal(res.dashCanceled, true, 'Dodge_Dash must cancel mid-flurry Skill_Yuluo');
    assert.equal(res.sawFeiyan, true);
  });
});

test('[T4][F7][F8][F9][F11][F12][T4-E2E-07] Seamless Cross-Stage Authoring -> Export -> Combat -> Re-Import Journey on :5173', async () => {
  await withPage('/', async (page) => {
    await page.waitFor(() => Boolean(window.__MOTION_STAGE__), 2000, 50);
    page.clearLogs();

    const result = await page.evaluate(async () => {
      const ms = window.__MOTION_STAGE__;
      document.getElementById('btn-clip-slash')?.click();
      ms.setCleanOptions({ deJitter: true, filterRadius: 4, footLock: true, ikBlend: 1.0 });
      ms.setCombatCurve({
        mode: 'single',
        windupEnd: 0.28,
        windupSpeed: 1.7,
        strikeEnd: 0.42,
        strikeSpeed: 1.7,
        hitstopFrames: 4,
        recoverySpeed: 1.0,
        bakeCombatCurve: true,
        bakeOnExport: true,
      });
      const exportedBvh = ms.exportCurrentBVH();

      const combatBtn = Array.from(document.querySelectorAll('button, [role="tab"]')).find((b) =>
        /战斗|Combat|⚔/i.test(b.textContent || '')
      );
      const wbBtn = Array.from(document.querySelectorAll('button, [role="tab"]')).find((b) =>
        /工作台|生产|Workbench|🛠/i.test(b.textContent || '')
      );
      combatBtn.click();
      await new Promise((r) => setTimeout(r, 400));

      const wbTimePaused0 = ms.getState().normalizedTime;
      const arena = window.__COMBAT_ARENA__;
      arena.dispatchAction('Attack');
      arena.step(0.6);
      await new Promise((r) => setTimeout(r, 120));
      const wbTimePaused1 = ms.getState().normalizedTime;

      wbBtn.click();
      await new Promise((r) => setTimeout(r, 250));
      await ms.loadClipFromBVHText(exportedBvh, 'custom_baked_slash.bvh', { nonCyclic: true });
      const finalSt = ms.getState();

      return {
        exportedBvh,
        wbTimePaused0,
        wbTimePaused1,
        reimportedFrames: finalSt.frameCount,
        hasTelemetry: Boolean(finalSt.cleanTelemetry?.slipSeries?.length),
      };
    });

    assert.equal(result.wbTimePaused1, result.wbTimePaused0, 'Workbench loop must stay paused during Combat Arena');
    const parsed = parseAndAnalyzeStandardBVH(result.exportedBvh, 'CrossStageExport');
    assert.equal(result.reimportedFrames, parsed.declaredFrames);
    assert.equal(result.hasTelemetry, true);
    assert.equal(page.pageErrors.length, 0);
  });
});

test('[T4][F3][F10][F11][T4-E2E-08] 300-Substep Arena Boundary (R <= 8.5m), Capsule Separation & Aerial Stress Journey', async () => {
  await withCombatArenaPage(async (page) => {
    page.clearLogs();
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');

      let maxR = 0;
      let anyNaN = false;
      // 30 batched steps x 0.167s = 5.0s (300 internal 60Hz substeps!)
      for (let step = 0; step < 30; step++) {
        const angle = (step / 30) * Math.PI * 4;
        if (step < 18) {
          a.dispatchAction('Move', { x: Math.cos(angle), z: Math.sin(angle) });
          if (step % 4 === 0) a.dispatchAction('Dodge_Dash');
          if (step === 7) a.dispatchAction('Dodge_Roll');
          if (step === 9 || step === 10) a.dispatchAction('Jump');
        } else {
          const p = a.getState().playerWorldPos;
          a.dispatchAction('Move', { x: -p.x, z: -p.z });
          if (step % 4 === 0) a.dispatchAction('Attack');
        }
        a.step(10 / 60);
        const s = a.getState();
        const r = Math.hypot(s.playerWorldPos.x, s.playerWorldPos.z);
        maxR = Math.max(maxR, r);
        if (!Number.isFinite(r) || !Number.isFinite(s.playerWorldPos.y) || !Number.isFinite(s.playerYaw)) {
          anyNaN = true;
        }
      }
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.step(1.0);
      return { maxR, anyNaN, endY: a.getState().playerWorldPos.y };
    });

    assert.equal(out.anyNaN, false);
    assert.ok(out.maxR <= 8.505, `Exceeded R=8.5m boundary: maxR=${out.maxR}`);
    assert.ok(Math.abs(out.endY) <= 0.08, `Expected grounded end Y ≈ 0, got ${out.endY}`);
    assert.equal(page.pageErrors.length, 0);
  });
});

test('[T4][F12][T4-E2E-09] Ephemeral Production Build (/dev/shm) + Static HTTP Server Full-App Smoke Journey', async () => {
  const build = getSharedEphemeralViteBuild();
  const { server, port } = await startStaticServer(build.shmOutDir);
  const prodOrigin = `http://127.0.0.1:${port}`;

  try {
    await withPage(`${prodOrigin}/`, async (page) => {
      await page.waitFor(() => Boolean(window.__MOTION_STAGE__), 2500, 50);
      const wbOk = await page.evaluate(async () => {
        const mRes = await fetch('/bvh_library/MANIFEST.json');
        return {
          mode: window.__MOTION_STAGE__.getState().activeMode,
          manifestStatus: mRes.status,
        };
      });
      assert.equal(wbOk.mode, 'workbench');
      assert.equal(wbOk.manifestStatus, 200);
      assert.equal(page.pageErrors.length, 0);
    });

    await withPage(`${prodOrigin}/?mode=combat`, async (page) => {
      await page.waitFor(() => window.__COMBAT_ARENA__?.getState()?.active === true, 2500, 50);
      const combatOk = await page.evaluate(() => {
        const a = window.__COMBAT_ARENA__;
        a.step(1 / 60);
        return a.getState().active && a.getState().loadedClipIds?.length >= 20;
      });
      assert.equal(combatOk, true);
      assert.equal(page.pageErrors.length, 0);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('[T4][F2][F12][T4-E2E-10] Clone-Ready Git Repository, CC-BY-3.0 Attribution & 26-Asset Tracking Audit', () => {
  assert.equal(fs.existsSync(path.join(WORKSPACE_ROOT, '.git')), true, 'Missing /home/antigravity/.git');
  const readme = fs.readFileSync(path.join(WORKSPACE_ROOT, 'README.md'), 'utf8');
  const license = fs.readFileSync(path.join(WORKSPACE_ROOT, 'LICENSE-CC-BY-3.0.md'), 'utf8');

  assert.ok(
    /Beijing Wushu|北京武术队|Pacific Wushu|C\.?\s*J\.?\s*Yeh/i.test(readme + '\n' + license),
    'README.md / LICENSE-CC-BY-3.0.md must attribute Beijing Wushu Team 2012 Tour (CC BY 3.0)'
  );
  assert.ok(/CC[\s-]*BY[\s-]*3\.0/i.test(license), 'LICENSE-CC-BY-3.0.md must specify CC BY 3.0 license');

  const tracked = execFileSync('git', ['ls-files'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: GIT_ENV,
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const trackedSet = new Set(tracked);

  for (const rel of ALL_26_BVH_REL_PATHS) {
    assert.equal(trackedSet.has(`bvh_library/${rel}`), true, `Missing tracked BVH: ${rel}`);
  }
  const mpChunks = tracked.filter((p) => p.startsWith('motion-stage/public/mediapipe/chunks/'));
  assert.ok(mpChunks.length >= 20, `Expected >= 20 offline MediaPipe chunk files tracked, got ${mpChunks.length}`);
  assert.equal(
    tracked.some((p) => /^reference_videos\/01/.test(p)),
    false,
    'Tencent 01* video must remain excluded from public Git tracking'
  );
});
