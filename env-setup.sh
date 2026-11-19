#!/usr/bin/env bash
set -euo pipefail

# Strip non-interactive early-return guard in ~/.bashrc if present
sed -i '/case \$- in/,/esac/d' "${HOME}/.bashrc" 2>/dev/null || true

# Ensure standard directories exist in persistent /home/antigravity
mkdir -p \
  "${HOME}/motion-stage" \
  "${HOME}/docs" \
  "${HOME}/bvh_library/A_raw_mocap" \
  "${HOME}/bvh_library/B_cleaned_ready" \
  "${HOME}/bvh_library/C_taibai_extracted" \
  "${HOME}/reference_videos" \
  "${HOME}/.agents/skills/wuxia-motion-pipeline"

# Install MotionStage dependencies if package.json exists
if [ -f "${HOME}/motion-stage/package.json" ]; then
  if [ ! -d "${HOME}/motion-stage/node_modules/three" ] || [ ! -d "${HOME}/motion-stage/node_modules/vite" ]; then
    (cd "${HOME}/motion-stage" && npm install --no-audit --no-fund)
  fi
fi

# Recreate project-level skill for Wuxia AI Motion Pipeline
cat <<'EOF' > "${HOME}/.agents/skills/wuxia-motion-pipeline/SKILL.md"
---
name: wuxia-motion-pipeline
description: Project conventions, workspace layout, Google Drive resource IDs, and 21-bone BVH standards for the Wuxia Action Roguelike AI Motion Pipeline (MotionStage).
---
# 武侠动作 AI 生产管线 (MotionStage)

## Workspace Layout (`/home/antigravity`)
- `/home/antigravity/motion-stage/`: Vite + Three.js + MediaPipe Heavy 3D 动作提取、去抖、双骨 IK 锁脚与 BVH 导出工作台（离线模型分片位于 `public/mediapipe/chunks/`）。
  - 启动开发预览：`npm run dev` (监听 `0.0.0.0:5173`，启动常驻服务需设置 `IsDaemon: true`)
  - 生产构建验证：`npm run build`
- `/home/antigravity/bvh_library/`:
  - `A_raw_mocap/`: CMU / MakeHuman 光学动捕原始 `.bvh`（CC0 / CC BY 3.0）
  - `B_cleaned_ready/`: 已清洗锁脚可直接进引擎的 6 套标准 `.bvh`
  - `C_taibai_extracted/`: AI 视频提取的天刀太白招式 `.bvh` 输出目录
- `/home/antigravity/reference_videos/`: 武术冠军与太白招式单人全身实拍参考片 (`.mp4`)
- `/home/antigravity/docs/`: 技术规范手册、MVP 32 招动作库蓝图与 Blender/UE5/Unity 导入 SOP

## Pinned Google Drive Resources
- Root Folder (`武侠动作AI生产管线_全量资料库/`): `1gAsMG7884ToeYtyeaWgBNacZenHJObR4`
  - `00_生产资料总目录与快速上手指南.md`: `18HF0uaZKKLMkCTmuCagn0ezG1m0MRkTu`
  - `01_参考视频源库_天刀太白与北京武术队/`: `1QQVa_jA3D2lG7kyHuykn7j_xselSM6J_`
  - `02_标准BVH骨骼动作资产库/`: `1aar1vMtDvytjWfoPoYPcIZ3GGG8ZH2X0`
    - `A_光学动捕原始源数据`: `1EQUsxk88fbJlblMkEmWm4ckfFi8VfLbI`
    - `B_清洗锁脚成品动作`: `1h3sid1gTU4rFtWzb-9NRCj1jPuQNrIQ5`
    - `C_AI视频提取成品_天刀太白招式BVH`: `1xxXXnYg3GVk9zAKrQMSuIPG8JjjESu0v`
  - `03_MotionStage工程源码与离线部署包/`: `1Q7pYkCpQFydoi4SeNX8fHQ5qOXtGbPF9`
  - `04_AI模型权重与WASM离线包/`: `1OWeADR9wWxw3Hm47b-znP38e2YNXJu50`
  - `05_技术规范手册与武侠肉鸽动作规划/`: `1Z4Ve23HBPMPODUDaM4JGBPhQoZw4Nf58`

## Standard BVH Specification
- **Skeleton**: 21-bone Humanoid (`Hips`, `Spine`, `Chest`, `Neck`, `Head`, `Left/RightShoulder`, `Left/RightUpperArm`, `Left/RightForeArm`, `Left/RightHand`, `Left/RightUpLeg`, `Left/RightLeg`, `Left/RightFoot`, `Left/RightToe`). Auxiliary `ForeArmTwist`, `Skirt*`, and `Cape*` bones are runtime-only and excluded from BVH export.
- **Units & Channels**: Centimeters (`cm`, `pos * 100`), `ZXY` Euler rotation order (`Zrotation Xrotation Yrotation`), Blender import scale `0.01`.
EOF
