import * as THREE from 'three';
import { BONE_DEFS, BONE_IDX } from '../rig/HumanoidRig.js';
import { bakeWarpedFrames } from './MotionCleaner.js';

export { bakeWarpedFrames };

// Standard 21-bone humanoid export set (excludes auxiliary Twist & Cloth physics bones)
export const EXPORT_BONE_INDICES = new Set([
  BONE_IDX.Hips,
  BONE_IDX.Spine,
  BONE_IDX.Chest,
  BONE_IDX.Neck,
  BONE_IDX.Head,
  BONE_IDX.LeftShoulder,
  BONE_IDX.LeftUpperArm,
  BONE_IDX.LeftForeArm,
  BONE_IDX.LeftHand,
  BONE_IDX.RightShoulder,
  BONE_IDX.RightUpperArm,
  BONE_IDX.RightForeArm,
  BONE_IDX.RightHand,
  BONE_IDX.LeftUpLeg,
  BONE_IDX.LeftLeg,
  BONE_IDX.LeftFoot,
  BONE_IDX.LeftToe,
  BONE_IDX.RightUpLeg,
  BONE_IDX.RightLeg,
  BONE_IDX.RightFoot,
  BONE_IDX.RightToe,
]);

const END_SITE_OFFSETS_CM = {
  [BONE_IDX.Head]: [0, 12, 0],
  [BONE_IDX.LeftHand]: [10, 0, 0],
  [BONE_IDX.RightHand]: [-10, 0, 0],
  [BONE_IDX.LeftToe]: [0, 0, 6],
  [BONE_IDX.RightToe]: [0, 0, 6],
};

function buildChildrenMap() {
  const map = new Map();
  for (const idx of EXPORT_BONE_INDICES) {
    map.set(idx, []);
  }
  BONE_DEFS.forEach((def, idx) => {
    if (EXPORT_BONE_INDICES.has(idx) && def.parent >= 0 && map.has(def.parent)) {
      map.get(def.parent).push(idx);
    }
  });
  return map;
}

function formatBVHFloat(val, decimals = 4) {
  if (!Number.isFinite(val)) return (0).toFixed(decimals);
  const halfLsb = 0.5 * Math.pow(10, -decimals);
  const clean = Math.abs(val) < halfLsb ? 0 : val;
  const str = clean.toFixed(decimals);
  return str.startsWith('-0.') && Number(str) === 0 ? str.slice(1) : str;
}

/**
 * Serializes cleaned humanoid frames into an industry-standard BioVision (.bvh) file
 * (21 joints, 66 channels, centimeter scale, ZXY Euler rotation channels) ready for Blender, Unity, or UE5.
 * Supports optional combat curve & hitstop baking via `options = { bakeCombatCurve: false, combatCurve: {} }`.
 */
export function exportCleanedClipToBVH(
  clip,
  frames,
  options = { bakeCombatCurve: false, combatCurve: {} }
) {
  const opts = options && typeof options === 'object' ? options : {};
  const sourceFrames = Array.isArray(frames) ? frames : Array.isArray(clip?.frames) ? clip.frames : [];
  const exportFrames = opts.bakeCombatCurve
    ? bakeWarpedFrames(sourceFrames, clip, opts.combatCurve || {})
    : sourceFrames;

  const childrenMap = buildChildrenMap();
  const jointOrder = [];
  const lines = ['HIERARCHY'];

  const emitJoint = (boneIdx, depth) => {
    const indent = '  '.repeat(depth);
    const def = BONE_DEFS[boneIdx];
    const isRoot = boneIdx === BONE_IDX.Hips;
    jointOrder.push(boneIdx);

    lines.push(`${indent}${isRoot ? 'ROOT' : 'JOINT'} ${def.name}`);
    lines.push(`${indent}{`);

    const ox = isRoot ? 0 : def.pos[0] * 100;
    const oy = isRoot ? 0 : def.pos[1] * 100;
    const oz = isRoot ? 0 : def.pos[2] * 100;
    lines.push(
      `${indent}  OFFSET ${formatBVHFloat(ox, 4)} ${formatBVHFloat(oy, 4)} ${formatBVHFloat(oz, 4)}`
    );

    if (isRoot) {
      lines.push(`${indent}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`);
    } else {
      lines.push(`${indent}  CHANNELS 3 Zrotation Xrotation Yrotation`);
    }

    const kids = childrenMap.get(boneIdx) || [];
    if (kids.length > 0) {
      for (const childIdx of kids) {
        emitJoint(childIdx, depth + 1);
      }
    } else {
      const endOff = END_SITE_OFFSETS_CM[boneIdx] || [0, 5, 0];
      lines.push(`${indent}  End Site`);
      lines.push(`${indent}  {`);
      lines.push(
        `${indent}    OFFSET ${formatBVHFloat(endOff[0], 4)} ${formatBVHFloat(endOff[1], 4)} ${formatBVHFloat(endOff[2], 4)}`
      );
      lines.push(`${indent}  }`);
    }

    lines.push(`${indent}}`);
  };

  emitJoint(BONE_IDX.Hips, 0);

  const fps = Number.isFinite(Number(clip?.fps)) && Number(clip.fps) > 0 ? Number(clip.fps) : 60;
  const frameTime = 1 / fps;
  lines.push('MOTION');
  lines.push(`Frames: ${exportFrames.length}`);
  lines.push(`Frame Time: ${formatBVHFloat(frameTime, 6)}`);

  const euler = new THREE.Euler(0, 0, 0, 'ZXY');
  const safeQ = new THREE.Quaternion();
  const rad2deg = 180 / Math.PI;

  for (let f = 0; f < exportFrames.length; f++) {
    const fr = exportFrames[f];
    const rx = Number.isFinite(fr?.rootPos?.x) ? fr.rootPos.x * 100 : 0;
    const ry = Number.isFinite(fr?.rootPos?.y) ? fr.rootPos.y * 100 : 0;
    const rz = Number.isFinite(fr?.rootPos?.z) ? fr.rootPos.z * 100 : 0;

    const row = [formatBVHFloat(rx, 4), formatBVHFloat(ry, 4), formatBVHFloat(rz, 4)];

    for (const boneIdx of jointOrder) {
      const q = fr?.quats?.[boneIdx];
      if (!q || !Number.isFinite(q.x + q.y + q.z + q.w) || q.lengthSq() < 1e-12) {
        safeQ.identity();
      } else {
        safeQ.copy(q).normalize();
      }
      euler.setFromQuaternion(safeQ, 'ZXY');
      row.push(
        formatBVHFloat(euler.z * rad2deg, 4),
        formatBVHFloat(euler.x * rad2deg, 4),
        formatBVHFloat(euler.y * rad2deg, 4)
      );
    }
    lines.push(row.join(' '));
  }

  return `${lines.join('\n')}\n`;
}

export function exportFramesToBVH(frames, fps = 60, options = {}) {
  return exportCleanedClipToBVH({ fps, ...options }, frames, options);
}
