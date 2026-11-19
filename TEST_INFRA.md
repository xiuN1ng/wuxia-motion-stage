# Wuxia Action Roguelike AI Motion Pipeline — E2E Test Infrastructure (`TEST_INFRA.md`)

## 1. Test Philosophy & Sandbox Invariants

The end-to-end verification suite in `/home/antigravity/tests/e2e/` validates the complete **Wuxia Action Roguelike AI Motion Pipeline (MotionStage)** across all three user-requested directions against the authoritative public contracts in `/home/antigravity/PROJECT.md` and `/home/antigravity/.agents/teamwork/ORIGINAL_REQUEST.md`:

1. **Requirement-Driven Opaque-Box Verification**:
   - Every test targets documented public contracts (`bvh_library/**` 21-bone/66-channel files and `MANIFEST.json`, Google Drive `02/C` `1xxXXnYg3GVk9zAKrQMSuIPG8JjjESu0v` & master video `05` `1MowvRZDlaoYf1PjIfp0Gl9ViOFyTt47B`, `MotionClips.js`, `VideoPoseCapture.js`, `MotionCleaner.js`, `TwoBoneIK.js`, `BVHExporter.js`, `CombatStateMachine.js`, `LayeredAnimator.js`, `window.__MOTION_STAGE__`, `window.__COMBAT_ARENA__`, Vite static/build endpoints, and root `/home/antigravity/.git`).
   - **Zero SUT Mocking / Zero Premature Pass Forcing**: No production algorithm, MediaPipe WASM inference, Three.js WebGL2 renderer, `gdrive` CLI, `ffprobe`/`ffmpeg` decode, or Git command is mocked or stubbed. Zero `{ skip: true }`, zero `{ todo: true }`, and zero vacuous assertions exist anywhere in the suite. Missing in-flight deliverables fail cleanly via descriptive `assert.fail(...)` messages with `CRASH=0`.
2. **Zero External Test-Runner Dependencies**:
   - Runs natively on **Node.js `v24.22.3`** (`node:test`, `node:assert/strict`, native `fetch`, native `WebSocket` CDP) without creating `/home/antigravity/package.json`.
   - Imports `THREE` and `BVHLoader` from `/home/antigravity/motion-stage/node_modules/three/` so `instanceof THREE.Vector3` / `THREE.Quaternion` singleton identity holds across out-of-tree `.mjs` tests and `motion-stage/src/**`.
3. **Strict `/dev/shm` `0700` Sandbox & Zero Workspace/Cloud Mutation**:
   - `helpers/browser_cdp.mjs` launches headless `/usr/lib/chromium/chromium` with `TMPDIR` and `--user-data-dir` inside an ephemeral `0o700` `/dev/shm/e2e_cdp_<pid>_<rand>` directory using all mandatory flags (`--headless=new --no-sandbox --disable-gpu-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --use-gl=angle --use-angle=swiftshader-webgl --enable-webgl --ignore-gpu-blocklist --enable-unsafe-swiftshader --mute-audio`).
   - `closeSharedBrowser()` kills the Chromium process group, sweeps `/proc` for any surviving subprocess referencing `shmDir`, and removes `/dev/shm/e2e_cdp_*`.
   - Production build verification (`T1-F12-06`, `T3-X20`, `T4-E2E-09`) outputs exclusively to `/dev/shm/e2e_dist_<pid>_<rand>` without mutating `/home/antigravity/motion-stage/dist`.
   - Google Drive verification (`F2`, `T3-X01`, `T4-E2E-02`) uses strictly read-only `/opt/antigravity/bin/gdrive readonly ...` commands and ephemeral `/dev/shm/e2e_gdrive_*` buffers.

---

## 2. Feature Inventory (`F1`–`F12`)

| Feature ID | Direction | Deliverable Domain | Tier 1 Tests | Tier 2 Tests | Tier 3 Cross-Feature IDs | Tier 4 E2E Journey IDs |
| :--- | :---: | :--- | :---: | :---: | :--- | :--- |
| **`F1`** | Dir 2 | Taibai `01b`–`04` Batch `.bvh` Extraction (`C_taibai_extracted/`) | `7` (`T1-F1-01`..`07`) | `7` (`T2-F1-01`..`07`) | `T3-X01`, `X02`, `X03`, `X04`, `X20` | `T4-E2E-02`, `05`, `06` |
| **`F2`** | Dir 2 | Google Drive `02/C` Sync & Master Video `05` (`75.9s`) Fetch | `7` (`T1-F2-01`..`07`) | `7` (`T2-F2-01`..`07`) | `T3-X01`, `X05` | `T4-E2E-01`, `02`, `10` |
| **`F3`** | Dir 2 | MVP Locomotion & Dodge `.bvh` Expansion (`07` 8-way, `08`, `09`, `10`) | `7` (`T1-F3-01`..`07`) | `7` (`T2-F3-01`..`07`) | `T3-X06`, `X07`, `X08`, `X20` | `T4-E2E-03`, `04`, `06`, `08` |
| **`F4`** | Dir 2 | MVP Hit-React & Kip-Up `.bvh` Expansion (`11`–`15` + 26-clip `MANIFEST.json`) | `7` (`T1-F4-01`..`07`) | `7` (`T2-F4-01`..`07`) | `T3-X09`, `X10`, `X20` | `T4-E2E-03`, `06` |
| **`F5`** | Dir 1 | Multi-Convention BVH Retargeter (`calf_r`, `pelvis`, toes, `>240f`, Root Motion) | `7` (`T1-F5-01`..`07`) | `7` (`T2-F5-01`..`07`) | `T3-X02`, `X06`, `X09`, `X11`, `X12` | `T4-E2E-01`, `02`, `03` |
| **`F6`** | Dir 1 | Long-Video In/Out Trim, Monotonic Timestamps & CPU XNNPACK Fast Path | `7` (`T1-F6-01`..`07`) | `7` (`T2-F6-01`..`07`) | `T3-X05`, `X13`, `X14`, `X19` | `T4-E2E-01` |
| **`F7`** | Dir 1 | Live `<15ms` Filter & Two-Bone IK Parameter Panel (`MotionCleaner.js`) | `7` (`T1-F7-01`..`07`) | `7` (`T2-F7-01`..`07`) | `T3-X07`, `X09`, `X11`, `X13`, `X15` | `T4-E2E-01`, `03`, `07` |
| **`F8`** | Dir 1 | Wind-Up Compression, Multi-Hit Hit-Stop & Baked `.bvh` Export | `7` (`T1-F8-01`..`07`) | `7` (`T2-F8-01`..`07`) | `T3-X12`, `X14`, `X16` | `T4-E2E-01`, `07` |
| **`F9`** | Dir 1 | Reference-Contact Slip/Jitter `<canvas>` HUD & Asset Library Selector | `7` (`T1-F9-01`..`07`) | `7` (`T2-F9-01`..`07`) | `T3-X03`, `X11`, `X13`, `X17` | `T4-E2E-01`, `02`, `07` |
| **`F10`** | Dir 3 | 15+ State Wuxia Action FSM (`180ms` buffer, parry, `KipUp`, `R<=8.5m` clamp) | `8` (`T1-F10-01`..`08`) | `8` (`T2-F10-01`..`08`) | `T3-X04`, `X08`, `X10`, `X16`, `X18` | `T4-E2E-04`, `05`, `06`, `08` |
| **`F11`** | Dir 3 | 21-Bone Upper/Lower `LayeredAnimator` & Playable 3D Combat Arena + AI Dummy | `8` (`T1-F11-01`..`08`) | `8` (`T2-F11-01`..`08`) | `T3-X04`, `X08`, `X10`, `X15`, `X16` | `T4-E2E-04`, `05`, `06`, `07`, `08` |
| **`F12`** | Dir 1–3 | Unified `:5173` Mode Switcher, Static HTTP `206` Range, Build & Root Git Repo | `8` (`T1-F12-01`..`08`) | `8` (`T2-F12-01`..`08`) | `T3-X17`, `X18`, `X19`, `X20` | `T4-E2E-02`, `03`, `07`, `09`, `10` |

---

## 3. Test Architecture & CLI

### Directory Layout
```text
/home/antigravity/tests/e2e/
├── run_e2e.mjs                          # Unified CLI runner (--tier 1|2|3|4|all, --feature F1..F12, --grep)
├── helpers/
│   ├── constants.mjs                    # Canonical 21-bone BVH spec, 26-asset paths, Drive IDs, video & FSM specs
│   ├── contract_loader.mjs              # Dynamic ESM contract loader, THREE singleton, ephemeral /dev/shm vite build
│   ├── bvh_verifier.mjs                 # 21-bone/66-ch FK analyzer, gdrive/ffprobe helpers, synthetic BVH/clip builders
│   └── browser_cdp.mjs                  # Shared /dev/shm 0700 SwiftShader Chromium CDP manager + warm capture tab
├── tier1/
│   ├── f01_f04_assets_sync.test.mjs     # 28 tests: F1 (7), F2 (7), F3 (7), F4 (7)
│   ├── f05_f09_workbench.test.mjs       # 35 tests: F5 (7), F6 (7), F7 (7), F8 (7), F9 (7)
│   └── f10_f12_combat_git.test.mjs      # 24 tests: F10 (8), F11 (8), F12 (8)
├── tier2/
│   ├── f01_f04_assets_edge.test.mjs     # 28 tests: F1 (7), F2 (7), F3 (7), F4 (7)
│   ├── f05_f09_workbench_edge.test.mjs  # 35 tests: F5 (7), F6 (7), F7 (7), F8 (7), F9 (7)
│   └── f10_f12_combat_git_edge.test.mjs # 24 tests: F10 (8), F11 (8), F12 (8)
├── tier3/
│   └── cross_feature_matrix.test.mjs    # 20 cross-feature pairwise/combinatorial integration tests (T3-X01..T3-X20)
└── tier4/
    └── user_journeys.test.mjs           # 10 complete real-world E2E user journeys (T4-E2E-01..T4-E2E-10)
```

### Standard Tier Execution Commands (M5 Gate Order)
Ensure the MotionStage Vite dev server is listening on `http://127.0.0.1:5173` (override via `E2E_BASE_URL` if needed).

```bash
# Tier 1 — Happy-Path Core Functionality (87 tests)
node /home/antigravity/tests/e2e/run_e2e.mjs --tier 1

# Tier 2 — Boundary, Corner, Security & Negative Robustness (87 tests)
node /home/antigravity/tests/e2e/run_e2e.mjs --tier 2

# Tier 3 — Cross-Feature Pairwise Integration Matrix (20 tests)
node /home/antigravity/tests/e2e/run_e2e.mjs --tier 3

# Tier 4 — End-to-End Real-World User Journeys (10 scenarios)
node /home/antigravity/tests/e2e/run_e2e.mjs --tier 4

# Full 4-Tier Gate (204 tests; default when --tier is omitted)
node /home/antigravity/tests/e2e/run_e2e.mjs --tier all
```

### Targeted Diagnostic Filtering & Exit-Code Contract
```bash
# Filter by feature tag(s) across one or all tiers:
node /home/antigravity/tests/e2e/run_e2e.mjs --tier all --feature F1,F2
node /home/antigravity/tests/e2e/run_e2e.mjs --tier 1 --feature F6,F7,F8

# Filter by test ID or name substring:
node /home/antigravity/tests/e2e/run_e2e.mjs --tier 1 --grep T1-F10-04
```

`run_e2e.mjs` prints both a **Per-Tier (`Tier 1`–`Tier 4`)** summary table and a **Per-Feature (`F1`–`F12`)** summary table, followed by `TOTAL EXECUTED | PASS | FAIL | SKIP | CRASH | TIME`. It exits **`0`** **if and only if** `totalExecuted > 0 && totalFail === 0 && totalSkip === 0 && topLevelErrors === 0`; otherwise it prints failure diagnostics and exits **`1`**. Unknown flags or invalid `--tier` / `--feature` values immediately exit **`1`**.

---

## 4. Tier 3 Cross-Feature Matrix (`T3-X01`–`T3-X20`)

| Test ID | Interacting Features | Cross-Boundary Contract Verified |
| :--- | :--- | :--- |
| **`T3-X01`** | `F1 × F2` | Local `C_taibai_extracted/` <-> Google Drive `02/C` SHA-256 bit-identity, 21-bone parse & `MANIFEST.json` parity |
| **`T3-X02`** | `F1 × F5` | All 4 `C_taibai_extracted` `.bvh` clips re-import via `MotionClips.parseBVHTextToClip` with uncapped `>4.7s` duration & cyclic parity |
| **`T3-X03`** | `F1 × F9` | `taibai_03` loads from Workbench Asset Library UI selector and renders full-length slip/jitter Telemetry HUD `<canvas>` curves |
| **`T3-X04`** | `F1 × F10 × F11` | `taibai_01b..04` drive live Combat Arena `Idle`, `Skill_Wuhen` parry window, `Skill_Yuluo` multi-hit damage & `Skill_Feiyan` i-frames |
| **`T3-X05`** | `F2 × F6` | Master video `05` (`75.9s`) non-monotonic late-to-early trim `[45.4..45.85s] -> [26.72..27.17s]` via HTTP `206` Range + watermark |
| **`T3-X06`** | `F3 × F5` | `08_dash_canglong` & `09_dodge_roll` re-import via `parseBVHTextToClip` preserving Frame-0 `(0,0)` anchor & `+Z` Root Motion |
| **`T3-X07`** | `F3 × F7` | Archived raw CMU optical mocap trial in `A_raw_mocap/` retargets via `retargetBVHToFrames` and cleans via `runCleaningPipeline` |
| **`T3-X08`** | `F3 × F10 × F11` | 8-way strafe + moving upper-body slash + `Dodge_Dash` + `Dodge_Roll` + `Air_Jump_Double` in live 3D Combat Arena |
| **`T3-X09`** | `F4 × F5 × F7` | `11..15` Hit/Knockdown/KipUp `.bvh` clips parse & re-clean with `loopClean: null` keeping supine floor clearance & `nonCyclic` end pose |
| **`T3-X10`** | `F4 × F10 × F11` | `11..15` clips drive Enemy Dummy Mode 2 light counter (`Hit_Light_L/R`) and Mode 3 heavy knockdown -> `KipUp` recovery |
| **`T3-X11`** | `F5 × F7 × F9` | 6-way `preserveRootMotion × nonCyclic × loopClean` pairwise matrix on UE5 BVH + `<50ms` live Workbench UI re-clean |
| **`T3-X12`** | `F5 × F8` | `>240`-frame UE5 (`calf_r`/`pelvis`) & Rigify (`.L`/`.R`) BVHs -> baked Combat Curve `.bvh` export -> round-trip re-import |
| **`T3-X13`** | `F6 × F7 × F9` | Trimmed `01b` video pose capture -> null-contact reference Telemetry -> `<50ms` live Workbench re-clean without MediaPipe re-run |
| **`T3-X14`** | `F6 × F8` | Trimmed `03` video pose capture -> `autoMultiHit` time-warp baking -> valid 21-bone 66-channel `.bvh` export |
| **`T3-X15`** | `F7 × F11` | `TwoBoneIK` `applyForearmTwistSolver` (58% twist, invariant blade aim) & `SpringClothSolver` parity across pipeline and `LayeredAnimator` |
| **`T3-X16`** | `F8 × F10 × F11` | Baked combat `.bvh` re-imports smoothly (`<0.65 rad/frame`) and steps moving upper-body slash in Combat Arena |
| **`T3-X17`** | `F9 × F12` | 26-clip `MANIFEST.json` catalog aligns across Workbench Asset Library selector (`>=26` options) and `CombatClipRegistry` |
| **`T3-X18`** | `F10 × F12` | Unified Mode Switcher strictly isolates `Space` / keyboard routing between Workbench (`isPlaying`) and Combat Arena (`Jump`) |
| **`T3-X19`** | `F6 × F12` | Workbench `activeClipId`, `cleanOptions`, and `combatCurve` state survive round-trip switch into Combat Arena and back |
| **`T3-X20`** | `F1 × F3 × F4 × F12` | All 26 `bvh_library` `.bvh` files + `MANIFEST.json` + raw CMU mocap provenance are both Git-tracked and copied into `vite build` |

---

## 5. Tier 4 Real-World Application Scenarios (`T4-E2E-01`–`T4-E2E-10`)

1. **`T4-E2E-01` (`F2,F5,F6,F7,F8,F9`) — Master Wushu Video (`05`) Sub-Clip Trim -> Clean -> Bake -> Engine `.bvh` Journey**: Probes `75.9s` master video `05`, extracts `[45.40..46.05s]` sub-clip, runs live `<50ms` de-jitter + foot-lock re-clean, bakes wind-up compression + hit-stop into a 21-bone `.bvh`, and verifies round-trip re-import.
2. **`T4-E2E-02` (`F1,F2,F5,F9,F12`) — Taibai 4-Signature-Skill Archive, Drive `02/C` Sync & Live Workbench View-Mode Audit**: Verifies `taibai_01b..04` local/Drive `02/C` parity, loads all 4 clips in live Workbench over HTTP, cycles `clean`/`raw`/`split` comparison modes, and toggles 6-DoF sword visibility with zero console/HTTP errors.
3. **`T4-E2E-03` (`F3,F4,F5,F7,F12`) — CMU & UE5 Retargeting + Full 26-Clip Library Kinematic Audit**: Verifies authentic CMU raw mocap provenance (banning `24_01`/`87_02`), retargets a `270`-frame UE5 lunge clip with preserved Root Motion, and audits all 26 production `.bvh` clips in `MANIFEST.json`.
4. **`T4-E2E-04` (`F3,F10,F11`) — Wuxia Roguelike Lock-On 8-Way Strafe + Moving Slash + 3-Hit Combo Journey**: Locks onto the Enemy Dummy, strafes while slashing (`upperLayerAlpha > 0.80`, 21-bone `Spine=0.55`/`Chest=0.85`/`Arms=1.0` mask), and chains `Attack_Combo_1 -> 2 -> 3` with blade hitbox damage and hit-stop.
5. **`T4-E2E-05` (`F1,F10,F11`) — Sparring Duel Part 1 (`Skill_Wuhen` Parry & `Evade_Backflip` Stagger Breakout)**: Deflects an incoming attack during `Skill_Wuhen` parry window, takes an unguarded light hit into `Hit_Light`, breaks out via `Evade_Backflip` (`i-frames`), and verifies `~6s` breakout cooldown enforcement.
6. **`T4-E2E-06` (`F1,F3,F4,F10,F11`) — Sparring Duel Part 2 (`Hit_Knockdown -> KipUp -> Kick -> Yuluo -> Dash-Cancel -> Feiyan`)**: Survives Dummy Mode 3 heavy knockdown via `KipUp`, breaks poise with `Skill_Kick`, dash-cancels mid-`Skill_Yuluo` into `Dodge_Dash`, and finishes with `Skill_Feiyan`.
7. **`T4-E2E-07` (`F7,F8,F9,F11,F12`) — Seamless Cross-Stage Authoring -> Export -> Combat -> Re-Import Journey on `:5173`**: Tunes filters & combat curve in Workbench, exports baked `.bvh`, switches to Combat Arena (verifying Workbench `rAF` stays paused), returns to Workbench, and re-imports the baked `.bvh`.
8. **`T4-E2E-08` (`F3,F10,F11`) — 300-Substep Arena Boundary (`R <= 8.5m`), Capsule Separation & Aerial Stress Journey**: Executes 300 deterministic `60Hz` combat substeps combining 8-way strafe, `Dodge_Dash`, `Dodge_Roll`, `Air_Jump_Double`, and moving slashes while verifying strict `R <= 8.5m` clamping and zero `NaN`.
9. **`T4-E2E-09` (`F12`) — Ephemeral Production Build (`/dev/shm`) + Static HTTP Server Full-App Smoke Journey**: Serves the `/dev/shm` `vite build` output from an ephemeral Node HTTP server (with RFC Range `206`) and boots both `/` Workbench and `/?mode=combat` Combat Arena with zero page errors.
10. **`T4-E2E-10` (`F2,F12`) — Clone-Ready Git Repository, CC-BY-3.0 Attribution & 26-Asset Tracking Audit**: Verifies root `.git`, CC-BY-3.0 attribution for Beijing Wushu Team 2012 Tour, tracking of all 26 `.bvh` clips + offline MediaPipe chunks, and strict exclusion of Tencent `01*` video and `$HOME` secrets.

---

## 6. Coverage Thresholds vs Implemented Counts

| Metric / Gate | Minimum Requirement | Implemented Count | Status |
| :--- | :---: | :---: | :---: |
| **Features Covered (`F1`–`F12`)** | `12` (`100%`) | **`12` (`F1`–`F12`)** | Exceeds / Complete |
| **Tier 1 (Happy-Path Core)** | `>= 60` total (`>= 5` / feature) | **`87`** (`7` on `F1`–`F9`; `8` on `F10`–`F12`) | **+45%** above floor |
| **Tier 2 (Boundary, Corner & Negative)** | `>= 60` total (`>= 5` / feature) | **`87`** (`7` on `F1`–`F9`; `8` on `F10`–`F12`) | **+45%** above floor |
| **Tier 3 (Cross-Feature Pairwise Matrix)** | `>= 16` tests | **`20`** (`T3-X01`..`T3-X20`) | **+25%** above floor |
| **Tier 4 (Real-World E2E User Journeys)** | `>= 8` scenarios | **`10`** (`T4-E2E-01`..`T4-E2E-10`) | **+25%** above floor |
| **Full 4-Tier Gate (`--tier all`)** | `>= 144` leaf tests | **`204` leaf tests** (`0` skipped, `0` crashes) | **+41.7%** above floor |
