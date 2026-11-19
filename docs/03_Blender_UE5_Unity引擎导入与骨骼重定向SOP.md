# Blender / Unreal Engine 5 / Unity 骨骼导入与重定向 SOP 手册

本资料库 `02_标准BVH骨骼动作资产库/` 导出的全部 `.bvh` 文件以及未来你用 **MotionStage** 导出的所有 `.bvh` 文件，均严格遵循同一套 **21 关节标准人形层级（Humanoid 21-Bone Rig）**，单位为**厘米（cm）**，旋转顺序为标准 **`ZXY`**。

---

## 一、MotionStage 标准导出骨骼树与引擎映射表

| MotionStage BVH 骨骼名 | 父节点 | Unity Humanoid Avatar 槽位 | Unreal Engine 5 (UE5 Mannequin) 对应骨骼 |
| :--- | :--- | :--- | :--- |
| `Hips` (ROOT) | — | `Hips` | `pelvis` |
| `Spine` | `Hips` | `Spine` | `spine_01` / `spine_02` |
| `Chest` | `Spine` | `Chest` / `UpperChest` | `spine_03` / `spine_04` |
| `Neck` | `Chest` | `Neck` | `neck_01` |
| `Head` | `Neck` | `Head` | `head` |
| `LeftShoulder` | `Chest` | `LeftShoulder` | `clavicle_l` |
| `LeftUpperArm` | `LeftShoulder` | `LeftUpperArm` | `upperarm_l` |
| `LeftForeArm` | `LeftUpperArm` | `LeftLowerArm` | `lowerarm_l` |
| `LeftHand` | `LeftForeArm` | `LeftHand` | `hand_l` |
| `RightShoulder` | `Chest` | `RightShoulder` | `clavicle_r` |
| `RightUpperArm` | `RightShoulder` | `RightUpperArm` | `upperarm_r` |
| `RightForeArm` | `RightUpperArm` | `RightLowerArm` | `lowerarm_r` |
| `RightHand` | `RightForeArm` | `RightHand` | `hand_r` |
| `LeftUpLeg` | `Hips` | `LeftUpperLeg` | `thigh_l` |
| `LeftLeg` | `LeftUpLeg` | `LeftLowerLeg` | `calf_l` |
| `LeftFoot` | `LeftLeg` | `LeftFoot` | `foot_l` |
| `LeftToe` | `LeftFoot` | `LeftToes` | `ball_l` |
| `RightUpLeg` | `Hips` | `RightUpperLeg` | `thigh_r` |
| `RightLeg` | `RightUpLeg` | `RightLowerLeg` | `calf_r` |
| `RightFoot` | `RightLeg` | `RightFoot` | `foot_r` |
| `RightToe` | `RightFoot` | `RightToes` | `ball_r` |

---

## 二、各平台导入实操步骤

### 1. Blender（3.6 / 4.x）一键导入与转 FBX / GLB
1. 打开 `File -> Import -> Motion Capture (.bvh)`。
2. 右侧导入参数设置：
   - **Scale**：设为 **`0.01`**（因为 BVH 为厘米制 `cm`，Blender 默认单位为米 `m`，设 `0.01` 后角色身高正好为标准 `1.75m`）。
   - **Forward / Up**：保持默认 `-Z Forward, Y Up`。
   - 勾选 **Update Scene FPS** 与 **Update Scene Duration**。
3. 若需重定向到你自己的国风武侠角色网格：安装免费插件 **Rokoko Studio Live for Blender** 或 **Auto-Rig Pro**，按上表一键自动识别全部 21 根骨骼名，点击 `Retarget Animation` 即可输出 `.fbx`。

### 2. Unity（URP / HDRP）人形重定向
1. Unity 原生偏好 `.fbx` 容器：先在 Blender 中将 `.bvh` 导入后直接 `File -> Export -> FBX (.fbx)`（勾选 `Only Deform Bones`，取消 `Add Leaf Bones`），拖入 Unity `Assets/`。
2. 在 Inspector 面板切到 **Rig** 页签：
   - **Animation Type** 选择 **`Humanoid`**，点击 `Apply`。
   - 点击 `Configure...` 检查映射——由于我们的骨骼命名完全遵循行业标准（`Hips`、`LeftUpperArm`、`RightHand` 等），Unity 会 **100% 自动全绿匹配**，无需手动拖拽任何一根骨头！
3. 切到 **Animations** 页签：
   - 循环动作（如 `待机呼吸`、`疾跑轻功`）勾选 `Loop Time` 与 `Bake Into Pose (Y)`；
   - 武器挂点：在角色 `RightHand` 下新建空物体 `WeaponSocket_R`，将武侠长剑 Prefab 挂入即可。

### 3. Unreal Engine 5（UE5.3+ IK Retargeter）
1. 将转换后的 `.fbx`（或安装免费 BVH Importer 插件直接拖入 `.bvh`）导入 UE5。
2. 右键新建 **IK Rig**（`IK_MotionStage_Source`）：
   - 将 `Hips` 设为 **Retarget Root**；
   - 按标准五肢 + 脊柱建立 6 条 Retarget Chains：`Spine` (`Spine -> Chest`)、`Head` (`Neck -> Head`)、`LeftArm` (`LeftShoulder -> LeftHand`)、`RightArm` (`RightShoulder -> RightHand`)、`LeftLeg` (`LeftUpLeg -> LeftToe`)、`RightLeg` (`RightUpLeg -> RightToe`)。
3. 新建 **IK Retargeter**，源选 `IK_MotionStage_Source`，目标选你的武侠角色（如 `IK_Mannequin` 或 MetaHuman），全选动画右键 **Duplicate and Retarget Animation Assets** 即可批量生成整套动作库！
