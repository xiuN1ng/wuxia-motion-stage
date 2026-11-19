# MotionStage — 武侠动作肉鸽 3D AI 动作生产管线与战斗验证台

> **Wuxia Action Roguelike 3D AI Motion Pipeline, Cleaning Workbench & Playable 21-Bone Combat Arena**  
> Repository: https://github.com/xiuN1ng/wuxia-motion-stage

MotionStage 是一套面向 3D 武侠动作肉鸽（Wuxia Action Roguelike）的端到端 **AI 视频姿态提取 + 骨骼动作清洗烘培工作台 + 19 状态分层战斗验证原型**，基于原生 `Three.js` (WebGL2) + `@mediapipe/tasks-vision` (离线 WASM/GPU) + `Vite` 构建，所有运行期与导出资产统一遵循 **21 骨骼 / 66 通道 / 60 FPS 标准 `.bvh` 规范**。

---

## 核心模块概览

### 1. 动作资产库与 AI 视频批量生产管线 (`bvh_library/` & `motion-stage/scripts/`)
- **26 条全量通过运动学质检的标准 21-Bone `.bvh` 动作资产**（索引于 `bvh_library/MANIFEST.json`）：
  - `bvh_library/B_cleaned_ready/`（22 条）：包含 6 条基础动作（待机、疾跑、旋风踢、拔剑劈斩、闪避翻滚、受击硬直）及 16 条武侠肉鸽 MVP 招式（锁定八向步法、轻击三连段、跳跃/二段跳、飞身疾退、背水后空翻、受击左右轻硬直/重击击飞、鲤鱼打挺、架势招架、破防重踢）。
  - `bvh_library/C_taibai_extracted/`（4 条）：从天刀太白与北京武术队剑术实拍视频经离线 Headless Chromium + MediaPipe Heavy 24fps 提取、Order-B 零相位滤波、60fps 半球对齐 Slerp 升频、解析双骨 IK 锁脚及长剑躯干/头颈防穿模解算生成的成品招式（`taibai_01b` 崖顶横剑定势、`taibai_02` 无痕剑意、`taibai_03` 雨落云飞五连斩、`taibai_04` 飞燕逐月旋风跌叉）。
- **自动化运动学质检器 (`scripts/lib/kinematicVerifier.mjs`)**：逐帧执行正向运动学（FK），强制校验 21 骨骼 SHA-256 拓扑一致、零 `NaN`/`-0.0000`、支撑脚滑步率、地面防穿模以及右手剑刃距躯干/头颈安全净空。

### 2. MotionStage 动作生产与清洗工作台 (`motion-stage/src/`)
- **无上限帧数与 Root Motion 重定向 (`MotionClips.js`)**：修复右小腿 `calf_r` 映射，解除 240 帧硬编码截断，支持 Mixamo/UE5/CMU/Rigify 多源骨骼自动对齐、`preserveRootMotion` 与 `nonCyclic` 尾帧采样钳制。
- **长视频入点/出点截取 (`VideoPoseCapture.js`)**：支持对长母带设置 `[inSec, outSec]` 区间提取，自动探测 GPU/CPU Delegate 回退并保持 MediaPipe 单调递增时间戳。
- **`< 15ms` 实时清洗控制抽屉 (`WorkbenchPanel.js` + `MotionCleaner.js`)**：支持零相位高斯滤波半径/Sigma、双骨腿部 IK 权重 (`ikBlend`)、支撑检测阈值、首尾闭环过渡与 58% 前臂防糖纸扭转实时调参。
- **武侠打击感非线性时间曲线烘培 (`CombatCurveBaker.js` + `BVHExporter.js`)**：支持前摇压缩（Wind-Up）、出招极速爆发、多段连斩峰值自动检测（Auto Multi-Hit）与命中顿帧（Hit-Stop），一键烘培为标准 60fps `.bvh`。
- **高分屏运动学遥测 HUD (`TelemetryHUD.js`)**：实时绘制清洗前后滑步速度曲线、质心高度曲线及剑尖瞬时线速度峰值对比。

### 3. 武侠肉鸽 19 状态战斗验证台 (`motion-stage/src/combat/`)
- **纯函数确定性战斗状态机 (`CombatStateMachine.js`)**：涵盖 `Idle`、`Move_8Way`、`Sprint`、`Jump`、`Air_Jump_Double`、`Dodge_Dash`、`Dodge_Roll`、`Evade_Backflip`（6s CD 受击脱身）、`Attack_Combo_1..3`（180ms 预输入缓冲）、`Skill_Wuhen`（无痕剑意弹反窗口 + 0.5s 破招反击加成）、`Skill_Yuluo`（雨落云飞五连斩 + 闪避打断）、`Skill_Feiyan`（飞燕逐月无敌突进）、`Skill_Kick`（破防重踢）、`Parry_Block`、`Hit_Light_L/R`、`Hit_Knockdown` 与 `KipUp`（鲤鱼打挺无敌起身）。
- **21 骨骼羽毛化上下半身混合器 (`LayeredAnimator.js`)**：实现移动挥砍时的 `Spine = 0.55`、`Chest = 0.85`、`Neck/Head/Shoulders/Arms = 1.0` 分层覆盖、骨盆反向偏航补偿（Pelvis Counter-Yaw Compensation）、58% 前臂扭转分摊及全向风摆披风/裙摆物理。
- **3D 演武场与统一双舞台秒切 (`CombatArenaApp.js` + `main.js`)**：顶部导航栏支持 `🛠 动作生产工作台` 与 `⚔️ 武侠肉鸽战斗验证台`（或 URL 参数 `/?mode=combat`）无缝切换，内置圆形演武场边界碰撞、扫掠剑刃胶囊体命中判定、架势条（Poise）破防木桩 AI 与飘字顿帧反馈。

---

## 快速启动

```bash
# 1. 环境初始化与离线依赖校验（支持云端沙箱一键拉起）
./env-setup.sh

# 2. 启动统一 WebGL2 双舞台开发服务器（默认端口 5173）
npm --prefix motion-stage run dev

# 3. 运行 62 项核心算法与状态机单元测试（Node 原生 test runner）
npm --prefix motion-stage test

# 4. 运行 4 层全量端到端验证套件（204 项 E2E 测试，含真实 Chromium WebGL2 渲染审计）
node tests/e2e/run_e2e.mjs --tier all
```

### 资产管线批处理脚本

```bash
# 批量重生成 22 条 B_cleaned_ready 标准动作资产
npm --prefix motion-stage run produce-bvh

# 从 reference_videos/ 批量提取并清洗 4 条天刀太白招式 BVH
npm --prefix motion-stage run extract-taibai

# 生成 MANIFEST.json（默认本地 dry-run；传入无参数或云端连接时同步 Google Drive 02/C）
node motion-stage/scripts/sync_drive_and_manifest.mjs --dry-run
```

---

## 目录结构

```text
.
├── bvh_library/
│   ├── A_raw_mocap/            # CMU 120fps / MakeHuman 原始动捕源资产
│   ├── B_cleaned_ready/        # 22 条清洗完毕的武侠肉鸽 21-Bone @60fps 标准动作库
│   ├── C_taibai_extracted/     # 4 条 AI 视频提取 + 双骨 IK 清洗成品太白剑招 BVH
│   └── MANIFEST.json           # 全量 26 条动作资产元数据、SHA-256 与来源溯源索引
├── docs/                       # 项目主控台索引、清洗算法架构与太白参考源清单
├── motion-stage/
│   ├── public/mediapipe/       # 离线 MediaPipe WASM 与 PoseLandmarker Heavy 分片模型
│   ├── scripts/                # 视频批量提取、MVP 资产合成、运动学质检与云盘同步脚本
│   ├── src/                    # MotionStage 工作台与 src/combat/ 战斗验证台核心源码
│   └── tests/                  # 工作台、资产管线与战斗系统的单元集成测试
├── reference_videos/           # CC BY 3.0 北京武术队 2012 巡演母带与裁剪单人实拍参考片
├── tests/e2e/                  # Tier 1-4 全量端到端与真实浏览器运动学验证套件
├── env-setup.sh                # 可重复执行的云端环境与资产完整性自检脚本
└── LICENSE-CC-BY-3.0.md        # CC BY 3.0 与动捕资产开源署名声明
```

---

## 版权与开源资产署名 (Attribution & License)

- **武术实拍视频与衍生太白招式 BVH (`CC BY 3.0`)**：  
  `reference_videos/02_*`、`03_*`、`04_*`、`05_*` 及衍生提取资产 `taibai_02`–`04` 基于 **Beijing Wushu Team (北京武术队) 2012 Tour / Pacific Wushu / C.J. Yeh** 发布的演出视频制作，遵循 **Creative Commons Attribution 3.0 Unported (`CC BY 3.0`)** 协议开源共享。详见 [LICENSE-CC-BY-3.0.md](./LICENSE-CC-BY-3.0.md)。
- **动捕基础库 (`CC0 1.0`)**：  
  `bvh_library/A_raw_mocap/` 与 `B_cleaned_ready/` 源自 Carnegie Mellon University Motion Capture Database (`cgspeed`) 与 MakeHuman `mocap_bvh` 开源动捕库。
- **非公开宣传片排除说明**：  
  `reference_videos/01*`（天涯明月刀门派演示参考片段）已在 `.gitignore` 中严格排除，不纳入公开 Git 仓库分发。
