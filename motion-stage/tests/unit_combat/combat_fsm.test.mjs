import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CombatStateMachine,
  CANONICAL_STATES,
  STATE_PRIORITIES,
  ARENA_RADIUS,
  ARENA_CLAMP_RADIUS,
  MIN_DUMMY_SEPARATION,
  STRAFE_SECTORS,
  normalizeActionName,
} from '../../src/combat/CombatStateMachine.js';

describe('CombatStateMachine (F10 — Pure-ESM Deterministic 19-State Wuxia FSM)', () => {
  it('defines all 19 canonical states and exact priority hierarchy', () => {
    assert.equal(CANONICAL_STATES.length, 19);
    const expectedOrder = [
      ['Hit_Knockdown', 100],
      ['Hit_Light_L', 95],
      ['Hit_Light_R', 95],
      ['Evade_Backflip', 85],
      ['Dodge_Dash', 80],
      ['Dodge_Roll', 80],
      ['KipUp', 80],
      ['Skill_Wuhen', 60],
      ['Skill_Yuluo', 60],
      ['Skill_Feiyan', 60],
      ['Skill_Kick', 60],
      ['Jump', 50],
      ['Air_Jump_Double', 50],
      ['Attack_Combo_1', 40],
      ['Attack_Combo_2', 40],
      ['Attack_Combo_3', 40],
      ['Move_8Way', 10],
      ['Sprint', 10],
      ['Idle', 0],
    ];
    for (const [state, prio] of expectedOrder) {
      assert.ok(CANONICAL_STATES.includes(state), `Missing state ${state}`);
      assert.equal(STATE_PRIORITIES[state], prio, `Priority mismatch for ${state}`);
    }
  });

  it('normalizes case-insensitive and snake/camel action names', () => {
    assert.equal(normalizeActionName('attack'), 'Attack');
    assert.equal(normalizeActionName('DODGE_DASH'), 'Dodge_Dash');
    assert.equal(normalizeActionName('dash'), 'Dodge_Dash');
    assert.equal(normalizeActionName('dodgeRoll'), 'Dodge_Roll');
    assert.equal(normalizeActionName('skill_wuhen'), 'Skill_Wuhen');
    assert.equal(normalizeActionName('parry'), 'Skill_Wuhen');
    assert.equal(normalizeActionName('kip_up'), 'KipUp');
    assert.equal(normalizeActionName('Evade_Backflip'), 'Evade_Backflip');
  });

  it('switches between Sprint (unlocked) and all 8 Move_8Way strafe sectors (locked on)', () => {
    const fsm = new CombatStateMachine({
      dummyWorldPos: { x: 0, y: 0, z: 3.0 },
      initialLockOn: false,
    });

    fsm.dispatchAction('Move', { x: 0, z: 1 });
    fsm.step(0.05);
    assert.equal(fsm.getState().currentState, 'Sprint');
    assert.equal(fsm.getState().baseClipId, '02_run');

    fsm.setLockOn(true);
    assert.equal(fsm.getState().currentState, 'Move_8Way');

    const dirInputs = [
      [{ x: 0, z: 1 }, 'F'],
      [{ x: 1, z: 1 }, 'FR'],
      [{ x: 1, z: 0 }, 'R'],
      [{ x: 1, z: -1 }, 'BR'],
      [{ x: 0, z: -1 }, 'B'],
      [{ x: -1, z: -1 }, 'BL'],
      [{ x: -1, z: 0 }, 'L'],
      [{ x: -1, z: 1 }, 'FL'],
    ];

    for (const [inp, expectedSector] of dirInputs) {
      // Reset position to origin facing dummy at +Z so target vector stays exact +Z
      fsm.playerWorldPos.x = 0;
      fsm.playerWorldPos.z = 0;
      fsm.playerYaw = 0;
      fsm.dispatchAction('Move', inp);
      assert.ok(STRAFE_SECTORS.includes(expectedSector));
      assert.equal(fsm.getState().strafeSector, expectedSector);
      assert.equal(fsm.getState().baseClipId, `07_strafe_${expectedSector}`);
    }
  });

  it('chains Attack_Combo_1 -> Attack_Combo_2 -> Attack_Combo_3 via 180ms input buffer and expires stale buffer > 180ms', () => {
    const fsm = new CombatStateMachine();
    fsm.dispatchAction('Attack');
    assert.equal(fsm.getState().currentState, 'Attack_Combo_1');

    // Step to u ≈ 0.22 (~0.10s into 0.46s clip -> ~0.14s = 140ms before u=0.52 chain window, within 180ms TTL!)
    fsm.step(0.10);
    const bufRes1 = fsm.dispatchAction('Attack');
    assert.equal(bufRes1.executed, false);
    assert.equal(bufRes1.buffered, true);
    assert.equal(fsm.getState().currentState, 'Attack_Combo_1');

    // Advance past u = 0.52 (~0.16s more): buffered Attack MUST auto-fire -> Attack_Combo_2!
    fsm.step(0.16);
    assert.equal(fsm.getState().currentState, 'Attack_Combo_2');

    // Buffer 3rd hit within 180ms of u = 0.52
    fsm.step(0.12);
    fsm.dispatchAction('Attack');
    fsm.step(0.16);
    assert.equal(fsm.getState().currentState, 'Attack_Combo_3');

    // Verify stale input (> 180ms before window) expires without chaining
    const fsmStale = new CombatStateMachine();
    fsmStale.dispatchAction('Attack'); // duration = 0.46s, window opens at 0.52 * 0.46 = 0.2392s
    fsmStale.step(0.02); // enqueue at t = 0.02s -> 0.2192s (219ms > 180ms) before window!
    fsmStale.dispatchAction('Attack');
    fsmStale.step(0.25);
    assert.equal(fsmStale.getState().currentState, 'Attack_Combo_1');
  });

  it('signals Upper Override during moving-while-slashing (Move_8Way / Sprint + Attack_Combo_1..2)', () => {
    const fsm = new CombatStateMachine({
      dummyWorldPos: { x: 0, y: 0, z: 4.0 },
      initialLockOn: true,
    });
    fsm.dispatchAction('Move', { x: 1, z: 0 }); // Strafe right
    fsm.step(1 / 60);
    assert.equal(fsm.getState().currentState, 'Move_8Way');

    fsm.dispatchAction('Attack');
    // Ramp over 0.12s (> 0.10s fade-in)
    fsm.step(0.12);

    const st = fsm.getState();
    assert.equal(st.currentState, 'Attack_Combo_1');
    assert.equal(st.layerMode, 'upper_override');
    assert.equal(st.baseState, 'Move_8Way');
    assert.equal(st.baseClipId, '07_strafe_R');
    assert.equal(st.upperClipId, 'combo_1');
    assert.ok(st.upperLayerAlpha >= 0.99, `Expected upperLayerAlpha >= 0.99, got ${st.upperLayerAlpha}`);
    // Player continues moving horizontally while slashing!
    assert.ok(Math.abs(st.playerWorldPos.x) > 0.25);
  });

  it('cancels attacks with Dodge_Dash / Dodge_Roll and grants active i-frames against enemy hits', () => {
    const fsm = new CombatStateMachine();
    fsm.dispatchAction('Attack');
    fsm.step(0.08);
    assert.equal(fsm.getState().currentState, 'Attack_Combo_1');

    // Dodge_Dash (Priority 80) cancels Attack_Combo_1 (Priority 40) immediately
    fsm.dispatchAction('Dodge_Dash');
    assert.equal(fsm.getState().currentState, 'Dodge_Dash');

    fsm.step(0.06); // u ≈ 0.167 inside i-frame window [0.05, 0.72]
    assert.equal(fsm.getState().isInvulnerable, true);

    const hpBefore = fsm.playerHp;
    const hitRes = fsm.receiveEnemyAttack({ type: 'heavy', damage: 90 });
    assert.equal(hitRes.outcome, 'evaded');
    assert.equal(fsm.playerHp, hpBefore);
    assert.equal(fsm.getState().currentState, 'Dodge_Dash');
  });

  it('executes Jump -> Air_Jump_Double once per ground touch and resets on landing', () => {
    const fsm = new CombatStateMachine();
    fsm.dispatchAction('Jump');
    fsm.step(0.12);
    assert.equal(fsm.getState().currentState, 'Jump');
    assert.ok(fsm.getState().playerWorldPos.y > 0.5);

    // Trigger Air_Jump_Double mid-air
    fsm.dispatchAction('Jump');
    assert.equal(fsm.getState().currentState, 'Air_Jump_Double');
    assert.equal(fsm.getState().doubleJumpAvailable, false);

    // Attempting a 3rd jump in mid-air is rejected
    fsm.step(0.10);
    const thirdJump = fsm.dispatchAction('Air_Jump_Double');
    assert.equal(thirdJump.executed, false);

    // Step until gravity lands character back on ground (y === 0)
    fsm.step(1.2);
    assert.equal(fsm.getState().playerWorldPos.y, 0);
    assert.equal(fsm.getState().doubleJumpAvailable, true);
    assert.equal(fsm.getState().currentState, 'Idle');
  });

  it('deflects enemy attacks during Skill_Wuhen parry window [0.00, 0.42] with 0 damage, 110ms hitstop, and 5s buff', () => {
    const fsm = new CombatStateMachine();
    fsm.dispatchAction('Skill_Wuhen');
    fsm.step(0.12); // u ≈ 0.14 in [0.00, 0.42]
    assert.equal(fsm.getState().inParryWindow, true);

    const hpBefore = fsm.playerHp;
    const parryRes = fsm.receiveEnemyAttack({ type: 'light', damage: 45 });
    assert.equal(parryRes.outcome, 'parried');
    assert.equal(fsm.playerHp, hpBefore);
    assert.equal(fsm.getState().hitstopRemainingMs, 110);
    assert.equal(fsm.getState().wuhenBuffRemainingMs, 5000);

    // While in 110ms hitstop, stateNormalizedTime stays frozen
    const uFrozen = fsm.getState().stateNormalizedTime;
    fsm.step(0.05);
    assert.equal(fsm.getState().stateNormalizedTime, uFrozen);
    assert.ok(Math.abs(fsm.getState().hitstopRemainingMs - 60) < 1e-3);
  });

  it('breaks out of Hit_Light_L stagger via Evade_Backflip and enforces 6.0s deterministic cooldown', () => {
    const fsm = new CombatStateMachine();
    fsm.receiveEnemyAttack({ type: 'light', side: 'L' });
    assert.equal(fsm.getState().currentState, 'Hit_Light_L');

    // Normal Dodge_Dash (80 < 95) is blocked during stagger
    fsm.dispatchAction('Dodge_Dash');
    assert.equal(fsm.getState().currentState, 'Hit_Light_L');

    // Evade_Backflip breaks out when off cooldown and starts 6000ms cooldown
    const bo1 = fsm.dispatchAction('Evade_Backflip');
    assert.equal(bo1.executed, true);
    assert.equal(fsm.getState().currentState, 'Evade_Backflip');
    assert.equal(fsm.getState().backflipCooldownMs, 6000);

    // Finish backflip (~0.8s), get hit again while 5.2s cooldown remains -> breakout blocked!
    fsm.step(0.80);
    fsm.receiveEnemyAttack({ type: 'light', side: 'R' });
    assert.equal(fsm.getState().currentState, 'Hit_Light_R');
    const boBlocked = fsm.dispatchAction('Evade_Backflip');
    assert.equal(boBlocked.executed, false);
    assert.equal(fsm.getState().currentState, 'Hit_Light_R');

    // Advance remaining 5.3s so 6.0s simTimeMs cooldown finishes -> breakout works again!
    fsm.step(5.30);
    assert.equal(fsm.getState().backflipCooldownMs, 0);
    fsm.receiveEnemyAttack({ type: 'light', side: 'L' });
    const bo2 = fsm.dispatchAction('Evade_Backflip');
    assert.equal(bo2.executed, true);
    assert.equal(fsm.getState().currentState, 'Evade_Backflip');
  });

  it('supports instant KipUp recovery at u >= 0.55 and automatic Hit_Knockdown -> KipUp recovery at u >= 1.0', () => {
    // 1. Instant KipUp via Space ('Jump') at u >= 0.55
    const fsmInstant = new CombatStateMachine();
    fsmInstant.receiveEnemyAttack({ type: 'heavy' });
    assert.equal(fsmInstant.getState().currentState, 'Hit_Knockdown');

    fsmInstant.step(0.20); // u ≈ 0.21 (< 0.55): too early for instant KipUp
    fsmInstant.dispatchAction('KipUp');
    assert.equal(fsmInstant.getState().currentState, 'Hit_Knockdown');

    fsmInstant.step(0.40); // u ≈ 0.63 (>= 0.55)
    const kipRes = fsmInstant.dispatchAction('Jump');
    assert.equal(kipRes.executed, true);
    assert.equal(fsmInstant.getState().currentState, 'KipUp');
    assert.equal(fsmInstant.getState().isInvulnerable, true);

    // 2. Auto-chain Hit_Knockdown -> KipUp -> Idle when no button pressed
    const fsmAuto = new CombatStateMachine();
    fsmAuto.receiveEnemyAttack({ type: 'heavy' });
    fsmAuto.step(0.98); // > 0.95s knockdown duration -> enters KipUp
    assert.equal(fsmAuto.getState().currentState, 'KipUp');
    assert.equal(fsmAuto.getState().isInvulnerable, true);
    fsmAuto.step(0.55); // finishes 0.48s KipUp -> Idle
    assert.equal(fsmAuto.getState().currentState, 'Idle');
  });

  it('enforces 0.68m dummy capsule separation and strict hypot(x, z) <= 8.15 < 8.5m circular arena slide', () => {
    const dummyPos = { x: 0, y: 0, z: 1.5 };
    const fsm = new CombatStateMachine({ dummyWorldPos: dummyPos, initialLockOn: true });

    // Dash straight into dummy: player must never penetrate < 0.68m
    fsm.dispatchAction('Dodge_Dash');
    for (let i = 0; i < 30; i++) {
      const st = fsm.step(1 / 60);
      const dist = Math.hypot(st.playerWorldPos.x - dummyPos.x, st.playerWorldPos.z - dummyPos.z);
      assert.ok(
        dist >= MIN_DUMMY_SEPARATION - 1e-6,
        `Dummy capsule penetrated: dist=${dist} < ${MIN_DUMMY_SEPARATION}`
      );
    }

    // Sprint diagonally against outer stone boundary for 4 seconds: hypot(x, z) <= 8.15 < 8.5 with tangential slide
    const fsmRing = new CombatStateMachine({ initialLockOn: false });
    fsmRing.dispatchAction('Move', { x: 0.6, z: 0.8 });
    for (let i = 0; i < 240; i++) {
      const st = fsmRing.step(1 / 60);
      const r = Math.hypot(st.playerWorldPos.x, st.playerWorldPos.z);
      assert.ok(r <= ARENA_CLAMP_RADIUS, `Exceeded clamp radius: ${r} > ${ARENA_CLAMP_RADIUS}`);
      assert.ok(r < ARENA_RADIUS, `Exceeded arena radius: ${r} >= ${ARENA_RADIUS}`);
    }
    // Now strafe/run at 45 degrees to outward normal and verify tangential sliding changes angle along ring
    const angleBefore = Math.atan2(fsmRing.playerWorldPos.x, fsmRing.playerWorldPos.z);
    fsmRing.dispatchAction('Move', { x: 1, z: 0 });
    fsmRing.step(0.5);
    const angleAfter = Math.atan2(fsmRing.playerWorldPos.x, fsmRing.playerWorldPos.z);
    assert.ok(Math.abs(angleAfter - angleBefore) > 0.15, 'Expected smooth tangential slide along boundary');

    // Corner-wedge test: player wedged directly between dummy at (0, 0, 8.10) and arena wall (r = 8.15)
    // must simultaneously satisfy hypot(x, z) <= 8.15 AND dist(player, dummy) >= 0.68!
    const wallDummy = { x: 0, y: 0, z: 8.10 };
    const fsmCorner = new CombatStateMachine({
      dummyWorldPos: wallDummy,
      initialPlayerPos: { x: 0.02, y: 0, z: 8.14 },
      initialLockOn: true,
    });
    fsmCorner.dispatchAction('Dodge_Dash');
    for (let i = 0; i < 20; i++) {
      const st = fsmCorner.step(1 / 60);
      const rad = Math.hypot(st.playerWorldPos.x, st.playerWorldPos.z);
      const sep = Math.hypot(st.playerWorldPos.x - wallDummy.x, st.playerWorldPos.z - wallDummy.z);
      assert.ok(rad <= ARENA_CLAMP_RADIUS, `Corner wedge exceeded clamp radius: ${rad}`);
      assert.ok(
        sep >= MIN_DUMMY_SEPARATION - 1e-5,
        `Corner wedge compressed dummy separation: ${sep} < ${MIN_DUMMY_SEPARATION}`
      );
    }
  });

  it('sanitizes NaN/±Infinity in constructor, reset, setDummyPosition, and receiveEnemyAttack, and zeroes velY on Skill_Feiyan entry', () => {
    const fsm = new CombatStateMachine({
      arenaRadius: NaN,
      arenaClampRadius: -Infinity,
      minDummySeparation: NaN,
      inputBufferTtlMs: Infinity,
      dummyWorldPos: { x: Infinity, y: NaN, z: -Infinity },
      initialPlayerPos: { x: NaN, y: -15, z: Infinity },
      initialYaw: NaN,
      initialLockOn: true,
    });

    assert.equal(fsm.arenaRadius, ARENA_RADIUS);
    assert.equal(fsm.arenaClampRadius, ARENA_CLAMP_RADIUS);
    assert.ok(Number.isFinite(fsm.playerWorldPos.x) && Number.isFinite(fsm.playerWorldPos.z));
    assert.equal(fsm.playerWorldPos.y, 0);
    assert.ok(Number.isFinite(fsm.playerYaw));
    assert.ok(
      Number.isFinite(fsm.dummyWorldPos.x) &&
        Number.isFinite(fsm.dummyWorldPos.y) &&
        Number.isFinite(fsm.dummyWorldPos.z)
    );

    // Valid dummy pos followed by corrupted NaN/Infinity setDummyPosition preserves valid finite dummyWorldPos
    fsm.setDummyPosition({ x: 1.25, y: 0, z: 2.5 });
    fsm.setDummyPosition({ x: Infinity, y: NaN, z: -Infinity });
    assert.equal(fsm.dummyWorldPos.x, 1.25);
    assert.equal(fsm.dummyWorldPos.z, 2.5);

    // receiveEnemyAttack with non-finite attackerPos and NaN / negative damage never poisons pos or heals playerHp
    const hpStart = fsm.playerHp;
    fsm.receiveEnemyAttack({ type: 'light', attackerPos: { x: Infinity, z: 0 }, damage: -500 });
    assert.equal(fsm.playerHp, hpStart, 'Negative damage must clamp to 0 and never overheal');
    fsm.step(0.1);
    assert.ok(Number.isFinite(fsm.playerWorldPos.x) && Number.isFinite(fsm.playerWorldPos.z));
    assert.ok(Number.isFinite(fsm.playerYaw));

    fsm.receiveEnemyAttack({ type: 'heavy', attackerPos: { x: NaN, z: -Infinity }, damage: NaN });
    fsm.step(0.1);
    assert.ok(Number.isFinite(fsm.playerWorldPos.x) && Number.isFinite(fsm.playerWorldPos.z));
    assert.equal(fsm.playerHp, hpStart - 85, 'NaN damage on heavy hit must fall back to default 85');

    // reset with NaN / Infinity / out-of-arena coords sanitizes and clamps cleanly
    fsm.reset({ x: NaN, y: Infinity, z: -Infinity, yaw: NaN });
    assert.deepEqual(fsm.playerWorldPos, { x: 0, y: 0, z: 0 });
    assert.equal(fsm.playerYaw, 0);

    fsm.reset({ x: 999, y: -5, z: 0, yaw: Infinity });
    assert.ok(Math.hypot(fsm.playerWorldPos.x, fsm.playerWorldPos.z) <= ARENA_CLAMP_RADIUS);
    assert.equal(fsm.playerWorldPos.y, 0);
    assert.equal(fsm.playerYaw, 0);

    // Mid-air Jump -> Skill_Feiyan immediately zeroes velY on _enterState before next step()
    fsm.reset();
    fsm.dispatchAction('Jump');
    assert.ok(fsm.velY > 0);
    fsm.dispatchAction('Skill_Feiyan');
    assert.equal(fsm.getState().currentState, 'Skill_Feiyan');
    assert.equal(fsm.velY, 0);
  });
});
