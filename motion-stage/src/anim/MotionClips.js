import * as THREE from 'three';
import { BONE_DEFS, BONE_IDX, createBoneHierarchy } from '../rig/HumanoidRig.js';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import {
  MOCAP_RUN_BVH,
  MOCAP_SWORD_STRIKE_BVH,
  MOCAP_KICK_BVH,
  MOCAP_BACKFLIP_BVH,
} from './mocap/bvhBundle.js';

const NUM_BONES = BONE_DEFS.length;

function emptyFrame() {
  return {
    rootPos: new THREE.Vector3(0, 0.94, 0),
    quats: Array.from({ length: NUM_BONES }, () => new THREE.Quaternion()),
    contactL: null,
    contactR: null,
  };
}

function addJitterQuat(quat, seed, amp, frameIdx) {
  const n1 = Math.sin(frameIdx * 1.93 + seed * 3.1) * 0.55 + Math.cos(frameIdx * 2.87 + seed * 1.7) * 0.45;
  const n2 = Math.sin(frameIdx * 2.41 + seed * 5.3) * 0.5 + Math.cos(frameIdx * 3.31 + seed * 2.9) * 0.5;
  const n3 = Math.cos(frameIdx * 2.17 + seed * 4.2) * 0.6;
  const dq = new THREE.Quaternion().setFromEuler(new THREE.Euler(n1 * amp, n2 * amp, n3 * amp));
  quat.multiply(dq).normalize();
}

function addEulerOffsetQuat(quat, rx, ry, rz) {
  const dq = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  quat.multiply(dq).normalize();
}

export function normalizeBVHBoneName(rawName = '') {
  return String(rawName)
    .replace(/^.*:/, '')
    .trim()
    .replace(/^(DEF-|ORG-)/i, '')
    .replace(/\.(l|r)$/i, (_, side) => `_${side.toLowerCase()}`);
}

// Complete 21-bone mapping table matching EXPORT_BONE_INDICES across MotionStage, CMU, UE5, Unity, Mixamo & Rigify
export const BVH_TARGET_CANDIDATES = [
  [BONE_IDX.Hips, [/^(hip|hips|pelvis)$/i, /^root$/i]],
  [BONE_IDX.Spine, [/^(abdomen|spine|spine_01|spine01)$/i, /^lowerback$/i]],
  [
    BONE_IDX.Chest,
    [
      /^(chest|upperchest|upper_chest|spine2|spine_03|spine03|spine_04|spine04|upperback|thorax)$/i,
      /^(spine1|spine_02|spine02)$/i,
    ],
  ],
  [BONE_IDX.Neck, [/^(neck1|neck_01|neck01)$/i, /^neck$/i]],
  [BONE_IDX.Head, [/^(head|head_01|head01)$/i]],
  [
    BONE_IDX.LeftShoulder,
    [/^(lcollar|leftshoulder|left_shoulder|l_shoulder|shoulder_l|l_clavicle|clavicle_l|leftclavicle|left_clavicle)$/i],
  ],
  [
    BONE_IDX.LeftUpperArm,
    [/^(lshldr|leftarm|left_arm|leftupperarm|left_upper_?arm|l_upper_?arm|upper_?arm_l|arm_l|l_arm)$/i],
  ],
  [
    BONE_IDX.LeftForeArm,
    [/^(lforearm|leftforearm|left_forearm|leftlowerarm|left_lower_?arm|l_forearm|forearm_l|l_lower_?arm|lower_?arm_l)$/i],
  ],
  [
    BONE_IDX.LeftHand,
    [/^(lhand|lefthand|left_hand|l_hand|hand_l|lwrist|leftwrist|wrist_l|l_wrist)$/i],
  ],
  [
    BONE_IDX.RightShoulder,
    [/^(rcollar|rightshoulder|right_shoulder|r_shoulder|shoulder_r|r_clavicle|clavicle_r|rightclavicle|right_clavicle)$/i],
  ],
  [
    BONE_IDX.RightUpperArm,
    [/^(rshldr|rightarm|right_arm|rightupperarm|right_upper_?arm|r_upper_?arm|upper_?arm_r|arm_r|r_arm)$/i],
  ],
  [
    BONE_IDX.RightForeArm,
    [/^(rforearm|rightforearm|right_forearm|rightlowerarm|right_lower_?arm|r_forearm|forearm_r|r_lower_?arm|lower_?arm_r)$/i],
  ],
  [
    BONE_IDX.RightHand,
    [/^(rhand|righthand|right_hand|r_hand|hand_r|rwrist|rightwrist|wrist_r|r_wrist)$/i],
  ],
  [
    BONE_IDX.LeftUpLeg,
    [/^(lthigh|leftupleg|left_up_?leg|leftupperleg|left_upper_?leg|upper_?leg_l|l_upper_?leg|leftthigh|left_thigh|l_thigh|thigh_l|l_upleg|upleg_l)$/i],
  ],
  [
    BONE_IDX.LeftLeg,
    [/^(lshin|leftleg|left_leg|leftlowerleg|left_lower_?leg|lower_?leg_l|l_lower_?leg|leftcalf|left_calf|leftshin|left_shin|l_calf|calf_l|l_leg|leg_l|shin_l|l_shin)$/i],
  ],
  [
    BONE_IDX.LeftFoot,
    [/^(lfoot|leftfoot|left_foot|l_foot|foot_l|lankle|leftankle|ankle_l|l_ankle)$/i],
  ],
  [
    BONE_IDX.LeftToe,
    [/^(ltoe|lefttoe|left_toe|lefttoebase|left_toe_?base|lefttoes|l_toe|toe_l|l_ball|ball_l|toebase_l|l_toebase)$/i],
  ],
  [
    BONE_IDX.RightUpLeg,
    [/^(rthigh|rightupleg|right_up_?leg|rightupperleg|right_upper_?leg|upper_?leg_r|r_upper_?leg|rightthigh|right_thigh|r_thigh|thigh_r|r_upleg|upleg_r)$/i],
  ],
  [
    BONE_IDX.RightLeg,
    [/^(rshin|rightleg|right_leg|rightlowerleg|right_lower_?leg|lower_?leg_r|r_lower_?leg|rightcalf|right_calf|rightshin|right_shin|r_calf|calf_r|r_leg|leg_r|shin_r|r_shin)$/i],
  ],
  [
    BONE_IDX.RightFoot,
    [/^(rfoot|rightfoot|right_foot|r_foot|foot_r|rankle|rightankle|ankle_r|r_ankle)$/i],
  ],
  [
    BONE_IDX.RightToe,
    [/^(rtoe|righttoe|right_toe|righttoebase|right_toe_?base|righttoes|r_toe|toe_r|r_ball|ball_r|toebase_r|r_toebase)$/i],
  ],
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
 * Retargets any BVH text (MotionStage cm, CMU, OpenMocap inches, Mixamo, UE5, Unity, Rigify, or meters)
 * onto our 29-bone HumanoidRig using World-Space Quaternion Retargeting + Rest-Pose Limb Alignment +
 * Universal Leg-Scale Calibration.
 *
 * Returns `frames` (`Frame[]`) decorated with non-enumerable `{ frames, totalFrames, fps }` properties
 * so both array callers (`Frame[]`) and object-destructuring callers (`{ frames, totalFrames, fps }`) work seamlessly.
 */
export function retargetBVHToFrames(
  bvhText,
  targetFps = 60,
  options = { preserveRootMotion: false, rootOriginMode: 'start', maxFrames: Infinity }
) {
  const safeFps = Number.isFinite(Number(targetFps)) && Number(targetFps) > 0 ? Number(targetFps) : 60;
  const opts = options && typeof options === 'object' ? options : {};
  const preserveRootMotion = Boolean(opts.preserveRootMotion);
  const rootOriginMode = opts.rootOriginMode || 'start';
  const maxFrames = opts.maxFrames !== undefined && opts.maxFrames !== null ? Number(opts.maxFrames) : Infinity;
  const groundAlign = opts.groundAlign !== undefined ? Boolean(opts.groundAlign) : true;

  const loader = new BVHLoader();
  const { clip, skeleton } = loader.parse(bvhText);

  const srcTimes = clip.tracks[0]?.times;
  const srcNumFrames = srcTimes ? srcTimes.length : 0;
  const maxCap = Number.isFinite(maxFrames) && maxFrames > 0 ? Math.floor(maxFrames) : Infinity;

  let totalFrames;
  if (clip.duration <= 0 || srcNumFrames <= 1) {
    totalFrames = 1;
  } else {
    const rawCount = Math.round(clip.duration * safeFps) + 1;
    totalFrames = Math.min(maxCap, Math.max(2, rawCount));
  }

  const rootRawName = skeleton.bones[0]?.name || '';
  const cleanBones = skeleton.bones.map((b) => ({
    bone: b,
    rawName: b.name,
    cleanName: normalizeBVHBoneName(b.name),
  }));

  // Sanitize THREE.PropertyBinding delimiters (:, /, [, ], ., whitespace) consistently
  // on both skeleton bone names and AnimationClip track prefixes so Mixamo/MotionBuilder/Rigify bind 1:1.
  const usedSanitizedNames = new Set();
  const rawNameToTrackTargets = new Map();
  const sanitizeTrackNodeName = (raw) => {
    let base = String(raw || 'bone')
      .replace(/[:/\[\]\s.]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!base) base = 'bone';
    let candidate = base;
    let suffix = 1;
    while (usedSanitizedNames.has(candidate)) {
      candidate = `${base}_${suffix++}`;
    }
    usedSanitizedNames.add(candidate);
    return candidate;
  };

  for (const entry of cleanBones) {
    const sanitized = sanitizeTrackNodeName(entry.rawName);
    entry.bone.name = sanitized;
    if (entry.rawName !== 'ENDSITE') {
      let bucket = rawNameToTrackTargets.get(entry.rawName);
      if (!bucket) {
        bucket = [];
        rawNameToTrackTargets.set(entry.rawName, bucket);
      }
      bucket.push({ sanitizedName: sanitized, consumedProps: new Set() });
    }
  }

  for (const track of clip.tracks) {
    const lastDot = track.name.lastIndexOf('.');
    if (lastDot < 0) continue;
    const rawNodeName = track.name.slice(0, lastDot);
    const propSuffix = track.name.slice(lastDot);
    const bucket = rawNameToTrackTargets.get(rawNodeName);
    const target = bucket?.find((item) => !item.consumedProps.has(propSuffix));
    if (target) {
      target.consumedProps.add(propSuffix);
      track.name = `${target.sanitizedName}${propSuffix}`;
    } else {
      const fallbackNode =
        rawNodeName.replace(/[:/\[\]\s.]+/g, '_').replace(/^_+|_+$/g, '') || 'bone';
      track.name = `${fallbackNode}${propSuffix}`;
    }
  }

  const srcByDst = new Array(NUM_BONES).fill(null);
  const usedBones = new Set();
  for (const [dstIdx, regexList] of BVH_TARGET_CANDIDATES) {
    for (const regex of regexList) {
      const match = cleanBones.find((entry) => !usedBones.has(entry.bone) && regex.test(entry.cleanName));
      if (match) {
        srcByDst[dstIdx] = match.bone;
        usedBones.add(match.bone);
        break;
      }
    }
  }

  // 1. Capture BVH HIERARCHY rest-pose world joint positions BEFORE AnimationMixer poses frame 0!
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

  // Compute rest-pose limb alignment quaternions (eliminates 20-deg splay / scissor-legs on CMU BVH)
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

  // Compute universal anatomical scale from rest-pose leg length (UpLeg -> Leg -> Foot = 0.82m)
  let srcLegLen = 0;
  if (srcByDst[BONE_IDX.LeftUpLeg] && srcByDst[BONE_IDX.LeftLeg] && srcByDst[BONE_IDX.LeftFoot]) {
    srcByDst[BONE_IDX.LeftUpLeg].getWorldPosition(pParentSrc);
    srcByDst[BONE_IDX.LeftLeg].getWorldPosition(pChildSrc);
    srcLegLen += pParentSrc.distanceTo(pChildSrc);
    srcByDst[BONE_IDX.LeftFoot].getWorldPosition(pParentSrc);
    srcLegLen += pChildSrc.distanceTo(pParentSrc);
  } else if (srcByDst[BONE_IDX.RightUpLeg] && srcByDst[BONE_IDX.RightLeg] && srcByDst[BONE_IDX.RightFoot]) {
    srcByDst[BONE_IDX.RightUpLeg].getWorldPosition(pParentSrc);
    srcByDst[BONE_IDX.RightLeg].getWorldPosition(pChildSrc);
    srcLegLen += pParentSrc.distanceTo(pChildSrc);
    srcByDst[BONE_IDX.RightFoot].getWorldPosition(pParentSrc);
    srcLegLen += pChildSrc.distanceTo(pParentSrc);
  }

  const srcHips = srcByDst[BONE_IDX.Hips] || bvhRoot;

  const mixer = new THREE.AnimationMixer(bvhRoot);
  const action = mixer.clipAction(clip);
  action.loop = THREE.LoopOnce;
  action.clampWhenFinished = true;
  action.play();

  mixer.setTime(0);
  bvhRoot.updateWorldMatrix(true, true);
  const tmpSrcHips = new THREE.Vector3();
  srcHips.getWorldPosition(tmpSrcHips);
  let peakAbsHipY = Math.abs(tmpSrcHips.y);

  if (srcLegLen <= 1e-4) {
    for (const track of clip.tracks) {
      if (track.name.endsWith('.position') && track.values?.length >= 3) {
        for (let i = 1; i < track.values.length; i += 3) {
          peakAbsHipY = Math.max(peakAbsHipY, Math.abs(track.values[i]));
        }
      }
    }
  }

  let posScale = 1.0;
  if (srcLegLen > 1e-4) {
    posScale = 0.82 / srcLegLen;
  } else if (peakAbsHipY > 60) {
    posScale = 0.01;
  } else if (peakAbsHipY > 12) {
    posScale = 0.94 / peakAbsHipY;
  }

  const qWorldSrc = new THREE.Quaternion();
  const qWorldParent = new THREE.Quaternion();
  const tmpFootL = new THREE.Vector3();
  const tmpFootR = new THREE.Vector3();

  const frames = [];
  let minAnkleY = Infinity;

  for (let f = 0; f < totalFrames; f++) {
    const t = totalFrames > 1 && clip.duration > 0 ? (f / (totalFrames - 1)) * clip.duration : 0;
    mixer.setTime(t);
    bvhRoot.updateWorldMatrix(true, true);

    srcHips.getWorldPosition(tmpSrcHips);
    const frame = emptyFrame();
    frame.rootPos.set(
      tmpSrcHips.x * posScale,
      tmpSrcHips.y * posScale,
      tmpSrcHips.z * posScale
    );
    dstBones[0].position.copy(frame.rootPos);

    for (let b = 0; b < NUM_BONES; b++) {
      const srcBone = srcByDst[b];
      if (srcBone) {
        srcBone.getWorldQuaternion(qWorldSrc);
        if (qAlign[b]) {
          qWorldSrc.multiply(qAlign[b]);
        }
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

  const isCanonicalRig = Math.abs(srcLegLen - 82) < 0.5 && /^hips$/i.test(rootRawName.trim());
  let yShift = Number.isFinite(minAnkleY) ? 0.08 - minAnkleY : 0;
  if (!groundAlign || rootOriginMode === 'raw') {
    yShift = 0;
  } else if (isCanonicalRig && minAnkleY > 0.12) {
    // Preserve airborne height on canonical calibrated BVHs (e.g., 10_wuxia_double_jump)
    yShift = 0;
  }

  let refX = 0;
  let refZ = 0;
  if (preserveRootMotion) {
    if (rootOriginMode === 'raw' || frames.length === 0) {
      refX = 0;
      refZ = 0;
    } else {
      refX = frames[0].rootPos.x;
      refZ = frames[0].rootPos.z;
    }
  } else if (frames.length > 0) {
    refX = frames.reduce((s, fr) => s + fr.rootPos.x, 0) / frames.length;
    refZ = frames.reduce((s, fr) => s + fr.rootPos.z, 0) / frames.length;
  }

  for (const fr of frames) {
    fr.rootPos.x -= refX;
    fr.rootPos.z -= refZ;
    fr.rootPos.y += yShift;
  }

  Object.defineProperties(frames, {
    frames: { value: frames, enumerable: false, configurable: true },
    totalFrames: { value: frames.length, enumerable: false, configurable: true },
    fps: { value: safeFps, enumerable: false, configurable: true },
  });

  return frames;
}

/**
 * Helper: measures clean retargeted world ankle positions, speeds, and upright hip status
 * BEFORE layering simulated raw AI video/diffusion defects onto the clip.
 */
function measureCleanFootContacts(frames, fps, heightThresh = 0.138, speedThresh = 0.90) {
  const N = frames.length;
  const { bones } = createBoneHierarchy();
  const ankleL = [];
  const ankleR = [];
  const upright = [];
  const tmp = new THREE.Vector3();
  const qHips = new THREE.Quaternion();

  for (let f = 0; f < N; f++) {
    bones[0].position.copy(frames[f].rootPos);
    for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(frames[f].quats[b]);
    bones[0].updateWorldMatrix(true, true);

    bones[BONE_IDX.LeftFoot].getWorldPosition(tmp);
    ankleL.push(tmp.clone());
    bones[BONE_IDX.RightFoot].getWorldPosition(tmp);
    ankleR.push(tmp.clone());

    bones[BONE_IDX.Hips].getWorldQuaternion(qHips);
    tmp.set(0, 1, 0).applyQuaternion(qHips);
    upright.push(tmp.y > 0.45);
  }

  for (let f = 0; f < N; f++) {
    const prev = (f - 1 + N) % N;
    const spdL = ankleL[f].distanceTo(ankleL[prev]) * fps;
    const spdR = ankleR[f].distanceTo(ankleR[prev]) * fps;
    frames[f].contactL = upright[f] && ankleL[f].y < heightThresh && spdL < speedThresh;
    frames[f].contactR = upright[f] && ankleR[f].y < heightThresh && spdR < speedThresh;
  }
}

/**
 * Preset 1: 剑术连斩 (`avatar_sword_strike_R.bvh`)
 * Complex two-hit sword combo with torso coil + simulated raw AI foot-skating, depth tremor & wrist jitter.
 */
export function buildSlashClip() {
  const { frames, totalFrames, fps } = retargetBVHToFrames(MOCAP_SWORD_STRIKE_BVH, 60);
  const qClearance = new THREE.Quaternion();

  for (let f = 0; f < totalFrames; f++) {
    const u = f / totalFrames;
    const phase = u * Math.PI * 2;
    const fr = frames[f];

    // Subtle outward-forward chest clearance during cross-body follow-through so arm clears cuirass & left arm
    if (u > 0.38 && u < 0.78) {
      const w = Math.sin(((u - 0.38) / 0.40) * Math.PI);
      const qChestClear = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.16 * w, -0.22 * w, -0.12 * w));
      const qShInv = fr.quats[BONE_IDX.RightShoulder].clone().invert();
      qClearance.copy(qShInv).multiply(qChestClear).multiply(fr.quats[BONE_IDX.RightShoulder]);
      fr.quats[BONE_IDX.RightUpperArm].premultiply(qClearance);
    }

    // Both boots stay planted in martial fencing stance throughout the strike
    fr.contactL = true;
    fr.contactR = true;

    // Monocular depth/root tremor + loop seam drift
    fr.rootPos.x += 0.032 * Math.sin(f * 1.65) + (u > 0.78 ? ((u - 0.78) / 0.22) * 0.08 : 0);
    fr.rootPos.z += 0.042 * Math.cos(f * 1.45) + (u > 0.78 ? ((u - 0.78) / 0.22) * 0.10 : 0);
    fr.rootPos.y += 0.018 * Math.sin(f * 1.9);

    // Simulated AI leg-skating drift (~14cm foot slide on floor before Two-Bone IK lock!)
    addEulerOffsetQuat(fr.quats[BONE_IDX.LeftUpLeg], 0.15 * Math.sin(phase * 2), 0, 0.10 * Math.cos(phase));
    addEulerOffsetQuat(fr.quats[BONE_IDX.RightUpLeg], -0.15 * Math.cos(phase * 2), 0, -0.10 * Math.sin(phase));

    addJitterQuat(fr.quats[BONE_IDX.RightHand], 11, 0.09, f);
    addJitterQuat(fr.quats[BONE_IDX.RightForeArm], 12, 0.06, f);
    addJitterQuat(fr.quats[BONE_IDX.LeftFoot], 13, 0.07, f);
    addJitterQuat(fr.quats[BONE_IDX.RightFoot], 14, 0.07, f);
    addJitterQuat(fr.quats[BONE_IDX.Head], 15, 0.042, f);
  }

  return {
    id: 'slash',
    name: '剑术连斩',
    fps,
    totalFrames,
    duration: totalFrames / fps,
    syntheticSpeed: 0.75,
    isCombatAttack: true,
    hasWeapon: true,
    nonCyclic: false,
    preserveRootMotion: false,
    stabilizeInPlace: false,
    frames,
  };
}

/**
 * Preset 2: 回旋踢 (`cmu_87_01_tornado_kick.bvh`)
 * True 360-degree Tornado Spinning Roundhouse Kick: grounded takeoff/landing stances lock via IK while
 * the character spins a full 360 degrees in mid-air and whips a horizontal head-high roundhouse arc!
 */
export function buildKickClip() {
  const { frames, totalFrames, fps } = retargetBVHToFrames(MOCAP_KICK_BVH, 60);
  measureCleanFootContacts(frames, fps, 0.145, 1.05);

  for (let f = 0; f < totalFrames; f++) {
    const u = f / totalFrames;
    const phase = u * Math.PI * 2;
    const fr = frames[f];

    // Monocular depth wobble + loop seam pop
    fr.rootPos.x += 0.030 * Math.cos(f * 1.75) + (u > 0.80 ? ((u - 0.80) / 0.20) * 0.07 : 0);
    fr.rootPos.z += 0.040 * Math.sin(f * 1.52) + (u > 0.80 ? ((u - 0.80) / 0.20) * 0.09 : 0);
    fr.rootPos.y += 0.016 * Math.cos(f * 2.05);

    // Grounded takeoff/landing foot slide in raw AI before Two-Bone IK lock
    if (fr.contactL) {
      addEulerOffsetQuat(fr.quats[BONE_IDX.LeftUpLeg], 0.14 * Math.sin(phase * 2), 0, 0.09 * Math.cos(phase * 2));
    }
    if (fr.contactR) {
      addEulerOffsetQuat(fr.quats[BONE_IDX.RightUpLeg], -0.12 * Math.cos(phase * 2), 0, -0.08 * Math.sin(phase * 2));
    }

    addJitterQuat(fr.quats[BONE_IDX.RightFoot], 31, 0.085, f);
    addJitterQuat(fr.quats[BONE_IDX.LeftFoot], 32, 0.075, f);
    addJitterQuat(fr.quats[BONE_IDX.RightHand], 33, 0.075, f);
    addJitterQuat(fr.quats[BONE_IDX.LeftHand], 34, 0.075, f);
    addJitterQuat(fr.quats[BONE_IDX.Head], 35, 0.04, f);
  }

  return {
    id: 'kick',
    name: '回旋踢',
    fps,
    totalFrames,
    duration: totalFrames / fps,
    syntheticSpeed: 0.65,
    isCombatAttack: false,
    hasWeapon: false,
    nonCyclic: false,
    preserveRootMotion: false,
    stabilizeInPlace: false,
    frames,
  };
}

/**
 * Preset 3: 原地后空翻 (`avatar_backflip.bvh`)
 * Full 360-degree aerial somersault: crouch & landing feet lock cleanly while mid-air tuck flies freely!
 */
export function buildBackflipClip() {
  const { frames, totalFrames, fps } = retargetBVHToFrames(MOCAP_BACKFLIP_BVH, 60);
  measureCleanFootContacts(frames, fps, 0.142, 0.95);

  for (let f = 0; f < totalFrames; f++) {
    const u = f / totalFrames;
    const phase = u * Math.PI * 2;
    const fr = frames[f];

    fr.rootPos.x += 0.028 * Math.sin(f * 1.8) + (u > 0.80 ? ((u - 0.80) / 0.20) * 0.07 : 0);
    fr.rootPos.z += 0.038 * Math.cos(f * 1.55) + (u > 0.80 ? ((u - 0.80) / 0.20) * 0.09 : 0);
    fr.rootPos.y += 0.018 * Math.sin(f * 2.1);

    if (fr.contactL) {
      addEulerOffsetQuat(fr.quats[BONE_IDX.LeftUpLeg], 0.13 * Math.sin(phase * 3), 0, 0.08 * Math.cos(phase * 2));
    }
    if (fr.contactR) {
      addEulerOffsetQuat(fr.quats[BONE_IDX.RightUpLeg], -0.13 * Math.cos(phase * 3), 0, -0.08 * Math.sin(phase * 2));
    }

    addJitterQuat(fr.quats[BONE_IDX.LeftHand], 41, 0.08, f);
    addJitterQuat(fr.quats[BONE_IDX.RightHand], 42, 0.08, f);
    addJitterQuat(fr.quats[BONE_IDX.LeftFoot], 43, 0.075, f);
    addJitterQuat(fr.quats[BONE_IDX.RightFoot], 44, 0.075, f);
    addJitterQuat(fr.quats[BONE_IDX.Head], 45, 0.04, f);
  }

  return {
    id: 'backflip',
    name: '原地后空翻',
    fps,
    totalFrames,
    duration: totalFrames / fps,
    syntheticSpeed: 0.5,
    isCombatAttack: false,
    hasWeapon: false,
    nonCyclic: false,
    preserveRootMotion: false,
    stabilizeInPlace: false,
    frames,
  };
}

/**
 * Preset 4: 冲刺奔跑 (`avatar_run.bvh`)
 * High-cadence running cycle + simulated AI foot skating, root drift & loop discontinuity.
 */
export function buildRunClip() {
  const { frames, totalFrames, fps } = retargetBVHToFrames(MOCAP_RUN_BVH, 60);
  measureCleanFootContacts(frames, fps, 0.138, Infinity);

  for (let f = 0; f < totalFrames; f++) {
    const u = f / totalFrames;
    const phase = u * Math.PI * 2;
    const fr = frames[f];

    fr.rootPos.z += 0.18 * Math.sin(phase + 0.35) + (u > 0.72 ? ((u - 0.72) / 0.28) * 0.14 : 0);
    fr.rootPos.x += 0.05 * Math.cos(phase) + (u > 0.75 ? ((u - 0.75) / 0.25) * 0.05 : 0);
    fr.rootPos.y += 0.02 * Math.sin(f * 1.7);

    addJitterQuat(fr.quats[BONE_IDX.LeftFoot], 1, 0.075, f);
    addJitterQuat(fr.quats[BONE_IDX.RightFoot], 2, 0.075, f);
    addJitterQuat(fr.quats[BONE_IDX.LeftHand], 3, 0.085, f);
    addJitterQuat(fr.quats[BONE_IDX.RightHand], 4, 0.09, f);
    addJitterQuat(fr.quats[BONE_IDX.Head], 5, 0.045, f);
  }

  return {
    id: 'run',
    name: '冲刺奔跑',
    fps,
    totalFrames,
    duration: totalFrames / fps,
    syntheticSpeed: 2.8,
    isCombatAttack: false,
    hasWeapon: false,
    nonCyclic: false,
    preserveRootMotion: false,
    stabilizeInPlace: true,
    frames,
  };
}

/**
 * Parses an uploaded or library .bvh file directly without injecting artificial degradation.
 * Defaults `preserveRootMotion: true` and auto-detects `nonCyclic` unless cyclic filename/option is set.
 */
export function parseBVHTextToClip(bvhText, fileName = 'Custom.bvh', options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const rawFps = Number(opts.targetFps ?? opts.fps);
  const targetFps = Number.isFinite(rawFps) && rawFps > 0 ? rawFps : 60;
  const preserveRootMotion = opts.preserveRootMotion !== undefined ? Boolean(opts.preserveRootMotion) : true;
  const rootOriginMode = opts.rootOriginMode ?? 'start';
  const maxFrames = opts.maxFrames ?? Infinity;
  const groundAlign = opts.groundAlign !== undefined ? Boolean(opts.groundAlign) : true;

  const { frames, totalFrames, fps } = retargetBVHToFrames(bvhText, targetFps, {
    preserveRootMotion,
    rootOriginMode,
    maxFrames,
    groundAlign,
  });

  const cyclicByFilename =
    /(?:^|[^a-zA-Z])(idle|stand|walk|run|jog|sprint|strafe|loco|loop|breath|01b)(?:$|[^a-zA-Z])|待机|呼吸|疾跑|奔跑|垫步|后撤步|行走|循环|定势/i.test(
      fileName
    );
  const isCyclic =
    opts.cyclic !== undefined
      ? Boolean(opts.cyclic)
      : opts.nonCyclic !== undefined
        ? !Boolean(opts.nonCyclic)
        : cyclicByFilename;
  const nonCyclic = !isCyclic;

  const hasWeapon =
    opts.hasWeapon !== undefined
      ? Boolean(opts.hasWeapon)
      : /sword|slash|blade|weapon|combo|canglong|wuhen|yuluo|feiyan|taibai|剑|斩|太白|苍龙|无痕|雨落|飞燕/i.test(
          fileName
        );
  const isCombatAttack =
    opts.isCombatAttack !== undefined
      ? Boolean(opts.isCombatAttack)
      : /sword|slash|strike|attack|combo|canglong|wuhen|yuluo|feiyan|kick|斩|剑|刺|踢/i.test(fileName);

  const sanitizedId =
    opts.id ||
    String(fileName)
      .replace(/\.bvh$/i, '')
      .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_')
      .replace(/^_+|_+$/g, '') ||
    'custom_bvh';

  return {
    id: sanitizedId,
    name: opts.name || `BVH: ${fileName}`,
    fps,
    totalFrames,
    duration: totalFrames / fps,
    syntheticSpeed: opts.syntheticSpeed ?? 0.8,
    isCombatAttack,
    hasWeapon,
    nonCyclic,
    preserveRootMotion,
    stabilizeInPlace: opts.stabilizeInPlace !== undefined ? Boolean(opts.stabilizeInPlace) : false,
    retargetOptions: {
      targetFps: fps,
      rootOriginMode,
      maxFrames,
      groundAlign,
    },
    rawBVHText: bvhText,
    sourceFileName: fileName,
    frames,
  };
}
