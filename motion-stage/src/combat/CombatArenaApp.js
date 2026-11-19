import * as THREE from 'three';
import { buildCharacterRig, BONE_IDX } from '../rig/HumanoidRig.js';
import {
  CombatStateMachine,
  ARENA_RADIUS,
  normalizeActionName,
} from './CombatStateMachine.js';
import { createCombatClipRegistry } from './CombatClipRegistry.js';
import { LayeredAnimator, getBoneLayerWeightsMap } from './LayeredAnimator.js';
import {
  EnemyDummy,
  DUMMY_SPAWN_POS,
  testSweptBladeVsCapsule,
  testSweptSphereVsCapsule,
  SWORD_BLADE_HIT_RADIUS,
  KICK_FOOT_HIT_RADIUS,
} from './EnemyDummy.js';
import { CombatCamera } from './CombatCamera.js';
import { CombatVFX } from './CombatVFX.js';
import { CombatHUD } from './CombatHUD.js';

if (typeof document !== 'undefined') {
  import('./combat.css').catch(() => {});
}

function buildWuxiaMartialArenaEnvironment(scene) {
  const envGroup = new THREE.Group();
  envGroup.name = 'WuxiaMartialTerrace';

  // Atmospheric lights (Three.js 0.187.0 zero-deprecation PCFShadowMap)
  const hemi = new THREE.HemisphereLight(0xd4e2f0, 0x1c222b, 0.98);
  envGroup.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xfff2de, 2.35);
  keyLight.position.set(6.5, 11.5, 5.5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  const shadowSpan = 9.6;
  keyLight.shadow.camera.left = -shadowSpan;
  keyLight.shadow.camera.right = shadowSpan;
  keyLight.shadow.camera.top = shadowSpan;
  keyLight.shadow.camera.bottom = -shadowSpan;
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 30;
  keyLight.shadow.bias = -0.0004;
  keyLight.shadow.radius = 2.2;
  envGroup.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x3ecf8e, 1.05);
  rimLight.position.set(-6.5, 4.2, -6.0);
  envGroup.add(rimLight);

  const brazierFill = new THREE.PointLight(0xe5a93c, 0.9, 16);
  brazierFill.position.set(0, 2.4, 8.6);
  envGroup.add(brazierFill);

  // Main circular basalt stone martial platform (R = 8.5m, top surface y = 0.000m)
  const terraceGeo = new THREE.CylinderGeometry(ARENA_RADIUS, ARENA_RADIUS + 0.35, 0.38, 96);
  const terraceMat = new THREE.MeshStandardMaterial({
    color: 0x171c24,
    roughness: 0.88,
    metalness: 0.08,
  });
  const terraceMesh = new THREE.Mesh(terraceGeo, terraceMat);
  terraceMesh.position.y = -0.19;
  terraceMesh.receiveShadow = true;
  envGroup.add(terraceMesh);

  // Inlaid weathered bronze dueling rings (r = 2.5m & r = 5.4m)
  const bronzeMat = new THREE.MeshStandardMaterial({
    color: 0x473d30,
    roughness: 0.62,
    metalness: 0.36,
    side: THREE.DoubleSide,
  });
  for (const r of [2.5, 5.4]) {
    const ringGeo = new THREE.RingGeometry(r - 0.02, r + 0.02, 96);
    ringGeo.rotateX(-Math.PI * 0.5);
    const ring = new THREE.Mesh(ringGeo, bronzeMat);
    ring.position.y = 0.002;
    ring.receiveShadow = true;
    envGroup.add(ring);
  }

  // 8-direction Bagua stone radial joint strips
  const radialGeo = new THREE.PlaneGeometry(0.022, ARENA_RADIUS * 1.94);
  radialGeo.rotateX(-Math.PI * 0.5);
  const radialMat = new THREE.MeshBasicMaterial({
    color: 0x262f3b,
    transparent: true,
    opacity: 0.72,
  });
  for (let i = 0; i < 4; i++) {
    const strip = new THREE.Mesh(radialGeo, radialMat);
    strip.position.y = 0.0015;
    strip.rotation.y = (i * Math.PI) / 4;
    envGroup.add(strip);
  }

  // Luminous celadon-jade boundary ring at R = 8.42..8.50m + carved stone curb
  const boundaryRingGeo = new THREE.RingGeometry(ARENA_RADIUS - 0.08, ARENA_RADIUS, 128);
  boundaryRingGeo.rotateX(-Math.PI * 0.5);
  const boundaryRingMat = new THREE.MeshStandardMaterial({
    color: 0x3ecf8e,
    emissive: 0x18583d,
    emissiveIntensity: 0.55,
    roughness: 0.35,
    side: THREE.DoubleSide,
  });
  const boundaryRing = new THREE.Mesh(boundaryRingGeo, boundaryRingMat);
  boundaryRing.position.y = 0.003;
  envGroup.add(boundaryRing);

  const curbGeo = new THREE.TorusGeometry(ARENA_RADIUS + 0.02, 0.055, 10, 128);
  curbGeo.rotateX(Math.PI * 0.5);
  const curbMat = new THREE.MeshStandardMaterial({
    color: 0x262d38,
    roughness: 0.76,
    metalness: 0.16,
  });
  const curbMesh = new THREE.Mesh(curbGeo, curbMat);
  curbMesh.position.y = 0.03;
  curbMesh.receiveShadow = true;
  envGroup.add(curbMesh);

  // 8 perimeter martial boundary pillars with warm ink-gold ember caps
  const pillarGeo = new THREE.CylinderGeometry(0.085, 0.11, 0.74, 8);
  const pillarMat = new THREE.MeshStandardMaterial({
    color: 0x232a34,
    roughness: 0.72,
    metalness: 0.18,
  });
  const capGeo = new THREE.SphereGeometry(0.058, 12, 12);
  const capMat = new THREE.MeshStandardMaterial({
    color: 0xe5a93c,
    emissive: 0xd98a1e,
    emissiveIntensity: 0.85,
    roughness: 0.3,
  });
  for (let i = 0; i < 8; i++) {
    const ang = (i * Math.PI) / 4;
    const px = Math.sin(ang) * (ARENA_RADIUS + 0.14);
    const pz = Math.cos(ang) * (ARENA_RADIUS + 0.14);
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(px, 0.37, pz);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.set(px, 0.78, pz);
    envGroup.add(pillar, cap);
  }

  scene.add(envGroup);
  return envGroup;
}

/**
 * Creates a standalone or embedded Wuxia Action Roguelike 3D Combat Arena (`F11c`).
 * Exposes `{ mount, setActive, step, dispatchAction, getState, destroy }` and registers `window.__COMBAT_ARENA__`.
 */
export function createCombatArena(containerEl = null, options = {}) {
  const embedded = Boolean(options.embedded);
  const autoActive = options.autoActive !== false;
  const exposeGlobal = options.exposeGlobal !== false;
  const headless = Boolean(options.headless || !containerEl || typeof document === 'undefined');

  // 1. Synchronous ClipRegistry bootstrap (all 26 canonical + 4 sub-clips immediately ready)
  const clipRegistry = options.clipRegistry || createCombatClipRegistry();

  // 2. Three.js Scene, Player Rig (`'prod'` skinning!), LayeredAnimator, EnemyDummy, Camera, VFX
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.FogExp2(0x0d1117, 0.030);
  buildWuxiaMartialArenaEnvironment(scene);

  const playerRig = buildCharacterRig();
  playerRig.setSkinningVisualState('prod', false);
  const playerWorldGroup = new THREE.Group();
  playerWorldGroup.name = 'PlayerWorldGroup';
  playerWorldGroup.add(playerRig.rootGroup);
  scene.add(playerWorldGroup);

  const layeredAnimator = new LayeredAnimator(playerRig, playerWorldGroup, clipRegistry);

  const dummy = new EnemyDummy(clipRegistry, {
    initialMode: options.initialDummyMode ?? 1,
    x: DUMMY_SPAWN_POS.x,
    y: DUMMY_SPAWN_POS.y,
    z: DUMMY_SPAWN_POS.z,
  });
  scene.add(dummy.worldGroup);

  const fsm = new CombatStateMachine({
    dummyWorldPos: dummy.worldPos,
    initialLockOn: options.initialLockOn ?? true,
  });

  const initWidth =
    !headless && containerEl
      ? Math.max(1, containerEl.clientWidth || window.innerWidth || 1280)
      : 1280;
  const initHeight =
    !headless && containerEl
      ? Math.max(1, containerEl.clientHeight || window.innerHeight || 720)
      : 720;

  const combatCamera = new CombatCamera(initWidth, initHeight);
  fsm.setCameraYaw(combatCamera.getPlanarForwardYaw());

  const vfx = new CombatVFX(scene);

  // World-space anchor scratchpads for swept hitbox evaluation
  const { baseAnchor: swordBaseAnchor, tipAnchor: swordTipAnchor } = playerRig.swordGroup.userData;
  const _currBase = new THREE.Vector3();
  const _currTip = new THREE.Vector3();
  const _prevBase = new THREE.Vector3();
  const _prevTip = new THREE.Vector3();
  const _currFootR = new THREE.Vector3();
  const _prevFootR = new THREE.Vector3();
  const _currFootL = new THREE.Vector3();
  const _prevFootL = new THREE.Vector3();
  const _dummyChestPos = new THREE.Vector3();
  let hasPrevAnchors = false;

  const hitSwingRegistry = new Set();
  let lastStateInstanceId = fsm.stateInstanceId;

  let simTimeSec = 0;
  let comboCount = 0;
  let comboIdleSec = 0;
  let bannerText = '';
  let bannerTimerSec = 0;

  let isMounted = false;
  let isActive = false;
  let isDestroyed = false;
  let rafId = 0;
  let lastRafMs = 0;

  // DOM & WebGL handles (created in browser mode)
  let rootEl = null;
  let canvasWrapEl = null;
  let renderer = null;
  let hud = null;
  let resizeObserver = null;
  const pointerAbortCtrl = new AbortController();
  let windowListenersAttached = false;

  // Dual-source movement axes (`domMoveAxes` from keyboard vs `programmaticMoveAxes` from `dispatchAction('Move')`)
  const heldKeys = new Set();
  const domMoveAxes = { x: 0, z: 0 };
  let programmaticMoveAxes = null;

  function setBanner(text, durationSec = 1.35) {
    bannerText = text;
    bannerTimerSec = durationSec;
  }

  function syncPlayerAndDummyPosesInitial() {
    const st = fsm.getState();
    const ld = fsm.getLayerDescriptor();
    layeredAnimator.evaluate(1 / 60, {
      ...ld,
      worldPos: st.playerWorldPos,
      playerYaw: st.playerYaw,
      worldVelXZ: st.playerVelXZ,
      inHitstop: false,
      simTimeSec: 0,
    });
    dummy.update(1 / 60, { playerWorldPos: st.playerWorldPos, inHitstop: false });
    swordBaseAnchor.getWorldPosition(_prevBase);
    swordTipAnchor.getWorldPosition(_prevTip);
    playerRig.bones[BONE_IDX.RightToe].getWorldPosition(_prevFootR);
    playerRig.bones[BONE_IDX.LeftToe].getWorldPosition(_prevFootL);
    hasPrevAnchors = true;
    combatCamera.snapImmediate(st.playerWorldPos, dummy.worldPos, st.isLockedOn);
  }

  syncPlayerAndDummyPosesInitial();

  function recomputeDomMoveAxes() {
    let x = 0;
    let z = 0;
    if (heldKeys.has('KeyD') || heldKeys.has('ArrowRight')) x += 1;
    if (heldKeys.has('KeyA') || heldKeys.has('ArrowLeft')) x -= 1;
    if (heldKeys.has('KeyW') || heldKeys.has('ArrowUp')) z += 1;
    if (heldKeys.has('KeyS') || heldKeys.has('ArrowDown')) z -= 1;
    domMoveAxes.x = x;
    domMoveAxes.z = z;
    programmaticMoveAxes = null;
    fsm.setCameraYaw(combatCamera.getPlanarForwardYaw());
    fsm.setMoveInput(x === 0 && z === 0 ? null : { x, z });
  }

  function syncViewportSize() {
    if (!renderer || !rootEl) return;
    const w = Math.max(1, rootEl.clientWidth || containerEl?.clientWidth || window.innerWidth || 1280);
    const h = Math.max(1, rootEl.clientHeight || containerEl?.clientHeight || window.innerHeight || 720);
    combatCamera.setAspect(w, h);
    renderer.setSize(w, h, false);
  }

  function updateHudFromCurrentState() {
    if (!hud) return;
    const fsmState = fsm.getState();
    hud.update({
      ...fsmState,
      upperLayerAlpha: layeredAnimator.upperLayerAlpha,
      dummyMode: dummy.mode,
      dummyHp: dummy.hp,
      dummyMaxHp: dummy.maxHp,
      dummyPoise: dummy.poise,
      dummyMaxPoise: dummy.maxPoise,
      dummyAiLabel: dummy.getStatusLabel(),
      comboCount,
      bannerText: bannerTimerSec > 0 ? bannerText : '',
    });
  }

  function stepSingleSubTick(h) {
    simTimeSec += h;

    if (bannerTimerSec > 0) {
      bannerTimerSec = Math.max(0, bannerTimerSec - h);
    }

    const activeMove = programmaticMoveAxes ?? domMoveAxes;
    fsm.setCameraYaw(combatCamera.getPlanarForwardYaw());
    fsm.setDummyPosition(dummy.worldPos);
    if (Math.abs(activeMove.x) > 1e-4 || Math.abs(activeMove.z) > 1e-4) {
      fsm.setMoveInput(activeMove);
    } else if (fsm.hasMoveInput) {
      fsm.setMoveInput(null);
    }

    const wasInHitstop = fsm.hitstopRemainingMs > 0;

    // 1. Step deterministic FSM
    const fsmSnapshot = fsm.step(h, {
      sampleClipRootDelta: (clipId, u0, u1) => clipRegistry.sampleClipRootDelta(clipId, u0, u1),
    });

    if (fsm.stateInstanceId !== lastStateInstanceId) {
      hitSwingRegistry.clear();
      lastStateInstanceId = fsm.stateInstanceId;
    }

    const inHitstopNow = fsmSnapshot.hitstopRemainingMs > 0;

    if (!inHitstopNow && comboCount > 0) {
      comboIdleSec += h;
      if (comboIdleSec >= 2.8) {
        comboCount = 0;
        comboIdleSec = 0;
      }
    }

    // 2. Handle FSM discrete events (double-jump wind ring, kip-up, stagger breakout)
    const fsmEvents = fsm.consumeEvents();
    for (const ev of fsmEvents) {
      if (ev.type === 'double_jump_ring') {
        vfx.spawnShockwaveRing(ev.pos, { colorHex: 0x3ecf8e, maxRadius: 1.45, durationSec: 0.28 });
      } else if (ev.type === 'kip_up_recovery') {
        vfx.spawnShockwaveRing(fsmSnapshot.playerWorldPos, {
          colorHex: 0x3ecf8e,
          maxRadius: 1.75,
          durationSec: 0.30,
        });
        setBanner('鲤鱼打挺 · 无敌起身!', 1.2);
      } else if (ev.type === 'stagger_breakout') {
        vfx.spawnShockwaveRing(fsmSnapshot.playerWorldPos, {
          colorHex: 0xe5a93c,
          maxRadius: 1.9,
          durationSec: 0.30,
        });
        setBanner('燕回朝阳 · 受身解控!', 1.25);
      }
    }

    // 3. Evaluate 21-bone LayeredAnimator + ForeArmTwist + 360° SpringClothSolver
    const layerDesc = fsm.getLayerDescriptor();
    layeredAnimator.evaluate(h, {
      ...layerDesc,
      worldPos: fsmSnapshot.playerWorldPos,
      playerYaw: fsmSnapshot.playerYaw,
      worldVelXZ: fsmSnapshot.playerVelXZ,
      inHitstop: inHitstopNow || wasInHitstop,
      simTimeSec,
    });
    // Sync actual animator upperLayerAlpha back onto FSM for single-truth telemetry
    fsm.upperLayerAlpha = layeredAnimator.upperLayerAlpha;

    // 4. Advance EnemyDummy AI & resolve any enemy strike against player Parry / I-Frames
    const dummyStrike = dummy.update(h, {
      playerWorldPos: fsmSnapshot.playerWorldPos,
      inHitstop: inHitstopNow || wasInHitstop,
    });
    fsm.setDummyPosition(dummy.worldPos);

    if (dummyStrike) {
      const defRes = fsm.receiveEnemyAttack(dummyStrike);
      const defEvents = fsm.consumeEvents();
      for (const dev of defEvents) {
        if (dev.type === 'parry_deflect') {
          dummy.applyParryDeflect({
            counterDamage: dev.counterDamage,
            stunDummySec: dev.stunDummySec,
            attackerPos: fsmSnapshot.playerWorldPos,
          });
          comboCount += 1;
          comboIdleSec = 0;
          vfx.spawnHitSparks(
            { x: dummy.worldPos.x, y: 1.25, z: dummy.worldPos.z },
            { count: 16, golden: true, heavy: true }
          );
          vfx.spawnShockwaveRing(fsmSnapshot.playerWorldPos, {
            colorHex: 0xf2b84b,
            maxRadius: 2.6,
            durationSec: 0.34,
          });
          combatCamera.addShake(0.11, 0.16);
          setBanner('无痕剑意 · 弹反破招!', 1.5);
        } else if (dev.type === 'evaded') {
          setBanner('身法闪避 · 无敌帧!', 1.0);
        } else if (dev.type === 'player_hit') {
          combatCamera.addShake(dev.hitState === 'Hit_Knockdown' ? 0.10 : 0.05, 0.14);
          setBanner(dev.hitState === 'Hit_Knockdown' ? '受击击飞 · 按 Space 鲤鱼打挺!' : '受击硬直 · 按 V 燕回解控', 1.4);
        }
      }
    }

    // 5. Sample world weapon & foot anchors and evaluate swept collision against EnemyDummy capsule
    swordBaseAnchor.getWorldPosition(_currBase);
    swordTipAnchor.getWorldPosition(_currTip);
    playerRig.bones[BONE_IDX.RightToe].getWorldPosition(_currFootR);
    playerRig.bones[BONE_IDX.LeftToe].getWorldPosition(_currFootL);

    const activeHitWin = fsm.getActiveHitWindow();
    if (activeHitWin && !hitSwingRegistry.has(activeHitWin.swingKey) && !inHitstopNow) {
      let hitConfirmed = false;
      let contactPoint = null;

      if (activeHitWin.type === 'sword' || activeHitWin.type === 'both') {
        const res = testSweptBladeVsCapsule(
          hasPrevAnchors ? _prevBase : null,
          hasPrevAnchors ? _prevTip : null,
          _currBase,
          _currTip,
          dummy.worldPos,
          undefined,
          SWORD_BLADE_HIT_RADIUS,
          4
        );
        if (res.hit) {
          hitConfirmed = true;
          contactPoint = res.hitPoint;
        }
      }

      if (!hitConfirmed && (activeHitWin.type === 'kick' || activeHitWin.type === 'both')) {
        const resR = testSweptSphereVsCapsule(
          hasPrevAnchors ? _prevFootR : null,
          _currFootR,
          KICK_FOOT_HIT_RADIUS,
          dummy.worldPos
        );
        const resL =
          activeHitWin.type === 'both'
            ? testSweptSphereVsCapsule(
                hasPrevAnchors ? _prevFootL : null,
                _currFootL,
                KICK_FOOT_HIT_RADIUS,
                dummy.worldPos
              )
            : { hit: false };
        if (resR.hit || resL.hit) {
          hitConfirmed = true;
          contactPoint = resR.hit ? resR.hitPoint : resL.hitPoint;
        }
      }

      if (!hitConfirmed && activeHitWin.type === 'aoe') {
        const d = Math.hypot(
          dummy.worldPos.x - fsmSnapshot.playerWorldPos.x,
          dummy.worldPos.z - fsmSnapshot.playerWorldPos.z
        );
        if (d <= activeHitWin.aoeRadius) {
          hitConfirmed = true;
          contactPoint = new THREE.Vector3(dummy.worldPos.x, 0.9, dummy.worldPos.z);
          vfx.spawnShockwaveRing(fsmSnapshot.playerWorldPos, {
            colorHex: 0x3ecf8e,
            maxRadius: 3.1,
            durationSec: 0.36,
          });
        }
      }

      if (hitConfirmed) {
        hitSwingRegistry.add(activeHitWin.swingKey);
        const hitRes = dummy.receivePlayerHit({
          damage: activeHitWin.damage,
          poiseDamage: activeHitWin.poiseDamage,
          guardBreak: activeHitWin.guardBreak,
          heavy: activeHitWin.heavy,
          attackerPos: fsmSnapshot.playerWorldPos,
        });
        fsm.triggerHitstop(activeHitWin.hitstopMs);
        comboCount += 1;
        comboIdleSec = 0;

        vfx.spawnHitSparks(contactPoint || _currTip, {
          count: activeHitWin.heavy || activeHitWin.guardBreak ? 14 : 8,
          golden: fsm.wuhenBuffRemainingMs > 0 || activeHitWin.heavy,
          heavy: activeHitWin.heavy,
        });

        if (hitRes.guardBroken) {
          vfx.spawnShockwaveRing(dummy.worldPos, {
            colorHex: 0xe5a93c,
            maxRadius: 2.2,
            durationSec: 0.32,
          });
          combatCamera.addShake(0.09, 0.14);
          setBanner(activeHitWin.guardBreak ? '正蹬破防 · 定力击碎!' : '剑势破防 · 定力击碎!', 1.35);
        } else if (activeHitWin.heavy) {
          combatCamera.addShake(0.075, 0.12);
        } else {
          combatCamera.addShake(0.03, 0.07);
        }
      }
    }

    _prevBase.copy(_currBase);
    _prevTip.copy(_currTip);
    _prevFootR.copy(_currFootR);
    _prevFootL.copy(_currFootL);
    hasPrevAnchors = true;

    // 6. Update Camera & VFX
    dummy.rig.bones[BONE_IDX.Chest].getWorldPosition(_dummyChestPos);
    const trailActive =
      Boolean(activeHitWin) ||
      fsm.currentState.startsWith('Attack_Combo') ||
      fsm.currentState === 'Dodge_Dash' ||
      fsm.currentState === 'Skill_Wuhen' ||
      fsm.currentState === 'Skill_Yuluo' ||
      fsm.currentState === 'Skill_Feiyan';

    combatCamera.update(h, fsm.playerWorldPos, dummy.worldPos, fsm.isLockedOn);
    vfx.update(h, {
      baseWorldPos: _currBase,
      tipWorldPos: _currTip,
      trailActive,
      goldenQi:
        fsm.wuhenBuffRemainingMs > 0 ||
        fsm.currentState === 'Attack_Combo_3' ||
        fsm.currentState === 'Skill_Wuhen',
      inHitstop: fsm.hitstopRemainingMs > 0,
      isLockedOn: fsm.isLockedOn,
      dummyChestWorldPos: _dummyChestPos,
      camera: combatCamera.camera,
    });
  }

  /**
   * Advances simulation deterministically by `dt` seconds (sub-stepping large `dt` into `<= 1/60s` ticks).
   */
  function step(dt) {
    if (isDestroyed || !Number.isFinite(dt) || dt <= 0) {
      return getState();
    }

    const maxStep = 1 / 60;
    const subSteps = Math.max(1, Math.ceil(dt / maxStep));
    const h = dt / subSteps;

    for (let i = 0; i < subSteps; i++) {
      stepSingleSubTick(h);
    }

    updateHudFromCurrentState();
    if (renderer) {
      renderer.render(scene, combatCamera.camera);
    }
    return getState();
  }

  /**
   * Dispatches any combat action, movement intent, lock-on toggle, or sparring dummy command.
   */
  function dispatchAction(action, payload = undefined) {
    if (isDestroyed || typeof action !== 'string') return getState();
    const rawTrimmed = action.trim();
    const lowerCompact = rawTrimmed.toLowerCase().replace(/[\s_-]+/g, '');

    if (lowerCompact === 'setdummymode' || lowerCompact === 'dummymode') {
      const m = typeof payload === 'object' && payload !== null ? payload.mode : payload;
      dummy.setMode(m);
      setBanner(
        dummy.mode === 1
          ? '陪练切换 · 静置木桩'
          : dummy.mode === 2
            ? '陪练切换 · 轻击反击 AI'
            : '陪练切换 · 重击击飞 AI',
        1.1
      );
      updateHudFromCurrentState();
      return getState();
    }

    if (lowerCompact === 'triggerdummyattack' || lowerCompact === 'dummyattack') {
      const t =
        typeof payload === 'string'
          ? payload
          : typeof payload === 'object' && payload !== null
            ? payload.type
            : null;
      dummy.triggerImmediateTelegraph(t);
      updateHudFromCurrentState();
      return getState();
    }

    if (lowerCompact === 'resetarena' || lowerCompact === 'reset') {
      programmaticMoveAxes = null;
      domMoveAxes.x = 0;
      domMoveAxes.z = 0;
      heldKeys.clear();
      fsm.reset({ x: 0, y: 0, z: 0, yaw: 0 });
      dummy.reset(DUMMY_SPAWN_POS);
      fsm.setDummyPosition(dummy.worldPos);
      layeredAnimator.reset();
      vfx.reset();
      comboCount = 0;
      comboIdleSec = 0;
      bannerText = '';
      bannerTimerSec = 0;
      hitSwingRegistry.clear();
      syncPlayerAndDummyPosesInitial();
      updateHudFromCurrentState();
      if (renderer) renderer.render(scene, combatCamera.camera);
      return getState();
    }

    const norm = normalizeActionName(rawTrimmed);
    if (norm === 'Move') {
      if (!payload) {
        programmaticMoveAxes = null;
        domMoveAxes.x = 0;
        domMoveAxes.z = 0;
        fsm.setMoveInput(null);
      } else {
        const rx = payload.right !== undefined ? Number(payload.right) : Number(payload.x ?? 0);
        const rz =
          payload.forward !== undefined
            ? Number(payload.forward)
            : payload.z !== undefined
              ? Number(payload.z)
              : Number(payload.y ?? 0);
        let x = Number.isFinite(rx) ? rx : 0;
        let z = Number.isFinite(rz) ? rz : 0;
        const mag = Math.hypot(x, z);
        if (mag < 1e-4) {
          programmaticMoveAxes = null;
          domMoveAxes.x = 0;
          domMoveAxes.z = 0;
          fsm.setMoveInput(null);
        } else {
          if (mag > 1) {
            x /= mag;
            z /= mag;
          }
          programmaticMoveAxes = { x, z };
          fsm.setCameraYaw(combatCamera.getPlanarForwardYaw());
          fsm.setMoveInput(programmaticMoveAxes);
        }
      }
      updateHudFromCurrentState();
      return getState();
    }

    if (norm === 'StopMove') {
      programmaticMoveAxes = null;
      domMoveAxes.x = 0;
      domMoveAxes.z = 0;
      fsm.setMoveInput(null);
      updateHudFromCurrentState();
      return getState();
    }

    fsm.setCameraYaw(combatCamera.getPlanarForwardYaw());
    fsm.setDummyPosition(dummy.worldPos);
    fsm.dispatchAction(rawTrimmed, payload);
    updateHudFromCurrentState();
    return getState();
  }

  /**
   * Returns all 20 exact plain JSON-serializable state keys defined in PROJECT.md § Contract 4.
   */
  function getState() {
    const s = fsm.getState();
    return {
      active: Boolean(isActive),
      currentState: s.currentState,
      stateNormalizedTime: Number(s.stateNormalizedTime),
      priority: Number(s.priority),
      isInvulnerable: Boolean(s.isInvulnerable),
      inParryWindow: Boolean(s.inParryWindow),
      canComboChain: Boolean(s.canComboChain),
      baseClipId: String(s.baseClipId),
      upperClipId: s.upperClipId ? String(s.upperClipId) : null,
      upperLayerAlpha: Number(layeredAnimator.upperLayerAlpha),
      boneLayerWeights: getBoneLayerWeightsMap(),
      playerWorldPos: {
        x: Number(s.playerWorldPos.x),
        y: Number(s.playerWorldPos.y),
        z: Number(s.playerWorldPos.z),
      },
      playerYaw: Number(s.playerYaw),
      isLockedOn: Boolean(s.isLockedOn),
      dummyMode: dummy.mode,
      dummyHp: Number(dummy.hp),
      dummyPoise: Number(dummy.poise),
      comboCount: Number(comboCount),
      hitstopRemainingMs: Number(s.hitstopRemainingMs),
      loadedClipIds: clipRegistry.getLoadedClipIds(),
    };
  }

  // Window Keyboard Listeners (attached ONLY when `isActive === true`)
  function onKeyDown(e) {
    if (!isActive || isDestroyed) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) {
      return;
    }

    const code = e.code;
    if (code === 'Tab') {
      e.preventDefault();
      if (!e.repeat) dispatchAction('ToggleLockOn');
      return;
    }
    if (code === 'Space') {
      e.preventDefault();
      if (!e.repeat) dispatchAction('Jump');
      return;
    }

    if (
      code === 'KeyW' ||
      code === 'KeyA' ||
      code === 'KeyS' ||
      code === 'KeyD' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    ) {
      if (!heldKeys.has(code)) {
        heldKeys.add(code);
        recomputeDomMoveAxes();
      }
      return;
    }

    if (e.repeat) return;

    switch (code) {
      case 'KeyJ':
        dispatchAction('Attack');
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        dispatchAction('Dodge_Dash');
        break;
      case 'KeyC':
        dispatchAction('Dodge_Roll');
        break;
      case 'KeyV':
        dispatchAction('Evade_Backflip');
        break;
      case 'KeyQ':
        dispatchAction('Skill_Wuhen');
        break;
      case 'KeyE':
        dispatchAction('Skill_Yuluo');
        break;
      case 'KeyR':
        dispatchAction('Skill_Feiyan');
        break;
      case 'KeyF':
      case 'KeyK':
        dispatchAction('Skill_Kick', { variant: e.altKey ? 'spin' : 'front' });
        break;
      case 'Digit1':
        dispatchAction('SetDummyMode', 1);
        break;
      case 'Digit2':
        dispatchAction('SetDummyMode', 2);
        break;
      case 'Digit3':
        dispatchAction('SetDummyMode', 3);
        break;
      default:
        break;
    }
  }

  function onKeyUp(e) {
    if (!isActive) return;
    if (heldKeys.delete(e.code)) {
      recomputeDomMoveAxes();
    }
  }

  function onWindowBlur() {
    if (heldKeys.size > 0) {
      heldKeys.clear();
      recomputeDomMoveAxes();
    }
  }

  function attachWindowListeners() {
    if (headless || windowListenersAttached || typeof window === 'undefined') return;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);
    windowListenersAttached = true;
  }

  function detachWindowListeners() {
    if (!windowListenersAttached || typeof window === 'undefined') return;
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onWindowBlur);
    windowListenersAttached = false;
  }

  function onAnimationFrame(nowMs) {
    if (!isActive || isDestroyed) {
      rafId = 0;
      return;
    }
    const rawDt = lastRafMs > 0 ? (nowMs - lastRafMs) / 1000 : 1 / 60;
    lastRafMs = nowMs;
    const clampedDt = Math.min(Math.max(rawDt, 0.001), 0.05);
    step(clampedDt);
    rafId = requestAnimationFrame(onAnimationFrame);
  }

  function setActive(nextActive) {
    if (isDestroyed) return;
    const target = Boolean(nextActive);
    if (target === isActive) {
      if (target && rootEl) {
        rootEl.hidden = false;
        syncViewportSize();
      }
      return;
    }

    isActive = target;
    if (!target) {
      if (rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (rootEl) {
        rootEl.hidden = true;
      }
      heldKeys.clear();
      domMoveAxes.x = 0;
      domMoveAxes.z = 0;
      programmaticMoveAxes = null;
      fsm.setMoveInput(null);
      detachWindowListeners();
    } else {
      if (rootEl) {
        rootEl.hidden = false;
      }
      attachWindowListeners();
      syncViewportSize();
      updateHudFromCurrentState();
      if (renderer) {
        renderer.render(scene, combatCamera.camera);
      }
      if (!headless && typeof requestAnimationFrame === 'function') {
        lastRafMs = performance.now();
        rafId = requestAnimationFrame(onAnimationFrame);
      }
    }
  }

  function initDomAndRenderer() {
    if (headless || rootEl) return;

    rootEl = document.createElement('div');
    rootEl.className = embedded
      ? 'combat-arena-root combat-arena-root--embedded'
      : 'combat-arena-root';
    rootEl.dataset.embedded = String(embedded);
    rootEl.hidden = !autoActive;

    canvasWrapEl = document.createElement('div');
    canvasWrapEl.id = 'combat-canvas-wrap';
    canvasWrapEl.className = 'combat-canvas-wrap';
    rootEl.appendChild(canvasWrapEl);

    hud = new CombatHUD(
      rootEl,
      { onDispatch: (act, payload) => dispatchAction(act, payload) },
      { embedded }
    );

    containerEl.appendChild(rootEl);

    const w = Math.max(1, containerEl.clientWidth || window.innerWidth || 1280);
    const h = Math.max(1, containerEl.clientHeight || window.innerHeight || 720);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // Zero Three.js r183+ deprecation warning!
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    canvasWrapEl.appendChild(renderer.domElement);

    // Pointer camera orbit + left-click attack / right-click dash / middle-click lock-on
    const sig = { signal: pointerAbortCtrl.signal };
    let pointerDown = false;
    let pointerBtn = 0;
    let downX = 0;
    let downY = 0;
    let lastX = 0;
    let lastY = 0;
    let dragDist = 0;

    renderer.domElement.addEventListener(
      'contextmenu',
      (e) => {
        e.preventDefault();
      },
      sig
    );

    renderer.domElement.addEventListener(
      'pointerdown',
      (e) => {
        if (!isActive) return;
        if (e.button === 1) {
          e.preventDefault();
          dispatchAction('ToggleLockOn');
          return;
        }
        pointerDown = true;
        pointerBtn = e.button;
        downX = e.clientX;
        downY = e.clientY;
        lastX = e.clientX;
        lastY = e.clientY;
        dragDist = 0;
      },
      sig
    );

    window.addEventListener(
      'pointermove',
      (e) => {
        if (!pointerDown || !isActive) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        dragDist += Math.hypot(dx, dy);
        if (dragDist > 4) {
          combatCamera.rotateOrbit(dx * 0.0055, dy * 0.0042);
        }
      },
      sig
    );

    window.addEventListener(
      'pointerup',
      (e) => {
        if (!pointerDown) return;
        pointerDown = false;
        const totalMove = Math.hypot(e.clientX - downX, e.clientY - downY);
        if (isActive && dragDist <= 6 && totalMove <= 6) {
          if (pointerBtn === 0) {
            dispatchAction('Attack');
          } else if (pointerBtn === 2) {
            dispatchAction('Dodge_Dash');
          }
        }
      },
      sig
    );

    renderer.domElement.addEventListener(
      'wheel',
      (e) => {
        if (!isActive) return;
        combatCamera.zoom(e.deltaY * 0.003);
      },
      { passive: true, signal: pointerAbortCtrl.signal }
    );

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (isActive) syncViewportSize();
      });
      resizeObserver.observe(rootEl);
    }
    window.addEventListener(
      'resize',
      () => {
        if (isActive) syncViewportSize();
      },
      sig
    );
  }

  async function mount() {
    if (isDestroyed) return api;
    if (!isMounted) {
      initDomAndRenderer();
      isMounted = true;
    }

    await clipRegistry.loadAll(options.clipLoaderOptions || {});

    // Re-evaluate initial frame with upgraded `bvh_library` clips
    syncPlayerAndDummyPosesInitial();
    updateHudFromCurrentState();

    // Honor optional URL query `?dummy=1|2|3` on standalone `/combat.html`
    if (!embedded && typeof window !== 'undefined' && window.location?.search) {
      const params = new URLSearchParams(window.location.search);
      const qDummy = Number(params.get('dummy'));
      if (qDummy === 1 || qDummy === 2 || qDummy === 3) {
        dummy.setMode(qDummy);
        updateHudFromCurrentState();
      }
    }

    setActive(autoActive);
    if (renderer && !isActive) {
      renderer.render(scene, combatCamera.camera);
    }
    return api;
  }

  function destroy() {
    if (isDestroyed) return;
    setActive(false);
    isDestroyed = true;

    resizeObserver?.disconnect();
    resizeObserver = null;
    pointerAbortCtrl.abort();
    hud?.destroy();
    hud = null;

    scene.traverse((obj) => {
      if (obj.geometry && typeof obj.geometry.dispose === 'function') {
        obj.geometry.dispose();
      }
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.map && typeof m.map.dispose === 'function') m.map.dispose();
          if (typeof m.dispose === 'function') m.dispose();
        }
      }
    });

    if (renderer) {
      renderer.renderLists?.dispose?.();
      renderer.dispose();
      renderer = null;
    }

    if (rootEl) {
      rootEl.remove();
      rootEl = null;
    }

    if (typeof window !== 'undefined' && window.__COMBAT_ARENA__ === api) {
      delete window.__COMBAT_ARENA__;
    }
  }

  const api = {
    mount,
    setActive,
    step,
    dispatchAction,
    getState,
    destroy,
  };

  if (exposeGlobal && typeof window !== 'undefined') {
    window.__COMBAT_ARENA__ = api;
  }

  return api;
}
