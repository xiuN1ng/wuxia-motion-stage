import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  BONE_DEFS,
  BONE_IDX,
  buildCharacterRig,
  createRawGhostVisualizer,
} from './rig/HumanoidRig.js';
import {
  buildSlashClip,
  buildKickClip,
  buildBackflipClip,
  buildRunClip,
  parseBVHTextToClip,
} from './anim/MotionClips.js';
import {
  DEFAULT_CLEAN_OPTIONS,
  DEFAULT_COMBAT_CURVE,
  sanitizeCombatCurveOptions,
  runCleaningPipeline,
  remapCombatTime,
  createCombatTimeRemapper,
  sampleInterpolatedFrame,
  computeBakedFrameCount,
} from './pipeline/MotionCleaner.js';
import { applyForearmTwistSolver, SpringClothSolver } from './pipeline/TwoBoneIK.js';
import { exportCleanedClipToBVH } from './pipeline/BVHExporter.js';
import {
  probeVideoSource,
  extractClipFromImageFile,
  extractClipFromVideoFile,
  extractClipFromVideoUrl,
} from './capture/VideoPoseCapture.js';
import {
  STATIC_ASSET_CATALOG,
  fetchAssetCatalog,
  findAssetInCatalog,
  populateAssetSelectElement,
} from './ui/AssetLibraryCatalog.js';
import { createWorkbenchPanel } from './ui/WorkbenchPanel.js';
import { createTelemetryHUD } from './ui/TelemetryHUD.js';
import { createCombatArena } from './combat/CombatArenaApp.js';

const SPEEDS = [1.0, 0.5, 0.25];
const SPLIT_OFFSET_X = 0.78;

const state = {
  activeMode: 'workbench', // 'workbench' | 'combat'
  workbenchActive: true,
  clipKey: 'slash',
  viewMode: 'clean', // 'clean' | 'raw' | 'split'
  playing: true,
  speedIdx: 0,
  normalizedTime: 0,
  warpedNormalizedTime: 0,
  inHitstop: false,
  lastCleanDurationMs: 0,
  cleanOptions: {
    ...DEFAULT_CLEAN_OPTIONS,
    loopClean: true,
    preserveRootMotion: false,
  },
  combatCurve: {
    ...DEFAULT_COMBAT_CURVE,
  },
  visuals: {
    showSkinHeatmap: false,
    showRawGhost: false,
  },
  trimState: {
    hasVideo: false,
    sourceKind: null, // 'url' | 'file'
    sourceUrl: null,
    sourceUrls: null,
    sourceFile: null,
    sourceLabel: '',
    clipId: '',
    hasWeapon: true,
    isCombatAttack: false,
    nonCyclic: true,
    videoDuration: 0,
    trimInSec: 0,
    trimOutSec: 0,
    pendingTrimInSec: 0,
    pendingTrimOutSec: 0,
    targetFps: 24,
    isScrubbingTrim: false,
  },
};

const _presetCache = {};
const _presetBuilders = {
  slash: buildSlashClip,
  kick: buildKickClip,
  backflip: buildBackflipClip,
  run: buildRunClip,
};
const presets = {
  get slash() {
    return (_presetCache.slash ||= _presetBuilders.slash());
  },
  get kick() {
    return (_presetCache.kick ||= _presetBuilders.kick());
  },
  get backflip() {
    return (_presetCache.backflip ||= _presetBuilders.backflip());
  },
  get run() {
    return (_presetCache.run ||= _presetBuilders.run());
  },
};

let assetCatalog = STATIC_ASSET_CATALOG.map((item) => ({ ...item }));
let activeClip = null;
let pipelineResult = null;
let activeMediaUrl = null;
let activeMediaOwned = false;
let isExtractingMedia = false;
let cachedTaibaiDemo = null;
let rafId = null;

// --- Three.js Minimalist Stage Setup ---
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x111419, 0.075);

const camera = new THREE.PerspectiveCamera(
  38,
  Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
  0.08,
  40
);
camera.position.set(1.55, 1.38, 2.85);

let renderer = null;
let controls = null;

function ensureWorkbenchRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0.94, 0);
  controls.minDistance = 0.75;
  controls.maxDistance = 9.0;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.enabled = Boolean(state.workbenchActive);
}

let camTransition = null;
function glideCameraToViewMode(mode) {
  const endPos =
    mode === 'split'
      ? new THREE.Vector3(0, 1.42, 3.85)
      : new THREE.Vector3(1.55, 1.38, 2.85);
  const endTarget = new THREE.Vector3(0, 0.94, 0);
  camTransition = {
    startPos: camera.position.clone(),
    endPos,
    startTarget: controls ? controls.target.clone() : new THREE.Vector3(0, 0.94, 0),
    endTarget,
    t: 0,
  };
}

// Studio Three-Point Lighting
const hemiLight = new THREE.HemisphereLight(0xd2deee, 0x232830, 0.98);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xfff4e6, 2.25);
keyLight.position.set(2.8, 4.5, 3.2);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 14;
const shadowSpan = 2.9;
keyLight.shadow.camera.left = -shadowSpan;
keyLight.shadow.camera.right = shadowSpan;
keyLight.shadow.camera.top = shadowSpan;
keyLight.shadow.camera.bottom = -shadowSpan;
keyLight.shadow.bias = -0.0004;
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0x64bfb2, 1.05);
rimLight.position.set(-2.6, 2.5, -2.8);
scene.add(rimLight);

// Matte Studio Stage Floor + Subtle Footprint Reference Rings
const floorGeo = new THREE.CircleGeometry(7.0, 64);
floorGeo.rotateX(-Math.PI * 0.5);
const floorMat = new THREE.MeshStandardMaterial({
  color: 0x16191f,
  roughness: 0.9,
  metalness: 0.06,
});
const floorMesh = new THREE.Mesh(floorGeo, floorMat);
floorMesh.receiveShadow = true;
scene.add(floorMesh);

const stageRings = new THREE.Group();
for (const r of [0.35, 0.85, 1.65]) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(r - 0.003, r + 0.003, 72),
    new THREE.MeshBasicMaterial({
      color: r === 0.35 ? 0x2c3440 : 0x21262f,
      side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI * 0.5;
  ring.position.y = 0.0015;
  stageRings.add(ring);
}
scene.add(stageRings);

// Build Dual Character Rigs + Raw Ghost Skeleton Overlay
const cleanChar = buildCharacterRig();
cleanChar.setSkinningVisualState('prod', false);
scene.add(cleanChar.rootGroup);

const rawChar = buildCharacterRig();
rawChar.setSkinningVisualState('bad', false);
scene.add(rawChar.rootGroup);

const rawGhost = createRawGhostVisualizer();
rawGhost.group.visible = false;
scene.add(rawGhost.group);

const cleanClothSolver = new SpringClothSolver();

// Subtle Sword Arc Ribbon (only active on armed sword clip)
const TRAIL_STEPS = 14;
const trailPositions = new Float32Array(TRAIL_STEPS * 2 * 3);
const trailColors = new Float32Array(TRAIL_STEPS * 2 * 3);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
trailGeo.setAttribute('color', new THREE.BufferAttribute(trailColors, 3));
const trailIndices = [];
for (let i = 0; i < TRAIL_STEPS - 1; i++) {
  const a = i * 2;
  const b = a + 1;
  const c = a + 2;
  const d = a + 3;
  trailIndices.push(a, b, c, b, d, c);
}
trailGeo.setIndex(trailIndices);
const trailMat = new THREE.MeshBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.36,
  side: THREE.DoubleSide,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const slashTrailMesh = new THREE.Mesh(trailGeo, trailMat);
slashTrailMesh.frustumCulled = false;
scene.add(slashTrailMesh);
const trailHistory = [];

// Scratch Pose Buffers
const cleanPose = {
  rootPos: new THREE.Vector3(),
  quats: Array.from({ length: BONE_DEFS.length }, () => new THREE.Quaternion()),
};
const rawPose = {
  rootPos: new THREE.Vector3(),
  quats: Array.from({ length: BONE_DEFS.length }, () => new THREE.Quaternion()),
};

// --- DOM Elements ---
const stageRootEl = document.getElementById('stage-root');
const combatContainerEl = document.getElementById('combat-arena-container');
const modeWorkbenchBtn = document.getElementById('btn-mode-workbench');
const modeCombatBtn = document.getElementById('btn-mode-combat');

let combatArena = null;
let combatMountPromise = null;
let combatClipsReady = false;

const scrubberEl = document.getElementById('timeline-scrubber');
const frameLabelEl = document.getElementById('lbl-frame');
const playPauseBtn = document.getElementById('btn-play-pause');
const speedBtn = document.getElementById('btn-speed-cycle');
const weaponBtn = document.getElementById('btn-toggle-weapon');
const demoTaibaiBtn = document.getElementById('btn-demo-taibai');
const assetSelectEl = document.getElementById('asset-library-select');
const toggleWorkbenchBtn = document.getElementById('btn-toggle-workbench');
const workbenchDrawerEl = document.getElementById('workbench-drawer');
const telemetryHudEl = document.getElementById('telemetry-hud');
const splitLabelsEl = document.getElementById('split-labels');

const pipBox = document.getElementById('source-pip');
const pipLabel = document.getElementById('pip-label');
const pipVideo = document.getElementById('pip-video');
const pipImage = document.getElementById('pip-image');
const pipOverlay = document.getElementById('pip-progress-overlay');
const pipProgressText = document.getElementById('pip-progress-text');
const dropOverlay = document.getElementById('drop-overlay');

const pipTrimControls = document.getElementById('pip-trim-controls');
const lblTrimSummary = document.getElementById('lbl-trim-summary');
const trimInRange = document.getElementById('trim-in-range');
const trimOutRange = document.getElementById('trim-out-range');
const trimInNum = document.getElementById('trim-in-num');
const trimOutNum = document.getElementById('trim-out-num');
const trimFpsSelect = document.getElementById('trim-fps-select');
const btnReextractTrim = document.getElementById('btn-reextract-trim');

// --- Mount Workbench Panel & Telemetry HUD ---
const workbenchPanel = createWorkbenchPanel(workbenchDrawerEl, {
  initialCleanOptions: state.cleanOptions,
  initialCombatCurve: state.combatCurve,
  initialVisuals: state.visuals,
  onCleanOptionsChange: (patch) => {
    applyCleanOptionsPatch(patch);
  },
  onCombatCurveChange: (patch) => {
    applyCombatCurvePatch(patch);
  },
  onVisualsChange: (nextVisuals) => {
    applyVisualsPatch(nextVisuals);
  },
  onExportBVH: () => {
    exportCurrentBVH({ triggerDownload: true });
  },
  onResetDefaults: () => {
    ensureActiveClip();
    state.cleanOptions = {
      ...DEFAULT_CLEAN_OPTIONS,
      loopClean: !Boolean(activeClip.nonCyclic),
      preserveRootMotion: Boolean(activeClip.preserveRootMotion),
    };
    state.combatCurve = { ...DEFAULT_COMBAT_CURVE };
    applyVisualsPatch({ showSkinHeatmap: false, showRawGhost: false });
    recleanActiveClip();
    if (!state.playing) renderSingleFrame();
  },
});

const telemetryHUD = createTelemetryHUD(telemetryHudEl, {
  onScrubNormalizedTime: (u) => {
    setNormalizedTime(u, true);
  },
});

populateAssetSelectElement(assetSelectEl, assetCatalog);
fetchAssetCatalog().then((loaded) => {
  assetCatalog = loaded;
  populateAssetSelectElement(assetSelectEl, assetCatalog, assetSelectEl?.value || '');
});

function evaluateCurrentRemap(u) {
  ensureActiveClip();
  return remapCombatTime(
    u,
    Boolean(activeClip.isCombatAttack),
    true,
    Boolean(activeClip.nonCyclic),
    state.combatCurve,
    pipelineResult?.cleanedFrames || activeClip.frames,
    activeClip.fps
  );
}

function syncTelemetryHUD() {
  if (!pipelineResult || !activeClip) return;
  const fastRemapFn = createCombatTimeRemapper(
    activeClip,
    state.combatCurve,
    pipelineResult.cleanedFrames || activeClip.frames
  );
  telemetryHUD.updateData({
    clip: activeClip,
    cleanedFrames: pipelineResult.cleanedFrames,
    rawTelemetry: pipelineResult.rawTelemetry,
    cleanTelemetry: pipelineResult.cleanTelemetry,
    combatCurve: state.combatCurve,
    remapFn: fastRemapFn,
  });
}

function syncStageVisibility() {
  const hasSword = Boolean(activeClip?.hasWeapon);
  cleanChar.swordGroup.visible = hasSword;
  rawChar.swordGroup.visible = hasSword;
  if (weaponBtn) {
    weaponBtn.classList.toggle('active', hasSword);
    weaponBtn.setAttribute('aria-pressed', String(hasSword));
  }

  cleanChar.rootGroup.visible = state.viewMode === 'clean' || state.viewMode === 'split';
  rawChar.rootGroup.visible = state.viewMode === 'raw' || state.viewMode === 'split';
  rawGhost.group.visible = Boolean(state.visuals.showRawGhost) && state.viewMode !== 'raw';
  splitLabelsEl.hidden = state.viewMode !== 'split';

  document.querySelectorAll('#view-mode-group .mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.viewMode);
  });
}

function recleanActiveClip() {
  if (!activeClip) return;
  const t0 = performance.now();
  pipelineResult = runCleaningPipeline(activeClip, state.cleanOptions);
  state.lastCleanDurationMs = performance.now() - t0;

  if (pipelineResult.appliedOptions) {
    state.cleanOptions = { ...pipelineResult.appliedOptions };
  }

  workbenchPanel.syncState({
    cleanOptions: state.cleanOptions,
    combatCurve: state.combatCurve,
    visuals: state.visuals,
    lastCleanDurationMs: state.lastCleanDurationMs,
  });
  syncTelemetryHUD();
}

function loadActiveClip(clip, presetKey = null, { preserveCleanToggles = false } = {}) {
  activeClip = clip;
  state.clipKey = presetKey;
  state.normalizedTime = 0;
  trailHistory.length = 0;
  cleanClothSolver.reset(cleanChar.bones);

  if (!preserveCleanToggles) {
    state.cleanOptions.loopClean = !Boolean(activeClip.nonCyclic);
    state.cleanOptions.preserveRootMotion = Boolean(activeClip.preserveRootMotion);
  }

  recleanActiveClip();

  scrubberEl.max = String(Math.max(1, activeClip.totalFrames - 1));
  scrubberEl.value = '0';

  document.querySelectorAll('#preset-nav .chip-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.clip === presetKey);
  });
  if (demoTaibaiBtn) {
    demoTaibaiBtn.classList.toggle('active', presetKey === 'taibai_demo');
  }

  syncStageVisibility();
  renderSingleFrame();
}

function ensureActiveClip() {
  if (!activeClip) {
    loadActiveClip(presets.slash, 'slash');
  }
  return activeClip;
}

function resetTrimState() {
  state.trimState = {
    hasVideo: false,
    sourceKind: null,
    sourceUrl: null,
    sourceUrls: null,
    sourceFile: null,
    sourceLabel: '',
    clipId: '',
    hasWeapon: true,
    isCombatAttack: false,
    nonCyclic: true,
    videoDuration: 0,
    trimInSec: 0,
    trimOutSec: 0,
    pendingTrimInSec: 0,
    pendingTrimOutSec: 0,
    targetFps: Number.parseInt(trimFpsSelect?.value || '24', 10) || 24,
    isScrubbingTrim: false,
  };
  if (pipTrimControls) {
    pipTrimControls.hidden = true;
  }
}

function clearMediaPreview() {
  if (activeMediaUrl && activeMediaOwned) {
    URL.revokeObjectURL(activeMediaUrl);
  }
  activeMediaUrl = null;
  activeMediaOwned = false;
  resetTrimState();
  pipVideo.pause?.();
  pipVideo.removeAttribute('src');
  pipVideo.hidden = true;
  pipImage.removeAttribute('src');
  pipImage.hidden = true;
  pipOverlay.hidden = true;
}

function syncTrimControlsUI() {
  const ts = state.trimState;
  if (!pipTrimControls) return;
  pipTrimControls.hidden = !ts.hasVideo;
  if (!ts.hasVideo) return;

  const maxDur = Math.max(0.2, Number(ts.videoDuration) || 3.0);
  const maxStr = maxDur.toFixed(2);
  trimInRange.max = maxStr;
  trimOutRange.max = maxStr;
  trimInNum.max = maxStr;
  trimOutNum.max = maxStr;

  trimInRange.value = String(ts.pendingTrimInSec);
  trimOutRange.value = String(ts.pendingTrimOutSec);
  trimInNum.value = ts.pendingTrimInSec.toFixed(2);
  trimOutNum.value = ts.pendingTrimOutSec.toFixed(2);
  trimFpsSelect.value = String(ts.targetFps || 24);

  const span = Math.max(0.05, ts.pendingTrimOutSec - ts.pendingTrimInSec);
  lblTrimSummary.textContent = `${ts.pendingTrimInSec.toFixed(2)}s – ${ts.pendingTrimOutSec.toFixed(2)}s (${span.toFixed(2)}s)`;
}

function updatePendingTrimWindow(which, rawVal, scrubPreview = true) {
  const ts = state.trimState;
  if (!ts.hasVideo) return;
  const maxDur = Math.max(0.2, Number(ts.videoDuration) || 3.0);
  const minSpan = Math.min(0.2, maxDur * 0.5);
  const v = Number.isFinite(Number(rawVal)) ? Number(rawVal) : 0;

  if (which === 'in') {
    ts.pendingTrimInSec = THREE.MathUtils.clamp(v, 0, Math.max(0, maxDur - minSpan));
    if (ts.pendingTrimOutSec < ts.pendingTrimInSec + minSpan) {
      ts.pendingTrimOutSec = Math.min(maxDur, ts.pendingTrimInSec + minSpan);
    }
  } else {
    ts.pendingTrimOutSec = THREE.MathUtils.clamp(v, minSpan, maxDur);
    if (ts.pendingTrimInSec > ts.pendingTrimOutSec - minSpan) {
      ts.pendingTrimInSec = Math.max(0, ts.pendingTrimOutSec - minSpan);
    }
  }

  syncTrimControlsUI();

  if (scrubPreview && !pipVideo.hidden) {
    state.playing = false;
    playPauseBtn.textContent = '播放';
    ts.isScrubbingTrim = true;
    const previewSec = which === 'in' ? ts.pendingTrimInSec : ts.pendingTrimOutSec;
    if (!pipVideo.seeking) {
      pipVideo.currentTime = THREE.MathUtils.clamp(previewSec, 0, Math.max(0, maxDur - 0.01));
    }
  }
}

function formatCaptureError(err, fallbackText) {
  if (!err) return fallbackText;
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.type) return `${fallbackText} (${err.type})`;
  return String(err);
}

/**
 * Shared live video extraction flow supporting initial probing (for long master videos like 05),
 * trim slider setup, and re-extraction without revoking local file Object URLs.
 */
async function runVideoExtractionWorkflow({
  sourceKind, // 'url' | 'file'
  urls = null,
  file = null,
  reuseExistingMediaUrl = false,
  label = '视频动作提取',
  clipId = 'captured_video',
  hasWeapon = true,
  isCombatAttack = false,
  nonCyclic = true,
  trimInSec = null,
  trimOutSec = null,
  defaultTrimIn = null,
  defaultTrimOut = null,
  targetFps = null,
  presetKey = null,
}) {
  if (isExtractingMedia) return null;
  isExtractingMedia = true;

  const prevMediaUrl = reuseExistingMediaUrl ? activeMediaUrl : null;
  const prevMediaOwned = reuseExistingMediaUrl ? activeMediaOwned : false;
  if (!reuseExistingMediaUrl) {
    clearMediaPreview();
  }

  pipBox.hidden = false;
  pipLabel.textContent = label;
  pipOverlay.hidden = false;
  pipProgressText.textContent = '正在探测视频时长与编码信息...';

  const onStatus = (statusText) => {
    pipProgressText.textContent = statusText;
  };
  const onProgress = (pct) => {
    pipProgressText.textContent = `正在提取 3D 骨骼动作 ${pct}%`;
  };

  try {
    let probedDuration = state.trimState.videoDuration || 0;
    let resolvedUrl = prevMediaUrl;
    let ownedUrl = prevMediaOwned;

    if (!reuseExistingMediaUrl) {
      const probeTarget = sourceKind === 'file' ? file : urls;
      const probe = await probeVideoSource(probeTarget);
      resolvedUrl = probe.mediaUrl;
      ownedUrl = probe.ownedObjectUrl;
      probedDuration = probe.videoDuration || 3.0;
      activeMediaUrl = resolvedUrl;
      activeMediaOwned = ownedUrl;
    }

    const fps = Number(targetFps) || Number.parseInt(trimFpsSelect?.value || '24', 10) || 24;
    let effectiveIn = trimInSec;
    let effectiveOut = trimOutSec;

    if (effectiveIn === null || effectiveIn === undefined) {
      effectiveIn = defaultTrimIn !== null && defaultTrimIn !== undefined ? defaultTrimIn : 0;
    }
    if (effectiveOut === null || effectiveOut === undefined) {
      if (defaultTrimOut !== null && defaultTrimOut !== undefined) {
        effectiveOut = Math.min(probedDuration, defaultTrimOut);
      } else if (probedDuration > 12.0) {
        effectiveOut = Math.min(probedDuration, effectiveIn + 6.0);
      } else {
        effectiveOut = probedDuration;
      }
    }

    let result;
    if (sourceKind === 'file') {
      result = await extractClipFromVideoFile(file, onProgress, {
        existingMediaUrl: resolvedUrl,
        id: clipId,
        name: label,
        hasWeapon,
        isCombatAttack,
        nonCyclic,
        trimInSec: effectiveIn,
        trimOutSec: effectiveOut,
        targetFps: fps,
        onStatus,
      });
      activeMediaOwned = ownedUrl;
    } else {
      result = await extractClipFromVideoUrl(urls || [resolvedUrl], label, onProgress, {
        id: clipId,
        name: label,
        hasWeapon,
        isCombatAttack,
        nonCyclic,
        trimInSec: effectiveIn,
        trimOutSec: effectiveOut,
        targetFps: fps,
        onStatus,
      });
    }

    activeMediaUrl = result.mediaUrl;
    if (pipVideo.src !== result.mediaUrl) {
      pipVideo.src = result.mediaUrl;
    }
    pipVideo.hidden = false;
    pipImage.hidden = true;
    pipOverlay.hidden = true;

    state.trimState = {
      hasVideo: true,
      sourceKind,
      sourceUrl: result.mediaUrl,
      sourceUrls: urls || [result.mediaUrl],
      sourceFile: file || null,
      sourceLabel: label,
      clipId,
      hasWeapon: Boolean(result.clip.hasWeapon),
      isCombatAttack: Boolean(result.clip.isCombatAttack),
      nonCyclic: Boolean(result.clip.nonCyclic),
      videoDuration: result.fullVideoDuration || probedDuration || result.duration,
      trimInSec: result.trimInSec ?? effectiveIn,
      trimOutSec: result.trimOutSec ?? effectiveOut,
      pendingTrimInSec: result.trimInSec ?? effectiveIn,
      pendingTrimOutSec: result.trimOutSec ?? effectiveOut,
      targetFps: result.clip.fps || fps,
      isScrubbingTrim: false,
    };
    syncTrimControlsUI();

    loadActiveClip(result.clip, presetKey);
    state.playing = true;
    playPauseBtn.textContent = '暂停';
    return result;
  } catch (err) {
    console.error('[MotionStage] Video capture error:', err);
    pipOverlay.hidden = false;
    pipProgressText.textContent = formatCaptureError(err, '视频姿态提取失败');
    throw err;
  } finally {
    isExtractingMedia = false;
  }
}

// --- Trim Controls Event Wiring ---
trimInRange?.addEventListener('input', (e) => updatePendingTrimWindow('in', e.target.value, true));
trimOutRange?.addEventListener('input', (e) => updatePendingTrimWindow('out', e.target.value, true));
trimInNum?.addEventListener('input', (e) => updatePendingTrimWindow('in', e.target.value, true));
trimOutNum?.addEventListener('input', (e) => updatePendingTrimWindow('out', e.target.value, true));

const clearTrimScrubFlag = () => {
  state.trimState.isScrubbingTrim = false;
};
[trimInRange, trimOutRange, trimInNum, trimOutNum].forEach((el) => {
  el?.addEventListener('change', clearTrimScrubFlag);
  el?.addEventListener('pointerup', clearTrimScrubFlag);
});

trimFpsSelect?.addEventListener('change', () => {
  state.trimState.targetFps = Number.parseInt(trimFpsSelect.value, 10) || 24;
});

btnReextractTrim?.addEventListener('click', async () => {
  const ts = state.trimState;
  if (!ts.hasVideo || isExtractingMedia) return;
  ts.isScrubbingTrim = false;
  try {
    await runVideoExtractionWorkflow({
      sourceKind: ts.sourceKind,
      urls: ts.sourceUrls,
      file: ts.sourceFile,
      reuseExistingMediaUrl: true,
      label: ts.sourceLabel,
      clipId: ts.clipId || activeClip.id,
      hasWeapon: Boolean(activeClip.hasWeapon),
      isCombatAttack: ts.isCombatAttack,
      nonCyclic: ts.nonCyclic,
      trimInSec: ts.pendingTrimInSec,
      trimOutSec: ts.pendingTrimOutSec,
      targetFps: Number.parseInt(trimFpsSelect.value, 10) || ts.targetFps || 24,
      presetKey: state.clipKey,
    });
  } catch {
    // Error displayed in PiP overlay
  }
});

// --- Preset Chips & Asset Library Selector ---
document.querySelectorAll('#preset-nav .chip-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (isExtractingMedia) return;
    const key = btn.dataset.clip;
    if (!presets[key]) return;
    if (assetSelectEl) assetSelectEl.value = '';
    pipBox.hidden = true;
    clearMediaPreview();
    loadActiveClip(presets[key], key);
  });
});

async function loadCatalogAssetItem(item) {
  if (!item || isExtractingMedia) return null;

  if (item.kind === 'preset' && presets[item.presetKey]) {
    pipBox.hidden = true;
    clearMediaPreview();
    loadActiveClip(presets[item.presetKey], item.presetKey);
    return getState();
  }

  if (item.kind === 'video') {
    await runVideoExtractionWorkflow({
      sourceKind: 'url',
      urls: [encodeURI(item.path)],
      label: item.label,
      clipId: item.id.replace(/^video:/, 'taibai_video_'),
      hasWeapon: Boolean(item.hasWeapon),
      isCombatAttack: Boolean(item.isCombatAttack),
      nonCyclic: !Boolean(item.cyclic),
      defaultTrimIn: item.defaultTrimIn ?? null,
      defaultTrimOut: item.defaultTrimOut ?? null,
      presetKey: item.id,
    });
    return getState();
  }

  if (item.kind === 'bvh' && item.path) {
    const resp = await fetch(encodeURI(item.path), { cache: 'no-store' });
    if (resp.ok) {
      const bvhText = await resp.text();
      if (bvhText.includes('HIERARCHY') && bvhText.includes('MOTION')) {
        const fileName = item.path.split('/').pop() || `${item.id}.bvh`;
        return loadClipFromBVHText(bvhText, fileName, {
          id: item.id.replace(/^[bc]_bvh:/, ''),
          name: item.label,
          cyclic: item.cyclic,
          hasWeapon: item.hasWeapon,
          isCombatAttack: item.isCombatAttack,
          preserveRootMotion: item.preserveRootMotion ?? true,
          presetKey: item.id,
        });
      }
    }

    // Graceful fallback to live source video extraction for C_taibai_extracted if BVH not yet on disk
    if (item.fallbackVideoUrl) {
      pipBox.hidden = false;
      pipOverlay.hidden = false;
      pipProgressText.textContent = '归档 BVH 尚未生成，正在从太白参考视频实时提取...';
      await runVideoExtractionWorkflow({
        sourceKind: 'url',
        urls: [encodeURI(item.fallbackVideoUrl)],
        label: item.label.replace(/\.bvh/i, ' (视频实时提取)'),
        clipId: item.id.replace(/^c_bvh:/, ''),
        hasWeapon: Boolean(item.hasWeapon),
        isCombatAttack: Boolean(item.isCombatAttack),
        nonCyclic: !Boolean(item.cyclic),
        presetKey: item.id,
      });
      return getState();
    }

    pipBox.hidden = false;
    pipVideo.hidden = true;
    pipImage.hidden = true;
    pipTrimControls.hidden = true;
    pipOverlay.hidden = false;
    pipProgressText.textContent = `资产尚未落盘 (${resp.status}): ${item.label}`;
    return null;
  }

  return null;
}

assetSelectEl?.addEventListener('change', async () => {
  const val = assetSelectEl.value;
  if (!val) return;
  const item = findAssetInCatalog(assetCatalog, val);
  if (!item) return;
  try {
    await loadCatalogAssetItem(item);
  } catch (err) {
    console.error('[MotionStage] Failed loading catalog asset:', err);
  }
});

demoTaibaiBtn?.addEventListener('click', async () => {
  if (isExtractingMedia) return;
  if (assetSelectEl) assetSelectEl.value = '';

  if (cachedTaibaiDemo) {
    clearMediaPreview();
    pipBox.hidden = false;
    pipLabel.textContent = '太白剑意·武术实拍 (CC-BY)';
    activeMediaUrl = cachedTaibaiDemo.mediaUrl;
    activeMediaOwned = false;
    pipVideo.src = cachedTaibaiDemo.mediaUrl;
    pipVideo.hidden = false;
    pipOverlay.hidden = true;
    state.trimState = {
      hasVideo: true,
      sourceKind: 'url',
      sourceUrl: cachedTaibaiDemo.mediaUrl,
      sourceUrls: [cachedTaibaiDemo.mediaUrl],
      sourceFile: null,
      sourceLabel: '太白剑意·武术实拍 (CC-BY)',
      clipId: 'taibai_wuhen_jianyi',
      hasWeapon: true,
      isCombatAttack: false,
      nonCyclic: true,
      videoDuration: cachedTaibaiDemo.fullVideoDuration || cachedTaibaiDemo.duration || 3.0,
      trimInSec: cachedTaibaiDemo.trimInSec ?? 0,
      trimOutSec: cachedTaibaiDemo.trimOutSec ?? cachedTaibaiDemo.duration ?? 3.0,
      pendingTrimInSec: cachedTaibaiDemo.trimInSec ?? 0,
      pendingTrimOutSec: cachedTaibaiDemo.trimOutSec ?? cachedTaibaiDemo.duration ?? 3.0,
      targetFps: cachedTaibaiDemo.clip.fps || 24,
      isScrubbingTrim: false,
    };
    syncTrimControlsUI();
    loadActiveClip(cachedTaibaiDemo.clip, 'taibai_demo');
    state.playing = true;
    playPauseBtn.textContent = '暂停';
    return;
  }

  const prefersWebm = Boolean(pipVideo.canPlayType('video/webm; codecs="vp9"'));
  const demoUrls = prefersWebm
    ? ['./demo/taibai_wuhen_jianyi.webm', './demo/taibai_wuhen_jianyi.mp4']
    : ['./demo/taibai_wuhen_jianyi.mp4', './demo/taibai_wuhen_jianyi.webm'];

  demoTaibaiBtn.classList.add('active');
  try {
    const res = await runVideoExtractionWorkflow({
      sourceKind: 'url',
      urls: demoUrls,
      label: '太白剑意·武术实拍 (CC-BY)',
      clipId: 'taibai_wuhen_jianyi',
      hasWeapon: true,
      isCombatAttack: false,
      nonCyclic: true,
      presetKey: 'taibai_demo',
    });
    if (res) cachedTaibaiDemo = res;
  } catch {
    // Handled in PiP overlay
  }
});

toggleWorkbenchBtn?.addEventListener('click', () => {
  const nextHidden = !workbenchDrawerEl.hidden;
  workbenchDrawerEl.hidden = nextHidden;
  toggleWorkbenchBtn.classList.toggle('active', !nextHidden);
  toggleWorkbenchBtn.setAttribute('aria-pressed', String(!nextHidden));
});

document.querySelectorAll('#view-mode-group .mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    setViewMode(btn.dataset.mode);
  });
});

playPauseBtn.addEventListener('click', () => {
  setPlaying(!state.playing);
});

modeWorkbenchBtn?.addEventListener('click', () => {
  setStageMode('workbench');
});

modeCombatBtn?.addEventListener('click', () => {
  setStageMode('combat');
});

window.addEventListener('keydown', (e) => {
  if (!state.workbenchActive || state.activeMode !== 'workbench') return;
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    setPlaying(!state.playing);
  }
});

speedBtn.addEventListener('click', () => {
  state.speedIdx = (state.speedIdx + 1) % SPEEDS.length;
  speedBtn.textContent = `${SPEEDS[state.speedIdx]}x`;
});

weaponBtn?.addEventListener('click', () => {
  ensureActiveClip();
  activeClip.hasWeapon = !activeClip.hasWeapon;
  trailHistory.length = 0;
  syncStageVisibility();
  if (!state.playing) renderSingleFrame();
});

scrubberEl.addEventListener('input', (e) => {
  ensureActiveClip();
  const span = activeClip.nonCyclic
    ? Math.max(1, activeClip.totalFrames - 1)
    : Math.max(1, activeClip.totalFrames);
  const u = THREE.MathUtils.clamp(Number(e.target.value) / span, 0, 1);
  setNormalizedTime(u, true);
});

document.getElementById('btn-close-pip').addEventListener('click', () => {
  pipBox.hidden = true;
});

document.getElementById('btn-export-bvh').addEventListener('click', () => {
  exportCurrentBVH({ triggerDownload: true });
});

async function handleUploadedFile(file) {
  if (!file || isExtractingMedia) return;
  const lower = file.name.toLowerCase();
  const inheritSword = activeClip ? Boolean(activeClip.hasWeapon) : true;

  if (lower.endsWith('.bvh')) {
    try {
      const text = await file.text();
      loadClipFromBVHText(text, file.name);
      state.playing = true;
      playPauseBtn.textContent = '暂停';
    } catch (err) {
      pipBox.hidden = false;
      pipOverlay.hidden = false;
      pipProgressText.textContent = `BVH 解析失败: ${formatCaptureError(err, '格式错误')}`;
    }
    return;
  }

  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(lower)) {
    isExtractingMedia = true;
    clearMediaPreview();
    pipBox.hidden = false;
    pipLabel.textContent = file.name;
    pipOverlay.hidden = false;
    pipProgressText.textContent = '正在准备 3D 姿态引擎...';
    try {
      const result = await extractClipFromImageFile(file, (txt) => {
        pipProgressText.textContent = txt;
      });
      result.clip.hasWeapon = inheritSword;
      activeMediaUrl = result.mediaUrl;
      activeMediaOwned = true;
      pipImage.src = result.mediaUrl;
      pipImage.hidden = false;
      pipOverlay.hidden = true;
      loadActiveClip(result.clip, null);
      state.playing = true;
      playPauseBtn.textContent = '暂停';
    } catch (err) {
      pipOverlay.hidden = false;
      pipProgressText.textContent = formatCaptureError(err, '图像姿态提取失败');
    } finally {
      isExtractingMedia = false;
    }
    return;
  }

  if (file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(lower)) {
    try {
      await runVideoExtractionWorkflow({
        sourceKind: 'file',
        file,
        label: `视频捕捉: ${file.name}`,
        clipId: file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_'),
        hasWeapon: inheritSword,
        isCombatAttack: /sword|slash|strike|attack|wuhen|yuluo|feiyan|剑|斩/i.test(file.name),
        nonCyclic: true,
        presetKey: null,
      });
    } catch {
      // Displayed in PiP overlay
    }
    return;
  }

  pipBox.hidden = false;
  pipOverlay.hidden = false;
  pipProgressText.textContent = '请上传视频 (.mp4/.webm)、图片 (.jpg/.png) 或 .bvh 文件';
}

const uploadInput = document.getElementById('media-upload-input');
uploadInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleUploadedFile(file);
  uploadInput.value = '';
});

// Drag-and-Drop Support across Entire Stage (strictly isolated to active Workbench mode)
window.addEventListener('dragenter', (e) => {
  if (!state.workbenchActive || state.activeMode !== 'workbench') {
    dropOverlay.hidden = true;
    return;
  }
  e.preventDefault();
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!state.workbenchActive || state.activeMode !== 'workbench') {
    dropOverlay.hidden = true;
    return;
  }
  e.preventDefault();
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!state.workbenchActive || state.activeMode !== 'workbench') return;
  if (e.relatedTarget === null) {
    dropOverlay.hidden = true;
  }
});
window.addEventListener('drop', (e) => {
  if (!state.workbenchActive || state.activeMode !== 'workbench') {
    dropOverlay.hidden = true;
    return;
  }
  e.preventDefault();
  dropOverlay.hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file) handleUploadedFile(file);
});

function handleResize() {
  if (!state.workbenchActive) return;
  ensureWorkbenchRenderer();
  const w = Math.max(1, container.clientWidth);
  const h = Math.max(1, container.clientHeight);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  telemetryHUD.resize();
}

window.addEventListener('resize', handleResize);

// --- Sword Ribbon Updater ---
const _tipWorld = new THREE.Vector3();
const _baseWorld = new THREE.Vector3();

function updateSwordTrail(inHitstop) {
  if (!activeClip?.hasWeapon || state.viewMode === 'raw') {
    slashTrailMesh.visible = false;
    return;
  }
  slashTrailMesh.visible = true;

  const { tipAnchor, baseAnchor } = cleanChar.swordGroup.userData;
  tipAnchor.getWorldPosition(_tipWorld);
  baseAnchor.getWorldPosition(_baseWorld);

  trailHistory.unshift({ tip: _tipWorld.clone(), base: _baseWorld.clone(), hit: inHitstop });
  if (trailHistory.length > TRAIL_STEPS) trailHistory.pop();
  while (trailHistory.length < TRAIL_STEPS) {
    trailHistory.push({ tip: _tipWorld.clone(), base: _baseWorld.clone(), hit: false });
  }

  const posArr = trailGeo.attributes.position.array;
  const colArr = trailGeo.attributes.color.array;

  for (let i = 0; i < TRAIL_STEPS; i++) {
    const item = trailHistory[i];
    const fade = Math.pow(1 - i / (TRAIL_STEPS - 1), 1.85);
    const o = i * 6;
    posArr[o] = item.base.x;
    posArr[o + 1] = item.base.y;
    posArr[o + 2] = item.base.z;
    posArr[o + 3] = item.tip.x;
    posArr[o + 4] = item.tip.y;
    posArr[o + 5] = item.tip.z;

    const r = (item.hit ? 0.96 : 0.26) * fade;
    const g = (item.hit ? 0.68 : 0.84) * fade;
    const b = (item.hit ? 0.26 : 0.76) * fade;
    colArr[o] = r * 0.35;
    colArr[o + 1] = g * 0.35;
    colArr[o + 2] = b * 0.35;
    colArr[o + 3] = r;
    colArr[o + 4] = g;
    colArr[o + 5] = b;
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.attributes.color.needsUpdate = true;
}

function updateAndRenderStage(now, dt, curSpeed) {
  ensureWorkbenchRenderer();
  ensureActiveClip();
  const nonCyclic = Boolean(activeClip.nonCyclic);
  const { warpedU, inHitstop } = evaluateCurrentRemap(state.normalizedTime);
  state.warpedNormalizedTime = warpedU;
  state.inHitstop = inHitstop;

  const span = nonCyclic
    ? Math.max(1, activeClip.totalFrames - 1)
    : Math.max(1, activeClip.totalFrames);
  const cleanFrameFloat = warpedU * span;
  const rawFrameFloat = state.normalizedTime * span;

  const activeFloat = state.viewMode === 'raw' ? rawFrameFloat : cleanFrameFloat;
  const displayFrame = nonCyclic
    ? Math.min(activeClip.totalFrames - 1, Math.max(0, Math.floor(activeFloat + 1e-5)))
    : ((Math.floor(activeFloat) % activeClip.totalFrames) + activeClip.totalFrames) %
      activeClip.totalFrames;

  if (state.playing) {
    scrubberEl.value = String(displayFrame);
  }
  frameLabelEl.textContent = `${String(displayFrame).padStart(2, '0')} / ${String(
    activeClip.totalFrames
  ).padStart(2, '0')}`;

  // 1. Update Cleaned Production Character (x = 0 in 'clean', x = +0.78 in 'split')
  if (cleanChar.rootGroup.visible && pipelineResult) {
    const xOff = state.viewMode === 'split' ? SPLIT_OFFSET_X : 0;
    sampleInterpolatedFrame(pipelineResult.cleanedFrames, cleanFrameFloat, cleanPose, nonCyclic);
    cleanChar.bones[0].position.set(
      cleanPose.rootPos.x + xOff,
      cleanPose.rootPos.y,
      cleanPose.rootPos.z
    );
    for (let i = 0; i < BONE_DEFS.length; i++) {
      cleanChar.bones[i].quaternion.copy(cleanPose.quats[i]);
    }
    if (inHitstop && activeClip.hasWeapon) {
      cleanChar.bones[BONE_IDX.RightForeArm].rotation.z += Math.sin(now * 0.09) * 0.022;
    }
    applyForearmTwistSolver(cleanChar.bones, true, state.cleanOptions.forearmTwistShare);
    cleanClothSolver.update(
      cleanChar.bones,
      state.playing ? dt * curSpeed : 0.016,
      true,
      activeClip.syntheticSpeed || 0.5
    );
    cleanChar.bones[0].updateWorldMatrix(true, true);
  }

  // 2. Update Raw AI Character (x = 0 in 'raw', x = -0.78 in 'split')
  if (rawChar.rootGroup.visible) {
    const xOff = state.viewMode === 'split' ? -SPLIT_OFFSET_X : 0;
    sampleInterpolatedFrame(activeClip.frames, rawFrameFloat, rawPose, nonCyclic);
    rawChar.bones[0].position.set(rawPose.rootPos.x + xOff, rawPose.rootPos.y, rawPose.rootPos.z);
    for (let i = 0; i < BONE_DEFS.length; i++) {
      rawChar.bones[i].quaternion.copy(rawPose.quats[i]);
    }
    applyForearmTwistSolver(rawChar.bones, false);
    rawChar.bones[0].updateWorldMatrix(true, true);
  }

  // 3. Optional Raw Ghost Skeleton Overlay aligned with Cleaned Character
  if (rawGhost.group.visible) {
    const xOff = state.viewMode === 'split' ? SPLIT_OFFSET_X : 0;
    sampleInterpolatedFrame(activeClip.frames, rawFrameFloat, rawPose, nonCyclic);
    rawGhost.group.position.set(xOff, 0, 0);
    rawGhost.bones[0].position.copy(rawPose.rootPos);
    for (let i = 0; i < BONE_DEFS.length; i++) {
      rawGhost.bones[i].quaternion.copy(rawPose.quats[i]);
    }
    rawGhost.updateVisuals();
  }

  telemetryHUD.updatePlayhead(state.normalizedTime, warpedU, inHitstop);
  updateSwordTrail(inHitstop);
  renderer.render(scene, camera);
}

function renderSingleFrame() {
  if (!state.workbenchActive) return;
  ensureWorkbenchRenderer();
  controls.update();
  updateAndRenderStage(performance.now(), 0.016, SPEEDS[state.speedIdx]);
}

let prevClock = performance.now();

function animate(now) {
  if (!state.workbenchActive) {
    rafId = null;
    return;
  }
  ensureWorkbenchRenderer();
  ensureActiveClip();
  rafId = requestAnimationFrame(animate);
  const dt = Math.min(Math.max(0, (now - prevClock) / 1000), 0.05);
  prevClock = now;

  if (camTransition) {
    camTransition.t = Math.min(1, camTransition.t + dt * 3.2);
    const s = camTransition.t * camTransition.t * (3 - 2 * camTransition.t);
    camera.position.lerpVectors(camTransition.startPos, camTransition.endPos, s);
    controls.target.lerpVectors(camTransition.startTarget, camTransition.endTarget, s);
    if (camTransition.t >= 1) camTransition = null;
  }
  controls.update();

  const curSpeed = SPEEDS[state.speedIdx];
  const clipDuration = Math.max(0.1, activeClip.totalFrames / activeClip.fps);
  const nonCyclic = Boolean(activeClip.nonCyclic);
  if (state.playing) {
    const nextU = state.normalizedTime + (dt * curSpeed) / clipDuration;
    if (nextU >= 1 && nonCyclic) {
      trailHistory.length = 0;
    }
    state.normalizedTime = nextU % 1;
  }

  // Sync PiP Reference Video within active [trimInSec, trimOutSec] window
  if (
    !pipBox.hidden &&
    !pipVideo.hidden &&
    state.trimState.hasVideo &&
    !state.trimState.isScrubbingTrim
  ) {
    const trimIn = state.trimState.trimInSec || 0;
    const trimSpan = Math.max(0.05, (state.trimState.trimOutSec || trimIn + 1) - trimIn);
    const targetSec = trimIn + state.normalizedTime * trimSpan;
    if (!pipVideo.seeking && Math.abs(pipVideo.currentTime - targetSec) > 0.045) {
      pipVideo.currentTime = targetSec;
    }
  }

  updateAndRenderStage(now, dt, curSpeed);
}

// --- Public State & Lifecycle API Functions (Contract 4) ---

function serializeTelemetry(tel) {
  if (!tel) return null;
  return {
    slipSeries: Array.from(tel.slipSeries || []),
    slipSeriesCmS: Array.from(tel.slipSeriesCmS || []),
    jitterSeries: Array.from(tel.jitterSeries || []),
    combinedError: Array.from(tel.combinedError || []),
    stanceLSeries: Array.from(tel.stanceLSeries || []),
    stanceRSeries: Array.from(tel.stanceRSeries || []),
    meanSlip: Number(tel.meanSlip || 0),
    maxSlip: Number(tel.maxSlip || 0),
    meanSlipCmS: Number(tel.meanSlipCmS || 0),
    rmsSlipCmS: Number(tel.rmsSlipCmS || 0),
    maxSlipCmS: Number(tel.maxSlipCmS || 0),
    meanJitter: Number(tel.meanJitter || 0),
    maxJitter: Number(tel.maxJitter || 0),
    rmsJitter: Number(tel.rmsJitter || 0),
  };
}

function getState() {
  ensureActiveClip();
  let bakedFrameCount = activeClip.totalFrames;
  if (pipelineResult?.cleanedFrames && state.combatCurve.mode !== 'off') {
    const shouldCountBaked =
      state.combatCurve.mode === 'single' ||
      state.combatCurve.mode === 'autoMultiHit' ||
      (state.combatCurve.mode === 'auto' && Boolean(activeClip.isCombatAttack));
    if (shouldCountBaked) {
      bakedFrameCount = computeBakedFrameCount(
        pipelineResult.cleanedFrames,
        activeClip,
        state.combatCurve
      );
    }
  }

  return {
    activeMode: state.activeMode,
    workbenchActive: Boolean(state.workbenchActive),
    viewMode: state.viewMode,
    activeClipId: activeClip.id,
    activeClipName: activeClip.name,
    frameCount: activeClip.totalFrames,
    bakedFrameCount,
    fps: activeClip.fps,
    nonCyclic: Boolean(activeClip.nonCyclic),
    isCombatAttack: Boolean(activeClip.isCombatAttack),
    hasWeapon: Boolean(activeClip.hasWeapon),
    isPlaying: Boolean(state.playing),
    speed: SPEEDS[state.speedIdx],
    normalizedTime: state.normalizedTime,
    warpedNormalizedTime: state.warpedNormalizedTime,
    inHitstop: Boolean(state.inHitstop),
    lastCleanDurationMs: state.lastCleanDurationMs,
    cleanOptions: { ...state.cleanOptions },
    combatCurve: { ...state.combatCurve },
    visuals: { ...state.visuals },
    rawTelemetry: serializeTelemetry(pipelineResult?.rawTelemetry),
    cleanTelemetry: serializeTelemetry(pipelineResult?.cleanTelemetry),
    trimState: {
      hasVideo: Boolean(state.trimState.hasVideo),
      sourceUrl: state.trimState.sourceUrl,
      videoDuration: state.trimState.videoDuration,
      trimInSec: state.trimState.trimInSec,
      trimOutSec: state.trimState.trimOutSec,
      pendingTrimInSec: state.trimState.pendingTrimOutSec !== undefined ? state.trimState.pendingTrimInSec : 0,
      pendingTrimOutSec: state.trimState.pendingTrimOutSec,
      targetFps: state.trimState.targetFps,
    },
  };
}

function setWorkbenchActive(active) {
  const next = Boolean(active);
  state.workbenchActive = next;
  document.body.classList.toggle('workbench-inactive', !next);
  if (controls) {
    controls.enabled = next;
  }

  if (!next) {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    dropOverlay.hidden = true;
    pipVideo.pause?.();
  } else if (state.activeMode === 'workbench') {
    ensureWorkbenchRenderer();
    ensureActiveClip();
    handleResize();
    prevClock = performance.now();
    renderSingleFrame();
    if (rafId === null) {
      rafId = requestAnimationFrame(animate);
    }
  }
  return state.workbenchActive;
}

function syncStageModeTabUI(mode) {
  const isCombat = mode === 'combat';
  document.body.classList.toggle('mode-combat', isCombat);
  if (stageRootEl) {
    stageRootEl.dataset.activeMode = mode;
  }
  if (modeWorkbenchBtn) {
    modeWorkbenchBtn.classList.toggle('active', !isCombat);
    modeWorkbenchBtn.setAttribute('aria-selected', String(!isCombat));
  }
  if (modeCombatBtn) {
    modeCombatBtn.classList.toggle('active', isCombat);
    modeCombatBtn.setAttribute('aria-selected', String(isCombat));
  }
}

function setStageMode(requestedMode, options = {}) {
  const nextMode = requestedMode === 'combat' ? 'combat' : 'workbench';
  const updateHistory = options.updateHistory !== undefined ? Boolean(options.updateHistory) : true;

  state.activeMode = nextMode;
  syncStageModeTabUI(nextMode);

  if (updateHistory && typeof window !== 'undefined' && window.history?.replaceState) {
    try {
      const url = new URL(window.location.href);
      if (nextMode === 'combat') {
        url.searchParams.set('mode', 'combat');
      } else {
        url.searchParams.delete('mode');
      }
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // Ignore history errors in restricted origins
    }
  }

  if (nextMode === 'combat') {
    setWorkbenchActive(false);
    if (combatContainerEl) {
      combatContainerEl.hidden = false;
    }
    if (!combatArena && combatContainerEl) {
      combatArena = createCombatArena(combatContainerEl, {
        embedded: true,
        autoActive: true,
        exposeGlobal: true,
      });
      combatMountPromise = combatArena
        .mount()
        .then(() => {
          combatClipsReady = true;
          if (combatArena && state.activeMode !== 'combat') {
            combatArena.setActive(false);
          }
          return combatArena;
        })
        .catch((err) => {
          console.error('[MotionStage] Failed mounting Combat Arena:', err);
        });
    } else if (combatArena) {
      if (combatClipsReady) {
        combatArena.setActive(true);
      } else if (combatMountPromise) {
        combatMountPromise.then(() => {
          if (combatArena) {
            combatArena.setActive(state.activeMode === 'combat');
          }
        });
      }
    }
  } else {
    if (combatArena) {
      combatArena.setActive(false);
    }
    if (combatContainerEl) {
      combatContainerEl.hidden = true;
    }
    setWorkbenchActive(true);
  }

  return options.skipStateSnapshot ? null : getState();
}

function applyCleanOptionsPatch(partial = {}) {
  if (!partial || typeof partial !== 'object') return getState();
  ensureActiveClip();
  const prevClean = state.cleanOptions;
  const merged = { ...prevClean };
  const numericCleanKeys = new Set([
    'filterRadius',
    'contactHeightThresh',
    'contactVelThresh',
    'ikBlend',
    'floorY',
    'stanceRampRatio',
    'pelvisPullWeight',
    'seamRatio',
    'forearmTwistShare',
  ]);

  for (const key of Object.keys(DEFAULT_CLEAN_OPTIONS)) {
    if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;
    const rawVal = partial[key];
    if (key === 'filterSigma') {
      if (rawVal === null || rawVal === undefined) {
        merged.filterSigma = null;
      } else if (rawVal !== '' && typeof rawVal !== 'boolean' && Number.isFinite(Number(rawVal))) {
        merged.filterSigma = Number(rawVal);
      } else {
        // Non-null non-finite sigma falls back to previous finite sigma or finite auto-sigma
        merged.filterSigma = prevClean.filterSigma !== null ? prevClean.filterSigma : rawVal;
      }
    } else if (numericCleanKeys.has(key)) {
      if (rawVal !== null && rawVal !== undefined && rawVal !== '' && typeof rawVal !== 'boolean' && Number.isFinite(Number(rawVal))) {
        merged[key] = Number(rawVal);
      } else {
        merged[key] = prevClean[key];
      }
    } else {
      merged[key] = rawVal;
    }
  }
  state.cleanOptions = merged;

  // Re-retarget cached raw BVH text when preserveRootMotion changes so X/Z centering toggles live
  // while preserving custom targetFps, rootOriginMode, maxFrames, and groundAlign!
  if ('preserveRootMotion' in partial && activeClip.rawBVHText) {
    const nextPreserve =
      partial.preserveRootMotion !== null && partial.preserveRootMotion !== undefined
        ? Boolean(partial.preserveRootMotion)
        : Boolean(activeClip.preserveRootMotion);
    const prevRetarget = activeClip.retargetOptions || {};
    const reparsed = parseBVHTextToClip(
      activeClip.rawBVHText,
      activeClip.sourceFileName || 'Custom.bvh',
      {
        ...prevRetarget,
        targetFps: prevRetarget.targetFps || activeClip.fps || 60,
        id: activeClip.id,
        name: activeClip.name,
        syntheticSpeed: activeClip.syntheticSpeed,
        stabilizeInPlace: activeClip.stabilizeInPlace,
        hasWeapon: activeClip.hasWeapon,
        isCombatAttack: activeClip.isCombatAttack,
        cyclic: !Boolean(activeClip.nonCyclic),
        nonCyclic: Boolean(activeClip.nonCyclic),
        preserveRootMotion: nextPreserve,
      }
    );
    activeClip = reparsed;
    scrubberEl.max = String(Math.max(1, activeClip.totalFrames - 1));
  }

  recleanActiveClip();
  if (!state.playing) renderSingleFrame();
  return getState();
}

function applyCombatCurvePatch(partial = {}) {
  if (!partial || typeof partial !== 'object') return getState();
  ensureActiveClip();
  state.combatCurve = sanitizeCombatCurveOptions(
    { ...state.combatCurve, ...partial },
    state.combatCurve
  );
  workbenchPanel.syncState({
    combatCurve: state.combatCurve,
    lastCleanDurationMs: state.lastCleanDurationMs,
  });
  syncTelemetryHUD();
  if (!state.playing) renderSingleFrame();
  return getState();
}

function applyVisualsPatch(partial = {}) {
  if (!partial || typeof partial !== 'object') return getState();
  ensureActiveClip();
  state.visuals = {
    showSkinHeatmap:
      partial.showSkinHeatmap !== undefined
        ? Boolean(partial.showSkinHeatmap)
        : Boolean(state.visuals.showSkinHeatmap),
    showRawGhost:
      partial.showRawGhost !== undefined
        ? Boolean(partial.showRawGhost)
        : Boolean(state.visuals.showRawGhost),
  };
  cleanChar.setSkinningVisualState('prod', Boolean(state.visuals.showSkinHeatmap));
  rawChar.setSkinningVisualState('bad', Boolean(state.visuals.showSkinHeatmap));
  syncStageVisibility();
  workbenchPanel.syncState({ visuals: state.visuals });
  if (!state.playing) renderSingleFrame();
  return getState();
}

function loadClipFromBVHText(bvhText, fileName = 'Custom.bvh', options = {}) {
  if (!bvhText || typeof bvhText !== 'string') {
    throw new Error('BVH 内容为空');
  }
  const opts = options && typeof options === 'object' ? options : {};
  const clip = parseBVHTextToClip(bvhText, fileName, opts);

  pipBox.hidden = true;
  clearMediaPreview();

  if (opts.cleanOptions && typeof opts.cleanOptions === 'object') {
    state.cleanOptions = { ...state.cleanOptions, ...opts.cleanOptions };
    loadActiveClip(clip, opts.presetKey ?? clip.id, { preserveCleanToggles: true });
  } else {
    loadActiveClip(clip, opts.presetKey ?? clip.id, { preserveCleanToggles: false });
  }
  return getState();
}

function exportCurrentBVH(options = {}) {
  ensureActiveClip();
  if (!pipelineResult) return '';
  const opts = options && typeof options === 'object' ? options : {};
  const combatCurve = sanitizeCombatCurveOptions(
    { ...state.combatCurve, ...(opts.combatCurve || {}) },
    state.combatCurve
  );
  const bakeCombatCurve =
    opts.bakeCombatCurve !== undefined
      ? Boolean(opts.bakeCombatCurve)
      : Boolean(combatCurve.bakeOnExport) &&
        (combatCurve.mode === 'single' ||
          combatCurve.mode === 'autoMultiHit' ||
          (combatCurve.mode === 'auto' && Boolean(activeClip.isCombatAttack)));

  const bvhText = exportCleanedClipToBVH(activeClip, pipelineResult.cleanedFrames, {
    bakeCombatCurve,
    combatCurve,
  });

  if (opts.triggerDownload === true) {
    const blob = new Blob([bvhText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeClip.id}_cleaned.bvh`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return bvhText;
}

function setNormalizedTime(u, pause = false) {
  ensureActiveClip();
  if (pause) {
    state.playing = false;
    playPauseBtn.textContent = '播放';
  }
  state.normalizedTime = THREE.MathUtils.clamp(Number(u) || 0, 0, 1);
  const span = activeClip.nonCyclic
    ? Math.max(1, activeClip.totalFrames - 1)
    : Math.max(1, activeClip.totalFrames);
  scrubberEl.value = String((state.normalizedTime * span).toFixed(1));
  renderSingleFrame();
  return getState();
}

function setPlaying(flag) {
  state.playing = Boolean(flag);
  playPauseBtn.textContent = state.playing ? '暂停' : '播放';
  return getState();
}

function setViewMode(nextMode) {
  if (!['clean', 'raw', 'split'].includes(nextMode)) return getState();
  if (nextMode === state.viewMode) return getState();
  ensureActiveClip();
  const prevWasSplit = state.viewMode === 'split';
  state.viewMode = nextMode;
  trailHistory.length = 0;
  cleanClothSolver.reset(cleanChar.bones);
  syncStageVisibility();
  if (prevWasSplit !== (nextMode === 'split')) {
    glideCameraToViewMode(nextMode);
  }
  if (!state.playing) renderSingleFrame();
  return getState();
}

// --- Boot Default Clip & Start Render Loop (or Combat Arena via ?mode=combat) ---
const initialModeParam = new URLSearchParams(window.location.search).get('mode');
const bootMode = initialModeParam === 'combat' ? 'combat' : 'workbench';
if (bootMode === 'combat') {
  state.workbenchActive = false;
  setStageMode('combat', { updateHistory: false, skipStateSnapshot: true });
} else {
  ensureWorkbenchRenderer();
  loadActiveClip(presets.slash, 'slash');
  syncStageModeTabUI('workbench');
  prevClock = performance.now();
  rafId = requestAnimationFrame(animate);
}

// Expose Contract 4 Public Workbench Handle synchronously on window
window.__MOTION_STAGE__ = {
  setStageMode,
  setWorkbenchActive,
  getState,
  setCleanOptions: applyCleanOptionsPatch,
  setCombatCurve: applyCombatCurvePatch,
  setVisuals: applyVisualsPatch,
  loadClipFromBVHText,
  exportCurrentBVH,
  setNormalizedTime,
  setPlaying,
  setViewMode,
  async loadAssetById(id) {
    const item = findAssetInCatalog(assetCatalog, id);
    if (!item) throw new Error(`未找到资产: ${id}`);
    if (assetSelectEl) assetSelectEl.value = item.id;
    return loadCatalogAssetItem(item);
  },
  async extractVideoSegment(url, opts = {}) {
    await runVideoExtractionWorkflow({
      sourceKind: 'url',
      urls: Array.isArray(url) ? url : [url],
      label: opts.label || opts.name || '视频截取提取',
      clipId: opts.id || opts.clipId || 'video_segment',
      hasWeapon: opts.hasWeapon !== undefined ? Boolean(opts.hasWeapon) : true,
      isCombatAttack: Boolean(opts.isCombatAttack),
      nonCyclic: opts.nonCyclic !== undefined ? Boolean(opts.nonCyclic) : true,
      trimInSec: opts.trimInSec ?? 0,
      trimOutSec: opts.trimOutSec ?? null,
      targetFps: opts.targetFps ?? 24,
      presetKey: opts.presetKey ?? null,
    });
    return getState();
  },
  async refreshAssetLibrary() {
    assetCatalog = await fetchAssetCatalog();
    populateAssetSelectElement(assetSelectEl, assetCatalog, assetSelectEl?.value || '');
    return assetCatalog;
  },
  getAssetCatalog: () => assetCatalog.map((x) => ({ ...x })),
};
