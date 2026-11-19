import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const BONE_DEFS = [
  { name: 'Hips', parent: -1, pos: [0, 0.94, 0] },               // 0
  { name: 'Spine', parent: 0, pos: [0, 0.14, 0] },               // 1
  { name: 'Chest', parent: 1, pos: [0, 0.22, 0] },               // 2
  { name: 'Neck', parent: 2, pos: [0, 0.22, 0] },                // 3
  { name: 'Head', parent: 3, pos: [0, 0.10, 0] },                // 4

  { name: 'LeftShoulder', parent: 2, pos: [0.075, 0.17, 0] },    // 5
  { name: 'LeftUpperArm', parent: 5, pos: [0.12, 0, 0] },        // 6
  { name: 'LeftForeArm', parent: 6, pos: [0.27, 0, 0] },         // 7
  { name: 'LeftForeArmTwist', parent: 7, pos: [0.13, 0, 0] },    // 8
  { name: 'LeftHand', parent: 7, pos: [0.25, 0, 0] },            // 9

  { name: 'RightShoulder', parent: 2, pos: [-0.075, 0.17, 0] },  // 10
  { name: 'RightUpperArm', parent: 10, pos: [-0.12, 0, 0] },     // 11
  { name: 'RightForeArm', parent: 11, pos: [-0.27, 0, 0] },      // 12
  { name: 'RightForeArmTwist', parent: 12, pos: [-0.13, 0, 0] }, // 13
  { name: 'RightHand', parent: 12, pos: [-0.25, 0, 0] },         // 14

  { name: 'LeftUpLeg', parent: 0, pos: [0.105, -0.04, 0] },      // 15
  { name: 'LeftLeg', parent: 15, pos: [0, -0.41, 0] },           // 16
  { name: 'LeftFoot', parent: 16, pos: [0, -0.41, 0] },          // 17
  { name: 'LeftToe', parent: 17, pos: [0, -0.05, 0.12] },        // 18

  { name: 'RightUpLeg', parent: 0, pos: [-0.105, -0.04, 0] },    // 19
  { name: 'RightLeg', parent: 19, pos: [0, -0.41, 0] },          // 20
  { name: 'RightFoot', parent: 20, pos: [0, -0.41, 0] },         // 21
  { name: 'RightToe', parent: 21, pos: [0, -0.05, 0.12] },       // 22

  { name: 'SkirtFront', parent: 0, pos: [0, -0.03, 0.09] },      // 23
  { name: 'SkirtBack', parent: 0, pos: [0, -0.03, -0.09] },      // 24

  { name: 'Cape01', parent: 2, pos: [0, 0.16, -0.10] },          // 25
  { name: 'Cape02', parent: 25, pos: [0, -0.24, -0.02] },        // 26
  { name: 'Cape03', parent: 26, pos: [0, -0.26, -0.02] },        // 27
  { name: 'Cape04', parent: 27, pos: [0, -0.28, -0.02] },        // 28
];

export const BONE_IDX = Object.fromEntries(BONE_DEFS.map((d, i) => [d.name, i]));

export function createBoneHierarchy() {
  const bones = BONE_DEFS.map((def) => {
    const b = new THREE.Bone();
    b.name = def.name;
    b.position.fromArray(def.pos);
    return b;
  });

  BONE_DEFS.forEach((def, idx) => {
    if (def.parent >= 0) {
      bones[def.parent].add(bones[idx]);
    }
  });

  const bindWorldPos = BONE_DEFS.map((_, idx) => {
    const p = new THREE.Vector3();
    let cur = idx;
    while (cur >= 0) {
      p.x += BONE_DEFS[cur].pos[0];
      p.y += BONE_DEFS[cur].pos[1];
      p.z += BONE_DEFS[cur].pos[2];
      cur = BONE_DEFS[cur].parent;
    }
    return p;
  });

  return { bones, bindWorldPos };
}

function makePart(geo, baseColorHex, partTag) {
  const nonIndexed = geo.index ? geo.toNonIndexed() : geo.clone();
  nonIndexed.computeVertexNormals();
  const count = nonIndexed.attributes.position.count;

  const baseColors = new Float32Array(count * 3);
  const c = new THREE.Color(baseColorHex);
  for (let i = 0; i < count; i++) {
    baseColors[i * 3] = c.r;
    baseColors[i * 3 + 1] = c.g;
    baseColors[i * 3 + 2] = c.b;
  }
  nonIndexed.setAttribute('color', new THREE.BufferAttribute(baseColors, 3));
  nonIndexed.userData.partTag = partTag;
  return nonIndexed;
}

function assignWeightsForPart(geo, partTag) {
  const pos = geo.attributes.position;
  const count = pos.count;

  const prodIdx = new Uint16Array(count * 4);
  const prodWgt = new Float32Array(count * 4);
  const badIdx = new Uint16Array(count * 4);
  const badWgt = new Float32Array(count * 4);

  const heatProd = new Float32Array(count * 3);
  const heatBad = new Float32Array(count * 3);

  const set4 = (idxArr, wgtArr, i, b0, w0, b1 = 0, w1 = 0, b2 = 0, w2 = 0, b3 = 0, w3 = 0) => {
    const sum = w0 + w1 + w2 + w3 || 1;
    const o = i * 4;
    idxArr[o] = b0;
    idxArr[o + 1] = b1;
    idxArr[o + 2] = b2;
    idxArr[o + 3] = b3;
    wgtArr[o] = w0 / sum;
    wgtArr[o + 1] = w1 / sum;
    wgtArr[o + 2] = w2 / sum;
    wgtArr[o + 3] = w3 / sum;
  };

  const setHeat = (arr, i, r, g, b) => {
    arr[i * 3] = r;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = b;
  };

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    if (partTag === 'pelvis') {
      set4(prodIdx, prodWgt, i, BONE_IDX.Hips, 0.85, BONE_IDX.Spine, 0.15);
      set4(badIdx, badWgt, i, BONE_IDX.Hips, 0.85, BONE_IDX.Spine, 0.15);
      setHeat(heatProd, i, 0.18, 0.55, 0.82);
      setHeat(heatBad, i, 0.18, 0.55, 0.82);
    } else if (partTag === 'torso') {
      const t = THREE.MathUtils.clamp((y - 1.05) / 0.36, 0, 1);
      set4(prodIdx, prodWgt, i, BONE_IDX.Spine, 1 - t, BONE_IDX.Chest, t);
      set4(badIdx, badWgt, i, BONE_IDX.Spine, 1 - t, BONE_IDX.Chest, t);
      setHeat(heatProd, i, 0.2, 0.72, 0.65);
      setHeat(heatBad, i, 0.2, 0.72, 0.65);
    } else if (partTag === 'head') {
      const t = THREE.MathUtils.clamp((y - 1.50) / 0.12, 0, 1);
      set4(prodIdx, prodWgt, i, BONE_IDX.Neck, 1 - t, BONE_IDX.Head, t);
      set4(badIdx, badWgt, i, BONE_IDX.Neck, 1 - t, BONE_IDX.Head, t);
      setHeat(heatProd, i, 0.35, 0.78, 0.52);
      setHeat(heatBad, i, 0.35, 0.78, 0.52);
    } else if (partTag === 'pauldron_l' || partTag === 'pauldron_r') {
      const isLeft = partTag === 'pauldron_l';
      const bSh = isLeft ? BONE_IDX.LeftShoulder : BONE_IDX.RightShoulder;
      const bUp = isLeft ? BONE_IDX.LeftUpperArm : BONE_IDX.RightUpperArm;
      // Production armor rig: anchor shoulder plate to clavicle + chest with 18% upper-arm follow
      set4(prodIdx, prodWgt, i, bSh, 0.54, BONE_IDX.Chest, 0.28, bUp, 0.18);
      // Naive auto-rig: 100% glued to upper arm -> flips into helmet on overhead swing
      set4(badIdx, badWgt, i, bUp, 1.0);
      setHeat(heatProd, i, 0.22, 0.76, 0.72);
      setHeat(heatBad, i, 0.88, 0.36, 0.22);
    } else if (partTag === 'arm_l') {
      // x from 0.155 to 0.805
      if (x < 0.455) {
        const t = THREE.MathUtils.clamp((x - 0.395) / 0.10, 0, 1);
        set4(prodIdx, prodWgt, i, BONE_IDX.LeftUpperArm, 1 - t, BONE_IDX.LeftForeArm, t);
        set4(badIdx, badWgt, i, BONE_IDX.LeftUpperArm, 1 - t, BONE_IDX.LeftForeArm, t);
        setHeat(heatProd, i, 0.24, 0.62, 0.85);
        setHeat(heatBad, i, 0.24, 0.62, 0.85);
      } else if (x < 0.705) {
        // Forearm span [0.455 .. 0.705]
        const u = THREE.MathUtils.clamp((x - 0.465) / 0.24, 0, 1);
        const wTwist = Math.sin(u * Math.PI * 0.5) * 0.82;
        const wHand = Math.max(0, (u - 0.72) / 0.28) * 0.45;
        const wFore = Math.max(0.05, 1 - wTwist - wHand);
        set4(prodIdx, prodWgt, i, BONE_IDX.LeftForeArm, wFore, BONE_IDX.LeftForeArmTwist, wTwist, BONE_IDX.LeftHand, wHand);

        // Bad auto-rig: abrupt boundary at wrist with 0 twist bone
        const badHand = THREE.MathUtils.smoothstep(x, 0.645, 0.695);
        set4(badIdx, badWgt, i, BONE_IDX.LeftForeArm, 1 - badHand, BONE_IDX.LeftHand, badHand);
        setHeat(heatProd, i, 0.16, 0.82, 0.68);
        setHeat(heatBad, i, badHand > 0.15 && badHand < 0.85 ? 0.95 : 0.35, 0.32, 0.25);
      } else {
        set4(prodIdx, prodWgt, i, BONE_IDX.LeftHand, 1);
        set4(badIdx, badWgt, i, BONE_IDX.LeftHand, 1);
        setHeat(heatProd, i, 0.28, 0.85, 0.55);
        setHeat(heatBad, i, 0.78, 0.42, 0.24);
      }
    } else if (partTag === 'arm_r') {
      // Right arm (sword arm!): x from -0.155 to -0.805
      const ax = -x;
      if (ax < 0.455) {
        const t = THREE.MathUtils.clamp((ax - 0.395) / 0.10, 0, 1);
        set4(prodIdx, prodWgt, i, BONE_IDX.RightUpperArm, 1 - t, BONE_IDX.RightForeArm, t);
        set4(badIdx, badWgt, i, BONE_IDX.RightUpperArm, 1 - t, BONE_IDX.RightForeArm, t);
        setHeat(heatProd, i, 0.24, 0.62, 0.85);
        setHeat(heatBad, i, 0.24, 0.62, 0.85);
      } else if (ax < 0.705) {
        // Forearm [0.465 .. 0.705]: smooth distributed twist vs candy-wrapper pinch
        const u = THREE.MathUtils.clamp((ax - 0.465) / 0.24, 0, 1);
        const wTwist = THREE.MathUtils.smoothstep(u, 0.08, 0.85) * 0.78;
        const wHand = THREE.MathUtils.smoothstep(u, 0.72, 1.0) * 0.48;
        const wFore = Math.max(0.05, 1 - wTwist - wHand);
        set4(prodIdx, prodWgt, i, BONE_IDX.RightForeArm, wFore, BONE_IDX.RightForeArmTwist, wTwist, BONE_IDX.RightHand, wHand);

        // Naive distance auto-rig: sharp 50/50 clash right at wrist cuff without Twist bone!
        const badHand = THREE.MathUtils.smoothstep(ax, 0.615, 0.695);
        set4(badIdx, badWgt, i, BONE_IDX.RightForeArm, 1 - badHand, BONE_IDX.RightHand, badHand);

        setHeat(heatProd, i, 0.12, 0.86, 0.70);
        // Highlight wrist collapse zone in hot red/amber on bad rig
        const pinchZone = 1 - Math.min(1, Math.abs(ax - 0.655) / 0.055);
        setHeat(heatBad, i, 0.45 + 0.52 * pinchZone, 0.45 - 0.32 * pinchZone, 0.22);
      } else {
        set4(prodIdx, prodWgt, i, BONE_IDX.RightHand, 1);
        set4(badIdx, badWgt, i, BONE_IDX.RightHand, 1);
        setHeat(heatProd, i, 0.28, 0.85, 0.55);
        setHeat(heatBad, i, 0.88, 0.36, 0.22);
      }
    } else if (partTag === 'leg_l' || partTag === 'leg_r') {
      const isLeft = partTag === 'leg_l';
      const bUp = isLeft ? BONE_IDX.LeftUpLeg : BONE_IDX.RightUpLeg;
      const bLo = isLeft ? BONE_IDX.LeftLeg : BONE_IDX.RightLeg;
      const bFt = isLeft ? BONE_IDX.LeftFoot : BONE_IDX.RightFoot;
      const bTo = isLeft ? BONE_IDX.LeftToe : BONE_IDX.RightToe;

      if (y > 0.53) {
        set4(prodIdx, prodWgt, i, bUp, 1);
        set4(badIdx, badWgt, i, bUp, 1);
      } else if (y > 0.44) {
        const t = THREE.MathUtils.clamp((0.53 - y) / 0.09, 0, 1);
        set4(prodIdx, prodWgt, i, bUp, 1 - t, bLo, t);
        set4(badIdx, badWgt, i, bUp, 1 - t, bLo, t);
      } else if (y > 0.12) {
        set4(prodIdx, prodWgt, i, bLo, 1);
        set4(badIdx, badWgt, i, bLo, 1);
      } else if (z > 0.08) {
        set4(prodIdx, prodWgt, i, bFt, 0.35, bTo, 0.65);
        set4(badIdx, badWgt, i, bFt, 0.35, bTo, 0.65);
      } else {
        set4(prodIdx, prodWgt, i, bFt, 1);
        set4(badIdx, badWgt, i, bFt, 1);
      }
      setHeat(heatProd, i, 0.22, 0.58, 0.86);
      setHeat(heatBad, i, 0.22, 0.58, 0.86);
    } else if (partTag === 'skirt') {
      // Battle tasset / front & back tabard around hips [y: 0.56 .. 0.92]
      const drop = THREE.MathUtils.clamp((0.91 - y) / 0.34, 0, 1);
      const skirtBone = z >= 0 ? BONE_IDX.SkirtFront : BONE_IDX.SkirtBack;
      // Production rig: isolated onto dedicated secondary Skirt cloth bones!
      set4(prodIdx, prodWgt, i, BONE_IDX.Hips, 1 - drop * 0.92, skirtBone, drop * 0.92);
      setHeat(heatProd, i, 0.18, 0.84, 0.62);

      // Bad AI distance auto-rig: contaminates skirt hem across BOTH LeftUpLeg & RightUpLeg!
      const sideBias = THREE.MathUtils.clamp(0.5 + x * 2.6, 0.12, 0.88);
      set4(
        badIdx,
        badWgt,
        i,
        BONE_IDX.Hips,
        (1 - drop) * 0.65,
        BONE_IDX.LeftUpLeg,
        drop * sideBias,
        BONE_IDX.RightUpLeg,
        drop * (1 - sideBias)
      );
      // Red contamination heatmap on skirt in bad auto-rig mode
      setHeat(heatBad, i, 0.96, 0.24 + (1 - drop) * 0.3, 0.20);
    } else if (partTag === 'cape') {
      // Flowing back cape [y: 1.46 down to 0.52]
      const h = THREE.MathUtils.clamp((1.46 - y) / 0.92, 0, 1);
      if (h < 0.33) {
        const t = h / 0.33;
        set4(prodIdx, prodWgt, i, BONE_IDX.Cape01, 1 - t, BONE_IDX.Cape02, t);
      } else if (h < 0.66) {
        const t = (h - 0.33) / 0.33;
        set4(prodIdx, prodWgt, i, BONE_IDX.Cape02, 1 - t, BONE_IDX.Cape03, t);
      } else {
        const t = (h - 0.66) / 0.34;
        set4(prodIdx, prodWgt, i, BONE_IDX.Cape03, 1 - t, BONE_IDX.Cape04, t);
      }
      setHeat(heatProd, i, 0.25, 0.78, 0.88);

      // Bad AI distance auto-rig: glues upper cape to Spine/Hips and lower cape to thighs!
      if (y > 0.94) {
        set4(badIdx, badWgt, i, BONE_IDX.Chest, 0.6, BONE_IDX.Spine, 0.4);
        setHeat(heatBad, i, 0.75, 0.52, 0.22);
      } else {
        const sideBias = THREE.MathUtils.clamp(0.5 + x * 2.2, 0.15, 0.85);
        set4(badIdx, badWgt, i, BONE_IDX.Hips, 0.2, BONE_IDX.LeftUpLeg, 0.8 * sideBias, BONE_IDX.RightUpLeg, 0.8 * (1 - sideBias));
        setHeat(heatBad, i, 0.96, 0.22, 0.22);
      }
    }
  }

  geo.userData.weights = { prodIdx, prodWgt, badIdx, badWgt, heatProd, heatBad };
}

export function buildCharacterRig() {
  const { bones } = createBoneHierarchy();
  const parts = [];

  const armorSteel = 0x8d99a8;
  const darkUnder = 0x39414c;
  const trimBronze = 0xc5924c;
  const clothCrimson = 0x2c6e68;
  const capeSlate = 0x284b57;

  // 1. Pelvis & Belt
  const pelvisGeo = new THREE.CylinderGeometry(0.135, 0.125, 0.15, 12, 2);
  pelvisGeo.scale(1.12, 1, 0.78);
  pelvisGeo.translate(0, 0.95, 0);
  parts.push(makePart(pelvisGeo, darkUnder, 'pelvis'));

  const beltGeo = new THREE.BoxGeometry(0.31, 0.055, 0.22);
  beltGeo.translate(0, 1.01, 0);
  parts.push(makePart(beltGeo, trimBronze, 'pelvis'));

  // 2. Torso & Athletic V-Tapered Armored Cuirass
  const abdomenGeo = new THREE.CylinderGeometry(0.132, 0.122, 0.22, 12, 3);
  abdomenGeo.scale(1.08, 1, 0.72);
  abdomenGeo.translate(0, 1.13, 0);
  parts.push(makePart(abdomenGeo, darkUnder, 'torso'));

  const chestGeo = new THREE.CylinderGeometry(0.152, 0.132, 0.26, 14, 4);
  chestGeo.scale(1.10, 1, 0.74);
  chestGeo.translate(0, 1.36, 0.006);
  parts.push(makePart(chestGeo, armorSteel, 'torso'));

  // Pauldrons (Shoulders)
  for (const sign of [1, -1]) {
    const pauldron = new THREE.SphereGeometry(0.084, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.60);
    pauldron.scale(1.18, 0.86, 1.02);
    pauldron.rotateZ(-sign * 0.28);
    pauldron.translate(sign * 0.205, 1.49, 0);
    parts.push(makePart(pauldron, armorSteel, sign > 0 ? 'pauldron_l' : 'pauldron_r'));
  }

  // 3. Neck & Stylized Visor Helmet Head
  const neckGeo = new THREE.CylinderGeometry(0.055, 0.065, 0.11, 10, 2);
  neckGeo.translate(0, 1.55, 0);
  parts.push(makePart(neckGeo, darkUnder, 'head'));

  const helmGeo = new THREE.BoxGeometry(0.17, 0.21, 0.19, 3, 3, 3);
  // Slight taper via vertex tweak for visor silhouette
  const hp = helmGeo.attributes.position;
  for (let i = 0; i < hp.count; i++) {
    const vy = hp.getY(i);
    const vz = hp.getZ(i);
    if (vy > 0.04) {
      hp.setX(i, hp.getX(i) * 0.88);
    }
    if (vz > 0.06 && Math.abs(vy) < 0.03) {
      hp.setZ(i, vz + 0.02); // Visor ridge
    }
  }
  helmGeo.translate(0, 1.70, 0.01);
  parts.push(makePart(helmGeo, armorSteel, 'head'));

  const visorSlit = new THREE.BoxGeometry(0.14, 0.026, 0.03);
  visorSlit.translate(0, 1.705, 0.105);
  parts.push(makePart(visorSlit, trimBronze, 'head'));

  // 4. Left & Right Arms (High-resolution forearm rings to clearly exhibit Wrist Twist vs Collapse!)
  for (const sign of [1, -1]) {
    const tag = sign > 0 ? 'arm_l' : 'arm_r';
    // Upper arm [0.195 .. 0.465]
    const upper = new THREE.CylinderGeometry(0.052, 0.045, 0.27, 12, 6);
    upper.rotateZ(-sign * Math.PI * 0.5);
    upper.translate(sign * 0.33, 1.47, 0);
    parts.push(makePart(upper, darkUnder, tag));

    // Forearm & Elliptical Armored Bracer [0.465 .. 0.705] (18 axial segments + elliptical cross-section!)
    const fore = new THREE.CylinderGeometry(0.049, 0.039, 0.25, 14, 18);
    fore.scale(1.0, 0.76, 1.26);
    fore.rotateZ(-sign * Math.PI * 0.5);
    fore.translate(sign * 0.59, 1.47, 0);
    parts.push(makePart(fore, armorSteel, tag));

    // Bracer dorsal ridge along forearm so user can visually see twist distribution!
    const ridge = new THREE.BoxGeometry(0.22, 0.018, 0.022, 16, 1, 1);
    ridge.translate(sign * 0.585, 1.510, 0);
    parts.push(makePart(ridge, trimBronze, tag));

    // Gauntlet Hand [0.705 .. 0.805]
    const hand = new THREE.BoxGeometry(0.10, 0.042, 0.082, 3, 2, 2);
    hand.translate(sign * 0.755, 1.47, 0);
    parts.push(makePart(hand, trimBronze, tag));
  }

  // 5. Left & Right Legs (Thigh, Knee Pad, Greave, Boot)
  for (const sign of [1, -1]) {
    const tag = sign > 0 ? 'leg_l' : 'leg_r';
    const lx = sign * 0.105;

    const thigh = new THREE.CylinderGeometry(0.078, 0.062, 0.40, 12, 6);
    thigh.translate(lx, 0.70, 0);
    parts.push(makePart(thigh, darkUnder, tag));

    const knee = new THREE.BoxGeometry(0.095, 0.085, 0.095);
    knee.translate(lx, 0.49, 0.025);
    parts.push(makePart(knee, trimBronze, tag));

    const shin = new THREE.CylinderGeometry(0.062, 0.048, 0.39, 12, 6);
    shin.translate(lx, 0.285, 0);
    parts.push(makePart(shin, armorSteel, tag));

    const boot = new THREE.BoxGeometry(0.098, 0.085, 0.22, 2, 2, 4);
    boot.translate(lx, 0.043, 0.045);
    parts.push(makePart(boot, armorSteel, tag));
  }

  // 6. Front & Back Battle Tabard / Skirt Panels (demonstrates thigh tearing vs clean cloth bone!)
  const frontSkirt = new THREE.BoxGeometry(0.25, 0.34, 0.018, 10, 12, 1);
  frontSkirt.translate(0, 0.74, 0.112);
  parts.push(makePart(frontSkirt, clothCrimson, 'skirt'));

  const backSkirt = new THREE.BoxGeometry(0.26, 0.34, 0.018, 10, 12, 1);
  backSkirt.translate(0, 0.74, -0.108);
  parts.push(makePart(backSkirt, clothCrimson, 'skirt'));

  // 7. Flowing Shoulder Cape [y: 1.46 down to 0.54]
  const capeGeo = new THREE.BoxGeometry(0.42, 0.92, 0.014, 12, 20, 1);
  const cp = capeGeo.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const cy = cp.getY(i); // +0.46 at top, -0.46 at bottom
    const dropRatio = (0.46 - cy) / 0.92;
    cp.setX(i, cp.getX(i) * (0.82 + dropRatio * 0.42));
    cp.setZ(i, cp.getZ(i) - dropRatio * 0.06);
  }
  capeGeo.computeVertexNormals();
  capeGeo.translate(0, 1.00, -0.115);
  parts.push(makePart(capeGeo, capeSlate, 'cape'));

  // Assign dual skin weights per part before merging
  parts.forEach((p) => assignWeightsForPart(p, p.userData.partTag));

  const merged = mergeGeometries(parts, false);
  const totalVerts = merged.attributes.position.count;

  const prodIdx = new Uint16Array(totalVerts * 4);
  const prodWgt = new Float32Array(totalVerts * 4);
  const badIdx = new Uint16Array(totalVerts * 4);
  const badWgt = new Float32Array(totalVerts * 4);
  const heatProd = new Float32Array(totalVerts * 3);
  const heatBad = new Float32Array(totalVerts * 3);
  const baseColors = new Float32Array(merged.attributes.color.array);

  // Also record indices of right-wrist cuff vertices to measure real-time wrist volume collapse!
  const wristSampleVerts = [];

  let offset = 0;
  for (const p of parts) {
    const c = p.attributes.position.count;
    const w = p.userData.weights;
    prodIdx.set(w.prodIdx, offset * 4);
    prodWgt.set(w.prodWgt, offset * 4);
    badIdx.set(w.badIdx, offset * 4);
    badWgt.set(w.badWgt, offset * 4);
    heatProd.set(w.heatProd, offset * 3);
    heatBad.set(w.heatBad, offset * 3);

    if (p.userData.partTag === 'arm_r') {
      const posAttr = p.attributes.position;
      for (let i = 0; i < c; i++) {
        const vx = posAttr.getX(i);
        if (vx < -0.625 && vx > -0.655) {
          wristSampleVerts.push(offset + i);
        }
      }
    }
    offset += c;
  }

  // Default start in 'bad' auto-rig mode so user immediately sees raw AI problem & can fix it!
  merged.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(badIdx.slice(), 4));
  merged.setAttribute('skinWeight', new THREE.Float32BufferAttribute(badWgt.slice(), 4));

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.46,
    metalness: 0.28,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.SkinnedMesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const rootGroup = new THREE.Group();
  rootGroup.name = 'CharacterRoot';
  rootGroup.add(bones[0]);
  rootGroup.add(mesh);

  // CRITICAL: Compute bind-pose world matrices BEFORE Skeleton.calculateInverses() runs!
  rootGroup.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton, mesh.matrixWorld);

  // Attach stylized Greatsword to RightHand
  const swordGroup = createGreatsword();
  bones[BONE_IDX.RightHand].add(swordGroup);

  const setSkinningVisualState = (skinMode, showHeatmap) => {
    const idxAttr = merged.attributes.skinIndex;
    const wgtAttr = merged.attributes.skinWeight;
    const colAttr = merged.attributes.color;

    if (skinMode === 'prod') {
      idxAttr.array.set(prodIdx);
      wgtAttr.array.set(prodWgt);
    } else {
      idxAttr.array.set(badIdx);
      wgtAttr.array.set(badWgt);
    }
    idxAttr.needsUpdate = true;
    wgtAttr.needsUpdate = true;

    if (showHeatmap) {
      colAttr.array.set(skinMode === 'prod' ? heatProd : heatBad);
      material.roughness = 0.75;
      material.metalness = 0.05;
    } else {
      colAttr.array.set(baseColors);
      material.roughness = 0.46;
      material.metalness = 0.28;
    }
    colAttr.needsUpdate = true;
  };

  return {
    rootGroup,
    mesh,
    skeleton,
    bones,
    swordGroup,
    wristSampleVerts,
    setSkinningVisualState,
  };
}

function createGreatsword() {
  const group = new THREE.Group();
  group.name = 'WeaponGreatsword';

  // Align +Z blade axis with RightHand's true radial thumb-side grip vector in OpenMocap T-pose
  // (eliminates 100% of overhead chamber & follow-through body clipping; >32cm body clearance)
  const zBlade = new THREE.Vector3(-0.619, 0.754, 0.219).normalize();
  const xEdge = new THREE.Vector3(-0.42, -0.15, 0.89);
  xEdge.addScaledVector(zBlade, -xEdge.dot(zBlade)).normalize();
  const yFlat = new THREE.Vector3().crossVectors(zBlade, xEdge).normalize();
  const basis = new THREE.Matrix4().makeBasis(xEdge, yFlat, zBlade);

  group.position.set(-0.05, 0.005, 0.01);
  group.quaternion.setFromRotationMatrix(basis);

  const guardMat = new THREE.MeshStandardMaterial({ color: 0xc8964e, metalness: 0.65, roughness: 0.32 });
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0xdbe4ee,
    metalness: 0.78,
    roughness: 0.2,
  });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x2b2623, roughness: 0.8 });

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.22, 8), gripMat);
  grip.rotation.x = Math.PI * 0.5;
  grip.position.z = -0.05;

  const pommelMesh = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), guardMat);
  pommelMesh.position.z = -0.17;

  // Crossguard spans along X (aligned with knuckles & cutting edge plane)
  const crossguard = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.026, 0.036), guardMat);
  crossguard.position.z = 0.07;

  // Main double-edged blade body (width along X = cutting edges, thin flat along Y)
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.012, 0.82), bladeMat);
  blade.position.z = 0.49;
  blade.castShadow = true;

  // Tapered diamond spear-point tip (+Z)
  const tipGeo = new THREE.ConeGeometry(0.032, 0.16, 4);
  tipGeo.rotateY(Math.PI * 0.25);
  tipGeo.scale(1.28, 0.32, 1.0);
  tipGeo.rotateX(Math.PI * 0.5);
  const bladePoint = new THREE.Mesh(tipGeo, bladeMat);
  bladePoint.position.z = 0.98;
  bladePoint.castShadow = true;

  // Ricasso / fuller collar near crossguard so forward blade direction is visually unmistakable
  const fullerCollar = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.018, 0.11), guardMat);
  fullerCollar.position.z = 0.135;

  // Tip anchor & Base anchor for combat slash trail ribbon
  const tipAnchor = new THREE.Object3D();
  tipAnchor.name = 'SwordTip';
  tipAnchor.position.set(0, 0, 1.06);

  const baseAnchor = new THREE.Object3D();
  baseAnchor.name = 'SwordBase';
  baseAnchor.position.set(0, 0, 0.18);

  group.add(grip, pommelMesh, crossguard, fullerCollar, blade, bladePoint, tipAnchor, baseAnchor);
  group.userData = { tipAnchor, baseAnchor };
  return group;
}

export function createRawGhostVisualizer() {
  const { bones } = createBoneHierarchy();
  const group = new THREE.Group();
  group.name = 'RawAIGhostRoot';
  group.add(bones[0]);

  // Line segments connecting parent -> child bones (excluding auxiliary cloth/twist for crisp silhouette)
  const pairs = [];
  BONE_DEFS.forEach((def, idx) => {
    if (def.parent >= 0 && idx <= 22 && !def.name.includes('Twist')) {
      pairs.push([def.parent, idx]);
    }
  });

  const linePositions = new Float32Array(pairs.length * 6);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));

  const lineMat = new THREE.LineBasicMaterial({
    color: 0xf09b36,
    transparent: true,
    opacity: 0.78,
    depthTest: true,
  });
  const lineSegments = new THREE.LineSegments(lineGeo, lineMat);
  lineSegments.frustumCulled = false;
  group.add(lineSegments);

  // Small joint markers on ankles & wrists to spotlight jitter & foot sliding
  const jointGeo = new THREE.SphereGeometry(0.022, 8, 8);
  const jointMat = new THREE.MeshBasicMaterial({
    color: 0xf5a623,
    transparent: true,
    opacity: 0.85,
  });
  const trackedJoints = [
    BONE_IDX.LeftFoot,
    BONE_IDX.RightFoot,
    BONE_IDX.LeftHand,
    BONE_IDX.RightHand,
    BONE_IDX.Head,
  ];
  const markers = trackedJoints.map(() => {
    const m = new THREE.Mesh(jointGeo, jointMat);
    group.add(m);
    return m;
  });

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  const updateVisuals = () => {
    bones[0].updateWorldMatrix(true, true);
    const arr = lineGeo.attributes.position.array;
    for (let i = 0; i < pairs.length; i++) {
      const [pIdx, cIdx] = pairs[i];
      bones[pIdx].getWorldPosition(tmpA);
      bones[cIdx].getWorldPosition(tmpB);
      group.worldToLocal(tmpA);
      group.worldToLocal(tmpB);
      const o = i * 6;
      arr[o] = tmpA.x;
      arr[o + 1] = tmpA.y;
      arr[o + 2] = tmpA.z;
      arr[o + 3] = tmpB.x;
      arr[o + 4] = tmpB.y;
      arr[o + 5] = tmpB.z;
    }
    lineGeo.attributes.position.needsUpdate = true;

    trackedJoints.forEach((bIdx, mIdx) => {
      bones[bIdx].getWorldPosition(tmpA);
      group.worldToLocal(tmpA);
      markers[mIdx].position.copy(tmpA);
    });
  };

  return { group, bones, updateVisuals };
}
