# 中国武侠动作肉鸽（Action Roguelike）角色动作库蓝图与 CMU 商用检索表

针对你的**中国武侠动作肉鸽游戏**研发需求，最稳健、最高性价比、且 100% 规避版权风险的工业方案是：
**「70% CMU 光学动捕免费商用底座（移动/翻滚/受击/基础身法） + 30% 视频动捕/关键帧精修招牌武学（太白快剑/剑指起势/大招收招）」**。

---

## 一、CMU 动捕数据库商用许可说明

- **官方名称**：Carnegie Mellon University (CMU) Graphics Lab Motion Capture Database（共 `144` 名演员、`2605` 条光学动捕序列）。
- **商用许可**：**完全允许免费用于商业游戏、影视与商业软件产品**（CMU 官方声明该数据集由 NSF 资助向公众开放，免费用于任何科研或商业用途，无需支付版税）。
- **最佳实践**：若使用第三方重拓扑转换版（如 MakeHuman / cgspeed BVH 转换版），保留一份 `CC0` / `CC BY 3.0` 制作人员鸣谢即可安心上架 Steam / 主机 / 移动端。

---

## 二、武侠动作肉鸽 · 核心主角最小完备动作集（MVP 32 招规划表）

| 模块分类 | 动作资产代号 | 游戏内用途 | 推荐生产来源（CMU 编号 / 视频动捕） | 循环属性 | 本资料库已含成品 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. 基础状态与轻功移动** | `Loco_Idle_Relax` | 非战斗收剑呼吸待机 | **CMU Subject `02_01` / MakeHuman `avatar_stand_1`** | 循环 | ✅ `01_wuxia_idle_待机呼吸_cleaned.bvh` |
| | `Loco_Idle_Combat` | 持剑戒备待机（剑指护胸） | **AI 视频提取**：太白崖顶横剑 / 武术起势 | 循环 | ✅ `taibai_01b_崖顶横剑定势_cleaned.bvh` |
| | `Loco_Run_Sprint` | 疾跑轻功 / 局内高速跑图 | **CMU Subject `09_01`~`09_11` / `avatar_run`** | 循环 | ✅ `02_wuxia_run_疾跑轻功_cleaned.bvh` |
| | `Loco_Strafe_8Way` | 锁定目标八向垫步走位 | **CMU Subject `16` / `35`**（前后左右移动） | 循环 | 按需由 CMU 扩展 |
| **2. 闪避与轻功身法** | `Dodge_Dash_Fwd` | 【苍龙出水】瞬步化影前冲刺 | **CMU Subject `49_04`**（爆发前冲）+ 上半身持剑层覆盖 | 单次 | 推荐叠加上半身剑姿 |
| | `Dodge_Backflip` | 【燕回朝阳】受身解控后空翻 | **CMU Subject `88_01` / `avatar_backflip`** | 单次 | ✅ `06_wuxia_backflip_原地后空翻_cleaned.bvh` |
| | `Dodge_Roll` | 翻滚无敌帧闪避 | **CMU Subject `88_04` / `90`**（体操翻滚） | 单次 | 按需由 CMU 扩展 |
| | `Air_Jump_Double` | 二段踏空轻功跳 | **CMU Subject `87_02` / `87_03`**（武术腾空跃） | 单次 | 按需由 CMU 扩展 |
| **3. 普攻快剑连段** | `Atk_Light_Combo` | 【云台三落】三段普攻快剑连斩 | **光学下盘 + 防穿模剑道层 / 武术快剑实拍提取** | 单次 | ✅ `03_wuxia_sword_combo_剑术连斩去穿模_cleaned.bvh` |
| | `Atk_Fast_5Slash` | 【雨落云飞】高速多段压制连斩 | **AI 视频提取**：北京武术队快剑五连斩 | 单次 | ✅ `taibai_03_雨落云飞_快剑五连斩_cleaned.bvh` |
| **4. 破招与武学战技** | `Skill_Stance_Buff` | 【无痕剑意】弹反架势 / 剑意爆发 | **AI 视频提取**：世界冠军李昕豫独立提膝云剑 | 单次 | ✅ `taibai_02_无痕剑意_独立提膝云剑_cleaned.bvh` |
| | `Skill_GuardBreak` | 正蹬破盾重踢（打断霸体） | **MakeHuman `avatar_kick_roundhouse_R`（正蹬原片）** | 单次 | ✅ `05_wuxia_front_kick_正蹬破防踢_cleaned.bvh` |
| | `Skill_SpinKick` | 旋风回旋扫堂/浮空踢 | **CMU Subject `87_01`（旋风回旋踢）** | 单次 | ✅ `04_wuxia_tornado_kick_旋风回旋踢_cleaned.bvh` |
| | `Skill_Ult_Aerial` | 【飞燕逐月】腾空旋风终结技 | **AI 视频提取**：全国冠军王曦腾空 540° 旋风跌叉 | 单次 | ✅ `taibai_04_飞燕逐月_腾空旋风跌叉_cleaned.bvh` |
| **5. 受击与结算** | `Hit_Light_L/R` | 轻受击硬直（左/右偏身） | **CMU Subject `24` / `143`**（拳击格斗受击反应） | 单次 | 按需由 CMU 扩展 |
| | `Hit_Knockdown` | 击飞倒地与鲤鱼打挺起身 | **CMU Subject `87` / `88`**（特技摔倒与起身） | 单次 | 按需由 CMU 扩展 |

---

## 三、CMU 库武术与冷兵器精华编号速查（直接去 CMU 库挑这几组最高效）

1. **Subject `24` & `124`（Swordplay / 剑术格斗专集）**：包含劈砍、斜撩、格挡、突刺、剑步进退，是最适合做武侠普攻下盘重心的光学动捕源。
2. **Subject `87`（Acrobatics & Martial Arts / 武术腾空腿法专集）**：包含旋风踢（`87_01`）、腾空飞脚、侧空翻，极适合武侠轻功与腿法战技。
3. **Subject `88` & `90`（Gymnastics & Flips / 空翻闪避专集）**：包含原地后空翻、前手翻、侧翻闪避，帧率稳、落地缓冲真实。
4. **Subject `135`（Martial Arts / 传统武术冲拳踢腿套路）**：包含马步、弓步冲拳、转身摆莲，适合拳脚流派或内功蓄力招式。

---

## 四、肉鸽战斗手感的「黄金三调」建议（引擎侧落地技巧）

光学动捕与真人武术视频最大的特点是**物理匀速真实**，而动作肉鸽（如《苍翼：混沌效应》《暖雪》《Hades》）需要极强的**凌厉节奏对比**：
1. **砍前摇（Anticipation）压缩至 `3～6 帧`**：肉鸽高频战斗中玩家要求按键即出刀，将真人起手准备帧裁剪或 1.8 倍加速，把核心辨识度留给**命中定格帧（Impact Pose）**与**收刀残影（Follow-through）**。
2. **上下半身分层混合（Layered Blend Per Bone）**：在 UE5 / Unity 中以 `Spine` 为分界——移动跑图时下半身播放 `02_wuxia_run_疾跑轻功`，上半身叠加太白挥剑，立刻实现「边走位边出剑」的丝滑肉鸽手感。
3. **根骨骼位移（Root Motion）开关分离**：突进技（如苍龙出水、五连斩）开启 Root Motion 制造真实踏步爆发感；受玩家摇杆微调的普攻可提取 Z 轴位移曲线转为程序化冲量，防止贴墙卡怪。
