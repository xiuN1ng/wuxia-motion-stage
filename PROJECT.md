# Project: Wuxia Action AI Motion Pipeline (MotionStage & Playable Combat Prototype)

## Architecture
- **Overview**: End-to-end 3D skeletal animation production pipeline and playable Wuxia Action Roguelike verification stage built on **Three.js (`^0.187.0`) + MediaPipe Pose Landmarker Heavy (`@mediapipe/tasks-vision ^1.2.3`) + Vite (`^8.3.6`)**, producing and consuming industry-standard **21-bone Humanoid `.bvh` (`cm` units, `ZXY` Euler order, 66 channels)** assets compatible with Blender (`Scale 0.01`), Unity Humanoid, and UE5 Mannequin.
- **Module Boundaries & Data Flow**:
  1. **Core Pipeline & MotionStage Workbench (`motion-stage/src/{anim,capture,pipeline,ui}/`, `src/main.js`, `index.html`, `src/style.css`, `vite.config.js`) — Milestone M1**:
     - `VideoPoseCapture.js`: Offline WASM/Heavy model loading (auto-selecting `'CPU'` XNNPACK delegate on SwiftShader/software WebGL for 8.5× speedup, monotonic `lastVideoTimestampMs`), video metadata probing, `[trimInSec, trimOutSec]` & `targetFps` (`24/30/60`) sampling, 6-DoF palm sword-axis solver (`zBlade = (-0.619, 0.754, 0.219)`), chest anti-penetration, and metric floor/scale calibration.
     - `MotionClips.js`: 21-bone `BVH_TARGET_CANDIDATES` retargeter (`calf_r` fix, `LeftToe`/`RightToe`, UE5/Unity/Mixamo/Rigify `.L/.R`), uncapped duration (`maxFrames = Infinity`), optional `preserveRootMotion` (Frame-0 X/Z origin anchoring), and `nonCyclic` detection.
     - `MotionCleaner.js` & `TwoBoneIK.js`: Parameterized `runCleaningPipeline(clip, options)` (`DEFAULT_CLEAN_OPTIONS`: zero-phase Gaussian filter, loop closure, Two-Bone analytic leg IK foot-lock, forearm 58% twist, `SpringClothSolver`), parameterized `remapCombatTime` (`off` / `single` / `autoMultiHit`), `nonCyclic`-safe `sampleInterpolatedFrame`, and reference-contact-aware `analyzeMotionTelemetry` (`slipSeries`, `jitterSeries`, RMS/max stats).
     - `BVHExporter.js`: `bakeWarpedFrames` + `exportCleanedClipToBVH(clip, frames, options)` baking wind-up compression & hit-stop curves via quaternion `slerp` + root `lerp` into discrete 21-bone `cm`/`ZXY` `.bvh` frames.
     - Workbench UI (`src/ui/*`, `main.js`, `index.html`): Video In/Out Trim bar + PiP frame scrubbing, Filter & Foot-Lock live re-clean panel (`<15ms`, zero MediaPipe re-inference), Combat Curve & Bake controls, high-DPI Canvas Telemetry HUD, Built-in Asset Library selector, and `window.__MOTION_STAGE__` public API.
  2. **Batch BVH Asset Production & Cloud Sync (`motion-stage/scripts/`, `bvh_library/`, `reference_videos/`, Google Drive `02/C`) — Milestone M2**:
     - Headless Chromium (`/usr/lib/chromium/chromium`, `TMPDIR` & `--user-data-dir` on `0700` `/dev/shm/<ephemeral>`, SwiftShader WebGL2 + `'CPU'` XNNPACK delegate) + Node v24 native `WebSocket` CDP batch pipeline (`scripts/batch_extract.mjs`) extracting `01b`–`04` Taibai `.mp4` clips into `/home/antigravity/bvh_library/C_taibai_extracted/` and syncing `05` master video from Google Drive (`1MowvRZDlaoYf1PjIfp0Gl9ViOFyTt47B`).
     - Validated one-shot upload (or in-place `gdrive mutate update` by file ID, respecting `canDeleteChildren: false`) of the 4 Taibai `.bvh` files to Google Drive `02/C_AI视频提取成品_天刀太白招式BVH` (`1xxXXnYg3GVk9zAKrQMSuIPG8JjjESu0v`).
     - Authentic optical mocap batch retargeting & Wuxia posture/IK cleaning (`scripts/produce_mvp_bvh.mjs`) from verified public-domain `una-dinosauria/cmu-mocap` trials (saved in `bvh_library/A_raw_mocap/cmu_*.bvh`) into 16 new cleaned 60fps 21-bone `.bvh` clips in `/home/antigravity/bvh_library/B_cleaned_ready/` (`07` 8-way strafe `F/B/L/R/FL/FR/BL/BR`, `08` 苍龙出水突刺, `09` 翻滚闪避, `10` 二段轻功跳, `11`/`12` 左右轻受击, `13`/`14`/`15` 击飞倒地与鲤鱼打挺起身) + `bvh_library/MANIFEST.json`.
  3. **Playable Wuxia Roguelike Combat Prototype (`motion-stage/src/combat/`, `motion-stage/combat.html`) — Milestone M3**:
     - `CombatStateMachine.js`: Pure-ESM deterministic 15+ state Wuxia action FSM with priority tiers, 180ms input buffer, combo chain windows, dodge-cancel windows, `Skill_Wuhen` parry/deflect counter window, `Hit_Knockdown -> KipUp` recovery, and circular arena root-motion clamping (`R = 8.5m`).
     - `LayeredAnimator.js`: 21-bone Upper/Lower body mask (`Hips` + `Legs` = `0.0` lower base; `Spine` = `0.55`, `Chest` = `0.85`, `Neck/Head/Shoulders/Arms/Hands` = `1.0` upper override) with pelvis counter-yaw compensation (enabling moving/8-way strafing while slashing!), quaternion `slerp` crossfading, `applyForearmTwistSolver`, and `SpringClothSolver`.
     - `CombatArenaApp.js`, `CombatClipRegistry.js`, `EnemyDummy.js`, `CombatCamera.js`, `CombatVFX.js`, `CombatHUD.js`: Interactive 3D arena (`setSkinningVisualState('prod', false)`), WASD/Mouse/Skill controls, `Tab` camera lock-on, 3-mode AI sparring dummy (Passive / Light Counter / Heavy Knockdown), swept `swordGroup` blade hitboxes, hit-stop freeze frames, live State & Layer Blend HUD, and `window.__COMBAT_ARENA__` API.
  4. **Cross-Track Stage Integration & Git/GitHub Repository (`main.js` mode switcher, `vite.config.js` static asset serving, `/home/antigravity/.git`, `.gitignore`, `README.md`) — Milestone M4**:
     - Unified top-bar switcher on `http://localhost:5173/` (`🛠 动作生产工作台` ↔ `⚔️ 武侠肉鸽战斗验证台`, plus `?mode=combat` & `/combat.html`), wiring all 26 cleaned `.bvh` files (`B_cleaned_ready` `01`–`15` + `C_taibai_extracted` `taibai_01b`–`04`) and `01b`–`05` videos across both Workbench presets and `CombatClipRegistry.js`, verified via `npm run build` and live `:5173`.
     - Local Git repository at `/home/antigravity` with strict `$HOME` root-allowlist `.gitignore` (`/*` + `!` project paths), `README.md`, `LICENSE-CC-BY-3.0.md`, structured commits, and GitHub remote push/readiness check.
  5. **E2E Testing Track & Final Hardening (`/home/antigravity/tests/e2e/`, `TEST_INFRA.md`, `TEST_READY.md`) — E2E Track & Milestone M5**:
     - Requirement-driven opaque-box test suite across Tiers 1–4 (`node /home/antigravity/tests/e2e/run_e2e.mjs --tier 1|2|3|4|all`) covering 100% of `Feature Inventory`, followed by M5 Phase 1 (100% pass Tiers 1→4) and Phase 2 (Tier 5 white-box adversarial hardening).

## Feature Inventory
Every Survey feature assigned a milestone (none unassigned).
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | `F1: Taibai 01b–04 Batch BVH Extraction` | Batch-extract & clean `01b`, `02`, `03` (full 5.125s), and `04` reference videos via authentic MediaPipe Heavy + 5-stage pipeline into 4 standard 21-bone `cm`/`ZXY` `.bvh` files in `bvh_library/C_taibai_extracted/`. | M2 | `ORIGINAL_REQUEST`, `survey_1`, `survey_2` |
| 2 | `F2: Google Drive 02/C Sync & Master Video Fetch` | Download `05_北京武术队2012巡演完整母带_720p_CC-BY-3.0.mp4` (`1MowvRZDlaoYf1PjIfp0Gl9ViOFyTt47B`) into `reference_videos/` and upload the 4 validated Taibai `.bvh` files to Google Drive `02/C` (`1xxXXnYg3GVk9zAKrQMSuIPG8JjjESu0v`, respecting `canDeleteChildren: false`). | M2 | `ORIGINAL_REQUEST`, `survey_1` |
| 3 | `F3: MVP Locomotion & Dodge BVH Expansion` | Produce standard 21-bone 60fps `.bvh` files in `bvh_library/B_cleaned_ready/` from verified real CMU mocap trials (`una-dinosauria/cmu-mocap`, archived in `A_raw_mocap/`): 8-way strafe (`07_wuxia_strafe_{F,B,L,R,FL,FR,BL,BR}`), forward dash thrust (`08_wuxia_dash_canglong_苍龙出水突刺`), dodge roll (`09_wuxia_dodge_roll_翻滚闪避`), and double jump (`10_wuxia_double_jump_二段轻功跳`). | M2 | `ORIGINAL_REQUEST`, `docs/02`, `survey_1` |
| 4 | `F4: MVP Hit-React & Kip-Up BVH Expansion` | Produce standard 21-bone 60fps `.bvh` files in `bvh_library/B_cleaned_ready/` from verified CMU mocap trials: `11_wuxia_hit_light_L_左轻受击`, `12_wuxia_hit_light_R_右轻受击`, `13_wuxia_knockdown_击飞倒地`, `14_wuxia_kipup_鲤鱼打挺起身`, and combined `15_wuxia_knockdown_kipup_击飞倒地接鲤鱼打挺`. | M2 | `ORIGINAL_REQUEST`, `docs/02`, `survey_1` |
| 5 | `F5: BVH Retargeter & Root Motion Fix` | Fix `MotionClips.js` `RightLeg` regex (`calf_l` → `calf_r`), map all 21 bones (`LeftToe`/`RightToe`, UE5 `spine_01..03`/`neck_01`/`ball_l,r`, Unity, Mixamo, Rigify `.L/.R`), remove hardcoded 240-frame cap, add `preserveRootMotion` option, and fix `parseBVHTextToClip` `nonCyclic` detection. | M1 | `ORIGINAL_REQUEST`, `survey_1`, `survey_2` |
| 6 | `F6: Long-Video In/Out Trim & Capture Upgrade` | Add `trimInSec`, `trimOutSec`, `targetFps` (`24/30/60`), `probeVideoSource`, monotonic timestamp watermark, and software-WebGL auto-`'CPU'` delegate in `VideoPoseCapture.js`, plus interactive UI trim slider/steppers and PiP video scrubbing sync. | M1 | `ORIGINAL_REQUEST`, `survey_2` |
| 7 | `F7: Filter & Foot-Lock Parameter Panel` | Expose `DEFAULT_CLEAN_OPTIONS` (`deJitter`, `filterRadius`, `filterSigma`, `footLock`, `contactMode`, `contactHeightThresh`, `contactVelThresh`, `ikBlend`, `keepFootFlat`, `loopClean`, `preserveRootMotion`, `forearmTwistShare`) in `MotionCleaner.js`/`TwoBoneIK.js` and interactive Workbench UI with `<15ms` live re-clean. | M1 | `ORIGINAL_REQUEST`, `survey_2` |
| 8 | `F8: Wind-Up Compression & Hit-Stop BVH Baking` | Parameterize `remapCombatTime` (`off`/`single`/`autoMultiHit`, `windupEnd`, `windupSpeed`, `strikeEnd`, `strikeSpeed`, `hitstopFrames`, `recoverySpeed`), fix `sampleInterpolatedFrame` `nonCyclic` end-wrap bug, and bake warped timing into exported `.bvh` via `bakeWarpedFrames` / `exportCleanedClipToBVH`. | M1 | `ORIGINAL_REQUEST`, `docs/02`, `survey_2` |
| 9 | `F9: Foot-Slip/Jitter Telemetry HUD & Asset Selector` | Fix `analyzeMotionTelemetry` null-contact bug so raw vs cleaned slip (`cm/s`) & jitter compute accurately, render high-DPI interactive `<canvas>` Telemetry HUD synced with playhead, and add categorized Built-in Asset Library selector in Workbench. | M1 | `ORIGINAL_REQUEST`, `survey_2` |
| 10 | `F10: Playable Wuxia Character Action State Machine` | Implement pure-ESM `CombatStateMachine.js` with 15+ states (`Idle`, `Move_8Way`, `Sprint`, `Dodge_Dash`, `Dodge_Roll`, `Jump`, `Air_Jump_Double`, `Evade_Backflip`, `Attack_Combo_1..3`, `Skill_Wuhen`, `Skill_Yuluo`, `Skill_Feiyan`, `Skill_Kick`, `Hit_Light_L/R`, `Hit_Knockdown`, `KipUp`), input buffer, cancel/parry/i-frame windows, and root-motion arena clamping. | M3 | `ORIGINAL_REQUEST`, `docs/02`, `survey_3` |
| 11 | `F11: Upper/Lower Body Layered Blending & 3D Combat Arena` | Implement 21-bone `LayeredAnimator.js` (`Spine: 0.55`, `Chest: 0.85`, `Arms/Head: 1.0` + pelvis counter-yaw + ForeArm twist & SpringCloth) and interactive 3D `CombatArenaApp.js` (WASD/Mouse/Skills, `Tab` lock-on 8-way strafe, 3-mode AI sparring dummy, swept sword hitboxes, hit-stop VFX, Combat HUD). | M3 | `ORIGINAL_REQUEST`, `docs/02`, `survey_3` |
| 12 | `F12: Unified Workbench/Combat Integration & Git/GitHub Repo` | Wire seamless Workbench ↔ Combat Arena mode switching on `http://localhost:5173`, connect all 26 `bvh_library` clips & `01b`–`05` videos across both modes (`vite.config.js` dev + `dist/` build), and initialize clean Git repository at `/home/antigravity` with `$HOME` root-allowlist `.gitignore`, `README.md`, `LICENSE-CC-BY-3.0.md`, structured commits, and GitHub push check. | M4 | `ORIGINAL_REQUEST`, `survey_1`, `survey_3` |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | `M1: Core Pipeline & MotionStage Workbench Upgrade (Dir 2)` | Implement `F5`, `F6`, `F7`, `F8`, `F9` across `MotionClips.js`, `VideoPoseCapture.js`, `MotionCleaner.js`, `TwoBoneIK.js`, `BVHExporter.js`, `src/ui/*`, `main.js`, `index.html`, `style.css`, and `vite.config.js`. | none | IN_PROGRESS (`31900a4f81650fe57b6729344821a8e4`) |
| 2 | `M2: Batch BVH Production, MVP Expansion & Drive Sync (Dir 1)` | Implement `F1`, `F2`, `F3`, `F4`: sync `05` master video, batch-extract `01b`–`04` via authentic headless Chromium + MediaPipe Heavy to `C_taibai_extracted/` & upload once validated to Drive `02/C` (`1xxXXnYg3GVk9zAKrQMSuIPG8JjjESu0v`), and produce 16 verified CMU-derived MVP `.bvh` files (`07`–`15`) in `B_cleaned_ready/` + `MANIFEST.json`. | none | IN_PROGRESS (`d41c90d4a647baabe390a0a4f563ac88`) |
| 3 | `M3: Playable Wuxia Roguelike Combat Prototype (Dir 3A)` | Implement `F10`, `F11` under `motion-stage/src/combat/*` and standalone `motion-stage/combat.html`: 15+ state FSM, 21-bone Spine/Chest feathered Upper/Lower layered blending, lock-on 8-way strafe, 3-mode AI dummy, hitboxes/hit-stop VFX, Combat HUD, and `window.__COMBAT_ARENA__`. | none | IN_PROGRESS (`5434b1967348383da5738551cb3262cc`) |
| 4 | `M4: Unified Stage Integration & Git/GitHub Version Control (Dir 3B)` | Implement `F12`: wire Workbench ↔ Combat Arena mode switcher on `index.html`/`main.js` (`?mode=combat`), verify all 26 `bvh_library` `.bvh` files + `01b`–`05` videos load cleanly in both Workbench & Combat Arena in dev (`:5173`) and `npm run build`, and initialize Git repo (`/home/antigravity/.git`, root-allowlist `.gitignore`, `README.md`, `LICENSE-CC-BY-3.0.md`, structured commits + GitHub remote check). | M1, M2, M3 | PLANNED |
| 5 | `M5: Final Milestone — Full E2E Pass (Tiers 1–4) & Tier 5 Hardening` | Phase 1: Pass 100% of E2E tests sequentially across Tier 1 → Tier 2 → Tier 3 → Tier 4 (`TEST_READY.md`) with full whole-project Forensic Audit. Phase 2: White-box Tier 5 adversarial coverage hardening loop (`Challenger → Worker → Reviewer + Auditor`) until zero gaps remain. | M4, E2E_Track (`ef3a1de89e623aac61621703007a0604`) | PLANNED |

## Interface Contracts

### 1. Canonical 21-Bone BVH & Internal Runtime Frame Contract (`All Modules`)
- **Runtime Rig (`HumanoidRig.js` — READ-ONLY in M1/M2/M3)**:
  - `BONE_DEFS` (`length === 29`), `BONE_IDX` (`Hips: 0`, `Spine: 1`, `Chest: 2`, `Neck: 3`, `Head: 4`, `LeftShoulder..LeftHand: 5..9` [with `LeftForeArmTwist: 8`], `RightShoulder..RightHand: 10..14` [with `RightForeArmTwist: 13`], `LeftUpLeg..LeftToe: 15..18`, `RightUpLeg..RightToe: 19..22`, `SkirtFront/Back: 23..24`, `Cape01..04: 25..28`).
  - `buildCharacterRig()` initializes in `'bad'` skinning mode; production characters MUST call `rig.setSkinningVisualState('prod', false)`.
  - Frame object schema: `{ rootPos: THREE.Vector3, quats: THREE.Quaternion[29], contactL: boolean|null, contactR: boolean|null, lockWeightL?: number, lockWeightR?: number }`.
- **Standard 21-Bone `.bvh` File Contract (`BVHExporter.js` & `bvh_library/**/*.bvh`)**:
  - Exactly **21 joints** (`EXPORT_BONE_INDICES`, excluding Twist & Cloth bones), **66 channels per frame** (`ROOT Hips`: `6` channels `Xposition Yposition Zposition Zrotation Xrotation Yrotation` in `cm` [`pos * 100`]; 20 child `JOINT`s: `3` channels `Zrotation Xrotation Yrotation` in degrees), zero `NaN`/`Infinity` values, `Frames: <N>` matching exact motion data line count.

### 2. Standardized Asset Naming & Manifest Contract (`M2` ↔ `M1`, `M3`, `M4`, `E2E`)
- **Taibai Video-Extracted BVHs (`/home/antigravity/bvh_library/C_taibai_extracted/` & Google Drive `02/C` `1xxXXnYg3GVk9zAKrQMSuIPG8JjjESu0v`)**:
  1. `taibai_01b_崖顶横剑定势_cleaned.bvh` (`cyclic`, `hasWeapon: true`, from `01b`)
  2. `taibai_02_无痕剑意_独立提膝云剑_cleaned.bvh` (`nonCyclic`, `hasWeapon: true`, from `02`)
  3. `taibai_03_雨落云飞_快剑五连斩_cleaned.bvh` (`nonCyclic`, `hasWeapon: true`, full ~5.125s from `03`)
  4. `taibai_04_飞燕逐月_腾空旋风跌叉_cleaned.bvh` (`nonCyclic`, `hasWeapon: true`, from `04`)
- **Expanded Wuxia Roguelike MVP BVHs (`/home/antigravity/bvh_library/B_cleaned_ready/`)** (preserving existing `01`–`06` untouched):
  - `07_wuxia_strafe_F_前垫步_cleaned.bvh`, `07_wuxia_strafe_B_后撤步_cleaned.bvh`, `07_wuxia_strafe_L_左垫步_cleaned.bvh`, `07_wuxia_strafe_R_右垫步_cleaned.bvh`, `07_wuxia_strafe_FL_左前垫步_cleaned.bvh`, `07_wuxia_strafe_FR_右前垫步_cleaned.bvh`, `07_wuxia_strafe_BL_左后垫步_cleaned.bvh`, `07_wuxia_strafe_BR_右后垫步_cleaned.bvh` (`cyclic`, `Loco_Strafe_8Way`)
  - `08_wuxia_dash_canglong_苍龙出水突刺_cleaned.bvh` (`nonCyclic`, forward `+Z` Root Motion preserved, `Dodge_Dash_Fwd`)
  - `09_wuxia_dodge_roll_翻滚闪避_cleaned.bvh` (`nonCyclic`, forward `+Z` Root Motion preserved, `Dodge_Roll`)
  - `10_wuxia_double_jump_二段轻功跳_cleaned.bvh` (`nonCyclic`, airborne vertical arc, `Air_Jump_Double`)
  - `11_wuxia_hit_light_L_左轻受击_cleaned.bvh` & `12_wuxia_hit_light_R_右轻受击_cleaned.bvh` (`nonCyclic`, `Hit_Light_L/R`)
  - `13_wuxia_knockdown_击飞倒地_cleaned.bvh`, `14_wuxia_kipup_鲤鱼打挺起身_cleaned.bvh`, `15_wuxia_knockdown_kipup_击飞倒地接鲤鱼打挺_cleaned.bvh` (`nonCyclic`, `Hit_Knockdown` & `KipUp`)
- **Asset Manifest (`/home/antigravity/bvh_library/MANIFEST.json`)**:
  - JSON array/object listing `{ id, category, label, path, archetype, cyclic, hasWeapon, preserveRootMotion, frames, fps, durationSec, sourceProvenance, driveFileId? }` so both Workbench (`M1`/`M4`) and `CombatClipRegistry.js` (`M3`/`M4`) + E2E tests discover all clips deterministically.

### 3. Core Pipeline Module Signatures (`M1` ↔ `M4` & `E2E`)
- `MotionClips.js`:
  - `BVH_TARGET_CANDIDATES`: 21 entries covering all `EXPORT_BONE_INDICES`, with `RightLeg` matching `calf_r` (never `calf_l`), `Hips` prioritizing `pelvis|hips` ahead of `root`, and `LeftToe`/`RightToe` included.
  - `retargetBVHToFrames(bvhText, targetFps = 60, options = { preserveRootMotion: false, rootOriginMode: 'start', maxFrames: Infinity }) -> Frame[]`
  - `parseBVHTextToClip(bvhText, fileName = 'Custom.bvh', options = {}) -> Clip` (defaults `preserveRootMotion: true` for custom/external BVHs and auto-sets `nonCyclic` unless cyclic filename/option).
- `VideoPoseCapture.js`:
  - `probeVideoSource(urlOrFile) -> Promise<{ mediaUrl, videoDuration, width, height, ownedObjectUrl }>`
  - `extractClipFromVideoSource(source, onProgress, options = { trimInSec: 0, trimOutSec: null, targetFps: 24, nonCyclic: true, isCombatAttack: false, delegate: 'auto' })`
  - `extractClipFromVideoFile(file, onProgress, options)` & `extractClipFromVideoUrl(url, label, onProgress, options)`
- `MotionCleaner.js` & `BVHExporter.js`:
  - `DEFAULT_CLEAN_OPTIONS`, `DEFAULT_COMBAT_CURVE`
  - `runCleaningPipeline(clip, options = {}) -> { cleanedFrames, rawTelemetry, cleanTelemetry, appliedOptions }`
  - `analyzeMotionTelemetry(frames, fps, cyclic = true, referenceFrames = null) -> { slipSeries, jitterSeries, meanSlip, maxSlip, rmsSlipCmS, maxSlipCmS, meanJitter, maxJitter, rmsJitter }`
  - `remapCombatTime(u, isCombatAttack, enabled = true, nonCyclic = false, curveOptions = {}, frames = null, fps = 60) -> { warpedU, inHitstop }`
  - `bakeWarpedFrames(frames, clip, curveOptions = {}) -> Frame[]`
  - `exportCleanedClipToBVH(clip, frames, options = { bakeCombatCurve: false, combatCurve: {} }) -> string`

### 4. Workbench ↔ Combat Arena & Browser E2E Contract (`M1` ↔ `M3` ↔ `M4` ↔ `E2E`)
- **Vite Static Asset Serving (`motion-stage/vite.config.js`)**:
  - Serves `/home/antigravity/bvh_library/**` at `/bvh_library/...` and `/home/antigravity/reference_videos/**` at `/reference_videos/...` (supporting HTTP `206 Partial Content` `Range: bytes=...` for video seeking!) in dev server AND copies `bvh_library/` into `dist/bvh_library/` during `vite build` (multi-page Rollup input: `index.html` and `combat.html` if `combat.html` exists).
- **Workbench Lifecycle & E2E Handle (`window.__MOTION_STAGE__` in `src/main.js`)**:
  - `setWorkbenchActive(active: boolean)`: pauses/resumes Workbench rAF rendering & global keyboard/drop listeners and toggles Workbench floating UI visibility.
  - `getState()`: returns `{ activeMode, activeClipId, frameCount, fps, isPlaying, normalizedTime, cleanOptions, combatCurve, rawTelemetry, cleanTelemetry, trimState }`.
  - `setCleanOptions(partial)` / `setCombatCurve(partial)` / `loadClipFromBVHText(bvhText, fileName, options)` / `exportCurrentBVH()`.
- **Combat Arena Lifecycle & E2E Handle (`src/combat/CombatArenaApp.js` & `window.__COMBAT_ARENA__`)**:
  - `createCombatArena(containerEl, options)` -> `{ mount(), setActive(active), step(dt), dispatchAction(action, payload), getState(), destroy() }`.
  - `window.__COMBAT_ARENA__.getState()`: returns `{ active, currentState, stateNormalizedTime, priority, isInvulnerable, inParryWindow, canComboChain, baseClipId, upperClipId, upperLayerAlpha, boneLayerWeights, playerWorldPos, playerYaw, isLockedOn, dummyMode, dummyHp, dummyPoise, comboCount, hitstopRemainingMs, loadedClipIds }`.

### 5. Headless Chromium VM Execution Contract (`All Subagents — Mandatory`)
- `/home/antigravity/.gemini` symlinks onto `virtiofs` (`0777`), causing Chromium `ProcessSingleton` `SIGTRAP` if `TMPDIR` or `--user-data-dir` resides there.
- Every headless `/usr/lib/chromium/chromium` launch MUST allocate an ephemeral `0700` directory on `/dev/shm/<prefix>_<random>` (`chmod 700`, removed in `finally` block) for `TMPDIR` and `--user-data-dir`, and pass:
  `--headless=new --no-sandbox --disable-gpu-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --use-gl=angle --use-angle=swiftshader-webgl --enable-webgl --ignore-gpu-blocklist --enable-unsafe-swiftshader --mute-audio`.

## Code Layout
Strict exclusive write ownership during concurrent Wave 1 execution (`M1 || M2 || M3 || E2E_Track`):
- **Shared Read-Only in Wave 1**:
  - `/home/antigravity/motion-stage/package.json`, `package-lock.json`
  - `/home/antigravity/motion-stage/src/rig/HumanoidRig.js`
  - `/home/antigravity/motion-stage/public/mediapipe/**`, `public/demo/**`, `public/mocap/**`
  - `/home/antigravity/bvh_library/B_cleaned_ready/01_*.bvh` .. `06_*.bvh`
  - `/home/antigravity/docs/**`
- **`M1` (Direction 2 Workbench & Pipeline)**:
  - `/home/antigravity/motion-stage/src/anim/MotionClips.js`
  - `/home/antigravity/motion-stage/src/capture/VideoPoseCapture.js`
  - `/home/antigravity/motion-stage/src/pipeline/MotionCleaner.js`
  - `/home/antigravity/motion-stage/src/pipeline/TwoBoneIK.js`
  - `/home/antigravity/motion-stage/src/pipeline/BVHExporter.js`
  - `/home/antigravity/motion-stage/src/ui/**`
  - `/home/antigravity/motion-stage/src/main.js`, `src/style.css`, `index.html`, `vite.config.js`
  - `/home/antigravity/motion-stage/tests/unit_workbench/**`
- **`M2` (Direction 1 Batch Asset Production & Drive Sync)**:
  - `/home/antigravity/motion-stage/scripts/**` (`batch_extract.mjs`, `produce_mvp_bvh.mjs`, `verify_bvh_library.mjs`)
  - `/home/antigravity/reference_videos/05_北京武术队2012巡演完整母带_720p_CC-BY-3.0.mp4` (and `01_*.mp4` if synced)
  - `/home/antigravity/bvh_library/A_raw_mocap/cmu_*.bvh` (fetched raw CMU mocap provenance files)
  - `/home/antigravity/bvh_library/B_cleaned_ready/07_*.bvh` .. `15_*.bvh`
  - `/home/antigravity/bvh_library/C_taibai_extracted/*.bvh` + `/home/antigravity/bvh_library/MANIFEST.json`
  - Google Drive `02/C` (`1xxXXnYg3GVk9zAKrQMSuIPG8JjjESu0v`)
  - `/home/antigravity/motion-stage/tests/unit_assets/**`
- **`M3` (Direction 3A Playable Combat Prototype)**:
  - `/home/antigravity/motion-stage/src/combat/**`
  - `/home/antigravity/motion-stage/combat.html`
  - `/home/antigravity/motion-stage/tests/unit_combat/**`
- **`M4` (Direction 3B Unified Integration & Git/GitHub Repo — runs AFTER M1, M2, M3)**:
  - Cross-module wiring in `motion-stage/index.html`, `src/main.js`, `src/combat/CombatClipRegistry.js`, `vite.config.js`
  - `/home/antigravity/.git`, `/home/antigravity/.gitignore`, `/home/antigravity/README.md`, `/home/antigravity/LICENSE-CC-BY-3.0.md`
- **`E2E Testing Track`**:
  - `/home/antigravity/TEST_INFRA.md`, `/home/antigravity/TEST_READY.md`
  - `/home/antigravity/tests/e2e/**`
