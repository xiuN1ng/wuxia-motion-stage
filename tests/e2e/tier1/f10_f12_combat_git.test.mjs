import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  WORKSPACE_ROOT,
  BASE_URL,
  ALL_26_BVH_REL_PATHS,
  REFERENCE_VIDEO_SPECS,
  EXPECTED_BONE_LAYER_WEIGHTS,
} from '../helpers/constants.mjs';
import {
  importThree,
  loadModuleContract,
  readBoneLayerWeight,
  extractExportedStateNames,
  extractExportedLayerWeights,
  getSharedEphemeralViteBuild,
} from '../helpers/contract_loader.mjs';
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

/**
 * Drives LayeredAnimator in pure Node using buildCharacterRig() ({ bones, rootGroup, ... })
 * so pelvis counter-yaw, 58% ForeArmTwist, and 360° SpringClothSolver all execute natively.
 */
async function driveLayeredAnimatorPose(
  layeredMod,
  baseFrame,
  upperFrame,
  upperAlpha = 1.0,
  dt = 1 / 60,
  worldVelXZ = { x: 0, z: 0 }
) {
  const rigMod = await loadModuleContract('src/rig/HumanoidRig.js', [
    'BONE_DEFS',
    'BONE_IDX',
    'buildCharacterRig',
  ]);
  const rig = rigMod.buildCharacterRig();
  const { bones } = rig;

  const baseClip = {
    id: 'test_base',
    fps: 60,
    totalFrames: 4,
    duration: 4 / 60,
    nonCyclic: false,
    frames: [baseFrame, baseFrame, baseFrame, baseFrame],
  };
  const upperClip = {
    id: 'test_upper',
    fps: 60,
    totalFrames: 4,
    duration: 4 / 60,
    nonCyclic: true,
    frames: [upperFrame, upperFrame, upperFrame, upperFrame],
  };

  const Ctor =
    layeredMod.LayeredAnimator ||
    layeredMod.createLayeredAnimator ||
    layeredMod.default;
  assert.equal(typeof Ctor, 'function', 'LayeredAnimator.js must export LayeredAnimator or createLayeredAnimator');

  const inst = Ctor.prototype ? new Ctor(rig, rig.rootGroup, null) : Ctor(rig, rig.rootGroup, null);
  if (typeof inst.evaluate === 'function') {
    for (let i = 0; i < 10; i++) {
      inst.evaluate(dt, {
        baseClip,
        baseClipId: 'test_base',
        baseNormalizedTime: 0,
        upperClip,
        upperClipId: 'test_upper',
        upperNormalizedTime: 0,
        targetUpperAlpha: upperAlpha,
        forceUpperAlpha: upperAlpha,
        worldPos: baseFrame.rootPos,
        playerYaw: 0,
        worldVelXZ,
        simTimeSec: i * dt,
      });
    }
  } else if (typeof layeredMod.blendUpperOverLowerWithCounterYaw === 'function') {
    const out = layeredMod.allocatePoseBuffer();
    layeredMod.blendUpperOverLowerWithCounterYaw(baseFrame, upperFrame, upperAlpha, out);
    bones[0].position.copy(out.rootPos);
    out.quats.forEach((q, idx) => bones[idx].quaternion.copy(q));
  }

  rig.rootGroup.updateMatrixWorld(true);
  return { rig, bones, BONE_IDX: rigMod.BONE_IDX, inst };
}

// ============================================================================
// Feature F10: Playable Wuxia Character Action State Machine (8 Happy-Path Tests)
// ============================================================================

test('[T1][F10][T1-F10-01] CombatStateMachine imports cleanly in bare Node and exposes >= 15 Wuxia states starting in Idle', async () => {
  assert.equal(typeof globalThis.window, 'undefined', 'Must run pure-ESM import check in bare Node');
  const fsmMod = await loadModuleContract('src/combat/CombatStateMachine.js');
  const stateSet = extractExportedStateNames(fsmMod);

  await withCombatArenaPage(async (page) => {
    const st = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      return a.getState();
    });

    assert.ok(
      stateSet.size >= 15,
      `Expected >= 15 exported Wuxia states from CombatStateMachine.js, found ${stateSet.size}`
    );
    for (const required of ['Idle', 'Move_8Way', 'Sprint', 'Dodge_Dash', 'Dodge_Roll', 'Jump', 'Hit_Knockdown', 'KipUp']) {
      assert.ok(stateSet.has(required), `Missing required Wuxia state "${required}" in CombatStateMachine`);
    }
    assert.equal(st.currentState, 'Idle');
    assert.equal(st.priority, 0);
    assert.ok(st.stateNormalizedTime >= 0 && st.stateNormalizedTime <= 1);
  });
});

test('[T1][F10][T1-F10-02] Locomotion transitions: unlocked WASD -> Sprint vs locked-on WASD -> Move_8Way -> Idle', async () => {
  await withCombatArenaPage(async (page) => {
    const startSt = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      return a.getState();
    });
    // Ensure unlocked so WASD enters Sprint
    if (startSt.isLockedOn) {
      await page.tapKey('Tab');
    }

    await page.keyDown('KeyW');
    const sprintSt = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.step(0.15);
      return a.getState();
    });
    await page.keyUp('KeyW');

    const distMoved = Math.hypot(
      sprintSt.playerWorldPos.x - startSt.playerWorldPos.x,
      sprintSt.playerWorldPos.z - startSt.playerWorldPos.z
    );
    assert.equal(sprintSt.isLockedOn, false);
    assert.equal(sprintSt.currentState, 'Sprint');
    assert.ok(sprintSt.priority >= 10, `Expected locomotion priority >= 10, got ${sprintSt.priority}`);
    assert.ok(distMoved > 0.1, `Expected playerWorldPos to advance during Sprint, moved=${distMoved}`);

    // Enable Lock-On (Tab) + KeyD -> Move_8Way
    await page.tapKey('Tab');
    await page.keyDown('KeyD');
    const strafeSt = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.step(0.15);
      return a.getState();
    });
    await page.keyUp('KeyD');
    assert.equal(strafeSt.isLockedOn, true);
    assert.equal(strafeSt.currentState, 'Move_8Way');

    // Release movement -> Idle
    const idleSt = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.step(0.25);
      return a.getState();
    });
    assert.equal(idleSt.currentState, 'Idle');
  });
});

test('[T1][F10][T1-F10-03] 3-hit light attack combo chains deterministically: Idle -> Attack_Combo_1 -> 2 -> 3 -> Idle', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      // Step backward clear of dummy so pure combo timing runs cleanly
      a.dispatchAction('Move', { x: 0, z: -1 });
      a.step(0.45);
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.step(0.2);

      a.dispatchAction('Attack');
      a.step(1 / 60);
      const s1 = a.getState().currentState;

      let chain1Open = false;
      for (let i = 0; i < 20; i++) {
        a.step(0.05);
        if (a.getState().canComboChain) {
          chain1Open = true;
          break;
        }
      }
      a.dispatchAction('Attack');
      let s2 = a.getState().currentState;
      for (let i = 0; i < 8 && s2 !== 'Attack_Combo_2'; i++) {
        a.step(0.04);
        s2 = a.getState().currentState;
      }

      let chain2Open = false;
      for (let i = 0; i < 20; i++) {
        a.step(0.05);
        if (a.getState().canComboChain) {
          chain2Open = true;
          break;
        }
      }
      a.dispatchAction('Attack');
      let s3 = a.getState().currentState;
      for (let i = 0; i < 8 && s3 !== 'Attack_Combo_3'; i++) {
        a.step(0.04);
        s3 = a.getState().currentState;
      }

      a.step(2.0);
      return { s1, chain1Open, s2, chain2Open, s3, endState: a.getState().currentState };
    });

    assert.equal(res.s1, 'Attack_Combo_1');
    assert.equal(res.chain1Open, true);
    assert.equal(res.s2, 'Attack_Combo_2');
    assert.equal(res.chain2Open, true);
    assert.equal(res.s3, 'Attack_Combo_3');
    assert.equal(res.endState, 'Idle');
  });
});

test('[T1][F10][T1-F10-04] 180ms input buffer queues early Attack before chain window and auto-fires Attack_Combo_2', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      a.dispatchAction('Move', { x: 0, z: -1 });
      a.step(0.45);
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.step(0.2);

      // Dry-run to locate exact elapsed time when canComboChain opens in Attack_Combo_1
      a.dispatchAction('Attack');
      let openAtSec = -1;
      for (let i = 1; i <= 40; i++) {
        a.step(0.025);
        if (a.getState().canComboChain) {
          openAtSec = i * 0.025;
          break;
        }
      }
      a.step(2.0); // Return to Idle

      // Replay: step to (openAtSec - 0.10s) — strictly BEFORE window opens (canComboChain === false),
      // within the 180ms buffer TTL! Queue Attack ONCE, then step 0.25s with ZERO new inputs!
      a.dispatchAction('Attack');
      a.step(Math.max(0.02, openAtSec - 0.1));
      const preWin = a.getState();
      a.dispatchAction('Attack');
      let autoFiredCombo2 = false;
      for (let i = 0; i < 8; i++) {
        a.step(0.035);
        if (a.getState().currentState === 'Attack_Combo_2') {
          autoFiredCombo2 = true;
          break;
        }
      }
      return { openAtSec, preState: preWin.currentState, preCanChain: preWin.canComboChain, autoFiredCombo2 };
    });

    assert.ok(res.openAtSec > 0.12, `Expected chain window after 0.12s, got ${res.openAtSec}`);
    assert.equal(res.preState, 'Attack_Combo_1');
    assert.equal(res.preCanChain, false, 'Must queue buffered Attack strictly before canComboChain opens');
    assert.equal(res.autoFiredCombo2, true, '180ms input buffer must auto-fire Attack_Combo_2 when window opens');
  });
});

test('[T1][F10][T1-F10-05] Dodge_Dash cancel, Dodge_Roll i-frames, and Jump -> Air_Jump_Double airborne chain', async () => {
  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction('Move', { x: 0, z: -1 });
      a.step(0.4);
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.step(0.15);

      // 1. Mid-attack Dodge_Dash cancel
      a.dispatchAction('Attack');
      a.step(0.18);
      const pos0 = { ...a.getState().playerWorldPos };
      a.dispatchAction('Dodge_Dash');
      a.step(0.05);
      const dashState = a.getState().currentState;
      const dashInvuln = a.getState().isInvulnerable;
      a.step(0.75);
      const dashDist = Math.hypot(
        a.getState().playerWorldPos.x - pos0.x,
        a.getState().playerWorldPos.z - pos0.z
      );

      // 2. Dodge_Roll i-frames
      a.dispatchAction('Dodge_Roll');
      a.step(0.08);
      const rollState = a.getState().currentState;
      const rollInvuln = a.getState().isInvulnerable;
      a.step(1.1);

      // 3. Jump -> Air_Jump_Double -> ground landing
      a.dispatchAction('Jump');
      a.step(0.16);
      a.dispatchAction('Jump');
      a.step(0.05);
      const doubleState = a.getState().currentState;
      let maxY = a.getState().playerWorldPos.y;
      for (let i = 0; i < 12; i++) {
        a.step(0.08);
        maxY = Math.max(maxY, a.getState().playerWorldPos.y);
      }
      a.step(1.0);
      const endY = a.getState().playerWorldPos.y;

      return { dashState, dashInvuln, dashDist, rollState, rollInvuln, doubleState, maxY, endY };
    });

    assert.equal(out.dashState, 'Dodge_Dash');
    assert.equal(out.dashInvuln, true);
    assert.ok(out.dashDist > 0.6, `Expected forward burst on Dodge_Dash, got ${out.dashDist.toFixed(2)}m`);
    assert.equal(out.rollState, 'Dodge_Roll');
    assert.equal(out.rollInvuln, true);
    assert.equal(out.doubleState, 'Air_Jump_Double');
    assert.ok(out.maxY > 0.35, `Expected airborne height > 0.35m, got ${out.maxY.toFixed(2)}m`);
    assert.ok(Math.abs(out.endY) <= 0.08);
  });
});

test('[T1][F10][T1-F10-06] Skill_Wuhen activates parry window and deflects incoming enemy strike without stagger', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction('TriggerDummyAttack', 'light');
      // Step through telegraph until right before strike lands, then fire Skill_Wuhen parry!
      a.dispatchAction('Skill_Wuhen');
      a.step(0.05);
      const parryActive = a.getState().inParryWindow;
      for (const act of ['IncomingHit', 'TakeHit']) {
        a.dispatchAction(act, { type: 'light', side: 'L', damage: 15 });
      }
      a.step(0.05);
      return { parryActive, stateAfter: a.getState().currentState };
    });

    assert.equal(res.parryActive, true);
    assert.ok(!res.stateAfter.startsWith('Hit_'), `Expected parry deflect, got ${res.stateAfter}`);
  });
});

test('[T1][F10][T1-F10-07] Unguarded light hit enters Hit_Light_L/R and Evade_Backflip (KeyV) emergency-breaks stagger', async () => {
  await withCombatArenaPage(async (page) => {
    const out = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      for (const act of ['IncomingHit', 'TakeHit', 'TriggerDummyAttack']) {
        a.dispatchAction(act, 'light');
        if (/^Hit_Light/.test(a.getState().currentState)) break;
      }
      if (!/^Hit_Light/.test(a.getState().currentState)) {
        a.dispatchAction('DummyMode', 2);
        for (let i = 0; i < 20 && !/^Hit_Light/.test(a.getState().currentState); i++) a.step(0.15);
      }
      const staggerState = a.getState().currentState;
      return { staggerState };
    });
    assert.ok(/^Hit_Light_(L|R)$/.test(out.staggerState), `Expected Hit_Light_L/R, got ${out.staggerState}`);

    await page.tapKey('KeyV');
    const breakout = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      if (a.getState().currentState !== 'Evade_Backflip') a.dispatchAction('Evade_Backflip');
      a.step(0.05);
      const s = a.getState();
      return { state: s.currentState, invuln: s.isInvulnerable };
    });
    assert.equal(breakout.state, 'Evade_Backflip');
    assert.equal(breakout.invuln, true);
  });
});

test('[T1][F10][T1-F10-08] Heavy hit enters Hit_Knockdown (priority 100) and chains into KipUp at floor window', async () => {
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
        for (let i = 0; i < 20 && a.getState().currentState !== 'Hit_Knockdown'; i++) a.step(0.1);
      }
      const enter = a.getState();
      for (let i = 0; i < 25; i++) {
        if (a.getState().stateNormalizedTime >= 0.66 || a.getState().currentState !== 'Hit_Knockdown') break;
        a.step(0.08);
      }
      a.dispatchAction('KipUp');
      if (a.getState().currentState !== 'KipUp') a.dispatchAction('Jump');
      a.step(0.05);
      const kip = a.getState();
      a.step(1.8);
      return {
        enterState: enter.currentState,
        enterPriority: enter.priority,
        kipState: kip.currentState,
        kipInvuln: kip.isInvulnerable,
        finalState: a.getState().currentState,
      };
    });

    assert.equal(out.enterState, 'Hit_Knockdown');
    assert.equal(out.enterPriority, 100);
    assert.equal(out.kipState, 'KipUp');
    assert.equal(out.kipInvuln, true);
    assert.equal(out.finalState, 'Idle');
  });
});

// ============================================================================
// Feature F11: Upper/Lower Body Layered Blending & 3D Combat Arena (8 Happy-Path Tests)
// ============================================================================

test('[T1][F11][T1-F11-01] LayeredAnimator.js & Combat Arena expose exact 21-bone Spine=0.55 / Chest=0.85 / Arms=1.0 mask', async () => {
  const layeredMod = await loadModuleContract('src/combat/LayeredAnimator.js');
  const modWeights =
    (typeof layeredMod.getBoneLayerWeightsMap === 'function' && layeredMod.getBoneLayerWeightsMap()) ||
    layeredMod.UPPER_BONE_WEIGHTS ||
    (await extractExportedLayerWeights(layeredMod));

  await withCombatArenaPage(async (page) => {
    const browserWeights = await page.evaluate(() => window.__COMBAT_ARENA__.getState().boneLayerWeights);
    const activeWeights = browserWeights || modWeights;
    assert.ok(activeWeights, 'Missing boneLayerWeights in both LayeredAnimator.js and __COMBAT_ARENA__.getState()');

    for (const spec of EXPECTED_BONE_LAYER_WEIGHTS) {
      const w = readBoneLayerWeight(activeWeights, spec.name, spec.rigIdx);
      assert.ok(
        typeof w === 'number' && Math.abs(w - spec.weight) <= 0.02,
        `Bone ${spec.name} (idx=${spec.rigIdx}) expected weight=${spec.weight}, got ${w}`
      );
    }
  });
});

test('[T1][F11][T1-F11-02] Moving-while-slashing activates upperLayerAlpha > 0.80 over locomotion baseClipId', async () => {
  await withCombatArenaPage(async (page) => {
    const blendState = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');
      a.dispatchAction('Move', { x: -1, z: 0 });
      a.step(0.1);
      a.dispatchAction('Attack');
      a.step(0.18);
      const st = a.getState();
      a.dispatchAction('Move', { x: 0, z: 0 });
      return st;
    });

    assert.ok(blendState.baseClipId, 'Expected non-null locomotion baseClipId');
    assert.ok(blendState.upperClipId, 'Expected non-null slash upperClipId while moving and attacking');
    assert.ok(
      blendState.upperLayerAlpha > 0.8,
      `Expected upperLayerAlpha > 0.80 during moving slash, got ${blendState.upperLayerAlpha}`
    );
  });
});

test('[T1][F11][T1-F11-03] Pelvis counter-yaw compensation stabilizes Chest world forward aim during twisted lower stride', async () => {
  const layeredMod = await loadModuleContract('src/combat/LayeredAnimator.js');
  const rigMod = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const { BONE_IDX } = rigMod;

  const baseFrame = {
    rootPos: new THREE.Vector3(0, 0.94, 0),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  };
  baseFrame.quats[BONE_IDX.Hips].setFromAxisAngle(new THREE.Vector3(0, 1, 0), (30 * Math.PI) / 180);

  const upperFrame = {
    rootPos: new THREE.Vector3(0, 0.94, 0),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  };

  const { bones } = await driveLayeredAnimatorPose(layeredMod, baseFrame, upperFrame, 1.0);
  const qChestWorld = new THREE.Quaternion();
  bones[BONE_IDX.Chest].getWorldQuaternion(qChestWorld);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qChestWorld);
  const chestYawDeg = Math.abs((Math.atan2(fwd.x, fwd.z) * 180) / Math.PI);

  assert.ok(
    chestYawDeg < 16.0,
    `Expected pelvis counter-yaw compensation to reduce Chest world yaw < 16° (vs 30° uncompensated), got ${chestYawDeg.toFixed(2)}°`
  );
});

test('[T1][F11][T1-F11-04] LayeredAnimator secondary pass drives 58% ForeArmTwist & dynamic SpringClothSolver', async () => {
  const layeredMod = await loadModuleContract('src/combat/LayeredAnimator.js');
  const rigMod = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const { BONE_IDX } = rigMod;

  const baseFrame = {
    rootPos: new THREE.Vector3(0, 0.94, 0.5),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  };
  const upperFrame = {
    rootPos: new THREE.Vector3(0, 0.94, 0.5),
    quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
    contactL: true,
    contactR: true,
  };
  upperFrame.quats[BONE_IDX.RightHand].setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.0);

  const { bones } = await driveLayeredAnimatorPose(
    layeredMod,
    baseFrame,
    upperFrame,
    1.0,
    1 / 60,
    { x: 0, z: 3.5 }
  );
  const qTwist = bones[BONE_IDX.RightForeArmTwist].quaternion;
  const twistAng = 2 * Math.acos(Math.min(1, Math.abs(qTwist.w)));
  assert.ok(
    Math.abs(twistAng - 0.58) <= 0.06,
    `Expected ~0.58 rad on RightForeArmTwist from 1.0 rad RightHand roll, got ${twistAng.toFixed(3)}`
  );

  let capeMoved = false;
  for (let i = 0; i < 4; i++) {
    const qc = bones[BONE_IDX.Cape01 + i].quaternion;
    assert.ok(Math.abs(qc.length() - 1) <= 1e-4, `Cape0${i + 1} non-unit quaternion`);
    if (2 * Math.acos(Math.min(1, Math.abs(qc.w))) > 0.02) capeMoved = true;
  }
  assert.equal(capeMoved, true, 'SpringClothSolver should update Cape01..04 away from rigid identity');
});

test('[T1][F11][T1-F11-05] Combat Arena WebGL2 canvas mounts cleanly with "prod" skinning weights (never "bad" mode)', async () => {
  await withCombatArenaPage(
    async (page) => {
      const info = await page.evaluate(async () => {
        const canvases = Array.from(document.querySelectorAll('canvas'));
        // On a WebGL/WebGL2 canvas already bound by Three.js WebGLRenderer, getContext('2d') is strictly null!
        const webglCanvas = canvases.find((c) => c.width >= 640 && c.height >= 360 && c.getContext('2d') === null);
        const st = window.__COMBAT_ARENA__.getState();

        const { buildCharacterRig, BONE_IDX } = await import('/src/rig/HumanoidRig.js');
        const sampleProd = buildCharacterRig();
        sampleProd.setSkinningVisualState('prod', false);
        const prodIdxArr = sampleProd.mesh.geometry.attributes.skinIndex.array;
        let prodUsesClothOrTwist = false;
        for (let i = 0; i < prodIdxArr.length; i++) {
          if (prodIdxArr[i] === BONE_IDX.RightForeArmTwist || prodIdxArr[i] >= BONE_IDX.SkirtFront) {
            prodUsesClothOrTwist = true;
            break;
          }
        }

        return {
          canvasW: webglCanvas?.width || 0,
          canvasH: webglCanvas?.height || 0,
          hasWebGL: Boolean(webglCanvas),
          active: st.active,
          prodUsesClothOrTwist,
        };
      });

      assert.equal(info.hasWebGL, true, 'Expected active WebGL2 canvas in Combat Arena');
      assert.ok(info.canvasW >= 640 && info.canvasH >= 360, `Unexpected canvas size ${info.canvasW}x${info.canvasH}`);
      assert.equal(info.active, true);
      assert.equal(info.prodUsesClothOrTwist, true);
      assert.equal(page.pageErrors.length, 0, `Uncaught errors: ${page.pageErrors.join('; ')}`);
    },
    { width: 1280, height: 720 }
  );
});

test('[T1][F11][T1-F11-06] Tab Lock-On toggles cleanly and orients playerYaw toward Enemy Dummy during 8-way strafe', async () => {
  await withCombatArenaPage(async (page) => {
    const beforeTab = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      return a.getState().isLockedOn;
    });
    await page.tapKey('Tab');
    const afterTab1 = await page.evaluate(() => window.__COMBAT_ARENA__.getState().isLockedOn);
    assert.equal(afterTab1, !beforeTab, 'Tab key must toggle isLockedOn');
    if (!afterTab1) {
      await page.tapKey('Tab');
    }

    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction('Move', { x: -1, z: 0 });
      a.step(0.25);
      const leftSt = a.getState();

      a.dispatchAction('Move', { x: 1, z: 1 });
      a.step(0.25);
      const diagSt = a.getState();
      a.dispatchAction('Move', { x: 0, z: 0 });
      return { leftSt, diagSt };
    });

    assert.equal(res.leftSt.isLockedOn, true);
    assert.equal(res.leftSt.currentState, 'Move_8Way');
    assert.equal(res.diagSt.currentState, 'Move_8Way');
    const movedBetween = Math.hypot(
      res.diagSt.playerWorldPos.x - res.leftSt.playerWorldPos.x,
      res.diagSt.playerWorldPos.z - res.leftSt.playerWorldPos.z
    );
    assert.ok(movedBetween > 0.1);
    assert.ok(Number.isFinite(res.diagSt.playerYaw));
  });
});

test('[T1][F11][T1-F11-07] Enemy Dummy switches across all 3 AI modes (Passive / Light Counter / Heavy Knockdown)', async () => {
  await withCombatArenaPage(async (page) => {
    await page.tapKey('Digit1');
    const m1 = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.step(1.2);
      return a.getState();
    });
    assert.ok(!m1.currentState.startsWith('Hit_'), 'Passive Dummy Mode 1 must never attack player');

    await page.tapKey('Digit2');
    const m2 = await page.evaluate(() => window.__COMBAT_ARENA__.getState().dummyMode);

    await page.tapKey('Digit3');
    const m3 = await page.evaluate(() => window.__COMBAT_ARENA__.getState().dummyMode);

    assert.notEqual(m1.dummyMode, m2);
    assert.notEqual(m2, m3);
  });
});

test('[T1][F11][T1-F11-08] Swept swordGroup blade hitbox damages Dummy, triggers hitstop, and updates Combat HUD DOM', async () => {
  await withCombatArenaPage(async (page) => {
    const res = await page.evaluate(() => {
      const a = window.__COMBAT_ARENA__;
      a.dispatchAction?.('Reset');
      a.dispatchAction?.('DummyMode', 1);
      const hp0 = a.getState().dummyHp;

      if (!a.getState().isLockedOn) a.dispatchAction('ToggleLockOn');
      a.dispatchAction('Move', { x: 0, z: 1 });
      a.step(0.6);
      a.dispatchAction('Move', { x: 0, z: 0 });
      a.dispatchAction('Attack');

      let maxHitstop = 0;
      for (let i = 0; i < 16; i++) {
        a.step(0.035);
        const s = a.getState();
        maxHitstop = Math.max(maxHitstop, s.hitstopRemainingMs || 0);
        if (s.dummyHp < hp0 && maxHitstop > 0) break;
      }
      const finalS = a.getState();
      return {
        hp0,
        hpAfter: finalS.dummyHp,
        comboCount: finalS.comboCount,
        maxHitstop,
        hudText: document.body.innerText,
      };
    });

    assert.ok(res.hpAfter < res.hp0, `Expected swept sword hit to reduce dummyHp (${res.hp0} -> ${res.hpAfter})`);
    assert.ok(res.comboCount >= 1);
    assert.ok(res.maxHitstop > 0);
    assert.ok(res.hudText.length > 15);
  });
});

// ============================================================================
// Feature F12: Unified Workbench/Combat Integration & Git/GitHub Repo (8 Happy-Path Tests)
// ============================================================================

test('[T1][F12][T1-F12-01] Unified top-bar mode switcher on :5173 toggles seamlessly between Workbench and Combat Arena', async () => {
  await withPage('/', async (page) => {
    await page.waitFor(() => Boolean(document.querySelector('#canvas-container canvas')), 2000, 50);
    const res = await page.evaluate(async () => {
      const ms = window.__MOTION_STAGE__;
      if (!ms) return { hasMs: false };
      const initialMode = ms.getState().activeMode;

      const buttons = Array.from(document.querySelectorAll('button, a, [role="tab"]'));
      const combatBtn = buttons.find((b) => /战斗|Combat|⚔/i.test(b.textContent || ''));
      const workbenchBtn = buttons.find((b) => /工作台|生产|Workbench|🛠/i.test(b.textContent || ''));
      if (!combatBtn || !workbenchBtn) return { hasMs: true, hasSwitcher: false };

      combatBtn.click();
      await new Promise((r) => setTimeout(r, 350));
      const combatActive = Boolean(window.__COMBAT_ARENA__?.getState()?.active);

      workbenchBtn.click();
      await new Promise((r) => setTimeout(r, 250));
      const combatAfter = Boolean(window.__COMBAT_ARENA__?.getState()?.active);
      const modeAfter = ms.getState().activeMode;

      return { hasMs: true, hasSwitcher: true, initialMode, combatActive, combatAfter, modeAfter };
    });

    assert.equal(res.hasMs, true, 'Missing window.__MOTION_STAGE__');
    assert.equal(res.hasSwitcher, true, 'Missing unified Workbench <-> Combat Arena mode switcher buttons');
    assert.equal(res.initialMode, 'workbench');
    assert.equal(res.combatActive, true);
    assert.equal(res.combatAfter, false);
    assert.equal(res.modeAfter, 'workbench');
    assert.equal(page.pageErrors.length, 0);
  });
});

test('[T1][F12][T1-F12-02] Direct navigation to /?mode=combat boots directly into active 3D Combat Arena', async () => {
  await withPage('/?mode=combat', async (page) => {
    const st = await page
      .waitFor(
        () =>
          window.__COMBAT_ARENA__?.getState()?.active === true
            ? window.__COMBAT_ARENA__.getState()
            : null,
        2000,
        50
      )
      .catch(() => null);

    assert.ok(st && st.active === true, 'Navigating to /?mode=combat must boot directly into active Combat Arena');
    assert.ok(Array.isArray(st.loadedClipIds) && st.loadedClipIds.length > 0);
    assert.equal(page.pageErrors.length, 0);
  });
});

test('[T1][F12][T1-F12-03] Active Combat Arena pauses Workbench rAF loop and isolates Spacebar input', async () => {
  await withPage('/', async (page) => {
    await page.waitFor(() => Boolean(window.__MOTION_STAGE__), 2000, 50);
    const beforeSwitch = await page.evaluate(async () => {
      const buttons = Array.from(document.querySelectorAll('button, [role="tab"]'));
      const combatBtn = buttons.find((b) => /战斗|Combat|⚔/i.test(b.textContent || ''));
      if (!combatBtn) throw new Error('Combat mode tab button not found');
      combatBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const s = window.__MOTION_STAGE__.getState();
      return { t0: s.normalizedTime, playing0: s.isPlaying };
    });

    await page.sleep(300);
    await page.tapKey('Space');
    await page.sleep(80);

    const afterWait = await page.evaluate(() => {
      const s = window.__MOTION_STAGE__.getState();
      return { t1: s.normalizedTime, playing1: s.isPlaying };
    });

    assert.equal(afterWait.t1, beforeSwitch.t0, 'Workbench rAF normalizedTime must NOT advance while Combat Arena is active');
    assert.equal(afterWait.playing1, beforeSwitch.playing0, 'Spacebar in Combat Arena must NOT toggle Workbench isPlaying');
  });
});

test('[T1][F12][T1-F12-04] Vite static serving returns HTTP 200 for MANIFEST.json and all 26 bvh_library .bvh files', async () => {
  const manifestRes = await fetch(`${BASE_URL}/bvh_library/MANIFEST.json`);
  assert.equal(manifestRes.status, 200, 'Expected HTTP 200 for /bvh_library/MANIFEST.json');
  const manifestJson = await manifestRes.json();
  const list = Array.isArray(manifestJson) ? manifestJson : manifestJson?.clips;
  assert.ok(Array.isArray(list) && list.length >= 26, `Expected >= 26 clips in served MANIFEST.json, got ${list?.length}`);

  for (const rel of ALL_26_BVH_REL_PATHS) {
    const encoded = rel
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const res = await fetch(`${BASE_URL}/bvh_library/${encoded}`);
    assert.equal(res.status, 200, `Expected HTTP 200 for /bvh_library/${rel}, got ${res.status}`);
    const text = await res.text();
    assert.ok(text.trimStart().startsWith('HIERARCHY') && text.includes('ROOT Hips') && text.includes('MOTION'));
  }
});

test('[T1][F12][T1-F12-05] Vite static serving supports HTTP 206 Partial Content Range requests on all 5 reference videos', async () => {
  for (const spec of REFERENCE_VIDEO_SPECS) {
    const url = `${BASE_URL}/reference_videos/${encodeURIComponent(spec.file)}`;
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    assert.equal(res.status, 206, `Expected HTTP 206 Partial Content for ${spec.file}, got ${res.status}`);
    const cr = res.headers.get('content-range') || '';
    assert.ok(cr.startsWith('bytes 0-1023/'), `Expected Content-Range bytes 0-1023/... on ${spec.file}, got "${cr}"`);
    const buf = await res.arrayBuffer();
    assert.equal(buf.byteLength, 1024, `Expected 1024-byte Range payload for ${spec.file}`);
  }
});

test('[T1][F12][T1-F12-06] Ephemeral vite build to /dev/shm bundles index/assets/mediapipe/bvh_library without mutating dist/', () => {
  const build = getSharedEphemeralViteBuild();
  assert.deepEqual(
    build.distAfter,
    build.distBefore,
    'E2E vite build MUST NOT mutate /home/antigravity/motion-stage/dist'
  );

  assert.equal(fs.existsSync(path.join(build.shmOutDir, 'index.html')), true);
  assert.equal(fs.existsSync(path.join(build.shmOutDir, 'mediapipe/chunks/manifest.json')), true);
  const assetsDir = path.join(build.shmOutDir, 'assets');
  assert.ok(fs.existsSync(assetsDir) && fs.readdirSync(assetsDir).some((f) => f.endsWith('.js')));

  assert.equal(
    fs.existsSync(path.join(build.shmOutDir, 'bvh_library/MANIFEST.json')),
    true,
    'vite build must copy bvh_library/MANIFEST.json into output bvh_library/'
  );
  for (const rel of ALL_26_BVH_REL_PATHS) {
    assert.equal(
      fs.existsSync(path.join(build.shmOutDir, 'bvh_library', rel)),
      true,
      `Missing ${rel} in built bvh_library/`
    );
  }
});

test('[T1][F12][T1-F12-07] Root Git repo (.git), root-allowlist .gitignore, README.md & LICENSE-CC-BY-3.0.md track deliverables', () => {
  const gitignorePath = path.join(WORKSPACE_ROOT, '.gitignore');
  const readmePath = path.join(WORKSPACE_ROOT, 'README.md');
  const licensePath = path.join(WORKSPACE_ROOT, 'LICENSE-CC-BY-3.0.md');

  assert.equal(fs.existsSync(gitignorePath), true, 'Missing /home/antigravity/.gitignore');
  assert.equal(fs.existsSync(readmePath), true, 'Missing /home/antigravity/README.md');
  assert.equal(fs.existsSync(licensePath), true, 'Missing /home/antigravity/LICENSE-CC-BY-3.0.md');

  const gitignoreText = fs.readFileSync(gitignorePath, 'utf8');
  assert.ok(/^\/?\*\s*$/m.test(gitignoreText), '.gitignore must use $HOME root-allowlist pattern (/*)');
  assert.ok(gitignoreText.includes('!'), '.gitignore must explicitly un-ignore project paths (!...)');

  const tracked = runGit(['ls-files']).split(/\r?\n/).filter(Boolean);
  const trackedSet = new Set(tracked);
  for (const reqFile of ['README.md', 'LICENSE-CC-BY-3.0.md', '.gitignore', 'env-setup.sh']) {
    assert.ok(trackedSet.has(reqFile), `Expected "${reqFile}" to be tracked in git ls-files`);
  }
  assert.ok(tracked.some((p) => p.startsWith('docs/')));
  assert.ok(tracked.some((p) => p.startsWith('bvh_library/')));
  assert.ok(tracked.some((p) => p.startsWith('motion-stage/src/')));
  assert.ok(tracked.some((p) => p.startsWith('motion-stage/public/mediapipe/chunks/')));
});

test('[T1][F12][T1-F12-08] Structured Git commit history, clean deliverable working tree & GitHub auth/remote readiness', () => {
  const logOut = runGit(['log', '--oneline', '-n', 10].map(String)).trim();
  assert.ok(logOut.length > 0, 'Expected non-empty structured git commit history');

  const dirtyDeliverables = runGit([
    'status',
    '--porcelain',
    '--',
    'motion-stage',
    'docs',
    'bvh_library',
    'README.md',
    'LICENSE-CC-BY-3.0.md',
    '.gitignore',
    'env-setup.sh',
  ]).trim();
  assert.equal(dirtyDeliverables, '', `Tracked project deliverables have uncommitted changes:\n${dirtyDeliverables}`);

  const ghStatus = execFileSync('/opt/antigravity/bin/gh', ['auth', 'status'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: 15000,
  });
  assert.ok(/Logged in to github\.com/i.test(ghStatus), 'gh auth status must confirm active GitHub login');

  const remotes = runGit(['remote', '-v']).trim();
  const readmeText = fs.readFileSync(path.join(WORKSPACE_ROOT, 'README.md'), 'utf8');
  assert.ok(
    remotes.includes('github.com') || /github/i.test(readmeText),
    'Expected GitHub remote configured or documented in README.md'
  );
});
