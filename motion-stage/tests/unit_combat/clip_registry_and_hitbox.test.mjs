import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { MOCAP_RUN_BVH } from '../../src/anim/mocap/bvhBundle.js';
import {
  CANONICAL_CLIP_SPECS,
  createCombatClipRegistry,
  isValidBVHText,
  parseBVHToRawFrames,
  retargetRawMocapFallback,
  createEmptyPoseFrame,
} from '../../src/combat/CombatClipRegistry.js';
import { createCombatArena } from '../../src/combat/CombatArenaApp.js';
import { EnemyDummy, testSweptBladeVsCapsule } from '../../src/combat/EnemyDummy.js';

const RAD2DEG = 180 / Math.PI;

/**
 * Serializes frames using the canonical 21-bone HIERARCHY from `01_wuxia_idle_待机呼吸_cleaned.bvh`
 * (`cm` root position + `ZXY` Euler degrees, 66 channels) so M3 unit tests remain 100% isolated
 * even if M1 is concurrently editing `src/pipeline/*`, plus runs `BVHExporter` when available.
 */
async function serializeStandard21BoneBVH(frames, fps = 60) {
  const refBvh = await fs.readFile(
    '/home/antigravity/bvh_library/B_cleaned_ready/01_wuxia_idle_待机呼吸_cleaned.bvh',
    'utf8'
  );
  const hierarchyPart = refBvh.split(/\bMOTION\b/)[0].trimEnd();

  // Exact joint traversal order in standard 21-bone HIERARCHY
  const jointBoneIndices = [];
  for (const line of hierarchyPart.split(/\r?\n/)) {
    const m = line.trim().match(/^(?:ROOT|JOINT)\s+(\S+)/);
    if (m) jointBoneIndices.push(m[1]);
  }
  const nameToIdx = {
    Hips: 0,
    Spine: 1,
    Chest: 2,
    Neck: 3,
    Head: 4,
    LeftShoulder: 5,
    LeftUpperArm: 6,
    LeftForeArm: 7,
    LeftHand: 9,
    RightShoulder: 10,
    RightUpperArm: 11,
    RightForeArm: 12,
    RightHand: 14,
    LeftUpLeg: 15,
    LeftLeg: 16,
    LeftFoot: 17,
    LeftToe: 18,
    RightUpLeg: 19,
    RightLeg: 20,
    RightFoot: 21,
    RightToe: 22,
  };

  // Read Hips rest OFFSET from reference HIERARCHY so exported X/Y/Zposition match exact convention
  const hipsOffsetMatch = hierarchyPart.match(/ROOT\s+Hips[\s\S]*?OFFSET\s+(\S+)\s+(\S+)\s+(\S+)/);
  const offX = hipsOffsetMatch ? Number(hipsOffsetMatch[1]) : 0;
  const offY = hipsOffsetMatch ? Number(hipsOffsetMatch[2]) : 0;
  const offZ = hipsOffsetMatch ? Number(hipsOffsetMatch[3]) : 0;

  const euler = new THREE.Euler(0, 0, 0, 'ZXY');
  const rows = [];
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f];
    const vals = [];
    for (const jName of jointBoneIndices) {
      const bIdx = nameToIdx[jName];
      if (jName === 'Hips') {
        vals.push(
          (fr.rootPos.x * 100 - offX).toFixed(4),
          (fr.rootPos.y * 100 - offY).toFixed(4),
          (fr.rootPos.z * 100 - offZ).toFixed(4)
        );
      }
      euler.setFromQuaternion(fr.quats[bIdx], 'ZXY');
      vals.push(
        (euler.z * RAD2DEG).toFixed(4),
        (euler.x * RAD2DEG).toFixed(4),
        (euler.y * RAD2DEG).toFixed(4)
      );
    }
    rows.push(vals.join(' '));
  }

  return `${hierarchyPart}\nMOTION\nFrames: ${frames.length}\nFrame Time: ${(1 / fps).toFixed(6)}\n${rows.join('\n')}\n`;
}

describe('CombatClipRegistry (F11b) & Swept 3D Hitbox / Headless Arena Integration (F11c)', () => {
  it('invokes explicit fetchImpl in Node, rejects Vite SPA <!doctype html> 200 OK fallback responses, and loads all 26+ clips cleanly', async () => {
    assert.equal(isValidBVHText('<!doctype html><html><body>SPA</body></html>'), false);
    assert.equal(isValidBVHText(''), false);
    assert.equal(isValidBVHText('HIERARCHY\nROOT Hips\n{\n}\nMOTION\nFrames: 1\nFrame Time: 0.016667\n'), true);

    // Simulate browser fetch returning HTTP 200 text/html for every URL and verify fetchImpl is genuinely called!
    let fetchCallCount = 0;
    const htmlFallbackFetch = async () => {
      fetchCallCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => '<!doctype html>\n<html lang="zh-CN"><head></head><body></body></html>',
      };
    };

    const regBrowserFallback = createCombatClipRegistry();
    await regBrowserFallback.loadAll({ fetchImpl: htmlFallbackFetch });
    assert.ok(
      fetchCallCount >= CANONICAL_CLIP_SPECS.length,
      `Expected fetchImpl to be called >= ${CANONICAL_CLIP_SPECS.length} times, got ${fetchCallCount}`
    );

    const ids = regBrowserFallback.getLoadedClipIds();
    assert.ok(ids.length >= 26, `Expected >= 26 clips even under HTML SPA fallback, got ${ids.length}`);
    for (const spec of CANONICAL_CLIP_SPECS) {
      assert.ok(regBrowserFallback.hasClip(spec.id), `Missing canonical clip ${spec.id}`);
      const c = regBrowserFallback.getClip(spec.id);
      assert.notEqual(c.provenance, 'bvh_library', `HTML SPA response must never register as bvh_library (${spec.id})`);
      assert.ok(c.frames.length > 0);
    }
  });

  it('throws clean descriptive Error on truncated/corrupt .bvh variants with zero TypeErrors, zero BVHLoader console spam, and zero 0-frame returns', async () => {
    const refCanonicalBvh = await fs.readFile(
      '/home/antigravity/bvh_library/B_cleaned_ready/01_wuxia_idle_待机呼吸_cleaned.bvh',
      'utf8'
    );
    const canonicalHeaderOnly =
      refCanonicalBvh.split(/\bFrame Time:[^\n]*\n/)[0] + 'Frame Time: 0.016667\n';
    const canonicalLines = refCanonicalBvh.split(/\r?\n/);
    const motionLineIdx = canonicalLines.findIndex((l) => /^Frame\s+Time\s*:/i.test(l.trim()));
    const canonicalMidRowTruncated =
      canonicalLines.slice(0, motionLineIdx + 1).join('\n') + '\n0 94 0 1 2 3 4 5\n';
    const canonicalFewerFramesThanDeclared =
      canonicalLines.slice(0, motionLineIdx + 3).join('\n') + '\n';
    const rawMocapTruncated = MOCAP_RUN_BVH.slice(0, Math.floor(MOCAP_RUN_BVH.length * 0.55));

    const badVariants = [
      '',
      '<!doctype html><html></html>',
      'HIERARCHY\nROOT Hips\n{\n OFFSET 0 0 0\n CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n}\nMOTION',
      'HIERARCHY\n{\n}\nMOTION\nFrames: 2\nFrame Time: 0.016667\n0 0 0\n',
      'HIERARCHY\nROOT Hips\n{\n OFFSET 0 0 0\n CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\nMOTION\nFrames: 1\nFrame Time: 0.016667\n0 0 0 0 0 0\n',
      'HIERARCHY\nROOT Hips\n{\n OFFSET 0 0 0\n CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n}\nMOTION\nFrames: 0\nFrame Time: 0.016667\n',
      'HIERARCHY\nROOT Hips\n{\n OFFSET 0 0 0\n CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n}\nMOTION\nFrames: 1\nFrame Time: 0\n0 0 0 0 0 0\n',
      canonicalHeaderOnly,
      canonicalMidRowTruncated,
      canonicalFewerFramesThanDeclared,
      rawMocapTruncated,
    ];

    const capturedErrors = [];
    const origConsoleError = console.error;
    console.error = (...args) => {
      capturedErrors.push(args.join(' '));
    };
    try {
      for (const bad of badVariants) {
        assert.throws(
          () => parseBVHToRawFrames(bad, 60),
          (err) => {
            assert.ok(err instanceof Error);
            assert.ok(!(err instanceof TypeError), `Must NOT throw TypeError: ${err.stack}`);
            assert.match(err.message, /Invalid or truncated BVH/i);
            return true;
          }
        );
        assert.throws(
          () => retargetRawMocapFallback(bad, 60),
          (err) => {
            assert.ok(err instanceof Error);
            assert.ok(!(err instanceof TypeError), `retargetRawMocapFallback must NOT throw TypeError: ${err.stack}`);
            assert.match(err.message, /Invalid or truncated BVH/i);
            return true;
          }
        );
      }
      assert.equal(
        capturedErrors.length,
        0,
        `Expected zero THREE.BVHLoader console.error spam, got: ${capturedErrors.join(' | ')}`
      );
    } finally {
      console.error = origConsoleError;
    }
  });

  it('loads real B_cleaned_ready 21-bone BVHs from disk, preserves >240 frames, anchors Frame-0, and round-trips losslessly', async () => {
    const reg = createCombatClipRegistry();
    await reg.loadAll();

    // Foundational 01..06 clips must load directly from bvh_library/B_cleaned_ready/
    for (const id of ['01_idle', '02_run', '03_sword_combo', '04_tornado_kick', '05_front_kick', '06_backflip']) {
      const clip = reg.getClip(id);
      assert.equal(clip.provenance, 'bvh_library', `Expected ${id} provenance === 'bvh_library'`);
      assert.ok(clip.frames.length >= 50);
    }

    // Verify 05_front_kick Frame-0 horizontal origin anchoring & +0.503m forward lunge extraction
    const kick = reg.getClip('05_front_kick');
    assert.equal(kick.rootTrackXZ[0], 0);
    assert.equal(kick.rootTrackXZ[1], 0);
    assert.ok(Math.abs(kick.peakForwardMeters - 0.503) < 0.01, `Unexpected kick lunge: ${kick.peakForwardMeters}`);
    assert.equal(kick.frames[0].rootPos.x, 0);
    assert.equal(kick.frames[0].rootPos.z, 0);

    // Verify cyclic strafe clips have zero secular drift snap across N-1 -> 0
    for (const sector of ['F', 'B', 'L', 'R', 'FL', 'FR', 'BL', 'BR']) {
      const strafe = reg.getClip(`07_strafe_${sector}`);
      const first = strafe.frames[0].rootPos;
      const last = strafe.frames[strafe.frames.length - 1].rootPos;
      assert.ok(Math.hypot(last.x - first.x, last.z - first.z) < 0.05);
    }

    // Verify >240 frame uncapped parsing & ZXY cm lossless round-trip
    const longRaw = [];
    for (let f = 0; f < 310; f++) {
      const fr = createEmptyPoseFrame();
      fr.rootPos.set(f * 0.005, 0.94, f * 0.01);
      fr.quats[0].setFromEuler(new THREE.Euler(0.1, f * 0.01, -0.05, 'ZXY'));
      fr.quats[20].setFromEuler(new THREE.Euler(0.45, 0, 0, 'ZXY')); // RightLeg
      longRaw.push(fr);
    }
    const serializedBvh = await serializeStandard21BoneBVH(longRaw, 60);
    const reparsed = parseBVHToRawFrames(serializedBvh, 60);
    assert.equal(reparsed.frames.length, 310, 'Must NOT cap BVH frames at 240');
    assert.ok(reparsed.frames[309].rootPos.distanceTo(longRaw[309].rootPos) < 1e-4);
    const dotRightLeg = Math.abs(reparsed.frames[150].quats[20].dot(longRaw[150].quats[20]));
    assert.ok(1 - dotRightLeg < 1e-6);
  });

  it('detects swept 3D blade segment vs capsule hits even when fast swing chords cross capsule between frames', () => {
    const dummyPos = { x: 0, y: 0, z: 1.65 };
    const prevBase = new THREE.Vector3(-0.7, 1.2, 1.55);
    const prevTip = new THREE.Vector3(-1.3, 1.3, 1.65);
    const currBase = new THREE.Vector3(0.7, 1.2, 1.55);
    const currTip = new THREE.Vector3(1.3, 1.3, 1.65);

    const hitRes = testSweptBladeVsCapsule(prevBase, prevTip, currBase, currTip, dummyPos);
    assert.equal(hitRes.hit, true);

    const missRes = testSweptBladeVsCapsule(
      new THREE.Vector3(-0.7, 1.2, -1.5),
      new THREE.Vector3(-1.3, 1.3, -1.5),
      new THREE.Vector3(0.7, 1.2, -1.5),
      new THREE.Vector3(1.3, 1.3, -1.5),
      dummyPos
    );
    assert.equal(missRes.hit, false);
  });

  it('preserves ParryStun across Wuhen riposte follow-through and prevents follow-up combos from infinitely resetting GuardBreak stun', async () => {
    const reg = createCombatClipRegistry();
    await reg.loadAll();

    // 1. Direct EnemyDummy state & stun-timer verification
    const dummy = new EnemyDummy(reg, { initialMode: 2 });
    dummy.applyParryDeflect({ counterDamage: 120, stunDummySec: 1.8, attackerPos: { x: 0, z: 0 } });
    assert.equal(dummy.aiState, 'ParryStun');
    assert.equal(dummy.getStatusLabel(), '弹反破招眩晕');
    assert.equal(dummy.poise, 0);
    assert.equal(dummy.hp, 880);

    dummy.update(0.15, { playerWorldPos: { x: 0, y: 0, z: 0 }, inHitstop: false });
    const elapsedBeforeRiposte = dummy.aiStateElapsed;
    const riposteRes = dummy.receivePlayerHit({
      damage: 55,
      poiseDamage: 40,
      heavy: true,
      attackerPos: { x: 0, z: 0 },
    });
    assert.equal(riposteRes.guardBroken, false, 'Riposte on ParryStun dummy must NOT re-trigger GuardBreak');
    assert.equal(dummy.aiState, 'ParryStun', 'aiState must remain ParryStun');
    assert.equal(dummy.getStatusLabel(), '弹反破招眩晕');
    assert.equal(dummy.aiStateDuration, 1.8);
    assert.equal(dummy.aiStateElapsed, elapsedBeforeRiposte, 'ParryStun elapsed timer must NOT reset');
    assert.equal(dummy.poise, 0);
    assert.equal(dummy.hp, 825);

    // 2. Follow-up hits on GuardBreak dummy return guardBroken: false and do NOT reset 1.35s stun timer
    dummy.reset();
    const breakRes = dummy.receivePlayerHit({
      damage: 28,
      poiseDamage: 200,
      guardBreak: true,
      attackerPos: { x: 0, z: 0 },
    });
    assert.equal(breakRes.guardBroken, true);
    assert.equal(dummy.aiState, 'GuardBreak');
    assert.equal(dummy.aiStateDuration, 1.35);

    dummy.update(0.50, { playerWorldPos: { x: 0, y: 0, z: 0 }, inHitstop: false });
    const elapsedMidBreak = dummy.aiStateElapsed;
    for (let h = 0; h < 3; h++) {
      const followUp = dummy.receivePlayerHit({
        damage: 24,
        poiseDamage: 30,
        guardBreak: h === 2,
        attackerPos: { x: 0, z: 0 },
      });
      assert.equal(followUp.guardBroken, false, 'Follow-up hit on GuardBreak dummy must return guardBroken: false');
      assert.equal(dummy.aiState, 'GuardBreak');
      assert.equal(dummy.aiStateElapsed, elapsedMidBreak, 'GuardBreak stun timer must NOT reset on follow-up hits');
      assert.equal(dummy.poise, 0);
    }
    // Stepping remaining 0.90s (0.50 + 0.90 = 1.40s > 1.35s) recovers poise cleanly (zero infinite stunlock)
    dummy.update(0.90, { playerWorldPos: { x: 0, y: 0, z: 0 }, inHitstop: false });
    assert.equal(dummy.aiState, 'Idle');
    assert.equal(dummy.poise, 100);
  });

  it('exposes exact 20-key getState() contract and executes live 3D hitboxes, guard-break, and full Wuhen parry + 0.50s riposte in headless arena', async () => {
    const arena = createCombatArena(null, { headless: true });
    await arena.mount();

    const exact20Keys = [
      'active',
      'currentState',
      'stateNormalizedTime',
      'priority',
      'isInvulnerable',
      'inParryWindow',
      'canComboChain',
      'baseClipId',
      'upperClipId',
      'upperLayerAlpha',
      'boneLayerWeights',
      'playerWorldPos',
      'playerYaw',
      'isLockedOn',
      'dummyMode',
      'dummyHp',
      'dummyPoise',
      'comboCount',
      'hitstopRemainingMs',
      'loadedClipIds',
    ].sort();

    const init = arena.getState();
    assert.deepEqual(Object.keys(init).sort(), exact20Keys);
    assert.equal(init.dummyHp, 1000);
    assert.equal(init.dummyPoise, 100);
    assert.ok(init.loadedClipIds.length >= 26);

    // 1. Standing Attack connects with 3D swept greatsword hitbox and reduces dummyHp
    arena.dispatchAction('Attack');
    let sawHitstop = false;
    for (let i = 0; i < 35; i++) {
      const st = arena.step(1 / 60);
      if (st.hitstopRemainingMs > 0) sawHitstop = true;
    }
    const afterAtk = arena.getState();
    assert.ok(afterAtk.dummyHp < 1000, `Expected dummyHp < 1000 after Attack, got ${afterAtk.dummyHp}`);
    assert.ok(afterAtk.comboCount >= 1);
    assert.equal(sawHitstop, true);

    // 2. Skill_Kick guard-break shatters dummyPoise to 0
    arena.dispatchAction('ResetArena');
    arena.dispatchAction('Skill_Kick');
    for (let i = 0; i < 45; i++) arena.step(1 / 60);
    assert.equal(arena.getState().dummyPoise, 0, 'Skill_Kick must shatter dummyPoise to 0');

    // 3. Mode 2 Dummy light attack deflected by Skill_Wuhen parry + full 0.50s riposte follow-through
    arena.dispatchAction('ResetArena');
    arena.dispatchAction('SetDummyMode', 2);
    arena.dispatchAction('TriggerDummyAttack', 'light'); // 0.45s telegraph
    arena.step(0.25); // 0.20s remaining on telegraph -> activate Skill_Wuhen (0.357s parry window)!
    arena.dispatchAction('Skill_Wuhen');
    arena.step(0.22); // Dummy strikes at 0.45s into active Wuhen parry window!
    const afterParry = arena.getState();
    assert.equal(afterParry.dummyPoise, 0, 'Wuhen deflect must shatter dummy poise');
    assert.equal(afterParry.dummyHp, 880, `Expected 120 deflect counter damage, got hp=${afterParry.dummyHp}`);

    // Step full 0.50s through 110ms hitstop + automatic riposte slash: riposte deals additional HP damage
    // without shortening the 1.8s ParryStun window (poise remains 0 at t = 0.52s < 1.8s, recovers at > 1.95s)!
    arena.step(0.50);
    const afterRiposte = arena.getState();
    assert.ok(afterRiposte.dummyHp < 880, `Expected riposte slash damage after parry, got hp=${afterRiposte.dummyHp}`);
    assert.equal(afterRiposte.dummyPoise, 0, 'Dummy must remain poise-broken in 1.8s ParryStun at 0.50s');
    // At ~1.42s of active stun elapsed (accounting for ~0.18s parry+riposte hitstop freeze: > 1.35s GuardBreak, < 1.80s ParryStun!),
    // poise MUST still be 0, proving ParryStun (1.8s) was NOT overwritten by GuardBreak (1.35s)!
    arena.step(1.10);
    assert.equal(
      arena.getState().dummyPoise,
      0,
      'At ~1.42s active stun (> 1.35s GuardBreak, < 1.80s ParryStun), dummyPoise must still be 0!'
    );
    arena.step(0.45);
    assert.equal(arena.getState().dummyPoise, 100, 'After 1.80s ParryStun expires, dummyPoise recovers to 100');

    arena.destroy();
  });
});
