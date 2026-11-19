# Asset & Reference Video Licensing Notice (CC0 / CC BY 3.0)

This repository combines original source code (`motion-stage/`, `tests/`, `docs/`) with open-licensed motion capture animations and Creative Commons reference footage used for Wuxia martial-arts pose extraction and kinematic verification.

---

## 1. Creative Commons Attribution 3.0 Unported (`CC BY 3.0`)

The following martial-arts performance videos and their derived 21-bone `.bvh` skeletal motion clips are distributed under the **Creative Commons Attribution 3.0 Unported License (`CC BY 3.0`)**:

- **License URL**: https://creativecommons.org/licenses/by/3.0/
- **Original Title**: *Beijing Wushu Team 2012 Tour — Complete Performance Master* (北京武术队 2012 巡演完整母带)
- **Creators / Attribution**: **Beijing Wushu Team (北京武术队)**, **Pacific Wushu**, and **C.J. Yeh** (featuring champion performers including Li Xinyu / 李昕豫 and Wang Xi / 王曦)

### Covered Reference Videos (`reference_videos/`)
- `reference_videos/02_太白无痕剑意_世界冠军李昕豫_独立提膝云剑_720p.mp4`
- `reference_videos/03_太白雨落云飞_北京武术队_快剑五连斩单人实拍_720p.mp4`
- `reference_videos/04_太白飞燕逐月_全国冠军王曦_腾空旋风跌叉单人裁剪.mp4`
- `reference_videos/05_北京武术队2012巡演完整母带_720p_CC-BY-3.0.mp4`

### Covered Derived `.bvh` Motion Clips (`bvh_library/C_taibai_extracted/`)
- `taibai_02_无痕剑意_独立提膝云剑_cleaned.bvh` — Extracted via MediaPipe PoseLandmarker Heavy (`@24fps` → upsampled & Two-Bone IK cleaned `@60fps`)
- `taibai_03_雨落云飞_快剑五连斩_cleaned.bvh` — Extracted via MediaPipe PoseLandmarker Heavy (`@24fps` → upsampled & Two-Bone IK cleaned `@60fps`)
- `taibai_04_飞燕逐月_腾空旋风跌叉_cleaned.bvh` — Extracted via MediaPipe PoseLandmarker Heavy (`@24fps` → upsampled & Two-Bone IK cleaned `@60fps`)

### Summary of `CC BY 3.0` Terms
You are free to:
- **Share** — copy and redistribute the material in any medium or format
- **Adapt** — remix, transform, and build upon the material for any purpose, even commercially

Under the following terms:
- **Attribution** — You must give appropriate credit to **Beijing Wushu Team / Pacific Wushu / C.J. Yeh**, provide a link to the `CC BY 3.0` license, and indicate if changes were made (cropped single-performer segments and 3D 21-bone `.bvh` skeletal motion extraction/cleaning).

---

## 2. Motion Capture Source Libraries (`CC0 1.0` / Free Redistribution)

- **MakeHuman / CMU Graphics Lab Motion Capture Database (`cgspeed` BVH conversion)**:
  - Raw mocap sources in `bvh_library/A_raw_mocap/` (`avatar_*.bvh`, `cmu_*.bvh`) and cleaned/synthesized 21-bone `@60fps` clips in `bvh_library/B_cleaned_ready/` (`01_*.bvh` through `22_*.bvh`) derive from the Carnegie Mellon University Motion Capture Database (`mocap.cs.cmu.edu`) and MakeHuman `mocap_bvh` collection (`CC0 1.0` / unrestricted academic & commercial use).

---

## 3. Excluded Promotional Reference Clips (Not Tracked in Public Git)

- Promotional gameplay/cinematic reference clips `reference_videos/01_*` and `reference_videos/01b_*` (*Moonlight Blade* / 天涯明月刀太白门派演示, Tencent Games) are **strictly excluded** from Git version control via `.gitignore` (`reference_videos/01*`) and are retained solely in private research storage for internal pose benchmarking.
