import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { MOTION_STAGE_ROOT, VITE_BIN } from './constants.mjs';

const THREE_ESM_PATH = path.join(MOTION_STAGE_ROOT, 'node_modules/three/build/three.module.js');
const BVH_LOADER_ESM_PATH = path.join(
  MOTION_STAGE_ROOT,
  'node_modules/three/examples/jsm/loaders/BVHLoader.js'
);

let cachedThree = null;
let cachedBVHLoader = null;
let sharedViteBuild = null; // { shmOutDir, stdout, stderr, distBefore, distAfter }
let buildHooksInstalled = false;

export async function importThree() {
  if (!cachedThree) {
    cachedThree = await import(pathToFileURL(THREE_ESM_PATH).href);
  }
  return cachedThree;
}

export async function importBVHLoader() {
  if (!cachedBVHLoader) {
    const mod = await import(pathToFileURL(BVH_LOADER_ESM_PATH).href);
    cachedBVHLoader = mod.BVHLoader;
  }
  return cachedBVHLoader;
}

export async function safeImport(absPathOrUrl) {
  const fileUrl = absPathOrUrl.startsWith('file://')
    ? absPathOrUrl
    : pathToFileURL(path.resolve(absPathOrUrl)).href;
  try {
    const mod = await import(fileUrl);
    return { ok: true, mod, error: null };
  } catch (error) {
    return { ok: false, mod: null, error };
  }
}

export function requireExport(importResult, exportName, moduleLabel) {
  assert.ok(
    importResult && importResult.ok && importResult.mod,
    `Failed to import ${moduleLabel}: ${importResult?.error?.stack || importResult?.error?.message || 'unknown error'}`
  );
  assert.notEqual(
    importResult.mod[exportName],
    undefined,
    `Missing required public export "${exportName}" on ${moduleLabel} (available exports: [${Object.keys(importResult.mod).join(', ')}])`
  );
  return importResult.mod[exportName];
}

export async function loadModuleContract(relPathFromMotionStage, requiredExports = []) {
  const absPath = path.resolve(MOTION_STAGE_ROOT, relPathFromMotionStage);
  if (!fs.existsSync(absPath)) {
    assert.fail(`Missing required contract module: ${absPath}`);
  }
  const res = await safeImport(absPath);
  if (!res.ok) {
    assert.fail(
      `Failed to import contract module ${absPath}: ${res.error?.stack || res.error?.message}`
    );
  }
  for (const expName of requiredExports) {
    requireExport(res, expName, relPathFromMotionStage);
  }
  return res.mod;
}

/**
 * Unwraps retargetBVHToFrames return value supporting both Frame[] (PROJECT.md §3)
 * and { frames, totalFrames, fps } (MotionClips.js legacy/composite return),
 * and validates canonical 29-bone runtime Frame contract.
 */
export async function unwrapRetargetFrames(res, label = 'retargetBVHToFrames') {
  const THREE = await importThree();
  const frames = Array.isArray(res) ? res : res?.frames;
  assert.ok(
    Array.isArray(frames) && frames.length > 0,
    `[${label}] Expected non-empty Frame[] or { frames: Frame[] }, got ${typeof res}`
  );
  const sampleIndices = [0, Math.floor(frames.length / 2), frames.length - 1];
  for (const idx of sampleIndices) {
    const fr = frames[idx];
    assert.ok(fr && typeof fr === 'object', `[${label}] Frame ${idx} is not an object`);
    assert.ok(
      fr.rootPos instanceof THREE.Vector3 ||
        (fr.rootPos && Number.isFinite(fr.rootPos.x) && Number.isFinite(fr.rootPos.y) && Number.isFinite(fr.rootPos.z)),
      `[${label}] Frame ${idx} rootPos invalid`
    );
    assert.ok(
      Array.isArray(fr.quats) && fr.quats.length === 29,
      `[${label}] Frame ${idx} quats must have length 29, got ${fr.quats?.length}`
    );
    for (let b = 0; b < 29; b++) {
      const q = fr.quats[b];
      assert.ok(
        q && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w),
        `[${label}] Frame ${idx} bone ${b} quaternion contains non-finite component`
      );
      const norm = Math.hypot(q.x, q.y, q.z, q.w);
      assert.ok(
        Math.abs(norm - 1) <= 1e-3,
        `[${label}] Frame ${idx} bone ${b} quaternion not unit length: ${norm}`
      );
    }
    assert.ok(
      fr.contactL === null || typeof fr.contactL === 'boolean',
      `[${label}] Frame ${idx} contactL must be boolean|null`
    );
    assert.ok(
      fr.contactR === null || typeof fr.contactR === 'boolean',
      `[${label}] Frame ${idx} contactR must be boolean|null`
    );
  }
  return frames;
}

export function resolveBakeWarpedFrames(bvhExporterMod, motionCleanerMod) {
  const fn = bvhExporterMod?.bakeWarpedFrames ?? motionCleanerMod?.bakeWarpedFrames;
  assert.equal(
    typeof fn,
    'function',
    'Missing required function export "bakeWarpedFrames" on BVHExporter.js / MotionCleaner.js'
  );
  return fn;
}

export function readBoneLayerWeight(weightsContainer, boneName, rigIdx) {
  if (!weightsContainer) return undefined;
  if (Array.isArray(weightsContainer) || ArrayBuffer.isView(weightsContainer)) {
    return weightsContainer[rigIdx];
  }
  if (weightsContainer instanceof Map) {
    return weightsContainer.has(boneName) ? weightsContainer.get(boneName) : weightsContainer.get(rigIdx);
  }
  if (typeof weightsContainer === 'object') {
    if (boneName in weightsContainer) return weightsContainer[boneName];
    if (rigIdx in weightsContainer) return weightsContainer[rigIdx];
  }
  return undefined;
}

export function extractExportedStateNames(fsmMod) {
  const found = new Set();
  const collectFromVal = (val, depth = 0) => {
    if (!val || depth > 2) return;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') found.add(item);
        else if (item && typeof item === 'object' && typeof item.id === 'string') found.add(item.id);
        else if (item && typeof item === 'object' && typeof item.name === 'string') found.add(item.name);
      }
      return;
    }
    if (val instanceof Set) {
      for (const item of val) if (typeof item === 'string') found.add(item);
      return;
    }
    if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        if (typeof v === 'string' && /^[A-Z][A-Za-z0-9_]+$/.test(v)) found.add(v);
        if (/^(Idle|Move_|Sprint|Dodge_|Jump|Air_Jump|Evade_|Attack_|Skill_|Hit_|KipUp)/.test(k)) {
          found.add(k);
        }
      }
    }
  };

  for (const expVal of Object.values(fsmMod)) {
    collectFromVal(expVal, 0);
  }

  // Also try instantiating exported FSM class/factory with zero args
  const FsmCtor =
    fsmMod.CombatStateMachine ||
    fsmMod.createCombatStateMachine ||
    fsmMod.default;
  if (typeof FsmCtor === 'function') {
    try {
      const inst = FsmCtor.prototype ? new FsmCtor() : FsmCtor();
      if (inst) {
        if (typeof inst.getSupportedStates === 'function') collectFromVal(inst.getSupportedStates());
        if (typeof inst.getStateDefinitions === 'function') collectFromVal(inst.getStateDefinitions());
        collectFromVal(inst.states);
        collectFromVal(inst.stateDefs);
        collectFromVal(inst.definitions);
      }
    } catch {
      // Constructor may require config; handled via browser __COMBAT_ARENA__ contract too
    }
  }
  return found;
}

export async function extractExportedLayerWeights(layeredMod) {
  for (const key of [
    'BONE_LAYER_WEIGHTS',
    'UPPER_LAYER_WEIGHTS',
    'UPPER_BODY_WEIGHTS',
    'UPPER_BODY_MASK',
    'DEFAULT_BONE_LAYER_WEIGHTS',
    'LAYER_WEIGHTS',
  ]) {
    if (layeredMod[key] && typeof layeredMod[key] === 'object') {
      return layeredMod[key];
    }
  }
  const rigMod = await loadModuleContract('src/rig/HumanoidRig.js', ['createBoneHierarchy']);
  const { bones } = rigMod.createBoneHierarchy();
  const Ctor =
    layeredMod.LayeredAnimator ||
    layeredMod.createLayeredAnimator ||
    layeredMod.default;
  if (typeof Ctor === 'function') {
    try {
      const inst = Ctor.prototype ? new Ctor({ bones }) : Ctor({ bones });
      if (inst) {
        if (typeof inst.getBoneLayerWeights === 'function') return inst.getBoneLayerWeights();
        if (typeof inst.getWeights === 'function') return inst.getWeights();
        if (inst.boneLayerWeights) return inst.boneLayerWeights;
        if (inst.weights) return inst.weights;
        if (inst.upperWeights) return inst.upperWeights;
      }
    } catch {
      try {
        const inst2 = Ctor.prototype ? new Ctor(bones) : Ctor(bones);
        if (inst2?.boneLayerWeights) return inst2.boneLayerWeights;
        if (inst2?.weights) return inst2.weights;
      } catch {}
    }
  }
  return null;
}

function snapshotDistStat() {
  const distPath = path.join(MOTION_STAGE_ROOT, 'dist');
  if (!fs.existsSync(distPath)) return { exists: false, mtimeMs: 0 };
  const st = fs.statSync(distPath);
  return { exists: true, mtimeMs: st.mtimeMs };
}

export function cleanupEphemeralViteBuild() {
  if (!sharedViteBuild) return;
  const { shmOutDir } = sharedViteBuild;
  sharedViteBuild = null;
  try {
    if (shmOutDir && fs.existsSync(shmOutDir)) {
      fs.rmSync(shmOutDir, { recursive: true, force: true });
    }
  } catch {}
}

export function getSharedEphemeralViteBuild() {
  if (sharedViteBuild && fs.existsSync(sharedViteBuild.shmOutDir)) {
    return sharedViteBuild;
  }

  if (!buildHooksInstalled) {
    buildHooksInstalled = true;
    process.on('exit', cleanupEphemeralViteBuild);
  }

  const shmOutDir = `/dev/shm/e2e_dist_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(shmOutDir, { mode: 0o700 });
  fs.chmodSync(shmOutDir, 0o700);

  const distBefore = snapshotDistStat();
  try {
    const stdout = execFileSync(
      VITE_BIN,
      ['build', '--outDir', shmOutDir, '--emptyOutDir'],
      {
        cwd: MOTION_STAGE_ROOT,
        encoding: 'utf8',
        timeout: 90000,
        env: { ...process.env, TMPDIR: shmOutDir },
      }
    );
    const distAfter = snapshotDistStat();
    sharedViteBuild = { shmOutDir, stdout, distBefore, distAfter };
    return sharedViteBuild;
  } catch (err) {
    try {
      fs.rmSync(shmOutDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }
}
