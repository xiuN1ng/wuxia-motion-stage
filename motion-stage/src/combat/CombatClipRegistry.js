import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { BONE_DEFS, BONE_IDX, createBoneHierarchy } from '../rig/HumanoidRig.js';
import {
  MOCAP_RUN_BVH,
  MOCAP_SWORD_STRIKE_BVH,
  MOCAP_KICK_BVH,
  MOCAP_BACKFLIP_BVH,
} from '../anim/mocap/bvhBundle.js';

const NUM_BONES = BONE_DEFS.length; // 29
const DEG2RAD = Math.PI / 180;

/**
 * All 26 canonical `bvh_library` assets from PROJECT.md § Contract 2.
 */
export const CANONICAL_CLIP_SPECS = Object.freeze([
  // B_cleaned_ready (01..06 existing + 07..15 M2 expansion = 22 clips)
  { id: '01_idle', relPath: 'B_cleaned_ready/01_wuxia_idle_待机呼吸_cleaned.bvh', prefix: '01_', cyclic: true },
  { id: '02_run', relPath: 'B_cleaned_ready/02_wuxia_run_疾跑轻功_cleaned.bvh', prefix: '02_', cyclic: true },
  { id: '03_sword_combo', relPath: 'B_cleaned_ready/03_wuxia_sword_combo_剑术连斩去穿模_cleaned.bvh', prefix: '03_', cyclic: false },
  { id: '04_tornado_kick', relPath: 'B_cleaned_ready/04_wuxia_tornado_kick_旋风回旋踢_cleaned.bvh', prefix: '04_', cyclic: false },
  { id: '05_front_kick', relPath: 'B_cleaned_ready/05_wuxia_front_kick_正蹬破防踢_cleaned.bvh', prefix: '05_', cyclic: false },
  { id: '06_backflip', relPath: 'B_cleaned_ready/06_wuxia_backflip_原地后空翻_cleaned.bvh', prefix: '06_', cyclic: false },
  { id: '07_strafe_F', relPath: 'B_cleaned_ready/07_wuxia_strafe_F_前垫步_cleaned.bvh', prefix: '07_wuxia_strafe_F', cyclic: true },
  { id: '07_strafe_B', relPath: 'B_cleaned_ready/07_wuxia_strafe_B_后撤步_cleaned.bvh', prefix: '07_wuxia_strafe_B', cyclic: true },
  { id: '07_strafe_L', relPath: 'B_cleaned_ready/07_wuxia_strafe_L_左垫步_cleaned.bvh', prefix: '07_wuxia_strafe_L', cyclic: true },
  { id: '07_strafe_R', relPath: 'B_cleaned_ready/07_wuxia_strafe_R_右垫步_cleaned.bvh', prefix: '07_wuxia_strafe_R', cyclic: true },
  { id: '07_strafe_FL', relPath: 'B_cleaned_ready/07_wuxia_strafe_FL_左前垫步_cleaned.bvh', prefix: '07_wuxia_strafe_FL', cyclic: true },
  { id: '07_strafe_FR', relPath: 'B_cleaned_ready/07_wuxia_strafe_FR_右前垫步_cleaned.bvh', prefix: '07_wuxia_strafe_FR', cyclic: true },
  { id: '07_strafe_BL', relPath: 'B_cleaned_ready/07_wuxia_strafe_BL_左后垫步_cleaned.bvh', prefix: '07_wuxia_strafe_BL', cyclic: true },
  { id: '07_strafe_BR', relPath: 'B_cleaned_ready/07_wuxia_strafe_BR_右后垫步_cleaned.bvh', prefix: '07_wuxia_strafe_BR', cyclic: true },
  { id: '08_dash_canglong', relPath: 'B_cleaned_ready/08_wuxia_dash_canglong_苍龙出水突刺_cleaned.bvh', prefix: '08_', cyclic: false },
  { id: '09_dodge_roll', relPath: 'B_cleaned_ready/09_wuxia_dodge_roll_翻滚闪避_cleaned.bvh', prefix: '09_', cyclic: false },
  { id: '10_double_jump', relPath: 'B_cleaned_ready/10_wuxia_double_jump_二段轻功跳_cleaned.bvh', prefix: '10_', cyclic: false, ballisticAir: true },
  { id: '11_hit_light_L', relPath: 'B_cleaned_ready/11_wuxia_hit_light_L_左轻受击_cleaned.bvh', prefix: '11_', cyclic: false },
  { id: '12_hit_light_R', relPath: 'B_cleaned_ready/12_wuxia_hit_light_R_右轻受击_cleaned.bvh', prefix: '12_', cyclic: false },
  { id: '13_knockdown', relPath: 'B_cleaned_ready/13_wuxia_knockdown_击飞倒地_cleaned.bvh', prefix: '13_', cyclic: false },
  { id: '14_kipup', relPath: 'B_cleaned_ready/14_wuxia_kipup_鲤鱼打挺起身_cleaned.bvh', prefix: '14_', cyclic: false },
  { id: '15_knockdown_kipup', relPath: 'B_cleaned_ready/15_wuxia_knockdown_kipup_击飞倒地接鲤鱼打挺_cleaned.bvh', prefix: '15_', cyclic: false },
  // C_taibai_extracted (taibai_01b..04 = 4 clips)
  { id: 'taibai_01b', relPath: 'C_taibai_extracted/taibai_01b_崖顶横剑定势_cleaned.bvh', prefix: 'taibai_01b', cyclic: true },
  { id: 'taibai_02', relPath: 'C_taibai_extracted/taibai_02_无痕剑意_独立提膝云剑_cleaned.bvh', prefix: 'taibai_02', cyclic: false },
  { id: 'taibai_03', relPath: 'C_taibai_extracted/taibai_03_雨落云飞_快剑五连斩_cleaned.bvh', prefix: 'taibai_03', cyclic: false },
  { id: 'taibai_04', relPath: 'C_taibai_extracted/taibai_04_飞燕逐月_腾空旋风跌叉_cleaned.bvh', prefix: 'taibai_04', cyclic: false, normalizeAerialRootY: true },
]);

const RAW_BVH_TARGET_CANDIDATES = [
  [BONE_IDX.Hips, [/^(hip|hips|pelvis)$/i, /^root$/i]],
  [BONE_IDX.Spine, [/^(abdomen|spine|spine_01|spine_02)$/i, /^lowerback$/i]],
  [BONE_IDX.Chest, [/^(chest|spine2|spine_03|spine_04|upperback|thorax|upperchest)$/i, /^spine1$/i]],
  [BONE_IDX.Neck, [/^(neck1|neck_01|neck)$/i]],
  [BONE_IDX.Head, [/^head$/i]],
  [BONE_IDX.LeftShoulder, [/^(lcollar|leftshoulder|l_clavicle|shoulder_l|clavicle_l)$/i]],
  [BONE_IDX.LeftUpperArm, [/^(lshldr|leftarm|leftupperarm|l_upperarm|upperarm_l)$/i]],
  [BONE_IDX.LeftForeArm, [/^(lforearm|leftforearm|leftlowerarm|l_forearm|lowerarm_l)$/i]],
  [BONE_IDX.LeftHand, [/^(lhand|lefthand|l_hand|hand_l)$/i]],
  [BONE_IDX.RightShoulder, [/^(rcollar|rightshoulder|r_clavicle|shoulder_r|clavicle_r)$/i]],
  [BONE_IDX.RightUpperArm, [/^(rshldr|rightarm|rightupperarm|r_upperarm|upperarm_r)$/i]],
  [BONE_IDX.RightForeArm, [/^(rforearm|rightforearm|rightlowerarm|r_forearm|lowerarm_r)$/i]],
  [BONE_IDX.RightHand, [/^(rhand|righthand|r_hand|hand_r)$/i]],
  [BONE_IDX.LeftUpLeg, [/^(lthigh|leftupleg|leftupperleg|leftthigh|l_thigh|thigh_l)$/i]],
  [BONE_IDX.LeftLeg, [/^(lshin|leftleg|leftlowerleg|leftcalf|leftshin|l_calf|calf_l)$/i]],
  [BONE_IDX.LeftFoot, [/^(lfoot|leftfoot|l_foot|foot_l)$/i]],
  [BONE_IDX.LeftToe, [/^(lefttoebase|ltoebase|lefttoe|lefttoes|ltoe|ball_l)$/i]],
  [BONE_IDX.RightUpLeg, [/^(rthigh|rightupleg|rightupperleg|rightthigh|r_thigh|thigh_r)$/i]],
  [BONE_IDX.RightLeg, [/^(rshin|rightleg|rightlowerleg|rightcalf|rightshin|r_calf|calf_r)$/i]],
  [BONE_IDX.RightFoot, [/^(rfoot|rightfoot|r_foot|foot_r)$/i]],
  [BONE_IDX.RightToe, [/^(righttoebase|rtoebase|righttoe|righttoes|rtoe|ball_r)$/i]],
];

const LIMB_ALIGNMENT_PAIRS = [
  [BONE_IDX.LeftUpperArm, BONE_IDX.LeftForeArm],
  [BONE_IDX.LeftForeArm, BONE_IDX.LeftHand],
  [BONE_IDX.RightUpperArm, BONE_IDX.RightForeArm],
  [BONE_IDX.RightForeArm, BONE_IDX.RightHand],
  [BONE_IDX.LeftUpLeg, BONE_IDX.LeftLeg],
  [BONE_IDX.LeftLeg, BONE_IDX.LeftFoot],
  [BONE_IDX.RightUpLeg, BONE_IDX.RightLeg],
  [BONE_IDX.RightLeg, BONE_IDX.RightFoot],
];

/**
 * Rejects HTML SPA fallback pages (e.g. `<!doctype html>`) and malformed responses.
 */
export function isValidBVHText(text) {
  return typeof text === 'string' && /^\s*HIERARCHY\b/.test(text) && /\bMOTION\b/.test(text);
}

export function createEmptyPoseFrame() {
  return {
    rootPos: new THREE.Vector3(0, 0.94, 0),
    quats: Array.from({ length: NUM_BONES }, () => new THREE.Quaternion()),
    contactL: null,
    contactR: null,
  };
}

export function clonePoseFrame(src) {
  return {
    rootPos: src.rootPos.clone(),
    quats: src.quats.map((q) => q.clone()),
    contactL: src.contactL ?? null,
    contactR: src.contactR ?? null,
  };
}

function addLocalEuler(quat, rx, ry, rz, order = 'XYZ') {
  const dq = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, order));
  quat.multiply(dq);
}

const VALID_BVH_CHANNELS = new Set([
  'Xposition',
  'Yposition',
  'Zposition',
  'Xrotation',
  'Yrotation',
  'Zrotation',
]);

/**
 * Strictly validates `.bvh` HIERARCHY & MOTION structure BEFORE invoking `BVHLoader` or motion parsing.
 * Guarantees truncated or malformed `.bvh` inputs throw a clean descriptive `Error` (zero `TypeError`,
 * zero `THREE.BVHLoader` console spam, and zero silent 0-frame returns).
 */
function preValidateAndScanBVH(bvhText) {
  if (!isValidBVHText(bvhText)) {
    throw new Error('Invalid or truncated BVH: missing HIERARCHY or MOTION section');
  }

  const lines = bvhText.split(/\r?\n/);
  let hierarchyIdx = -1;
  let motionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (hierarchyIdx < 0) {
      if (t !== 'HIERARCHY') {
        throw new Error('Invalid or truncated BVH: expected HIERARCHY header first');
      }
      hierarchyIdx = i;
      continue;
    }
    if (t === 'MOTION') {
      motionIdx = i;
      break;
    }
  }
  if (hierarchyIdx < 0 || motionIdx <= hierarchyIdx) {
    throw new Error('Invalid or truncated BVH: MOTION header not found after HIERARCHY');
  }

  const joints = [];
  const blockStack = [];
  let braceDepth = 0;
  let pendingBlock = null;

  for (let i = hierarchyIdx + 1; i < motionIdx; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    if (/^(ROOT|JOINT)\s+/i.test(trimmed)) {
      if (pendingBlock !== null) {
        throw new Error('Invalid or truncated BVH: missing opening { before joint declaration');
      }
      const parts = trimmed.split(/\s+/);
      const kind = parts[0].toUpperCase();
      if (kind === 'ROOT' && (braceDepth !== 0 || joints.length > 0)) {
        throw new Error('Invalid or truncated BVH: unexpected ROOT placement in HIERARCHY');
      }
      if (kind === 'JOINT' && (braceDepth < 1 || blockStack[blockStack.length - 1]?.type !== 'joint')) {
        throw new Error('Invalid or truncated BVH: JOINT outside active parent joint block');
      }
      const rawName = (parts[1] || '').replace(/^.*:/, '').trim();
      if (!rawName) {
        throw new Error('Invalid or truncated BVH: missing joint name');
      }
      pendingBlock = {
        type: 'joint',
        name: rawName,
        boneIdx: BONE_IDX[rawName] ?? -1,
        offsetCm: [0, 0, 0],
        channels: [],
        hasOffset: false,
        hasChannels: false,
      };
      joints.push(pendingBlock);
    } else if (/^End\s+Site\s*$/i.test(trimmed)) {
      if (pendingBlock !== null || braceDepth < 1 || blockStack[blockStack.length - 1]?.type !== 'joint') {
        throw new Error('Invalid or truncated BVH: invalid End Site placement');
      }
      pendingBlock = { type: 'end', hasOffset: false };
    } else if (trimmed === '{') {
      if (!pendingBlock) {
        throw new Error('Invalid or truncated BVH: unexpected opening { in HIERARCHY');
      }
      braceDepth += 1;
      blockStack.push(pendingBlock);
      pendingBlock = null;
    } else if (trimmed === '}') {
      if (pendingBlock !== null || braceDepth <= 0 || blockStack.length === 0) {
        throw new Error('Invalid or truncated BVH: unbalanced closing } in HIERARCHY');
      }
      const closed = blockStack.pop();
      braceDepth -= 1;
      if (!closed.hasOffset || (closed.type === 'joint' && !closed.hasChannels)) {
        throw new Error('Invalid or truncated BVH: joint block missing OFFSET or CHANNELS');
      }
    } else {
      if (pendingBlock !== null || blockStack.length === 0) {
        throw new Error('Invalid or truncated BVH: unexpected directive outside brace block');
      }
      const currentBlock = blockStack[blockStack.length - 1];
      if (/^OFFSET\s+/i.test(trimmed)) {
        const parts = trimmed.split(/\s+/);
        if (parts.length !== 4) {
          throw new Error('Invalid or truncated BVH: OFFSET requires exactly 3 coordinates');
        }
        const ox = Number(parts[1]);
        const oy = Number(parts[2]);
        const oz = Number(parts[3]);
        if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) {
          throw new Error('Invalid or truncated BVH: non-finite OFFSET coordinates');
        }
        currentBlock.hasOffset = true;
        if (currentBlock.type === 'joint') {
          currentBlock.offsetCm = [ox, oy, oz];
        }
      } else if (/^CHANNELS\s+/i.test(trimmed) && currentBlock.type === 'joint') {
        const parts = trimmed.split(/\s+/);
        const count = Number(parts[1]);
        if (!Number.isInteger(count) || count < 0 || parts.length !== 2 + count) {
          throw new Error('Invalid or truncated BVH: malformed CHANNELS count or list');
        }
        const chList = parts.slice(2, 2 + count);
        for (let c = 0; c < chList.length; c++) {
          if (!VALID_BVH_CHANNELS.has(chList[c])) {
            throw new Error(`Invalid or truncated BVH: unknown channel ${chList[c]}`);
          }
        }
        currentBlock.channels = chList;
        currentBlock.hasChannels = true;
      } else {
        throw new Error('Invalid or truncated BVH: unrecognized HIERARCHY line');
      }
    }
  }

  if (pendingBlock !== null || braceDepth !== 0 || blockStack.length !== 0) {
    throw new Error('Invalid or truncated BVH: unbalanced braces in HIERARCHY');
  }
  const totalChannels = joints.reduce((sum, j) => sum + j.channels.length, 0);
  if (joints.length === 0 || totalChannels < 3) {
    throw new Error('Invalid or truncated BVH: empty skeleton or fewer than 3 motion channels');
  }

  let declaredFrames = NaN;
  let frameTimeSec = NaN;
  let foundFramesHeader = false;
  let foundFrameTimeHeader = false;
  let dataStartIdx = -1;

  for (let i = motionIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (!foundFramesHeader) {
      const m = trimmed.match(/^Frames\s*:\s*([+-]?\d+)\s*$/i);
      if (!m) {
        throw new Error('Invalid or truncated BVH: missing or malformed Frames header');
      }
      declaredFrames = parseInt(m[1], 10);
      foundFramesHeader = true;
    } else if (!foundFrameTimeHeader) {
      const m = trimmed.match(/^Frame\s+Time\s*:\s*(\S+)\s*$/i);
      if (!m) {
        throw new Error('Invalid or truncated BVH: missing or malformed Frame Time header');
      }
      frameTimeSec = Number(m[1]);
      foundFrameTimeHeader = true;
      dataStartIdx = i + 1;
      break;
    }
  }

  if (
    !foundFramesHeader ||
    !foundFrameTimeHeader ||
    !Number.isFinite(declaredFrames) ||
    declaredFrames <= 0 ||
    !Number.isFinite(frameTimeSec) ||
    frameTimeSec <= 0
  ) {
    throw new Error('Invalid or truncated BVH: Frames and Frame Time must be finite and > 0');
  }

  const numericRows = [];
  for (let i = dataStartIdx; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < totalChannels) {
      throw new Error(
        `Invalid or truncated BVH: motion row has ${parts.length} values, expected >= ${totalChannels}`
      );
    }
    const row = new Float64Array(totalChannels);
    for (let k = 0; k < totalChannels; k++) {
      const val = Number(parts[k]);
      if (!Number.isFinite(val)) {
        throw new Error('Invalid or truncated BVH: non-finite numeric value in motion data');
      }
      row[k] = val;
    }
    numericRows.push(row);
    if (numericRows.length >= declaredFrames) {
      break;
    }
  }

  if (numericRows.length === 0 || numericRows.length < declaredFrames) {
    throw new Error(
      `Invalid or truncated BVH: declared ${declaredFrames} frames but found ${numericRows.length} complete motion rows`
    );
  }

  return {
    joints,
    totalChannels,
    declaredFrames,
    frameTimeSec,
    numericRows,
  };
}

/**
 * Self-contained parser for standard 21-bone (`cm`, `ZXY` Euler, 66-channel) `.bvh` files,
 * automatically falling back to anatomical world-space retargeting for raw MakeHuman/CMU `.bvh` files.
 */
export function parseBVHToRawFrames(bvhText, targetFps = 60) {
  const { joints, totalChannels, frameTimeSec, numericRows } = preValidateAndScanBVH(bvhText);

  const isCanonical21Bone =
    joints.length >= 19 &&
    joints[0]?.boneIdx === BONE_IDX.Hips &&
    joints.every((j) => j.boneIdx >= 0);

  if (!isCanonical21Bone) {
    return retargetRawMocapFallback(bvhText, targetFps, true);
  }

  const fps = Math.max(1, Math.round(1 / frameTimeSec));
  const euler = new THREE.Euler();
  const frames = [];

  for (let rIdx = 0; rIdx < numericRows.length; rIdx++) {
    const row = numericRows[rIdx];
    const frame = createEmptyPoseFrame();
    let cursor = 0;

    for (let jIdx = 0; jIdx < joints.length; jIdx++) {
      const joint = joints[jIdx];
      let px = joint.offsetCm[0];
      let py = joint.offsetCm[1];
      let pz = joint.offsetCm[2];
      let rx = 0;
      let ry = 0;
      let rz = 0;
      let rotOrder = '';

      for (let c = 0; c < joint.channels.length; c++) {
        const val = row[cursor++];
        const ch = joint.channels[c];
        if (ch === 'Xposition') px += val;
        else if (ch === 'Yposition') py += val;
        else if (ch === 'Zposition') pz += val;
        else if (ch === 'Zrotation') {
          rz = val * DEG2RAD;
          rotOrder += 'Z';
        } else if (ch === 'Xrotation') {
          rx = val * DEG2RAD;
          rotOrder += 'X';
        } else if (ch === 'Yrotation') {
          ry = val * DEG2RAD;
          rotOrder += 'Y';
        }
      }

      if (joint.boneIdx === BONE_IDX.Hips) {
        frame.rootPos.set(px * 0.01, py * 0.01, pz * 0.01);
      }
      if (rotOrder.length === 3) {
        euler.set(rx, ry, rz, rotOrder);
        frame.quats[joint.boneIdx].setFromEuler(euler);
      }
    }

    frames.push(frame);
  }

  if (frames.length === 0) {
    throw new Error('Invalid or truncated BVH: 0 motion frames parsed');
  }

  return {
    frames,
    fps,
    jointCount: joints.length,
    totalChannels,
    isCanonical21Bone: true,
  };
}

/**
 * Self-contained anatomical retargeter for raw MakeHuman / CMU `.bvh` sources (`bvhBundle.js` & `/mocap/*.bvh`).
 * Fixes `calf_r`, includes `LeftToe`/`RightToe`, lifts 240-frame cap, and preserves raw trajectory for Frame-0 normalization.
 */
export function retargetRawMocapFallback(bvhText, targetFps = 60, _preValidated = false) {
  if (!_preValidated) {
    preValidateAndScanBVH(bvhText);
  }
  const loader = new BVHLoader();
  const { clip, skeleton } = loader.parse(bvhText);
  if (!skeleton?.bones?.length || !clip) {
    throw new Error('Invalid or truncated BVH: empty skeleton or animation clip');
  }

  const duration = Math.max(clip.duration, 0.2);
  const totalFrames = Math.max(24, Math.round(duration * targetFps));

  const cleanBones = skeleton.bones.map((b) => ({
    bone: b,
    cleanName: b.name.replace(/^.*:/, '').trim(),
  }));

  const srcByDst = new Array(NUM_BONES).fill(null);
  for (const [dstIdx, regexList] of RAW_BVH_TARGET_CANDIDATES) {
    for (const regex of regexList) {
      const match = cleanBones.find((entry) => regex.test(entry.cleanName));
      if (match) {
        srcByDst[dstIdx] = match.bone;
        break;
      }
    }
  }

  const bvhRoot = skeleton.bones[0];
  bvhRoot.updateWorldMatrix(true, true);

  const { bones: dstBones } = createBoneHierarchy();
  dstBones[0].updateWorldMatrix(true, true);

  const pParentSrc = new THREE.Vector3();
  const pChildSrc = new THREE.Vector3();
  const pParentDst = new THREE.Vector3();
  const pChildDst = new THREE.Vector3();
  const uSrcRest = new THREE.Vector3();
  const uDstRest = new THREE.Vector3();

  const qAlign = new Array(NUM_BONES).fill(null);
  for (const [pIdx, cIdx] of LIMB_ALIGNMENT_PAIRS) {
    const sParent = srcByDst[pIdx];
    const sChild = srcByDst[cIdx];
    if (sParent && sChild) {
      sParent.getWorldPosition(pParentSrc);
      sChild.getWorldPosition(pChildSrc);
      uSrcRest.subVectors(pChildSrc, pParentSrc);

      dstBones[pIdx].getWorldPosition(pParentDst);
      dstBones[cIdx].getWorldPosition(pChildDst);
      uDstRest.subVectors(pChildDst, pParentDst);

      if (uSrcRest.lengthSq() > 1e-6 && uDstRest.lengthSq() > 1e-6) {
        uSrcRest.normalize();
        uDstRest.normalize();
        qAlign[pIdx] = new THREE.Quaternion().setFromUnitVectors(uDstRest, uSrcRest);
      }
    }
  }

  let srcLegLen = 0;
  if (srcByDst[BONE_IDX.LeftUpLeg] && srcByDst[BONE_IDX.LeftLeg] && srcByDst[BONE_IDX.LeftFoot]) {
    srcByDst[BONE_IDX.LeftUpLeg].getWorldPosition(pParentSrc);
    srcByDst[BONE_IDX.LeftLeg].getWorldPosition(pChildSrc);
    srcLegLen += pParentSrc.distanceTo(pChildSrc);
    srcByDst[BONE_IDX.LeftFoot].getWorldPosition(pParentSrc);
    srcLegLen += pChildSrc.distanceTo(pParentSrc);
  }

  const mixer = new THREE.AnimationMixer(bvhRoot);
  const action = mixer.clipAction(clip);
  action.play();

  mixer.setTime(0);
  bvhRoot.updateWorldMatrix(true, true);
  const rawHipY = Math.abs(bvhRoot.position.y);
  let posScale = 1.0;
  if (srcLegLen > 1e-4) {
    posScale = 0.82 / srcLegLen;
  } else if (rawHipY > 60) {
    posScale = 0.01;
  } else if (rawHipY > 12) {
    posScale = 0.94 / rawHipY;
  }

  const qWorldSrc = new THREE.Quaternion();
  const qWorldParent = new THREE.Quaternion();
  const tmpFootL = new THREE.Vector3();
  const tmpFootR = new THREE.Vector3();

  const frames = [];
  let minAnkleY = Infinity;

  for (let f = 0; f < totalFrames; f++) {
    const t = (f / Math.max(1, totalFrames - 1)) * Math.max(0.01, duration - 0.001);
    mixer.setTime(t);
    bvhRoot.updateWorldMatrix(true, true);

    const frame = createEmptyPoseFrame();
    frame.rootPos.set(
      bvhRoot.position.x * posScale,
      bvhRoot.position.y * posScale,
      bvhRoot.position.z * posScale
    );
    dstBones[0].position.copy(frame.rootPos);

    for (let b = 0; b < NUM_BONES; b++) {
      const srcBone = srcByDst[b];
      if (srcBone) {
        srcBone.getWorldQuaternion(qWorldSrc);
        if (qAlign[b]) qWorldSrc.multiply(qAlign[b]);
        if (b === 0) {
          dstBones[0].quaternion.copy(qWorldSrc);
        } else {
          dstBones[b].parent.getWorldQuaternion(qWorldParent);
          dstBones[b].quaternion.copy(qWorldParent).invert().multiply(qWorldSrc);
        }
      } else {
        dstBones[b].quaternion.identity();
      }
      dstBones[b].updateWorldMatrix(false, false);
      frame.quats[b].copy(dstBones[b].quaternion);
    }

    dstBones[0].updateWorldMatrix(true, true);
    dstBones[BONE_IDX.LeftFoot].getWorldPosition(tmpFootL);
    dstBones[BONE_IDX.RightFoot].getWorldPosition(tmpFootR);
    minAnkleY = Math.min(minAnkleY, tmpFootL.y, tmpFootR.y);
    frames.push(frame);
  }

  const yShift = 0.08 - minAnkleY;
  for (let i = 0; i < frames.length; i++) {
    frames[i].rootPos.y += yShift;
  }

  if (frames.length === 0) {
    throw new Error('Invalid or truncated BVH: 0 retargeted frames');
  }

  return {
    frames,
    fps: targetFps,
    jointCount: skeleton.bones.length,
    totalChannels: skeleton.bones.length * 3 + 3,
    isCanonical21Bone: false,
  };
}

/**
 * Anchors horizontal Frame-0 origin `(x0, z0)`, extracts `rootTrackXZ` & `rootVelXZ`,
 * zeroes horizontal `frame.rootPos.x/z` on non-cyclic clips (zero double root motion),
 * and strips linear secular drift on cyclic clips (`07_strafe_*`).
 */
export function normalizeCombatClip(id, rawFrames, fps = 60, options = {}) {
  const cyclic = Boolean(options.cyclic);
  const provenance = options.provenance || 'derived_kinematic';
  const N = rawFrames.length;
  if (N === 0) {
    throw new Error(`Clip ${id} has 0 frames`);
  }

  const x0 = rawFrames[0].rootPos.x;
  const y0 = rawFrames[0].rootPos.y;
  const z0 = rawFrames[0].rootPos.z;

  const rootTrackXZ = new Float32Array(N * 2);
  const rootVelXZ = new Array(N);
  let maxDispZ = 0;
  let maxDispRadius = 0;

  for (let f = 0; f < N; f++) {
    const rx = rawFrames[f].rootPos.x - x0;
    const rz = rawFrames[f].rootPos.z - z0;
    rootTrackXZ[f * 2] = rx;
    rootTrackXZ[f * 2 + 1] = rz;
    if (rz > maxDispZ) maxDispZ = rz;
    const rad = Math.hypot(rx, rz);
    if (rad > maxDispRadius) maxDispRadius = rad;

    if (f === 0) {
      rootVelXZ[0] = { x: 0, z: 0 };
    } else {
      const px = rootTrackXZ[(f - 1) * 2];
      const pz = rootTrackXZ[(f - 1) * 2 + 1];
      rootVelXZ[f] = {
        x: (rx - px) * fps,
        z: (rz - pz) * fps,
      };
    }
  }

  const netX = rootTrackXZ[(N - 1) * 2];
  const netZ = rootTrackXZ[(N - 1) * 2 + 1];

  const frames = new Array(N);
  for (let f = 0; f < N; f++) {
    const fr = clonePoseFrame(rawFrames[f]);
    if (cyclic) {
      const frac = f / Math.max(1, N - 1);
      let sx = rootTrackXZ[f * 2] - frac * netX;
      let sz = rootTrackXZ[f * 2 + 1] - frac * netZ;
      const swayMag = Math.hypot(sx, sz);
      if (swayMag > 0.035) {
        const scale = 0.035 / swayMag;
        sx *= scale;
        sz *= scale;
      }
      fr.rootPos.set(sx, rawFrames[f].rootPos.y, sz);
    } else {
      let adjY = rawFrames[f].rootPos.y;
      if (options.ballisticAir) {
        // World Y is integrated ballistically by CombatStateMachine; keep subtle hip tuck locally
        adjY = THREE.MathUtils.clamp(0.88 + (adjY - y0) * 0.15, 0.72, 0.98);
      } else if (options.normalizeAerialRootY) {
        // Keep aerial kick crouch/extension within [0.74..1.04m] while FSM provides controlled world elevation
        adjY = THREE.MathUtils.clamp(0.88 + (adjY - y0) * 0.35, 0.74, 1.04);
      }
      fr.rootPos.set(0, adjY, 0);
    }
    frames[f] = fr;
  }

  return {
    id,
    frames,
    fps,
    durationSec: N / fps,
    cyclic,
    nonCyclic: !cyclic,
    provenance,
    rootTrackXZ,
    rootVelXZ,
    netDisplacementXZ: { x: netX, z: netZ },
    peakForwardMeters: maxDispZ,
    maxRadiusMeters: maxDispRadius,
  };
}

/**
 * Samples continuous horizontal clip root delta `(dx, dz)` between `[uPrev, uCurr]` in character-local meters.
 */
export function sampleClipRootDeltaXZ(clip, uPrev, uCurr) {
  if (!clip || !clip.rootTrackXZ || clip.frames.length < 2) {
    return { x: 0, z: 0 };
  }
  const N = clip.frames.length;
  const sampleAt = (u) => {
    const cu = THREE.MathUtils.clamp(u, 0, 1);
    const t = cu * (N - 1);
    const i0 = Math.min(N - 1, Math.floor(t));
    const i1 = Math.min(N - 1, i0 + 1);
    const a = t - i0;
    return {
      x: clip.rootTrackXZ[i0 * 2] * (1 - a) + clip.rootTrackXZ[i1 * 2] * a,
      z: clip.rootTrackXZ[i0 * 2 + 1] * (1 - a) + clip.rootTrackXZ[i1 * 2 + 1] * a,
    };
  };
  const p0 = sampleAt(uPrev);
  const p1 = sampleAt(uCurr);
  return { x: p1.x - p0.x, z: p1.z - p0.z };
}

function sampleRawPoseAt(frames, u, cyclic = false) {
  const N = frames.length;
  const out = createEmptyPoseFrame();
  if (N === 0) return out;
  if (N === 1) return clonePoseFrame(frames[0]);

  let f0;
  let f1;
  let alpha;
  if (cyclic) {
    const wu = ((u % 1) + 1) % 1;
    const t = wu * N;
    f0 = Math.floor(t) % N;
    f1 = (f0 + 1) % N;
    alpha = t - Math.floor(t);
  } else {
    const cu = THREE.MathUtils.clamp(u, 0, 1);
    const t = cu * (N - 1);
    f0 = Math.min(N - 1, Math.floor(t));
    f1 = Math.min(N - 1, f0 + 1);
    alpha = t - f0;
  }

  out.rootPos.lerpVectors(frames[f0].rootPos, frames[f1].rootPos, alpha);
  for (let i = 0; i < NUM_BONES; i++) {
    out.quats[i].copy(frames[f0].quats[i]).slerp(frames[f1].quats[i], alpha);
  }
  return out;
}

function buildProceduralBreathingIdleRaw(frameCount = 90) {
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const phase = (f / frameCount) * Math.PI * 2;
    const breath = Math.sin(phase);
    const fr = createEmptyPoseFrame();
    fr.rootPos.set(0, 0.925 + breath * 0.004, 0);
    addLocalEuler(fr.quats[BONE_IDX.Hips], 0.03, -0.18, 0);
    addLocalEuler(fr.quats[BONE_IDX.Spine], 0.04 + breath * 0.015, 0.08, 0);
    addLocalEuler(fr.quats[BONE_IDX.Chest], 0.03 + breath * 0.02, 0.12, 0);
    addLocalEuler(fr.quats[BONE_IDX.LeftUpLeg], -0.10, 0.08, 0.06);
    addLocalEuler(fr.quats[BONE_IDX.LeftLeg], 0.18, 0, 0);
    addLocalEuler(fr.quats[BONE_IDX.LeftFoot], -0.08, 0, 0);
    addLocalEuler(fr.quats[BONE_IDX.RightUpLeg], 0.06, -0.08, -0.06);
    addLocalEuler(fr.quats[BONE_IDX.RightLeg], 0.14, 0, 0);
    addLocalEuler(fr.quats[BONE_IDX.RightFoot], -0.18, 0, 0);
    // Relaxed arms down-forward
    addLocalEuler(fr.quats[BONE_IDX.LeftUpperArm], 0.25, 0.35, 1.05);
    addLocalEuler(fr.quats[BONE_IDX.LeftForeArm], 0.15, 0.55, 0.10);
    addLocalEuler(fr.quats[BONE_IDX.RightUpperArm], 0.32, -0.42, -1.02);
    addLocalEuler(fr.quats[BONE_IDX.RightForeArm], 0.20, -0.68, -0.12);
    frames.push(fr);
  }
  return frames;
}

function applyWuxiaSwordGuardOverlay(frame, breath = 0, intensity = 1.0) {
  const guardPose = {
    [BONE_IDX.LeftShoulder]: [0.05, 0.12, 0.10],
    [BONE_IDX.LeftUpperArm]: [0.42, 0.58, 0.92],
    [BONE_IDX.LeftForeArm]: [0.22, 0.88, 0.18],
    [BONE_IDX.LeftHand]: [0.08, 0.15, -0.12],
    [BONE_IDX.RightShoulder]: [0.06, -0.16, -0.08],
    [BONE_IDX.RightUpperArm]: [0.48 + breath * 0.02, -0.52, -0.86],
    [BONE_IDX.RightForeArm]: [0.26, -0.92, -0.22],
    [BONE_IDX.RightHand]: [0.28, -0.35, 0.16 + breath * 0.02],
  };
  const tmp = new THREE.Quaternion();
  for (const [idxStr, [rx, ry, rz]] of Object.entries(guardPose)) {
    const idx = Number(idxStr);
    tmp.setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
    frame.quats[idx].slerp(tmp, intensity);
  }
}

function sliceAndWarpComboSubClip(swordClip, uStart, uEnd, outFrames, windupCompress = 1.55, pitchBias = 0, rollBias = 0) {
  const raw = [];
  for (let f = 0; f < outFrames; f++) {
    const uNorm = f / Math.max(1, outFrames - 1);
    // Compress windup (first 28% of swing) so blade reaches active window in ~4 frames
    let warped;
    if (uNorm < 0.24) {
      warped = (uNorm / 0.24) * 0.38;
    } else {
      warped = 0.38 + ((uNorm - 0.24) / 0.76) * 0.62;
    }
    warped = Math.pow(THREE.MathUtils.clamp(warped, 0, 1), 1 / Math.max(1, windupCompress * 0.68));
    const srcU = uStart + (uEnd - uStart) * warped;
    const fr = sampleRawPoseAt(swordClip.frames, srcU, false);
    const strikeEnv = Math.sin(uNorm * Math.PI);
    // Pitch torso & extend right arm slightly forward (+Z) so greatsword cleaves cleanly across dueling range
    addLocalEuler(fr.quats[BONE_IDX.Spine], 0.14 * strikeEnv + pitchBias * 0.4, 0, rollBias * 0.3);
    addLocalEuler(fr.quats[BONE_IDX.Chest], 0.18 * strikeEnv + pitchBias * 0.6, 0.10 * strikeEnv, rollBias * 0.5);
    fr.rootPos.set(0, fr.rootPos.y, uNorm * 0.52);
    raw.push(fr);
  }
  return raw;
}

export class CombatClipRegistry {
  constructor() {
    this.clips = new Map();
    this.aliasMap = new Map();
    this._initializedBaseline = false;
  }

  _registerClip(clip, aliases = []) {
    this.clips.set(clip.id, clip);
    this.aliasMap.set(clip.id.toLowerCase(), clip.id);
    for (const alias of aliases) {
      if (alias) this.aliasMap.set(String(alias).toLowerCase(), clip.id);
    }
  }

  /**
   * Synchronously populates all 26 canonical clip IDs + 4 tactical sub-clips (`combo_1..3`, `jump`)
   * from bundled optical mocap (`bvhBundle.js`) + kinematic derivations so `getState()` works immediately.
   */
  populateBaselineSync() {
    if (this._initializedBaseline) return;
    this._initializedBaseline = true;

    const needBase = (id) => {
      const ex = this.clips.get(id);
      return !ex || ex.provenance !== 'bvh_library';
    };

    if (needBase('01_idle')) {
      const idleRaw = buildProceduralBreathingIdleRaw(90);
      this._registerClip(
        normalizeCombatClip('01_idle', idleRaw, 60, { cyclic: true, provenance: 'derived_kinematic' }),
        ['01_wuxia_idle_待机呼吸_cleaned']
      );
    }
    if (needBase('02_run')) {
      const runParsed = parseBVHToRawFrames(MOCAP_RUN_BVH, 60);
      this._registerClip(
        normalizeCombatClip('02_run', runParsed.frames, 60, { cyclic: true, provenance: 'bvh_bundle' }),
        ['02_wuxia_run_疾跑轻功_cleaned']
      );
    }
    if (needBase('03_sword_combo')) {
      const swordParsed = parseBVHToRawFrames(MOCAP_SWORD_STRIKE_BVH, 60);
      this._registerClip(
        normalizeCombatClip('03_sword_combo', swordParsed.frames, 60, { cyclic: false, provenance: 'bvh_bundle' }),
        ['03_wuxia_sword_combo_剑术连斩去穿模_cleaned']
      );
    }
    if (needBase('04_tornado_kick') || needBase('05_front_kick')) {
      const kickParsed = parseBVHToRawFrames(MOCAP_KICK_BVH, 60);
      if (needBase('04_tornado_kick')) {
        this._registerClip(
          normalizeCombatClip('04_tornado_kick', kickParsed.frames, 60, { cyclic: false, provenance: 'bvh_bundle' }),
          ['04_wuxia_tornado_kick_旋风回旋踢_cleaned']
        );
      }
      if (needBase('05_front_kick')) {
        const frontKickRaw = [];
        for (let f = 0; f < 60; f++) {
          const u = f / 59;
          const fr = sampleRawPoseAt(kickParsed.frames, 0.12 + u * 0.42, false);
          const env = Math.sin(u * Math.PI);
          fr.rootPos.set(0, 0.92 - 0.04 * env, 0.50 * Math.sin(Math.min(1, u * 1.35) * Math.PI * 0.85));
          addLocalEuler(fr.quats[BONE_IDX.RightUpLeg], -1.15 * env, 0, 0);
          addLocalEuler(fr.quats[BONE_IDX.RightLeg], 0.85 * Math.sin(Math.min(1, u * 2) * Math.PI) * (1 - env * 0.7), 0, 0);
          frontKickRaw.push(fr);
        }
        this._registerClip(
          normalizeCombatClip('05_front_kick', frontKickRaw, 60, { cyclic: false, provenance: 'bvh_bundle' }),
          ['05_wuxia_front_kick_正蹬破防踢_cleaned']
        );
      }
    }
    if (needBase('06_backflip')) {
      const backflipParsed = parseBVHToRawFrames(MOCAP_BACKFLIP_BVH, 60);
      this._registerClip(
        normalizeCombatClip('06_backflip', backflipParsed.frames, 60, { cyclic: false, provenance: 'bvh_bundle' }),
        ['06_wuxia_backflip_原地后空翻_cleaned']
      );
    }

    this._rebuildDerivedClips(true);
  }

  /**
   * Builds or refreshes any derived clips that were NOT loaded directly from `bvh_library`,
   * plus the tactical 3-hit combo slices (`combo_1..3`) and ballistic `jump` clip.
   */
  _rebuildDerivedClips(preserveRealLibraryClips = true) {
    const canOverwrite = (id) => {
      if (!preserveRealLibraryClips) return true;
      const existing = this.clips.get(id);
      return !existing || existing.provenance !== 'bvh_library';
    };

    const idleClip = this.clips.get('01_idle');
    const runClip = this.clips.get('02_run');
    const swordClip = this.clips.get('03_sword_combo');
    const tornadoClip = this.clips.get('04_tornado_kick');
    const backflipClip = this.clips.get('06_backflip');

    // 1. Tactical 3-Hit Sword Combo slices (`combo_1`, `combo_2`, `combo_3`) from `03_sword_combo`
    // Empirical 03_sword_combo phases: [0.24..0.54] = forward cleave 1 (tip Z=+1.59m at srcU=0.44); [0.54..0.86] = reverse cross-slash 2 (tip Z=+1.42m at srcU=0.73)
    const c1Raw = sliceAndWarpComboSubClip(swordClip, 0.24, 0.54, 30, 1.6, 0.08, -0.04);
    const c2Raw = sliceAndWarpComboSubClip(swordClip, 0.54, 0.86, 30, 1.6, 0.08, 0.10);
    const c3Raw = sliceAndWarpComboSubClip(swordClip, 0.24, 0.84, 36, 1.8, 0.16, -0.08);
    this._registerClip(normalizeCombatClip('combo_1', c1Raw, 60, { cyclic: false, provenance: swordClip.provenance }));
    this._registerClip(normalizeCombatClip('combo_2', c2Raw, 60, { cyclic: false, provenance: swordClip.provenance }));
    this._registerClip(normalizeCombatClip('combo_3', c3Raw, 60, { cyclic: false, provenance: swordClip.provenance }));

    // 2. `taibai_01b` (Combat sword-ready cliff stance)
    if (canOverwrite('taibai_01b')) {
      const N = idleClip.frames.length;
      const raw = [];
      for (let f = 0; f < N; f++) {
        const phase = (f / N) * Math.PI * 2;
        const breath = Math.sin(phase);
        const fr = clonePoseFrame(idleClip.frames[f]);
        // Wuxia combat guard: pull sword hand forward-chest with blade poised diagonally
        const swordPose = sampleRawPoseAt(swordClip.frames, 0.04, false);
        for (const bIdx of [
          BONE_IDX.Spine, BONE_IDX.Chest,
          BONE_IDX.RightShoulder, BONE_IDX.RightUpperArm, BONE_IDX.RightForeArm, BONE_IDX.RightHand,
          BONE_IDX.LeftShoulder, BONE_IDX.LeftUpperArm, BONE_IDX.LeftForeArm, BONE_IDX.LeftHand,
        ]) {
          fr.quats[bIdx].slerp(swordPose.quats[bIdx], bIdx <= BONE_IDX.Chest ? 0.45 : 0.82);
        }
        addLocalEuler(fr.quats[BONE_IDX.Chest], breath * 0.018, 0, 0);
        raw.push(fr);
      }
      this._registerClip(normalizeCombatClip('taibai_01b', raw, idleClip.fps, { cyclic: true, provenance: 'derived_kinematic' }), [
        'taibai_01b_崖顶横剑定势_cleaned',
      ]);
    }

    // 3. `07_strafe_{F,B,L,R,FL,FR,BL,BR}` (8-Way Lock-On Strafe)
    const sectorDefs = [
      { id: '07_strafe_F', dirX: 0, dirZ: 1, rev: false, bankZ: 0, hipYaw: 0 },
      { id: '07_strafe_B', dirX: 0, dirZ: -1, rev: true, bankZ: 0, hipYaw: 0 },
      { id: '07_strafe_L', dirX: 1, dirZ: 0, rev: false, bankZ: -0.14, hipYaw: 0.34 },
      { id: '07_strafe_R', dirX: -1, dirZ: 0, rev: false, bankZ: 0.14, hipYaw: -0.34 },
      { id: '07_strafe_FL', dirX: 0.707, dirZ: 0.707, rev: false, bankZ: -0.08, hipYaw: 0.22 },
      { id: '07_strafe_FR', dirX: -0.707, dirZ: 0.707, rev: false, bankZ: 0.08, hipYaw: -0.22 },
      { id: '07_strafe_BL', dirX: 0.707, dirZ: -0.707, rev: true, bankZ: -0.08, hipYaw: -0.22 },
      { id: '07_strafe_BR', dirX: -0.707, dirZ: -0.707, rev: true, bankZ: 0.08, hipYaw: 0.22 },
    ];
    const guardRef = sampleRawPoseAt(swordClip.frames, 0.05, false);
    for (const sDef of sectorDefs) {
      if (!canOverwrite(sDef.id)) continue;
      const N = 48;
      const raw = [];
      for (let f = 0; f < N; f++) {
        const u = f / N;
        const sampleU = sDef.rev ? (1 - u) % 1 : u;
        const fr = sampleRawPoseAt(runClip.frames, sampleU, true);
        const stepWave = Math.sin(u * Math.PI * 2);
        addLocalEuler(fr.quats[BONE_IDX.Hips], 0.05, sDef.hipYaw, sDef.bankZ * 0.4);
        addLocalEuler(fr.quats[BONE_IDX.LeftUpLeg], 0, 0, sDef.bankZ * 0.8 * stepWave);
        addLocalEuler(fr.quats[BONE_IDX.RightUpLeg], 0, 0, -sDef.bankZ * 0.8 * stepWave);
        // Stabilize upper body into ready sword guard facing target (+Z)
        addLocalEuler(fr.quats[BONE_IDX.Spine], 0.06, -sDef.hipYaw * 0.55, -sDef.bankZ * 0.25);
        addLocalEuler(fr.quats[BONE_IDX.Chest], 0.08, -sDef.hipYaw * 0.45, -sDef.bankZ * 0.15);
        for (const bIdx of [
          BONE_IDX.LeftShoulder, BONE_IDX.LeftUpperArm, BONE_IDX.LeftForeArm, BONE_IDX.LeftHand,
          BONE_IDX.RightShoulder, BONE_IDX.RightUpperArm, BONE_IDX.RightForeArm, BONE_IDX.RightHand,
        ]) {
          fr.quats[bIdx].slerp(guardRef.quats[bIdx], 0.78);
        }
        fr.rootPos.set(sDef.dirX * u * 2.8, fr.rootPos.y * 0.97, sDef.dirZ * u * 2.8);
        raw.push(fr);
      }
      this._registerClip(normalizeCombatClip(sDef.id, raw, 60, { cyclic: true, provenance: 'derived_kinematic' }));
    }

    // 4. `08_dash_canglong` (苍龙出水 forward lunge thrust)
    if (canOverwrite('08_dash_canglong')) {
      const N = 30;
      const raw = [];
      for (let f = 0; f < N; f++) {
        const u = f / (N - 1);
        const thrustEnv = Math.sin(Math.min(1, u * 1.25) * Math.PI);
        const runPose = sampleRawPoseAt(runClip.frames, 0.28, true);
        const strikePose = sampleRawPoseAt(swordClip.frames, 0.44, false);
        for (let b = BONE_IDX.Spine; b <= BONE_IDX.RightHand; b++) {
          runPose.quats[b].slerp(strikePose.quats[b], 0.88);
        }
        addLocalEuler(runPose.quats[BONE_IDX.Hips], 0.18 * thrustEnv, -0.35 * thrustEnv, 0);
        addLocalEuler(runPose.quats[BONE_IDX.Spine], 0.20 * thrustEnv, 0, 0);
        addLocalEuler(runPose.quats[BONE_IDX.Chest], 0.18 * thrustEnv, 0.12 * thrustEnv, 0);
        runPose.rootPos.set(0, 0.84 - 0.08 * thrustEnv, 3.4 * (1 - Math.pow(1 - u, 2.4)));
        raw.push(runPose);
      }
      this._registerClip(normalizeCombatClip('08_dash_canglong', raw, 60, { cyclic: false, provenance: 'derived_kinematic' }), [
        '08_wuxia_dash_canglong_苍龙出水突刺_cleaned',
      ]);
    }

    // 5. `09_dodge_roll` (360° tucked forward dodge roll)
    if (canOverwrite('09_dodge_roll')) {
      const N = 30;
      const raw = [];
      for (let f = 0; f < N; f++) {
        const u = f / (N - 1);
        const tuck = Math.sin(u * Math.PI);
        const rollAngle = u * Math.PI * 2;
        const fr = sampleRawPoseFrameWithTuck(idleClip.frames[0], tuck, rollAngle);
        fr.rootPos.set(0, 0.90 - 0.46 * tuck, 3.0 * (1 - Math.pow(1 - u, 2.1)));
        raw.push(fr);
      }
      this._registerClip(normalizeCombatClip('09_dodge_roll', raw, 60, { cyclic: false, provenance: 'derived_kinematic' }), [
        '09_wuxia_dodge_roll_翻滚闪避_cleaned',
      ]);
    }

    // 6. `jump` & `10_double_jump` (Lightness skill jump & mid-air twist double-jump)
    {
      const N = 44;
      const jumpRaw = [];
      for (let f = 0; f < N; f++) {
        const u = f / (N - 1);
        const air = Math.sin(u * Math.PI);
        const fr = clonePoseFrame(idleClip.frames[0]);
        applyWuxiaSwordGuardOverlay(fr, 0, 0.75);
        addLocalEuler(fr.quats[BONE_IDX.Hips], 0.08 * air, 0, 0);
        addLocalEuler(fr.quats[BONE_IDX.LeftUpLeg], -0.58 * air, 0, 0);
        addLocalEuler(fr.quats[BONE_IDX.LeftLeg], 0.92 * air, 0, 0);
        addLocalEuler(fr.quats[BONE_IDX.RightUpLeg], -0.32 * air, 0, 0);
        addLocalEuler(fr.quats[BONE_IDX.RightLeg], 0.62 * air, 0, 0);
        fr.rootPos.set(0, 0.90 + 0.55 * air, 0);
        jumpRaw.push(fr);
      }
      this._registerClip(normalizeCombatClip('jump', jumpRaw, 60, { cyclic: false, ballisticAir: true, provenance: 'derived_kinematic' }));

      if (canOverwrite('10_double_jump')) {
        const djRaw = [];
        for (let f = 0; f < N; f++) {
          const u = f / (N - 1);
          const air = Math.sin(u * Math.PI);
          const spin = THREE.MathUtils.smoothstep(u, 0.08, 0.86) * Math.PI * 2;
          const fr = sampleRawPoseAt(backflipClip.frames, u < 0.2 ? u : 0.8 + (u - 0.2) * 0.25, false);
          applyWuxiaSwordGuardOverlay(fr, 0, 0.70);
          addLocalEuler(fr.quats[BONE_IDX.Hips], 0.14 * air, spin, 0);
          addLocalEuler(fr.quats[BONE_IDX.LeftUpLeg], -0.72 * air, 0, 0);
          addLocalEuler(fr.quats[BONE_IDX.LeftLeg], 1.10 * air, 0, 0);
          addLocalEuler(fr.quats[BONE_IDX.RightUpLeg], -0.45 * air, 0, 0);
          addLocalEuler(fr.quats[BONE_IDX.RightLeg], 0.85 * air, 0, 0);
          fr.rootPos.set(0, 0.90 + 0.68 * air, 0);
          djRaw.push(fr);
        }
        this._registerClip(
          normalizeCombatClip('10_double_jump', djRaw, 60, {
            cyclic: false,
            ballisticAir: true,
            provenance: 'derived_kinematic',
          }),
          ['10_wuxia_double_jump_二段轻功跳_cleaned']
        );
      }
    }

    // 7. `taibai_02` (无痕剑意 — single-leg knee raise parry stance -> riposte slash)
    if (canOverwrite('taibai_02')) {
      const N = 52;
      const raw = [];
      for (let f = 0; f < N; f++) {
        const u = f / (N - 1);
        let fr;
        if (u <= 0.42) {
          // Parry guard phase: independent knee raise + overhead cloud-sword ward
          const w = Math.sin((u / 0.42) * Math.PI * 0.65);
          fr = clonePoseFrame(idleClip.frames[0]);
          const wardRef = sampleRawPoseAt(swordClip.frames, 0.12, false);
          for (let b = BONE_IDX.Spine; b <= BONE_IDX.RightHand; b++) {
            fr.quats[b].slerp(wardRef.quats[b], 0.85 * w + 0.15);
          }
          addLocalEuler(fr.quats[BONE_IDX.RightUpLeg], -1.22 * w, -0.10 * w, 0);
          addLocalEuler(fr.quats[BONE_IDX.RightLeg], 1.42 * w, 0, 0);
          addLocalEuler(fr.quats[BONE_IDX.RightFoot], 0.35 * w, 0, 0);
          fr.rootPos.set(0, 0.92, 0);
        } else {
          // Counter-slash riposte phase [0.42..1.00]
          const su = (u - 0.42) / 0.58;
          fr = sampleRawPoseAt(swordClip.frames, 0.28 + su * 0.56, false);
          addLocalEuler(fr.quats[BONE_IDX.Chest], 0.20 * Math.sin(su * Math.PI), 0, 0);
          fr.rootPos.set(0, fr.rootPos.y, 0.35 * Math.sin(su * Math.PI * 0.5));
        }
        raw.push(fr);
      }
      this._registerClip(normalizeCombatClip('taibai_02', raw, 60, { cyclic: false, provenance: 'derived_kinematic' }), [
        'taibai_02_无痕剑意_独立提膝云剑_cleaned',
      ]);
    }

    // 8. `taibai_03` (雨落云飞 — 5-hit rapid sword flurry)
    if (canOverwrite('taibai_03')) {
      const N = 82;
      const raw = [];
      const phases = [
        [0.26, 0.54, -0.08],
        [0.54, 0.85, 0.12],
        [0.28, 0.54, -0.14],
        [0.54, 0.86, 0.16],
        [0.26, 0.84, -0.06],
      ];
      for (let f = 0; f < N; f++) {
        const u = f / (N - 1);
        const segFloat = Math.min(4.999, u * 5);
        const segIdx = Math.floor(segFloat);
        const localU = segFloat - segIdx;
        const [s0, s1, roll] = phases[segIdx];
        const fr = sampleRawPoseAt(swordClip.frames, s0 + (s1 - s0) * localU, false);
        const env = Math.sin(localU * Math.PI);
        addLocalEuler(fr.quats[BONE_IDX.Chest], 0.18 * env, 0, roll * env);
        fr.rootPos.set(0, fr.rootPos.y, u * 1.65);
        raw.push(fr);
      }
      this._registerClip(normalizeCombatClip('taibai_03', raw, 60, { cyclic: false, provenance: 'derived_kinematic' }), [
        'taibai_03_雨落云飞_快剑五连斩_cleaned',
      ]);
    }

    // 9. `taibai_04` (飞燕逐月 — 540° aerial whirlwind kick + greatsword vortex)
    if (canOverwrite('taibai_04')) {
      const N = 76;
      const raw = [];
      for (let f = 0; f < N; f++) {
        const u = f / (N - 1);
        const fr = sampleRawPoseAt(tornadoClip.frames, u, false);
        const slashRef = sampleRawPoseAt(swordClip.frames, (u * 2.2) % 1, false);
        for (let b = BONE_IDX.RightShoulder; b <= BONE_IDX.RightHand; b++) {
          fr.quats[b].slerp(slashRef.quats[b], 0.85);
        }
        if (u > 0.74) {
          const land = (u - 0.74) / 0.26;
          addLocalEuler(fr.quats[BONE_IDX.Hips], 0.18 * Math.sin(land * Math.PI), 0, 0);
        }
        fr.rootPos.set(0, fr.rootPos.y, u * 1.35);
        raw.push(fr);
      }
      this._registerClip(
        normalizeCombatClip('taibai_04', raw, 60, {
          cyclic: false,
          normalizeAerialRootY: true,
          provenance: 'derived_kinematic',
        }),
        ['taibai_04_飞燕逐月_腾空旋风跌叉_cleaned']
      );
    }

    // 10. `11_hit_light_L` & `12_hit_light_R` (Snappy left/right recoil stagger)
    for (const [hitId, sign] of [
      ['11_hit_light_L', 1],
      ['12_hit_light_R', -1],
    ]) {
      if (!canOverwrite(hitId)) continue;
      const N = 24;
      const raw = [];
      for (let f = 0; f < N; f++) {
        const u = f / (N - 1);
        // Fast 3-frame snap, damped exponential recovery
        const recoil = u < 0.14 ? u / 0.14 : Math.exp(-(u - 0.14) * 3.6);
        const fr = clonePoseFrame(idleClip.frames[0]);
        applyWuxiaSwordGuardOverlay(fr, 0, 0.55);
        addLocalEuler(fr.quats[BONE_IDX.Hips], -0.10 * recoil, 0.16 * sign * recoil, 0);
        addLocalEuler(fr.quats[BONE_IDX.Spine], -0.22 * recoil, 0.20 * sign * recoil, 0.14 * sign * recoil);
        addLocalEuler(fr.quats[BONE_IDX.Chest], -0.26 * recoil, 0.24 * sign * recoil, 0.16 * sign * recoil);
        addLocalEuler(fr.quats[BONE_IDX.Head], -0.20 * recoil, 0.18 * sign * recoil, 0);
        fr.rootPos.set(0, 0.91 - 0.04 * recoil, -0.65 * (1 - Math.pow(1 - u, 2.2)));
        raw.push(fr);
      }
      this._registerClip(normalizeCombatClip(hitId, raw, 60, { cyclic: false, provenance: 'derived_kinematic' }));
    }

    // 11. `13_knockdown`, `14_kipup`, `15_knockdown_kipup` (Supine launch fall & 鲤鱼打挺 kip-up)
    const kdRaw = [];
    for (let f = 0; f < 57; f++) {
      const u = f / 56;
      const fr = clonePoseFrame(idleClip.frames[0]);
      const pitchBack = -1.46 * THREE.MathUtils.smoothstep(u, 0.0, 0.52);
      const yArc =
        u < 0.52
          ? 0.92 + Math.sin((u / 0.52) * Math.PI) * 0.28 - (u / 0.52) * 0.72
          : 0.20 + Math.exp(-(u - 0.52) * 12) * 0.04 * Math.abs(Math.sin((u - 0.52) * 22));
      addLocalEuler(fr.quats[BONE_IDX.Hips], pitchBack, 0, 0);
      addLocalEuler(fr.quats[BONE_IDX.Spine], 0.22 * (1 - u * 0.5), 0, 0);
      const legKick = Math.sin(Math.min(1, u * 1.6) * Math.PI) * 0.55;
      addLocalEuler(fr.quats[BONE_IDX.LeftUpLeg], -0.45 * legKick, 0, 0.12);
      addLocalEuler(fr.quats[BONE_IDX.RightUpLeg], -0.35 * legKick, 0, -0.12);
      fr.rootPos.set(0, Math.max(0.18, yArc), -2.10 * (1 - Math.pow(1 - Math.min(1, u / 0.65), 2.0)));
      kdRaw.push(fr);
    }

    const kipRaw = [];
    for (let f = 0; f < 30; f++) {
      const u = f / 29;
      const fr = clonePoseFrame(idleClip.frames[0]);
      applyWuxiaSwordGuardOverlay(fr, 0, THREE.MathUtils.smoothstep(u, 0.45, 1.0) * 0.8);
      // Chamber legs to chest [0..0.3], explosive hip-bridge whip [0.3..0.75], plant boots [0.75..1.0]
      const pitchBack = -1.46 * (1 - THREE.MathUtils.smoothstep(u, 0.22, 0.78));
      const bridgeArch = Math.sin(THREE.MathUtils.clamp((u - 0.18) / 0.62, 0, 1) * Math.PI);
      const chamber = Math.sin(THREE.MathUtils.clamp(u / 0.45, 0, 1) * Math.PI);
      addLocalEuler(fr.quats[BONE_IDX.Hips], pitchBack, 0, 0);
      addLocalEuler(fr.quats[BONE_IDX.Spine], -0.42 * bridgeArch, 0, 0);
      addLocalEuler(fr.quats[BONE_IDX.Chest], -0.32 * bridgeArch, 0, 0);
      addLocalEuler(fr.quats[BONE_IDX.LeftUpLeg], -1.25 * chamber, 0, 0);
      addLocalEuler(fr.quats[BONE_IDX.LeftLeg], 1.10 * chamber, 0, 0);
      addLocalEuler(fr.quats[BONE_IDX.RightUpLeg], -1.25 * chamber, 0, 0);
      addLocalEuler(fr.quats[BONE_IDX.RightLeg], 1.10 * chamber, 0, 0);
      const yKip = 0.20 + THREE.MathUtils.smoothstep(u, 0.22, 0.72) * 0.72 + bridgeArch * 0.14;
      fr.rootPos.set(0, u > 0.82 ? THREE.MathUtils.lerp(yKip, 0.92, (u - 0.82) / 0.18) : yKip, 0);
      kipRaw.push(fr);
    }

    if (canOverwrite('13_knockdown')) {
      this._registerClip(normalizeCombatClip('13_knockdown', kdRaw, 60, { cyclic: false, provenance: 'derived_kinematic' }), [
        '13_wuxia_knockdown_击飞倒地_cleaned',
      ]);
    }
    if (canOverwrite('14_kipup')) {
      this._registerClip(normalizeCombatClip('14_kipup', kipRaw, 60, { cyclic: false, provenance: 'derived_kinematic' }), [
        '14_wuxia_kipup_鲤鱼打挺起身_cleaned',
      ]);
    }
    if (canOverwrite('15_knockdown_kipup')) {
      const combined = kdRaw.map(clonePoseFrame).concat(kipRaw.map((fr) => {
        const c = clonePoseFrame(fr);
        c.rootPos.z = kdRaw[kdRaw.length - 1].rootPos.z;
        return c;
      }));
      this._registerClip(
        normalizeCombatClip('15_knockdown_kipup', combined, 60, { cyclic: false, provenance: 'derived_kinematic' }),
        ['15_wuxia_knockdown_kipup_击飞倒地接鲤鱼打挺_cleaned']
      );
    }
  }

  /**
   * 4-Tier Async Loader:
   * Tier 1: Node FS (`/home/antigravity/bvh_library`) via dynamic `node:fs/promises`
   * Tier 2: Browser HTTP `/bvh_library/...` (with HTML SPA fallback rejection guard!)
   * Tier 3: Browser `/mocap/*.bvh` foundational mocap pool
   * Tier 4: Deterministic kinematic derivations for any pending M2 clip
   */
  async loadAll(options = {}) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const bvhLibraryDir = safeOptions.bvhLibraryDir || '/home/antigravity/bvh_library';
    const baseUrl = (safeOptions.baseUrl || '/bvh_library').replace(/\/+$/, '');
    const hasExplicitFetch = typeof safeOptions.fetchImpl === 'function';
    const hasExplicitFs =
      typeof safeOptions.readTextFile === 'function' || Boolean(safeOptions.bvhLibraryDir);
    const customReadText =
      typeof safeOptions.readTextFile === 'function' ? safeOptions.readTextFile : null;
    const customFetch = hasExplicitFetch
      ? safeOptions.fetchImpl
      : globalThis.fetch?.bind(globalThis);

    const isNodeRuntime =
      typeof window === 'undefined' && Boolean(globalThis.process?.versions?.node);

    // Tier 1: Node filesystem or injected `readTextFile` (skipped when caller explicitly injects `fetchImpl` without `fs` options)
    if (hasExplicitFs || (isNodeRuntime && !hasExplicitFetch)) {
      let readFn = customReadText;
      let readdirFn = null;
      if (!readFn && isNodeRuntime) {
        try {
          const fsSpec = 'node:fs/promises';
          const fsp = await import(/* @vite-ignore */ fsSpec);
          readFn = (p) => fsp.readFile(p, 'utf8');
          readdirFn = (p) => fsp.readdir(p);
        } catch {
          readFn = null;
        }
      }

      if (readFn) {
        // Discover directory filenames if readdir available (handles slight Chinese suffix variations cleanly)
        const dirFiles = new Map();
        if (readdirFn) {
          for (const sub of ['B_cleaned_ready', 'C_taibai_extracted']) {
            try {
              const names = await readdirFn(`${bvhLibraryDir}/${sub}`);
              dirFiles.set(sub, names.filter((n) => n.endsWith('.bvh')));
            } catch {
              dirFiles.set(sub, []);
            }
          }
        }

        await Promise.all(
          CANONICAL_CLIP_SPECS.map(async (spec) => {
            let targetRel = spec.relPath;
            const [subDir] = spec.relPath.split('/');
            const candidates = dirFiles.get(subDir);
            if (candidates && candidates.length > 0) {
              const exactOrPrefix = candidates.find(
                (f) => `${subDir}/${f}` === spec.relPath || f.startsWith(spec.prefix)
              );
              if (exactOrPrefix) targetRel = `${subDir}/${exactOrPrefix}`;
            }
            try {
              const txt = await readFn(`${bvhLibraryDir}/${targetRel}`);
              if (isValidBVHText(txt)) {
                const parsed = parseBVHToRawFrames(txt, 60);
                const clip = normalizeCombatClip(spec.id, parsed.frames, parsed.fps, {
                  cyclic: spec.cyclic,
                  ballisticAir: spec.ballisticAir,
                  normalizeAerialRootY: spec.normalizeAerialRootY,
                  provenance: 'bvh_library',
                });
                const stem = targetRel.split('/').pop().replace(/\.bvh$/i, '');
                this._registerClip(clip, [stem]);
              }
            } catch {
              // File not yet produced by M2; Tier 4 derivation remains active
            }
          })
        );
      }
    }

    // Tier 2 & Tier 3: Browser HTTP fetch (or explicit `fetchImpl` injection) with strict `Accept: text/plain` & `isValidBVHText` guard
    if (hasExplicitFetch || (!isNodeRuntime && Boolean(customFetch))) {
      const fetchOneSpec = async (spec, rel) => {
        if (this.clips.get(spec.id)?.provenance === 'bvh_library') return true;
        try {
          const url = `${baseUrl}/${rel.split('/').map(encodeURIComponent).join('/')}`;
          const res = await customFetch(url, { headers: { Accept: 'text/plain' } });
          if (!res.ok) return false;
          const txt = await res.text();
          if (!isValidBVHText(txt)) return false;
          const parsed = parseBVHToRawFrames(txt, 60);
          const clip = normalizeCombatClip(spec.id, parsed.frames, parsed.fps, {
            cyclic: spec.cyclic,
            ballisticAir: spec.ballisticAir,
            normalizeAerialRootY: spec.normalizeAerialRootY,
            provenance: 'bvh_library',
          });
          const stem = rel.split('/').pop().replace(/\.bvh$/i, '');
          this._registerClip(clip, [stem]);
          return true;
        } catch {
          return false;
        }
      };

      // Fast path: probe all 26 canonical `/bvh_library/...` files immediately in parallel
      await Promise.all(CANONICAL_CLIP_SPECS.map((spec) => fetchOneSpec(spec, spec.relPath)));

      // Fallback: only consult MANIFEST.json if any canonical spec used an alternate filename
      const missingSpecs = CANONICAL_CLIP_SPECS.filter(
        (spec) => this.clips.get(spec.id)?.provenance !== 'bvh_library'
      );
      if (missingSpecs.length > 0) {
        try {
          const mRes = await customFetch(`${baseUrl}/MANIFEST.json`, {
            headers: { Accept: 'application/json' },
          });
          if (mRes.ok) {
            const mTxt = (await mRes.text()).trim();
            if (mTxt.startsWith('{') || mTxt.startsWith('[')) {
              const parsedManifest = JSON.parse(mTxt);
              const entries = Array.isArray(parsedManifest)
                ? parsedManifest
                : Array.isArray(parsedManifest.clips)
                  ? parsedManifest.clips
                  : Array.isArray(parsedManifest.assets)
                    ? parsedManifest.assets
                    : [];
              const manifestPaths = new Map();
              for (const entry of entries) {
                const p = String(entry.path || entry.relPath || '').replace(/^\/?bvh_library\//, '');
                if (p.endsWith('.bvh')) {
                  const fileBase = p.split('/').pop();
                  for (const spec of missingSpecs) {
                    if (entry.id === spec.id || fileBase.startsWith(spec.prefix)) {
                      manifestPaths.set(spec.id, p);
                    }
                  }
                }
              }
              await Promise.all(
                missingSpecs
                  .filter((spec) => manifestPaths.has(spec.id))
                  .map((spec) => fetchOneSpec(spec, manifestPaths.get(spec.id)))
              );
            }
          }
        } catch {
          // Ignore offline/missing manifest
        }
      }

      // Tier 3: Foundational `/mocap/*.bvh` fallback for `01_idle` and `05_front_kick` if `/bvh_library` isn't mounted yet
      const mocapFallbacks = [
        { id: '01_idle', url: '/mocap/avatar_stand_1.bvh', cyclic: true },
        { id: '05_front_kick', url: '/mocap/avatar_kick_roundhouse_R.bvh', cyclic: false },
      ];
      await Promise.all(
        mocapFallbacks.map(async (fb) => {
          if (this.clips.get(fb.id)?.provenance === 'bvh_library') return;
          try {
            const res = await customFetch(fb.url, { headers: { Accept: 'text/plain' } });
            if (!res.ok) return;
            const txt = await res.text();
            if (!isValidBVHText(txt)) return;
            const parsed = parseBVHToRawFrames(txt, 60);
            const clip = normalizeCombatClip(fb.id, parsed.frames, parsed.fps, {
              cyclic: fb.cyclic,
              provenance: 'public_mocap',
            });
            this._registerClip(clip);
          } catch {
            // Keep baseline clip
          }
        })
      );
    }

    // Tier 4: Populate fallback mocap/derived clips only if any of the 26 canonical clips was unavailable
    if (this.clips.size < CANONICAL_CLIP_SPECS.length) {
      this.populateBaselineSync();
    } else {
      this._rebuildDerivedClips(true);
    }
    return this;
  }

  getClip(idOrAlias) {
    if (this.clips.size === 0) this.populateBaselineSync();
    if (!idOrAlias) return this.clips.get('taibai_01b') || this.clips.get('01_idle');
    if (this.clips.has(idOrAlias)) return this.clips.get(idOrAlias);
    const mapped = this.aliasMap.get(String(idOrAlias).toLowerCase());
    if (mapped && this.clips.has(mapped)) return this.clips.get(mapped);
    return this.clips.get('taibai_01b') || this.clips.get('01_idle');
  }

  hasClip(idOrAlias) {
    if (this.clips.size === 0) this.populateBaselineSync();
    if (!idOrAlias) return false;
    return this.clips.has(idOrAlias) || this.aliasMap.has(String(idOrAlias).toLowerCase());
  }

  getLoadedClipIds() {
    if (this.clips.size === 0) this.populateBaselineSync();
    return Array.from(this.clips.keys()).sort();
  }

  sampleClipRootDelta(clipId, uPrev, uCurr) {
    const clip = this.getClip(clipId);
    return sampleClipRootDeltaXZ(clip, uPrev, uCurr);
  }
}

function sampleRawPoseFrameWithTuck(baseFrame, tuck, rollAngle) {
  const fr = clonePoseFrame(baseFrame);
  addLocalEuler(fr.quats[BONE_IDX.Hips], rollAngle, 0, 0);
  addLocalEuler(fr.quats[BONE_IDX.Spine], 0.52 * tuck, 0, 0);
  addLocalEuler(fr.quats[BONE_IDX.Chest], 0.48 * tuck, 0, 0);
  addLocalEuler(fr.quats[BONE_IDX.Neck], 0.35 * tuck, 0, 0);
  addLocalEuler(fr.quats[BONE_IDX.LeftUpLeg], -1.35 * tuck, 0, 0);
  addLocalEuler(fr.quats[BONE_IDX.LeftLeg], 1.65 * tuck, 0, 0);
  addLocalEuler(fr.quats[BONE_IDX.RightUpLeg], -1.35 * tuck, 0, 0);
  addLocalEuler(fr.quats[BONE_IDX.RightLeg], 1.65 * tuck, 0, 0);
  addLocalEuler(fr.quats[BONE_IDX.LeftUpperArm], 0.85 * tuck, 0.45 * tuck, 0.85);
  addLocalEuler(fr.quats[BONE_IDX.LeftForeArm], 1.10 * tuck, 0, 0);
  addLocalEuler(fr.quats[BONE_IDX.RightUpperArm], 0.85 * tuck, -0.45 * tuck, -0.85);
  addLocalEuler(fr.quats[BONE_IDX.RightForeArm], 1.10 * tuck, 0, 0);
  return fr;
}

export function createCombatClipRegistry() {
  return new CombatClipRegistry();
}
