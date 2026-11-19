import * as THREE from 'three';

const TRAIL_STEPS = 18;
const SPARK_POOL_SIZE = 24;
const RING_POOL_SIZE = 6;

const COLOR_JADE_TIP = new THREE.Color(0x3ecf8e);
const COLOR_JADE_BASE = new THREE.Color(0x186848);
const COLOR_GOLD_TIP = new THREE.Color(0xf2b84b);
const COLOR_GOLD_BASE = new THREE.Color(0xb86d19);

export class CombatVFX {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'CombatVFXRoot';
    this.scene.add(this.root);

    // 1. Sword Qi Ribbon Trail (`TRAIL_STEPS = 18`)
    const vertCount = TRAIL_STEPS * 2;
    this.trailPositions = new Float32Array(vertCount * 3);
    this.trailColors = new Float32Array(vertCount * 3);
    const indices = [];
    for (let i = 0; i < TRAIL_STEPS - 1; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }

    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    trailGeo.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 3));
    trailGeo.setIndex(indices);

    this.trailMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.trailMesh = new THREE.Mesh(trailGeo, this.trailMat);
    this.trailMesh.frustumCulled = false;
    this.root.add(this.trailMesh);

    this.trailHistoryBase = Array.from({ length: TRAIL_STEPS }, () => new THREE.Vector3());
    this.trailHistoryTip = Array.from({ length: TRAIL_STEPS }, () => new THREE.Vector3());
    this.trailInitialized = false;
    this.trailOpacity = 0;

    // 2. Pre-allocated Impact Spark Burst Pool (zero runtime allocations)
    this.sparkGeo = new THREE.BoxGeometry(0.016, 0.016, 0.18);
    this.sparks = [];
    for (let i = 0; i < SPARK_POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffdf91,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.sparkGeo, mat);
      mesh.visible = false;
      this.root.add(mesh);
      this.sparks.push({
        mesh,
        mat,
        vel: new THREE.Vector3(),
        age: 0,
        maxAge: 0.22,
        active: false,
      });
    }
    this._sparkCursor = 0;
    this._sparkSeed = 1;

    // 3. Pre-allocated Shockwave & Wind Rings
    this.ringGeo = new THREE.RingGeometry(0.24, 0.42, 48);
    this.ringGeo.rotateX(-Math.PI * 0.5);
    this.rings = [];
    for (let i = 0; i < RING_POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x3ecf8e,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.visible = false;
      this.root.add(mesh);
      this.rings.push({
        mesh,
        mat,
        age: 0,
        maxAge: 0.34,
        maxRadius: 2.4,
        active: false,
      });
    }
    this._ringCursor = 0;

    // 4. Crisp 3D Lock-On Diamond Reticle
    this.lockReticleGroup = new THREE.Group();
    const diamondGeo = new THREE.RingGeometry(0.11, 0.145, 4);
    this.lockDiamondMat = new THREE.MeshBasicMaterial({
      color: 0x3ecf8e,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.lockDiamondMesh = new THREE.Mesh(diamondGeo, this.lockDiamondMat);

    const outerLockGeo = new THREE.RingGeometry(0.18, 0.198, 32);
    this.lockOuterMat = new THREE.MeshBasicMaterial({
      color: 0xe5a93c,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.lockOuterMesh = new THREE.Mesh(outerLockGeo, this.lockOuterMat);

    this.lockReticleGroup.add(this.lockOuterMesh, this.lockDiamondMesh);
    this.lockReticleGroup.renderOrder = 10;
    this.lockReticleGroup.visible = false;
    this.root.add(this.lockReticleGroup);

    this._simTime = 0;
    this._tmpTarget = new THREE.Vector3();
  }

  _nextDetRand() {
    this._sparkSeed = (this._sparkSeed * 1664525 + 1013904223) >>> 0;
    return this._sparkSeed / 4294967296;
  }

  reset() {
    this.trailInitialized = false;
    this.trailOpacity = 0;
    this.trailMat.opacity = 0;
    for (const s of this.sparks) {
      s.active = false;
      s.mesh.visible = false;
    }
    for (const r of this.rings) {
      r.active = false;
      r.mesh.visible = false;
    }
    this.lockReticleGroup.visible = false;
  }

  spawnHitSparks(worldPos, options = {}) {
    const count = options.count ?? 10;
    const colorHex = options.golden ? 0xf5c45e : 0x8ef5c8;
    const speedBase = options.heavy ? 5.6 : 4.1;

    for (let i = 0; i < count; i++) {
      const slot = this.sparks[this._sparkCursor];
      this._sparkCursor = (this._sparkCursor + 1) % SPARK_POOL_SIZE;

      const theta = this._nextDetRand() * Math.PI * 2;
      const elev = (this._nextDetRand() - 0.25) * 1.4;
      const spd = speedBase * (0.65 + this._nextDetRand() * 0.7);

      slot.active = true;
      slot.age = 0;
      slot.maxAge = 0.18 + this._nextDetRand() * 0.08;
      slot.mat.color.setHex(i % 3 === 0 ? 0xffffff : colorHex);
      slot.mat.opacity = 0.95;

      slot.mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
      slot.vel.set(Math.cos(theta) * spd, elev * spd + 1.2, Math.sin(theta) * spd);
      this._tmpTarget.copy(slot.mesh.position).add(slot.vel);
      slot.mesh.lookAt(this._tmpTarget);
      slot.mesh.visible = true;
    }
  }

  spawnShockwaveRing(worldPos, options = {}) {
    const slot = this.rings[this._ringCursor];
    this._ringCursor = (this._ringCursor + 1) % RING_POOL_SIZE;

    slot.active = true;
    slot.age = 0;
    slot.maxAge = options.durationSec ?? 0.34;
    slot.maxRadius = options.maxRadius ?? 2.4;
    slot.mat.color.setHex(options.colorHex ?? 0x3ecf8e);
    slot.mat.opacity = 0.85;
    slot.mesh.position.set(worldPos.x, (worldPos.y || 0) + 0.03, worldPos.z);
    slot.mesh.scale.set(0.25, 1, 0.25);
    slot.mesh.visible = true;
  }

  update(dt, params = {}) {
    const {
      baseWorldPos = null,
      tipWorldPos = null,
      trailActive = false,
      goldenQi = false,
      inHitstop = false,
      isLockedOn = false,
      dummyChestWorldPos = null,
      camera = null,
    } = params;

    const safeDt = Math.max(0, Math.min(dt, 0.08));
    this._simTime += safeDt;

    // 1. Update Sleek Outer-Edge Sword Qi Crescent Ribbon
    if (!trailActive && this.trailOpacity < 0.03) {
      this.trailInitialized = false;
    }

    if (baseWorldPos && tipWorldPos && !inHitstop && (trailActive || this.trailOpacity >= 0.03)) {
      // Sample upper 42% of blade toward tip for a crisp calligraphic crescent arc
      const innerX = baseWorldPos.x * 0.42 + tipWorldPos.x * 0.58;
      const innerY = baseWorldPos.y * 0.42 + tipWorldPos.y * 0.58;
      const innerZ = baseWorldPos.z * 0.42 + tipWorldPos.z * 0.58;

      if (
        !this.trailInitialized ||
        this.trailHistoryTip[0].distanceToSquared(tipWorldPos) > 1.44
      ) {
        for (let i = 0; i < TRAIL_STEPS; i++) {
          this.trailHistoryBase[i].set(innerX, innerY, innerZ);
          this.trailHistoryTip[i].copy(tipWorldPos);
        }
        this.trailInitialized = true;
      } else {
        for (let i = TRAIL_STEPS - 1; i > 0; i--) {
          this.trailHistoryBase[i].copy(this.trailHistoryBase[i - 1]);
          this.trailHistoryTip[i].copy(this.trailHistoryTip[i - 1]);
        }
        this.trailHistoryBase[0].set(innerX, innerY, innerZ);
        this.trailHistoryTip[0].copy(tipWorldPos);
      }

      const tipCol = goldenQi ? COLOR_GOLD_TIP : COLOR_JADE_TIP;
      const baseCol = goldenQi ? COLOR_GOLD_BASE : COLOR_JADE_BASE;

      for (let i = 0; i < TRAIL_STEPS; i++) {
        const fade = Math.pow(1 - i / (TRAIL_STEPS - 1), 2.45);
        const idx = i * 6;
        const b = this.trailHistoryBase[i];
        const t = this.trailHistoryTip[i];

        this.trailPositions[idx] = b.x;
        this.trailPositions[idx + 1] = b.y;
        this.trailPositions[idx + 2] = b.z;
        this.trailPositions[idx + 3] = t.x;
        this.trailPositions[idx + 4] = t.y;
        this.trailPositions[idx + 5] = t.z;

        this.trailColors[idx] = baseCol.r * fade * 0.55;
        this.trailColors[idx + 1] = baseCol.g * fade * 0.55;
        this.trailColors[idx + 2] = baseCol.b * fade * 0.55;
        this.trailColors[idx + 3] = tipCol.r * fade;
        this.trailColors[idx + 4] = tipCol.g * fade;
        this.trailColors[idx + 5] = tipCol.b * fade;
      }
      this.trailMesh.geometry.attributes.position.needsUpdate = true;
      this.trailMesh.geometry.attributes.color.needsUpdate = true;
    }

    const targetOpacity = inHitstop ? 0.68 : trailActive ? 0.48 : 0.0;
    const rate = targetOpacity > this.trailOpacity ? 24 : 14;
    this.trailOpacity = THREE.MathUtils.lerp(
      this.trailOpacity,
      targetOpacity,
      1 - Math.exp(-rate * Math.max(safeDt, 0.004))
    );
    this.trailMat.opacity = this.trailOpacity;

    // 2. Update Sparks
    for (let i = 0; i < SPARK_POOL_SIZE; i++) {
      const s = this.sparks[i];
      if (!s.active) continue;
      s.age += safeDt;
      if (s.age >= s.maxAge) {
        s.active = false;
        s.mesh.visible = false;
        continue;
      }
      const p = s.age / s.maxAge;
      s.vel.y -= 12 * safeDt;
      s.mesh.position.addScaledVector(s.vel, safeDt);
      s.mat.opacity = (1 - p) * 0.95;
      s.mesh.scale.set(1 - p * 0.5, 1 - p * 0.5, 1 + p * 0.6);
    }

    // 3. Update Shockwave Rings
    for (let i = 0; i < RING_POOL_SIZE; i++) {
      const r = this.rings[i];
      if (!r.active) continue;
      r.age += safeDt;
      if (r.age >= r.maxAge) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const p = r.age / r.maxAge;
      const ease = 1 - Math.pow(1 - p, 2.2);
      const radScale = (0.3 + ease * r.maxRadius) / 0.42;
      r.mesh.scale.set(radScale, 1, radScale);
      r.mat.opacity = (1 - p) * 0.82;
    }

    // 4. Update 3D Lock-On Reticle
    if (isLockedOn && dummyChestWorldPos) {
      this.lockReticleGroup.visible = true;
      this.lockReticleGroup.position.copy(dummyChestWorldPos);
      if (camera) {
        this.lockReticleGroup.quaternion.copy(camera.quaternion);
      }
      this.lockDiamondMesh.rotation.z = this._simTime * 1.8;
      const pulse = 1 + Math.sin(this._simTime * 6) * 0.06;
      this.lockOuterMesh.scale.set(pulse, pulse, 1);
    } else {
      this.lockReticleGroup.visible = false;
    }
  }
}
