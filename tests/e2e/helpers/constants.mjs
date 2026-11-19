import path from 'node:path';

export const WORKSPACE_ROOT = '/home/antigravity';
export const MOTION_STAGE_ROOT = '/home/antigravity/motion-stage';
export const BVH_LIBRARY_ROOT = '/home/antigravity/bvh_library';
export const RAW_MOCAP_DIR = path.join(BVH_LIBRARY_ROOT, 'A_raw_mocap');
export const B_CLEANED_DIR = path.join(BVH_LIBRARY_ROOT, 'B_cleaned_ready');
export const C_TAIBAI_DIR = path.join(BVH_LIBRARY_ROOT, 'C_taibai_extracted');
export const MANIFEST_PATH = path.join(BVH_LIBRARY_ROOT, 'MANIFEST.json');
export const REF_VIDEOS_DIR = '/home/antigravity/reference_videos';
export const DOCS_DIR = '/home/antigravity/docs';

export const GDRIVE_BIN = '/opt/antigravity/bin/gdrive';
export const FFPROBE_BIN = '/usr/bin/ffprobe';
export const FFMPEG_BIN = '/usr/bin/ffmpeg';
export const CHROMIUM_BIN = '/usr/lib/chromium/chromium';
export const VITE_BIN = path.join(MOTION_STAGE_ROOT, 'node_modules/.bin/vite');

export const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173';

// Google Drive Canonical IDs
export const DRIVE_ROOT_ID = '1gAsMG7884ToeYtyeaWgBNacZenHJObR4';
export const DRIVE_FOLDER_01_VIDEOS = '1QQVa_jA3D2lG7kyHuykn7j_xselSM6J_';
export const DRIVE_FOLDER_02B_CLEANED = '1h3sid1gTU4rFtWzb-9NRCj1jPuQNrIQ5';
export const DRIVE_FOLDER_02C_TAIBAI = '1xxXXnYg3GVk9zAKrQMSuIPG8JjjESu0v';
export const DRIVE_FILE_05_MASTER = '1MowvRZDlaoYf1PjIfp0Gl9ViOFyTt47B';

// Canonical 21-Bone Standard Humanoid BVH Specification (cm, ZXY Euler, 66 channels)
export const CANONICAL_21_JOINTS = [
  { kw: 'ROOT',  rigIdx: 0,  name: 'Hips',          parent: null,            offset: [0, 0, 0],       endSite: null },
  { kw: 'JOINT', rigIdx: 1,  name: 'Spine',         parent: 'Hips',          offset: [0, 14, 0],      endSite: null },
  { kw: 'JOINT', rigIdx: 2,  name: 'Chest',         parent: 'Spine',         offset: [0, 22, 0],      endSite: null },
  { kw: 'JOINT', rigIdx: 3,  name: 'Neck',          parent: 'Chest',         offset: [0, 22, 0],      endSite: null },
  { kw: 'JOINT', rigIdx: 4,  name: 'Head',          parent: 'Neck',          offset: [0, 10, 0],      endSite: [0, 12, 0] },
  { kw: 'JOINT', rigIdx: 5,  name: 'LeftShoulder',  parent: 'Chest',         offset: [7.5, 17, 0],    endSite: null },
  { kw: 'JOINT', rigIdx: 6,  name: 'LeftUpperArm',  parent: 'LeftShoulder',  offset: [12, 0, 0],      endSite: null },
  { kw: 'JOINT', rigIdx: 7,  name: 'LeftForeArm',   parent: 'LeftUpperArm',  offset: [27, 0, 0],      endSite: null },
  { kw: 'JOINT', rigIdx: 9,  name: 'LeftHand',      parent: 'LeftForeArm',   offset: [25, 0, 0],      endSite: [10, 0, 0] },
  { kw: 'JOINT', rigIdx: 10, name: 'RightShoulder', parent: 'Chest',         offset: [-7.5, 17, 0],   endSite: null },
  { kw: 'JOINT', rigIdx: 11, name: 'RightUpperArm', parent: 'RightShoulder', offset: [-12, 0, 0],     endSite: null },
  { kw: 'JOINT', rigIdx: 12, name: 'RightForeArm',  parent: 'RightUpperArm', offset: [-27, 0, 0],     endSite: null },
  { kw: 'JOINT', rigIdx: 14, name: 'RightHand',     parent: 'RightForeArm',  offset: [-25, 0, 0],     endSite: [-10, 0, 0] },
  { kw: 'JOINT', rigIdx: 15, name: 'LeftUpLeg',     parent: 'Hips',          offset: [10.5, -4, 0],   endSite: null },
  { kw: 'JOINT', rigIdx: 16, name: 'LeftLeg',       parent: 'LeftUpLeg',     offset: [0, -41, 0],     endSite: null },
  { kw: 'JOINT', rigIdx: 17, name: 'LeftFoot',      parent: 'LeftLeg',       offset: [0, -41, 0],     endSite: null },
  { kw: 'JOINT', rigIdx: 18, name: 'LeftToe',       parent: 'LeftFoot',      offset: [0, -5, 12],     endSite: [0, 0, 6] },
  { kw: 'JOINT', rigIdx: 19, name: 'RightUpLeg',    parent: 'Hips',          offset: [-10.5, -4, 0],  endSite: null },
  { kw: 'JOINT', rigIdx: 20, name: 'RightLeg',      parent: 'RightUpLeg',    offset: [0, -41, 0],     endSite: null },
  { kw: 'JOINT', rigIdx: 21, name: 'RightFoot',     parent: 'RightLeg',      offset: [0, -41, 0],     endSite: null },
  { kw: 'JOINT', rigIdx: 22, name: 'RightToe',      parent: 'RightFoot',     offset: [0, -5, 12],     endSite: [0, 0, 6] },
];

export const EXPORT_21_BONE_INDICES = CANONICAL_21_JOINTS.map((j) => j.rigIdx);

export const FORBIDDEN_AUX_TOKENS = [
  'LeftForeArmTwist',
  'RightForeArmTwist',
  'SkirtFront',
  'SkirtBack',
  'Cape01',
  'Cape02',
  'Cape03',
  'Cape04',
  'WeaponGreatsword',
  'WISDOM_SWORD',
];

// Immutable Baseline 01..06 in B_cleaned_ready/
export const BASELINE_01_06_SPECS = [
  {
    file: '01_wuxia_idle_待机呼吸_cleaned.bvh',
    bytes: 57783,
    frames: 108,
    sha256: 'fb83509771a3a4aad985c78ce0911c82ae64378994ce6fe1639379c2a0ef5200',
  },
  {
    file: '02_wuxia_run_疾跑轻功_cleaned.bvh',
    bytes: 30005,
    frames: 52,
    sha256: '0159207fafe541bbf3fd8ce6faafb85805e33e8616f73216a066a1b5b1b93b4b',
  },
  {
    file: '03_wuxia_sword_combo_剑术连斩去穿模_cleaned.bvh',
    bytes: 46057,
    frames: 82,
    sha256: 'cd8a5b9b5ef7a52240d613736f67da71242080729f7dba1e868878debb4a59e6',
  },
  {
    file: '04_wuxia_tornado_kick_旋风回旋踢_cleaned.bvh',
    bytes: 62390,
    frames: 113,
    sha256: 'f95df5b530c6a9daa8509ab54a113183f75ae2b4e1d6bab7873551b4f4e9bafd',
  },
  {
    file: '05_wuxia_front_kick_正蹬破防踢_cleaned.bvh',
    bytes: 49083,
    frames: 87,
    sha256: 'e1d9252df243fdea2fa59f178f72fb46357f35124adea136fe0293fe5bdef135',
  },
  {
    file: '06_wuxia_backflip_原地后空翻_cleaned.bvh',
    bytes: 40416,
    frames: 72,
    sha256: 'd0f773c87181c6f46e13ef19c15185ae1bb6c6dc5bc977c84d4797371b2c9693',
  },
];

export const BASELINE_01_06_FILENAMES = BASELINE_01_06_SPECS.map((s) => s.file);

// Feature F1: 4 Taibai Video-Extracted BVHs (C_taibai_extracted/ & Drive 02/C)
export const TAIBAI_EXPECTED_FILENAMES = [
  'taibai_01b_崖顶横剑定势_cleaned.bvh',
  'taibai_02_无痕剑意_独立提膝云剑_cleaned.bvh',
  'taibai_03_雨落云飞_快剑五连斩_cleaned.bvh',
  'taibai_04_飞燕逐月_腾空旋风跌叉_cleaned.bvh',
];

// Feature F3: 11 Locomotion & Dodge MVP BVHs (B_cleaned_ready/)
export const F3_STRAFE_FILENAMES = [
  '07_wuxia_strafe_F_前垫步_cleaned.bvh',
  '07_wuxia_strafe_B_后撤步_cleaned.bvh',
  '07_wuxia_strafe_L_左垫步_cleaned.bvh',
  '07_wuxia_strafe_R_右垫步_cleaned.bvh',
  '07_wuxia_strafe_FL_左前垫步_cleaned.bvh',
  '07_wuxia_strafe_FR_右前垫步_cleaned.bvh',
  '07_wuxia_strafe_BL_左后垫步_cleaned.bvh',
  '07_wuxia_strafe_BR_右后垫步_cleaned.bvh',
];

export const F3_EXPECTED_FILENAMES = [
  ...F3_STRAFE_FILENAMES,
  '08_wuxia_dash_canglong_苍龙出水突刺_cleaned.bvh',
  '09_wuxia_dodge_roll_翻滚闪避_cleaned.bvh',
  '10_wuxia_double_jump_二段轻功跳_cleaned.bvh',
];

// Feature F4: 5 Hit-React & Kip-Up MVP BVHs (B_cleaned_ready/)
export const F4_EXPECTED_FILENAMES = [
  '11_wuxia_hit_light_L_左轻受击_cleaned.bvh',
  '12_wuxia_hit_light_R_右轻受击_cleaned.bvh',
  '13_wuxia_knockdown_击飞倒地_cleaned.bvh',
  '14_wuxia_kipup_鲤鱼打挺起身_cleaned.bvh',
  '15_wuxia_knockdown_kipup_击飞倒地接鲤鱼打挺_cleaned.bvh',
];

// Complete 26-Asset Canonical Library Relative Paths (from bvh_library/)
export const ALL_22_B_CLEANED_FILENAMES = [
  ...BASELINE_01_06_FILENAMES,
  ...F3_EXPECTED_FILENAMES,
  ...F4_EXPECTED_FILENAMES,
];

export const ALL_26_BVH_REL_PATHS = [
  ...ALL_22_B_CLEANED_FILENAMES.map((f) => `B_cleaned_ready/${f}`),
  ...TAIBAI_EXPECTED_FILENAMES.map((f) => `C_taibai_extracted/${f}`),
];

// Reference Videos Specification (/home/antigravity/reference_videos/)
export const REFERENCE_VIDEO_SPECS = [
  {
    key: '01b',
    file: '01b_天刀官网_太白崖顶拔剑定势_全身镜头.mp4',
    bytes: 1225590,
    width: 1920,
    height: 1080,
    rFrameRate: '24/1',
    minFrames: 24,
    durationMin: 0.95,
    durationMax: 1.05,
    baselinePresent: true,
  },
  {
    key: '02',
    file: '02_太白无痕剑意_世界冠军李昕豫_独立提膝云剑_720p.mp4',
    bytes: 1013265,
    width: 1280,
    height: 720,
    rFrameRate: '24/1',
    minFrames: 74,
    durationMin: 3.05,
    durationMax: 3.20,
    baselinePresent: true,
  },
  {
    key: '03',
    file: '03_太白雨落云飞_北京武术队_快剑五连斩单人实拍_720p.mp4',
    bytes: 3112678,
    width: 1280,
    height: 720,
    rFrameRate: '24/1',
    minFrames: 122,
    durationMin: 5.05,
    durationMax: 5.20,
    baselinePresent: true,
  },
  {
    key: '04',
    file: '04_太白飞燕逐月_全国冠军王曦_腾空旋风跌叉单人裁剪.mp4',
    bytes: 1022982,
    width: 960,
    height: 600,
    rFrameRate: '24/1',
    minFrames: 42,
    durationMin: 1.74,
    durationMax: 1.85,
    baselinePresent: true,
  },
  {
    key: '05',
    file: '05_北京武术队2012巡演完整母带_720p_CC-BY-3.0.mp4',
    bytes: 28448640,
    width: 1280,
    height: 720,
    rFrameRate: '2997/100',
    minFrames: 2240,
    durationMin: 75.80,
    durationMax: 76.05,
    baselinePresent: false,
  },
];

// Feature F10: Canonical Combat State Machine States (15+ states)
export const CANONICAL_COMBAT_STATES = [
  'Idle',
  'Move_8Way',
  'Sprint',
  'Dodge_Dash',
  'Dodge_Roll',
  'Jump',
  'Air_Jump_Double',
  'Evade_Backflip',
  'Attack_Combo_1',
  'Attack_Combo_2',
  'Attack_Combo_3',
  'Skill_Wuhen',
  'Skill_Yuluo',
  'Skill_Feiyan',
  'Skill_Kick',
  'Hit_Light_L',
  'Hit_Light_R',
  'Hit_Knockdown',
  'KipUp',
];

// Feature F11: Canonical 21-Bone Upper/Lower Layer Mask
export const EXPECTED_BONE_LAYER_WEIGHTS = [
  { rigIdx: 0,  name: 'Hips',          weight: 0.0 },
  { rigIdx: 1,  name: 'Spine',         weight: 0.55 },
  { rigIdx: 2,  name: 'Chest',         weight: 0.85 },
  { rigIdx: 3,  name: 'Neck',          weight: 1.0 },
  { rigIdx: 4,  name: 'Head',          weight: 1.0 },
  { rigIdx: 5,  name: 'LeftShoulder',  weight: 1.0 },
  { rigIdx: 6,  name: 'LeftUpperArm',  weight: 1.0 },
  { rigIdx: 7,  name: 'LeftForeArm',   weight: 1.0 },
  { rigIdx: 9,  name: 'LeftHand',      weight: 1.0 },
  { rigIdx: 10, name: 'RightShoulder', weight: 1.0 },
  { rigIdx: 11, name: 'RightUpperArm', weight: 1.0 },
  { rigIdx: 12, name: 'RightForeArm',  weight: 1.0 },
  { rigIdx: 14, name: 'RightHand',     weight: 1.0 },
  { rigIdx: 15, name: 'LeftUpLeg',     weight: 0.0 },
  { rigIdx: 16, name: 'LeftLeg',       weight: 0.0 },
  { rigIdx: 17, name: 'LeftFoot',      weight: 0.0 },
  { rigIdx: 18, name: 'LeftToe',       weight: 0.0 },
  { rigIdx: 19, name: 'RightUpLeg',    weight: 0.0 },
  { rigIdx: 20, name: 'RightLeg',      weight: 0.0 },
  { rigIdx: 21, name: 'RightFoot',     weight: 0.0 },
  { rigIdx: 22, name: 'RightToe',      weight: 0.0 },
];
