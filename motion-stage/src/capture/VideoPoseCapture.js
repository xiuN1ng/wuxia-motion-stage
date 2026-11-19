import * as THREE from 'three';
import { PoseLandmarker } from '@mediapipe/tasks-vision';
import ModuleFactory from '@mediapipe/tasks-vision/vision_wasm_module_internal.js';
import { BONE_DEFS, BONE_IDX, createBoneHierarchy } from '../rig/HumanoidRig.js';

const NUM_BONES = BONE_DEFS.length;

let runtimeAssetsPromise = null;
let landmarkerVideo = null;
let landmarkerVideoDelegate = null;
let landmarkerImage = null;
let landmarkerImageDelegate = null;
let gpuInitFailed = false;
let cachedSoftwareWebGL = null;
let lastVideoTimestampMs = 0;

/**
 * Detects whether the browser WebGL context is backed by a software rasterizer
 * (SwiftShader, LLVMpipe, Lavapipe, Subzero, Basic Render Driver).
 * Node-safe and context-leak-free (immediately releases probe context via WEBGL_lose_context).
 */
export function isSoftwareWebGL() {
  if (typeof document === 'undefined') {
    return true;
  }
  if (cachedSoftwareWebGL !== null) {
    return cachedSoftwareWebGL;
  }
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      cachedSoftwareWebGL = true;
      return true;
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    cachedSoftwareWebGL = /swiftshader|llvmpipe|lavapipe|software|subzero|basic render/i.test(
      `${vendor || ''} ${renderer || ''}`
    );
    return cachedSoftwareWebGL;
  } catch {
    cachedSoftwareWebGL = true;
    return true;
  }
}

export function resolvePreferredDelegate(delegate = 'auto') {
  const norm = String(delegate || 'auto').trim().toUpperCase();
  if (norm === 'CPU') return 'CPU';
  if (norm === 'GPU') return gpuInitFailed ? 'CPU' : 'GPU';
  return gpuInitFailed || isSoftwareWebGL() ? 'CPU' : 'GPU';
}

/**
 * Advances and returns a strictly monotonic timestamp (ms) for MediaPipe VIDEO runningMode,
 * guaranteeing re-trims or back-to-back clips never violate input stream monotonicity.
 */
export function advanceMonotonicVideoTimestampMs(relSec = 0, clipBaseOverrideMs = null) {
  const relMs = Math.max(0, Math.round((Number(relSec) || 0) * 1000));
  const baseMs =
    clipBaseOverrideMs !== null && Number.isFinite(clipBaseOverrideMs)
      ? clipBaseOverrideMs
      : Math.max(Math.round(performance.now()) + 1000, lastVideoTimestampMs + 1000);
  const tsMs = Math.max(lastVideoTimestampMs + 1, baseMs + relMs);
  lastVideoTimestampMs = tsMs;
  return tsMs;
}

export function getLastVideoTimestampMs() {
  return lastVideoTimestampMs;
}

async function fetchChunkedAsset(chunksBaseUrl, entry, onChunkDone) {
  const out = new Uint8Array(entry.totalBytes);
  const offsets = [];
  let runningOffset = 0;
  const CHUNK_SIZE = 2 * 1024 * 1024;
  for (let i = 0; i < entry.parts.length; i++) {
    offsets.push(runningOffset);
    runningOffset += CHUNK_SIZE;
  }

  let nextIdx = 0;
  const workerCount = Math.min(4, entry.parts.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIdx < entry.parts.length) {
      const idx = nextIdx++;
      const partUrl = new URL(entry.parts[idx], chunksBaseUrl).toString();
      const resp = await fetch(partUrl, { credentials: 'same-origin' });
      if (!resp.ok) {
        throw new Error(`加载姿态模型分片失败 (${entry.parts[idx]}: HTTP ${resp.status})`);
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      out.set(buf, offsets[idx]);
      onChunkDone?.();
    }
  });
  await Promise.all(workers);
  return out;
}

async function ensureRuntimeAssets(onStatus) {
  if (!runtimeAssetsPromise) {
    runtimeAssetsPromise = (async () => {
      const chunksBaseUrl = new URL('./mediapipe/chunks/', window.location.href);
      const manifestResp = await fetch(new URL('manifest.json', chunksBaseUrl).toString(), {
        credentials: 'same-origin',
      });
      if (!manifestResp.ok) {
        throw new Error(`无法读取姿态模型清单 (HTTP ${manifestResp.status})`);
      }
      const manifest = await manifestResp.json();
      const totalParts = manifest.wasm.parts.length + manifest.model.parts.length;
      let loadedParts = 0;
      const report = () => {
        loadedParts++;
        const pct = Math.round((loadedParts / totalParts) * 100);
        onStatus?.(`正在加载 3D 姿态引擎 ${pct}%`);
      };

      const [wasmBytes, modelBytes] = await Promise.all([
        fetchChunkedAsset(chunksBaseUrl, manifest.wasm, report),
        fetchChunkedAsset(chunksBaseUrl, manifest.model, report),
      ]);
      const compiledWasm = await WebAssembly.compile(wasmBytes);
      return { compiledWasm, modelBytes };
    })().catch((err) => {
      runtimeAssetsPromise = null;
      throw err;
    });
  }
  return runtimeAssetsPromise;
}

async function createSingleLandmarker(compiledWasm, modelBytes, runningMode, delegate) {
  globalThis.ModuleFactory = ModuleFactory;
  globalThis.Module = {
    instantiateWasm(imports, successCallback) {
      WebAssembly.instantiate(compiledWasm, imports).then((instance) => {
        successCallback(instance);
      });
      return {};
    },
  };

  const vision = {
    wasmLoaderPath: '',
    wasmBinaryPath: '',
  };

  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetBuffer: modelBytes.slice(),
      delegate,
    },
    runningMode,
    numPoses: 1,
  });
}

async function createWithFallback(compiledWasm, modelBytes, runningMode, preferredDelegate = 'auto') {
  const targetDelegate = resolvePreferredDelegate(preferredDelegate);
  if (targetDelegate === 'CPU') {
    const landmarker = await createSingleLandmarker(compiledWasm, modelBytes, runningMode, 'CPU');
    return { landmarker, actualDelegate: 'CPU' };
  }

  try {
    const landmarker = await createSingleLandmarker(compiledWasm, modelBytes, runningMode, 'GPU');
    return { landmarker, actualDelegate: 'GPU' };
  } catch {
    gpuInitFailed = true;
    const landmarker = await createSingleLandmarker(compiledWasm, modelBytes, runningMode, 'CPU');
    return { landmarker, actualDelegate: 'CPU' };
  }
}

async function ensureLandmarker(mode, onStatus, delegate = 'auto') {
  const { compiledWasm, modelBytes } = await ensureRuntimeAssets(onStatus);
  const targetDelegate = resolvePreferredDelegate(delegate);
  onStatus?.(`正在初始化 3D 骨骼解算器 (${targetDelegate})...`);

  if (mode === 'VIDEO') {
    if (landmarkerVideo && landmarkerVideoDelegate !== targetDelegate) {
      try {
        landmarkerVideo.close();
      } catch {
        // Ignore WASM teardown errors during delegate switch
      }
      landmarkerVideo = null;
      landmarkerVideoDelegate = null;
    }
    if (!landmarkerVideo) {
      const created = await createWithFallback(compiledWasm, modelBytes, 'VIDEO', targetDelegate);
      landmarkerVideo = created.landmarker;
      landmarkerVideoDelegate = created.actualDelegate;
    }
    return landmarkerVideo;
  }

  if (landmarkerImage && landmarkerImageDelegate !== targetDelegate) {
    try {
      landmarkerImage.close();
    } catch {
      // Ignore WASM teardown errors during delegate switch
    }
    landmarkerImage = null;
    landmarkerImageDelegate = null;
  }
  if (!landmarkerImage) {
    const created = await createWithFallback(compiledWasm, modelBytes, 'IMAGE', targetDelegate);
    landmarkerImage = created.landmarker;
    landmarkerImageDelegate = created.actualDelegate;
  }
  return landmarkerImage;
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = THREE.MathUtils.clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return THREE.MathUtils.lerp(sorted[lo], sorted[hi], pos - lo);
}

/**
 * Converts MediaPipe 33 worldLandmarks (+x right, +y down, +z away)
 * into Three.js right-handed world space (+X left-of-body/viewer-right, +Y up, +Z toward camera)
 * and solves 3D joint quaternions (including 6-DoF radial wrist roll for Wuxia Sword grip).
 */
export function landmarksToHumanoidFrame(worldLm, normLm) {
  const P = Array.from({ length: 33 }, (_, idx) => {
    const p = worldLm?.[idx];
    const x = Number.isFinite(p?.x) ? p.x : 0;
    const y = Number.isFinite(p?.y) ? -p.y : 0;
    const z = Number.isFinite(p?.z) ? -p.z : 0;
    return new THREE.Vector3(x, y, z);
  });

  const { bones } = createBoneHierarchy();
  const quats = Array.from({ length: NUM_BONES }, () => new THREE.Quaternion());

  const vX = new THREE.Vector3();
  const vY = new THREE.Vector3();
  const vZ = new THREE.Vector3();
  const mat = new THREE.Matrix4();
  const qParentInv = new THREE.Quaternion();

  const normalizeQuatSafe = (q) => {
    if (!q || !Number.isFinite(q.x + q.y + q.z + q.w) || q.lengthSq() < 1e-12) {
      return q.set(0, 0, 0, 1);
    }
    return q.normalize();
  };

  // Returns a unit vector strictly orthogonal to unitAxis, preferring preferredVec when non-collinear
  const makePerpUnit = (unitAxis, preferredVec = null) => {
    const out = new THREE.Vector3();
    if (preferredVec) {
      out.copy(preferredVec).addScaledVector(unitAxis, -preferredVec.dot(unitAxis));
      if (out.lengthSq() >= 1e-8) {
        return out.normalize();
      }
    }
    if (Math.abs(unitAxis.z) < 0.9) {
      out.set(0, 0, 1);
    } else {
      out.set(0, 1, 0);
    }
    return out.addScaledVector(unitAxis, -out.dot(unitAxis)).normalize();
  };

  const setBoneWorldQuat = (boneIdx, qWorld) => {
    normalizeQuatSafe(qWorld);
    const b = bones[boneIdx];
    if (boneIdx === 0) {
      b.quaternion.copy(qWorld);
    } else {
      b.parent.getWorldQuaternion(qParentInv).invert();
      b.quaternion.multiplyQuaternions(qParentInv, qWorld);
    }
    normalizeQuatSafe(b.quaternion);
    b.updateWorldMatrix(false, false);
    quats[boneIdx].copy(b.quaternion);
  };

  // 1. Pelvis / Hips (23 = LeftHip, 24 = RightHip)
  const hipCenter = new THREE.Vector3().addVectors(P[23], P[24]).multiplyScalar(0.5);
  const shCenter = new THREE.Vector3().addVectors(P[11], P[12]).multiplyScalar(0.5);

  vX.subVectors(P[23], P[24]);
  if (vX.lengthSq() < 1e-8) {
    vX.set(1, 0, 0);
  } else {
    vX.normalize();
  }

  vY.subVectors(shCenter, hipCenter);
  if (vY.lengthSq() < 1e-8) {
    vY.copy(makePerpUnit(vX, new THREE.Vector3(0, 1, 0)));
  } else {
    vY.normalize();
  }

  vZ.crossVectors(vX, vY);
  if (vZ.lengthSq() < 1e-8) {
    vZ.copy(makePerpUnit(vX, new THREE.Vector3(0, 0, 1)));
  } else {
    vZ.normalize();
  }
  vY.crossVectors(vZ, vX).normalize();

  mat.makeBasis(vX, vY, vZ);
  const qHipsWorld = normalizeQuatSafe(new THREE.Quaternion().setFromRotationMatrix(mat));
  setBoneWorldQuat(BONE_IDX.Hips, qHipsWorld);

  // 2. Spine & Chest (11 = LeftShoulder, 12 = RightShoulder)
  const cX = new THREE.Vector3().subVectors(P[11], P[12]);
  if (cX.lengthSq() < 1e-8) {
    cX.copy(vX);
  } else {
    cX.normalize();
  }

  const cY = new THREE.Vector3().subVectors(shCenter, hipCenter);
  if (cY.lengthSq() < 1e-8) {
    cY.copy(vY);
  } else {
    cY.normalize();
  }

  const cZ = new THREE.Vector3().crossVectors(cX, cY);
  if (cZ.lengthSq() < 1e-8) {
    cZ.copy(makePerpUnit(cX, vZ));
  } else {
    cZ.normalize();
  }
  cY.crossVectors(cZ, cX).normalize();
  mat.makeBasis(cX, cY, cZ);
  const qChestWorld = normalizeQuatSafe(new THREE.Quaternion().setFromRotationMatrix(mat));
  const qSpineWorld = normalizeQuatSafe(qHipsWorld.clone().slerp(qChestWorld, 0.45));

  setBoneWorldQuat(BONE_IDX.Spine, qSpineWorld);
  setBoneWorldQuat(BONE_IDX.Chest, qChestWorld);

  // 3. Neck & Head (7 = LeftEar, 8 = RightEar, 0 = Nose)
  const earMid = new THREE.Vector3().addVectors(P[7], P[8]).multiplyScalar(0.5);
  const hX = new THREE.Vector3().subVectors(P[7], P[8]);
  if (hX.lengthSq() < 1e-8) {
    hX.copy(cX);
  } else {
    hX.normalize();
  }
  const hZ = new THREE.Vector3().subVectors(P[0], earMid);
  if (hZ.lengthSq() < 1e-8) {
    hZ.copy(cZ);
  } else {
    hZ.normalize();
  }
  const hY = new THREE.Vector3().crossVectors(hZ, hX);
  if (hY.lengthSq() < 1e-8) {
    hY.copy(makePerpUnit(hX, cY));
  } else {
    hY.normalize();
  }
  hZ.crossVectors(hX, hY).normalize();
  mat.makeBasis(hX, hY, hZ);
  const qHeadWorld = normalizeQuatSafe(new THREE.Quaternion().setFromRotationMatrix(mat));
  setBoneWorldQuat(BONE_IDX.Neck, normalizeQuatSafe(qChestWorld.clone().slerp(qHeadWorld, 0.4)));
  setBoneWorldQuat(BONE_IDX.Head, qHeadWorld);

  // Helper to orient a single limb segment from bindRestDir -> targetWorldDir
  const restLeft = new THREE.Vector3(1, 0, 0);
  const restRight = new THREE.Vector3(-1, 0, 0);
  const restDown = new THREE.Vector3(0, -1, 0);
  const segDir = new THREE.Vector3();

  const alignLimbSegment = (boneIdx, pStart, pEnd, restVec, fallbackQuat) => {
    segDir.subVectors(pEnd, pStart);
    if (segDir.lengthSq() < 1e-8) {
      setBoneWorldQuat(boneIdx, fallbackQuat);
      return fallbackQuat.clone();
    }
    segDir.normalize();
    const qSwing = normalizeQuatSafe(new THREE.Quaternion().setFromUnitVectors(restVec, segDir));
    setBoneWorldQuat(boneIdx, qSwing);
    return qSwing;
  };

  // 4A. Left Arm (11 -> 13 -> 15) + 6-DoF LeftHand (17 = Pinky, 19 = Index, 21 = Thumb)
  bones[BONE_IDX.LeftShoulder].quaternion.identity();
  bones[BONE_IDX.LeftShoulder].updateWorldMatrix(false, false);
  const qLUA = alignLimbSegment(BONE_IDX.LeftUpperArm, P[11], P[13], restLeft, qChestWorld);
  const qLFA = alignLimbSegment(BONE_IDX.LeftForeArm, P[13], P[15], restLeft, qLUA);
  {
    const foreDirL = new THREE.Vector3().subVectors(P[15], P[13]);
    if (foreDirL.lengthSq() < 1e-8) foreDirL.set(1, 0, 0);
    foreDirL.normalize();

    const handDirL = new THREE.Vector3().addVectors(P[17], P[19]).multiplyScalar(0.5).sub(P[15]);
    if (handDirL.lengthSq() < 1e-8) {
      handDirL.copy(foreDirL);
    } else {
      handDirL.normalize().lerp(foreDirL, 0.25);
      if (handDirL.lengthSq() < 1e-8) handDirL.copy(foreDirL);
      else handDirL.normalize();
    }

    const radialL = new THREE.Vector3()
      .copy(P[19])
      .multiplyScalar(0.6)
      .addScaledVector(P[21], 0.4)
      .sub(P[17]);
    radialL.addScaledVector(handDirL, -radialL.dot(handDirL));
    if (radialL.lengthSq() < 1e-8) {
      radialL.copy(makePerpUnit(handDirL, new THREE.Vector3(0, 1, 0)));
    } else {
      radialL.normalize();
    }

    const zHandL = new THREE.Vector3().crossVectors(handDirL, radialL).normalize();
    mat.makeBasis(handDirL, radialL, zHandL);
    setBoneWorldQuat(BONE_IDX.LeftHand, new THREE.Quaternion().setFromRotationMatrix(mat));
  }
  void qLFA;

  // 4B. Right Arm (12 -> 14 -> 16) + 6-DoF RightHand calibrated to Wuxia Sword radial grip
  bones[BONE_IDX.RightShoulder].quaternion.identity();
  bones[BONE_IDX.RightShoulder].updateWorldMatrix(false, false);
  const qRUA = alignLimbSegment(BONE_IDX.RightUpperArm, P[12], P[14], restRight, qChestWorld);
  alignLimbSegment(BONE_IDX.RightForeArm, P[14], P[16], restRight, qRUA);
  {
    const foreDirR = new THREE.Vector3().subVectors(P[16], P[14]);
    if (foreDirR.lengthSq() < 1e-8) foreDirR.set(-1, 0, 0);
    foreDirR.normalize();

    const handDirR = new THREE.Vector3().addVectors(P[18], P[20]).multiplyScalar(0.5).sub(P[16]);
    if (handDirR.lengthSq() < 1e-8) {
      handDirR.copy(foreDirR);
    } else {
      handDirR.normalize().lerp(foreDirR, 0.25);
      if (handDirR.lengthSq() < 1e-8) handDirR.copy(foreDirR);
      else handDirR.normalize();
    }

    const radialR = new THREE.Vector3()
      .copy(P[20])
      .multiplyScalar(0.6)
      .addScaledVector(P[22], 0.4)
      .sub(P[18]);
    radialR.addScaledVector(handDirR, -radialR.dot(handDirR));
    if (radialR.lengthSq() < 1e-8) {
      radialR.copy(makePerpUnit(handDirR, new THREE.Vector3(0, 1, 0)));
    } else {
      radialR.normalize();
    }

    // Prevent monocular landmark flip from pointing a held sword inward toward the chest
    const torsoCenter = new THREE.Vector3().lerpVectors(hipCenter, shCenter, 0.65);
    const outFromBody = new THREE.Vector3().subVectors(P[16], torsoCenter);
    if (outFromBody.lengthSq() > 1e-8 && outFromBody.length() < 0.58) {
      const outUnit = outFromBody.clone().normalize();
      const handInward = handDirR.dot(outUnit);
      if (handInward < -0.10) {
        handDirR.addScaledVector(outUnit, -handInward + 0.15);
        if (handDirR.lengthSq() < 1e-8) handDirR.copy(outUnit);
        else handDirR.normalize();
        radialR.addScaledVector(handDirR, -radialR.dot(handDirR));
        if (radialR.lengthSq() < 1e-8) {
          radialR.copy(makePerpUnit(handDirR, outUnit));
        } else {
          radialR.normalize();
        }
      }
      const bladeDir = new THREE.Vector3()
        .copy(handDirR)
        .multiplyScalar(0.619)
        .addScaledVector(radialR, 0.785);
      const safeOut = outUnit.clone().add(new THREE.Vector3(0, 0.45, 0.25));
      safeOut.addScaledVector(handDirR, -safeOut.dot(handDirR));
      if (bladeDir.dot(outUnit) < 0.05 && safeOut.lengthSq() > 1e-4) {
        safeOut.normalize();
        radialR.lerp(safeOut, 0.85).addScaledVector(handDirR, -radialR.dot(handDirR));
        if (radialR.lengthSq() < 1e-8) {
          radialR.copy(makePerpUnit(handDirR, new THREE.Vector3(0, 1, 0)));
        } else {
          radialR.normalize();
        }
      }
    }

    const eX = handDirR.clone().negate();
    const bPerp = new THREE.Vector3().crossVectors(eX, radialR).normalize();
    const colY = new THREE.Vector3()
      .copy(radialR)
      .multiplyScalar(0.9600)
      .addScaledVector(bPerp, -0.2788)
      .normalize();
    const colZ = new THREE.Vector3().crossVectors(eX, colY).normalize();
    mat.makeBasis(eX, colY, colZ);
    setBoneWorldQuat(BONE_IDX.RightHand, new THREE.Quaternion().setFromRotationMatrix(mat));
  }

  // 5. Left Leg (23 -> 25 -> 27) & Right Leg (24 -> 26 -> 28) with forward knee plane
  const solveLegFromLandmarks = (upIdx, loIdx, ftIdx, pHip, pKnee, pAnkle, pHeel, pToe) => {
    const dUpperRaw = new THREE.Vector3().subVectors(pKnee, pHip);
    const dLowerRaw = new THREE.Vector3().subVectors(pAnkle, pKnee);
    const footFwd = new THREE.Vector3().subVectors(pToe, pHeel);
    if (footFwd.lengthSq() < 1e-8) footFwd.copy(vZ);
    footFwd.normalize();

    const buildLegBasis = (downVec) => {
      const ly = downVec.clone().negate().normalize();
      const lx = new THREE.Vector3().crossVectors(ly, footFwd);
      if (lx.lengthSq() < 1e-8) {
        lx.copy(makePerpUnit(ly, vX));
      } else {
        lx.normalize();
      }
      const lz = new THREE.Vector3().crossVectors(lx, ly).normalize();
      mat.makeBasis(lx, ly, lz);
      return normalizeQuatSafe(new THREE.Quaternion().setFromRotationMatrix(mat));
    };

    const qUp =
      dUpperRaw.lengthSq() > 1e-6
        ? buildLegBasis(dUpperRaw.clone().normalize())
        : alignLimbSegment(upIdx, pHip, pKnee, restDown, qHipsWorld);
    setBoneWorldQuat(upIdx, qUp);

    const qLo = dLowerRaw.lengthSq() > 1e-6 ? buildLegBasis(dLowerRaw.clone().normalize()) : qUp;
    setBoneWorldQuat(loIdx, qLo);

    const fZ = footFwd.clone();
    const fX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fZ);
    if (fX.lengthSq() < 1e-8) {
      fX.copy(makePerpUnit(fZ, vX));
    } else {
      fX.normalize();
    }
    const fY = new THREE.Vector3().crossVectors(fZ, fX).normalize();
    mat.makeBasis(fX, fY, fZ);
    setBoneWorldQuat(ftIdx, new THREE.Quaternion().setFromRotationMatrix(mat));
  };

  solveLegFromLandmarks(
    BONE_IDX.LeftUpLeg,
    BONE_IDX.LeftLeg,
    BONE_IDX.LeftFoot,
    P[23],
    P[25],
    P[27],
    P[29],
    P[31]
  );
  solveLegFromLandmarks(
    BONE_IDX.RightUpLeg,
    BONE_IDX.RightLeg,
    BONE_IDX.RightFoot,
    P[24],
    P[26],
    P[28],
    P[30],
    P[32]
  );

  for (let i = 0; i < NUM_BONES; i++) {
    normalizeQuatSafe(quats[i]);
  }

  let rx = 0;
  let ry = 0.94;
  let imgMeta = null;
  if (normLm && normLm.length >= 29) {
    const imgHipX = ((Number(normLm[23]?.x) || 0) + (Number(normLm[24]?.x) || 0)) * 0.5;
    const imgHipY = ((Number(normLm[23]?.y) || 0) + (Number(normLm[24]?.y) || 0)) * 0.5;
    const imgShX = ((Number(normLm[11]?.x) || 0) + (Number(normLm[12]?.x) || 0)) * 0.5;
    const imgShY = ((Number(normLm[11]?.y) || 0) + (Number(normLm[12]?.y) || 0)) * 0.5;
    const legLenL =
      Math.hypot((normLm[23]?.x || 0) - (normLm[25]?.x || 0), (normLm[23]?.y || 0) - (normLm[25]?.y || 0)) +
      Math.hypot((normLm[25]?.x || 0) - (normLm[27]?.x || 0), (normLm[25]?.y || 0) - (normLm[27]?.y || 0));
    const legLenR =
      Math.hypot((normLm[24]?.x || 0) - (normLm[26]?.x || 0), (normLm[24]?.y || 0) - (normLm[26]?.y || 0)) +
      Math.hypot((normLm[26]?.x || 0) - (normLm[28]?.x || 0), (normLm[26]?.y || 0) - (normLm[28]?.y || 0));
    const lowestAnkleY = Math.max(
      Number(normLm[27]?.y) || 0,
      Number(normLm[28]?.y) || 0,
      Number(normLm[29]?.y ?? normLm[27]?.y) || 0,
      Number(normLm[30]?.y ?? normLm[28]?.y) || 0
    );
    const torsoNorm = Math.hypot(imgShX - imgHipX, imgShY - imgHipY);

    if (Number.isFinite(imgHipX) && Number.isFinite(imgHipY)) {
      rx = (imgHipX - 0.5) * 1.35;
      ry = 0.94 + (0.55 - imgHipY) * 0.85;
      imgMeta = {
        hipX: imgHipX,
        hipY: imgHipY,
        lowestAnkleY: Number.isFinite(lowestAnkleY) ? lowestAnkleY : imgHipY,
        maxLegNorm: Number.isFinite(Math.max(legLenL, legLenR)) ? Math.max(legLenL, legLenR) : 0,
        torsoNorm: Number.isFinite(torsoNorm) ? torsoNorm : 0,
      };
    }
  }

  bones[0].position.set(rx, ry, 0);
  bones[0].updateWorldMatrix(true, true);

  return {
    rootPos: new THREE.Vector3(rx, ry, 0),
    quats,
    contactL: null,
    contactR: null,
    _imgMeta: imgMeta,
  };
}

/**
 * Calibrates metric stride scale (pxPerMeter), studio floor line, aerial jump clearance,
 * and subtle depth lunge (rz) across an entire extracted video sequence.
 */
export function calibrateVideoSequenceMetrics(frames) {
  if (!frames || frames.length === 0) return;
  const validMeta = frames.map((f) => f._imgMeta).filter(Boolean);
  const { bones } = createBoneHierarchy();
  const pL = new THREE.Vector3();
  const pR = new THREE.Vector3();

  if (validMeta.length < 3) {
    let minFootY = Infinity;
    for (const fr of frames) {
      bones[0].position.copy(fr.rootPos);
      for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(fr.quats[b]);
      bones[0].updateWorldMatrix(true, true);
      bones[BONE_IDX.LeftFoot].getWorldPosition(pL);
      bones[BONE_IDX.RightFoot].getWorldPosition(pR);
      minFootY = Math.min(minFootY, pL.y, pR.y);
      delete fr._imgMeta;
    }
    const yOffset = Number.isFinite(minFootY) ? 0.08 - minFootY : 0;
    for (const fr of frames) fr.rootPos.y += yOffset;
    return;
  }

  const refLegNorm = THREE.MathUtils.clamp(
    percentile(
      validMeta.map((m) => m.maxLegNorm),
      0.75
    ),
    0.16,
    0.68
  );
  const pxPerMeter = refLegNorm / 0.82;
  const groundLineNormY = percentile(
    validMeta.map((m) => m.lowestAnkleY),
    0.88
  );
  const centerHipNormX = percentile(
    validMeta.map((m) => m.hipX),
    0.5
  );
  const medianTorsoNorm = Math.max(
    0.08,
    percentile(
      validMeta.map((m) => m.torsoNorm),
      0.5
    )
  );

  for (const fr of frames) {
    bones[0].position.set(0, 0, 0);
    for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(fr.quats[b]);
    bones[0].updateWorldMatrix(true, true);
    bones[BONE_IDX.LeftFoot].getWorldPosition(pL);
    bones[BONE_IDX.RightFoot].getWorldPosition(pR);
    const relMinFootY = Math.min(pL.y, pR.y);

    if (fr._imgMeta) {
      const m = fr._imgMeta;
      const rx = THREE.MathUtils.clamp((m.hipX - centerHipNormX) / pxPerMeter, -1.65, 1.65);
      const airClearance = THREE.MathUtils.clamp(
        (groundLineNormY - m.lowestAnkleY - 0.015) / pxPerMeter,
        0,
        0.85
      );
      const ry = 0.08 + airClearance - relMinFootY;
      const rz = THREE.MathUtils.clamp((m.torsoNorm / medianTorsoNorm - 1.0) * 0.9, -0.4, 0.4);
      fr.rootPos.set(rx, ry, rz);
    } else {
      fr.rootPos.y = 0.08 - relMinFootY;
    }
    delete fr._imgMeta;
  }
}

/**
 * Extracts a 3D motion clip from an uploaded Image file (.png/.jpg/.webp)
 */
export async function extractClipFromImageFile(file, onStatus, options = {}) {
  const landmarker = await ensureLandmarker('IMAGE', onStatus, options?.delegate || 'auto');
  onStatus?.('正在解析图像 3D 骨骼...');
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();

  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 640 / Math.max(1, img.naturalWidth, img.naturalHeight));
  canvas.width = Math.max(64, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(64, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const res = landmarker.detect(canvas);
  if (!res.worldLandmarks || res.worldLandmarks.length === 0) {
    URL.revokeObjectURL(url);
    throw new Error('未在图片中检测到完整人体姿态，请上传全身清晰入镜的人物图片。');
  }

  const baseFrame = landmarksToHumanoidFrame(res.worldLandmarks[0], res.landmarks?.[0]);
  delete baseFrame._imgMeta;

  const { bones } = createBoneHierarchy();
  bones[0].position.copy(baseFrame.rootPos);
  for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(baseFrame.quats[b]);
  bones[0].updateWorldMatrix(true, true);
  const fL = new THREE.Vector3();
  const fR = new THREE.Vector3();
  bones[BONE_IDX.LeftFoot].getWorldPosition(fL);
  bones[BONE_IDX.RightFoot].getWorldPosition(fR);
  baseFrame.rootPos.y += 0.08 - Math.min(fL.y, fR.y);
  baseFrame.rootPos.x = 0;

  const totalFrames = 60;
  const frames = [];
  for (let f = 0; f < totalFrames; f++) {
    const breath = Math.sin((f / totalFrames) * Math.PI * 2) * 0.012;
    frames.push({
      rootPos: new THREE.Vector3(
        baseFrame.rootPos.x,
        baseFrame.rootPos.y + breath * 0.4,
        baseFrame.rootPos.z
      ),
      quats: baseFrame.quats.map((q) => q.clone()),
      contactL: fL.y <= fR.y + 0.06,
      contactR: fR.y <= fL.y + 0.06,
    });
  }

  return {
    clip: {
      id: 'captured_image',
      name: `图像姿态: ${file.name}`,
      fps: 30,
      totalFrames,
      duration: totalFrames / 30,
      syntheticSpeed: 0.2,
      isCombatAttack: false,
      nonCyclic: false,
      preserveRootMotion: false,
      hasWeapon: Boolean(options?.hasWeapon),
      frames,
    },
    mediaUrl: url,
    mediaType: 'image',
    ownedObjectUrl: true,
  };
}

function resolveMediaUrl(rawUrl) {
  const s = String(rawUrl || '');
  if (s.startsWith('blob:') || s.startsWith('data:')) return s;
  if (typeof window !== 'undefined' && window.location?.href) {
    return new URL(s, window.location.href).toString();
  }
  return s;
}

function releaseVideoElement(video) {
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch {
    // Ignore DOM cleanup errors
  }
}

async function loadReadyVideoElement(candidateUrls, ownedObjectUrl) {
  let lastErr = null;
  for (const rawUrl of candidateUrls) {
    const resolvedUrl = resolveMediaUrl(rawUrl);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    if (
      /^https?:\/\//i.test(resolvedUrl) &&
      typeof window !== 'undefined' &&
      !resolvedUrl.startsWith(window.location.origin)
    ) {
      video.crossOrigin = 'anonymous';
    }

    try {
      await new Promise((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          const code = video.error?.code || 'unknown';
          reject(new Error(`视频解码失败 (code=${code})，请使用 MP4 或 WebM 格式。`));
        };
        const cleanup = () => {
          video.removeEventListener('loadeddata', onReady);
          video.removeEventListener('canplay', onReady);
          video.removeEventListener('error', onError);
        };
        video.addEventListener('loadeddata', onReady);
        video.addEventListener('canplay', onReady);
        video.addEventListener('error', onError);
        video.src = resolvedUrl;
        video.load();
      });
      return { video, activeUrl: resolvedUrl };
    } catch (err) {
      releaseVideoElement(video);
      lastErr = err;
    }
  }

  if (ownedObjectUrl && candidateUrls[0]) {
    URL.revokeObjectURL(candidateUrls[0]);
  }
  throw lastErr || new Error('视频加载失败');
}

async function seekVideoSafely(video, targetSec) {
  if (Math.abs(video.currentTime - targetSec) < 0.002 && video.readyState >= 2) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', finish);
      resolve();
    };
    const timer = setTimeout(finish, 1500);
    video.addEventListener('seeked', finish);
    video.currentTime = targetSec;
  });
}

function normalizeSourceDescriptor(source) {
  if (typeof source === 'string') {
    return { candidateUrls: [source], ownedObjectUrl: false, embeddedOpts: {} };
  }
  if (Array.isArray(source)) {
    return { candidateUrls: source, ownedObjectUrl: false, embeddedOpts: {} };
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const blobUrl = URL.createObjectURL(source);
    return {
      candidateUrls: [blobUrl],
      ownedObjectUrl: true,
      embeddedOpts: {
        clipName: source.name ? `视频捕捉: ${source.name}` : '视频捕捉',
      },
    };
  }
  if (source && typeof source === 'object') {
    if (typeof Blob !== 'undefined' && source.file instanceof Blob) {
      const blobUrl = source.mediaUrl || URL.createObjectURL(source.file);
      const owned = source.ownedObjectUrl !== undefined ? Boolean(source.ownedObjectUrl) : !source.mediaUrl;
      return {
        candidateUrls: [blobUrl],
        ownedObjectUrl: owned,
        embeddedOpts: {
          clipName: source.file.name ? `视频捕捉: ${source.file.name}` : '视频捕捉',
          ...source,
        },
      };
    }
    const urls =
      source.candidateUrls ||
      source.urls ||
      (source.url ? [source.url] : source.mediaUrl ? [source.mediaUrl] : []);
    return {
      candidateUrls: Array.isArray(urls) ? urls : [urls],
      ownedObjectUrl: Boolean(source.ownedObjectUrl),
      embeddedOpts: { ...source },
    };
  }
  throw new Error('无效的视频源参数');
}

/**
 * Probes a video URL, fallback URL array, or File/Blob for duration and dimensions
 * without running MediaPipe inference. Keeps `mediaUrl` alive for PiP preview & subsequent extraction.
 */
export async function probeVideoSource(urlOrFile) {
  const { candidateUrls, ownedObjectUrl } = normalizeSourceDescriptor(urlOrFile);
  const { video, activeUrl } = await loadReadyVideoElement(candidateUrls, ownedObjectUrl);
  const videoDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const width = video.videoWidth || 0;
  const height = video.videoHeight || 0;
  releaseVideoElement(video);
  return {
    mediaUrl: activeUrl,
    videoDuration,
    width,
    height,
    ownedObjectUrl: Boolean(ownedObjectUrl),
  };
}

function cloneRawCapturedFrame(src) {
  return {
    rootPos: src.rootPos.clone(),
    quats: src.quats.map((q) => q.clone()),
    contactL: src.contactL,
    contactR: src.contactR,
    _imgMeta: src._imgMeta ? { ...src._imgMeta } : null,
  };
}

/**
 * Computes clamped trim window `[trimIn, trimOut]` and sample count for a video of `rawVideoDuration`.
 * Exported as a pure helper for deterministic unit testing.
 */
export function resolveTrimSamplingPlan(rawVideoDuration, options = {}) {
  const fullDuration = Math.max(
    0.1,
    Number.isFinite(Number(rawVideoDuration)) && Number(rawVideoDuration) > 0 ? Number(rawVideoDuration) : 3.0
  );
  const sampleFps = THREE.MathUtils.clamp(Math.round(Number(options.targetFps) || 24), 12, 60);
  const trimIn = THREE.MathUtils.clamp(Number(options.trimInSec) || 0, 0, Math.max(0, fullDuration - 0.05));

  let trimOut;
  if (
    options.trimOutSec !== null &&
    options.trimOutSec !== undefined &&
    Number.isFinite(Number(options.trimOutSec)) &&
    Number(options.trimOutSec) > 0
  ) {
    trimOut = THREE.MathUtils.clamp(
      Number(options.trimOutSec),
      Math.min(fullDuration, trimIn + 0.05),
      fullDuration
    );
  } else {
    const defaultMaxSpan = Number(options.maxDurationSec) > 0 ? Number(options.maxDurationSec) : 12.0;
    trimOut = Math.min(fullDuration, trimIn + defaultMaxSpan);
  }

  const spanSec = Math.max(0.05, trimOut - trimIn);
  const totalSamples = Math.max(4, Math.round(spanSec * sampleFps));
  return { fullDuration, sampleFps, trimIn, trimOut, spanSec, totalSamples };
}

/**
 * Shared MediaPipe Heavy 3D Video Pose Extractor supporting `[trimInSec, trimOutSec]`,
 * `targetFps` (24/30/60), monotonic timestamps, and software-WebGL CPU delegate acceleration.
 */
export async function extractClipFromVideoSource(source, onProgress, options = {}) {
  const { candidateUrls, ownedObjectUrl, embeddedOpts } = normalizeSourceDescriptor(source);

  let progressCb = typeof onProgress === 'function' ? onProgress : null;
  let explicitOpts = options && typeof options === 'object' ? options : {};
  if (onProgress && typeof onProgress === 'object' && (!options || Object.keys(options).length === 0)) {
    explicitOpts = onProgress;
    progressCb = typeof explicitOpts.onProgress === 'function' ? explicitOpts.onProgress : null;
  }

  const mergedOpts = { ...embeddedOpts, ...explicitOpts };
  if (!progressCb && typeof mergedOpts.onProgress === 'function') {
    progressCb = mergedOpts.onProgress;
  }
  const statusCb = typeof mergedOpts.onStatus === 'function' ? mergedOpts.onStatus : null;

  const landmarker = await ensureLandmarker('VIDEO', statusCb, mergedOpts.delegate || 'auto');
  statusCb?.('正在解码参考视频画面...');

  const { video, activeUrl } = await loadReadyVideoElement(candidateUrls, ownedObjectUrl);

  try {
    const { fullDuration, sampleFps, trimIn, trimOut, spanSec, totalSamples } = resolveTrimSamplingPlan(
      video.duration,
      mergedOpts
    );

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = 480;
    frameCanvas.height = Math.max(240, Math.round((480 * vh) / Math.max(1, vw)));
    const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });

    const frames = [];
    let lastValidFrame = null;
    let leadingMissing = 0;
    const clipBaseMs = Math.max(Math.round(performance.now()) + 1000, lastVideoTimestampMs + 1000);
    const safeSpan = Math.max(0.01, Math.min(spanSec, Math.max(0.01, fullDuration - trimIn - 0.008)));

    for (let i = 0; i < totalSamples; i++) {
      const u = totalSamples > 1 ? i / (totalSamples - 1) : 0;
      const t = THREE.MathUtils.clamp(trimIn + u * safeSpan, 0, Math.max(0, fullDuration - 0.005));
      await seekVideoSafely(video, t);
      frameCtx.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);

      const tsMs = advanceMonotonicVideoTimestampMs(t - trimIn, clipBaseMs);
      const res = landmarker.detectForVideo(frameCanvas, tsMs);

      if (res.worldLandmarks && res.worldLandmarks.length > 0) {
        const fr = landmarksToHumanoidFrame(res.worldLandmarks[0], res.landmarks?.[0]);
        if (leadingMissing > 0) {
          for (let m = 0; m < leadingMissing; m++) {
            frames.push(cloneRawCapturedFrame(fr));
          }
          leadingMissing = 0;
        }
        lastValidFrame = fr;
        frames.push(fr);
      } else if (lastValidFrame) {
        frames.push(cloneRawCapturedFrame(lastValidFrame));
      } else {
        leadingMissing++;
      }

      if (progressCb) {
        progressCb(Math.round(((i + 1) / totalSamples) * 100));
      }
    }

    if (frames.length === 0) {
      if (ownedObjectUrl && mergedOpts.revokeOnError !== false) {
        URL.revokeObjectURL(activeUrl);
      }
      throw new Error('视频选定区间中未检测到人体动作，请确保人物全身清晰入镜。');
    }

    calibrateVideoSequenceMetrics(frames);

    const clipId = mergedOpts.id || mergedOpts.clipId || 'captured_video';
    const clipName = mergedOpts.name || mergedOpts.clipName || mergedOpts.label || '视频捕捉';
    const hasWeapon = Boolean(mergedOpts.hasWeapon);
    const nonCyclic = mergedOpts.nonCyclic !== undefined ? Boolean(mergedOpts.nonCyclic) : true;
    const isCombatAttack = Boolean(mergedOpts.isCombatAttack);
    const preserveRootMotion =
      mergedOpts.preserveRootMotion !== undefined ? Boolean(mergedOpts.preserveRootMotion) : true;

    return {
      clip: {
        id: clipId,
        name: clipName,
        fps: sampleFps,
        totalFrames: frames.length,
        duration: spanSec,
        trimInSec: trimIn,
        trimOutSec: trimOut,
        fullVideoDuration: fullDuration,
        syntheticSpeed: mergedOpts.syntheticSpeed ?? 0.55,
        isCombatAttack,
        nonCyclic,
        preserveRootMotion,
        hasWeapon,
        frames,
      },
      mediaUrl: activeUrl,
      mediaType: 'video',
      duration: spanSec,
      fullVideoDuration: fullDuration,
      trimInSec: trimIn,
      trimOutSec: trimOut,
      ownedObjectUrl: Boolean(ownedObjectUrl),
    };
  } finally {
    releaseVideoElement(video);
  }
}

/**
 * Extracts a 3D motion sequence from an uploaded Video file (.mp4/.webm/.mov)
 */
export async function extractClipFromVideoFile(file, onProgress, options = {}) {
  let progressCb = typeof onProgress === 'function' ? onProgress : null;
  let opts = options && typeof options === 'object' ? options : {};
  if (onProgress && typeof onProgress === 'object' && (!options || Object.keys(options).length === 0)) {
    opts = onProgress;
    progressCb = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  }

  const reusableUrl = opts.existingMediaUrl || null;
  const url = reusableUrl || URL.createObjectURL(file);
  const ownedObjectUrl = !reusableUrl;

  return extractClipFromVideoSource(
    {
      candidateUrls: [url],
      ownedObjectUrl,
      revokeOnError: ownedObjectUrl,
      clipId: opts.id || opts.clipId || 'captured_video',
      clipName: opts.name || opts.clipName || `视频捕捉: ${file?.name || '本地视频'}`,
    },
    progressCb,
    opts
  );
}

/**
 * Normalizes polymorphic arguments for `extractClipFromVideoUrl`:
 *  1) `(urls, options, onProgress)` — Workbench UI legacy style
 *  2) `(url, label, onProgress, options)` — Contract 3 / M2 batch pipeline style
 *  3) `(url, onProgress, options)` — 3-arg callback-first style
 */
export function normalizeVideoUrlCallArgs(urlOrList, arg1, arg2, arg3) {
  const urls = Array.isArray(urlOrList) ? urlOrList : [urlOrList];
  let label = null;
  let onProgress = null;
  let options = {};

  if (typeof arg1 === 'string') {
    label = arg1;
    if (typeof arg2 === 'function') {
      onProgress = arg2;
      options = arg3 && typeof arg3 === 'object' ? arg3 : {};
    } else if (arg2 == null) {
      options = arg3 && typeof arg3 === 'object' ? arg3 : {};
    } else if (typeof arg2 === 'object') {
      options = arg2;
      if (typeof arg3 === 'function') onProgress = arg3;
    }
  } else if (typeof arg1 === 'function') {
    onProgress = arg1;
    options = arg2 && typeof arg2 === 'object' ? arg2 : {};
  } else if (arg1 && typeof arg1 === 'object') {
    options = arg1;
    onProgress =
      typeof arg2 === 'function'
        ? arg2
        : typeof options.onProgress === 'function'
          ? options.onProgress
          : null;
  } else if (arg1 == null) {
    if (typeof arg2 === 'function') {
      onProgress = arg2;
      options = arg3 && typeof arg3 === 'object' ? arg3 : {};
    } else if (arg2 && typeof arg2 === 'object') {
      options = arg2;
    }
  }

  const clipId =
    options.id ||
    options.clipId ||
    (label
      ? label
          .replace(/\.[^.]+$/, '')
          .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_')
          .replace(/^_+|_+$/g, '')
      : 'taibai_wushu_capture');
  const clipName = options.name || options.clipName || label || '太白剑意·武术实拍提取';
  const hasWeapon = options.hasWeapon !== undefined ? Boolean(options.hasWeapon) : true;

  return { urls, label, onProgress, options, clipId, clipName, hasWeapon };
}

/**
 * Extracts a 3D motion sequence live from built-in or workspace reference Video URL(s) (.webm / .mp4)
 */
export async function extractClipFromVideoUrl(urlOrList, arg1, arg2, arg3) {
  const { urls, onProgress, options, clipId, clipName, hasWeapon } = normalizeVideoUrlCallArgs(
    urlOrList,
    arg1,
    arg2,
    arg3
  );

  return extractClipFromVideoSource(
    {
      candidateUrls: urls,
      ownedObjectUrl: false,
      clipId,
      clipName,
      hasWeapon,
    },
    onProgress,
    { ...options, hasWeapon }
  );
}
