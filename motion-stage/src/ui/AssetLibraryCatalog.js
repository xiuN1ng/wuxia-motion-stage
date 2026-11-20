export const ASSET_CATEGORY_ORDER = [
  { key: 'presets', label: '内置退化对比预设 · 开源动捕库 (MakeHuman / CMU)' },
  { key: 'videos', label: '武术与太白实拍视频 · AI 实时姿态提取 (MediaPipe)' },
  { key: 'b_cleaned', label: 'B_cleaned_ready · 开源光学动捕库 (22套 · CMU / MakeHuman)' },
  { key: 'c_taibai', label: 'C_taibai_extracted · AI 视频提取成品 (4套 · 天刀太白)' },
];

export const STATIC_ASSET_CATALOG = [
  // 1. Built-in Raw-vs-Clean Presets
  {
    id: 'preset:slash',
    presetKey: 'slash',
    kind: 'preset',
    category: 'presets',
    label: '剑术连斩 (Raw 瑕疵 vs Clean 修复)',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: true,
    preserveRootMotion: false,
  },
  {
    id: 'preset:kick',
    presetKey: 'kick',
    kind: 'preset',
    category: 'presets',
    label: '旋风回旋踢 (Raw 瑕疵 vs Clean 修复)',
    cyclic: true,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: false,
  },
  {
    id: 'preset:backflip',
    presetKey: 'backflip',
    kind: 'preset',
    category: 'presets',
    label: '原地后空翻 (Raw 瑕疵 vs Clean 修复)',
    cyclic: true,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: false,
  },
  {
    id: 'preset:run',
    presetKey: 'run',
    kind: 'preset',
    category: 'presets',
    label: '冲刺奔跑 (Raw 瑕疵 vs Clean 修复)',
    cyclic: true,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: false,
  },

  // 2. Reference Wushu / Taibai Videos
  {
    id: 'video:01b',
    kind: 'video',
    category: 'videos',
    label: '01b 太白崖顶横剑定势 · 1.0s (.mp4)',
    path: '/reference_videos/01b_天刀官网_太白崖顶拔剑定势_全身镜头.mp4',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'video:02',
    kind: 'video',
    category: 'videos',
    label: '02 无痕剑意·独立提膝云剑 · 3.1s (.mp4)',
    path: '/reference_videos/02_太白无痕剑意_世界冠军李昕豫_独立提膝云剑_720p.mp4',
    cyclic: false,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'video:03',
    kind: 'video',
    category: 'videos',
    label: '03 雨落云飞·快剑五连斩 · 5.1s (.mp4)',
    path: '/reference_videos/03_太白雨落云飞_北京武术队_快剑五连斩单人实拍_720p.mp4',
    cyclic: false,
    hasWeapon: true,
    isCombatAttack: true,
    preserveRootMotion: true,
  },
  {
    id: 'video:04',
    kind: 'video',
    category: 'videos',
    label: '04 飞燕逐月·腾空旋风跌叉 · 1.8s (.mp4)',
    path: '/reference_videos/04_太白飞燕逐月_全国冠军王曦_腾空旋风跌叉单人裁剪.mp4',
    cyclic: false,
    hasWeapon: true,
    isCombatAttack: true,
    preserveRootMotion: true,
  },
  {
    id: 'video:05',
    kind: 'video',
    category: 'videos',
    label: '05 北京武术队2012巡演完整母带 · 75.9s [区间截取]',
    path: '/reference_videos/05_北京武术队2012巡演完整母带_720p_CC-BY-3.0.mp4',
    cyclic: false,
    hasWeapon: true,
    isCombatAttack: true,
    preserveRootMotion: true,
    defaultTrimIn: 26.72,
    defaultTrimOut: 31.77,
  },

  // 3. B_cleaned_ready Standard 21-Bone BVH Library (01..15)
  {
    id: 'b_bvh:01_wuxia_idle',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '01 待机呼吸 (Idle · 108f)',
    path: '/bvh_library/B_cleaned_ready/01_wuxia_idle_待机呼吸_cleaned.bvh',
    cyclic: true,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: false,
  },
  {
    id: 'b_bvh:02_wuxia_run',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '02 疾跑轻功 (Run · 52f)',
    path: '/bvh_library/B_cleaned_ready/02_wuxia_run_疾跑轻功_cleaned.bvh',
    cyclic: true,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: false,
  },
  {
    id: 'b_bvh:03_wuxia_sword_combo',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '03 剑术连斩去穿模 (Sword Combo · 82f)',
    path: '/bvh_library/B_cleaned_ready/03_wuxia_sword_combo_剑术连斩去穿模_cleaned.bvh',
    cyclic: false,
    hasWeapon: true,
    isCombatAttack: true,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:04_wuxia_tornado_kick',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '04 旋风回旋踢 (Tornado Kick · 113f)',
    path: '/bvh_library/B_cleaned_ready/04_wuxia_tornado_kick_旋风回旋踢_cleaned.bvh',
    cyclic: false,
    hasWeapon: false,
    isCombatAttack: true,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:05_wuxia_front_kick',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '05 正蹬破防踢 (Front Kick · 87f)',
    path: '/bvh_library/B_cleaned_ready/05_wuxia_front_kick_正蹬破防踢_cleaned.bvh',
    cyclic: false,
    hasWeapon: false,
    isCombatAttack: true,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:06_wuxia_backflip',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '06 原地后空翻 (Backflip · 72f)',
    path: '/bvh_library/B_cleaned_ready/06_wuxia_backflip_原地后空翻_cleaned.bvh',
    cyclic: false,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:07_wuxia_strafe_F',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '07F 八向垫步·前垫步 (Strafe F)',
    path: '/bvh_library/B_cleaned_ready/07_wuxia_strafe_F_前垫步_cleaned.bvh',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:07_wuxia_strafe_B',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '07B 八向垫步·后撤步 (Strafe B)',
    path: '/bvh_library/B_cleaned_ready/07_wuxia_strafe_B_后撤步_cleaned.bvh',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:07_wuxia_strafe_L',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '07L 八向垫步·左垫步 (Strafe L)',
    path: '/bvh_library/B_cleaned_ready/07_wuxia_strafe_L_左垫步_cleaned.bvh',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:07_wuxia_strafe_R',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '07R 八向垫步·右垫步 (Strafe R)',
    path: '/bvh_library/B_cleaned_ready/07_wuxia_strafe_R_右垫步_cleaned.bvh',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:07_wuxia_strafe_FL',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '07FL 八向垫步·左前垫步 (Strafe FL)',
    path: '/bvh_library/B_cleaned_ready/07_wuxia_strafe_FL_左前垫步_cleaned.bvh',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:07_wuxia_strafe_FR',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '07FR 八向垫步·右前垫步 (Strafe FR)',
    path: '/bvh_library/B_cleaned_ready/07_wuxia_strafe_FR_右前垫步_cleaned.bvh',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:07_wuxia_strafe_BL',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '07BL 八向垫步·左后垫步 (Strafe BL)',
    path: '/bvh_library/B_cleaned_ready/07_wuxia_strafe_BL_左后垫步_cleaned.bvh',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:07_wuxia_strafe_BR',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '07BR 八向垫步·右后垫步 (Strafe BR)',
    path: '/bvh_library/B_cleaned_ready/07_wuxia_strafe_BR_右后垫步_cleaned.bvh',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:08_wuxia_dash_canglong',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '08 苍龙出水突刺 (Forward Dash +Z)',
    path: '/bvh_library/B_cleaned_ready/08_wuxia_dash_canglong_苍龙出水突刺_cleaned.bvh',
    cyclic: false,
    hasWeapon: true,
    isCombatAttack: true,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:09_wuxia_dodge_roll',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '09 翻滚闪避 (Dodge Roll +Z)',
    path: '/bvh_library/B_cleaned_ready/09_wuxia_dodge_roll_翻滚闪避_cleaned.bvh',
    cyclic: false,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:10_wuxia_double_jump',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '10 二段轻功跳 (Air Double Jump)',
    path: '/bvh_library/B_cleaned_ready/10_wuxia_double_jump_二段轻功跳_cleaned.bvh',
    cyclic: false,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:11_wuxia_hit_light_L',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '11 左轻受击 (Hit Light L)',
    path: '/bvh_library/B_cleaned_ready/11_wuxia_hit_light_L_左轻受击_cleaned.bvh',
    cyclic: false,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:12_wuxia_hit_light_R',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '12 右轻受击 (Hit Light R)',
    path: '/bvh_library/B_cleaned_ready/12_wuxia_hit_light_R_右轻受击_cleaned.bvh',
    cyclic: false,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:13_wuxia_knockdown',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '13 击飞倒地 (Hit Knockdown)',
    path: '/bvh_library/B_cleaned_ready/13_wuxia_knockdown_击飞倒地_cleaned.bvh',
    cyclic: false,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:14_wuxia_kipup',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '14 鲤鱼打挺起身 (Kip-Up)',
    path: '/bvh_library/B_cleaned_ready/14_wuxia_kipup_鲤鱼打挺起身_cleaned.bvh',
    cyclic: false,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'b_bvh:15_wuxia_knockdown_kipup',
    kind: 'bvh',
    category: 'b_cleaned',
    label: '15 击飞倒地接鲤鱼打挺 (Knockdown -> Kip-Up)',
    path: '/bvh_library/B_cleaned_ready/15_wuxia_knockdown_kipup_击飞倒地接鲤鱼打挺_cleaned.bvh',
    cyclic: false,
    hasWeapon: false,
    isCombatAttack: false,
    preserveRootMotion: true,
  },

  // 4. C_taibai_extracted AI Video Extracted Taibai BVHs (with automatic video fallback if 404)
  {
    id: 'c_bvh:taibai_01b',
    kind: 'bvh',
    category: 'c_taibai',
    label: 'taibai_01b 崖顶横剑定势 (.bvh)',
    path: '/bvh_library/C_taibai_extracted/taibai_01b_崖顶横剑定势_cleaned.bvh',
    fallbackVideoId: 'video:01b',
    fallbackVideoUrl: '/reference_videos/01b_天刀官网_太白崖顶拔剑定势_全身镜头.mp4',
    cyclic: true,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'c_bvh:taibai_02',
    kind: 'bvh',
    category: 'c_taibai',
    label: 'taibai_02 无痕剑意·独立提膝云剑 (.bvh)',
    path: '/bvh_library/C_taibai_extracted/taibai_02_无痕剑意_独立提膝云剑_cleaned.bvh',
    fallbackVideoId: 'video:02',
    fallbackVideoUrl: '/reference_videos/02_太白无痕剑意_世界冠军李昕豫_独立提膝云剑_720p.mp4',
    cyclic: false,
    hasWeapon: true,
    isCombatAttack: false,
    preserveRootMotion: true,
  },
  {
    id: 'c_bvh:taibai_03',
    kind: 'bvh',
    category: 'c_taibai',
    label: 'taibai_03 雨落云飞·快剑五连斩 (.bvh)',
    path: '/bvh_library/C_taibai_extracted/taibai_03_雨落云飞_快剑五连斩_cleaned.bvh',
    fallbackVideoId: 'video:03',
    fallbackVideoUrl: '/reference_videos/03_太白雨落云飞_北京武术队_快剑五连斩单人实拍_720p.mp4',
    cyclic: false,
    hasWeapon: true,
    isCombatAttack: true,
    preserveRootMotion: true,
  },
  {
    id: 'c_bvh:taibai_04',
    kind: 'bvh',
    category: 'c_taibai',
    label: 'taibai_04 飞燕逐月·腾空旋风跌叉 (.bvh)',
    path: '/bvh_library/C_taibai_extracted/taibai_04_飞燕逐月_腾空旋风跌叉_cleaned.bvh',
    fallbackVideoId: 'video:04',
    fallbackVideoUrl: '/reference_videos/04_太白飞燕逐月_全国冠军王曦_腾空旋风跌叉单人裁剪.mp4',
    cyclic: false,
    hasWeapon: true,
    isCombatAttack: true,
    preserveRootMotion: true,
  },
];

function normalizeManifestPath(rawPath) {
  if (!rawPath) return '';
  const s = String(rawPath).trim().replace(/^\.\//, '/');
  if (s.startsWith('/bvh_library/') || s.startsWith('/reference_videos/')) return s;
  if (s.startsWith('bvh_library/')) return `/${s}`;
  if (s.startsWith('reference_videos/')) return `/${s}`;
  if (s.startsWith('B_cleaned_ready/') || s.startsWith('C_taibai_extracted/') || s.startsWith('A_raw_mocap/')) {
    return `/bvh_library/${s}`;
  }
  return s.startsWith('/') ? s : `/bvh_library/${s}`;
}

function inferCategoryFromPath(normPath, rawCategory) {
  const cat = String(rawCategory || '').toLowerCase();
  if (normPath.includes('/C_taibai_extracted/') || cat.includes('taibai') || cat === 'c_taibai') {
    return 'c_taibai';
  }
  if (normPath.includes('/reference_videos/') || /\.(mp4|webm|mov)$/i.test(normPath) || cat === 'videos') {
    return 'videos';
  }
  return 'b_cleaned';
}

export function extractManifestItems(manifestData) {
  if (!manifestData) return [];
  if (Array.isArray(manifestData)) return manifestData;
  if (typeof manifestData === 'object') {
    if (Array.isArray(manifestData.clips)) return manifestData.clips;
    if (Array.isArray(manifestData.assets)) return manifestData.assets;
    if (Array.isArray(manifestData.items)) return manifestData.items;
    if (Array.isArray(manifestData.entries)) return manifestData.entries;
  }
  return [];
}

/**
 * Pure merge helper combining dynamic `/bvh_library/MANIFEST.json` entries over `STATIC_ASSET_CATALOG`
 * without creating duplicates.
 */
export function mergeManifestWithCatalog(manifestData, baseCatalog = STATIC_ASSET_CATALOG) {
  const merged = baseCatalog.map((item) => ({ ...item }));
  const items = extractManifestItems(manifestData);
  if (!items.length) return merged;

  const byPath = new Map();
  const byId = new Map();
  merged.forEach((entry, idx) => {
    if (entry.path) byPath.set(entry.path, idx);
    byId.set(entry.id, idx);
  });

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const normPath = normalizeManifestPath(raw.path || raw.file || raw.url || '');
    const category = inferCategoryFromPath(normPath, raw.category);
    const kind = category === 'videos' ? 'video' : 'bvh';
    const rawId = String(raw.id || '').trim();
    const prefixedId =
      rawId.includes(':') || !rawId
        ? rawId || `${category === 'c_taibai' ? 'c_bvh' : 'b_bvh'}:${normPath.split('/').pop()?.replace(/\.bvh$/i, '')}`
        : `${category === 'c_taibai' ? 'c_bvh' : category === 'videos' ? 'video' : 'b_bvh'}:${rawId}`;

    const existingIdx =
      (normPath && byPath.has(normPath) ? byPath.get(normPath) : undefined) ??
      (byId.has(rawId) ? byId.get(rawId) : undefined) ??
      (byId.has(prefixedId) ? byId.get(prefixedId) : undefined);

    if (existingIdx !== undefined) {
      const target = merged[existingIdx];
      if (raw.label) target.label = raw.label;
      if (raw.cyclic !== undefined) target.cyclic = Boolean(raw.cyclic);
      if (raw.hasWeapon !== undefined) target.hasWeapon = Boolean(raw.hasWeapon);
      if (raw.preserveRootMotion !== undefined) target.preserveRootMotion = Boolean(raw.preserveRootMotion);
      if (raw.frames !== undefined) target.frames = raw.frames;
      if (raw.fps !== undefined) target.fps = raw.fps;
      if (raw.durationSec !== undefined) target.durationSec = raw.durationSec;
      if (raw.archetype) target.archetype = raw.archetype;
      if (raw.sourceProvenance) target.sourceProvenance = raw.sourceProvenance;
      if (raw.sourceProvenanceDetail) target.sourceProvenanceDetail = raw.sourceProvenanceDetail;
      if (raw.driveFileId) target.driveFileId = raw.driveFileId;
      target.manifestVerified = true;
    } else if (normPath) {
      const added = {
        id: prefixedId,
        kind,
        category,
        label: raw.label || normPath.split('/').pop() || prefixedId,
        path: normPath,
        cyclic: Boolean(raw.cyclic),
        hasWeapon: Boolean(raw.hasWeapon),
        isCombatAttack: Boolean(
          raw.isCombatAttack ?? /attack|combo|slash|sword|kick|wuhen|yuluo|feiyan|canglong/i.test(normPath)
        ),
        preserveRootMotion: raw.preserveRootMotion !== undefined ? Boolean(raw.preserveRootMotion) : true,
        frames: raw.frames,
        fps: raw.fps,
        durationSec: raw.durationSec,
        archetype: raw.archetype,
        sourceProvenance: raw.sourceProvenance,
        sourceProvenanceDetail: raw.sourceProvenanceDetail,
        driveFileId: raw.driveFileId,
        manifestVerified: true,
      };
      const newIdx = merged.length;
      merged.push(added);
      byPath.set(normPath, newIdx);
      byId.set(added.id, newIdx);
    }
  }

  return merged;
}

const KNOWN_ORIGIN_LOOKUP = [
  {
    match: /(taibai_01b|video:01b|01b_)/i,
    originGroup: 'ai_extracted',
    tagShort: 'AI提取',
    badgeLabel: 'AI 视频提取 · MediaPipe',
    upstreamText: '天刀太白崖顶横剑实拍 (1.0s)',
  },
  {
    match: /(taibai_02|taibai_demo|taibai_wuhen|video:02|02_太白无痕)/i,
    originGroup: 'ai_extracted',
    tagShort: 'AI提取',
    badgeLabel: 'AI 视频提取 · MediaPipe',
    upstreamText: '世界冠军李昕豫剑术实拍 (CC BY 3.0)',
  },
  {
    match: /(taibai_03|video:03|03_太白雨落)/i,
    originGroup: 'ai_extracted',
    tagShort: 'AI提取',
    badgeLabel: 'AI 视频提取 · MediaPipe',
    upstreamText: '北京武术队2012巡演实拍 (CC BY 3.0)',
  },
  {
    match: /(taibai_04|video:04|04_太白飞燕)/i,
    originGroup: 'ai_extracted',
    tagShort: 'AI提取',
    badgeLabel: 'AI 视频提取 · MediaPipe',
    upstreamText: '全国冠军王曦旋风跌叉实拍 (CC BY 3.0)',
  },
  {
    match: /(video:05|taibai_video_05|05_北京武术队)/i,
    originGroup: 'ai_extracted',
    tagShort: 'AI提取',
    badgeLabel: 'AI 视频提取 · MediaPipe',
    upstreamText: '北京武术队2012巡演75.9s母带 (CC BY 3.0)',
  },
  {
    match: /(^|:)(01_idle|wuxia_01_idle|01_wuxia_idle)/i,
    originGroup: 'open_mocap',
    tagShort: '开源·MH',
    badgeLabel: '开源动捕库 · MakeHuman',
    upstreamText: 'MakeHuman avatar_stand_1.bvh (CC0)',
  },
  {
    match: /(^|:)(run|02_run|wuxia_02_run|02_wuxia_run)/i,
    originGroup: 'open_mocap',
    tagShort: '开源·MH',
    badgeLabel: '开源动捕库 · MakeHuman',
    upstreamText: 'MakeHuman avatar_run.bvh (CC0)',
  },
  {
    match: /(^|:)(slash|combo_[123]|03_sword_combo|wuxia_03_sword_combo|03_wuxia_sword_combo)/i,
    originGroup: 'open_mocap',
    tagShort: '开源·MH',
    badgeLabel: '开源动捕库 · MakeHuman',
    upstreamText: 'MakeHuman avatar_sword_strike_R.bvh (CC0)',
  },
  {
    match: /(^|:)(kick|04_tornado_kick|wuxia_04_tornado_kick|04_wuxia_tornado_kick)/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #87_01 旋风踢 (Public Domain)',
  },
  {
    match: /(^|:)(05_front_kick|wuxia_05_front_kick|05_wuxia_front_kick)/i,
    originGroup: 'open_mocap',
    tagShort: '开源·MH',
    badgeLabel: '开源动捕库 · MakeHuman',
    upstreamText: 'MakeHuman avatar_kick_roundhouse_R.bvh (CC0)',
  },
  {
    match: /(^|:)(backflip|06_backflip|wuxia_06_backflip|06_wuxia_backflip)/i,
    originGroup: 'open_mocap',
    tagShort: '开源·MH',
    badgeLabel: '开源动捕库 · MakeHuman',
    upstreamText: 'MakeHuman avatar_backflip.bvh (CC0)',
  },
  {
    match: /07_.*strafe_F\b/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #143_32 前垫步重定向 (Public Domain)',
  },
  {
    match: /07_.*strafe_B\b/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #143_39 后撤步重定向 (Public Domain)',
  },
  {
    match: /07_.*strafe_[LR]\b/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #141_33 侧垫步重定向 (Public Domain)',
  },
  {
    match: /07_.*strafe_F[LR]\b/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #141_32 斜前垫步重定向 (Public Domain)',
  },
  {
    match: /07_.*strafe_B[LR]\b/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #143_40 斜后垫步重定向 (Public Domain)',
  },
  {
    match: /08_.*dash_canglong/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #49_04 剑刺突进 (Public Domain)',
  },
  {
    match: /09_.*dodge_roll/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #90_34 前滚翻闪避 (Public Domain)',
  },
  {
    match: /(^|:)(jump|10_.*double_jump)/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #83_62 腾空轻功跳 (Public Domain)',
  },
  {
    match: /11_.*hit_light_L/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #144_07 左受击硬直 (Public Domain)',
  },
  {
    match: /12_.*hit_light_R/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #144_26 右受击硬直 (Public Domain)',
  },
  {
    match: /15_.*knockdown_kipup/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #90_18 + #140_08 倒地接打挺',
  },
  {
    match: /13_.*knockdown/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #90_18 击飞倒地 (Public Domain)',
  },
  {
    match: /14_.*kipup/i,
    originGroup: 'open_mocap',
    tagShort: '开源·CMU',
    badgeLabel: '开源动捕库 · CMU Mocap',
    upstreamText: 'CMU Mocap #140_08 鲤鱼打挺 (Public Domain)',
  },
];

/**
 * Resolves unified human-readable provenance metadata distinguishing AI-extracted clips
 * (`C_taibai_extracted`, reference/uploaded videos & images) from open-source optical mocap
 * libraries (`MakeHuman OpenMocap` & `CMU Graphics Lab Mocap`).
 */
export function resolveMotionProvenance(input = {}) {
  const {
    clipKey = '',
    clipId = '',
    clipName = '',
    path = '',
    category = '',
    kind = '',
    originKind = '',
    sourceProvenance = '',
    sourceProvenanceDetail = null,
  } = typeof input === 'string' ? { clipId: input } : input || {};

  if (originKind === 'video_capture' || originKind === 'image_capture') {
    return {
      originGroup: 'ai_extracted',
      tagShort: 'AI提取',
      badgeLabel: originKind === 'image_capture' ? 'AI 图像姿态提取 · MediaPipe' : 'AI 视频实时提取 · MediaPipe',
      upstreamText: clipName || '本地上传实拍媒体',
    };
  }
  if (originKind === 'bvh_upload') {
    return {
      originGroup: 'custom_bvh',
      tagShort: '本地BVH',
      badgeLabel: '本地导入 · 标准 BVH',
      upstreamText: clipName || '用户上传 .bvh 动作文件',
    };
  }

  const probe = [clipKey, clipId, path, clipName].filter(Boolean).join(' | ');
  for (const rule of KNOWN_ORIGIN_LOOKUP) {
    if (rule.match.test(probe)) {
      return { ...rule };
    }
  }

  const provStr = `${sourceProvenanceDetail?.type || ''} ${sourceProvenance || ''}`.toLowerCase();
  if (
    kind === 'video' ||
    category === 'videos' ||
    category === 'c_taibai' ||
    path.includes('/C_taibai_extracted/') ||
    path.includes('/reference_videos/') ||
    provStr.includes('mediapipe') ||
    provStr.includes('video')
  ) {
    return {
      originGroup: 'ai_extracted',
      tagShort: 'AI提取',
      badgeLabel: 'AI 视频提取 · MediaPipe',
      upstreamText: sourceProvenanceDetail?.upstreamRef || clipName || '实拍视频姿态提取',
    };
  }
  if (provStr.includes('makehuman')) {
    return {
      originGroup: 'open_mocap',
      tagShort: '开源·MH',
      badgeLabel: '开源动捕库 · MakeHuman',
      upstreamText: sourceProvenanceDetail?.upstreamRef || 'MakeHuman OpenMocap (CC0)',
    };
  }
  if (provStr.includes('cmu') || category === 'b_cleaned' || path.includes('/B_cleaned_ready/')) {
    return {
      originGroup: 'open_mocap',
      tagShort: '开源·CMU',
      badgeLabel: '开源动捕库 · CMU Mocap',
      upstreamText: sourceProvenanceDetail?.upstreamRef || 'CMU Graphics Lab 光学动捕库',
    };
  }

  return {
    originGroup: 'custom_bvh',
    tagShort: '外部动作',
    badgeLabel: '外部骨骼动作 (.BVH)',
    upstreamText: clipName || clipId || '自定义动作资产',
  };
}

export async function fetchAssetCatalog(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    return STATIC_ASSET_CATALOG.map((item) => ({ ...item }));
  }
  try {
    const resp = await fetchImpl('/bvh_library/MANIFEST.json', { cache: 'no-store' });
    if (!resp.ok) {
      return STATIC_ASSET_CATALOG.map((item) => ({ ...item }));
    }
    const contentType = resp.headers?.get?.('content-type') || '';
    if (contentType.includes('text/html')) {
      return STATIC_ASSET_CATALOG.map((item) => ({ ...item }));
    }
    const data = await resp.json();
    return mergeManifestWithCatalog(data, STATIC_ASSET_CATALOG);
  } catch {
    return STATIC_ASSET_CATALOG.map((item) => ({ ...item }));
  }
}

export function findAssetInCatalog(catalog, idOrQuery) {
  if (!idOrQuery || !Array.isArray(catalog)) return null;
  const q = String(idOrQuery).trim();
  return (
    catalog.find((item) => item.id === q) ||
    catalog.find((item) => item.presetKey === q) ||
    catalog.find((item) => item.id.endsWith(`:${q}`)) ||
    catalog.find((item) => item.path && (item.path === q || item.path.endsWith(`/${q}`) || item.path.includes(q))) ||
    null
  );
}

export function populateAssetSelectElement(selectEl, catalog, selectedId = '') {
  if (!selectEl) return;
  const prevValue = selectedId || selectEl.value || '';
  selectEl.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '动作库 (开源库 22套 / AI提取 4套)...';
  selectEl.appendChild(placeholder);

  for (const groupDef of ASSET_CATEGORY_ORDER) {
    const groupItems = catalog.filter((item) => item.category === groupDef.key);
    if (!groupItems.length) continue;

    const optgroup = document.createElement('optgroup');
    optgroup.label = groupDef.label;

    for (const item of groupItems) {
      const opt = document.createElement('option');
      opt.value = item.id;
      const prov = resolveMotionProvenance({
        clipKey: item.presetKey || item.id,
        clipId: item.id,
        clipName: item.label,
        path: item.path || '',
        category: item.category,
        kind: item.kind,
        sourceProvenance: item.sourceProvenance,
        sourceProvenanceDetail: item.sourceProvenanceDetail,
      });
      const prefix = prov?.tagShort ? `[${prov.tagShort}] ` : '';
      const suffix =
        item.frames && item.fps && !/\d+f/.test(item.label) ? ` · ${item.frames}f` : '';
      opt.textContent = `${prefix}${item.label}${suffix}`;
      optgroup.appendChild(opt);
    }
    selectEl.appendChild(optgroup);
  }

  if (prevValue && catalog.some((item) => item.id === prevValue)) {
    selectEl.value = prevValue;
  } else {
    selectEl.value = '';
  }
}
