import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  WORKSPACE_ROOT,
  BVH_LIBRARY_ROOT,
  MANIFEST_PATH,
  GDRIVE_BIN,
  FFPROBE_BIN,
  FFMPEG_BIN,
  CANONICAL_21_JOINTS,
  FORBIDDEN_AUX_TOKENS,
} from './constants.mjs';
import { importThree, importBVHLoader, loadModuleContract } from './contract_loader.mjs';

const THREE = await importThree();

const GDRIVE_ENV = {
  ...process.env,
  PATH: `${process.env.PATH || ''}:/opt/antigravity/bin`,
};

export function requireDeliverableFile(absPath, featureTag) {
  assert.equal(
    fs.existsSync(absPath),
    true,
    `[${featureTag}] Deliverable file not yet present: ${absPath}`
  );
  const stat = fs.statSync(absPath);
  assert.ok(
    stat.isFile() && stat.size > 0,
    `[${featureTag}] File is empty or not a regular file: ${absPath}`
  );
  return stat;
}

export function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function withEphemeralShmDir(prefix, fn) {
  const shmDir = `/dev/shm/${prefix}_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(shmDir, { mode: 0o700 });
  fs.chmodSync(shmDir, 0o700);
  try {
    return await fn(shmDir);
  } finally {
    try {
      fs.rmSync(shmDir, { recursive: true, force: true });
    } catch {}
  }
}

export function gdriveJson(args) {
  const out = execFileSync(GDRIVE_BIN, [...args, '--json'], {
    encoding: 'utf8',
    env: GDRIVE_ENV,
    timeout: 30000,
  });
  return JSON.parse(out);
}

export function gdriveDownloadReadonly(fileId, destAbsPath) {
  execFileSync(GDRIVE_BIN, ['readonly', 'download', fileId, '--out', destAbsPath], {
    encoding: 'utf8',
    env: GDRIVE_ENV,
    timeout: 45000,
  });
}

export function ffprobeVideo(absVideoPath) {
  const out = execFileSync(
    FFPROBE_BIN,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,r_frame_rate,nb_frames,pix_fmt:format=duration,size',
      '-of',
      'json',
      absVideoPath,
    ],
    { encoding: 'utf8', timeout: 20000 }
  );
  return JSON.parse(out);
}

export function ffmpegDecodeCheck(absVideoPath, seekSec = 0, framesCount = 1) {
  const args = ['-v', 'error'];
  if (seekSec > 0) {
    args.push('-ss', String(seekSec));
  }
  args.push('-i', absVideoPath, '-frames:v', String(framesCount), '-f', 'null', '-');
  const stderr = execFileSync(FFMPEG_BIN, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
  });
  return stderr;
}

export function loadAndNormalizeManifest(manifestPath = MANIFEST_PATH) {
  requireDeliverableFile(manifestPath, 'MANIFEST');
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray(raw.clips)
      ? raw.clips
      : null;
  assert.ok(
    Array.isArray(list),
    '[MANIFEST] Top-level JSON must be either an Array or an Object with a "clips" Array'
  );
  return list;
}

export function resolveManifestEntryPath(entryPath) {
  assert.equal(typeof entryPath, 'string', '[MANIFEST] entry.path must be a string');
  const clean = entryPath.replace(/^\/+/, '').replace(/^\.\//, '');
  const abs = clean.startsWith('bvh_library/')
    ? path.resolve(WORKSPACE_ROOT, clean)
    : path.resolve(BVH_LIBRARY_ROOT, clean);
  assert.ok(
    abs.startsWith(`${BVH_LIBRARY_ROOT}/`),
    `[MANIFEST] Path escapes bvh_library: ${entryPath}`
  );
  return abs;
}

/**
 * Pure-ESM 21-Bone Standard BVH Structural & Forward-Kinematics Analyzer.
 * Verifies exact 21-joint hierarchy, parent nesting, rest OFFSETs & End Sites (<= 1e-3 cm),
 * 66 channels/frame, ZXY order, Frames === rows.length, zero NaN/Infinity, forbidden aux tokens,
 * Three.js FK trajectories (in cm), SwordTip clearance, unwrapped rotational std, frozen-frame runs, and loop seam.
 */
export function parseAndAnalyzeStandardBVH(bvhText, label = 'BVH', options = {}) {
  const minFrames = options.minFrames ?? 12;
  assert.equal(typeof bvhText, 'string', `[${label}] BVH content must be a string`);
  for (const bad of FORBIDDEN_AUX_TOKENS) {
    assert.ok(!bvhText.includes(bad), `[${label}] Forbidden auxiliary bone "${bad}" leaked into BVH`);
  }
  assert.ok(
    !/\b(NaN|Infinity|-Infinity)\b/.test(bvhText),
    `[${label}] BVH text contains NaN/Infinity literal`
  );

  const parts = bvhText.split(/\r?\nMOTION\r?\n/);
  assert.equal(parts.length, 2, `[${label}] Expected exactly one MOTION section`);
  const [hierPart, motionPart] = parts;

  const hLines = hierPart
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  assert.equal(hLines[0], 'HIERARCHY', `[${label}] First line must be HIERARCHY`);

  const joints = [];
  const stack = [];
  let inEndSite = false;

  for (let i = 1; i < hLines.length; i++) {
    const line = hLines[i];
    if (line === '{') continue;
    if (line === '}') {
      if (inEndSite) inEndSite = false;
      else stack.pop();
      continue;
    }
    if (line.startsWith('ROOT ') || line.startsWith('JOINT ')) {
      const [kw, name] = line.split(/\s+/);
      const parent = stack.length ? stack[stack.length - 1].name : null;
      const j = { kw, name, parent, offset: null, channels: [], endSite: null };
      joints.push(j);
      stack.push(j);
    } else if (line === 'End Site') {
      inEndSite = true;
    } else if (line.startsWith('OFFSET ')) {
      const vals = line.slice(7).trim().split(/\s+/).map(Number);
      assert.equal(vals.length, 3, `[${label}] OFFSET must have 3 floats`);
      assert.ok(vals.every(Number.isFinite), `[${label}] Non-finite OFFSET`);
      if (inEndSite) stack[stack.length - 1].endSite = vals;
      else stack[stack.length - 1].offset = vals;
    } else if (line.startsWith('CHANNELS ')) {
      const toks = line.split(/\s+/);
      const count = Number(toks[1]);
      const chs = toks.slice(2);
      assert.equal(chs.length, count, `[${label}] CHANNELS count mismatch`);
      stack[stack.length - 1].channels = chs;
    }
  }

  assert.equal(stack.length, 0, `[${label}] Unbalanced braces in HIERARCHY`);
  assert.equal(joints.length, 21, `[${label}] Expected exactly 21 joints, got ${joints.length}`);

  let totalChannels = 0;
  joints.forEach((j, idx) => {
    const spec = CANONICAL_21_JOINTS[idx];
    assert.equal(j.kw, spec.kw, `[${label}] Joint #${idx} keyword mismatch`);
    assert.equal(j.name, spec.name, `[${label}] Joint #${idx} name mismatch`);
    assert.equal(j.parent, spec.parent, `[${label}] Joint ${j.name} parent mismatch`);
    for (let k = 0; k < 3; k++) {
      assert.ok(
        Math.abs(j.offset[k] - spec.offset[k]) <= 1e-3,
        `[${label}] Joint ${j.name} OFFSET[${k}] = ${j.offset[k]}, expected ${spec.offset[k]}`
      );
    }
    if (spec.endSite) {
      assert.ok(Array.isArray(j.endSite), `[${label}] Leaf ${j.name} missing End Site`);
      for (let k = 0; k < 3; k++) {
        assert.ok(
          Math.abs(j.endSite[k] - spec.endSite[k]) <= 1e-3,
          `[${label}] Leaf ${j.name} End Site OFFSET[${k}] = ${j.endSite[k]}, expected ${spec.endSite[k]}`
        );
      }
    } else {
      assert.equal(j.endSite, null, `[${label}] Non-leaf ${j.name} should not have End Site`);
    }
    if (idx === 0) {
      assert.deepEqual(j.channels, [
        'Xposition',
        'Yposition',
        'Zposition',
        'Zrotation',
        'Xrotation',
        'Yrotation',
      ]);
    } else {
      assert.deepEqual(j.channels, ['Zrotation', 'Xrotation', 'Yrotation']);
    }
    totalChannels += j.channels.length;
  });
  assert.equal(totalChannels, 66, `[${label}] Total channels must be 66`);

  const mLines = motionPart
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  assert.ok(mLines.length >= 2 + minFrames, `[${label}] MOTION section missing Frames/Frame Time/data`);
  const fMatch = mLines[0].match(/^Frames:\s*(\d+)$/);
  const dtMatch = mLines[1].match(/^Frame Time:\s*([0-9.eE+-]+)$/);
  assert.ok(fMatch, `[${label}] Malformed Frames line: ${mLines[0]}`);
  assert.ok(dtMatch, `[${label}] Malformed Frame Time line: ${mLines[1]}`);

  const declaredFrames = Number(fMatch[1]);
  const frameTime = Number(dtMatch[1]);
  assert.ok(
    declaredFrames >= minFrames,
    `[${label}] Expected >= ${minFrames} frames, got ${declaredFrames}`
  );
  assert.ok(frameTime > 0.002 && frameTime < 0.25, `[${label}] Out-of-bounds Frame Time: ${frameTime}`);

  const dataLines = mLines.slice(2);
  assert.equal(
    dataLines.length,
    declaredFrames,
    `[${label}] Declared Frames=${declaredFrames} != data lines=${dataLines.length}`
  );

  const rows = dataLines.map((line, fIdx) => {
    const vals = line.split(/\s+/).map(Number);
    assert.equal(
      vals.length,
      66,
      `[${label}] Frame ${fIdx} has ${vals.length} channels (expected 66)`
    );
    assert.ok(vals.every(Number.isFinite), `[${label}] Frame ${fIdx} contains non-finite numbers`);
    return vals;
  });

  // Build Three.js FK rig (in cm) + attach Greatsword Tip for weapon clearance checks
  const boneMap = new Map();
  const bones = joints.map((j) => {
    const b = new THREE.Object3D();
    b.name = j.name;
    b.position.set(j.offset[0], j.offset[1], j.offset[2]);
    boneMap.set(j.name, b);
    if (j.parent) boneMap.get(j.parent).add(b);
    return b;
  });

  const zBlade = new THREE.Vector3(-0.619, 0.754, 0.219).normalize();
  const xEdge = new THREE.Vector3(-0.42, -0.15, 0.89);
  xEdge.addScaledVector(zBlade, -xEdge.dot(zBlade)).normalize();
  const yFlat = new THREE.Vector3().crossVectors(zBlade, xEdge).normalize();
  const swordGroup = new THREE.Object3D();
  swordGroup.position.set(-5.0, 0.5, 1.0);
  swordGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xEdge, yFlat, zBlade));
  const swordTip = new THREE.Object3D();
  swordTip.position.set(0, 0, 106.0);
  swordGroup.add(swordTip);
  boneMap.get('RightHand').add(swordGroup);

  const deg2rad = Math.PI / 180;
  const eul = new THREE.Euler(0, 0, 0, 'ZXY');
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();

  const trackedWorldNames = [
    'Hips',
    'Spine',
    'Chest',
    'Neck',
    'Head',
    'LeftHand',
    'RightHand',
    'LeftLeg',
    'RightLeg',
    'LeftFoot',
    'RightFoot',
    'LeftToe',
    'RightToe',
  ];
  const worldTraj = {
    SwordTip: [],
    hipsUpY: [],
    chestFwdZ: [],
    chestRollX: [],
  };
  for (const k of trackedWorldNames) worldTraj[k] = [];

  const perFrameQuats = [];

  for (let f = 0; f < rows.length; f++) {
    const r = rows[f];
    bones[0].position.set(r[0], r[1], r[2]);
    const fQuats = [];
    for (let j = 0; j < 21; j++) {
      const off = j === 0 ? 3 : 6 + (j - 1) * 3;
      eul.set(r[off + 1] * deg2rad, r[off + 2] * deg2rad, r[off] * deg2rad, 'ZXY');
      bones[j].quaternion.setFromEuler(eul);
      fQuats.push(bones[j].quaternion.clone());
    }
    perFrameQuats.push(fQuats);
    bones[0].updateMatrixWorld(true);

    for (const k of trackedWorldNames) {
      boneMap.get(k).getWorldPosition(tmpV);
      worldTraj[k].push(tmpV.clone());
    }
    swordTip.getWorldPosition(tmpV);
    worldTraj.SwordTip.push(tmpV.clone());

    bones[0].getWorldQuaternion(tmpQ);
    worldTraj.hipsUpY.push(tmpV.set(0, 1, 0).applyQuaternion(tmpQ).y);

    boneMap.get('Chest').getWorldQuaternion(tmpQ);
    worldTraj.chestFwdZ.push(tmpV.set(0, 0, 1).applyQuaternion(tmpQ).z);
    worldTraj.chestRollX.push(tmpV.set(0, 1, 0).applyQuaternion(tmpQ).x);
  }

  // Unwrapped rotational std per channel [3..65]
  const chStds = [];
  for (let c = 3; c < 66; c++) {
    const un = [rows[0][c]];
    for (let i = 1; i < rows.length; i++) {
      let d = rows[i][c] - rows[i - 1][c];
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      un.push(un[i - 1] + d);
    }
    const mean = un.reduce((a, b) => a + b, 0) / un.length;
    chStds.push(Math.sqrt(un.reduce((a, b) => a + (b - mean) ** 2, 0) / un.length));
  }

  // Joint-by-joint unwrapped std helper (jointIdx 0..20)
  const jointRotStds = {};
  joints.forEach((j, idx) => {
    const base = idx * 3;
    jointRotStds[j.name] = [chStds[base], chStds[base + 1], chStds[base + 2]];
  });

  // Frozen-frame & transition metrics
  let maxIdenticalRun = 0;
  let curRun = 0;
  let movingPairs = 0;
  for (let i = 1; i < rows.length; i++) {
    let maxDiff = 0;
    for (let c = 0; c < 66; c++) {
      maxDiff = Math.max(maxDiff, Math.abs(rows[i][c] - rows[i - 1][c]));
    }
    if (maxDiff < 1e-4) {
      curRun++;
      maxIdenticalRun = Math.max(maxIdenticalRun, curRun);
    } else {
      curRun = 0;
      movingPairs++;
    }
  }

  // Loop seam metrics (frame N-1 vs frame 0)
  const N = rows.length;
  const seamPosXYZ = worldTraj.Hips[0].distanceTo(worldTraj.Hips[N - 1]);
  const seamPosXZ = Math.hypot(rows[0][0] - rows[N - 1][0], rows[0][2] - rows[N - 1][2]);
  const seamPosY = Math.abs(rows[0][1] - rows[N - 1][1]);
  let maxUpperSeamDeg = 0;
  let maxLegSeamDeg = 0;
  for (let j = 1; j < 21; j++) {
    const dot = Math.min(1, Math.abs(perFrameQuats[0][j].dot(perFrameQuats[N - 1][j])));
    const deg = 2 * Math.acos(dot) * (180 / Math.PI);
    if (j <= 12) maxUpperSeamDeg = Math.max(maxUpperSeamDeg, deg);
    else maxLegSeamDeg = Math.max(maxLegSeamDeg, deg);
  }

  return {
    joints,
    declaredFrames,
    frameTime,
    fps: Math.round(1 / frameTime),
    durationSec: declaredFrames * frameTime,
    rows,
    perFrameQuats,
    worldTraj,
    chStds,
    jointRotStds,
    activeRotChs: chStds.filter((s) => s > 0.1).length,
    maxRotStd: Math.max(...chStds),
    sumRotStd: chStds.reduce((a, b) => a + b, 0),
    maxIdenticalRun,
    uniqueTransitionRatio: N > 1 ? movingPairs / (N - 1) : 1,
    seam: { seamPosXYZ, seamPosXZ, seamPosY, maxUpperSeamDeg, maxLegSeamDeg },
  };
}

/**
 * Lightweight parser for raw optical mocap BVH files (e.g. 31-bone CMU in A_raw_mocap/).
 */
export async function parseGenericBVHSummary(bvhText, label = 'RawBVH') {
  const BVHLoader = await importBVHLoader();
  assert.ok(!/\b(NaN|Infinity|-Infinity)\b/.test(bvhText), `[${label}] Contains NaN/Infinity`);
  const fMatch = bvhText.match(/Frames:\s*(\d+)/);
  const dtMatch = bvhText.match(/Frame Time:\s*([0-9.eE+-]+)/);
  assert.ok(fMatch && dtMatch, `[${label}] Missing Frames or Frame Time`);
  const frames = Number(fMatch[1]);
  const frameTime = Number(dtMatch[1]);
  const loader = new BVHLoader();
  const { clip, skeleton } = loader.parse(bvhText);
  const realBones = skeleton.bones.filter((b) => b.name !== 'ENDSITE');
  return {
    frames,
    frameTime,
    fps: Math.round(1 / frameTime),
    duration: clip.duration,
    boneCount: realBones.length,
    boneNames: realBones.map((b) => b.name),
  };
}

// --- Deterministic Synthetic BVH & Runtime Clip Builders (F5–F9) ---

const CONVENTION_NAME_MAP = {
  standard21: {
    Hips: 'Hips',
    Spine: 'Spine',
    Chest: 'Chest',
    Neck: 'Neck',
    Head: 'Head',
    LeftShoulder: 'LeftShoulder',
    LeftUpperArm: 'LeftUpperArm',
    LeftForeArm: 'LeftForeArm',
    LeftHand: 'LeftHand',
    RightShoulder: 'RightShoulder',
    RightUpperArm: 'RightUpperArm',
    RightForeArm: 'RightForeArm',
    RightHand: 'RightHand',
    LeftUpLeg: 'LeftUpLeg',
    LeftLeg: 'LeftLeg',
    LeftFoot: 'LeftFoot',
    LeftToe: 'LeftToe',
    RightUpLeg: 'RightUpLeg',
    RightLeg: 'RightLeg',
    RightFoot: 'RightFoot',
    RightToe: 'RightToe',
  },
  ue5: {
    Hips: 'pelvis',
    Spine: 'spine_01',
    Chest: 'spine_03',
    Neck: 'neck_01',
    Head: 'head',
    LeftShoulder: 'clavicle_l',
    LeftUpperArm: 'upperarm_l',
    LeftForeArm: 'lowerarm_l',
    LeftHand: 'hand_l',
    RightShoulder: 'clavicle_r',
    RightUpperArm: 'upperarm_r',
    RightForeArm: 'lowerarm_r',
    RightHand: 'hand_r',
    LeftUpLeg: 'thigh_l',
    LeftLeg: 'calf_l',
    LeftFoot: 'foot_l',
    LeftToe: 'ball_l',
    RightUpLeg: 'thigh_r',
    RightLeg: 'calf_r',
    RightFoot: 'foot_r',
    RightToe: 'ball_r',
  },
  unity: {
    Hips: 'Hips',
    Spine: 'Spine',
    Chest: 'UpperChest',
    Neck: 'Neck',
    Head: 'Head',
    LeftShoulder: 'LeftShoulder',
    LeftUpperArm: 'LeftUpperArm',
    LeftForeArm: 'LeftLowerArm',
    LeftHand: 'LeftHand',
    RightShoulder: 'RightShoulder',
    RightUpperArm: 'RightUpperArm',
    RightForeArm: 'RightLowerArm',
    RightHand: 'RightHand',
    LeftUpLeg: 'LeftUpperLeg',
    LeftLeg: 'LeftLowerLeg',
    LeftFoot: 'LeftFoot',
    LeftToe: 'LeftToes',
    RightUpLeg: 'RightUpperLeg',
    RightLeg: 'RightLowerLeg',
    RightFoot: 'RightFoot',
    RightToe: 'RightToes',
  },
  mixamo: {
    Hips: 'mixamorig:Hips',
    Spine: 'mixamorig:Spine',
    Chest: 'mixamorig:Spine2',
    Neck: 'mixamorig:Neck',
    Head: 'mixamorig:Head',
    LeftShoulder: 'mixamorig:LeftShoulder',
    LeftUpperArm: 'mixamorig:LeftArm',
    LeftForeArm: 'mixamorig:LeftForeArm',
    LeftHand: 'mixamorig:LeftHand',
    RightShoulder: 'mixamorig:RightShoulder',
    RightUpperArm: 'mixamorig:RightArm',
    RightForeArm: 'mixamorig:RightForeArm',
    RightHand: 'mixamorig:RightHand',
    LeftUpLeg: 'mixamorig:LeftUpLeg',
    LeftLeg: 'mixamorig:LeftLeg',
    LeftFoot: 'mixamorig:LeftFoot',
    LeftToe: 'mixamorig:LeftToeBase',
    RightUpLeg: 'mixamorig:RightUpLeg',
    RightLeg: 'mixamorig:RightLeg',
    RightFoot: 'mixamorig:RightFoot',
    RightToe: 'mixamorig:RightToeBase',
  },
  rigify: {
    Hips: 'pelvis',
    Spine: 'spine',
    Chest: 'chest',
    Neck: 'neck',
    Head: 'head',
    LeftShoulder: 'shoulder.L',
    LeftUpperArm: 'upper_arm.L',
    LeftForeArm: 'forearm.L',
    LeftHand: 'hand.L',
    RightShoulder: 'shoulder.R',
    RightUpperArm: 'upper_arm.R',
    RightForeArm: 'forearm.R',
    RightHand: 'hand.R',
    LeftUpLeg: 'thigh.L',
    LeftLeg: 'shin.L',
    LeftFoot: 'foot.L',
    LeftToe: 'toe.L',
    RightUpLeg: 'thigh.R',
    RightLeg: 'shin.R',
    RightFoot: 'foot.R',
    RightToe: 'toe.R',
  },
};

export function buildSyntheticBVH(spec = {}) {
  const {
    convention = 'standard21',
    frames = 12,
    fps = 60,
    scale = 1.0, // 1.0 = cm, 1/2.54 = inches, 0.01 = meters
    rootPosFn = null, // (f) => [x, y, z] in scaled units (default [0, 94*scale, 0])
    jointEulerZXYDegFn = null, // (canonicalOrMappedName, f) => [zDeg, xDeg, yDeg]
  } = spec;

  const hasFloorRoot = convention === 'ue5_with_floor_root';
  const nameMap = CONVENTION_NAME_MAP[hasFloorRoot ? 'ue5' : convention] || CONVENTION_NAME_MAP.standard21;

  // Build tree from CANONICAL_21_JOINTS
  const childrenByParent = new Map();
  for (const j of CANONICAL_21_JOINTS) {
    const p = j.parent;
    if (!childrenByParent.has(p)) childrenByParent.set(p, []);
    childrenByParent.get(p).push(j);
  }

  const emitOrder = [];
  const lines = ['HIERARCHY'];

  const emitNode = (canonNode, depth, isRootNode) => {
    const indent = '  '.repeat(depth);
    const mappedName = nameMap[canonNode.name];
    emitOrder.push({ canonical: canonNode.name, mapped: mappedName, isRoot: isRootNode });

    lines.push(`${indent}${isRootNode ? 'ROOT' : 'JOINT'} ${mappedName}`);
    lines.push(`${indent}{`);

    let ox = canonNode.offset[0] * scale;
    let oy = canonNode.offset[1] * scale;
    let oz = canonNode.offset[2] * scale;
    if (canonNode.name === 'Hips' && hasFloorRoot) {
      oy = 94.0 * scale;
    }
    lines.push(`${indent}  OFFSET ${ox.toFixed(4)} ${oy.toFixed(4)} ${oz.toFixed(4)}`);

    if (isRootNode) {
      lines.push(
        `${indent}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`
      );
    } else {
      lines.push(`${indent}  CHANNELS 3 Zrotation Xrotation Yrotation`);
    }

    const kids = childrenByParent.get(canonNode.name) || [];
    if (kids.length > 0) {
      for (const child of kids) {
        emitNode(child, depth + 1, false);
      }
    } else if (canonNode.endSite) {
      const ex = canonNode.endSite[0] * scale;
      const ey = canonNode.endSite[1] * scale;
      const ez = canonNode.endSite[2] * scale;
      lines.push(`${indent}  End Site`);
      lines.push(`${indent}  {`);
      lines.push(`${indent}    OFFSET ${ex.toFixed(4)} ${ey.toFixed(4)} ${ez.toFixed(4)}`);
      lines.push(`${indent}  }`);
    }
    lines.push(`${indent}}`);
  };

  const hipsNode = CANONICAL_21_JOINTS[0];
  if (hasFloorRoot) {
    emitOrder.push({ canonical: 'FloorRoot', mapped: 'root', isRoot: true });
    lines.push('ROOT root');
    lines.push('{');
    lines.push('  OFFSET 0.0000 0.0000 0.0000');
    lines.push('  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation');
    emitNode(hipsNode, 1, false);
    lines.push('}');
  } else {
    emitNode(hipsNode, 0, true);
  }

  lines.push('MOTION');
  lines.push(`Frames: ${frames}`);
  lines.push(`Frame Time: ${(1 / fps).toFixed(6)}`);

  for (let f = 0; f < frames; f++) {
    const row = [];
    for (const node of emitOrder) {
      if (node.isRoot) {
        const defaultY = hasFloorRoot ? 0 : 94.0 * scale;
        const pos = rootPosFn ? rootPosFn(f) : [0, defaultY, 0];
        row.push(pos[0].toFixed(4), pos[1].toFixed(4), pos[2].toFixed(4));
      }
      const rot =
        (jointEulerZXYDegFn &&
          (jointEulerZXYDegFn(node.mapped, f) || jointEulerZXYDegFn(node.canonical, f))) || [
          0, 0, 0,
        ];
      row.push(rot[0].toFixed(4), rot[1].toFixed(4), rot[2].toFixed(4));
    }
    lines.push(row.join(' '));
  }

  return `${lines.join('\n')}\n`;
}

export async function buildControlledSlipClip({
  N = 31,
  fps = 60,
  driftVelMps = 0.2,
  nullContacts = true,
} = {}) {
  const frames = [];
  for (let f = 0; f < N; f++) {
    const t = f / fps;
    const x = -0.05 + driftVelMps * t;
    frames.push({
      rootPos: new THREE.Vector3(x, 0.92, 0),
      quats: Array.from({ length: 29 }, () => new THREE.Quaternion()),
      contactL: nullContacts ? null : true,
      contactR: nullContacts ? null : true,
    });
  }
  return {
    id: 'synthetic_slip_clip',
    name: 'Synthetic Slip Clip',
    fps,
    totalFrames: N,
    duration: N / fps,
    nonCyclic: true,
    isCombatAttack: false,
    hasWeapon: false,
    preserveRootMotion: true,
    frames,
  };
}

export async function buildMultiPeakCombatClip({ N = 180, fps = 60, peakCount = 4 } = {}) {
  const rigMod = await loadModuleContract('src/rig/HumanoidRig.js', ['BONE_IDX']);
  const { BONE_IDX } = rigMod;

  const peakCenters = Array.from(
    { length: peakCount },
    (_, i) => Math.round(((i + 0.8) / (peakCount + 0.8)) * N)
  );
  const frames = [];
  for (let f = 0; f < N; f++) {
    const quats = Array.from({ length: 29 }, () => new THREE.Quaternion());
    let swingAngle = 0;
    for (let p = 0; p < peakCenters.length; p++) {
      const dist = (f - peakCenters[p]) / 4.0;
      const pulse = Math.exp(-0.5 * dist * dist) * (p % 2 === 0 ? 1.35 : -1.25);
      swingAngle += pulse;
    }
    quats[BONE_IDX.RightUpperArm].setFromEuler(new THREE.Euler(swingAngle * 0.65, swingAngle * 0.85, -0.35));
    quats[BONE_IDX.RightForeArm].setFromEuler(new THREE.Euler(0, swingAngle * 0.55, 0));
    quats[BONE_IDX.RightHand].setFromEuler(new THREE.Euler(swingAngle * 0.4, 0, 0));
    frames.push({
      rootPos: new THREE.Vector3(0, 0.92, (f / Math.max(1, N - 1)) * 0.45),
      quats,
      contactL: true,
      contactR: true,
    });
  }
  return {
    id: 'synthetic_multihit_clip',
    name: 'Synthetic MultiHit Slash',
    fps,
    totalFrames: N,
    duration: N / fps,
    nonCyclic: true,
    isCombatAttack: true,
    hasWeapon: true,
    preserveRootMotion: true,
    frames,
  };
}

export async function computeWorldBonePositionsForFrame(frame) {
  const rigMod = await loadModuleContract('src/rig/HumanoidRig.js', [
    'BONE_DEFS',
    'BONE_IDX',
    'createBoneHierarchy',
  ]);
  const { BONE_DEFS, createBoneHierarchy } = rigMod;
  const { bones } = createBoneHierarchy();
  bones[0].position.copy(frame.rootPos);
  for (let i = 0; i < BONE_DEFS.length; i++) {
    bones[i].quaternion.copy(frame.quats[i]);
  }
  bones[0].updateMatrixWorld(true);
  const out = {};
  const v = new THREE.Vector3();
  BONE_DEFS.forEach((def, idx) => {
    bones[idx].getWorldPosition(v);
    out[def.name] = v.clone();
  });
  return out;
}
