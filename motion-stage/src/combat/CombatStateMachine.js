/**
 * Pure-ESM Deterministic Wuxia Character Action State Machine (F10).
 * Zero DOM, WebGL, Three.js, or wall-clock imports — 100% deterministic in Node ESM & Browser.
 */

export const ARENA_RADIUS = 8.5;
export const ARENA_MARGIN = 0.35;
export const ARENA_CLAMP_RADIUS = ARENA_RADIUS - ARENA_MARGIN; // 8.15m (< 8.5m)
export const PLAYER_CAPSULE_RADIUS = 0.34;
export const DUMMY_CAPSULE_RADIUS = 0.34;
export const MIN_DUMMY_SEPARATION = PLAYER_CAPSULE_RADIUS + DUMMY_CAPSULE_RADIUS; // 0.68m

export const INPUT_BUFFER_TTL_MS = 180;
export const BACKFLIP_COOLDOWN_MS = 6000;
export const WUHEN_BUFF_DURATION_MS = 5000;
export const GRAVITY_ACCEL = -18.5;

export const STRAFE_SECTORS = Object.freeze(['F', 'FR', 'R', 'BR', 'B', 'BL', 'L', 'FL']);

export const CANONICAL_STATES = Object.freeze([
  'Idle',
  'Move_8Way',
  'Sprint',
  'Dodge_Dash',
  'Dodge_Roll',
  'Jump',
  'Air_Jump_Double',
  'Evade_Backflip',
  'Attack_Combo_1',
  'Attack_Combo_2',
  'Attack_Combo_3',
  'Skill_Wuhen',
  'Skill_Yuluo',
  'Skill_Feiyan',
  'Skill_Kick',
  'Hit_Light_L',
  'Hit_Light_R',
  'Hit_Knockdown',
  'KipUp',
]);

export const STATE_PRIORITIES = Object.freeze({
  Idle: 0,
  Move_8Way: 10,
  Sprint: 10,
  Attack_Combo_1: 40,
  Attack_Combo_2: 40,
  Attack_Combo_3: 40,
  Jump: 50,
  Air_Jump_Double: 50,
  Skill_Wuhen: 60,
  Skill_Yuluo: 60,
  Skill_Feiyan: 60,
  Skill_Kick: 60,
  Dodge_Dash: 80,
  Dodge_Roll: 80,
  KipUp: 80,
  Evade_Backflip: 85,
  Hit_Light_L: 95,
  Hit_Light_R: 95,
  Hit_Knockdown: 100,
});

export const CANONICAL_21_BONE_WEIGHTS = Object.freeze({
  Hips: 0.0,
  Spine: 0.55,
  Chest: 0.85,
  Neck: 1.0,
  Head: 1.0,
  LeftShoulder: 1.0,
  LeftUpperArm: 1.0,
  LeftForeArm: 1.0,
  LeftHand: 1.0,
  RightShoulder: 1.0,
  RightUpperArm: 1.0,
  RightForeArm: 1.0,
  RightHand: 1.0,
  LeftUpLeg: 0.0,
  LeftLeg: 0.0,
  LeftFoot: 0.0,
  LeftToe: 0.0,
  RightUpLeg: 0.0,
  RightLeg: 0.0,
  RightFoot: 0.0,
  RightToe: 0.0,
});

export const STATE_CONFIGS = Object.freeze({
  Idle: {
    id: 'Idle',
    wuxiaName: '持剑戒备待机',
    priority: 0,
    cyclic: true,
    durationSec: 1.0,
    clipId: 'taibai_01b',
    fallbackClipId: '01_idle',
    crossfadeSec: 0.12,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [],
  },
  Move_8Way: {
    id: 'Move_8Way',
    wuxiaName: '锁定八向垫步',
    priority: 10,
    cyclic: true,
    durationSec: 0.80,
    clipId: '07_strafe_F',
    speedMps: 3.8,
    crossfadeSec: 0.10,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [],
  },
  Sprint: {
    id: 'Sprint',
    wuxiaName: '疾跑轻功',
    priority: 10,
    cyclic: true,
    durationSec: 0.72,
    clipId: '02_run',
    speedMps: 6.0,
    crossfadeSec: 0.10,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [],
  },
  Dodge_Dash: {
    id: 'Dodge_Dash',
    wuxiaName: '苍龙出水',
    priority: 80,
    cyclic: false,
    durationSec: 0.36,
    clipId: '08_dash_canglong',
    impulseMeters: 3.4,
    crossfadeSec: 0.06,
    iframeWindow: [0.05, 0.72],
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [
      { start: 0.15, end: 0.55, damage: 18, poiseDamage: 20, hitstopMs: 45, type: 'sword' },
    ],
  },
  Dodge_Roll: {
    id: 'Dodge_Roll',
    wuxiaName: '翻滚闪避',
    priority: 80,
    cyclic: false,
    durationSec: 0.45,
    clipId: '09_dodge_roll',
    impulseMeters: 3.0,
    crossfadeSec: 0.06,
    iframeWindow: [0.04, 0.78],
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [],
  },
  Jump: {
    id: 'Jump',
    wuxiaName: '踏空轻功跳',
    priority: 50,
    cyclic: false,
    durationSec: 0.72,
    clipId: 'jump',
    jumpVelY: 6.6,
    airControlSpeedMps: 4.5,
    crossfadeSec: 0.08,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [],
  },
  Air_Jump_Double: {
    id: 'Air_Jump_Double',
    wuxiaName: '二段踏空轻功跳',
    priority: 50,
    cyclic: false,
    durationSec: 0.68,
    clipId: '10_double_jump',
    jumpVelY: 6.2,
    airControlSpeedMps: 4.8,
    crossfadeSec: 0.07,
    iframeWindow: [0.00, 0.28],
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [],
  },
  Evade_Backflip: {
    id: 'Evade_Backflip',
    wuxiaName: '燕回朝阳',
    priority: 85,
    cyclic: false,
    durationSec: 0.68,
    clipId: '06_backflip',
    impulseMeters: -2.4,
    crossfadeSec: 0.06,
    iframeWindow: [0.00, 0.65],
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [],
  },
  Attack_Combo_1: {
    id: 'Attack_Combo_1',
    wuxiaName: '云台三落·一式',
    priority: 40,
    cyclic: false,
    durationSec: 0.46,
    clipId: 'combo_1',
    impulseMeters: 0.55,
    crossfadeSec: 0.07,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: [0.52, 0.96],
    hitWindows: [
      { start: 0.18, end: 0.52, damage: 24, poiseDamage: 18, hitstopMs: 45, type: 'sword' },
    ],
  },
  Attack_Combo_2: {
    id: 'Attack_Combo_2',
    wuxiaName: '云台三落·二式',
    priority: 40,
    cyclic: false,
    durationSec: 0.48,
    clipId: 'combo_2',
    impulseMeters: 0.50,
    crossfadeSec: 0.07,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: [0.52, 0.96],
    hitWindows: [
      { start: 0.18, end: 0.52, damage: 28, poiseDamage: 22, hitstopMs: 45, type: 'sword' },
    ],
  },
  Attack_Combo_3: {
    id: 'Attack_Combo_3',
    wuxiaName: '云台三落·三式',
    priority: 40,
    cyclic: false,
    durationSec: 0.58,
    clipId: 'combo_3',
    impulseMeters: 0.95,
    crossfadeSec: 0.08,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [
      { start: 0.22, end: 0.50, damage: 46, poiseDamage: 48, hitstopMs: 85, type: 'sword', heavy: true },
    ],
  },
  Skill_Wuhen: {
    id: 'Skill_Wuhen',
    wuxiaName: '无痕剑意',
    priority: 60,
    cyclic: false,
    durationSec: 0.85,
    clipId: 'taibai_02',
    impulseMeters: 0.20,
    crossfadeSec: 0.07,
    iframeWindow: null,
    parryWindow: [0.00, 0.42],
    comboChainWindow: null,
    hitWindows: [
      { start: 0.43, end: 0.68, damage: 35, poiseDamage: 40, hitstopMs: 85, type: 'sword', requiresParry: true },
    ],
  },
  Skill_Yuluo: {
    id: 'Skill_Yuluo',
    wuxiaName: '雨落云飞',
    priority: 60,
    cyclic: false,
    durationSec: 1.35,
    clipId: 'taibai_03',
    impulseMeters: 1.65,
    crossfadeSec: 0.07,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [
      { start: 0.12, end: 0.23, damage: 18, poiseDamage: 12, hitstopMs: 45, type: 'sword' },
      { start: 0.28, end: 0.39, damage: 18, poiseDamage: 12, hitstopMs: 45, type: 'sword' },
      { start: 0.44, end: 0.55, damage: 20, poiseDamage: 14, hitstopMs: 45, type: 'sword' },
      { start: 0.60, end: 0.71, damage: 22, poiseDamage: 16, hitstopMs: 45, type: 'sword' },
      { start: 0.76, end: 0.90, damage: 38, poiseDamage: 45, hitstopMs: 85, type: 'sword', heavy: true },
    ],
  },
  Skill_Feiyan: {
    id: 'Skill_Feiyan',
    wuxiaName: '飞燕逐月',
    priority: 60,
    cyclic: false,
    durationSec: 1.25,
    clipId: 'taibai_04',
    impulseMeters: 1.35,
    crossfadeSec: 0.08,
    iframeWindow: [0.10, 0.75],
    parryWindow: null,
    comboChainWindow: null,
    superArmorWindow: [0.00, 0.86],
    hitWindows: [
      { start: 0.16, end: 0.32, damage: 24, poiseDamage: 20, hitstopMs: 45, type: 'both' },
      { start: 0.36, end: 0.52, damage: 24, poiseDamage: 20, hitstopMs: 45, type: 'both' },
      { start: 0.56, end: 0.70, damage: 26, poiseDamage: 25, hitstopMs: 45, type: 'both' },
      { start: 0.74, end: 0.88, damage: 48, poiseDamage: 65, hitstopMs: 85, type: 'aoe', heavy: true, aoeRadius: 2.8 },
    ],
  },
  Skill_Kick: {
    id: 'Skill_Kick',
    wuxiaName: '正蹬破防踢',
    priority: 60,
    cyclic: false,
    durationSec: 0.65,
    spinDurationSec: 0.92,
    clipId: '05_front_kick',
    spinClipId: '04_tornado_kick',
    impulseMeters: 0.65,
    crossfadeSec: 0.07,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [
      { start: 0.28, end: 0.58, damage: 26, poiseDamage: 100, hitstopMs: 85, type: 'kick', guardBreak: true },
    ],
  },
  Hit_Light_L: {
    id: 'Hit_Light_L',
    wuxiaName: '左轻受击硬直',
    priority: 95,
    cyclic: false,
    durationSec: 0.38,
    clipId: '11_hit_light_L',
    impulseMeters: -0.65,
    crossfadeSec: 0.04,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [],
  },
  Hit_Light_R: {
    id: 'Hit_Light_R',
    wuxiaName: '右轻受击硬直',
    priority: 95,
    cyclic: false,
    durationSec: 0.38,
    clipId: '12_hit_light_R',
    impulseMeters: -0.65,
    crossfadeSec: 0.04,
    iframeWindow: null,
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [],
  },
  Hit_Knockdown: {
    id: 'Hit_Knockdown',
    wuxiaName: '击飞倒地',
    priority: 100,
    cyclic: false,
    durationSec: 0.95,
    clipId: '13_knockdown',
    impulseMeters: -2.10,
    crossfadeSec: 0.05,
    iframeWindow: [0.55, 1.00],
    parryWindow: null,
    comboChainWindow: null,
    kipUpWindowStart: 0.55,
    hitWindows: [],
  },
  KipUp: {
    id: 'KipUp',
    wuxiaName: '鲤鱼打挺起身',
    priority: 80,
    cyclic: false,
    durationSec: 0.48,
    clipId: '14_kipup',
    impulseMeters: 0.0,
    crossfadeSec: 0.05,
    iframeWindow: [0.00, 1.00],
    parryWindow: null,
    comboChainWindow: null,
    hitWindows: [],
  },
});

const ACTION_ALIAS_MAP = Object.freeze({
  attack: 'Attack',
  lightattack: 'Attack',
  attackcombo: 'Attack',
  attackcombo1: 'Attack_Combo_1',
  attackcombo2: 'Attack_Combo_2',
  attackcombo3: 'Attack_Combo_3',
  dodgedash: 'Dodge_Dash',
  dash: 'Dodge_Dash',
  canglong: 'Dodge_Dash',
  dodgeroll: 'Dodge_Roll',
  roll: 'Dodge_Roll',
  jump: 'Jump',
  airjumpdouble: 'Air_Jump_Double',
  doublejump: 'Air_Jump_Double',
  evadebackflip: 'Evade_Backflip',
  backflip: 'Evade_Backflip',
  yanhui: 'Evade_Backflip',
  skillwuhen: 'Skill_Wuhen',
  wuhen: 'Skill_Wuhen',
  parry: 'Skill_Wuhen',
  skillyuluo: 'Skill_Yuluo',
  yuluo: 'Skill_Yuluo',
  skillfeiyan: 'Skill_Feiyan',
  feiyan: 'Skill_Feiyan',
  skillkick: 'Skill_Kick',
  kick: 'Skill_Kick',
  guardbreak: 'Skill_Kick',
  kipup: 'KipUp',
  hitlightl: 'Hit_Light_L',
  hitlightr: 'Hit_Light_R',
  hitlight: 'Hit_Light',
  hitknockdown: 'Hit_Knockdown',
  hitheavy: 'Hit_Knockdown',
  knockdown: 'Hit_Knockdown',
  move: 'Move',
  move8way: 'Move',
  sprint: 'Sprint_Input',
  stopmove: 'StopMove',
  idle: 'StopMove',
  togglelockon: 'ToggleLockOn',
  setlockon: 'SetLockOn',
  reset: 'Reset',
  resetarena: 'Reset',
});

const BUFFER_ACTION_PRIORITY = Object.freeze({
  Evade_Backflip: 85,
  KipUp: 82,
  Dodge_Dash: 80,
  Dodge_Roll: 80,
  Skill_Wuhen: 62,
  Skill_Feiyan: 61,
  Skill_Yuluo: 60,
  Skill_Kick: 60,
  Air_Jump_Double: 52,
  Jump: 50,
  Attack_Combo_3: 42,
  Attack_Combo_2: 41,
  Attack_Combo_1: 40,
  Attack: 40,
});

export function normalizeActionName(action) {
  if (typeof action !== 'string') return '';
  const compact = action.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return ACTION_ALIAS_MAP[compact] || action.trim();
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function wrapAngleRad(angle) {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function dampAngleRad(current, target, rate, dt) {
  const diff = wrapAngleRad(target - current);
  const alpha = 1 - Math.exp(-rate * dt);
  return wrapAngleRad(current + diff * alpha);
}

/**
 * Smooth ease-out cumulative progress curve E(u) in [0, 1] for impulse states.
 * E(0) = 0, E(1) = 1, fast initial burst, gentle settle.
 */
function impulseEaseCurve(u) {
  const cu = clamp(u, 0, 1);
  return 1 - Math.pow(1 - cu, 2.4);
}

function finiteOr(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function positiveFiniteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class CombatStateMachine {
  constructor(options = {}) {
    const safeOpts = options && typeof options === 'object' ? options : {};
    this.arenaRadius = positiveFiniteOr(safeOpts.arenaRadius, ARENA_RADIUS);
    this.arenaClampRadius = positiveFiniteOr(safeOpts.arenaClampRadius, ARENA_CLAMP_RADIUS);
    this.minDummySeparation = positiveFiniteOr(safeOpts.minDummySeparation, MIN_DUMMY_SEPARATION);
    this.inputBufferTtlMs = positiveFiniteOr(safeOpts.inputBufferTtlMs, INPUT_BUFFER_TTL_MS);
    this.backflipCooldownDurationMs = positiveFiniteOr(
      safeOpts.backflipCooldownMs,
      BACKFLIP_COOLDOWN_MS
    );
    this.wuhenBuffDurationMs = positiveFiniteOr(safeOpts.wuhenBuffMs, WUHEN_BUFF_DURATION_MS);

    this.simTimeMs = 0;
    this.currentState = 'Idle';
    this.stateElapsedSec = 0;
    this.stateDurationSec = STATE_CONFIGS.Idle.durationSec;
    this.stateNormalizedTime = 0;
    this.stateInstanceId = 1;

    this.playerWorldPos = { x: 0, y: 0, z: 0 };
    this.playerVelXZ = { x: 0, z: 0 };
    this.velY = 0;
    this.playerYaw = 0;
    this.cameraYaw = 0;

    this.isLockedOn = Boolean(safeOpts.initialLockOn ?? false);
    this.dummyWorldPos = null;

    this.moveInput = { right: 0, forward: 0 };
    this.hasMoveInput = false;
    this.worldMoveDir = { x: 0, z: 0 };
    this.strafeSector = 'F';
    this.locoCycleU = 0;

    this.doubleJumpAvailable = true;
    this.backflipCooldownMs = 0;
    this.wuhenBuffRemainingMs = 0;
    this.hitstopRemainingMs = 0;

    this.upperLayerAlpha = 0;
    this.parryTriggeredInState = false;
    this.kickVariant = 'front';
    this.actionYaw = 0;
    this.knockbackDirXZ = { x: 0, z: -1 };
    this.nextLightHitSide = 'L';

    this.playerHp = 1000;
    this.maxPlayerHp = 1000;
    this.parryCount = 0;

    this.inputBuffer = [];
    this.pendingEvents = [];

    if (safeOpts.dummyWorldPos && typeof safeOpts.dummyWorldPos === 'object') {
      this.setDummyPosition(safeOpts.dummyWorldPos);
    }

    if (safeOpts.initialPlayerPos && typeof safeOpts.initialPlayerPos === 'object') {
      this.playerWorldPos.x = finiteOr(safeOpts.initialPlayerPos.x, 0);
      this.playerWorldPos.y = Math.max(0, finiteOr(safeOpts.initialPlayerPos.y, 0));
      this.playerWorldPos.z = finiteOr(safeOpts.initialPlayerPos.z, 0);
      this._clampPlayerPositionToArena();
    }
    if (typeof safeOpts.initialYaw === 'number' && Number.isFinite(safeOpts.initialYaw)) {
      this.playerYaw = wrapAngleRad(safeOpts.initialYaw);
    }
  }

  _clampPlayerPositionToArena() {
    const r = Math.hypot(this.playerWorldPos.x, this.playerWorldPos.z);
    if (!Number.isFinite(r)) {
      this.playerWorldPos.x = 0;
      this.playerWorldPos.z = 0;
      return;
    }
    if (r > this.arenaClampRadius) {
      const safeR = this.arenaClampRadius * (1 - 1e-12);
      this.playerWorldPos.x = (this.playerWorldPos.x / r) * safeR;
      this.playerWorldPos.z = (this.playerWorldPos.z / r) * safeR;
    }
  }

  reset(options = {}) {
    const safeOpts = options && typeof options === 'object' ? options : {};
    this.currentState = 'Idle';
    this.stateElapsedSec = 0;
    this.stateDurationSec = STATE_CONFIGS.Idle.durationSec;
    this.stateNormalizedTime = 0;
    this.stateInstanceId += 1;

    this.playerWorldPos.x = finiteOr(safeOpts.x, 0);
    this.playerWorldPos.y = Math.max(0, finiteOr(safeOpts.y, 0));
    this.playerWorldPos.z = finiteOr(safeOpts.z, 0);
    this._clampPlayerPositionToArena();
    this.playerVelXZ.x = 0;
    this.playerVelXZ.z = 0;
    this.velY = 0;
    const rawYaw = Number(safeOpts.yaw);
    this.playerYaw = Number.isFinite(rawYaw) ? wrapAngleRad(rawYaw) : 0;

    this.moveInput.right = 0;
    this.moveInput.forward = 0;
    this.hasMoveInput = false;
    this.worldMoveDir.x = 0;
    this.worldMoveDir.z = 0;
    this.strafeSector = 'F';
    this.locoCycleU = 0;

    this.doubleJumpAvailable = true;
    this.backflipCooldownMs = 0;
    this.wuhenBuffRemainingMs = 0;
    this.hitstopRemainingMs = 0;
    this.upperLayerAlpha = 0;
    this.parryTriggeredInState = false;
    this.kickVariant = 'front';
    this.playerHp = this.maxPlayerHp;

    this.inputBuffer.length = 0;
    this.pendingEvents.length = 0;
  }

  setCameraYaw(yawRad) {
    if (Number.isFinite(yawRad)) {
      this.cameraYaw = wrapAngleRad(yawRad);
      this._recomputeMoveVectors();
    }
  }

  setDummyPosition(pos) {
    if (!pos || typeof pos !== 'object') {
      this.dummyWorldPos = null;
      return;
    }
    const prevX = this.dummyWorldPos ? this.dummyWorldPos.x : 0;
    const prevY = this.dummyWorldPos ? this.dummyWorldPos.y : 0;
    const prevZ = this.dummyWorldPos ? this.dummyWorldPos.z : 0;
    const nx = Number(pos.x);
    const ny = Number(pos.y);
    const nz = Number(pos.z);
    if (!this.dummyWorldPos) {
      this.dummyWorldPos = { x: 0, y: 0, z: 0 };
    }
    const maxCoord = this.arenaRadius * 4;
    this.dummyWorldPos.x = Number.isFinite(nx) ? clamp(nx, -maxCoord, maxCoord) : prevX;
    this.dummyWorldPos.y = Number.isFinite(ny) ? clamp(ny, -maxCoord, maxCoord) : prevY;
    this.dummyWorldPos.z = Number.isFinite(nz) ? clamp(nz, -maxCoord, maxCoord) : prevZ;
    this._recomputeMoveVectors();
  }

  setLockOn(locked, targetPos = undefined) {
    this.isLockedOn = Boolean(locked);
    if (targetPos !== undefined) {
      this.setDummyPosition(targetPos);
    }
    this._recomputeMoveVectors();
    if (this.currentState === 'Sprint' && this.isLockedOn && this.hasMoveInput) {
      this._enterState('Move_8Way');
    } else if (this.currentState === 'Move_8Way' && !this.isLockedOn && this.hasMoveInput) {
      this._enterState('Sprint');
    }
    return this.isLockedOn;
  }

  toggleLockOn() {
    return this.setLockOn(!this.isLockedOn);
  }

  /**
   * Accepts `{ x, z }`, `{ right, forward }`, `{ x, y }`, or `null` to stop.
   * Convention: `right` (`x`) in [-1, 1] (+1 = right/D, -1 = left/A), `forward` (`z`) in [-1, 1] (+1 = forward/W, -1 = back/S).
   */
  setMoveInput(input) {
    if (!input) {
      this.moveInput.right = 0;
      this.moveInput.forward = 0;
    } else {
      const rawRight = input.right !== undefined ? Number(input.right) : Number(input.x ?? 0);
      const rawFwd =
        input.forward !== undefined
          ? Number(input.forward)
          : input.z !== undefined
            ? Number(input.z)
            : Number(input.y ?? 0);
      let r = Number.isFinite(rawRight) ? rawRight : 0;
      let f = Number.isFinite(rawFwd) ? rawFwd : 0;
      const len = Math.hypot(r, f);
      if (len > 1) {
        r /= len;
        f /= len;
      }
      this.moveInput.right = len < 0.05 ? 0 : r;
      this.moveInput.forward = len < 0.05 ? 0 : f;
    }

    this._recomputeMoveVectors();

    if (this.currentState === 'Idle' && this.hasMoveInput) {
      this._enterState(this.isLockedOn ? 'Move_8Way' : 'Sprint');
    } else if ((this.currentState === 'Move_8Way' || this.currentState === 'Sprint') && !this.hasMoveInput) {
      this._enterState('Idle');
    } else if (this.currentState === 'Sprint' && this.isLockedOn && this.hasMoveInput) {
      this._enterState('Move_8Way');
    } else if (this.currentState === 'Move_8Way' && !this.isLockedOn && this.hasMoveInput) {
      this._enterState('Sprint');
    }
  }

  _recomputeMoveVectors() {
    const r = this.moveInput.right;
    const f = this.moveInput.forward;
    const len = Math.hypot(r, f);
    this.hasMoveInput = len >= 0.05;

    if (!this.hasMoveInput) {
      this.worldMoveDir.x = 0;
      this.worldMoveDir.z = 0;
      return;
    }

    // Planar basis: when locked on & dummy exists, planar forward points toward dummy; else along cameraYaw (+Z at yaw=0)
    let fx = Math.sin(this.cameraYaw);
    let fz = Math.cos(this.cameraYaw);
    if (this.isLockedOn && this.dummyWorldPos) {
      const dx = this.dummyWorldPos.x - this.playerWorldPos.x;
      const dz = this.dummyWorldPos.z - this.playerWorldPos.z;
      const dLen = Math.hypot(dx, dz);
      if (dLen > 1e-4) {
        fx = dx / dLen;
        fz = dz / dLen;
      } else {
        fx = Math.sin(this.playerYaw);
        fz = Math.cos(this.playerYaw);
      }
    }

    // Right-handed Three.js basis (+Z forward, +Y up, +X character left):
    // Right = Forward x Up = (-fz, 0, +fx)
    const rx = -fz;
    const rz = fx;

    const wx = rx * r + fx * f;
    const wz = rz * r + fz * f;
    const wLen = Math.hypot(wx, wz);
    if (wLen > 1e-6) {
      this.worldMoveDir.x = wx / wLen;
      this.worldMoveDir.z = wz / wLen;
    } else {
      this.worldMoveDir.x = fx;
      this.worldMoveDir.z = fz;
    }

    // Compute 8-way strafe sector relative to character facing yaw
    const charYaw =
      this.isLockedOn && this.dummyWorldPos
        ? this._computeTargetYaw()
        : this.playerYaw;
    const cfx = Math.sin(charYaw);
    const cfz = Math.cos(charYaw);
    const crx = -cfz;
    const crz = cfx;

    const dotF = this.worldMoveDir.x * cfx + this.worldMoveDir.z * cfz;
    const dotR = this.worldMoveDir.x * crx + this.worldMoveDir.z * crz;
    const theta = Math.atan2(dotR, dotF);
    const sectorIdx = ((Math.round(theta / (Math.PI / 4)) % 8) + 8) % 8;
    this.strafeSector = STRAFE_SECTORS[sectorIdx];
  }

  _computeTargetYaw() {
    if (!this.dummyWorldPos) return this.playerYaw;
    const dx = this.dummyWorldPos.x - this.playerWorldPos.x;
    const dz = this.dummyWorldPos.z - this.playerWorldPos.z;
    if (Math.hypot(dx, dz) < 1e-4) return this.playerYaw;
    return Math.atan2(dx, dz);
  }

  triggerHitstop(durationMs) {
    if (Number.isFinite(durationMs) && durationMs > 0) {
      this.hitstopRemainingMs = Math.max(this.hitstopRemainingMs, durationMs);
    }
  }

  enqueueInput(action, payload = {}) {
    return this.dispatchAction(action, payload);
  }

  dispatchAction(action, payload = {}) {
    const norm = normalizeActionName(action);
    if (!norm) return { executed: false, buffered: false, state: this.currentState };

    if (norm === 'Move') {
      this.setMoveInput(payload);
      return { executed: true, buffered: false, state: this.currentState };
    }
    if (norm === 'Sprint_Input') {
      const wasLocked = this.isLockedOn;
      if (wasLocked) this.isLockedOn = false;
      this.setMoveInput(payload && (payload.x !== undefined || payload.z !== undefined || payload.forward !== undefined) ? payload : { x: 0, z: 1 });
      return { executed: true, buffered: false, state: this.currentState };
    }
    if (norm === 'StopMove') {
      this.setMoveInput(null);
      return { executed: true, buffered: false, state: this.currentState };
    }
    if (norm === 'ToggleLockOn') {
      this.toggleLockOn();
      return { executed: true, buffered: false, state: this.currentState };
    }
    if (norm === 'SetLockOn') {
      const flag = typeof payload === 'boolean' ? payload : Boolean(payload?.locked ?? payload?.active ?? true);
      this.setLockOn(flag);
      return { executed: true, buffered: false, state: this.currentState };
    }
    if (norm === 'Reset') {
      this.reset(payload || {});
      return { executed: true, buffered: false, state: this.currentState };
    }

    // Incoming enemy attacks route directly to defense/parry/i-frame/interrupt resolution
    if (norm === 'Hit_Light_L' || norm === 'Hit_Light_R' || norm === 'Hit_Light' || norm === 'Hit_Knockdown') {
      const res = this.receiveEnemyAttack({
        type: norm === 'Hit_Knockdown' ? 'heavy' : 'light',
        side: norm === 'Hit_Light_L' ? 'L' : norm === 'Hit_Light_R' ? 'R' : payload?.side,
        attackerPos: payload?.attackerPos ?? this.dummyWorldPos,
        damage: payload?.damage,
        bypassDefenses: Boolean(payload?.bypassDefenses),
      });
      return { executed: res.outcome === 'hit', buffered: false, outcome: res.outcome, state: this.currentState };
    }

    // Attempt immediate execution if not frozen in hit-stop
    if (this.hitstopRemainingMs <= 0 && this._tryExecuteAction(norm, payload)) {
      return { executed: true, buffered: false, state: this.currentState };
    }

    // Do not queue redundant 3rd/4th mid-air jumps once double-jump charge is spent
    if ((norm === 'Jump' || norm === 'Air_Jump_Double') && this.doubleJumpUsed) {
      return { executed: false, buffered: false, state: this.currentState };
    }

    // Otherwise store in 180ms TTL input buffer
    this._pruneExpiredBuffer();
    const prio = BUFFER_ACTION_PRIORITY[norm] ?? 40;
    // Replace existing buffered entry of same action or push
    const existingIdx = this.inputBuffer.findIndex((e) => e.action === norm);
    if (existingIdx >= 0) {
      this.inputBuffer.splice(existingIdx, 1);
    }
    this.inputBuffer.push({
      action: norm,
      payload: payload || {},
      enqueuedAtMs: this.simTimeMs,
      priority: prio,
    });
    // Sort descending by priority, then newest first
    this.inputBuffer.sort((a, b) => b.priority - a.priority || b.enqueuedAtMs - a.enqueuedAtMs);
    if (this.inputBuffer.length > 4) {
      this.inputBuffer.length = 4;
    }

    return { executed: false, buffered: true, state: this.currentState };
  }

  /**
   * Resolves an incoming enemy hit against Parry Window, Invulnerability (i-frames), Super-Armor, and Hit-React priority.
   */
  receiveEnemyAttack(attackInfo = {}) {
    const safeAttack = attackInfo && typeof attackInfo === 'object' ? attackInfo : {};
    const type = safeAttack.type === 'heavy' ? 'heavy' : 'light';
    const defaultDamage = type === 'heavy' ? 85 : 35;
    const rawDamage = Number(safeAttack.damage);
    const damage = Number.isFinite(rawDamage) ? Math.max(0, rawDamage) : defaultDamage;
    const bypassDefenses = Boolean(safeAttack.bypassDefenses);

    if (!bypassDefenses) {
      // 1. Skill_Wuhen Parry / Deflect Counter Window [0.00, 0.42]
      if (this.isInParryWindow()) {
        this.parryTriggeredInState = true;
        this.parryCount += 1;
        this.wuhenBuffRemainingMs = this.wuhenBuffDurationMs;
        // Advance Wuhen into counter-slash riposte phase if earlier than 0.42
        if (this.stateNormalizedTime < 0.42) {
          this.stateNormalizedTime = 0.42;
          this.stateElapsedSec = 0.42 * this.stateDurationSec;
        }
        this.triggerHitstop(110);
        const evt = {
          type: 'parry_deflect',
          attackType: type,
          playerDamageTaken: 0,
          hitstopMs: 110,
          stunDummySec: type === 'heavy' ? 2.0 : 1.8,
          shatterPoise: true,
          counterDamage: type === 'heavy' ? 160 : 120,
        };
        this.pendingEvents.push(evt);
        return { outcome: 'parried', playerDamageTaken: 0, event: evt };
      }

      // 2. Active I-Frame Invulnerability check
      if (this.isInvulnerable()) {
        const evt = { type: 'evaded', attackType: type, state: this.currentState };
        this.pendingEvents.push(evt);
        return { outcome: 'evaded', playerDamageTaken: 0, event: evt };
      }

      // 3. Super-Armor check (e.g., Skill_Feiyan aerial ultimate resists light flinches)
      const cfg = STATE_CONFIGS[this.currentState];
      if (
        type === 'light' &&
        cfg?.superArmorWindow &&
        this.stateNormalizedTime >= cfg.superArmorWindow[0] &&
        this.stateNormalizedTime <= cfg.superArmorWindow[1]
      ) {
        const armoredDmg = Math.round(damage * 0.35);
        this.playerHp = Math.max(1, this.playerHp - armoredDmg);
        const evt = { type: 'super_armor_absorbed', playerDamageTaken: armoredDmg };
        this.pendingEvents.push(evt);
        return { outcome: 'armored', playerDamageTaken: armoredDmg, event: evt };
      }
    }

    // Compute knockback direction away from attacker (or backward -playerForward)
    const atkPos = safeAttack.attackerPos ?? this.dummyWorldPos;
    const hasFiniteAtkPos =
      atkPos &&
      typeof atkPos === 'object' &&
      Number.isFinite(Number(atkPos.x)) &&
      Number.isFinite(Number(atkPos.z));
    if (hasFiniteAtkPos) {
      const dx = this.playerWorldPos.x - Number(atkPos.x);
      const dz = this.playerWorldPos.z - Number(atkPos.z);
      const d = Math.hypot(dx, dz);
      if (Number.isFinite(d) && d > 1e-4) {
        this.knockbackDirXZ.x = dx / d;
        this.knockbackDirXZ.z = dz / d;
        this.playerYaw = Math.atan2(-this.knockbackDirXZ.x, -this.knockbackDirXZ.z);
      } else {
        this.knockbackDirXZ.x = -Math.sin(this.playerYaw);
        this.knockbackDirXZ.z = -Math.cos(this.playerYaw);
      }
    } else {
      this.knockbackDirXZ.x = -Math.sin(this.playerYaw);
      this.knockbackDirXZ.z = -Math.cos(this.playerYaw);
    }

    if (type === 'heavy') {
      // Priority 100: Hit_Knockdown interrupts everything non-invulnerable
      this.playerHp = Math.max(1, this.playerHp - damage);
      this._enterState('Hit_Knockdown');
      const evt = { type: 'player_hit', hitState: 'Hit_Knockdown', playerDamageTaken: damage };
      this.pendingEvents.push(evt);
      return { outcome: 'hit', playerDamageTaken: damage, event: evt };
    }

    // Priority 95: Hit_Light_L / Hit_Light_R (cannot override Priority 100 Hit_Knockdown)
    if (this.getPriority() >= 100) {
      return { outcome: 'ignored_knockdown', playerDamageTaken: 0 };
    }

    let side = safeAttack.side;
    if (side !== 'L' && side !== 'R') {
      side = this.nextLightHitSide;
      this.nextLightHitSide = side === 'L' ? 'R' : 'L';
    }
    const targetHitState = side === 'R' ? 'Hit_Light_R' : 'Hit_Light_L';
    this.playerHp = Math.max(1, this.playerHp - damage);
    this._enterState(targetHitState);
    const evt = { type: 'player_hit', hitState: targetHitState, playerDamageTaken: damage };
    this.pendingEvents.push(evt);
    return { outcome: 'hit', playerDamageTaken: damage, event: evt };
  }

  _tryExecuteAction(normAction, payload = {}) {
    const cur = this.currentState;
    const u = this.stateNormalizedTime;
    const curPrio = this.getPriority();

    // 1. Hit_Knockdown (Priority 100): ONLY KipUp / Jump / Dodge_Dash at u >= 0.55 can transition -> KipUp
    if (cur === 'Hit_Knockdown') {
      if (
        u >= STATE_CONFIGS.Hit_Knockdown.kipUpWindowStart &&
        (normAction === 'KipUp' || normAction === 'Jump' || normAction === 'Dodge_Dash')
      ) {
        this._enterState('KipUp', payload);
        this.pendingEvents.push({ type: 'kip_up_recovery', instant: true });
        return true;
      }
      return false;
    }

    // Explicit KipUp action is only valid from Hit_Knockdown
    if (normAction === 'KipUp') {
      return false;
    }

    // 2. Hit_Light_L / Hit_Light_R (Priority 95): ONLY Evade_Backflip can break out when off 6s cooldown!
    if (cur === 'Hit_Light_L' || cur === 'Hit_Light_R') {
      if (normAction === 'Evade_Backflip' && this.backflipCooldownMs <= 0) {
        this.backflipCooldownMs = this.backflipCooldownDurationMs;
        this._enterState('Evade_Backflip', payload);
        this.pendingEvents.push({ type: 'stagger_breakout', fromState: cur });
        return true;
      }
      return false;
    }

    // 3. KipUp (Priority 80, recovery i-frames): allow early action chain near completion (u >= 0.85)
    if (cur === 'KipUp' && u < 0.85) {
      return false;
    }

    // 4. Evade_Backflip (Priority 85)
    if (normAction === 'Evade_Backflip') {
      if (this.backflipCooldownMs > 0) return false;
      if (cur === 'Evade_Backflip' && u < 0.85) return false;
      this.backflipCooldownMs = this.backflipCooldownDurationMs;
      this._enterState('Evade_Backflip', payload);
      return true;
    }

    // 5. Dodge_Dash & Dodge_Roll (Priority 80)
    if (normAction === 'Dodge_Dash' || normAction === 'Dodge_Roll') {
      if (curPrio > 80) return false;
      if ((cur === 'Dodge_Dash' || cur === 'Dodge_Roll') && u < 0.78) return false;
      // Can cancel Attacks (40), Locomotion/Idle (0..10), Jump (50) anytime; cancels Skills (60) at u >= 0.12 (except Feiyan air commitment u < 0.75)
      if (cur === 'Skill_Feiyan' && u < 0.75) return false;
      if (curPrio === 60 && u < 0.12) return false;
      this._enterState(normAction, payload);
      return true;
    }

    // 6. Martial Skills (Priority 60: Skill_Wuhen, Skill_Yuluo, Skill_Feiyan, Skill_Kick)
    if (
      normAction === 'Skill_Wuhen' ||
      normAction === 'Skill_Yuluo' ||
      normAction === 'Skill_Feiyan' ||
      normAction === 'Skill_Kick'
    ) {
      if (curPrio > 60 && !(curPrio === 80 && u >= 0.82)) return false;
      if (curPrio === 60 && u < 0.82) return false;
      // Airborne restriction: only Skill_Feiyan can be cast mid-air
      if (this.playerWorldPos.y > 0.08 && normAction !== 'Skill_Feiyan') {
        return false;
      }
      // Attack_Combo_3 heavy commitment: skills cancel at u >= 0.46 (Attack_Combo_1 & 2 cancel anytime)
      if (cur === 'Attack_Combo_3' && u < 0.46) return false;
      this._enterState(normAction, payload);
      return true;
    }

    // 7. Jump & Air_Jump_Double (Priority 50)
    if (normAction === 'Air_Jump_Double') {
      if ((cur === 'Jump' && u >= 0.08) || (this.playerWorldPos.y > 0.05 && curPrio < 60)) {
        if (this.doubleJumpAvailable) {
          this.doubleJumpAvailable = false;
          this._enterState('Air_Jump_Double', payload);
          return true;
        }
      }
      return false;
    }

    if (normAction === 'Jump') {
      // Mid-air Jump chains to Air_Jump_Double
      if (cur === 'Jump') {
        if (u >= 0.08 && this.doubleJumpAvailable) {
          this.doubleJumpAvailable = false;
          this._enterState('Air_Jump_Double', payload);
          return true;
        }
        return false;
      }
      if (cur === 'Air_Jump_Double' || this.playerWorldPos.y > 0.08) {
        return false;
      }
      if (curPrio > 50 && !(curPrio === 80 && u >= 0.82)) return false;
      if (cur === 'Attack_Combo_3' && u < 0.46) return false;
      this._enterState('Jump', payload);
      return true;
    }

    // 8. Attack Combo 1 -> 2 -> 3 (Priority 40)
    if (
      normAction === 'Attack' ||
      normAction === 'Attack_Combo_1' ||
      normAction === 'Attack_Combo_2' ||
      normAction === 'Attack_Combo_3'
    ) {
      if (this.playerWorldPos.y > 0.12) return false;
      if (cur === 'Idle' || cur === 'Move_8Way' || cur === 'Sprint' || (curPrio === 80 && u >= 0.82)) {
        const target =
          normAction === 'Attack_Combo_2' || normAction === 'Attack_Combo_3' ? normAction : 'Attack_Combo_1';
        this._enterState(target, payload);
        return true;
      }
      if (cur === 'Attack_Combo_1') {
        const [w0, w1] = STATE_CONFIGS.Attack_Combo_1.comboChainWindow;
        if (u >= w0 && u <= w1 && normAction !== 'Attack_Combo_1') {
          this._enterState('Attack_Combo_2', payload);
          return true;
        }
        if (u >= w0 && u <= w1 && normAction === 'Attack_Combo_1') {
          this._enterState('Attack_Combo_2', payload);
          return true;
        }
        return false;
      }
      if (cur === 'Attack_Combo_2') {
        const [w0, w1] = STATE_CONFIGS.Attack_Combo_2.comboChainWindow;
        if (u >= w0 && u <= w1) {
          this._enterState('Attack_Combo_3', payload);
          return true;
        }
        return false;
      }
      if (cur === 'Attack_Combo_3') {
        if (u >= 0.88) {
          this._enterState('Attack_Combo_1', payload);
          return true;
        }
        return false;
      }
      return false;
    }

    return false;
  }

  _enterState(nextState, payload = {}) {
    const cfg = STATE_CONFIGS[nextState];
    if (!cfg) return;

    this.currentState = nextState;
    this.stateElapsedSec = 0;
    this.stateNormalizedTime = 0;
    this.stateInstanceId += 1;
    this.parryTriggeredInState = false;

    if (nextState === 'Skill_Kick') {
      const variant = payload?.variant === 'spin' || payload?.variant === 'tornado' ? 'spin' : 'front';
      this.kickVariant = variant;
      this.stateDurationSec = variant === 'spin' ? cfg.spinDurationSec : cfg.durationSec;
    } else {
      this.stateDurationSec = cfg.durationSec;
    }

    // Orient character on state entry
    if (
      nextState === 'Attack_Combo_1' ||
      nextState === 'Attack_Combo_2' ||
      nextState === 'Attack_Combo_3' ||
      nextState === 'Skill_Wuhen' ||
      nextState === 'Skill_Yuluo' ||
      nextState === 'Skill_Feiyan' ||
      nextState === 'Skill_Kick'
    ) {
      if (this.isLockedOn && this.dummyWorldPos) {
        this.playerYaw = this._computeTargetYaw();
      } else if (this.hasMoveInput) {
        this.playerYaw = Math.atan2(this.worldMoveDir.x, this.worldMoveDir.z);
      }
      this.actionYaw = this.playerYaw;
    } else if (nextState === 'Dodge_Dash' || nextState === 'Dodge_Roll') {
      if (payload && (Number.isFinite(Number(payload.x)) || Number.isFinite(Number(payload.z)))) {
        const px = finiteOr(payload.x, 0);
        const pz = finiteOr(payload.z, 0);
        if (Math.hypot(px, pz) > 1e-4) {
          this.actionYaw = Math.atan2(px, pz);
          this.playerYaw = this.actionYaw;
        } else {
          this.actionYaw = this.playerYaw;
        }
      } else if (this.hasMoveInput) {
        this.actionYaw = Math.atan2(this.worldMoveDir.x, this.worldMoveDir.z);
        if (!this.isLockedOn || nextState === 'Dodge_Roll') {
          this.playerYaw = this.actionYaw;
        }
      } else if (this.isLockedOn && this.dummyWorldPos) {
        this.playerYaw = this._computeTargetYaw();
        this.actionYaw = this.playerYaw;
      } else {
        this.actionYaw = this.playerYaw;
      }
    } else if (nextState === 'Evade_Backflip') {
      if (this.isLockedOn && this.dummyWorldPos) {
        this.playerYaw = this._computeTargetYaw();
      }
      this.actionYaw = this.playerYaw;
    } else if (nextState === 'Jump') {
      this.velY = cfg.jumpVelY;
      this.doubleJumpAvailable = true;
    } else if (nextState === 'Air_Jump_Double') {
      this.velY = cfg.jumpVelY;
      this.doubleJumpAvailable = false;
      this.pendingEvents.push({ type: 'double_jump_ring', pos: { ...this.playerWorldPos } });
    }

    if (nextState === 'Skill_Feiyan') {
      this.velY = 0;
    }

    this._recomputeMoveVectors();
  }

  _pruneExpiredBuffer() {
    for (let i = this.inputBuffer.length - 1; i >= 0; i--) {
      if (this.simTimeMs - this.inputBuffer[i].enqueuedAtMs > this.inputBufferTtlMs + 1e-6) {
        this.inputBuffer.splice(i, 1);
      }
    }
  }

  _consumeBufferedInput() {
    this._pruneExpiredBuffer();
    for (let i = 0; i < this.inputBuffer.length; i++) {
      const entry = this.inputBuffer[i];
      if (this._tryExecuteAction(entry.action, entry.payload)) {
        this.inputBuffer.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Advances simulation deterministically by `dt` seconds.
   * Sub-steps large `dt` into <= 1/60s increments so windows and boundary slides never tunnel.
   */
  step(dt, options = {}) {
    if (!Number.isFinite(dt) || dt <= 0) {
      return this.getState();
    }

    const maxStep = 1 / 60;
    const subSteps = Math.max(1, Math.ceil(dt / maxStep));
    const h = dt / subSteps;

    for (let s = 0; s < subSteps; s++) {
      this._stepSingle(h, options);
    }

    return this.getState();
  }

  _stepSingle(dt, options) {
    const dtMs = dt * 1000;
    this.simTimeMs += dtMs;

    // Cooldowns & buffs tick on simulation time
    if (this.backflipCooldownMs > 0) {
      this.backflipCooldownMs = Math.max(0, this.backflipCooldownMs - dtMs);
    }
    if (this.wuhenBuffRemainingMs > 0) {
      this.wuhenBuffRemainingMs = Math.max(0, this.wuhenBuffRemainingMs - dtMs);
    }

    // Hit-stop freeze handling (preserves input buffer TTL during freeze)
    let effectiveDt = dt;
    if (this.hitstopRemainingMs > 0) {
      const frozenMs = Math.min(this.hitstopRemainingMs, dtMs);
      this.hitstopRemainingMs = Math.max(0, this.hitstopRemainingMs - dtMs);
      for (let i = 0; i < this.inputBuffer.length; i++) {
        this.inputBuffer[i].enqueuedAtMs += frozenMs;
      }
      effectiveDt = Math.max(0, (dtMs - frozenMs) / 1000);
      if (effectiveDt <= 1e-7) {
        this.playerVelXZ.x = 0;
        this.playerVelXZ.z = 0;
        return;
      }
    }

    this._recomputeMoveVectors();

    // Check buffered inputs at start of tick (in case previous tick opened window)
    this._consumeBufferedInput();

    const cfg = STATE_CONFIGS[this.currentState];
    const uPrev = this.stateNormalizedTime;

    // Advance locomotion base cycle whenever moving
    if (this.hasMoveInput) {
      const locoDur = this.isLockedOn ? STATE_CONFIGS.Move_8Way.durationSec : STATE_CONFIGS.Sprint.durationSec;
      this.locoCycleU = (this.locoCycleU + effectiveDt / locoDur) % 1;
    }

    // Advance state time
    this.stateElapsedSec += effectiveDt;
    if (cfg.cyclic) {
      this.stateNormalizedTime = (this.stateElapsedSec / this.stateDurationSec) % 1;
    } else {
      this.stateNormalizedTime = clamp(this.stateElapsedSec / this.stateDurationSec, 0, 1);
    }
    const uCurr = this.stateNormalizedTime;

    // Update Upper Override blend weight (0 -> 1 in 0.10s, 1 -> 0 in 0.18s)
    const isUpperOverrideActive =
      (this.currentState === 'Attack_Combo_1' || this.currentState === 'Attack_Combo_2') && this.hasMoveInput;
    if (isUpperOverrideActive) {
      this.upperLayerAlpha = Math.min(1, this.upperLayerAlpha + effectiveDt / 0.10);
    } else {
      this.upperLayerAlpha = Math.max(0, this.upperLayerAlpha - effectiveDt / 0.18);
    }

    // Orient & compute horizontal world displacement
    let dxWorld = 0;
    let dzWorld = 0;

    if (this.currentState === 'Move_8Way') {
      if (this.dummyWorldPos) {
        this.playerYaw = dampAngleRad(this.playerYaw, this._computeTargetYaw(), 18, effectiveDt);
      }
      const spd = STATE_CONFIGS.Move_8Way.speedMps;
      dxWorld = this.worldMoveDir.x * spd * effectiveDt;
      dzWorld = this.worldMoveDir.z * spd * effectiveDt;
    } else if (this.currentState === 'Sprint') {
      if (this.hasMoveInput) {
        const targetYaw = Math.atan2(this.worldMoveDir.x, this.worldMoveDir.z);
        this.playerYaw = dampAngleRad(this.playerYaw, targetYaw, 16, effectiveDt);
      }
      const spd = STATE_CONFIGS.Sprint.speedMps;
      dxWorld = this.worldMoveDir.x * spd * effectiveDt;
      dzWorld = this.worldMoveDir.z * spd * effectiveDt;
    } else if (isUpperOverrideActive) {
      // Moving-While-Slashing: lower body moves at strafe/sprint speed while upper body cleaves!
      if (this.isLockedOn && this.dummyWorldPos) {
        this.playerYaw = dampAngleRad(this.playerYaw, this._computeTargetYaw(), 18, effectiveDt);
      } else if (this.hasMoveInput) {
        const targetYaw = Math.atan2(this.worldMoveDir.x, this.worldMoveDir.z);
        this.playerYaw = dampAngleRad(this.playerYaw, targetYaw, 14, effectiveDt);
      }
      const spd = this.isLockedOn ? STATE_CONFIGS.Move_8Way.speedMps : STATE_CONFIGS.Sprint.speedMps * 0.88;
      dxWorld = this.worldMoveDir.x * spd * effectiveDt;
      dzWorld = this.worldMoveDir.z * spd * effectiveDt;
    } else if (this.currentState === 'Jump' || this.currentState === 'Air_Jump_Double') {
      if (this.isLockedOn && this.dummyWorldPos) {
        this.playerYaw = dampAngleRad(this.playerYaw, this._computeTargetYaw(), 14, effectiveDt);
      } else if (this.hasMoveInput) {
        const targetYaw = Math.atan2(this.worldMoveDir.x, this.worldMoveDir.z);
        this.playerYaw = dampAngleRad(this.playerYaw, targetYaw, 12, effectiveDt);
      }
      if (this.hasMoveInput) {
        dxWorld = this.worldMoveDir.x * cfg.airControlSpeedMps * effectiveDt;
        dzWorld = this.worldMoveDir.z * cfg.airControlSpeedMps * effectiveDt;
      }
    } else if (this.currentState === 'Hit_Light_L' || this.currentState === 'Hit_Light_R' || this.currentState === 'Hit_Knockdown') {
      const distDelta = Math.abs(cfg.impulseMeters) * (impulseEaseCurve(uCurr) - impulseEaseCurve(uPrev));
      dxWorld = this.knockbackDirXZ.x * distDelta;
      dzWorld = this.knockbackDirXZ.z * distDelta;
    } else if (typeof options?.sampleClipRootDelta === 'function' && (this.currentState === 'Skill_Kick' || this.currentState === 'Skill_Wuhen')) {
      const clipDelta = options.sampleClipRootDelta(this.getActiveStateClipId(), uPrev, uCurr);
      const extraFwd =
        this.currentState === 'Skill_Kick'
          ? 0.30 * (impulseEaseCurve(uCurr) - impulseEaseCurve(uPrev))
          : 0;
      if (clipDelta) {
        const localX = clipDelta.x;
        const localZ = clipDelta.z + extraFwd;
        const sinY = Math.sin(this.playerYaw);
        const cosY = Math.cos(this.playerYaw);
        dxWorld = localX * cosY + localZ * sinY;
        dzWorld = -localX * sinY + localZ * cosY;
      }
    } else if (cfg.impulseMeters) {
      if (this.isLockedOn && this.dummyWorldPos && this.currentState !== 'Dodge_Dash' && this.currentState !== 'Dodge_Roll') {
        this.playerYaw = dampAngleRad(this.playerYaw, this._computeTargetYaw(), 14, effectiveDt);
        this.actionYaw = this.playerYaw;
      }
      const distDelta = cfg.impulseMeters * (impulseEaseCurve(uCurr) - impulseEaseCurve(uPrev));
      dxWorld = Math.sin(this.actionYaw) * distDelta;
      dzWorld = Math.cos(this.actionYaw) * distDelta;
    } else if (this.currentState === 'Idle' && this.isLockedOn && this.dummyWorldPos) {
      this.playerYaw = dampAngleRad(this.playerYaw, this._computeTargetYaw(), 16, effectiveDt);
    }

    // Apply horizontal displacement
    this.playerWorldPos.x += dxWorld;
    this.playerWorldPos.z += dzWorld;
    this.playerVelXZ.x = dxWorld / effectiveDt;
    this.playerVelXZ.z = dzWorld / effectiveDt;

    // Integrate vertical trajectory
    if (this.currentState === 'Skill_Feiyan') {
      // Controlled martial aerial vortex arc peaking at u=0.45 and slamming down at u=0.76
      if (uCurr < 0.76) {
        const phase = uCurr / 0.76;
        this.playerWorldPos.y = Math.sin(phase * Math.PI) * 1.15;
      } else {
        this.playerWorldPos.y = 0;
      }
      this.velY = 0;
    } else if (this.currentState === 'Jump' || this.currentState === 'Air_Jump_Double' || this.playerWorldPos.y > 0 || this.velY > 0) {
      this.velY += GRAVITY_ACCEL * effectiveDt;
      this.playerWorldPos.y += this.velY * effectiveDt;
      if (this.playerWorldPos.y <= 0) {
        this.playerWorldPos.y = 0;
        this.velY = 0;
        this.doubleJumpAvailable = true;
        if ((this.currentState === 'Jump' || this.currentState === 'Air_Jump_Double') && uCurr > 0.15) {
          this._finishOneShotState();
        }
      }
    }

    // Check buffered inputs again immediately after advancing u (fires on exact tick window opens!)
    this._consumeBufferedInput();

    // Check non-cyclic state completion
    const activeCfg = STATE_CONFIGS[this.currentState];
    if (!activeCfg.cyclic && this.stateElapsedSec >= this.stateDurationSec - 1e-7) {
      if (this.currentState === 'Hit_Knockdown') {
        // Auto-chain Hit_Knockdown -> KipUp at u >= 1.00
        this._enterState('KipUp');
        this.pendingEvents.push({ type: 'kip_up_recovery', instant: false });
      } else if (this.currentState !== 'Jump' && this.currentState !== 'Air_Jump_Double') {
        this._finishOneShotState();
      } else if (this.playerWorldPos.y <= 0.001) {
        this.playerWorldPos.y = 0;
        this.velY = 0;
        this.doubleJumpAvailable = true;
        this._finishOneShotState();
      }
    }

    // 1. Player-vs-Dummy Capsule Separation (minDist = 0.68m)
    if (this.dummyWorldPos && this.playerWorldPos.y < 1.35) {
      const dx = this.playerWorldPos.x - this.dummyWorldPos.x;
      const dz = this.playerWorldPos.z - this.dummyWorldPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < this.minDummySeparation) {
        let nx;
        let nz;
        if (dist > 1e-5) {
          nx = dx / dist;
          nz = dz / dist;
        } else {
          nx = -Math.sin(this.playerYaw);
          nz = -Math.cos(this.playerYaw);
        }
        this.playerWorldPos.x = this.dummyWorldPos.x + nx * this.minDummySeparation;
        this.playerWorldPos.z = this.dummyWorldPos.z + nz * this.minDummySeparation;
        const vn = this.playerVelXZ.x * nx + this.playerVelXZ.z * nz;
        if (vn < 0) {
          this.playerVelXZ.x -= vn * nx;
          this.playerVelXZ.z -= vn * nz;
        }
      }
    }

    // 2. Circular Arena Clamping AFTER Dummy Separation (guarantees hypot(x, z) <= 8.15 < 8.5 unconditionally!)
    const safeR = this.arenaClampRadius * (1 - 2e-12);
    const r = Math.hypot(this.playerWorldPos.x, this.playerWorldPos.z);
    if (r > this.arenaClampRadius) {
      const nx = this.playerWorldPos.x / r;
      const nz = this.playerWorldPos.z / r;
      this.playerWorldPos.x = nx * safeR;
      this.playerWorldPos.z = nz * safeR;
      const vn = this.playerVelXZ.x * nx + this.playerVelXZ.z * nz;
      if (vn > 0) {
        this.playerVelXZ.x -= vn * nx;
        this.playerVelXZ.z -= vn * nz;
      }

      // 3. Corner-wedge tangential slide: if wall clamp compressed player back into dummy capsule,
      // project onto exact circle-circle intersection on `r = safeR` so BOTH r <= 8.15 and dist >= 0.68 hold!
      if (this.dummyWorldPos && this.playerWorldPos.y < 1.35) {
        const dxW = this.playerWorldPos.x - this.dummyWorldPos.x;
        const dzW = this.playerWorldPos.z - this.dummyWorldPos.z;
        const distW = Math.hypot(dxW, dzW);
        const dMin = this.minDummySeparation;
        const dummyR = Math.hypot(this.dummyWorldPos.x, this.dummyWorldPos.z);
        if (
          distW < dMin - 1e-6 &&
          dummyR > 1e-5 &&
          safeR + dummyR > dMin &&
          Math.abs(safeR - dummyR) < dMin
        ) {
          const ux = this.dummyWorldPos.x / dummyR;
          const uz = this.dummyWorldPos.z / dummyR;
          const tx = -uz;
          const tz = ux;
          const cosAlpha = clamp(
            (safeR * safeR + dummyR * dummyR - dMin * dMin) / (2 * safeR * dummyR),
            -1,
            1
          );
          const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));
          const sideSign = this.playerWorldPos.x * tx + this.playerWorldPos.z * tz >= 0 ? 1 : -1;
          this.playerWorldPos.x = safeR * (ux * cosAlpha + sideSign * tx * sinAlpha);
          this.playerWorldPos.z = safeR * (uz * cosAlpha + sideSign * tz * sinAlpha);
          const rCheck = Math.hypot(this.playerWorldPos.x, this.playerWorldPos.z);
          if (rCheck > this.arenaClampRadius) {
            const s = safeR / rCheck;
            this.playerWorldPos.x *= s;
            this.playerWorldPos.z *= s;
          }
        }
      }
    }
  }

  _finishOneShotState() {
    this._recomputeMoveVectors();
    if (this.hasMoveInput) {
      this._enterState(this.isLockedOn ? 'Move_8Way' : 'Sprint');
    } else {
      this._enterState('Idle');
    }
    this._consumeBufferedInput();
  }

  consumeEvents() {
    if (this.pendingEvents.length === 0) return [];
    const copy = this.pendingEvents.slice();
    this.pendingEvents.length = 0;
    return copy;
  }

  getPriority() {
    return STATE_PRIORITIES[this.currentState] ?? 0;
  }

  isInvulnerable() {
    const cfg = STATE_CONFIGS[this.currentState];
    const u = this.stateNormalizedTime;
    if (this.currentState === 'Skill_Wuhen' && this.parryTriggeredInState && u >= 0.42 && u <= 1.0) {
      return true;
    }
    if (!cfg || !cfg.iframeWindow) return false;
    return u >= cfg.iframeWindow[0] && u <= cfg.iframeWindow[1];
  }

  isInParryWindow() {
    if (this.currentState !== 'Skill_Wuhen' || this.parryTriggeredInState) return false;
    const [w0, w1] = STATE_CONFIGS.Skill_Wuhen.parryWindow;
    return this.stateNormalizedTime >= w0 && this.stateNormalizedTime <= w1;
  }

  canComboChain() {
    const cfg = STATE_CONFIGS[this.currentState];
    if (!cfg || !cfg.comboChainWindow) return false;
    return (
      this.stateNormalizedTime >= cfg.comboChainWindow[0] &&
      this.stateNormalizedTime <= cfg.comboChainWindow[1]
    );
  }

  getActiveHitWindow() {
    const cfg = STATE_CONFIGS[this.currentState];
    if (!cfg || !cfg.hitWindows || cfg.hitWindows.length === 0) return null;
    const u = this.stateNormalizedTime;
    for (let i = 0; i < cfg.hitWindows.length; i++) {
      const hw = cfg.hitWindows[i];
      if (hw.requiresParry && !this.parryTriggeredInState) continue;
      if (u >= hw.start && u <= hw.end) {
        const wuhenMult = this.wuhenBuffRemainingMs > 0 ? 1.25 : 1.0;
        return {
          windowIdx: i,
          swingKey: `${this.stateInstanceId}:${i}`,
          damage: Math.round(hw.damage * wuhenMult),
          poiseDamage: hw.poiseDamage,
          hitstopMs: hw.hitstopMs,
          type: hw.type,
          heavy: Boolean(hw.heavy),
          guardBreak: Boolean(hw.guardBreak),
          aoeRadius: hw.aoeRadius ?? 0,
        };
      }
    }
    return null;
  }

  getActiveStateClipId() {
    if (this.currentState === 'Move_8Way') {
      return `07_strafe_${this.strafeSector}`;
    }
    if (this.currentState === 'Skill_Kick') {
      return this.kickVariant === 'spin' ? '04_tornado_kick' : '05_front_kick';
    }
    return STATE_CONFIGS[this.currentState]?.clipId || 'taibai_01b';
  }

  getLayerDescriptor() {
    const isMovingSlash =
      (this.currentState === 'Attack_Combo_1' || this.currentState === 'Attack_Combo_2') &&
      this.hasMoveInput;

    if (isMovingSlash) {
      const baseState = this.isLockedOn ? 'Move_8Way' : 'Sprint';
      const baseClipId = this.isLockedOn ? `07_strafe_${this.strafeSector}` : '02_run';
      const upperClipId = this.currentState === 'Attack_Combo_1' ? 'combo_1' : 'combo_2';
      return {
        layerMode: 'upper_override',
        baseState,
        baseClipId,
        baseNormalizedTime: this.locoCycleU,
        baseCrossfadeSec: 0.10,
        upperState: this.currentState,
        upperClipId,
        upperNormalizedTime: this.stateNormalizedTime,
        upperCrossfadeSec: 0.06,
        targetUpperAlpha: 1.0,
      };
    }

    const baseClipId = this.getActiveStateClipId();
    const cfg = STATE_CONFIGS[this.currentState];
    return {
      layerMode: 'full_body',
      baseState: this.currentState,
      baseClipId,
      baseNormalizedTime: this.stateNormalizedTime,
      baseCrossfadeSec: cfg?.crossfadeSec ?? 0.10,
      upperState: null,
      upperClipId: null,
      upperNormalizedTime: 0,
      upperCrossfadeSec: 0.08,
      targetUpperAlpha: 0.0,
    };
  }

  getState() {
    const layer = this.getLayerDescriptor();
    return {
      currentState: this.currentState,
      wuxiaName: STATE_CONFIGS[this.currentState]?.wuxiaName ?? this.currentState,
      stateNormalizedTime: this.stateNormalizedTime,
      priority: this.getPriority(),
      isInvulnerable: this.isInvulnerable(),
      inParryWindow: this.isInParryWindow(),
      canComboChain: this.canComboChain(),
      layerMode: layer.layerMode,
      baseState: layer.baseState,
      baseClipId: layer.baseClipId,
      upperClipId: layer.upperClipId,
      targetUpperAlpha: layer.targetUpperAlpha,
      upperLayerAlpha: this.upperLayerAlpha,
      boneLayerWeights: { ...CANONICAL_21_BONE_WEIGHTS },
      playerWorldPos: {
        x: this.playerWorldPos.x,
        y: this.playerWorldPos.y,
        z: this.playerWorldPos.z,
      },
      playerVelXZ: {
        x: this.playerVelXZ.x,
        z: this.playerVelXZ.z,
      },
      playerYaw: this.playerYaw,
      isLockedOn: this.isLockedOn,
      strafeSector: this.strafeSector,
      doubleJumpAvailable: this.doubleJumpAvailable,
      backflipCooldownMs: this.backflipCooldownMs,
      wuhenBuffRemainingMs: this.wuhenBuffRemainingMs,
      hitstopRemainingMs: this.hitstopRemainingMs,
      simTimeMs: this.simTimeMs,
      bufferedInputCount: this.inputBuffer.length,
    };
  }
}
