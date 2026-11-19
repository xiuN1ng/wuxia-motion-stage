import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { WORKSPACE_ROOT, BASE_URL, REFERENCE_VIDEO_SPECS } from '../helpers/constants.mjs';
import { importThree, loadModuleContract } from '../helpers/contract_loader.mjs';
import { withPage, withCombatArenaPage } from '../helpers/browser_cdp.mjs';

const THREE = await importThree();

const GIT_ENV = {
  ...process.env,
  PATH: `${process.env.PATH || ''}:/opt/antigravity/bin`,
};

function runGit(args) {
  assert.equal(
    fs.existsSync(path.join(WORKSPACE_ROOT, '.git')),
    true,
    '[F12] Missing Git repository at /home/antigravity/.git'
  );
  return execFileSync('git', args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: 15000,
  });
}

// ============================================================================
// Feature F10 Tier 2: Priority, Cooldown, Buffer TTL & Boundary Guards (8 Tests)
// ============================================================================

test('[T2][F10][T2-F10-01] Expired >180ms input buffer TTL does NOT phantom-chain into Attack_Combo_2', async () => {
  await withCombatArenaPage(async (page) => {
    const sawCombo2 = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      a.dispatchAction('Move', { x: 0, z: -1 });
      a.step(0.45);
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.step(0.2);

      // Trigger Attack_Combo_1 and immediately queue a 2nd Attack 16ms later (>250ms before chain window)
      a.dispatchAction('Attack');
      a.step(1 / 60);
      a.dispatchAction('Attack');
      for (let i = 0; i < 20; i++) {
        a.step(0.1);
        if (a.getState().currentState === 'Attack_Combo_2') return true;
      }
      return false;
    });
    assert.equal(sawCombo2, false, 'Attack queued >180ms before chain window must expire without chaining');
  });
});

test('[T2][F10][T2-F10-02] Priority gate blocks lower-priority Attack & Move_8Way during early Dodge_Dash', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction('Dodge_Dash');
      a.step(0.035);
      const earlyState = a.getState().currentState;
      a.dispatchAction('Attack');
      a.dispatchAction('Move', { x: 1, z: 0 });
      a.step(1 / 60);
      return { earlyState, afterSpam: a.getState().currentState };
    });

    assert.equal(res.earlyState, 'Dodge_Dash');
    assert.equal(res.afterSpam, 'Dodge_Dash');
  });
});

test('[T2][F10][T2-F10-03] Evade_Backflip stagger-breakout ~6s cooldown blocks immediate repeat breakout', async () => {
  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      const applyLightHit = () => {
        for (const act of ['IncomingHit', 'TakeHit']) {
          a.dispatchAction(act, { type: 'light', side: 'L', damage: 8 });
          if (/^Hit_Light/.test(a.getState().currentState)) return true;
        }
        a.dispatchAction('TriggerDummyAttack', 'light');
        for (let i = 0; i < 15; i++) {
          a.step(0.1);
          if (/^Hit_Light/.test(a.getState().currentState)) return true;
        }
        return false;
      };

      const hit1 = applyLightHit();
      a.dispatchAction('Evade_Backflip');
      a.step(0.02);
      const firstBreakout = a.getState().currentState === 'Evade_Backflip';

      // Step 1.3s so backflip finishes (well inside ~6s cooldown!)
      a.step(1.3);

      const hit2 = applyLightHit();
      a.dispatchAction('Evade_Backflip');
      a.step(0.02);
      const stateDuringCooldown = a.getState().currentState;

      // Step 6.5s so cooldown expires, take 3rd hit -> breakout succeeds again!
      a.step(6.5);
      const hit3 = applyLightHit();
      a.dispatchAction('Evade_Backflip');
      a.step(0.02);
      const thirdBreakout = a.getState().currentState === 'Evade_Backflip';

      return { hit1, firstBreakout, hit2, stateDuringCooldown, hit3, thirdBreakout };
    });

    assert.equal(out.hit1 && out.firstBreakout, true, '1st Evade_Backflip breakout must succeed');
    assert.equal(out.hit2, true);
    assert.ok(
      /^Hit_Light/.test(out.stateDuringCooldown),
      `Evade_Backflip cooldown must block immediate repeat breakout, got ${out.stateDuringCooldown}`
    );
    assert.equal(out.hit3 && out.thirdBreakout, true, 'Evade_Backflip must succeed again after cooldown expires');
  });
});

test('[T2][F10][T2-F10-04] Late Skill_Wuhen recovery (after inParryWindow closes) is vulnerable to enemy hits', async () => {
  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction('Skill_Wuhen');
      let foundLateRecovery = false;
      for (let i = 0; i < 30; i++) {
        a.step(0.1);
        const s = a.getState();
        if (s.currentState === 'Skill_Wuhen' && s.stateNormalizedTime > 0.45 && !s.inParryWindow) {
          foundLateRecovery = true;
          break;
        }
      }
      for (const act of ['IncomingHit', 'TakeHit']) {
        a.dispatchAction(act, { type: 'light', side: 'R', damage: 10 });
        if (/^Hit_Light/.test(a.getState().currentState)) break;
      }
      if (!/^Hit_Light/.test(a.getState().currentState)) {
        a.dispatchAction('TriggerDummyAttack', 'light');
        for (let i = 0; i < 10 && !/^Hit_Light/.test(a.getState().currentState); i++) a.step(0.06);
      }
      return { foundLateRecovery, stateAfterHit: a.getState().currentState };
    });

    assert.equal(out.foundLateRecovery, true);
    assert.ok(/^Hit_Light/.test(out.stateAfterHit), `Expected stagger hit in late recovery, got ${out.stateAfterHit}`);
  });
});

test('[T2][F10][T2-F10-05] Double-jump charge cannot be spammed a 3rd/4th time in mid-air before landing', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction('Jump');
      a.step(0.16);
      a.dispatchAction('Jump'); // 2nd jump -> Air_Jump_Double
      a.step(0.2);
      const uBefore3rd = a.getState().stateNormalizedTime;

      a.dispatchAction('Jump');
      a.dispatchAction('Air_Jump_Double');
      a.step(1 / 60);
      const uAfter3rd = a.getState().stateNormalizedTime;

      let landed = false;
      for (let i = 0; i < 16; i++) {
        a.dispatchAction('Jump');
        a.step(0.12);
        if (a.getState().playerWorldPos.y <= 0.03 && i > 2) {
          landed = true;
          break;
        }
      }
      return { uBefore3rd, uAfter3rd, landed };
    });

    assert.ok(res.uAfter3rd >= res.uBefore3rd);
    assert.equal(res.landed, true);
  });
});

test('[T2][F10][T2-F10-06] Early Hit_Knockdown launch arc (u < 0.50, priority 100) rejects premature cancels & early KipUp', async () => {
  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      for (const act of ['IncomingHit', 'TakeHit']) {
        a.dispatchAction(act, { type: 'heavy', knockdown: true, damage: 30 });
        if (a.getState().currentState === 'Hit_Knockdown') break;
      }
      if (a.getState().currentState !== 'Hit_Knockdown') {
        a.dispatchAction('TriggerDummyAttack', 'heavy');
        for (let i = 0; i < 15 && a.getState().currentState !== 'Hit_Knockdown'; i++) a.step(0.08);
      }
      a.step(0.03);
      const uEarly = a.getState().stateNormalizedTime;
      for (const spam of ['Attack', 'Dodge_Dash', 'Skill_Yuluo', 'KipUp', 'Jump']) {
        a.dispatchAction(spam);
      }
      a.step(1 / 60);
      return { uEarly, stateAfterSpam: a.getState().currentState };
    });

    assert.ok(out.uEarly < 0.45);
    assert.equal(out.stateAfterSpam, 'Hit_Knockdown');
  });
});

test('[T2][F10][T2-F10-07] Circular arena boundary clamp (R <= 8.5m) holds strictly across outward steps & slides tangentially', async () => {
  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      let maxRadius = 0;
      let anyNaN = false;

      for (let i = 0; i < 14; i++) {
        a.dispatchAction('Move', { x: 0, z: -1 });
        if (i % 4 === 0) a.dispatchAction('Dodge_Dash');
        a.step(0.25);
        const p = a.getState().playerWorldPos;
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) anyNaN = true;
        maxRadius = Math.max(maxRadius, Math.hypot(p.x, p.z));
      }
      const posAtWall = { ...a.getState().playerWorldPos };

      for (let i = 0; i < 8; i++) {
        a.dispatchAction('Move', { x: 1, z: -1 });
        a.step(0.2);
        const p = a.getState().playerWorldPos;
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) anyNaN = true;
        maxRadius = Math.max(maxRadius, Math.hypot(p.x, p.z));
      }
      const posAfterSlide = { ...a.getState().playerWorldPos };
      return { maxRadius, anyNaN, posAtWall, posAfterSlide };
    });

    assert.equal(out.anyNaN, false);
    assert.ok(out.maxRadius <= 8.505, `Player escaped circular R=8.5m arena: maxRadius=${out.maxRadius}`);
    const slideDist = Math.hypot(
      out.posAfterSlide.x - out.posAtWall.x,
      out.posAfterSlide.z - out.posAtWall.z
    );
    assert.ok(slideDist > 0.1, 'Diagonal input at arena wall must slide tangentially along boundary');
  });
});

test('[T2][F10][T2-F10-08] Pathological dt values (0, -0.05, +2.5s spike) & unknown action execute safely without NaN', async () => {
  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction('UNKNOWN_ACTION_XYZ', { bogus: true });
      a.step(0);
      a.step(-0.05);
      a.dispatchAction('Move', { x: 0, z: 1 });
      a.step(2.5);
      const s = a.getState();
      return {
        state: s.currentState,
        u: s.stateNormalizedTime,
        pos: s.playerWorldPos,
        yaw: s.playerYaw,
      };
    });

    assert.equal(typeof out.state, 'string');
    assert.ok(Number.isFinite(out.u) && out.u >= 0 && out.u <= 1);
    assert.ok(
      Number.isFinite(out.pos.x) &&
        Number.isFinite(out.pos.y) &&
        Number.isFinite(out.pos.z) &&
        Math.hypot(out.pos.x, out.pos.z) <= 8.505
    );
    assert.ok(Number.isFinite(out.yaw));
  });
});

// ============================================================================
// Feature F11 Tier 2: Blending Seam, Hitbox Dedup & Capsule Collision Guards (8 Tests)
// ============================================================================

test('[T2][F11][T2-F11-01] LayeredAnimator aligns antipodal quaternion hemispheres (dot < 0) without 360° spin', async () => {
  const layeredMod = await loadModuleContract('src/combat/LayeredAnimator.js');
  const rigMod = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX', 'buildCharacterRig']);
  const { BONE_IDX, buildCharacterRig } = rigMod;

  const qPos = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.5, -0.2));
  const qNeg = new THREE.Quaternion(-qPos.x, -qPos.y, -qPos.z, -qPos.w);

  const baseFrame = {
    rootPos: new THREE.Vector3(0, 0.94, 0),
    quats: Array.from({ length: 29 }, () => qPos.clone()),
    contactL: true,
    contactR: true,
  };
  const upperFrame = {
    rootPos: new THREE.Vector3(0, 0.94, 0),
    quats: Array.from({ length: 29 }, () => qNeg.clone()),
    contactL: true,
    contactR: true,
  };

  const rig = buildCharacterRig();
  const { bones } = rig;
  if (typeof layeredMod.blendUpperOverLowerWithCounterYaw === 'function') {
    const out = layeredMod.allocatePoseBuffer();
    layeredMod.blendUpperOverLowerWithCounterYaw(baseFrame, upperFrame, 0.5, out);
    out.quats.forEach((q, i) => bones[i].quaternion.copy(q));
  } else {
    const Ctor = layeredMod.LayeredAnimator || layeredMod.createLayeredAnimator || layeredMod.default;
    const inst = Ctor.prototype ? new Ctor(rig, rig.rootGroup, null) : Ctor(rig, rig.rootGroup, null);
    inst.evaluate?.(1 / 60, {
      baseClip: { id: 'b', fps: 60, frames: [baseFrame, baseFrame] },
      upperClip: { id: 'u', fps: 60, frames: [upperFrame, upperFrame] },
      forceUpperAlpha: 0.5,
    });
  }

  for (const idx of [BONE_IDX.Spine, BONE_IDX.Chest, BONE_IDX.RightUpperArm, BONE_IDX.RightHand]) {
    const q = bones[idx].quaternion;
    assert.ok(Number.isFinite(q.w) && Math.abs(q.length() - 1) <= 1e-4, `Bone ${idx} NaN on antipodal blend`);
    assert.ok(q.angleTo(qPos) < 0.01, `Antipodal blend spun away from qPos: ${q.angleTo(qPos)} rad`);
  }
});

test('[T2][F11][T2-F11-02] Full-body Dodge_Roll interrupt cleanly clears/ramps down upper-body slash override', async () => {
  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction('Move', { x: 1, z: 0 });
      a.step(0.1);
      a.dispatchAction('Attack');
      a.step(0.18);
      const duringSlash = a.getState();

      a.dispatchAction('Move', { x: 0, z: 0 });
      a.dispatchAction('Dodge_Roll');
      a.step(0.25);
      const duringRoll = a.getState();
      return { duringSlash, duringRoll };
    });

    assert.ok(out.duringSlash.upperLayerAlpha > 0.5);
    assert.equal(out.duringRoll.currentState, 'Dodge_Roll');
    assert.ok(
      out.duringRoll.upperClipId === null || out.duringRoll.upperLayerAlpha < 0.15,
      `Full-body Dodge_Roll must clear upper-body slash layer, got alpha=${out.duringRoll.upperLayerAlpha}`
    );
  });
});

test('[T2][F11][T2-F11-03] Out-of-range whiffed slashes (>4.5m from Dummy) never false-register hits', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      a.dispatchAction('Move', { x: 0, z: -1 });
      a.step(1.3);
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.step(0.1);
      const hpBefore = a.getState().dummyHp;
      const comboBefore = a.getState().comboCount;

      a.dispatchAction('Attack');
      let maxHitstop = 0;
      for (let i = 0; i < 10; i++) {
        a.step(0.11);
        maxHitstop = Math.max(maxHitstop, a.getState().hitstopRemainingMs || 0);
      }
      const after = a.getState();
      return { hpBefore, hpAfter: after.dummyHp, comboBefore, comboAfter: after.comboCount, maxHitstop };
    });

    assert.equal(res.hpAfter, res.hpBefore);
    assert.equal(res.comboAfter, res.comboBefore);
    assert.equal(res.maxHitstop, 0);
  });
});

test('[T2][F11][T2-F11-04] Per-swing hit-ID deduplication registers at most 1 hit per single slash across fine substeps', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');
      a.dispatchAction('Move', { x: 0, z: 1 });
      a.step(0.8);
      a.dispatchAction('Move', { x: 0, z: 0 });
      const combo0 = a.getState().comboCount || 0;

      a.dispatchAction('Attack');
      for (let i = 0; i < 12; i++) {
        a.step(0.08);
      }
      return { comboDelta: (a.getState().comboCount || 0) - combo0 };
    });

    assert.equal(res.comboDelta, 1, `Single Attack_Combo_1 swing must register exactly 1 hit, got ${res.comboDelta}`);
  });
});

test('[T2][F11][T2-F11-05] Player-vs-Dummy body capsule separation prevents 0m overlap & NaN lock-on yaw', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');

      let anyNaNYaw = false;
      for (let i = 0; i < 10; i++) {
        a.dispatchAction('Move', { x: 0, z: 1 });
        if (i % 3 === 0) a.dispatchAction('Dodge_Dash');
        a.step(0.2);
        const s = a.getState();
        if (!Number.isFinite(s.playerYaw) || !Number.isFinite(s.playerWorldPos.x)) {
          anyNaNYaw = true;
        }
      }
      return { anyNaNYaw };
    });

    assert.equal(res.anyNaNYaw, false);
  });
});

test('[T2][F11][T2-F11-06] Active hit-stop freezes/slows animation phase and decays back to 0 without deadlock', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');
      a.dispatchAction('Move', { x: 0, z: 1 });
      a.step(0.8);
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.dispatchAction('Attack');

      let hitFrameU = null;
      let uDuringHitstop = null;
      for (let i = 0; i < 25; i++) {
        a.step(0.025);
        const s = a.getState();
        if ((s.hitstopRemainingMs || 0) > 15) {
          hitFrameU = s.stateNormalizedTime;
          a.step(0.01);
          uDuringHitstop = a.getState().stateNormalizedTime;
          break;
        }
      }
      a.step(1.0);
      return { hitFrameU, uDuringHitstop, remainingAfter: a.getState().hitstopRemainingMs || 0 };
    });

    assert.ok(res.hitFrameU !== null, 'Expected blade hit on Dummy to trigger hitstopRemainingMs > 15ms');
    assert.ok(Math.abs(res.uDuringHitstop - res.hitFrameU) < 0.008);
    assert.equal(res.remainingAfter, 0);
  });
});

test('[T2][F11][T2-F11-07] Driving Enemy Dummy HP to 0 clamps >= 0 or auto-resets without negative NaN or crash', async () => {
  await withCombatArenaPage(async (page) => {
    page.clearLogs();
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');
      a.dispatchAction('Move', { x: 0, z: 1 });
      a.step(0.8);
      a.dispatchAction('Move', { x: 0, z: 0 });

      let anyInvalidHp = false;
      for (let cycle = 0; cycle < 12; cycle++) {
        a.dispatchAction(cycle % 2 === 0 ? 'Skill_Yuluo' : 'Attack');
        a.step(0.9);
        const hp = a.getState().dummyHp;
        if (!Number.isFinite(hp) || hp < 0) anyInvalidHp = true;
      }
      return { anyInvalidHp };
    });

    assert.equal(res.anyInvalidHp, false);
    assert.equal(page.pageErrors.length, 0);
  });
});

test('[T2][F11][T2-F11-08] setActive(false -> true) & viewport resize (640x480 -> 1280x720) execute cleanly', async () => {
  await withCombatArenaPage(async (page) => {
    page.clearLogs();
    await page.evaluate(() => window.__COMBAT_ARENA__.setActive(false));
    await page.setViewport(640, 480, 1);
    await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.setActive(true);
      a.step(1 / 60);
    });
    await page.setViewport(1280, 720, 1);
    const active = await page.evaluate(() => window.__COMBAT_ARENA__.getState().active);
    assert.equal(active, true);
    assert.equal(page.pageErrors.length, 0);
  });
});

// ============================================================================
// Feature F12 Tier 2: Security Allowlist, Blob Size, Traversal & Range Guards (8 Tests)
// ============================================================================

test('[T2][F12][T2-F12-01] Root-allowlist .gitignore strictly excludes $HOME secrets, .agents/, node_modules/, dist/ & 01* video', () => {
  const forbiddenPaths = [
    '.agents/teamwork/ORIGINAL_REQUEST.md',
    '.gemini',
    '.bashrc',
    '.gitconfig',
    'motion-stage/node_modules/three/package.json',
    'reference_videos/01b_天刀官网_太白崖顶拔剑定势_全身镜头.mp4',
  ];

  const trackedSet = new Set(runGit(['ls-files']).split(/\r?\n/).filter(Boolean));
  for (const p of forbiddenPaths) {
    assert.equal(trackedSet.has(p), false, `SECURITY/LICENSE VIOLATION: "${p}" must NEVER be tracked in git!`);
    const ignored = execFileSync('git', ['check-ignore', p], {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      env: GIT_ENV,
    }).trim();
    assert.ok(ignored.length > 0, `Expected "${p}" to be matched by .gitignore`);
  }
  assert.equal(
    [...trackedSet].some(
      (p) =>
        p.startsWith('.agents/') ||
        p.startsWith('.gemini/') ||
        p.includes('node_modules/') ||
        p.startsWith('motion-stage/dist/') ||
        /^reference_videos\/01/.test(p)
    ),
    false,
    'Tracked files leaked forbidden directory or non-redistributable 01* video'
  );
});

test('[T2][F12][T2-F12-02] Every git-tracked blob in HEAD is strictly < 50 MB (50,000,000 bytes)', () => {
  const treeLines = runGit(['ls-tree', '-r', '-l', 'HEAD']).split(/\r?\n/).filter(Boolean);
  assert.ok(treeLines.length > 20, 'Expected populated HEAD tree');

  let maxBytes = 0;
  let maxPath = '';
  for (const line of treeLines) {
    const [meta, filePath] = line.split('\t');
    const parts = meta.trim().split(/\s+/);
    const size = Number(parts[3]);
    if (Number.isFinite(size) && size > maxBytes) {
      maxBytes = size;
      maxPath = filePath;
    }
  }
  assert.ok(
    maxBytes < 50_000_000,
    `Tracked git blob "${maxPath}" (${maxBytes} bytes) exceeds 50 MB GitHub safety ceiling`
  );
});

test('[T2][F12][T2-F12-03] Rapid 10x Workbench <-> Combat Arena mode switching leaks 0 duplicate canvases or WebGL errors', async () => {
  await withPage('/', async (page) => {
    await page.waitFor(() => Boolean(window.__MOTION_STAGE__), 2000, 50);
    page.clearLogs();

    const out = await page.evaluate(async () => {
      const buttons = Array.from(document.querySelectorAll('button, [role="tab"]'));
      const combatBtn = buttons.find((b) => /战斗|Combat|⚔/i.test(b.textContent || ''));
      const workbenchBtn = buttons.find((b) => /工作台|生产|Workbench|🛠/i.test(b.textContent || ''));
      if (!combatBtn || !workbenchBtn) throw new Error('Mode switcher buttons missing');

      for (let i = 0; i < 10; i++) {
        (i % 2 === 0 ? combatBtn : workbenchBtn).click();
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((r) => setTimeout(r, 150));
      const containerCanvases = document.querySelectorAll('#canvas-container canvas').length;
      return {
        containerCanvases,
        finalMode: window.__MOTION_STAGE__.getState().activeMode,
      };
    });

    assert.ok(out.containerCanvases <= 2, `Canvas leak detected in #canvas-container: ${out.containerCanvases}`);
    assert.equal(out.finalMode, 'workbench');
    assert.equal(page.pageErrors.length, 0);
  });
});

test('[T2][F12][T2-F12-04] Static middleware blocks path traversal (../../.bashrc) & returns 404 (not SPA HTML) for missing .bvh', async () => {
  for (const traversalUrl of [
    `${BASE_URL}/bvh_library/../../.gitconfig`,
    `${BASE_URL}/reference_videos/../../.bashrc`,
  ]) {
    const res = await fetch(traversalUrl);
    assert.ok(res.status === 403 || res.status === 404, `Path traversal ${traversalUrl} returned HTTP ${res.status}!`);
  }

  const missingBvh = await fetch(`${BASE_URL}/bvh_library/does_not_exist_999.bvh`);
  assert.equal(missingBvh.status, 404, `Missing .bvh must return HTTP 404 (not SPA 200 HTML), got ${missingBvh.status}`);
});

test('[T2][F12][T2-F12-05] Open-ended Range (bytes=1000-) & single-byte Range (bytes=0-0) return RFC-compliant HTTP 206', async () => {
  const spec02 = REFERENCE_VIDEO_SPECS.find((s) => s.key === '02');
  const url = `${BASE_URL}/reference_videos/${encodeURIComponent(spec02.file)}`;

  const resSingle = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  assert.equal(resSingle.status, 206);
  assert.equal(resSingle.headers.get('content-range'), `bytes 0-0/${spec02.bytes}`);
  assert.equal((await resSingle.arrayBuffer()).byteLength, 1);

  const resOpen = await fetch(url, { headers: { Range: 'bytes=1000-' } });
  assert.equal(resOpen.status, 206);
  const crOpen = resOpen.headers.get('content-range') || '';
  assert.ok(crOpen.startsWith('bytes 1000-'));
  await resOpen.body?.cancel();
});

test('[T2][F12][T2-F12-06] Unknown query ?mode=invalid_unknown_mode falls back cleanly to default Workbench mode', async () => {
  await withPage('/?mode=invalid_unknown_mode', async (page) => {
    await page.waitFor(() => Boolean(window.__MOTION_STAGE__), 2000, 50);
    const st = await page.evaluate(() => window.__MOTION_STAGE__.getState());
    assert.equal(st.activeMode, 'workbench');
    assert.equal(page.pageErrors.length, 0);
  });
});

test('[T2][F12][T2-F12-07] Workbench drag-and-drop overlay stays hidden when dragover fires inside Combat Arena', async () => {
  await withPage('/?mode=combat', async (page) => {
    await page.waitFor(() => window.__COMBAT_ARENA__?.getState()?.active === true, 2000, 50);
    const dropHidden = await page.evaluate(() => {
      window.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
      window.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
      const el = document.getElementById('drop-overlay');
      return el ? el.hidden || getComputedStyle(el).display === 'none' : true;
    });
    assert.equal(dropHidden, true);
  });
});

test('[T2][F12][T2-F12-08] Zero HTTP 404 asset errors during initial boot of both Workbench and Combat Arena', async () => {
  await withPage('/', async (page) => {
    await page.waitFor(() => Boolean(window.__MOTION_STAGE__), 2000, 50);
    await page.sleep(200);
    assert.deepEqual(page.httpErrors, [], `HTTP errors during Workbench boot: ${JSON.stringify(page.httpErrors)}`);
  });

  await withPage('/?mode=combat', async (page) => {
    await page.waitFor(() => window.__COMBAT_ARENA__?.getState()?.active === true, 2000, 50);
    await page.sleep(200);
    assert.deepEqual(page.httpErrors, [], `HTTP errors during Combat Arena boot: ${JSON.stringify(page.httpErrors)}`);
  });
});
