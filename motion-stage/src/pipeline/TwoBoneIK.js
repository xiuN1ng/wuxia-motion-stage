import * as THREE from 'three';
import { BONE_IDX } from '../rig/HumanoidRig.js';

const _hPos = new THREE.Vector3();
const _dVec = new THREE.Vector3();
const _uAxis = new THREE.Vector3();
const _poleVec = new THREE.Vector3();
const _fAxis = new THREE.Vector3();
const _kPos = new THREE.Vector3();
const _aPos = new THREE.Vector3();

const _xUpper = new THREE.Vector3();
const _yUpper = new THREE.Vector3();
const _zUpper = new THREE.Vector3();
const _yLower = new THREE.Vector3();
const _zLower = new THREE.Vector3();

const _basisMat = new THREE.Matrix4();
const _parentQuat = new THREE.Quaternion();
const _qWorldUpper = new THREE.Quaternion();
const _qWorldLower = new THREE.Quaternion();
const _qWorldFoot = new THREE.Quaternion();
const _invQuat = new THREE.Quaternion();

/**
 * Closed-form Analytic Two-Bone Leg IK Solver (Hip -> Knee -> Ankle)
 * Guarantees forward knee hinge in pole plane with zero shin roll.
 */
export function solveTwoBoneLegIK(
  upLegBone,
  legBone,
  footBone,
  targetWorldPos,
  poleWorldPos,
  keepFootFlat = true,
  characterYawQuat = null
) {
  const L1 = legBone.position.length(); // 0.41m
  const L2 = footBone.position.length(); // 0.41m

  upLegBone.parent.updateWorldMatrix(true, false);
  upLegBone.updateWorldMatrix(false, false);
  upLegBone.getWorldPosition(_hPos);

  _dVec.subVectors(targetWorldPos, _hPos);
  const rawDistSq = _dVec.lengthSq();
  const rawDist = Number.isFinite(rawDistSq) ? Math.sqrt(rawDistSq) : 0;
  const minDist = Math.abs(L1 - L2) + 0.015;
  const maxDist = (L1 + L2) * 0.996;
  const d = THREE.MathUtils.clamp(rawDist > 0 ? rawDist : minDist, minDist, maxDist);

  if (rawDist < 1e-5) {
    _uAxis.set(0, -1, 0);
  } else {
    _uAxis.copy(_dVec).divideScalar(rawDist);
  }

  // Project pole direction perpendicular to hip->ankle line with guaranteed non-collinear fallback
  _poleVec.subVectors(poleWorldPos, _hPos);
  if (!Number.isFinite(_poleVec.x + _poleVec.y + _poleVec.z)) {
    _poleVec.set(0, 0, 1);
  }
  const proj = _poleVec.dot(_uAxis);
  _fAxis.copy(_poleVec).addScaledVector(_uAxis, -proj);
  if (_fAxis.lengthSq() < 1e-6) {
    if (Math.abs(_uAxis.z) < 0.9) {
      _fAxis.set(0, 0, 1);
    } else {
      _fAxis.set(0, 1, 0);
    }
    _fAxis.addScaledVector(_uAxis, -_fAxis.dot(_uAxis)).normalize();
  } else {
    _fAxis.normalize();
  }

  // Law of cosines for hip interior angle alpha
  const cosAlpha = THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

  // World knee K and clamped ankle A
  _kPos.copy(_hPos).addScaledVector(_uAxis, L1 * cosAlpha).addScaledVector(_fAxis, L1 * sinAlpha);
  _aPos.copy(_hPos).addScaledVector(_uAxis, d);

  // Upper leg world basis (bind pose has bone pointing along -Y, forward +Z)
  _yUpper.subVectors(_hPos, _kPos).normalize();
  _xUpper.crossVectors(_yUpper, _fAxis);
  if (_xUpper.lengthSq() < 1e-6) {
    if (Math.abs(_yUpper.x) < 0.9) {
      _xUpper.set(1, 0, 0);
    } else {
      _xUpper.set(0, 0, 1);
    }
    _xUpper.addScaledVector(_yUpper, -_xUpper.dot(_yUpper)).normalize();
  } else {
    _xUpper.normalize();
  }
  _zUpper.crossVectors(_xUpper, _yUpper).normalize();

  _basisMat.makeBasis(_xUpper, _yUpper, _zUpper);
  _qWorldUpper.setFromRotationMatrix(_basisMat).normalize();

  upLegBone.parent.getWorldQuaternion(_parentQuat);
  _invQuat.copy(_parentQuat).invert();
  upLegBone.quaternion.multiplyQuaternions(_invQuat, _qWorldUpper).normalize();

  // Lower leg world basis (shares hinge axis _xUpper -> zero axial shin twist)
  _yLower.subVectors(_kPos, _aPos).normalize();
  _zLower.crossVectors(_xUpper, _yLower).normalize();

  _basisMat.makeBasis(_xUpper, _yLower, _zLower);
  _qWorldLower.setFromRotationMatrix(_basisMat).normalize();

  _invQuat.copy(_qWorldUpper).invert();
  legBone.quaternion.multiplyQuaternions(_invQuat, _qWorldLower).normalize();

  // Keep foot planted parallel to ground during contact lock
  if (keepFootFlat) {
    if (characterYawQuat) {
      _qWorldFoot.copy(characterYawQuat).normalize();
    } else {
      _qWorldFoot.identity();
    }
    _invQuat.copy(_qWorldLower).invert();
    footBone.quaternion.multiplyQuaternions(_invQuat, _qWorldFoot).normalize();
  } else {
    footBone.quaternion.normalize();
  }

  upLegBone.updateWorldMatrix(false, true);
}

const _twistQuat = new THREE.Quaternion();
const _idQuat = new THREE.Quaternion();

/**
 * Swing-Twist Decomposition around local X-axis (forearm longitudinal roll axis).
 * Distributes 58% of wrist roll into ForeArmTwist bone to prevent candy-wrapper collapse.
 */
export function applyForearmTwistSolver(bones, enabled, twistShare = 0.58) {
  const share = THREE.MathUtils.clamp(
    Number.isFinite(Number(twistShare)) ? Number(twistShare) : 0.58,
    0,
    1
  );
  const pairs = [
    [BONE_IDX.LeftHand, BONE_IDX.LeftForeArmTwist],
    [BONE_IDX.RightHand, BONE_IDX.RightForeArmTwist],
  ];

  for (const [handIdx, twistIdx] of pairs) {
    const twistBone = bones[twistIdx];
    if (!enabled) {
      twistBone.quaternion.identity();
      continue;
    }

    const q = bones[handIdx].quaternion;
    const len = Math.hypot(q.x, q.w);
    if (!Number.isFinite(len) || len < 1e-6) {
      twistBone.quaternion.identity();
      continue;
    }

    let tx = q.x / len;
    let tw = q.w / len;
    if (tw < 0) {
      tx = -tx;
      tw = -tw;
    }
    _twistQuat.set(tx, 0, 0, tw);
    twistBone.quaternion.copy(_idQuat).slerp(_twistQuat, share).normalize();
  }
}

/**
 * Real-time SpringBone / Secondary Cloth Dynamics for Cape & Battle Tabard.
 * Responds to character root/chest inertia and avoids clipping into thigh capsules.
 */
export class SpringClothSolver {
  constructor() {
    this.prevChestPos = new THREE.Vector3();
    this.initialized = false;
    this.capeAnglesX = [0.06, 0.08, 0.1, 0.12];
    this.capeVelX = [0, 0, 0, 0];
    this.capeAnglesZ = [0, 0, 0, 0];
    this.capeVelZ = [0, 0, 0, 0];
    this.skirtFrontAng = 0;
    this.skirtFrontVel = 0;
    this.skirtBackAng = 0;
    this.skirtBackVel = 0;
    this._chestWorld = new THREE.Vector3();
    this._invHips = new THREE.Matrix4();
    this._kneeL = new THREE.Vector3();
    this._kneeR = new THREE.Vector3();
  }

  reset(bones) {
    this.initialized = false;
    for (let i = 0; i < 4; i++) {
      this.capeAnglesX[i] = 0.08;
      this.capeVelX[i] = 0;
      this.capeAnglesZ[i] = 0;
      this.capeVelZ[i] = 0;
      bones[BONE_IDX.Cape01 + i].quaternion.identity();
    }
    this.skirtFrontAng = -0.08;
    this.skirtFrontVel = 0;
    this.skirtBackAng = 0.08;
    this.skirtBackVel = 0;
    bones[BONE_IDX.SkirtFront].quaternion.identity();
    bones[BONE_IDX.SkirtBack].quaternion.identity();
  }

  update(bones, dt, enabled, syntheticForwardSpeed = 0) {
    if (!enabled) {
      for (let i = 0; i < 4; i++) {
        bones[BONE_IDX.Cape01 + i].quaternion.identity();
      }
      bones[BONE_IDX.SkirtFront].quaternion.identity();
      bones[BONE_IDX.SkirtBack].quaternion.identity();
      this.initialized = false;
      return;
    }

    const numDt = Number(dt);
    const clampedDt = Number.isFinite(numDt) ? THREE.MathUtils.clamp(numDt, 0, 0.05) : 0;
    const safeForwardSpeed = Number.isFinite(Number(syntheticForwardSpeed))
      ? Number(syntheticForwardSpeed)
      : 0;

    bones[0].updateWorldMatrix(true, true);
    bones[BONE_IDX.Chest].getWorldPosition(this._chestWorld);
    if (!Number.isFinite(this._chestWorld.x + this._chestWorld.y + this._chestWorld.z)) {
      this._chestWorld.set(0, 1.3, 0);
    }

    if (!this.initialized) {
      this.prevChestPos.copy(this._chestWorld);
      this.initialized = true;
    }

    let vx = 0;
    let vy = 0;
    let vz = safeForwardSpeed;
    if (clampedDt > 0) {
      const denom = Math.max(clampedDt, 0.008);
      vx = (this._chestWorld.x - this.prevChestPos.x) / denom;
      vy = (this._chestWorld.y - this.prevChestPos.y) / denom;
      vz = (this._chestWorld.z - this.prevChestPos.z) / denom + safeForwardSpeed;
      this.prevChestPos.copy(this._chestWorld);
    }

    // Exact 3D knee positions in Hips local space for zero-penetration skirt & cape clearance
    this._invHips.copy(bones[BONE_IDX.Hips].matrixWorld).invert();
    bones[BONE_IDX.LeftLeg].getWorldPosition(this._kneeL).applyMatrix4(this._invHips);
    bones[BONE_IDX.RightLeg].getWorldPosition(this._kneeR).applyMatrix4(this._invHips);

    const downL = Math.max(0.14, -this._kneeL.y);
    const downR = Math.max(0.14, -this._kneeR.y);
    const fwdKickL = this._kneeL.z > 0.02 ? Math.atan2(this._kneeL.z, downL) + 0.24 : 0.04;
    const fwdKickR = this._kneeR.z > 0.02 ? Math.atan2(this._kneeR.z, downR) + 0.24 : 0.04;
    const backKickL = this._kneeL.z < -0.02 ? Math.atan2(-this._kneeL.z, downL) + 0.24 : 0.04;
    const backKickR = this._kneeR.z < -0.02 ? Math.atan2(-this._kneeR.z, downR) + 0.24 : 0.04;

    const maxForwardKick = Math.min(1.38, Math.max(0, fwdKickL, fwdKickR));
    const maxBackwardKick = Math.min(1.32, Math.max(0, backKickL, backKickR));

    const chestTwistY = bones[BONE_IDX.Chest].quaternion.y * 2 + bones[BONE_IDX.Spine].quaternion.y * 2;

    // 4-link cascaded cape pendulum
    for (let i = 0; i < 4; i++) {
      if (clampedDt > 0) {
        const stiffness = 26 - i * 3.5;
        const damping = 5.4 - i * 0.45;
        const windFlutter =
          Math.sin(performance.now() * 0.0065 - i * 1.15) * (0.03 + 0.045 * Math.min(1, Math.abs(vz)));

        // Positive rotation.x tilts -Y cape bone backward (-Z), clearing back and thighs
        const targetPitch =
          0.12 +
          THREE.MathUtils.clamp(vz * 0.16, -0.06, 0.55) +
          THREE.MathUtils.clamp(-vy * 0.08, -0.10, 0.26) +
          (i >= 1 ? maxBackwardKick * 0.52 : maxBackwardKick * 0.22) +
          windFlutter;

        const parentFollow = i > 0 ? this.capeAnglesX[i - 1] * 0.25 : 0;
        const desiredX = THREE.MathUtils.clamp(targetPitch + parentFollow, 0.08, 0.92);

        const accX = (desiredX - this.capeAnglesX[i]) * stiffness - this.capeVelX[i] * damping;
        this.capeVelX[i] += accX * clampedDt;
        this.capeAnglesX[i] += this.capeVelX[i] * clampedDt;
        if (i === 0) {
          this.capeAnglesX[i] = Math.max(0.08, this.capeAnglesX[i]);
        }

        const targetRoll = THREE.MathUtils.clamp(-vx * 0.14 - chestTwistY * (0.24 + i * 0.06), -0.46, 0.46);
        const accZ = (targetRoll - this.capeAnglesZ[i]) * (stiffness * 0.85) - this.capeVelZ[i] * damping;
        this.capeVelZ[i] += accZ * clampedDt;
        this.capeAnglesZ[i] += this.capeVelZ[i] * clampedDt;
      }

      bones[BONE_IDX.Cape01 + i].rotation.set(this.capeAnglesX[i], 0, this.capeAnglesZ[i]);
      bones[BONE_IDX.Cape01 + i].quaternion.normalize();
    }

    // Skirt front & back anti-clip swing with hard non-penetration bound against thigh capsules!
    const hardFrontBound = -0.08 - maxForwardKick;
    const targetFront = Math.min(hardFrontBound, -0.08 - Math.max(0, -vz * 0.08));
    if (clampedDt > 0) {
      this.skirtFrontVel += ((targetFront - this.skirtFrontAng) * 38 - this.skirtFrontVel * 6.8) * clampedDt;
      this.skirtFrontAng = Math.min(hardFrontBound, this.skirtFrontAng + this.skirtFrontVel * clampedDt);
    } else {
      this.skirtFrontAng = Math.min(hardFrontBound, this.skirtFrontAng);
    }
    bones[BONE_IDX.SkirtFront].rotation.set(this.skirtFrontAng, 0, 0);
    bones[BONE_IDX.SkirtFront].quaternion.normalize();

    const hardBackBound = 0.08 + maxBackwardKick;
    const targetBack = Math.max(hardBackBound, 0.08 + Math.max(0, vz * 0.10));
    if (clampedDt > 0) {
      this.skirtBackVel += ((targetBack - this.skirtBackAng) * 38 - this.skirtBackVel * 6.8) * clampedDt;
      this.skirtBackAng = Math.max(hardBackBound, this.skirtBackAng + this.skirtBackVel * clampedDt);
    } else {
      this.skirtBackAng = Math.max(hardBackBound, this.skirtBackAng);
    }
    bones[BONE_IDX.SkirtBack].rotation.set(this.skirtBackAng, 0, 0);
    bones[BONE_IDX.SkirtBack].quaternion.normalize();
  }
}
