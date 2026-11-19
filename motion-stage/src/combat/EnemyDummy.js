import * as THREE from 'three';
import { buildCharacterRig, BONE_IDX } from '../rig/HumanoidRig.js';
import { applyForearmTwistSolver, SpringClothSolver } from '../pipeline/TwoBoneIK.js';
import { sampleClipNormalized, allocatePoseBuffer } from './LayeredAnimator.js';
import { ARENA_CLAMP_RADIUS, MIN_DUMMY_SEPARATION } from './CombatStateMachine.js';

export const DUMMY_SPAWN_POS = Object.freeze({ x: 0, y: 0, z: 1.65 });
export const DUMMY_CAPSULE_RADIUS = 0.34;
export const DUMMY_CAPSULE_HEIGHT = 1.72;
export const SWORD_BLADE_HIT_RADIUS = 0.16;
export const KICK_FOOT_HIT_RADIUS = 0.28;

const _segD1 = new THREE.Vector3();
const _segD2 = new THREE.Vector3();
const _segR = new THREE.Vector3();
const _ptA = new THREE.Vector3();
const _ptB = new THREE.Vector3();
const _lerpB = new THREE.Vector3();
const _lerpT = new THREE.Vector3();
const _capP0 = new THREE.Vector3();
const _capP1 = new THREE.Vector3();

/**
 * Exact closest-point squared distance between 3D line segments P1->Q1 and P2->Q2.
 */
export function closestDistanceSqSegmentToSegment(
  p1,
  q1,
  p2,
  q2,
  outClosestA = null,
  outClosestB = null
) {
  _segD1.subVectors(q1, p1);
  _segD2.subVectors(q2, p2);
  _segR.subVectors(p1, p2);

  const a = _segD1.dot(_segD1);
  const e = _segD2.dot(_segD2);
  const f = _segD2.dot(_segR);

  let s = 0;
  let t = 0;

  if (a <= 1e-8 && e <= 1e-8) {
    s = 0;
    t = 0;
  } else if (a <= 1e-8) {
    s = 0;
    t = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = _segD1.dot(_segR);
    if (e <= 1e-8) {
      t = 0;
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const b = _segD1.dot(_segD2);
      const denom = a * e - b * b;
      if (denom !== 0) {
        s = THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1);
      } else {
        s = 0;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = THREE.MathUtils.clamp((b - c) / a, 0, 1);
      }
    }
  }

  _ptA.copy(p1).addScaledVector(_segD1, s);
  _ptB.copy(p2).addScaledVector(_segD2, t);
  if (outClosestA) outClosestA.copy(_ptA);
  if (outClosestB) outClosestB.copy(_ptB);
  return _ptA.distanceToSquared(_ptB);
}

/**
 * Sub-stepped (`K = 4`) swept greatsword blade segment + tip motion chord vs vertical capsule collision.
 */
export function testSweptBladeVsCapsule(
  prevBase,
  prevTip,
  currBase,
  currTip,
  capsuleWorldPos,
  capsuleRadius = DUMMY_CAPSULE_RADIUS,
  bladeRadius = SWORD_BLADE_HIT_RADIUS,
  subSteps = 4
) {
  _capP0.set(capsuleWorldPos.x, (capsuleWorldPos.y || 0) + capsuleRadius, capsuleWorldPos.z);
  _capP1.set(
    capsuleWorldPos.x,
    (capsuleWorldPos.y || 0) + (DUMMY_CAPSULE_HEIGHT - capsuleRadius),
    capsuleWorldPos.z
  );

  const combinedR = capsuleRadius + bladeRadius;
  const threshSq = combinedR * combinedR;
  let minDistSq = Infinity;
  const hitPoint = new THREE.Vector3();
  const candA = new THREE.Vector3();
  const candB = new THREE.Vector3();

  const steps = Math.max(1, subSteps);
  const startB = prevBase || currBase;
  const startT = prevTip || currTip;

  for (let k = 1; k <= steps; k++) {
    const alpha = k / steps;
    _lerpB.lerpVectors(startB, currBase, alpha);
    _lerpT.lerpVectors(startT, currTip, alpha);
    const dSq = closestDistanceSqSegmentToSegment(_lerpB, _lerpT, _capP0, _capP1, candA, candB);
    if (dSq < minDistSq) {
      minDistSq = dSq;
      hitPoint.lerpVectors(candA, candB, 0.5);
    }
  }

  // Tip sweep chord check prevents fast 180-degree swings from skipping across capsule between sub-steps
  if (prevTip) {
    const chordSq = closestDistanceSqSegmentToSegment(prevTip, currTip, _capP0, _capP1, candA, candB);
    if (chordSq < minDistSq) {
      minDistSq = chordSq;
      hitPoint.lerpVectors(candA, candB, 0.5);
    }
  }

  return {
    hit: minDistSq <= threshSq,
    distance: Math.sqrt(minDistSq),
    hitPoint,
  };
}

/**
 * Sub-stepped swept sphere (e.g. RightFoot / LeftFoot kick) vs vertical capsule collision.
 */
export function testSweptSphereVsCapsule(
  prevCenter,
  currCenter,
  sphereRadius = KICK_FOOT_HIT_RADIUS,
  capsuleWorldPos,
  capsuleRadius = DUMMY_CAPSULE_RADIUS
) {
  _capP0.set(capsuleWorldPos.x, (capsuleWorldPos.y || 0) + capsuleRadius, capsuleWorldPos.z);
  _capP1.set(
    capsuleWorldPos.x,
    (capsuleWorldPos.y || 0) + (DUMMY_CAPSULE_HEIGHT - capsuleRadius),
    capsuleWorldPos.z
  );

  const combinedR = sphereRadius + capsuleRadius;
  const startC = prevCenter || currCenter;
  const candA = new THREE.Vector3();
  const candB = new THREE.Vector3();
  const dSq = closestDistanceSqSegmentToSegment(startC, currCenter, _capP0, _capP1, candA, candB);
  const hitPoint = new THREE.Vector3().lerpVectors(candA, candB, 0.5);

  return {
    hit: dSq <= combinedR * combinedR,
    distance: Math.sqrt(dSq),
    hitPoint,
  };
}

/**
 * Switches EnemyDummy to `'prod'` skinning FIRST, then remaps all 17,196 baked vertex colors
 * to Obsidian Iron + Wuxia Crimson + Burnished Brass and configures zero-GC emissive hit-flash.
 */
export function applyEnemyDummyPalette(dummyRig) {
  // 1. MUST call setSkinningVisualState('prod', false) BEFORE vertex color remapping!
  dummyRig.setSkinningVisualState('prod', false);

  const paletteMap = [
    [new THREE.Color(0x8d99a8), new THREE.Color(0x2d2930)], // armorSteel  -> Obsidian Iron
    [new THREE.Color(0x39414c), new THREE.Color(0x17151b)], // darkUnder   -> Deep Charcoal
    [new THREE.Color(0xc5924c), new THREE.Color(0xd68c42)], // trimBronze  -> Burnished Brass
    [new THREE.Color(0x2c6e68), new THREE.Color(0x9e242b)], // skirt       -> Wuxia Cinnabar Crimson
    [new THREE.Color(0x284b57), new THREE.Color(0x6b1820)], // capeSlate   -> Dark Crimson Cloak
  ];

  const colAttr = dummyRig.mesh.geometry.attributes.color;
  const arr = colAttr.array;
  for (let i = 0; i < colAttr.count; i++) {
    const r = arr[i * 3];
    const g = arr[i * 3 + 1];
    const b = arr[i * 3 + 2];
    for (let p = 0; p < paletteMap.length; p++) {
      const [src, dst] = paletteMap[p];
      if (Math.abs(r - src.r) + Math.abs(g - src.g) + Math.abs(b - src.b) < 0.015) {
        arr[i * 3] = dst.r;
        arr[i * 3 + 1] = dst.g;
        arr[i * 3 + 2] = dst.b;
        break;
      }
    }
  }
  colAttr.needsUpdate = true;

  // Configure armor sheen & silent default emissive hit-flash channel
  dummyRig.mesh.material.roughness = 0.38;
  dummyRig.mesh.material.metalness = 0.42;
  dummyRig.mesh.material.emissive.setHex(0xffcf75);
  dummyRig.mesh.material.emissiveIntensity = 0.0;

  dummyRig.swordGroup.traverse((child) => {
    if (child.isMesh && child.material?.color) {
      if (child.geometry.type === 'ConeGeometry' || child.position.z > 0.4) {
        child.material.color.setHex(0x8a929e);
        if (child.material.emissive) {
          child.material.emissive.setHex(0x3a0c0e);
        }
      }
    }
  });
}

function wrapAngleRad(a) {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
}

export class EnemyDummy {
  constructor(clipRegistry = null, options = {}) {
    this.clipRegistry = clipRegistry;
    this.rig = buildCharacterRig();
    applyEnemyDummyPalette(this.rig);

    this.worldGroup = new THREE.Group();
    this.worldGroup.name = 'EnemyDummyWorldGroup';
    this.worldGroup.add(this.rig.rootGroup);

    // Ground telegraph ring (hidden until Mode 2 amber / Mode 3 crimson windup)
    this.telegraphGroup = new THREE.Group();
    this.telegraphGroup.position.y = 0.008;

    const outerGeo = new THREE.RingGeometry(1.78, 1.86, 64);
    outerGeo.rotateX(-Math.PI * 0.5);
    this.telegraphBorderMat = new THREE.MeshBasicMaterial({
      color: 0xe5a93c,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.telegraphBorderMesh = new THREE.Mesh(outerGeo, this.telegraphBorderMat);

    const fillGeo = new THREE.CircleGeometry(1.82, 64);
    fillGeo.rotateX(-Math.PI * 0.5);
    this.telegraphFillMat = new THREE.MeshBasicMaterial({
      color: 0xe5a93c,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.telegraphFillMesh = new THREE.Mesh(fillGeo, this.telegraphFillMat);

    this.telegraphGroup.add(this.telegraphFillMesh, this.telegraphBorderMesh);
    this.telegraphGroup.visible = false;
    this.worldGroup.add(this.telegraphGroup);

    // Independent per-character cloth solver (NEVER shared with player!)
    this.clothSolver = new SpringClothSolver();
    this._poseBuf = allocatePoseBuffer();

    this.maxHp = 1000;
    this.hp = 1000;
    this.maxPoise = 100;
    this.poise = 100;

    this.mode = options.initialMode ?? 1; // 1: Passive, 2: Light Counter AI, 3: Heavy Knockdown AI
    this.worldPos = {
      x: options.x ?? DUMMY_SPAWN_POS.x,
      y: options.y ?? DUMMY_SPAWN_POS.y,
      z: options.z ?? DUMMY_SPAWN_POS.z,
    };
    this.velXZ = { x: 0, z: 0 };
    this.yaw = Math.PI; // Faces -Z toward player at (0, 0, 0)

    this.aiState = 'Idle';
    this.aiStateElapsed = 0;
    this.aiStateDuration = 1.0;
    this.attackCooldownSec = 1.1;
    this.poiseRegenDelaySec = 0;
    this.hpRefillDelaySec = 0;
    this.hitFlashTimer = 0;
    this.knockbackVelXZ = { x: 0, z: 0 };
    this.nextFlinchSide = 'L';
    this._strikeDelivered = false;

    this.worldGroup.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.worldGroup.rotation.set(0, this.yaw, 0);
    this.worldGroup.updateMatrixWorld(true);
  }

  setClipRegistry(registry) {
    this.clipRegistry = registry;
  }

  reset(pos = DUMMY_SPAWN_POS) {
    this.hp = this.maxHp;
    this.poise = this.maxPoise;
    this.worldPos.x = pos.x ?? DUMMY_SPAWN_POS.x;
    this.worldPos.y = pos.y ?? DUMMY_SPAWN_POS.y;
    this.worldPos.z = pos.z ?? DUMMY_SPAWN_POS.z;
    this.velXZ.x = 0;
    this.velXZ.z = 0;
    this.knockbackVelXZ.x = 0;
    this.knockbackVelXZ.z = 0;
    this.yaw = Math.PI;
    this.aiState = 'Idle';
    this.aiStateElapsed = 0;
    this.aiStateDuration = 1.0;
    this.attackCooldownSec = this.mode === 2 ? 1.0 : this.mode === 3 ? 1.2 : 1.5;
    this.poiseRegenDelaySec = 0;
    this.hpRefillDelaySec = 0;
    this.hitFlashTimer = 0;
    this._strikeDelivered = false;
    this.rig.mesh.material.emissiveIntensity = 0.0;
    this.telegraphGroup.visible = false;
    this.clothSolver.reset(this.rig.bones);
    this.worldGroup.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.worldGroup.rotation.set(0, this.yaw, 0);
    this.worldGroup.updateMatrixWorld(true);
  }

  setMode(mode) {
    const m = Number(mode);
    if (m === 1 || m === 2 || m === 3) {
      this.mode = m;
      if (this.aiState.startsWith('Telegraph_') || this.aiState === 'Approach') {
        this._enterAiState('Idle', 1.0);
      }
      this.attackCooldownSec = m === 2 ? 0.65 : m === 3 ? 0.85 : 1.5;
      this.telegraphGroup.visible = false;
    }
    return this.mode;
  }

  /**
   * Deterministic test/sparring helper to start Mode 2 light (`0.45s`) or Mode 3 heavy (`0.65s`) telegraph immediately.
   */
  triggerImmediateTelegraph(type = null) {
    const useHeavy = type === 'heavy' || (type === null && this.mode === 3);
    if (useHeavy) {
      if (this.mode === 1) this.mode = 3;
      this._enterAiState('Telegraph_Heavy', 0.65);
    } else {
      if (this.mode === 1) this.mode = 2;
      this._enterAiState('Telegraph_Light', 0.45);
    }
  }

  _enterAiState(state, duration = 1.0) {
    this.aiState = state;
    this.aiStateElapsed = 0;
    this.aiStateDuration = Math.max(0.05, duration);
    this._strikeDelivered = false;

    if (state === 'Telegraph_Light') {
      this.telegraphGroup.visible = true;
      this.telegraphGroup.scale.set(1, 1, 1);
      this.telegraphBorderMat.color.setHex(0xe5a93c);
      this.telegraphFillMat.color.setHex(0xe5a93c);
    } else if (state === 'Telegraph_Heavy') {
      this.telegraphGroup.visible = true;
      const s = 2.35 / 1.85;
      this.telegraphGroup.scale.set(s, 1, s);
      this.telegraphBorderMat.color.setHex(0xe05252);
      this.telegraphFillMat.color.setHex(0xe05252);
    } else {
      this.telegraphGroup.visible = false;
    }
  }

  receivePlayerHit(hitInfo = {}) {
    const rawDamage = Number(hitInfo.damage ?? 24);
    const damage = Math.max(1, Math.round(Number.isFinite(rawDamage) ? rawDamage : 24));
    const rawPoiseDmg = Number(hitInfo.poiseDamage ?? 18);
    const poiseDamage = Math.max(0, Math.round(Number.isFinite(rawPoiseDmg) ? rawPoiseDmg : 18));
    const guardBreak = Boolean(hitInfo.guardBreak);
    const heavy = Boolean(hitInfo.heavy);
    const attackerPos = hitInfo.attackerPos || { x: 0, z: 0 };

    this.hp = Math.max(0, this.hp - damage);
    if (this.hp === 0) {
      this.hpRefillDelaySec = 1.25;
    }

    this.hitFlashTimer = 0.095;
    this.poiseRegenDelaySec = 2.4;

    const ax = Number.isFinite(Number(attackerPos.x)) ? Number(attackerPos.x) : 0;
    const az = Number.isFinite(Number(attackerPos.z)) ? Number(attackerPos.z) : 0;
    const dx = this.worldPos.x - ax;
    const dz = this.worldPos.z - az;
    const dist = Math.hypot(dx, dz);
    const nx = dist > 1e-4 ? dx / dist : 0;
    const nz = dist > 1e-4 ? dz / dist : 1;

    const alreadyBroken = this.aiState === 'GuardBreak' || this.aiState === 'ParryStun';
    if (!alreadyBroken && (guardBreak || (this.poise > 0 && this.poise - poiseDamage <= 0))) {
      this.poise = 0;
      this.knockbackVelXZ.x = nx * 4.2;
      this.knockbackVelXZ.z = nz * 4.2;
      this._enterAiState('GuardBreak', 1.35);
      return { guardBroken: true, hp: this.hp, poise: this.poise };
    }

    if (alreadyBroken) {
      this.poise = 0;
      const kbSpeed = heavy ? 3.2 : 1.6;
      this.knockbackVelXZ.x = nx * kbSpeed;
      this.knockbackVelXZ.z = nz * kbSpeed;
      return { guardBroken: false, hp: this.hp, poise: 0 };
    }

    this.poise = Math.max(0, this.poise - poiseDamage);

    // Mode 3 Heavy Telegraph has super-armor against light flinches (broken only by guard-break or parry!)
    const hasSuperArmor = this.aiState === 'Telegraph_Heavy';
    if (!hasSuperArmor) {
      const kbSpeed = heavy ? 3.2 : 1.6;
      this.knockbackVelXZ.x = nx * kbSpeed;
      this.knockbackVelXZ.z = nz * kbSpeed;
      const side = this.nextFlinchSide;
      this.nextFlinchSide = side === 'L' ? 'R' : 'L';
      this._enterAiState(side === 'L' ? 'Flinch_L' : 'Flinch_R', heavy ? 0.42 : 0.28);
    }

    return { guardBroken: false, hp: this.hp, poise: this.poise };
  }

  applyParryDeflect(info = {}) {
    const counterDmg = Math.max(0, Math.round(info.counterDamage ?? 120));
    const stunSec = info.stunDummySec ?? 1.8;
    const attackerPos = info.attackerPos || { x: 0, z: 0 };

    this.poise = 0;
    this.hp = Math.max(0, this.hp - counterDmg);
    if (this.hp === 0) {
      this.hpRefillDelaySec = 1.25;
    }

    this.hitFlashTimer = 0.14;
    this.poiseRegenDelaySec = stunSec + 1.0;

    const dx = this.worldPos.x - attackerPos.x;
    const dz = this.worldPos.z - attackerPos.z;
    const dist = Math.hypot(dx, dz);
    const nx = dist > 1e-4 ? dx / dist : 0;
    const nz = dist > 1e-4 ? dz / dist : 1;
    this.knockbackVelXZ.x = nx * 3.6;
    this.knockbackVelXZ.z = nz * 3.6;

    this._enterAiState('ParryStun', stunSec);
  }

  /**
   * Advances dummy AI, telegraph rings, knockback physics, and skeletal animation.
   * Returns an enemy attack trigger object `{ type: 'light'|'heavy', attackerPos }` on the exact strike frame, or `null`.
   */
  update(dt, context = {}) {
    const {
      playerWorldPos = { x: 0, y: 0, z: 0 },
      inHitstop = false,
      clothEnabled = true,
    } = context;

    // Decay emissive hit flash even during hit-stop aftermath
    if (this.hitFlashTimer > 0 && !inHitstop) {
      this.hitFlashTimer = Math.max(0, this.hitFlashTimer - dt);
    }
    this.rig.mesh.material.emissiveIntensity =
      this.hitFlashTimer > 0 ? 0.72 * (this.hitFlashTimer / 0.10) : 0.0;

    if (inHitstop || dt <= 1e-7) {
      return null;
    }

    // Refill sparring HP after stagger-break pause so player can practice endlessly
    if (this.hp === 0 && this.hpRefillDelaySec > 0) {
      this.hpRefillDelaySec -= dt;
      if (this.hpRefillDelaySec <= 0) {
        this.hp = this.maxHp;
        if (this.aiState !== 'GuardBreak' && this.aiState !== 'ParryStun') {
          this.poise = this.maxPoise;
        }
      }
    }

    // Poise recovery after untouched window
    if (this.poise < this.maxPoise && this.aiState !== 'GuardBreak' && this.aiState !== 'ParryStun') {
      if (this.poiseRegenDelaySec > 0) {
        this.poiseRegenDelaySec -= dt;
      } else {
        this.poise = Math.min(this.maxPoise, this.poise + 35 * dt);
      }
    }

    const dxToPlayer = playerWorldPos.x - this.worldPos.x;
    const dzToPlayer = playerWorldPos.z - this.worldPos.z;
    const distToPlayer = Math.hypot(dxToPlayer, dzToPlayer);
    const targetYaw = distToPlayer > 1e-4 ? Math.atan2(dxToPlayer, dzToPlayer) : this.yaw;

    let moveVx = 0;
    let moveVz = 0;
    let triggeredAttack = null;

    this.aiStateElapsed += dt;
    const u = Math.min(1, this.aiStateElapsed / this.aiStateDuration);

    if (this.aiState === 'GuardBreak' || this.aiState === 'ParryStun') {
      if (this.aiStateElapsed >= this.aiStateDuration) {
        this.poise = this.maxPoise;
        this.attackCooldownSec = 1.0;
        this._enterAiState('Idle', 1.0);
      }
    } else if (this.aiState === 'Flinch_L' || this.aiState === 'Flinch_R') {
      if (this.aiStateElapsed >= this.aiStateDuration) {
        this._enterAiState('Idle', 1.0);
      }
    } else if (this.aiState === 'Telegraph_Light') {
      const diff = wrapAngleRad(targetYaw - this.yaw);
      this.yaw = wrapAngleRad(this.yaw + diff * (1 - Math.exp(-10 * dt)));
      const fillScale = Math.max(0.05, u);
      this.telegraphFillMesh.scale.set(fillScale, fillScale, 1);
      this.telegraphBorderMat.opacity = 0.78;
      this.telegraphFillMat.opacity = 0.14 + 0.22 * u;

      if (this.aiStateElapsed >= this.aiStateDuration) {
        this._enterAiState('Strike_Light', 0.34);
        if (distToPlayer <= 2.75) {
          triggeredAttack = {
            type: 'light',
            attackerPos: { ...this.worldPos },
            damage: 35,
          };
        }
      }
    } else if (this.aiState === 'Telegraph_Heavy') {
      const diff = wrapAngleRad(targetYaw - this.yaw);
      this.yaw = wrapAngleRad(this.yaw + diff * (1 - Math.exp(-8 * dt)));
      const fillScale = Math.max(0.05, u);
      this.telegraphFillMesh.scale.set(fillScale, fillScale, 1);
      this.telegraphBorderMat.opacity = 0.86;
      this.telegraphFillMat.opacity = 0.16 + 0.28 * u;

      if (this.aiStateElapsed >= this.aiStateDuration) {
        this._enterAiState('Strike_Heavy', 0.44);
        if (distToPlayer <= 3.05) {
          triggeredAttack = {
            type: 'heavy',
            attackerPos: { ...this.worldPos },
            damage: 85,
          };
        }
      }
    } else if (this.aiState === 'Strike_Light' || this.aiState === 'Strike_Heavy') {
      if (this.aiStateElapsed >= this.aiStateDuration) {
        this.attackCooldownSec = this.mode === 3 ? 2.1 : 1.65;
        this._enterAiState('Idle', 1.0);
      }
    } else {
      // Idle or Approach
      const diff = wrapAngleRad(targetYaw - this.yaw);
      this.yaw = wrapAngleRad(this.yaw + diff * (1 - Math.exp(-10 * dt)));

      if (this.mode === 2 || this.mode === 3) {
        const engageRange = this.mode === 3 ? 2.55 : 2.35;
        const stopRange = 1.55;
        if (distToPlayer > engageRange) {
          if (this.aiState !== 'Approach') this._enterAiState('Approach', 0.8);
          const spd = 2.25;
          moveVx = (dxToPlayer / distToPlayer) * spd;
          moveVz = (dzToPlayer / distToPlayer) * spd;
        } else {
          if (this.aiState === 'Approach' && distToPlayer <= stopRange) {
            this._enterAiState('Idle', 1.0);
          } else if (this.aiState === 'Approach') {
            const spd = 1.6;
            moveVx = (dxToPlayer / distToPlayer) * spd;
            moveVz = (dzToPlayer / distToPlayer) * spd;
          }
          this.attackCooldownSec -= dt;
          if (this.attackCooldownSec <= 0) {
            if (this.mode === 2) {
              this._enterAiState('Telegraph_Light', 0.45);
            } else {
              this._enterAiState('Telegraph_Heavy', 0.65);
            }
          }
        }
      } else if (this.aiState !== 'Idle') {
        this._enterAiState('Idle', 1.0);
      }
    }

    // Integrate damped knockback + AI movement
    const damp = Math.exp(-10 * dt);
    this.knockbackVelXZ.x *= damp;
    this.knockbackVelXZ.z *= damp;

    const totalVx = moveVx + this.knockbackVelXZ.x;
    const totalVz = moveVz + this.knockbackVelXZ.z;
    this.worldPos.x += totalVx * dt;
    this.worldPos.z += totalVz * dt;
    this.velXZ.x = totalVx;
    this.velXZ.z = totalVz;

    // Maintain 0.68m capsule separation from player
    const pdx = this.worldPos.x - playerWorldPos.x;
    const pdz = this.worldPos.z - playerWorldPos.z;
    const pDist = Math.hypot(pdx, pdz);
    if (pDist < MIN_DUMMY_SEPARATION && playerWorldPos.y < 1.35) {
      const nx = pDist > 1e-4 ? pdx / pDist : 0;
      const nz = pDist > 1e-4 ? pdz / pDist : 1;
      this.worldPos.x = playerWorldPos.x + nx * MIN_DUMMY_SEPARATION;
      this.worldPos.z = playerWorldPos.z + nz * MIN_DUMMY_SEPARATION;
    }

    // Clamp inside R = 8.15m arena boundary
    const rad = Math.hypot(this.worldPos.x, this.worldPos.z);
    if (rad > ARENA_CLAMP_RADIUS) {
      const s = (ARENA_CLAMP_RADIUS * (1 - 1e-12)) / rad;
      this.worldPos.x *= s;
      this.worldPos.z *= s;
    }

    // Sample & apply animation pose
    this._applyDummyPose(dt, clothEnabled);
    return triggeredAttack;
  }

  _applyDummyPose(dt, clothEnabled) {
    let clipId = 'taibai_01b';
    let normU = (this.aiStateElapsed / this.aiStateDuration) % 1;
    let nonCyclic = false;

    if (this.aiState === 'Approach') {
      clipId = '07_strafe_F';
      nonCyclic = false;
    } else if (this.aiState === 'Flinch_L') {
      clipId = '11_hit_light_L';
      normU = Math.min(1, this.aiStateElapsed / this.aiStateDuration);
      nonCyclic = true;
    } else if (this.aiState === 'Flinch_R') {
      clipId = '12_hit_light_R';
      normU = Math.min(1, this.aiStateElapsed / this.aiStateDuration);
      nonCyclic = true;
    } else if (this.aiState === 'GuardBreak' || this.aiState === 'ParryStun') {
      clipId = '11_hit_light_L';
      // Hold staggered recoil posture then recover near end
      const p = Math.min(1, this.aiStateElapsed / this.aiStateDuration);
      normU = p < 0.7 ? 0.18 + Math.sin(p * 18) * 0.04 : 0.20 + ((p - 0.7) / 0.3) * 0.80;
      nonCyclic = true;
    } else if (this.aiState === 'Telegraph_Light') {
      clipId = '03_sword_combo';
      normU = 0.06 + Math.min(1, this.aiStateElapsed / this.aiStateDuration) * 0.20;
      nonCyclic = true;
    } else if (this.aiState === 'Telegraph_Heavy') {
      clipId = '03_sword_combo';
      normU = 0.02 + Math.min(1, this.aiStateElapsed / this.aiStateDuration) * 0.24;
      nonCyclic = true;
    } else if (this.aiState === 'Strike_Light') {
      clipId = 'combo_1';
      normU = Math.min(1, this.aiStateElapsed / this.aiStateDuration);
      nonCyclic = true;
    } else if (this.aiState === 'Strike_Heavy') {
      clipId = 'combo_3';
      normU = Math.min(1, this.aiStateElapsed / this.aiStateDuration);
      nonCyclic = true;
    }

    const clip = this.clipRegistry ? this.clipRegistry.getClip(clipId) : null;
    if (clip && clip.frames.length > 0) {
      sampleClipNormalized(clip.frames, normU, nonCyclic, this._poseBuf);
      this.rig.bones[BONE_IDX.Hips].position.copy(this._poseBuf.rootPos);
      for (let i = 0; i <= BONE_IDX.RightToe; i++) {
        if (i === BONE_IDX.LeftForeArmTwist || i === BONE_IDX.RightForeArmTwist) continue;
        this.rig.bones[i].quaternion.copy(this._poseBuf.quats[i]);
      }
    }

    this.worldGroup.position.set(this.worldPos.x, this.worldPos.y, this.worldPos.z);
    this.worldGroup.rotation.set(0, this.yaw, 0);

    applyForearmTwistSolver(this.rig.bones, true);

    if (clothEnabled && dt > 1e-6) {
      const localFwd = this.velXZ.x * Math.sin(this.yaw) + this.velXZ.z * Math.cos(this.yaw);
      const synthFwd = localFwd - this.velXZ.z;
      this.clothSolver.update(this.rig.bones, dt, true, synthFwd);
    }

    this.worldGroup.updateMatrixWorld(true);
  }

  getStatusLabel() {
    if (this.aiState === 'Telegraph_Light') {
      const rem = Math.max(0, this.aiStateDuration - this.aiStateElapsed).toFixed(2);
      return `黄圈轻击预警 ${rem}s`;
    }
    if (this.aiState === 'Telegraph_Heavy') {
      const rem = Math.max(0, this.aiStateDuration - this.aiStateElapsed).toFixed(2);
      return `红圈重击预警 ${rem}s`;
    }
    if (this.aiState === 'Strike_Light') return '轻剑斩击中';
    if (this.aiState === 'Strike_Heavy') return '霸体重劈中';
    if (this.aiState === 'ParryStun') return '弹反破招眩晕';
    if (this.aiState === 'GuardBreak') return '破防失衡硬直';
    if (this.aiState === 'Approach') return '逼近追击';
    if (this.mode === 1) return '静置木桩戒备';
    if (this.mode === 2) return '轻击陪练巡弋';
    return '重击陪练蓄势';
  }
}
