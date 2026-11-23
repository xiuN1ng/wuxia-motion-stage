import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  BONE_DEFS,
  BONE_IDX,
  buildCharacterRig,
  createRawGhostVisualizer,
} from '../rig/HumanoidRig.js';
import { parseBVHTextToClip } from '../anim/MotionClips.js';
import { sampleInterpolatedFrame } from '../pipeline/MotionCleaner.js';
import { applyForearmTwistSolver, SpringClothSolver } from '../pipeline/TwoBoneIK.js';
import { exportFramesToBVH } from '../pipeline/BVHExporter.js';
import {
  extractPoseFromVideoElement,
  extractSalientKeyframesFromVideoElement,
} from '../capture/VideoPoseCapture.js';
import { STATIC_ASSET_CATALOG, findAssetInCatalog } from '../ui/AssetLibraryCatalog.js';
import {
  EDITABLE_BONE_GROUPS,
  DEFAULT_INBETWEEN_OPTIONS,
  createNeutralKeyframe,
  cloneKeyframe,
  getBoneLocalEulerDeg,
  setBoneLocalEulerDeg,
  mirrorKeyframePoseLR,
  snapKeyframeFeetToFloor,
  synthesizeKeyframeClip,
} from './KeyframeInbetweener.js';
import { KEYFRAME_TEMPLATES } from './KeyframePresets.js';

const NUM_BONES = BONE_DEFS.length;
const SPEEDS = [1.0, 0.5, 0.25];
const SPLIT_OFFSET_X = 0.85;

function detectSoftwareGpu() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|Software|SubZero/i.test(r);
  } catch {
    return false;
  }
}

export function createKeyframeStudio(hostEl, hooks = {}) {
  let mounted = false;
  let active = false;
  let rafId = 0;
  let lastClock = 0;
  let ownedVideoBlobUrl = null;

  const videoAssets = STATIC_ASSET_CATALOG.filter((x) => x.kind === 'video');
  const bvhCompareAssets = STATIC_ASSET_CATALOG.filter(
    (x) => x.kind === 'bvh' && (x.category === 'c_taibai' || x.category === 'clear_demos' || x.category === 'b_cleaned')
  );

  const st = {
    templateId: KEYFRAME_TEMPLATES[0].id,
    viewMode: 'pose_edit', // 'pose_edit' | 'play_ai' | 'compare_stepped' | 'compare_bvh'
    gizmoMode: 'rotate', // 'rotate' | 'translate'
    onionSkin: true,
    showArc: true,
    playing: false,
    loop: true,
    speedIdx: 0,
    normalizedTime: 0,
    activeKfIdx: 1,
    selectedBoneIdx: BONE_IDX.RightUpperArm,
    compareAssetId: 'c_bvh:taibai_02',
    inbetweenOpts: {
      ...DEFAULT_INBETWEEN_OPTIONS,
      hasWeapon: true,
      cyclic: false,
    },
    keyframes: KEYFRAME_TEMPLATES[0].buildKeyframes(),
    isExtractingVideo: false,
  };

  let synthResult = synthesizeKeyframeClip(st.keyframes, st.inbetweenOpts);
  let compareClip = null;
  const compareClipCache = new Map();

  // Three.js references
  let renderer = null;
  let scene = null;
  let camera = null;
  let orbitControls = null;
  let transformControls = null;
  let transformHelper = null;
  let mainChar = null;
  let leftCompareChar = null;
  let mainCloth = null;
  let leftCloth = null;
  let prevGhost = null;
  let nextGhost = null;
  let jointHandlesGroup = null;
  let jointHandleMeshes = [];
  let arcLine = null;
  let trailMesh = null;
  const trailHistory = [];

  const evalPoseA = {
    rootPos: new THREE.Vector3(),
    quats: Array.from({ length: NUM_BONES }, () => new THREE.Quaternion()),
  };
  const evalPoseB = {
    rootPos: new THREE.Vector3(),
    quats: Array.from({ length: NUM_BONES }, () => new THREE.Quaternion()),
  };

  // DOM Elements map
  const dom = {};

  function buildDOM() {
    hostEl.innerHTML = `
      <div class="kf-canvas-wrap" id="kf-canvas-wrap"></div>

      <!-- Top-Center Stage View & Side-by-Side Comparison Switcher -->
      <div class="kf-view-bar" role="toolbar" aria-label="关键帧视图与对比切换">
        <button type="button" class="kf-view-btn active" data-kf-view="pose_edit">🎯 定格摆姿 (编辑骨骼)</button>
        <button type="button" class="kf-view-btn" data-kf-view="play_ai">▶️ AI补帧预览 (60fps)</button>
        <button type="button" class="kf-view-btn" data-kf-view="compare_stepped">🔀 对比：AI补帧 vs 定格跳切</button>
        <button type="button" class="kf-view-btn" data-kf-view="compare_bvh">🆚 对比：AI补帧 vs 视频直出</button>
        <select id="kf-compare-bvh-select" class="kf-compare-select" title="选择左侧同屏对比的参照动作">
          ${bvhCompareAssets
            .map(
              (item) =>
                `<option value="${item.id}" ${item.id === st.compareAssetId ? 'selected' : ''}>参照: ${item.label.split(' (')[0]}</option>`
            )
            .join('')}
        </select>
      </div>

      <div class="kf-split-banners" id="kf-split-banners" hidden>
        <span class="kf-split-pill is-left" id="kf-left-banner">左侧：定格原始跳切</span>
        <span class="kf-split-pill is-right" id="kf-right-banner">右侧：AI 智能武侠补帧 (60fps)</span>
      </div>

      <div class="kf-hint-toast" id="kf-hint-toast">
        💡 点击角色身上圆点或右侧芯片选中骨骼 → 直接拖拽 3D 旋转环摆出武侠定势（洋葱皮琥珀=上一帧，青色=下一帧）
      </div>

      <!-- Left Dock: Step 1 Video Keyframe Capture & Templates -->
      <aside class="kf-left-dock" aria-label="视频截取关键帧面板">
        <div class="kf-section">
          <div class="kf-sec-head">
            <span>📦 武侠定格模板快速试玩</span>
          </div>
          <select id="kf-template-select" class="kf-select" aria-label="关键帧预设模板">
            ${KEYFRAME_TEMPLATES.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}
            <option value="__blank__">+ 新建空白双帧定格台</option>
          </select>
          <div class="kf-sec-sub" id="kf-template-desc">${KEYFRAME_TEMPLATES[0].description}</div>
        </div>

        <div class="kf-section">
          <div class="kf-sec-head">
            <span>1. 视频截取关键帧 (MediaPipe)</span>
            <label class="kf-btn" for="kf-video-file-input" style="padding:2px 6px;font-size:11px;">+ 本地视频</label>
            <input type="file" id="kf-video-file-input" accept="video/*" hidden />
          </div>
          <select id="kf-video-select" class="kf-select" aria-label="参考视频选择">
            ${videoAssets
              .map(
                (v) =>
                  `<option value="${v.path}" ${
                    v.path === KEYFRAME_TEMPLATES[0].defaultVideoUrl ? 'selected' : ''
                  }>${v.label}</option>`
              )
              .join('')}
          </select>

          <div class="kf-video-box">
            <video id="kf-video-el" muted playsinline preload="auto"></video>
            <div class="kf-video-status" id="kf-video-status" hidden>正在通过 AI 识别骨骼...</div>
          </div>

          <div class="kf-row">
            <button type="button" class="kf-btn" id="kf-vid-prev" title="后退1帧 (-0.04s)">◀ -1帧</button>
            <button type="button" class="kf-btn" id="kf-vid-play" style="flex:1;">播放原片</button>
            <button type="button" class="kf-btn" id="kf-vid-next" title="前进1帧 (+0.04s)">+1帧 ▶</button>
            <span class="kf-mono-val" id="kf-vid-time" style="width:52px;">0.00s</span>
          </div>
          <input type="range" id="kf-vid-scrub" min="0" max="5" step="0.02" value="0" aria-label="原视频时间轴" />

          <div class="kf-row">
            <button type="button" class="kf-btn primary" id="kf-btn-grab-add" style="flex:1;">
              📸 抓当前帧 → 新增关键帧
            </button>
            <button type="button" class="kf-btn" id="kf-btn-grab-replace" title="用视频当前画面姿态替换选中的关键帧">
              替换本帧
            </button>
          </div>
          <button type="button" class="kf-btn amber" id="kf-btn-auto-extract">
            ⚡ AI 自动抽取视频极值关键帧 (5帧)
          </button>
        </div>
      </aside>

      <!-- Right Dock: Step 2 Puppet Bone Editor + Step 3 AI In-Betweener -->
      <aside class="kf-right-dock" aria-label="骨骼定格调整与AI补帧面板">
        <div class="kf-section">
          <div class="kf-sec-head">
            <span>2. 定格木偶骨骼精调</span>
            <span class="kf-mono-val" id="kf-selected-bone-lbl" style="color:#fbbf24;">右大臂</span>
          </div>
          <div class="kf-row">
            <button type="button" class="kf-btn active" id="kf-gizmo-rot" style="flex:1;padding:4px 5px;">🔄 旋转(R)</button>
            <button type="button" class="kf-btn" id="kf-gizmo-pos" style="flex:1;padding:4px 5px;">✥ 位移(T)</button>
            <button type="button" class="kf-btn active" id="kf-toggle-onion" style="padding:4px 6px;" title="显示前/后关键帧半透明重影">🧅 洋葱皮</button>
            <button type="button" class="kf-btn active" id="kf-toggle-sword" style="padding:4px 6px;" title="切换右手长剑">🗡 佩剑</button>
          </div>

          <div class="kf-bone-grid" id="kf-bone-grid">
            ${EDITABLE_BONE_GROUPS.map(
              (b) =>
                `<button type="button" class="kf-bone-chip ${
                  b.idx === st.selectedBoneIdx ? 'active' : ''
                }" data-bone-idx="${b.idx}">${b.shortLabel}</button>`
            ).join('')}
          </div>

          <div class="kf-slider-row">
            <span>俯仰 X°</span>
            <input type="range" id="kf-rot-x" min="-180" max="180" step="0.5" value="0" />
            <span class="kf-mono-val" id="kf-rot-x-val">0.0°</span>
          </div>
          <div class="kf-slider-row">
            <span>偏航 Y°</span>
            <input type="range" id="kf-rot-y" min="-180" max="180" step="0.5" value="0" />
            <span class="kf-mono-val" id="kf-rot-y-val">0.0°</span>
          </div>
          <div class="kf-slider-row">
            <span>翻滚 Z°</span>
            <input type="range" id="kf-rot-z" min="-180" max="180" step="0.5" value="0" />
            <span class="kf-mono-val" id="kf-rot-z-val">0.0°</span>
          </div>

          <div class="kf-slider-row">
            <span>重心高 Y</span>
            <input type="range" id="kf-root-y" min="0.45" max="1.65" step="0.01" value="0.94" />
            <span class="kf-mono-val" id="kf-root-y-val">0.94m</span>
          </div>
          <div class="kf-slider-row">
            <span>前后进 Z</span>
            <input type="range" id="kf-root-z" min="-1.2" max="2.2" step="0.02" value="0" />
            <span class="kf-mono-val" id="kf-root-z-val">0.00m</span>
          </div>

          <div class="kf-row">
            <button type="button" class="kf-btn" id="kf-btn-reset-bone" style="flex:1;">重置此关节</button>
            <button type="button" class="kf-btn" id="kf-btn-snap-floor" style="flex:1;">双脚贴地</button>
            <button type="button" class="kf-btn" id="kf-btn-mirror-pose" style="flex:1;">左右镜像</button>
          </div>
        </div>

        <div class="kf-section">
          <div class="kf-sec-head">
            <span>⏱ 本关键帧过渡 & 多圈转体</span>
            <span class="kf-mono-val" id="kf-cur-card-tag">#2</span>
          </div>
          <input type="text" id="kf-pose-label-input" class="kf-input-text" placeholder="关键帧招式名称" />
          <div class="kf-slider-row">
            <span>过渡时长</span>
            <input type="range" id="kf-seg-dur" min="0.10" max="1.40" step="0.02" value="0.38" />
            <span class="kf-mono-val" id="kf-seg-dur-val">0.38s</span>
          </div>
          <div class="kf-slider-row">
            <span>定格顿帧</span>
            <input type="range" id="kf-seg-hold" min="0" max="0.28" step="0.02" value="0" />
            <span class="kf-mono-val" id="kf-seg-hold-val">0.00s</span>
          </div>
          <div class="kf-row">
            <span style="font-size:11.5px;color:var(--text-secondary);width:58px;">旋身圈数</span>
            <select id="kf-seg-spin" class="kf-select" style="flex:1;">
              <option value="-2">↺ 逆旋 2 圈 (-720°)</option>
              <option value="-1">↺ 逆旋 1 圈 (-360°)</option>
              <option value="0" selected>不额外转圈 (最短弧)</option>
              <option value="1">↻ 顺旋 1 圈 (+360°)</option>
              <option value="2">↻ 顺旋 2 圈 (+720°)</option>
            </select>
          </div>
          <div class="kf-row">
            <span style="font-size:11.5px;color:var(--text-secondary);width:58px;">发力节奏</span>
            <select id="kf-seg-easing" class="kf-select" style="flex:1;">
              <option value="wuxia_snap">武侠寸劲爆发</option>
              <option value="charge_slash">慢蓄力 → 极速闪斩</option>
              <option value="smooth">行云流水高阶平滑</option>
              <option value="linear">匀速线性过渡</option>
            </select>
          </div>
        </div>

        <div class="kf-section">
          <div class="kf-sec-head">
            <span>3. AI 智能补帧 & 流畅度验证</span>
            <span class="kf-grade-pill grade-S" id="kf-grade-pill">S级 · 行云流水</span>
          </div>
          <select id="kf-inbetween-mode" class="kf-select" aria-label="补帧算法模式">
            <option value="ai_smart" selected>✨ AI 武侠智能补帧 (Squad样条+动力链+双骨锁脚IK)</option>
            <option value="linear">📐 普通线性补帧 (Slerp 对照)</option>
            <option value="stepped">🎞 纯定格跳切 (无补帧对照)</option>
          </select>
          <div class="kf-slider-row">
            <span>动力链鞭打</span>
            <input type="range" id="kf-opt-lag" min="0" max="1.3" step="0.05" value="0.85" />
            <span class="kf-mono-val" id="kf-opt-lag-val">85%</span>
          </div>
          <div class="kf-slider-row">
            <span>锁脚IK权重</span>
            <input type="range" id="kf-opt-ik" min="0" max="1" step="0.05" value="0.88" />
            <span class="kf-mono-val" id="kf-opt-ik-val">88%</span>
          </div>

          <div class="kf-metrics-grid">
            <div class="kf-metric-cell">
              <span class="kf-metric-lbl">总帧数 (60fps)</span>
              <span class="kf-metric-num" id="kf-met-frames">124f · 2.05s</span>
            </div>
            <div class="kf-metric-cell">
              <span class="kf-metric-lbl">单帧最大跳变</span>
              <span class="kf-metric-num" id="kf-met-jump">14.2°</span>
            </div>
            <div class="kf-metric-cell">
              <span class="kf-metric-lbl">滑步 RMS</span>
              <span class="kf-metric-num" id="kf-met-slip">2.4 cm/s</span>
            </div>
          </div>

          <div class="kf-row">
            <button type="button" class="kf-btn primary" id="kf-btn-send-workbench" style="flex:1;">
              🛠 送入工作台精调
            </button>
            <button type="button" class="kf-btn" id="kf-btn-export-bvh">📤 导出 .BVH</button>
          </div>
        </div>
      </aside>

      <!-- Bottom Rail: Step 4 Stop-Motion Keyframe Filmstrip & Playback Verification -->
      <section class="kf-bottom-rail" aria-label="定格关键帧时间轴与播放验证">
        <div class="kf-filmstrip-row" id="kf-filmstrip-row"></div>
        <div class="kf-playback-row">
          <button type="button" class="kf-btn primary" id="kf-btn-play-toggle" style="min-width:88px;">
            ▶ 播放验证
          </button>
          <button type="button" class="kf-btn" id="kf-btn-speed">1.0x</button>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--text-secondary);cursor:pointer;">
            <input type="checkbox" id="kf-chk-loop" checked /> 循环
          </label>
          <div class="kf-scrubber-wrap">
            <input type="range" id="kf-timeline-scrub" min="0" max="120" step="1" value="0" aria-label="补帧动画进度条" />
          </div>
          <span class="kf-mono-val" id="kf-frame-readout" style="width:94px;">001 / 120f</span>
          <button type="button" class="kf-btn" id="kf-btn-dup-kf" title="在当前关键帧后插入副本">+ 复制插入帧</button>
          <button type="button" class="kf-btn" id="kf-btn-del-kf" title="删除当前选中的关键帧">🗑 删除帧</button>
        </div>
      </section>
    `;

    const q = (sel) => hostEl.querySelector(sel);
    dom.canvasWrap = q('#kf-canvas-wrap');
    dom.viewBtns = Array.from(hostEl.querySelectorAll('[data-kf-view]'));
    dom.compareBvhSelect = q('#kf-compare-bvh-select');
    dom.splitBanners = q('#kf-split-banners');
    dom.leftBanner = q('#kf-left-banner');
    dom.rightBanner = q('#kf-right-banner');
    dom.hintToast = q('#kf-hint-toast');

    dom.templateSelect = q('#kf-template-select');
    dom.templateDesc = q('#kf-template-desc');
    dom.videoFileInput = q('#kf-video-file-input');
    dom.videoSelect = q('#kf-video-select');
    dom.videoEl = q('#kf-video-el');
    dom.videoStatus = q('#kf-video-status');
    dom.vidPrev = q('#kf-vid-prev');
    dom.vidPlay = q('#kf-vid-play');
    dom.vidNext = q('#kf-vid-next');
    dom.vidTime = q('#kf-vid-time');
    dom.vidScrub = q('#kf-vid-scrub');
    dom.btnGrabAdd = q('#kf-btn-grab-add');
    dom.btnGrabReplace = q('#kf-btn-grab-replace');
    dom.btnAutoExtract = q('#kf-btn-auto-extract');

    dom.selectedBoneLbl = q('#kf-selected-bone-lbl');
    dom.gizmoRot = q('#kf-gizmo-rot');
    dom.gizmoPos = q('#kf-gizmo-pos');
    dom.toggleOnion = q('#kf-toggle-onion');
    dom.toggleSword = q('#kf-toggle-sword');
    dom.boneChips = Array.from(hostEl.querySelectorAll('[data-bone-idx]'));
    dom.rotX = q('#kf-rot-x');
    dom.rotY = q('#kf-rot-y');
    dom.rotZ = q('#kf-rot-z');
    dom.rotXVal = q('#kf-rot-x-val');
    dom.rotYVal = q('#kf-rot-y-val');
    dom.rotZVal = q('#kf-rot-z-val');
    dom.rootY = q('#kf-root-y');
    dom.rootZ = q('#kf-root-z');
    dom.rootYVal = q('#kf-root-y-val');
    dom.rootZVal = q('#kf-root-z-val');
    dom.btnResetBone = q('#kf-btn-reset-bone');
    dom.btnSnapFloor = q('#kf-btn-snap-floor');
    dom.btnMirrorPose = q('#kf-btn-mirror-pose');

    dom.curCardTag = q('#kf-cur-card-tag');
    dom.poseLabelInput = q('#kf-pose-label-input');
    dom.segDur = q('#kf-seg-dur');
    dom.segDurVal = q('#kf-seg-dur-val');
    dom.segHold = q('#kf-seg-hold');
    dom.segHoldVal = q('#kf-seg-hold-val');
    dom.segSpin = q('#kf-seg-spin');
    dom.segEasing = q('#kf-seg-easing');

    dom.inbetweenMode = q('#kf-inbetween-mode');
    dom.optLag = q('#kf-opt-lag');
    dom.optLagVal = q('#kf-opt-lag-val');
    dom.optIk = q('#kf-opt-ik');
    dom.optIkVal = q('#kf-opt-ik-val');
    dom.gradePill = q('#kf-grade-pill');
    dom.metFrames = q('#kf-met-frames');
    dom.metJump = q('#kf-met-jump');
    dom.metSlip = q('#kf-met-slip');
    dom.btnSendWorkbench = q('#kf-btn-send-workbench');
    dom.btnExportBvh = q('#kf-btn-export-bvh');

    dom.filmstripRow = q('#kf-filmstrip-row');
    dom.btnPlayToggle = q('#kf-btn-play-toggle');
    dom.btnSpeed = q('#kf-btn-speed');
    dom.chkLoop = q('#kf-chk-loop');
    dom.timelineScrub = q('#kf-timeline-scrub');
    dom.frameReadout = q('#kf-frame-readout');
    dom.btnDupKf = q('#kf-btn-dup-kf');
    dom.btnDelKf = q('#kf-btn-del-kf');
  }

  function buildThreeStage() {
    const w = Math.max(1, dom.canvasWrap.clientWidth || window.innerWidth);
    const h = Math.max(1, dom.canvasWrap.clientHeight || window.innerHeight);
    const softwareGpu = detectSoftwareGpu();

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x101319, 0.068);

    camera = new THREE.PerspectiveCamera(38, w / h, 0.08, 40);
    camera.position.set(1.35, 1.38, 3.45);

    renderer = new THREE.WebGLRenderer({
      antialias: !softwareGpu,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(softwareGpu ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = !softwareGpu;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    dom.canvasWrap.appendChild(renderer.domElement);

    orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.08;
    orbitControls.target.set(0, 0.96, 0.2);
    orbitControls.minDistance = 0.85;
    orbitControls.maxDistance = 9.5;
    orbitControls.maxPolarAngle = Math.PI * 0.495;

    // Studio lighting + floor grid
    scene.add(new THREE.HemisphereLight(0xd5e2f2, 0x222730, 1.0));
    const keyLight = new THREE.DirectionalLight(0xfff4e6, 2.2);
    keyLight.position.set(2.8, 4.6, 3.3);
    keyLight.castShadow = !softwareGpu;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x5eead4, 1.0);
    rimLight.position.set(-2.6, 2.4, -2.8);
    scene.add(rimLight);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(7.5, 64).rotateX(-Math.PI * 0.5),
      new THREE.MeshStandardMaterial({ color: 0x15181f, roughness: 0.9, metalness: 0.05 })
    );
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(5.6, 14, 0x2c3646, 0x1e2530);
    grid.position.y = 0.002;
    scene.add(grid);

    // +Z Forward Direction Indicator Arrow on Floor
    const dirArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0.01, -0.35),
      0.85,
      0x10b981,
      0.14,
      0.08
    );
    scene.add(dirArrow);

    // Main Editable / AI-Inbetweened Character
    mainChar = buildCharacterRig();
    scene.add(mainChar.rootGroup);
    mainCloth = new SpringClothSolver();
    mainCloth.reset(mainChar.bones);

    // Left Comparison Character (used in compare_stepped & compare_bvh)
    leftCompareChar = buildCharacterRig();
    leftCompareChar.rootGroup.visible = false;
    scene.add(leftCompareChar.rootGroup);
    leftCloth = new SpringClothSolver();
    leftCloth.reset(leftCompareChar.bones);

    // Onion-Skin Ghosts (Prev = Warm Amber, Next = Cool Cyan)
    prevGhost = createRawGhostVisualizer();
    prevGhost.group.children.forEach((ch) => {
      if (ch.material) {
        ch.material = ch.material.clone();
        ch.material.color.setHex(0xf59e0b);
        ch.material.opacity = 0.44;
      }
    });
    scene.add(prevGhost.group);

    nextGhost = createRawGhostVisualizer();
    nextGhost.group.children.forEach((ch) => {
      if (ch.material) {
        ch.material = ch.material.clone();
        ch.material.color.setHex(0x38bdf8);
        ch.material.opacity = 0.44;
      }
    });
    scene.add(nextGhost.group);

    // 3D Sword / Hand Trajectory Arc Curve
    const arcGeo = new THREE.BufferGeometry();
    arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(600 * 3), 3));
    arcGeo.setDrawRange(0, 0);
    arcLine = new THREE.Line(
      arcGeo,
      new THREE.LineBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.72 })
    );
    arcLine.frustumCulled = false;
    scene.add(arcLine);

    // Sword Slash Ribbon Trail during 60fps Playback
    const maxTrail = 18;
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxTrail * 2 * 3), 3));
    const trailIndices = [];
    for (let i = 0; i < maxTrail - 1; i++) {
      const a = i * 2;
      trailIndices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    trailGeo.setIndex(trailIndices);
    trailGeo.setDrawRange(0, 0);
    trailMesh = new THREE.Mesh(
      trailGeo,
      new THREE.MeshBasicMaterial({
        color: 0x5eead4,
        transparent: true,
        opacity: 0.36,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    trailMesh.frustumCulled = false;
    scene.add(trailMesh);

    // 3D Joint Picker Spheres (Stop-Motion Puppet Pins)
    jointHandlesGroup = new THREE.Group();
    const pinGeo = new THREE.SphereGeometry(0.028, 12, 12);
    jointHandleMeshes = EDITABLE_BONE_GROUPS.map((info) => {
      const baseHex =
        info.group === 'core'
          ? 0x34d399
          : info.group === 'rightArm'
            ? 0xfbbf24
            : info.group === 'leftArm'
              ? 0x38bdf8
              : 0xa78bfa;
      const mat = new THREE.MeshBasicMaterial({
        color: baseHex,
        transparent: true,
        opacity: 0.88,
        depthTest: false,
      });
      const m = new THREE.Mesh(pinGeo, mat);
      m.renderOrder = 12;
      m.userData = { boneIdx: info.idx, baseHex };
      jointHandlesGroup.add(m);
      return m;
    });
    scene.add(jointHandlesGroup);

    // Three.js TransformControls for Direct 3D Bone Rotation / Root Translation
    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setSize(0.72);
    transformControls.setMode('rotate');
    transformControls.setSpace('local');
    transformHelper = transformControls.getHelper ? transformControls.getHelper() : transformControls;
    scene.add(transformHelper);

    transformControls.addEventListener('dragging-changed', (event) => {
      if (orbitControls) orbitControls.enabled = !event.value;
    });

    transformControls.addEventListener('objectChange', () => {
      if (st.viewMode !== 'pose_edit' || st.playing) return;
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      if (st.gizmoMode === 'translate') {
        kf.rootPos.copy(mainChar.bones[0].position);
        kf.rootPos.y = THREE.MathUtils.clamp(kf.rootPos.y, 0.38, 2.1);
      } else {
        const b = st.selectedBoneIdx;
        kf.quats[b].copy(mainChar.bones[b].quaternion).normalize();
      }
      rebuildSynthesis({ skipPoseSync: false });
      syncInspectorSlidersFromActivePose();
    });

    // Raycast click on 3D joint pins to select bone like a stop-motion armature
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let downXY = null;

    renderer.domElement.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      downXY = [ev.clientX, ev.clientY];
    });

    renderer.domElement.addEventListener('pointerup', (ev) => {
      if (!downXY || st.viewMode !== 'pose_edit' || st.playing) return;
      const moved = Math.hypot(ev.clientX - downXY[0], ev.clientY - downXY[1]);
      downXY = null;
      if (moved > 5 || transformControls?.dragging) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointerNdc.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      pointerNdc.y = -((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);
      const hits = raycaster.intersectObjects(jointHandleMeshes, false);
      if (hits.length > 0) {
        selectBone(hits[0].object.userData.boneIdx);
      }
    });
  }

  function applyPoseToRig(rig, rootPos, quats, offsetX = 0) {
    rig.bones[0].position.set(rootPos.x + offsetX, rootPos.y, rootPos.z);
    for (let b = 0; b < NUM_BONES; b++) {
      if (quats[b]) rig.bones[b].quaternion.copy(quats[b]);
    }
    applyForearmTwistSolver(rig.bones, true, 0.58);
    rig.bones[0].updateWorldMatrix(true, true);
  }

  function updateJointPinPositions() {
    if (!jointHandlesGroup || !mainChar) return;
    const showPins = st.viewMode === 'pose_edit' && !st.playing;
    jointHandlesGroup.visible = showPins;
    if (!showPins) return;

    const tmp = new THREE.Vector3();
    for (const m of jointHandleMeshes) {
      const bIdx = m.userData.boneIdx;
      mainChar.bones[bIdx].getWorldPosition(tmp);
      m.position.copy(tmp);
      const isSel = bIdx === st.selectedBoneIdx;
      m.scale.setScalar(isSel ? 1.48 : 1.0);
      m.material.color.setHex(isSel ? 0xffffff : m.userData.baseHex);
    }
  }

  function syncGizmoAttachment() {
    if (!transformControls || !mainChar) return;
    const enableGizmo = active && st.viewMode === 'pose_edit' && !st.playing;
    transformControls.enabled = enableGizmo;
    if (transformHelper) transformHelper.visible = enableGizmo;
    if (!enableGizmo) {
      transformControls.detach();
      return;
    }

    if (st.gizmoMode === 'translate') {
      transformControls.setMode('translate');
      transformControls.setSpace('world');
      transformControls.attach(mainChar.bones[0]);
    } else {
      transformControls.setMode('rotate');
      transformControls.setSpace('local');
      transformControls.attach(mainChar.bones[st.selectedBoneIdx]);
    }
  }

  function updateMotionArcGeometry() {
    if (!arcLine || !mainChar) return;
    const frames = synthResult?.cleanFrames || [];
    const show = st.showArc && st.viewMode === 'pose_edit' && frames.length >= 2;
    arcLine.visible = show;
    if (!show) return;

    const posAttr = arcLine.geometry.attributes.position;
    const maxPts = Math.min(600, frames.length);
    const { bones } = createRawGhostVisualizer();
    const tmp = new THREE.Vector3();
    const qW = new THREE.Quaternion();
    const bladeLocal = new THREE.Vector3(-0.619, 0.754, 0.219).normalize();

    for (let i = 0; i < maxPts; i++) {
      const fIdx = Math.min(frames.length - 1, Math.round((i / Math.max(1, maxPts - 1)) * (frames.length - 1)));
      const fr = frames[fIdx];
      bones[0].position.copy(fr.rootPos);
      for (let b = 0; b < NUM_BONES; b++) bones[b].quaternion.copy(fr.quats[b]);
      bones[0].updateWorldMatrix(true, true);

      if (st.inbetweenOpts.hasWeapon) {
        bones[BONE_IDX.RightHand].getWorldPosition(tmp);
        bones[BONE_IDX.RightHand].getWorldQuaternion(qW);
        tmp.addScaledVector(bladeLocal.clone().applyQuaternion(qW), 0.95);
      } else {
        bones[BONE_IDX.RightFoot].getWorldPosition(tmp);
      }
      posAttr.setXYZ(i, tmp.x, tmp.y, tmp.z);
    }
    posAttr.needsUpdate = true;
    arcLine.geometry.setDrawRange(0, maxPts);
  }

  function updateOnionSkins() {
    if (!prevGhost || !nextGhost) return;
    const show = st.onionSkin && st.viewMode === 'pose_edit' && !st.playing;
    const hasPrev = show && st.activeKfIdx > 0;
    const hasNext = show && st.activeKfIdx < st.keyframes.length - 1;

    prevGhost.group.visible = hasPrev;
    nextGhost.group.visible = hasNext;

    if (hasPrev) {
      const kp = st.keyframes[st.activeKfIdx - 1];
      prevGhost.bones[0].position.copy(kp.rootPos);
      for (let b = 0; b < NUM_BONES; b++) prevGhost.bones[b].quaternion.copy(kp.quats[b]);
      prevGhost.updateVisuals();
    }
    if (hasNext) {
      const kn = st.keyframes[st.activeKfIdx + 1];
      nextGhost.bones[0].position.copy(kn.rootPos);
      for (let b = 0; b < NUM_BONES; b++) nextGhost.bones[b].quaternion.copy(kn.quats[b]);
      nextGhost.updateVisuals();
    }
  }

  function rebuildSynthesis(opts = {}) {
    synthResult = synthesizeKeyframeClip(st.keyframes, st.inbetweenOpts);
    const total = Math.max(1, synthResult.cleanFrames.length);
    dom.timelineScrub.max = String(Math.max(1, total - 1));

    // Sync metrics card
    const m = synthResult.metrics;
    dom.metFrames.textContent = `${m.totalFrames}f · ${m.durationSec}s`;
    dom.metJump.textContent = `${m.maxJumpDeg}°`;
    dom.metSlip.textContent = `${m.slipRmsCmS} cm/s`;
    dom.gradePill.textContent = m.gradeLabel;
    dom.gradePill.className = `kf-grade-pill grade-${m.grade}`;

    renderFilmstrip();

    if (!opts.skipPoseSync && st.viewMode === 'pose_edit' && !st.playing) {
      const kf = st.keyframes[st.activeKfIdx];
      if (kf && mainChar) {
        applyPoseToRig(mainChar, kf.rootPos, kf.quats, 0);
        mainCloth.reset(mainChar.bones);
        updateJointPinPositions();
        syncGizmoAttachment();
      }
    }
    updateOnionSkins();
    updateMotionArcGeometry();
    updateFrameReadout();
  }

  function syncInspectorSlidersFromActivePose() {
    const kf = st.keyframes[st.activeKfIdx];
    if (!kf) return;
    const boneInfo = EDITABLE_BONE_GROUPS.find((x) => x.idx === st.selectedBoneIdx);
    dom.selectedBoneLbl.textContent = boneInfo ? boneInfo.shortLabel : BONE_DEFS[st.selectedBoneIdx].name;
    dom.boneChips.forEach((chip) => {
      chip.classList.toggle('active', Number(chip.dataset.boneIdx) === st.selectedBoneIdx);
    });

    const eul = getBoneLocalEulerDeg(kf, st.selectedBoneIdx);
    dom.rotX.value = String(eul.x);
    dom.rotY.value = String(eul.y);
    dom.rotZ.value = String(eul.z);
    dom.rotXVal.textContent = `${eul.x.toFixed(1)}°`;
    dom.rotYVal.textContent = `${eul.y.toFixed(1)}°`;
    dom.rotZVal.textContent = `${eul.z.toFixed(1)}°`;

    dom.rootY.value = String(kf.rootPos.y.toFixed(2));
    dom.rootZ.value = String(kf.rootPos.z.toFixed(2));
    dom.rootYVal.textContent = `${kf.rootPos.y.toFixed(2)}m`;
    dom.rootZVal.textContent = `${kf.rootPos.z.toFixed(2)}m`;

    dom.curCardTag.textContent = `#${st.activeKfIdx + 1} / ${st.keyframes.length}`;
    dom.poseLabelInput.value = kf.label;
    dom.segDur.value = String(kf.durationToNext);
    dom.segDurVal.textContent = `${kf.durationToNext.toFixed(2)}s`;
    dom.segHold.value = String(kf.holdSec);
    dom.segHoldVal.textContent = `${kf.holdSec.toFixed(2)}s`;
    dom.segSpin.value = String(kf.spinTurns || 0);
    dom.segEasing.value = kf.easing || 'wuxia_snap';
  }

  function renderFilmstrip() {
    dom.filmstripRow.innerHTML = '';
    st.keyframes.forEach((kf, idx) => {
      const card = document.createElement('div');
      card.className = `kf-card ${idx === st.activeKfIdx ? 'active' : ''}`;
      card.dataset.kfIndex = String(idx);

      const spinBadge =
        kf.spinTurns && idx < st.keyframes.length - 1
          ? `<span class="kf-card-spin">${kf.spinTurns > 0 ? '↻+' : '↺'}${kf.spinTurns}圈</span>`
          : kf.sourceTimeSec !== null
            ? `<span class="kf-card-dur">${kf.sourceTimeSec.toFixed(2)}s</span>`
            : '';

      card.innerHTML = `
        ${kf.thumbnailDataUrl ? `<img class="kf-card-thumb" src="${kf.thumbnailDataUrl}" alt="" />` : ''}
        <div class="kf-card-top">
          <span class="kf-card-idx">#${idx + 1}</span>
          ${spinBadge}
        </div>
        <div class="kf-card-title">${kf.label}</div>
        <div class="kf-card-btm">
          <span class="kf-card-dur">${
            idx < st.keyframes.length - 1 ? `过渡 ${kf.durationToNext.toFixed(2)}s` : '收势终点'
          }</span>
          ${kf.holdSec > 0 ? `<span class="kf-card-dur">顿${Math.round(kf.holdSec * 60)}f</span>` : ''}
        </div>
      `;

      card.addEventListener('click', () => {
        selectKeyframe(idx, { enterPoseEdit: true });
      });
      dom.filmstripRow.appendChild(card);

      if (idx < st.keyframes.length - 1) {
        const conn = document.createElement('span');
        conn.className = 'kf-connector';
        conn.textContent = `──${kf.durationToNext.toFixed(2)}s──▶`;
        dom.filmstripRow.appendChild(conn);
      }
    });
  }

  function selectKeyframe(idx, opts = {}) {
    if (!st.keyframes.length) return;
    st.activeKfIdx = THREE.MathUtils.clamp(idx, 0, st.keyframes.length - 1);
    const kfFrame = synthResult.keyframeFrameIndices[st.activeKfIdx] || 0;
    const maxF = Math.max(1, synthResult.cleanFrames.length - 1);
    st.normalizedTime = THREE.MathUtils.clamp(kfFrame / maxF, 0, 1);
    dom.timelineScrub.value = String(kfFrame);

    if (opts.enterPoseEdit) {
      st.playing = false;
      dom.btnPlayToggle.textContent = '▶ 播放验证';
      setViewMode('pose_edit');
    }

    const kf = st.keyframes[st.activeKfIdx];
    if (kf && mainChar && st.viewMode === 'pose_edit') {
      applyPoseToRig(mainChar, kf.rootPos, kf.quats, 0);
      mainCloth.reset(mainChar.bones);
    }
    syncInspectorSlidersFromActivePose();
    renderFilmstrip();
    updateJointPinPositions();
    syncGizmoAttachment();
    updateOnionSkins();
    updateFrameReadout();
  }

  function selectBone(boneIdx) {
    st.selectedBoneIdx = THREE.MathUtils.clamp(Number(boneIdx) || 0, 0, NUM_BONES - 1);
    syncInspectorSlidersFromActivePose();
    updateJointPinPositions();
    syncGizmoAttachment();
  }

  async function ensureCompareClipLoaded(assetId) {
    if (!assetId) return null;
    if (compareClipCache.has(assetId)) {
      compareClip = compareClipCache.get(assetId);
      return compareClip;
    }
    const item = findAssetInCatalog(STATIC_ASSET_CATALOG, assetId);
    if (!item || !item.path) return null;
    try {
      const resp = await fetch(encodeURI(item.path));
      if (!resp.ok) return null;
      const text = await resp.text();
      if (!text.includes('HIERARCHY')) return null;
      const parsed = parseBVHTextToClip(text, item.path.split('/').pop(), {
        preserveRootMotion: true,
        hasWeapon: item.hasWeapon,
      });
      compareClipCache.set(assetId, parsed);
      compareClip = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  function setViewMode(mode) {
    if (!['pose_edit', 'play_ai', 'compare_stepped', 'compare_bvh'].includes(mode)) return;
    st.viewMode = mode;
    dom.viewBtns.forEach((b) => b.classList.toggle('active', b.dataset.kfView === mode));

    const isSplit = mode === 'compare_stepped' || mode === 'compare_bvh';
    dom.splitBanners.hidden = !isSplit;
    dom.hintToast.hidden = mode !== 'pose_edit';

    if (mode === 'compare_stepped') {
      dom.leftBanner.textContent = '左侧：纯定格跳切 (无补帧)';
      dom.rightBanner.textContent = '右侧：AI 武侠智能补帧 (60fps)';
    } else if (mode === 'compare_bvh') {
      const item = findAssetInCatalog(STATIC_ASSET_CATALOG, st.compareAssetId);
      dom.leftBanner.textContent = `左侧参照：${item ? item.label.split(' (')[0] : '原视频直出动作'}`;
      dom.rightBanner.textContent = '右侧：关键帧定格 + AI 智能补帧';
      ensureCompareClipLoaded(st.compareAssetId);
    }

    if (leftCompareChar && mainChar) {
      leftCompareChar.rootGroup.visible = isSplit;
      leftCompareChar.swordGroup.visible =
        mode === 'compare_bvh'
          ? Boolean(compareClip?.hasWeapon ?? st.inbetweenOpts.hasWeapon)
          : Boolean(st.inbetweenOpts.hasWeapon);
      mainChar.swordGroup.visible = Boolean(st.inbetweenOpts.hasWeapon);
      if (!isSplit) {
        mainChar.rootGroup.position.x = 0;
      }
    }

    if (camera && orbitControls) {
      if (isSplit) {
        camera.position.set(0, 1.42, 4.55);
        orbitControls.target.set(0, 0.94, 0.25);
      } else {
        camera.position.set(1.35, 1.38, 3.45);
        orbitControls.target.set(0, 0.96, 0.2);
      }
      orbitControls.update();
    }

    if (mode === 'pose_edit') {
      st.playing = false;
      dom.btnPlayToggle.textContent = '▶ 播放验证';
      trailHistory.length = 0;
      if (trailMesh) trailMesh.geometry.setDrawRange(0, 0);
      const kf = st.keyframes[st.activeKfIdx];
      if (kf && mainChar) {
        applyPoseToRig(mainChar, kf.rootPos, kf.quats, 0);
      }
    } else if (!st.playing && mode !== 'pose_edit') {
      // Auto-start playback when user clicks a preview/comparison mode tab!
      st.playing = true;
      dom.btnPlayToggle.textContent = '⏸ 暂停播放';
    }

    updateJointPinPositions();
    syncGizmoAttachment();
    updateOnionSkins();
    updateMotionArcGeometry();
  }

  function updateFrameReadout() {
    const total = Math.max(1, synthResult.cleanFrames.length);
    const cur = Math.min(total, Math.round(st.normalizedTime * Math.max(1, total - 1)) + 1);
    dom.frameReadout.textContent = `${String(cur).padStart(3, '0')} / ${total}f`;
  }

  function updateSwordTrail(rig, hasWeapon, playingNow) {
    if (!trailMesh) return;
    if (!hasWeapon || !playingNow || st.viewMode === 'pose_edit') {
      trailHistory.length = 0;
      trailMesh.geometry.setDrawRange(0, 0);
      return;
    }
    const anchors = rig.swordGroup?.userData;
    if (!anchors?.tipAnchor || !anchors?.baseAnchor) return;
    const tip = new THREE.Vector3();
    const base = new THREE.Vector3();
    anchors.tipAnchor.getWorldPosition(tip);
    anchors.baseAnchor.getWorldPosition(base);

    trailHistory.unshift({ tip, base });
    if (trailHistory.length > 18) trailHistory.pop();
    if (trailHistory.length < 2) {
      trailMesh.geometry.setDrawRange(0, 0);
      return;
    }

    const pos = trailMesh.geometry.attributes.position;
    for (let i = 0; i < trailHistory.length; i++) {
      pos.setXYZ(i * 2, trailHistory[i].base.x, trailHistory[i].base.y, trailHistory[i].base.z);
      pos.setXYZ(i * 2 + 1, trailHistory[i].tip.x, trailHistory[i].tip.y, trailHistory[i].tip.z);
    }
    pos.needsUpdate = true;
    trailMesh.geometry.setDrawRange(0, (trailHistory.length - 1) * 6);
  }

  function renderFrame(dt) {
    if (!renderer || !scene || !camera || !mainChar) return;

    const cleanFrames = synthResult.cleanFrames;
    const maxIdx = Math.max(1, cleanFrames.length - 1);

    if (st.playing && st.viewMode !== 'pose_edit') {
      const dur = Math.max(0.15, synthResult.clip.duration);
      const speed = SPEEDS[st.speedIdx] || 1.0;
      st.normalizedTime += (dt * speed) / dur;
      if (st.normalizedTime >= 1) {
        if (st.loop) {
          st.normalizedTime %= 1;
          trailHistory.length = 0;
        } else {
          st.normalizedTime = 1;
          st.playing = false;
          dom.btnPlayToggle.textContent = '▶ 播放验证';
        }
      }
      dom.timelineScrub.value = String(Math.round(st.normalizedTime * maxIdx));
      updateFrameReadout();
    }

    if (st.viewMode === 'pose_edit' && !st.playing) {
      updateJointPinPositions();
    } else if (st.viewMode === 'play_ai') {
      sampleInterpolatedFrame(cleanFrames, st.normalizedTime * maxIdx, evalPoseA, true);
      applyPoseToRig(mainChar, evalPoseA.rootPos, evalPoseA.quats, 0);
      mainCloth.update(mainChar.bones, dt, st.playing, 1.0);
      updateSwordTrail(mainChar, st.inbetweenOpts.hasWeapon, st.playing);
    } else if (st.viewMode === 'compare_stepped') {
      const stepFrames = synthResult.steppedFrames;
      const stepIdx = Math.min(stepFrames.length - 1, Math.round(st.normalizedTime * Math.max(1, stepFrames.length - 1)));
      const sf = stepFrames[stepIdx];
      applyPoseToRig(leftCompareChar, sf.rootPos, sf.quats, -SPLIT_OFFSET_X);
      leftCloth.update(leftCompareChar.bones, dt, st.playing, 0.5);

      sampleInterpolatedFrame(cleanFrames, st.normalizedTime * maxIdx, evalPoseA, true);
      applyPoseToRig(mainChar, evalPoseA.rootPos, evalPoseA.quats, SPLIT_OFFSET_X);
      mainCloth.update(mainChar.bones, dt, st.playing, 1.0);
      updateSwordTrail(mainChar, st.inbetweenOpts.hasWeapon, st.playing);
    } else if (st.viewMode === 'compare_bvh') {
      if (compareClip && compareClip.frames?.length > 0) {
        const cMax = Math.max(1, compareClip.frames.length - 1);
        sampleInterpolatedFrame(compareClip.frames, st.normalizedTime * cMax, evalPoseB, true);
        applyPoseToRig(leftCompareChar, evalPoseB.rootPos, evalPoseB.quats, -SPLIT_OFFSET_X);
        leftCompareChar.swordGroup.visible = Boolean(compareClip.hasWeapon);
      } else {
        const sf = synthResult.linearFrames[Math.min(maxIdx, Math.round(st.normalizedTime * maxIdx))];
        applyPoseToRig(leftCompareChar, sf.rootPos, sf.quats, -SPLIT_OFFSET_X);
      }
      leftCloth.update(leftCompareChar.bones, dt, st.playing, 1.0);

      sampleInterpolatedFrame(cleanFrames, st.normalizedTime * maxIdx, evalPoseA, true);
      applyPoseToRig(mainChar, evalPoseA.rootPos, evalPoseA.quats, SPLIT_OFFSET_X);
      mainCloth.update(mainChar.bones, dt, st.playing, 1.0);
      updateSwordTrail(mainChar, st.inbetweenOpts.hasWeapon, st.playing);
    }

    orbitControls.update();
    renderer.render(scene, camera);
  }

  function loop(now) {
    if (!active) {
      rafId = 0;
      return;
    }
    rafId = requestAnimationFrame(loop);
    const dt = lastClock > 0 ? Math.min(0.05, (now - lastClock) / 1000) : 1 / 60;
    lastClock = now;
    renderFrame(dt);
  }

  function loadVideoSource(url) {
    if (!dom.videoEl) return;
    dom.videoEl.pause();
    dom.videoEl.src = url.startsWith('blob:') ? url : encodeURI(url);
    dom.videoEl.load();
    dom.vidPlay.textContent = '播放原片';
  }

  async function grabCurrentVideoFrameAsKeyframe(replaceCurrent = false) {
    if (st.isExtractingVideo || !dom.videoEl) return null;
    st.isExtractingVideo = true;
    dom.videoEl.pause();
    dom.vidPlay.textContent = '播放原片';
    dom.videoStatus.hidden = false;
    dom.videoStatus.textContent = '正在用 MediaPipe 识别当前画面骨骼...';

    try {
      const res = await extractPoseFromVideoElement(dom.videoEl, {
        onStatus: (msg) => {
          dom.videoStatus.textContent = msg;
        },
      });
      const basePose = res.detected
        ? { rootPos: res.rootPos, quats: res.quats }
        : st.keyframes[st.activeKfIdx]
          ? {
              rootPos: st.keyframes[st.activeKfIdx].rootPos.clone(),
              quats: st.keyframes[st.activeKfIdx].quats.map((q) => q.clone()),
            }
          : {};

      const labelText = res.detected
        ? `视频抓帧 @${res.timestampSec.toFixed(2)}s`
        : `手动定格 @${res.timestampSec.toFixed(2)}s`;

      if (replaceCurrent && st.keyframes[st.activeKfIdx]) {
        const cur = st.keyframes[st.activeKfIdx];
        cur.rootPos.copy(basePose.rootPos);
        cur.quats = basePose.quats.map((q) => q.clone());
        cur.sourceTimeSec = +res.timestampSec.toFixed(2);
        cur.thumbnailDataUrl = res.thumbnailDataUrl;
        cur.label = labelText;
        rebuildSynthesis();
        selectKeyframe(st.activeKfIdx, { enterPoseEdit: true });
        return cur;
      } else {
        const newKf = createNeutralKeyframe({
          label: labelText,
          durationToNext: 0.38,
          sourceTimeSec: +res.timestampSec.toFixed(2),
          thumbnailDataUrl: res.thumbnailDataUrl,
          rootPos: basePose.rootPos,
          quats: basePose.quats,
        });
        const insertAt = Math.min(st.keyframes.length, st.activeKfIdx + 1);
        st.keyframes.splice(insertAt, 0, newKf);
        rebuildSynthesis();
        selectKeyframe(insertAt, { enterPoseEdit: true });
        return newKf;
      }
    } finally {
      st.isExtractingVideo = false;
      dom.videoStatus.hidden = true;
    }
  }

  async function runAutoVideoSalientKeyframes(targetCount = 5) {
    if (st.isExtractingVideo || !dom.videoEl) return null;
    st.isExtractingVideo = true;
    dom.videoEl.pause();
    dom.vidPlay.textContent = '播放原片';
    dom.videoStatus.hidden = false;
    dom.videoStatus.textContent = '正在扫描视频动作极值帧...';

    try {
      const dur = Number.isFinite(dom.videoEl.duration) && dom.videoEl.duration > 0 ? dom.videoEl.duration : 5.0;
      const inSec = dur > 20 ? 26.72 : 0;
      const outSec = dur > 20 ? Math.min(dur, 31.77) : Math.min(dur, 6.2);

      const extractedList = await extractSalientKeyframesFromVideoElement(dom.videoEl, {
        trimInSec: inSec,
        trimOutSec: outSec,
        targetCount,
        sampleFps: 10,
        onStatus: (msg) => {
          dom.videoStatus.textContent = msg;
        },
        onProgress: (pct) => {
          dom.videoStatus.textContent = `AI 扫描提取关键帧 ${pct}%...`;
        },
      });

      st.keyframes = extractedList.map((item, idx) =>
        createNeutralKeyframe({
          label: `${idx + 1}. 视频极值 @${item.sourceTimeSec.toFixed(2)}s`,
          durationToNext: item.durationToNext,
          sourceTimeSec: item.sourceTimeSec,
          thumbnailDataUrl: item.thumbnailDataUrl,
          rootPos: item.rootPos,
          quats: item.quats,
        })
      );
      st.activeKfIdx = 0;
      rebuildSynthesis();
      selectKeyframe(0, { enterPoseEdit: true });
      return st.keyframes;
    } finally {
      st.isExtractingVideo = false;
      dom.videoStatus.hidden = true;
    }
  }

  function wireEvents() {
    dom.viewBtns.forEach((btn) => {
      btn.addEventListener('click', () => setViewMode(btn.dataset.kfView));
    });

    dom.compareBvhSelect.addEventListener('change', async () => {
      st.compareAssetId = dom.compareBvhSelect.value;
      await ensureCompareClipLoaded(st.compareAssetId);
      if (st.viewMode !== 'compare_bvh') {
        setViewMode('compare_bvh');
      } else {
        const item = findAssetInCatalog(STATIC_ASSET_CATALOG, st.compareAssetId);
        dom.leftBanner.textContent = `左侧参照：${item ? item.label.split(' (')[0] : '原视频直出动作'}`;
      }
    });

    dom.templateSelect.addEventListener('change', () => {
      const val = dom.templateSelect.value;
      st.templateId = val;
      if (val === '__blank__') {
        dom.templateDesc.textContent = '空白双帧定格台：可直接从下方视频抓帧插入，或手工旋转骨骼从零创作武侠招式。';
        st.keyframes = [
          snapKeyframeFeetToFloor(createNeutralKeyframe({ label: '1. 起始定势', durationToNext: 0.45 })),
          snapKeyframeFeetToFloor(
            createNeutralKeyframe({
              label: '2. 出招定势',
              durationToNext: 0.45,
              rootPos: new THREE.Vector3(0, 0.94, 0.35),
            })
          ),
        ];
      } else {
        const tpl = KEYFRAME_TEMPLATES.find((t) => t.id === val);
        if (!tpl) return;
        dom.templateDesc.textContent = tpl.description;
        st.inbetweenOpts.hasWeapon = Boolean(tpl.hasWeapon);
        dom.toggleSword.classList.toggle('active', st.inbetweenOpts.hasWeapon);
        if (mainChar) mainChar.swordGroup.visible = st.inbetweenOpts.hasWeapon;
        if (tpl.compareAssetId) {
          st.compareAssetId = tpl.compareAssetId;
          dom.compareBvhSelect.value = tpl.compareAssetId;
          ensureCompareClipLoaded(tpl.compareAssetId);
        }
        if (tpl.defaultVideoUrl) {
          dom.videoSelect.value = tpl.defaultVideoUrl;
          loadVideoSource(tpl.defaultVideoUrl);
        }
        st.keyframes = tpl.buildKeyframes();
      }
      st.activeKfIdx = 0;
      rebuildSynthesis();
      selectKeyframe(0, { enterPoseEdit: true });
    });

    // Video controls
    dom.videoSelect.addEventListener('change', () => {
      if (dom.videoSelect.value) loadVideoSource(dom.videoSelect.value);
    });

    dom.videoFileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (ownedVideoBlobUrl) URL.revokeObjectURL(ownedVideoBlobUrl);
      ownedVideoBlobUrl = URL.createObjectURL(file);
      loadVideoSource(ownedVideoBlobUrl);
    });

    dom.videoEl.addEventListener('loadedmetadata', () => {
      const d = Number.isFinite(dom.videoEl.duration) ? dom.videoEl.duration : 5;
      dom.vidScrub.max = d.toFixed(2);
      dom.vidScrub.value = '0';
      dom.vidTime.textContent = '0.00s';
    });

    dom.videoEl.addEventListener('timeupdate', () => {
      const t = dom.videoEl.currentTime || 0;
      dom.vidScrub.value = String(t);
      dom.vidTime.textContent = `${t.toFixed(2)}s`;
    });

    dom.vidScrub.addEventListener('input', () => {
      dom.videoEl.pause();
      dom.vidPlay.textContent = '播放原片';
      dom.videoEl.currentTime = Number(dom.vidScrub.value) || 0;
    });

    dom.vidPrev.addEventListener('click', () => {
      dom.videoEl.pause();
      dom.vidPlay.textContent = '播放原片';
      dom.videoEl.currentTime = Math.max(0, (dom.videoEl.currentTime || 0) - 1 / 24);
    });

    dom.vidNext.addEventListener('click', () => {
      dom.videoEl.pause();
      dom.vidPlay.textContent = '播放原片';
      const maxT = Number.isFinite(dom.videoEl.duration) ? dom.videoEl.duration - 0.01 : 10;
      dom.videoEl.currentTime = Math.min(maxT, (dom.videoEl.currentTime || 0) + 1 / 24);
    });

    dom.vidPlay.addEventListener('click', () => {
      if (dom.videoEl.paused) {
        dom.videoEl.play().catch(() => {});
        dom.vidPlay.textContent = '暂停原片';
      } else {
        dom.videoEl.pause();
        dom.vidPlay.textContent = '播放原片';
      }
    });

    dom.btnGrabAdd.addEventListener('click', () => grabCurrentVideoFrameAsKeyframe(false));
    dom.btnGrabReplace.addEventListener('click', () => grabCurrentVideoFrameAsKeyframe(true));
    dom.btnAutoExtract.addEventListener('click', () => runAutoVideoSalientKeyframes(5));

    // Puppet Bone Inspector controls
    dom.gizmoRot.addEventListener('click', () => {
      st.gizmoMode = 'rotate';
      dom.gizmoRot.classList.add('active');
      dom.gizmoPos.classList.remove('active');
      setViewMode('pose_edit');
      syncGizmoAttachment();
    });

    dom.gizmoPos.addEventListener('click', () => {
      st.gizmoMode = 'translate';
      dom.gizmoPos.classList.add('active');
      dom.gizmoRot.classList.remove('active');
      setViewMode('pose_edit');
      syncGizmoAttachment();
    });

    dom.toggleOnion.addEventListener('click', () => {
      st.onionSkin = !st.onionSkin;
      dom.toggleOnion.classList.toggle('active', st.onionSkin);
      updateOnionSkins();
    });

    dom.toggleSword.addEventListener('click', () => {
      st.inbetweenOpts.hasWeapon = !st.inbetweenOpts.hasWeapon;
      dom.toggleSword.classList.toggle('active', st.inbetweenOpts.hasWeapon);
      if (mainChar) mainChar.swordGroup.visible = st.inbetweenOpts.hasWeapon;
      rebuildSynthesis();
    });

    dom.boneChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        if (st.viewMode !== 'pose_edit') setViewMode('pose_edit');
        selectBone(Number(chip.dataset.boneIdx));
      });
    });

    const onEulerSliderInput = () => {
      if (st.viewMode !== 'pose_edit') setViewMode('pose_edit');
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      const rx = Number(dom.rotX.value) || 0;
      const ry = Number(dom.rotY.value) || 0;
      const rz = Number(dom.rotZ.value) || 0;
      setBoneLocalEulerDeg(kf, st.selectedBoneIdx, rx, ry, rz);
      dom.rotXVal.textContent = `${rx.toFixed(1)}°`;
      dom.rotYVal.textContent = `${ry.toFixed(1)}°`;
      dom.rotZVal.textContent = `${rz.toFixed(1)}°`;
      rebuildSynthesis();
    };
    dom.rotX.addEventListener('input', onEulerSliderInput);
    dom.rotY.addEventListener('input', onEulerSliderInput);
    dom.rotZ.addEventListener('input', onEulerSliderInput);

    const onRootSliderInput = () => {
      if (st.viewMode !== 'pose_edit') setViewMode('pose_edit');
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      kf.rootPos.y = Number(dom.rootY.value) || 0.94;
      kf.rootPos.z = Number(dom.rootZ.value) || 0;
      dom.rootYVal.textContent = `${kf.rootPos.y.toFixed(2)}m`;
      dom.rootZVal.textContent = `${kf.rootPos.z.toFixed(2)}m`;
      rebuildSynthesis();
    };
    dom.rootY.addEventListener('input', onRootSliderInput);
    dom.rootZ.addEventListener('input', onRootSliderInput);

    dom.btnResetBone.addEventListener('click', () => {
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      kf.quats[st.selectedBoneIdx].identity();
      syncInspectorSlidersFromActivePose();
      rebuildSynthesis();
    });

    dom.btnSnapFloor.addEventListener('click', () => {
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      snapKeyframeFeetToFloor(kf, 0.08);
      syncInspectorSlidersFromActivePose();
      rebuildSynthesis();
    });

    dom.btnMirrorPose.addEventListener('click', () => {
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      mirrorKeyframePoseLR(kf);
      syncInspectorSlidersFromActivePose();
      rebuildSynthesis();
    });

    // Keyframe segment metadata
    dom.poseLabelInput.addEventListener('input', () => {
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      kf.label = dom.poseLabelInput.value || `关键帧 #${st.activeKfIdx + 1}`;
      renderFilmstrip();
    });

    dom.segDur.addEventListener('input', () => {
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      kf.durationToNext = Number(dom.segDur.value) || 0.38;
      dom.segDurVal.textContent = `${kf.durationToNext.toFixed(2)}s`;
      rebuildSynthesis();
    });

    dom.segHold.addEventListener('input', () => {
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      kf.holdSec = Number(dom.segHold.value) || 0;
      dom.segHoldVal.textContent = `${kf.holdSec.toFixed(2)}s`;
      rebuildSynthesis();
    });

    dom.segSpin.addEventListener('change', () => {
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      kf.spinTurns = Number.parseInt(dom.segSpin.value, 10) || 0;
      rebuildSynthesis();
    });

    dom.segEasing.addEventListener('change', () => {
      const kf = st.keyframes[st.activeKfIdx];
      if (!kf) return;
      kf.easing = dom.segEasing.value;
      rebuildSynthesis();
    });

    // AI In-betweener options
    dom.inbetweenMode.addEventListener('change', () => {
      st.inbetweenOpts.mode = dom.inbetweenMode.value;
      rebuildSynthesis();
    });

    dom.optLag.addEventListener('input', () => {
      st.inbetweenOpts.kineticChainLag = Number(dom.optLag.value) || 0;
      dom.optLagVal.textContent = `${Math.round(st.inbetweenOpts.kineticChainLag * 100)}%`;
      rebuildSynthesis();
    });

    dom.optIk.addEventListener('input', () => {
      st.inbetweenOpts.ikFootLock = Number(dom.optIk.value) || 0;
      dom.optIkVal.textContent = `${Math.round(st.inbetweenOpts.ikFootLock * 100)}%`;
      rebuildSynthesis();
    });

    dom.btnExportBvh.addEventListener('click', () => {
      exportBVH({ triggerDownload: true });
    });

    dom.btnSendWorkbench.addEventListener('click', () => {
      sendToWorkbench();
    });

    // Bottom Playback & Filmstrip actions
    dom.btnPlayToggle.addEventListener('click', () => {
      togglePlay();
    });

    dom.btnSpeed.addEventListener('click', () => {
      st.speedIdx = (st.speedIdx + 1) % SPEEDS.length;
      dom.btnSpeed.textContent = `${SPEEDS[st.speedIdx]}x`;
    });

    dom.chkLoop.addEventListener('change', () => {
      st.loop = dom.chkLoop.checked;
    });

    dom.timelineScrub.addEventListener('input', () => {
      const maxF = Math.max(1, synthResult.cleanFrames.length - 1);
      const f = Number(dom.timelineScrub.value) || 0;
      st.normalizedTime = THREE.MathUtils.clamp(f / maxF, 0, 1);
      st.playing = false;
      dom.btnPlayToggle.textContent = '▶ 播放验证';
      if (st.viewMode === 'pose_edit') {
        setViewMode('play_ai');
        st.playing = false;
        dom.btnPlayToggle.textContent = '▶ 播放验证';
      }
      renderFrame(1 / 60);
      updateFrameReadout();
    });

    dom.btnDupKf.addEventListener('click', () => {
      const cur = st.keyframes[st.activeKfIdx];
      if (!cur) return;
      const copy = cloneKeyframe(cur, { label: `${cur.label} (副本)` });
      const insertIdx = st.activeKfIdx + 1;
      st.keyframes.splice(insertIdx, 0, copy);
      rebuildSynthesis();
      selectKeyframe(insertIdx, { enterPoseEdit: true });
    });

    dom.btnDelKf.addEventListener('click', () => {
      if (st.keyframes.length <= 2) return;
      st.keyframes.splice(st.activeKfIdx, 1);
      st.activeKfIdx = Math.min(st.activeKfIdx, st.keyframes.length - 1);
      rebuildSynthesis();
      selectKeyframe(st.activeKfIdx, { enterPoseEdit: true });
    });

    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', handleKeyDown);
  }

  function togglePlay(forceFlag) {
    const next = forceFlag !== undefined ? Boolean(forceFlag) : !st.playing;
    if (next && st.viewMode === 'pose_edit') {
      if (st.normalizedTime >= 0.99) st.normalizedTime = 0;
      setViewMode('play_ai');
      st.playing = true;
    } else {
      st.playing = next;
    }
    dom.btnPlayToggle.textContent = st.playing ? '⏸ 暂停播放' : '▶ 播放验证';
    updateJointPinPositions();
    syncGizmoAttachment();
    updateOnionSkins();
  }

  function handleKeyDown(e) {
    if (!active) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'KeyR') {
      dom.gizmoRot.click();
    } else if (e.code === 'KeyT') {
      dom.gizmoPos.click();
    }
  }

  function handleResize() {
    if (!renderer || !camera || !dom.canvasWrap) return;
    const w = Math.max(1, dom.canvasWrap.clientWidth || window.innerWidth);
    const h = Math.max(1, dom.canvasWrap.clientHeight || window.innerHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function exportBVH(opts = {}) {
    const bvhText = exportFramesToBVH(synthResult.cleanFrames, 60);
    if (opts.triggerDownload && typeof document !== 'undefined') {
      const blob = new Blob([bvhText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${st.templateId || 'wuxia_keyframe'}_60fps.bvh`;
      a.click();
      URL.revokeObjectURL(url);
    }
    return bvhText;
  }

  function sendToWorkbench() {
    const bvhText = exportFramesToBVH(synthResult.cleanFrames, 60);
    const tpl = KEYFRAME_TEMPLATES.find((t) => t.id === st.templateId);
    const clipTitle = tpl ? `定格AI补帧 · ${tpl.name.split('（')[0]}` : '定格AI补帧合成招式';
    hooks.onSendToWorkbench?.(bvhText, `${st.templateId}_keyframe.bvh`, {
      id: `kf_${st.templateId}`,
      name: clipTitle,
      hasWeapon: Boolean(st.inbetweenOpts.hasWeapon),
      isCombatAttack: true,
      preserveRootMotion: true,
      originKind: 'keyframe_synth',
    });
    return bvhText;
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    buildDOM();
    buildThreeStage();
    wireEvents();
    loadVideoSource(KEYFRAME_TEMPLATES[0].defaultVideoUrl);
    ensureCompareClipLoaded(st.compareAssetId);
    rebuildSynthesis();
    selectKeyframe(st.activeKfIdx, { enterPoseEdit: true });
  }

  function setActive(flag) {
    const next = Boolean(flag);
    if (next && !mounted) {
      mount();
    }
    active = next;
    if (!active) {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      dom.videoEl?.pause?.();
      syncGizmoAttachment();
      return;
    }
    handleResize();
    syncGizmoAttachment();
    lastClock = performance.now();
    if (!rafId) {
      rafId = requestAnimationFrame(loop);
    }
  }

  function dispose() {
    setActive(false);
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('keydown', handleKeyDown);
    if (ownedVideoBlobUrl) {
      URL.revokeObjectURL(ownedVideoBlobUrl);
      ownedVideoBlobUrl = null;
    }
    transformControls?.dispose?.();
    orbitControls?.dispose?.();
    renderer?.dispose?.();
    renderer?.forceContextLoss?.();
  }

  function getState() {
    return {
      active,
      mounted,
      templateId: st.templateId,
      viewMode: st.viewMode,
      gizmoMode: st.gizmoMode,
      playing: st.playing,
      activeKfIdx: st.activeKfIdx,
      keyframeCount: st.keyframes.length,
      selectedBoneIdx: st.selectedBoneIdx,
      selectedBoneName: BONE_DEFS[st.selectedBoneIdx]?.name || 'Hips',
      inbetweenMode: st.inbetweenOpts.mode,
      hasWeapon: Boolean(st.inbetweenOpts.hasWeapon),
      normalizedTime: st.normalizedTime,
      metrics: { ...synthResult.metrics },
      keyframes: st.keyframes.map((k, idx) => ({
        index: idx,
        id: k.id,
        label: k.label,
        durationToNext: k.durationToNext,
        holdSec: k.holdSec,
        spinTurns: k.spinTurns,
        sourceTimeSec: k.sourceTimeSec,
        hasThumbnail: Boolean(k.thumbnailDataUrl),
      })),
    };
  }

  const publicApi = {
    mount,
    setActive,
    dispose,
    getState,
    selectKeyframe: (idx) => {
      selectKeyframe(idx, { enterPoseEdit: true });
      return getState();
    },
    selectBone: (idx) => {
      selectBone(idx);
      return getState();
    },
    setBoneEulerDeg: (boneIdx, xDeg, yDeg, zDeg) => {
      selectBone(boneIdx);
      const kf = st.keyframes[st.activeKfIdx];
      if (kf) {
        setBoneLocalEulerDeg(kf, st.selectedBoneIdx, xDeg, yDeg, zDeg);
        syncInspectorSlidersFromActivePose();
        rebuildSynthesis();
      }
      return getState();
    },
    setKeyframeSpinTurns: (turns) => {
      const kf = st.keyframes[st.activeKfIdx];
      if (kf) {
        kf.spinTurns = THREE.MathUtils.clamp(Math.round(Number(turns) || 0), -3, 3);
        syncInspectorSlidersFromActivePose();
        rebuildSynthesis();
      }
      return getState();
    },
    setViewMode: (m) => {
      setViewMode(m);
      return getState();
    },
    setPlaying: (flag) => {
      togglePlay(Boolean(flag));
      return getState();
    },
    grabVideoFrameAt: async (sec, replaceCurrent = false) => {
      if (dom.videoEl && Number.isFinite(Number(sec))) {
        dom.videoEl.currentTime = Number(sec);
        await new Promise((r) => setTimeout(r, 150));
      }
      await grabCurrentVideoFrameAsKeyframe(replaceCurrent);
      return getState();
    },
    autoExtractFromVideo: async (count = 5) => {
      await runAutoVideoSalientKeyframes(count);
      return getState();
    },
    exportBVH,
    sendToWorkbench,
  };

  if (typeof window !== 'undefined') {
    window.__KEYFRAME_STUDIO__ = publicApi;
  }

  return publicApi;
}
