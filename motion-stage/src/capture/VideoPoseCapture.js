import * as THREE from 'three';
import { BONE_DEFS, BONE_IDX, createBoneHierarchy } from '../rig/HumanoidRig.js';

const NUM_BONES = BONE_DEFS.length;

let mediaPipeSdkPromise = null;
function ensureMediaPipeSdk() {
  if (!mediaPipeSdkPromise) {
    mediaPipeSdkPromise = Promise.all([
      import('@mediapipe/tasks-vision'),
      import('@mediapipe/tasks-vision/vision_wasm_module_internal.js'),
    ]).then(([visionMod, wasmFactoryMod]) => ({
      PoseLandmarker: visionMod.PoseLandmarker,
      ModuleFactory: wasmFactoryMod.default || wasmFactoryMod,
    }));
  }
  return mediaPipeSdkPromise;
}

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
  const { PoseLandmarker, ModuleFactory } = await ensureMediaPipeSdk();
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

function normalizeQuatSafe(q) {
  if (!q || !Number.isFinite(q.x + q.y + q.z + q.w) || q.lengthSq() < 1e-12) {
    return q.set(0, 0, 0, 1);
  }
  return q.normalize();
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

  // 3. Neck & Head (7 = LeftEar, 8 = RightEar, 0 = Nose) with back-view flip guard
  const earMid = new THREE.Vector3().addVectors(P[7], P[8]).multiplyScalar(0.5);
  const hX = new THREE.Vector3().subVectors(P[7], P[8]);
  if (hX.lengthSq() < 1e-8) {
    hX.copy(cX);
  } else {
    hX.normalize();
  }
  if (hX.dot(cX) < -0.25) {
    hX.lerp(cX, 0.7).normalize();
  }
  const hZ = new THREE.Vector3().subVectors(P[0], earMid);
  if (hZ.lengthSq() < 1e-8) {
    hZ.copy(cZ);
  } else {
    hZ.normalize();
    // Stabilize monocular nose-vs-ear elevation bias & prevent back-facing head flips
    if (hZ.dot(cZ) < 0.15) {
      hZ.lerp(cZ, 0.72);
    } else {
      hZ.lerp(cZ, 0.22);
    }
    if (hZ.lengthSq() < 1e-8) hZ.copy(cZ);
    else hZ.normalize();
  }
  const hY = new THREE.Vector3().crossVectors(hZ, hX);
  if (hY.lengthSq() < 1e-8) {
    hY.copy(makePerpUnit(hX, cY));
  } else {
    hY.normalize();
    if (hY.dot(cY) < 0.35) {
      hY.lerp(cY, 0.65);
      if (hY.lengthSq() < 1e-8) hY.copy(makePerpUnit(hX, cY));
      else hY.normalize();
    }
  }
  hX.crossVectors(hY, hZ);
  if (hX.lengthSq() < 1e-8) hX.copy(makePerpUnit(hY, cX));
  else hX.normalize();
  hZ.crossVectors(hX, hY).normalize();
  mat.makeBasis(hX, hY, hZ);
  const qHeadWorld = normalizeQuatSafe(new THREE.Quaternion().setFromRotationMatrix(mat));
  setBoneWorldQuat(BONE_IDX.Neck, normalizeQuatSafe(qChestWorld.clone().slerp(qHeadWorld, 0.4)));
  setBoneWorldQuat(BONE_IDX.Head, qHeadWorld);

  // Singularity-free chest-relative arm basis solver (eliminates 180-deg cross-chest/back-turn twist flips)
  const solveArmFromLandmarks = (upIdx, foreIdx, sideSign, pShoulder, pElbow, pWrist) => {
    const restDir = cX.clone().multiplyScalar(sideSign);
    const rawUpper = new THREE.Vector3().subVectors(pElbow, pShoulder);
    if (rawUpper.lengthSq() < 1e-8) {
      rawUpper.copy(restDir);
    } else {
      rawUpper.normalize();
    }

    const dotUp = THREE.MathUtils.clamp(restDir.dot(rawUpper), -1, 1);
    let qSwingArm;
    if (dotUp < -0.92) {
      qSwingArm = new THREE.Quaternion().setFromAxisAngle(cY, sideSign * Math.acos(dotUp));
    } else {
      qSwingArm = new THREE.Quaternion().setFromUnitVectors(restDir, rawUpper);
    }
    normalizeQuatSafe(qSwingArm);

    const xUp = rawUpper.clone().multiplyScalar(sideSign).normalize();
    const yBase = cY.clone().applyQuaternion(qSwingArm);
    yBase.addScaledVector(xUp, -yBase.dot(xUp));
    if (yBase.lengthSq() < 1e-8) {
      yBase.copy(makePerpUnit(xUp, cY));
    } else {
      yBase.normalize();
    }
    const zBase = new THREE.Vector3().crossVectors(xUp, yBase).normalize();

    const rawFore = new THREE.Vector3().subVectors(pWrist, pElbow);
    const hasFore = rawFore.lengthSq() >= 1e-8;
    if (hasFore) {
      rawFore.normalize();
    } else {
      rawFore.copy(rawUpper);
    }

    // Subtle bounded shoulder roll toward the elbow-bend plane when the elbow is clearly flexed
    const bend = rawFore.clone().addScaledVector(rawUpper, -rawFore.dot(rawUpper));
    const bendLen = bend.length();
    const zUp = zBase.clone();
    if (hasFore && bendLen > 0.14) {
      bend.divideScalar(bendLen);
      const twistW =
        THREE.MathUtils.smoothstep(bendLen, 0.14, 0.45) *
        THREE.MathUtils.smoothstep(bend.dot(zBase), -0.25, 0.35) *
        0.42;
      zUp.lerp(bend, twistW);
      zUp.addScaledVector(xUp, -zUp.dot(xUp));
      if (zUp.lengthSq() > 1e-8) zUp.normalize();
      else zUp.copy(zBase);
    }
    const yUp = new THREE.Vector3().crossVectors(zUp, xUp);
    if (yUp.lengthSq() < 1e-8) yUp.copy(yBase);
    else yUp.normalize();
    zUp.crossVectors(xUp, yUp).normalize();
    mat.makeBasis(xUp, yUp, zUp);
    const qUp = normalizeQuatSafe(new THREE.Quaternion().setFromRotationMatrix(mat));
    setBoneWorldQuat(upIdx, qUp);

    // Forearm inherits upper-arm twist via minimal hinge swing (zero sudden axial spin at elbow)
    const xLo = rawFore.clone().multiplyScalar(sideSign).normalize();
    const dotElb = THREE.MathUtils.clamp(xUp.dot(xLo), -1, 1);
    let qElbSwing;
    if (dotElb < -0.92) {
      qElbSwing = new THREE.Quaternion().setFromAxisAngle(yUp, Math.acos(dotElb));
    } else {
      qElbSwing = new THREE.Quaternion().setFromUnitVectors(xUp, xLo);
    }
    normalizeQuatSafe(qElbSwing);

    const yLo = yUp.clone().applyQuaternion(qElbSwing);
    yLo.addScaledVector(xLo, -yLo.dot(xLo));
    if (yLo.lengthSq() < 1e-8) {
      yLo.copy(makePerpUnit(xLo, yUp));
    } else {
      yLo.normalize();
    }
    const zLo = new THREE.Vector3().crossVectors(xLo, yLo).normalize();
    mat.makeBasis(xLo, yLo, zLo);
    const qLo = normalizeQuatSafe(new THREE.Quaternion().setFromRotationMatrix(mat));
    setBoneWorldQuat(foreIdx, qLo);

    return { qUp, qLo, foreDir: rawFore };
  };

  // 4A. Left Arm (11 -> 13 -> 15) + 6-DoF LeftHand (17 = Pinky, 19 = Index, 21 = Thumb)
  bones[BONE_IDX.LeftShoulder].quaternion.identity();
  bones[BONE_IDX.LeftShoulder].updateWorldMatrix(false, false);
  const { foreDir: foreDirL } = solveArmFromLandmarks(
    BONE_IDX.LeftUpperArm,
    BONE_IDX.LeftForeArm,
    1,
    P[11],
    P[13],
    P[15]
  );
  {
    const handDirL = new THREE.Vector3().addVectors(P[17], P[19]).multiplyScalar(0.5).sub(P[15]);
    if (handDirL.lengthSq() < 1e-8) {
      handDirL.copy(foreDirL);
    } else {
      handDirL.normalize().lerp(foreDirL, 0.28);
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

  // 4B. Right Arm (12 -> 14 -> 16) + 6-DoF RightHand calibrated to Wuxia Sword radial grip
  bones[BONE_IDX.RightShoulder].quaternion.identity();
  bones[BONE_IDX.RightShoulder].updateWorldMatrix(false, false);
  const { foreDir: foreDirR } = solveArmFromLandmarks(
    BONE_IDX.RightUpperArm,
    BONE_IDX.RightForeArm,
    -1,
    P[12],
    P[14],
    P[16]
  );
  {
    const handDirR = new THREE.Vector3().addVectors(P[18], P[20]).multiplyScalar(0.5).sub(P[16]);
    if (handDirR.lengthSq() < 1e-8) {
      handDirR.copy(foreDirR);
    } else {
      handDirR.normalize().lerp(foreDirR, 0.28);
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

  // 5. Left Leg (23 -> 25 -> 27) & Right Leg (24 -> 26 -> 28)
  // Singularity-free pelvis-swing + bounded knee-hinge + hyperextension-clamp solver (matches videoPoseSolver.mjs)
  const solveLegFromLandmarks = (upIdx, loIdx, ftIdx, pHip, pKnee, pAnkle, pHeel, pToe) => {
    const yUpper = new THREE.Vector3().subVectors(pHip, pKnee);
    if (yUpper.lengthSq() < 1e-8) yUpper.copy(vY);
    else yUpper.normalize();

    const dotUp = THREE.MathUtils.clamp(vY.dot(yUpper), -1, 1);
    let qSwingThigh;
    if (dotUp < -0.92) {
      qSwingThigh = new THREE.Quaternion().setFromAxisAngle(vX, -Math.acos(dotUp));
    } else {
      qSwingThigh = new THREE.Quaternion().setFromUnitVectors(vY, yUpper);
    }
    normalizeQuatSafe(qSwingThigh);

    const xBase = vX.clone().applyQuaternion(qSwingThigh);
    xBase.addScaledVector(yUpper, -xBase.dot(yUpper));
    if (xBase.lengthSq() < 1e-8) xBase.copy(makePerpUnit(yUpper, vX));
    else xBase.normalize();
    const zBase = new THREE.Vector3().crossVectors(xBase, yUpper).normalize();

    // Stabilize monocular heel->toe forward cue against pelvis forward vZ (eliminates flamingo knee flips)
    const rawFootFwd = new THREE.Vector3().subVectors(pToe, pHeel);
    const footFwd = vZ.clone();
    if (rawFootFwd.lengthSq() > 1e-8) {
      rawFootFwd.normalize();
      const fwdAgree = THREE.MathUtils.smoothstep(rawFootFwd.dot(vZ), -0.25, 0.35);
      footFwd.lerp(rawFootFwd, fwdAgree * 0.72);
      if (footFwd.lengthSq() < 1e-8) footFwd.copy(vZ);
      else footFwd.normalize();
    }

    // Subtle bounded hip external/internal rotation from knee-bend + foot plane (never flips >33 deg)
    const midHipAnkle = new THREE.Vector3().addVectors(pHip, pAnkle).multiplyScalar(0.5);
    const obsPole = new THREE.Vector3()
      .subVectors(pKnee, midHipAnkle)
      .addScaledVector(footFwd, 0.08);
    obsPole.addScaledVector(yUpper, -obsPole.dot(yUpper));
    const obsLen = obsPole.length();
    const zUpper = zBase.clone();
    if (obsLen > 1e-4) {
      obsPole.divideScalar(obsLen);
      const twistW =
        THREE.MathUtils.smoothstep(obsLen, 0.03, 0.12) *
        THREE.MathUtils.smoothstep(obsPole.dot(zBase), -0.15, 0.35) *
        0.52;
      zUpper.lerp(obsPole, twistW);
      zUpper.addScaledVector(yUpper, -zUpper.dot(yUpper));
      if (zUpper.lengthSq() > 1e-8) zUpper.normalize();
      else zUpper.copy(zBase);
    }
    const xUpper = new THREE.Vector3().crossVectors(yUpper, zUpper);
    if (xUpper.lengthSq() < 1e-8) xUpper.copy(xBase);
    else xUpper.normalize();
    zUpper.crossVectors(xUpper, yUpper).normalize();
    mat.makeBasis(xUpper, yUpper, zUpper);
    const qUp = normalizeQuatSafe(new THREE.Quaternion().setFromRotationMatrix(mat));
    setBoneWorldQuat(upIdx, qUp);

    // Lower leg shares xUpper knee-hinge axis (zero 180-deg shin twist) with hyperextension clamp
    const yLower = new THREE.Vector3().subVectors(pKnee, pAnkle);
    if (yLower.lengthSq() < 1e-8) yLower.copy(yUpper);
    else yLower.normalize();
    const hyper = yLower.dot(zUpper);
    if (hyper < -0.03) {
      yLower.addScaledVector(zUpper, -hyper - 0.03);
      if (yLower.lengthSq() < 1e-8) yLower.copy(yUpper);
      else yLower.normalize();
    }
    const xLower = xUpper.clone().addScaledVector(yLower, -xUpper.dot(yLower));
    if (xLower.lengthSq() < 1e-8) xLower.copy(makePerpUnit(yLower, xUpper));
    else xLower.normalize();
    const zLower = new THREE.Vector3().crossVectors(xLower, yLower).normalize();
    mat.makeBasis(xLower, yLower, zLower);
    const qLo = normalizeQuatSafe(new THREE.Quaternion().setFromRotationMatrix(mat));
    setBoneWorldQuat(loIdx, qLo);

    // Foot uses shared ankle hinge axis xLower (avoids world-up cross singularity on steep kicks/splits)
    const fZ = zLower.clone().lerp(footFwd, 0.55);
    if (fZ.dot(zLower) < 0.25) {
      fZ.lerp(zLower, 0.65);
    }
    if (fZ.lengthSq() < 1e-8) fZ.copy(zLower);
    else fZ.normalize();
    const fY = new THREE.Vector3().crossVectors(fZ, xLower);
    if (fY.lengthSq() < 1e-8) fY.copy(makePerpUnit(fZ, yLower));
    else fY.normalize();
    const fX = new THREE.Vector3().crossVectors(fY, fZ);
    if (fX.lengthSq() < 1e-8) fX.copy(xLower);
    else fX.normalize();
    fY.crossVectors(fZ, fX).normalize();
    mat.makeBasis(fX, fY, fZ);
    setBoneWorldQuat(ftIdx, normalizeQuatSafe(new THREE.Quaternion().setFromRotationMatrix(mat)));
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
 * Suppresses isolated 1-frame monocular MediaPipe glitch spikes and aligns quaternion hemisphere signs
 * across consecutive frames without dulling intentional fast martial arts strikes.
 */
export function stabilizeCapturedSequence(frames) {
  if (!frames || frames.length < 2) return;

  // 1. Enforce shortest-arc quaternion sign continuity
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1].quats;
    const curr = frames[i].quats;
    for (let b = 0; b < NUM_BONES; b++) {
      if (curr[b].dot(prev[b]) < 0) {
        curr[b].set(-curr[b].x, -curr[b].y, -curr[b].z, -curr[b].w);
      }
    }
  }

  if (frames.length < 3) return;

  // 2. Reject isolated single-frame landmark glitches (V-spike where neighbors agree within 32 deg)
  const cosNeighborAgree = Math.cos((32 * Math.PI) / 180 / 2);
  const cosSpikeThresh = Math.cos((46 * Math.PI) / 180 / 2);
  const qMid = new THREE.Quaternion();

  for (let i = 1; i < frames.length - 1; i++) {
    const qPrev = frames[i - 1].quats;
    const qCurr = frames[i].quats;
    const qNext = frames[i + 1].quats;
    for (let b = 0; b < NUM_BONES; b++) {
      const dotPN = Math.abs(qPrev[b].dot(qNext[b]));
      if (dotPN >= cosNeighborAgree) {
        const dotPC = Math.abs(qPrev[b].dot(qCurr[b]));
        const dotCN = Math.abs(qCurr[b].dot(qNext[b]));
        if (dotPC < cosSpikeThresh && dotCN < cosSpikeThresh) {
          qMid.copy(qPrev[b]).slerp(qNext[b], 0.5);
          normalizeQuatSafe(qMid);
          if (qMid.dot(qPrev[b]) < 0) {
            qMid.set(-qMid.x, -qMid.y, -qMid.z, -qMid.w);
          }
          qCurr[b].copy(qMid);
        }
      }
    }
  }
}

/**
 * Calibrates metric stride scale (pxPerMeter), perspective-aware studio floor line,
 * genuine aerial jump clearance, and subtle depth lunge (rz) across an extracted sequence.
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

  // Perspective-aware local sliding-window floor line (±14 frames 88th percentile of lowestAnkleY)
  // Prevents perspective levitation when performers step deeper into the studio while preserving true jumps.
  const winHalf = Math.min(14, Math.max(2, Math.floor(frames.length / 4)));
  const localFloorY = frames.map((_, idx) => {
    const samples = [];
    const s0 = Math.max(0, idx - winHalf);
    const s1 = Math.min(frames.length - 1, idx + winHalf);
    for (let k = s0; k <= s1; k++) {
      if (frames[k]._imgMeta) samples.push(frames[k]._imgMeta.lowestAnkleY);
    }
    return samples.length > 0 ? percentile(samples, 0.88) : 0.8;
  });

  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i];
    bones[0].position.set(0, 0, 0);
    for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(fr.quats[b]);
    bones[0].updateWorldMatrix(true, true);
    bones[BONE_IDX.LeftFoot].getWorldPosition(pL);
    bones[BONE_IDX.RightFoot].getWorldPosition(pR);
    const relMinFootY = Math.min(pL.y, pR.y);

    if (fr._imgMeta) {
      const m = fr._imgMeta;
      const rx = THREE.MathUtils.clamp((m.hipX - centerHipNormX) / pxPerMeter, -1.65, 1.65);
      // Require genuine lift (> 4.5% of image height above local floor line) before granting aerial clearance
      const rawLift = localFloorY[i] - m.lowestAnkleY;
      const airClearance =
        rawLift > 0.045
          ? THREE.MathUtils.clamp((rawLift - 0.035) / pxPerMeter, 0, 0.85)
          : 0;
      const ry = 0.08 + airClearance - relMinFootY;
      const rz = THREE.MathUtils.clamp((m.torsoNorm / medianTorsoNorm - 1.0) * 0.75, -0.35, 0.35);
      fr.rootPos.set(rx, ry, rz);
    } else {
      fr.rootPos.y = 0.08 - relMinFootY;
    }
    delete fr._imgMeta;
  }
}

function alignCapturedSequenceToPlusZ(frames, useWholeClipMean = false) {
  if (!frames || frames.length === 0) return;
  const { bones } = createBoneHierarchy();
  const sampleEnd = useWholeClipMean ? frames.length : Math.min(frames.length, 6);
  const sumFwd = new THREE.Vector3();
  const qH = new THREE.Quaternion();
  const qC = new THREE.Quaternion();
  const fH = new THREE.Vector3();
  const fC = new THREE.Vector3();

  for (let i = 0; i < sampleEnd; i++) {
    const fr = frames[i];
    bones[0].position.set(0, 0, 0);
    for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(fr.quats[b]);
    bones[0].updateWorldMatrix(true, true);
    bones[BONE_IDX.Hips].getWorldQuaternion(qH);
    bones[BONE_IDX.Chest].getWorldQuaternion(qC);
    fH.set(0, 0, 1).applyQuaternion(qH);
    fC.set(0, 0, 1).applyQuaternion(qC);
    fH.y = 0;
    fC.y = 0;
    if (fH.lengthSq() > 1e-5) sumFwd.add(fH.normalize());
    if (fC.lengthSq() > 1e-5) sumFwd.add(fC.normalize());
  }

  const baseYaw = sumFwd.lengthSq() > 1e-5 ? Math.atan2(sumFwd.x, sumFwd.z) : 0;
  const qRotY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -baseYaw);
  const p0x = frames[0].rootPos.x;
  const p0z = frames[0].rootPos.z;
  const delta = new THREE.Vector3();

  for (const fr of frames) {
    delta.set(fr.rootPos.x - p0x, 0, fr.rootPos.z - p0z).applyQuaternion(qRotY);
    fr.rootPos.x = p0x + delta.x;
    fr.rootPos.z = p0z + delta.z;
    fr.quats[BONE_IDX.Hips].premultiply(qRotY).normalize();
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

const BUNDLED_WEBM_KEYS = new Set(['02', '03', '04', '06', '07', '08', '09']);

function safeDecodeUri(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function detectBrowserPrefersWebm(videoEl = null) {
  try {
    const v =
      videoEl ||
      (typeof document !== 'undefined' && typeof document.createElement === 'function'
        ? document.createElement('video')
        : null);
    if (!v || typeof v.canPlayType !== 'function') return true;
    const canVp9 = Boolean(v.canPlayType('video/webm; codecs="vp9"'));
    const canWebm = Boolean(v.canPlayType('video/webm'));
    return canVp9 || canWebm;
  } catch {
    return true;
  }
}

/**
 * Maps workspace `/reference_videos/<key>_*.mp4` URLs to an ordered list of
 * pure-ASCII, open-codec VP9 `.webm` and `.mp4` candidates so playback works
 * identically in open-source Chromium/Electron Preview (no proprietary H.264),
 * Chrome, Edge, Firefox, Safari, and reverse-proxied environments.
 */
export function resolveCompatVideoCandidates(rawUrlOrList, options = {}) {
  const inputList = Array.isArray(rawUrlOrList) ? rawUrlOrList : [rawUrlOrList];
  const preferWebm =
    options.preferWebm !== undefined ? Boolean(options.preferWebm) : detectBrowserPrefersWebm(options.videoEl);
  const out = [];
  const seen = new Set();
  const pushUnique = (u) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  for (const item of inputList) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    if (raw.startsWith('blob:') || raw.startsWith('data:')) {
      pushUnique(raw);
      continue;
    }

    const decoded = safeDecodeUri(raw);
    const refMatch = /(?:^|\/)reference_videos\/([0-9a-zA-Z]+)_[^/]+\.mp4(?:[?#].*)?$/i.exec(decoded);
    if (refMatch) {
      const key = refMatch[1];
      const encodedOrig = raw.includes('%') ? raw : encodeURI(raw);
      const webmUrls = [`/video_compat/${key}.webm`];
      const mp4Urls = [`/video_compat/${key}.mp4`, encodedOrig];

      if (preferWebm) {
        webmUrls.forEach(pushUnique);
        mp4Urls.forEach(pushUnique);
      } else {
        mp4Urls.forEach(pushUnique);
        webmUrls.forEach(pushUnique);
      }
      continue;
    }

    pushUnique(raw.includes('%') ? raw : encodeURI(raw));
  }

  return out;
}

function waitVideoElementReady(video, timeoutMs = 6500) {
  if (video.readyState >= 2 && video.videoWidth > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => {
      if (settled) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const code = video.error?.code || 'unknown';
      reject(new Error(`视频解码失败 (code=${code})`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      if (video.readyState >= 2 && video.videoWidth > 0) {
        resolve();
      } else {
        reject(new Error('视频加载超时'));
      }
    }, timeoutMs);

    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onError);
  });
}

const spriteFilmstripCache = new Map();

/**
 * Resolves a workspace `/reference_videos/<key>_*.mp4` URL to its pre-baked or
 * on-demand 12fps JPEG Filmstrip Sprite Sheet + JSON manifest.
 * Sprite sheets render via standard `image/jpeg` + 2D `<canvas>` so reference playback
 * works with zero codec / `<video>` / Range-request / CSP issues in any preview pane.
 */
export function resolveSpritePreviewUrls(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) return null;
  const decoded = safeDecodeUri(raw);
  const refMatch = /(?:^|\/)reference_videos\/([0-9a-zA-Z]+)_[^/]+\.mp4(?:[?#].*)?$/i.exec(decoded);
  if (!refMatch) return null;
  const key = refMatch[1];
  if (BUNDLED_WEBM_KEYS.has(key)) {
    return {
      key,
      metaUrl: `/demo/sprites/${key}.json`,
      imgUrl: `/demo/sprites/${key}.jpg`,
      fallbackMetaUrl: `/video_compat/${key}.json`,
      fallbackImgUrl: `/video_compat/${key}.jpg`,
    };
  }
  return {
    key,
    metaUrl: `/video_compat/${key}.json`,
    imgUrl: `/video_compat/${key}.jpg`,
    fallbackMetaUrl: null,
    fallbackImgUrl: null,
  };
}

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function loadImageWithTimeout(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    let settled = false;
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (ok) resolve(img);
      else reject(err || new Error('图片解码失败'));
    };
    const timer = setTimeout(() => done(false, new Error('原片图集加载超时')), timeoutMs);
    img.onload = () => done(true);
    img.onerror = () => done(false, new Error('原片图集加载失败'));
    img.src = url;
  });
}

/**
 * Loads (and caches) a 12fps JPEG Filmstrip Sprite Sheet for a built-in reference video.
 */
export async function loadSpriteFilmstrip(rawUrl) {
  const spec = resolveSpritePreviewUrls(rawUrl);
  if (!spec) return null;
  if (spriteFilmstripCache.has(spec.key)) {
    return spriteFilmstripCache.get(spec.key);
  }

  let meta = null;
  let img = null;
  let activeImgUrl = spec.imgUrl;
  try {
    [meta, img] = await Promise.all([
      fetchJsonWithTimeout(resolveMediaUrl(spec.metaUrl), 8000),
      loadImageWithTimeout(resolveMediaUrl(spec.imgUrl), 12000),
    ]);
  } catch (err) {
    if (spec.fallbackMetaUrl && spec.fallbackImgUrl) {
      activeImgUrl = spec.fallbackImgUrl;
      [meta, img] = await Promise.all([
        fetchJsonWithTimeout(resolveMediaUrl(spec.fallbackMetaUrl), 8000),
        loadImageWithTimeout(resolveMediaUrl(spec.fallbackImgUrl), 12000),
      ]);
    } else {
      throw err;
    }
  }

  const frameCount = Math.max(1, Number(meta.frameCount) || 1);
  const cols = Math.max(1, Number(meta.cols) || 8);
  const tileW = Math.max(16, Number(meta.tileW) || 384);
  const tileH = Math.max(16, Number(meta.tileH) || 216);
  const fps = Math.max(1, Number(meta.fps) || 12);
  const duration = Math.max(0.1, Number(meta.duration) || frameCount / fps);
  const startSec = Number(meta.startSec) || 0;

  const filmstrip = {
    kind: 'sprite',
    key: spec.key,
    activeUrl: resolveMediaUrl(activeImgUrl),
    meta: { ...meta, frameCount, cols, tileW, tileH, fps, duration, startSec },
    img,
    drawFrameIndex(ctx, frameIdx, dstW, dstH) {
      const i = Math.max(0, Math.min(frameCount - 1, Math.round(frameIdx)));
      const col = i % cols;
      const row = Math.floor(i / cols);
      const w = dstW || ctx.canvas.width || tileW;
      const h = dstH || ctx.canvas.height || tileH;
      ctx.drawImage(img, col * tileW, row * tileH, tileW, tileH, 0, 0, w, h);
      return i;
    },
    drawFrameAtSec(ctx, localSec, dstW, dstH) {
      const clamped = Math.max(0, Math.min(duration, Number(localSec) || 0));
      const idx = Math.min(frameCount - 1, Math.floor((clamped / Math.max(0.001, duration)) * frameCount));
      return filmstrip.drawFrameIndex(ctx, idx, dstW, dstH);
    },
  };

  spriteFilmstripCache.set(spec.key, filmstrip);
  return filmstrip;
}

/**
 * Resiliently binds a video URL (or candidate list) to an existing `<video>` element.
 * Uses pure-ASCII VP9 WebM first and loads short clips into an in-memory `blob:` URL
 * via `fetch()` so playback & frame-stepping work reliably even behind remote proxies
 * or inside Electron/Chromium previews without H.264 decoders.
 */
export async function bindVideoElementWithFallback(videoEl, rawUrlOrList, options = {}) {
  const candidates = resolveCompatVideoCandidates(rawUrlOrList, {
    videoEl,
    preferWebm: options.preferWebm,
  });
  const isStale = typeof options.isStale === 'function' ? options.isStale : () => false;
  const preferBlob = options.preferBlob !== false;
  let lastErr = null;

  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.preload = 'auto';

  for (const rawCandidate of candidates) {
    if (isStale()) return { ok: false, stale: true };
    const resolvedUrl = resolveMediaUrl(rawCandidate);
    const isLocalBlob = resolvedUrl.startsWith('blob:') || resolvedUrl.startsWith('data:');
    const isLargeReel = /\/05\.(webm|mp4)(\?|$)|05_/.test(resolvedUrl);

    // Strategy 1: Fetch short clips into an in-memory Blob URL (immune to proxy Range/206 quirks)
    if (preferBlob && !isLocalBlob && !isLargeReel && typeof fetch === 'function') {
      let blobUrl = null;
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const fetchTimer = ctrl ? setTimeout(() => ctrl.abort(), 4500) : null;
      try {
        const resp = await fetch(resolvedUrl, ctrl ? { signal: ctrl.signal } : undefined);
        if (fetchTimer) clearTimeout(fetchTimer);
        if (isStale()) return { ok: false, stale: true };
        const ct = String(resp.headers?.get?.('content-type') || '');
        if (!resp.ok || /text\/html/i.test(ct)) {
          throw new Error(`HTTP ${resp.status} (${ct || 'unknown'})`);
        }
        const buf = await resp.arrayBuffer();
        if (isStale()) return { ok: false, stale: true };
        if (buf.byteLength < 1024) {
          throw new Error(`视频体过小 (${buf.byteLength}B)`);
        }
        const mime = /\.webm(\?|$)/i.test(resolvedUrl) ? 'video/webm' : 'video/mp4';
        blobUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
        videoEl.pause();
        videoEl.src = blobUrl;
        videoEl.load();
        await waitVideoElementReady(videoEl, 4000);
        if (isStale()) {
          URL.revokeObjectURL(blobUrl);
          return { ok: false, stale: true };
        }
        if (options.paintFirstFrame !== false && videoEl.duration > 0.08 && videoEl.currentTime === 0) {
          try {
            videoEl.currentTime = 0.04;
          } catch {
            // Ignore seek failure
          }
        }
        return {
          ok: true,
          activeUrl: resolvedUrl,
          mediaUrl: blobUrl,
          ownedBlobUrl: blobUrl,
          duration: Number.isFinite(videoEl.duration) ? videoEl.duration : 0,
          videoWidth: videoEl.videoWidth || 0,
          videoHeight: videoEl.videoHeight || 0,
        };
      } catch (err) {
        if (fetchTimer) clearTimeout(fetchTimer);
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        lastErr = err;
        // If fetch failed due to CORS/network, still try direct <video src> below for this candidate
      }
    }

    // Strategy 2: Direct streaming <video src="...">
    try {
      if (isStale()) return { ok: false, stale: true };
      videoEl.pause();
      if (
        /^https?:\/\//i.test(resolvedUrl) &&
        typeof window !== 'undefined' &&
        !resolvedUrl.startsWith(window.location.origin)
      ) {
        videoEl.crossOrigin = 'anonymous';
      } else {
        videoEl.removeAttribute('crossorigin');
      }
      videoEl.src = resolvedUrl;
      videoEl.load();
      await waitVideoElementReady(videoEl, isLargeReel ? 12000 : 7500);
      if (isStale()) return { ok: false, stale: true };
      if (options.paintFirstFrame !== false && videoEl.duration > 0.08 && videoEl.currentTime === 0) {
        try {
          videoEl.currentTime = 0.04;
        } catch {
          // Ignore seek failure
        }
      }
      return {
        ok: true,
        activeUrl: resolvedUrl,
        mediaUrl: resolvedUrl,
        ownedBlobUrl: null,
        duration: Number.isFinite(videoEl.duration) ? videoEl.duration : 0,
        videoWidth: videoEl.videoWidth || 0,
        videoHeight: videoEl.videoHeight || 0,
      };
    } catch (err) {
      lastErr = err;
    }
  }

  return {
    ok: false,
    stale: false,
    error: lastErr || new Error('视频加载失败，请尝试切换片源或上传本地 WebM/MP4 视频。'),
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
  const compatUrls = resolveCompatVideoCandidates(candidateUrls);
  const expandedUrls = [];
  const seen = new Set();
  for (const u of [...candidateUrls, ...compatUrls]) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    expandedUrls.push(u);
  }
  let lastErr = null;
  for (const rawUrl of expandedUrls) {
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
      video.src = resolvedUrl;
      video.load();
      await waitVideoElementReady(video, 10000);
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
    frameCanvas.width = Math.min(640, Math.max(480, vw));
    frameCanvas.height = Math.max(240, Math.round((frameCanvas.width * vh) / Math.max(1, vw)));
    const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });

    const frames = [];
    let lastValidFrame = null;
    let leadingMissing = 0;
    let detectedFrames = 0;
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
        detectedFrames++;
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

    stabilizeCapturedSequence(frames);
    calibrateVideoSequenceMetrics(frames);
    alignCapturedSequenceToPlusZ(frames, !Boolean(mergedOpts.nonCyclic ?? true));
    const detectionRate = totalSamples > 0 ? detectedFrames / totalSamples : 0;

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
      detectedFrames,
      detectionRate,
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

function captureMediaThumbnailDataUrl(source, thumbW = 192, spriteSec = 0) {
  const isSprite = source && source.kind === 'sprite' && typeof source.drawFrameAtSec === 'function';
  const vw = Math.max(
    1,
    isSprite ? source.meta.tileW : source.videoWidth || source.width || 640
  );
  const vh = Math.max(
    1,
    isSprite ? source.meta.tileH : source.videoHeight || source.height || 360
  );
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbW;
  thumbCanvas.height = Math.max(90, Math.round((thumbW * vh) / vw));
  const ctx = thumbCanvas.getContext('2d');
  if (isSprite) {
    source.drawFrameAtSec(ctx, spriteSec, thumbCanvas.width, thumbCanvas.height);
  } else {
    ctx.drawImage(source, 0, 0, thumbCanvas.width, thumbCanvas.height);
  }
  return thumbCanvas.toDataURL('image/jpeg', 0.78);
}

/**
 * Extracts a single 3D 29-bone keyframe pose + JPEG thumbnail from the current frame
 * (or optional `targetTimeSec`) of a mounted HTMLVideoElement, HTMLCanvasElement, or Sprite Filmstrip.
 */
export async function extractPoseFromVideoElement(mediaSource, options = {}) {
  if (!mediaSource) throw new Error('未找到视频画面元素');
  const isSprite = mediaSource.kind === 'sprite' && typeof mediaSource.drawFrameAtSec === 'function';
  const isVideoEl = !isSprite && typeof mediaSource.play === 'function';

  let localTimeSec = Number(options.timestampSec ?? options.targetTimeSec ?? 0) || 0;
  if (isVideoEl) {
    if (
      options.targetTimeSec !== undefined &&
      options.targetTimeSec !== null &&
      Number.isFinite(Number(options.targetTimeSec))
    ) {
      await seekVideoSafely(mediaSource, Math.max(0, Number(options.targetTimeSec)));
    }
    localTimeSec = Number(mediaSource.currentTime) || 0;
  }

  const timestampSec = isSprite ? (mediaSource.meta.startSec || 0) + localTimeSec : localTimeSec;
  const thumbnailDataUrl = captureMediaThumbnailDataUrl(mediaSource, 192, localTimeSec);

  const landmarker = await ensureLandmarker('IMAGE', options.onStatus, options.delegate || 'auto');
  const vw = Math.max(
    1,
    isSprite ? mediaSource.meta.tileW : mediaSource.videoWidth || mediaSource.width || 640
  );
  const vh = Math.max(
    1,
    isSprite ? mediaSource.meta.tileH : mediaSource.videoHeight || mediaSource.height || 360
  );
  const inferCanvas = document.createElement('canvas');
  inferCanvas.width = Math.min(640, Math.max(480, vw));
  inferCanvas.height = Math.max(240, Math.round((inferCanvas.width * vh) / vw));
  const inferCtx = inferCanvas.getContext('2d', { willReadFrequently: true });
  if (isSprite) {
    mediaSource.drawFrameAtSec(inferCtx, localTimeSec, inferCanvas.width, inferCanvas.height);
  } else {
    inferCtx.drawImage(mediaSource, 0, 0, inferCanvas.width, inferCanvas.height);
  }

  const res = landmarker.detect(inferCanvas);
  if (!res.worldLandmarks || res.worldLandmarks.length === 0) {
    return {
      detected: false,
      timestampSec,
      thumbnailDataUrl,
      rootPos: new THREE.Vector3(0, 0.94, 0),
      quats: Array.from({ length: NUM_BONES }, () => new THREE.Quaternion()),
    };
  }

  const frame = landmarksToHumanoidFrame(res.worldLandmarks[0], res.landmarks?.[0]);
  const meta = frame._imgMeta;
  delete frame._imgMeta;

  if (options.alignPlusZ !== false) {
    alignCapturedSequenceToPlusZ([frame], true);
  }

  // Snap lowest ankle cleanly to floor unless performer is visibly airborne in image
  const { bones } = createBoneHierarchy();
  bones[0].position.copy(frame.rootPos);
  for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(frame.quats[b]);
  bones[0].updateWorldMatrix(true, true);
  const pL = new THREE.Vector3();
  const pR = new THREE.Vector3();
  bones[BONE_IDX.LeftFoot].getWorldPosition(pL);
  bones[BONE_IDX.RightFoot].getWorldPosition(pR);
  const minFootY = Math.min(pL.y, pR.y);
  const isAir = meta && meta.lowestAnkleY < 0.66;
  const targetFloor = isAir ? 0.24 : 0.08;
  frame.rootPos.y += targetFloor - minFootY;
  frame.rootPos.x = THREE.MathUtils.clamp(frame.rootPos.x * 0.45, -0.65, 0.65);

  return {
    detected: true,
    timestampSec,
    thumbnailDataUrl,
    rootPos: frame.rootPos,
    quats: frame.quats,
  };
}

/**
 * Scans `[trimInSec, trimOutSec]` on a Sprite Filmstrip or HTMLVideoElement, solves the metric-calibrated
 * sequence, and returns `targetCount` salient keyframes with thumbnails and real segment durations.
 */
export async function extractSalientKeyframesFromVideoElement(mediaSource, options = {}) {
  if (!mediaSource) throw new Error('未找到视频画面元素');
  const isSprite = mediaSource.kind === 'sprite' && typeof mediaSource.drawFrameAtSec === 'function';
  const fullDur = isSprite
    ? Math.max(0.2, mediaSource.meta.duration)
    : Number.isFinite(mediaSource.duration) && mediaSource.duration > 0
      ? mediaSource.duration
      : 4.0;
  const trimIn = isSprite
    ? 0
    : THREE.MathUtils.clamp(Number(options.trimInSec) || 0, 0, Math.max(0, fullDur - 0.1));
  const trimOut = isSprite
    ? fullDur
    : THREE.MathUtils.clamp(
        options.trimOutSec !== undefined && options.trimOutSec !== null
          ? Number(options.trimOutSec)
          : Math.min(fullDur, trimIn + 6.5),
        Math.min(fullDur, trimIn + 0.2),
        fullDur
      );
  const targetCount = THREE.MathUtils.clamp(Math.round(Number(options.targetCount) || 5), 3, 9);
  const sampleFps = isSprite
    ? Math.min(mediaSource.meta.fps || 12, THREE.MathUtils.clamp(Math.round(Number(options.sampleFps) || 10), 6, 12))
    : THREE.MathUtils.clamp(Math.round(Number(options.sampleFps) || 10), 6, 24);
  const spanSec = Math.max(0.2, trimOut - trimIn);
  const totalSamples = isSprite
    ? Math.max(targetCount, Math.min(mediaSource.meta.frameCount, Math.round(spanSec * sampleFps)))
    : Math.max(targetCount, Math.round(spanSec * sampleFps));

  const landmarker = await ensureLandmarker('VIDEO', options.onStatus, options.delegate || 'auto');
  const vw = Math.max(1, isSprite ? mediaSource.meta.tileW : mediaSource.videoWidth || 640);
  const vh = Math.max(1, isSprite ? mediaSource.meta.tileH : mediaSource.videoHeight || 360);
  const inferCanvas = document.createElement('canvas');
  inferCanvas.width = Math.min(640, Math.max(480, vw));
  inferCanvas.height = Math.max(240, Math.round((inferCanvas.width * vh) / vw));
  const inferCtx = inferCanvas.getContext('2d', { willReadFrequently: true });

  const frames = [];
  const sampleTimes = [];
  let lastValid = null;
  let leadingMiss = 0;
  const clipBaseMs = Math.max(Math.round(performance.now()) + 1000, lastVideoTimestampMs + 1000);
  const safeSpan = Math.max(0.05, Math.min(spanSec, Math.max(0.05, fullDur - trimIn - 0.01)));

  for (let i = 0; i < totalSamples; i++) {
    const u = totalSamples > 1 ? i / (totalSamples - 1) : 0;
    const t = THREE.MathUtils.clamp(trimIn + u * safeSpan, 0, Math.max(0, fullDur - 0.008));
    sampleTimes.push(t);
    if (isSprite) {
      mediaSource.drawFrameAtSec(inferCtx, t, inferCanvas.width, inferCanvas.height);
    } else {
      await seekVideoSafely(mediaSource, t);
      inferCtx.drawImage(mediaSource, 0, 0, inferCanvas.width, inferCanvas.height);
    }

    const tsMs = advanceMonotonicVideoTimestampMs(t - trimIn, clipBaseMs);
    const res = landmarker.detectForVideo(inferCanvas, tsMs);
    if (res.worldLandmarks && res.worldLandmarks.length > 0) {
      const fr = landmarksToHumanoidFrame(res.worldLandmarks[0], res.landmarks?.[0]);
      if (leadingMiss > 0) {
        for (let m = 0; m < leadingMiss; m++) frames.push(cloneRawCapturedFrame(fr));
        leadingMiss = 0;
      }
      lastValid = fr;
      frames.push(fr);
    } else if (lastValid) {
      frames.push(cloneRawCapturedFrame(lastValid));
    } else {
      leadingMiss++;
    }
    options.onProgress?.(Math.round(((i + 1) / totalSamples) * 100));
  }

  if (frames.length === 0) {
    throw new Error('视频区间未检测到清晰全身姿态，请切换更清晰的全身画面片段。');
  }

  stabilizeCapturedSequence(frames);
  calibrateVideoSequenceMetrics(frames);
  alignCapturedSequenceToPlusZ(frames, false);

  // Pick salient indices (endpoints + max turning/inflection poses)
  const { selectSalientKeyframeIndices } = await import('../keyframe/KeyframeInbetweener.js');
  const indices = selectSalientKeyframeIndices(frames, targetCount);

  const outKeyframes = [];
  for (let k = 0; k < indices.length; k++) {
    const idx = indices[k];
    const nextIdx = k < indices.length - 1 ? indices[k + 1] : idx;
    const tSec = sampleTimes[Math.min(sampleTimes.length - 1, idx)] ?? trimIn;
    const nextSec = sampleTimes[Math.min(sampleTimes.length - 1, nextIdx)] ?? tSec + 0.35;
    if (!isSprite) {
      await seekVideoSafely(mediaSource, tSec);
    }
    const thumbnailDataUrl = captureMediaThumbnailDataUrl(mediaSource, 192, tSec);
    const srcFr = frames[idx];
    const displayTime = isSprite ? (mediaSource.meta.startSec || 0) + tSec : tSec;
    outKeyframes.push({
      sourceTimeSec: +displayTime.toFixed(2),
      durationToNext: THREE.MathUtils.clamp(+(nextSec - tSec).toFixed(2) || 0.38, 0.14, 1.8),
      thumbnailDataUrl,
      rootPos: srcFr.rootPos.clone(),
      quats: srcFr.quats.map((q) => q.clone()),
    });
  }

  return outKeyframes;
}


