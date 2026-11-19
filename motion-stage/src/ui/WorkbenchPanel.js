/**
 * Interactive Workbench Drawer (`#workbench-drawer`) for `F7` (Zero-Phase Filter & Two-Bone Foot-Lock IK),
 * Rig Diagnostics (Skinning Weight Heatmap & Raw AI Ghost Skeleton), and `F8` (Combat Time-Warp & BVH Baking).
 */
export function createWorkbenchPanel(
  containerEl,
  {
    initialCleanOptions,
    initialCombatCurve,
    initialVisuals = { showSkinHeatmap: false, showRawGhost: false },
    onCleanOptionsChange,
    onCombatCurveChange,
    onVisualsChange,
    onExportBVH,
    onResetDefaults,
    onCollapseChange,
  }
) {
  let collapsed = false;
  let cleanState = { ...initialCleanOptions };
  let curveState = { ...initialCombatCurve };
  let visualState = { ...initialVisuals };

  containerEl.innerHTML = `
    <div class="wb-header">
      <div class="wb-title-row">
        <span class="wb-title">管线参数精调台</span>
        <span id="lbl-clean-ms" class="wb-ms-badge" title="最近一次同步动作清洗与 IK 解算耗时">0.0 ms</span>
      </div>
      <div class="wb-header-actions">
        <button type="button" id="btn-reset-workbench" class="wb-mini-btn" title="恢复全部滤波、锁脚与节奏曲线默认参数">重置</button>
        <button type="button" id="btn-collapse-workbench" class="wb-mini-btn" aria-label="折叠参数面板" title="收起 / 展开参数面板">收起</button>
      </div>
    </div>

    <div class="wb-body" id="workbench-body">
      <!-- Section 1: Filter & Foot-Lock IK (F7) -->
      <section class="wb-section" aria-label="去抖滤波与双骨锁脚">
        <div class="wb-sec-header">
          <span class="wb-sec-title">1. 零相滤波 &amp; 双骨锁脚 IK</span>
        </div>

        <div class="wb-toggle-grid">
          <label class="wb-check-row" for="chk-dejitter">
            <input type="checkbox" id="chk-dejitter" />
            <span>双向高斯去抖</span>
          </label>
          <label class="wb-check-row" for="chk-foot-lock">
            <input type="checkbox" id="chk-foot-lock" />
            <span>双骨 IK 锁脚</span>
          </label>
          <label class="wb-check-row" for="chk-keep-foot-flat">
            <input type="checkbox" id="chk-keep-foot-flat" />
            <span>落脚底板贴平</span>
          </label>
          <label class="wb-check-row" for="chk-loop-clean">
            <input type="checkbox" id="chk-loop-clean" />
            <span>循环接缝闭合</span>
          </label>
          <label class="wb-check-row wb-span-2" for="chk-preserve-root">
            <input type="checkbox" id="chk-preserve-root" />
            <span>保留位移 Root Motion (突进 / 八向垫步)</span>
          </label>
        </div>

        <div class="wb-slider-row">
          <div class="wb-slider-head">
            <label for="rng-filter-radius">滤波窗口半径 (Radius)</label>
            <span id="val-filter-radius" class="wb-val">3f</span>
          </div>
          <input type="range" id="rng-filter-radius" min="0" max="8" step="1" value="3" />
        </div>

        <div class="wb-slider-row">
          <div class="wb-slider-head">
            <label for="rng-filter-sigma">高斯核平滑度 (Sigma)</label>
            <span id="val-filter-sigma" class="wb-val">Auto</span>
          </div>
          <input type="range" id="rng-filter-sigma" min="0.4" max="4.0" step="0.1" value="1.6" />
        </div>

        <div class="wb-select-row">
          <label for="sel-contact-mode">触地判定模式</label>
          <select id="sel-contact-mode" class="wb-select">
            <option value="auto">自动感知 (Auto)</option>
            <option value="threshold">手动阈值覆盖 (Threshold)</option>
          </select>
        </div>

        <div class="wb-slider-row">
          <div class="wb-slider-head">
            <label for="rng-contact-height">触地高度阈值 (Height)</label>
            <span id="val-contact-height" class="wb-val">15.5 cm</span>
          </div>
          <input type="range" id="rng-contact-height" min="0.06" max="0.30" step="0.005" value="0.155" />
        </div>

        <div class="wb-slider-row">
          <div class="wb-slider-head">
            <label for="rng-contact-vel">触地速度阈值 (Slip Thr)</label>
            <span id="val-contact-vel" class="wb-val">0.92 m/s</span>
          </div>
          <input type="range" id="rng-contact-vel" min="0.15" max="2.50" step="0.01" value="0.92" />
        </div>

        <div class="wb-slider-row">
          <div class="wb-slider-head">
            <label for="rng-ik-blend">锁脚 IK 混合权重</label>
            <span id="val-ik-blend" class="wb-val">1.00</span>
          </div>
          <input type="range" id="rng-ik-blend" min="0" max="1" step="0.01" value="1" />
        </div>

        <div class="wb-slider-row">
          <div class="wb-slider-head">
            <label for="rng-forearm-twist">前臂防拧麻花分担 (Twist)</label>
            <span id="val-forearm-twist" class="wb-val">58%</span>
          </div>
          <input type="range" id="rng-forearm-twist" min="0" max="1" step="0.01" value="0.58" />
        </div>
      </section>

      <!-- Section 2: Skinning & Raw Ghost Diagnostics -->
      <section class="wb-section" aria-label="蒙皮权重与原始残影叠加">
        <div class="wb-sec-header">
          <span class="wb-sec-title">2. 蒙皮诊断 &amp; 原始残影对比</span>
        </div>
        <div class="wb-toggle-grid">
          <label class="wb-check-row" for="chk-skin-heatmap">
            <input type="checkbox" id="chk-skin-heatmap" />
            <span>骨骼蒙皮热力图</span>
          </label>
          <label class="wb-check-row" for="chk-raw-ghost">
            <input type="checkbox" id="chk-raw-ghost" />
            <span>叠加原始骨骼残影</span>
          </label>
        </div>
      </section>

      <!-- Section 3: Combat Curve & Bake Export (F8) -->
      <section class="wb-section" aria-label="打击节奏曲线与顿帧烘焙">
        <div class="wb-sec-header">
          <span class="wb-sec-title">3. 前摇压缩 &amp; 顿帧曲线烘焙</span>
        </div>

        <div class="wb-select-row">
          <label for="sel-combat-mode">节奏曲线模式</label>
          <select id="sel-combat-mode" class="wb-select">
            <option value="auto">智能匹配 (Auto)</option>
            <option value="off">线性原速 (Off)</option>
            <option value="single">单次爆发斩击 (Single)</option>
            <option value="autoMultiHit">多段连斩峰值 (Multi-Hit)</option>
          </select>
        </div>

        <div class="wb-slider-row">
          <div class="wb-slider-head">
            <label for="rng-windup-end">蓄力前摇终点 / 加速比</label>
            <span id="val-windup-end" class="wb-val">0.28 · 1.60x</span>
          </div>
          <div class="wb-dual-inputs">
            <input type="range" id="rng-windup-end" min="0.08" max="0.65" step="0.01" value="0.28" title="前摇归一化终点" />
            <input type="range" id="rng-windup-speed" min="0.50" max="3.00" step="0.01" value="1.60" title="前摇压缩倍率" />
          </div>
          <span id="val-windup-speed" class="wb-sr-val" hidden>1.60x</span>
        </div>

        <div class="wb-slider-row">
          <div class="wb-slider-head">
            <label for="rng-strike-end">挥砍爆发终点 / 加速比</label>
            <span id="val-strike-end" class="wb-val">0.40 · 1.80x</span>
          </div>
          <div class="wb-dual-inputs">
            <input type="range" id="rng-strike-end" min="0.15" max="0.90" step="0.01" value="0.40" title="挥砍极值终点" />
            <input type="range" id="rng-strike-speed" min="0.80" max="3.00" step="0.01" value="1.80" title="出招爆发倍率" />
          </div>
          <span id="val-strike-speed" class="wb-sr-val" hidden>1.80x</span>
        </div>

        <div class="wb-slider-row">
          <div class="wb-slider-head">
            <label for="rng-hitstop-frames">命中肉感顿帧 (Hitstop)</label>
            <span id="val-hitstop-frames" class="wb-val">4 帧</span>
          </div>
          <input type="range" id="rng-hitstop-frames" min="0" max="12" step="1" value="4" />
        </div>

        <div class="wb-slider-row">
          <div class="wb-slider-head">
            <label for="rng-recovery-speed">收招回正倍率 (Recovery)</label>
            <span id="val-recovery-speed" class="wb-val">1.00x</span>
          </div>
          <input type="range" id="rng-recovery-speed" min="0.50" max="2.20" step="0.01" value="1.00" />
        </div>

        <label class="wb-check-row wb-bake-row" for="chk-bake-export">
          <input type="checkbox" id="chk-bake-export" checked />
          <span>导出 .BVH 时烘焙非线性前摇与顿帧曲线</span>
        </label>

        <button type="button" id="btn-panel-export-bvh" class="wb-export-cta">
          烘焙并导出标准 21 骨 .BVH
        </button>
      </section>
    </div>
  `;

  const q = (sel) => containerEl.querySelector(sel);

  const msBadge = q('#lbl-clean-ms');
  const bodyEl = q('#workbench-body');
  const collapseBtn = q('#btn-collapse-workbench');
  const resetBtn = q('#btn-reset-workbench');

  const chkDejitter = q('#chk-dejitter');
  const chkFootLock = q('#chk-foot-lock');
  const chkKeepFootFlat = q('#chk-keep-foot-flat');
  const chkLoopClean = q('#chk-loop-clean');
  const chkPreserveRoot = q('#chk-preserve-root');
  const rngFilterRadius = q('#rng-filter-radius');
  const valFilterRadius = q('#val-filter-radius');
  const rngFilterSigma = q('#rng-filter-sigma');
  const valFilterSigma = q('#val-filter-sigma');
  const selContactMode = q('#sel-contact-mode');
  const rngContactHeight = q('#rng-contact-height');
  const valContactHeight = q('#val-contact-height');
  const rngContactVel = q('#rng-contact-vel');
  const valContactVel = q('#val-contact-vel');
  const rngIkBlend = q('#rng-ik-blend');
  const valIkBlend = q('#val-ik-blend');
  const rngForearmTwist = q('#rng-forearm-twist');
  const valForearmTwist = q('#val-forearm-twist');

  const chkSkinHeatmap = q('#chk-skin-heatmap');
  const chkRawGhost = q('#chk-raw-ghost');

  const selCombatMode = q('#sel-combat-mode');
  const rngWindupEnd = q('#rng-windup-end');
  const rngWindupSpeed = q('#rng-windup-speed');
  const valWindupEnd = q('#val-windup-end');
  const valWindupSpeed = q('#val-windup-speed');
  const rngStrikeEnd = q('#rng-strike-end');
  const rngStrikeSpeed = q('#rng-strike-speed');
  const valStrikeEnd = q('#val-strike-end');
  const valStrikeSpeed = q('#val-strike-speed');
  const rngHitstop = q('#rng-hitstop-frames');
  const valHitstop = q('#val-hitstop-frames');
  const rngRecoverySpeed = q('#rng-recovery-speed');
  const valRecoverySpeed = q('#val-recovery-speed');
  const chkBakeExport = q('#chk-bake-export');
  const btnPanelExport = q('#btn-panel-export-bvh');

  const safeNum = (val, fallback, min = -Infinity, max = Infinity) => {
    if (val === null || val === undefined || val === '' || typeof val === 'boolean') {
      return fallback;
    }
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  function renderReadouts(lastCleanMs = null) {
    if (lastCleanMs !== null && Number.isFinite(Number(lastCleanMs))) {
      msBadge.textContent = `${Number(lastCleanMs).toFixed(1)} ms`;
    }

    chkDejitter.checked = Boolean(cleanState.deJitter);
    chkFootLock.checked = Boolean(cleanState.footLock);
    chkKeepFootFlat.checked = Boolean(cleanState.keepFootFlat ?? true);
    chkLoopClean.checked = Boolean(cleanState.loopClean);
    chkPreserveRoot.checked = Boolean(cleanState.preserveRootMotion);

    const r = Math.round(safeNum(cleanState.filterRadius, 3, 0, 60));
    rngFilterRadius.value = String(r);
    valFilterRadius.textContent = `${r}f`;

    if (
      cleanState.filterSigma === null ||
      cleanState.filterSigma === undefined ||
      cleanState.filterSigma === '' ||
      !Number.isFinite(Number(cleanState.filterSigma))
    ) {
      const autoSig = Math.max(0.85, r * 0.52);
      rngFilterSigma.value = String(autoSig.toFixed(1));
      valFilterSigma.textContent = `Auto (${autoSig.toFixed(2)})`;
    } else {
      const s = safeNum(cleanState.filterSigma, Math.max(0.85, r * 0.52), 0.1, 20.0);
      rngFilterSigma.value = String(s);
      valFilterSigma.textContent = s.toFixed(2);
    }

    selContactMode.value = cleanState.contactMode === 'threshold' ? 'threshold' : 'auto';

    const h = safeNum(cleanState.contactHeightThresh, 0.155, 0.005, 1.0);
    rngContactHeight.value = String(h);
    valContactHeight.textContent = `${(h * 100).toFixed(1)} cm`;

    const v = safeNum(cleanState.contactVelThresh, 0.92, 0.01, 20.0);
    rngContactVel.value = String(v);
    valContactVel.textContent = `${v.toFixed(2)} m/s`;

    const ikb = safeNum(cleanState.ikBlend, 1.0, 0, 1);
    rngIkBlend.value = String(ikb);
    valIkBlend.textContent = ikb.toFixed(2);

    const tw = safeNum(cleanState.forearmTwistShare, 0.58, 0, 1);
    rngForearmTwist.value = String(tw);
    valForearmTwist.textContent = `${Math.round(tw * 100)}%`;

    chkSkinHeatmap.checked = Boolean(visualState.showSkinHeatmap);
    chkRawGhost.checked = Boolean(visualState.showRawGhost);

    const validModes = ['auto', 'off', 'single', 'autoMultiHit'];
    selCombatMode.value = validModes.includes(curveState.mode) ? curveState.mode : 'auto';

    const wEnd = safeNum(curveState.windupEnd, 0.28, 0.02, 0.90);
    const wSpd = safeNum(
      Number(curveState.windupSpeed) > 0 ? curveState.windupSpeed : 1.60,
      1.60,
      0.1,
      10.0
    );
    rngWindupEnd.value = String(wEnd);
    rngWindupSpeed.value = String(wSpd);
    valWindupEnd.textContent = `${wEnd.toFixed(2)} · ${wSpd.toFixed(2)}x`;
    valWindupSpeed.textContent = `${wSpd.toFixed(2)}x`;

    const sEnd = Math.max(wEnd + 0.02, safeNum(curveState.strikeEnd, 0.40, 0.04, 0.98));
    const sSpd = safeNum(
      Number(curveState.strikeSpeed) > 0 ? curveState.strikeSpeed : 1.80,
      1.80,
      0.1,
      10.0
    );
    rngStrikeEnd.value = String(sEnd);
    rngStrikeSpeed.value = String(sSpd);
    valStrikeEnd.textContent = `${sEnd.toFixed(2)} · ${sSpd.toFixed(2)}x`;
    valStrikeSpeed.textContent = `${sSpd.toFixed(2)}x`;

    const hs = Math.round(safeNum(curveState.hitstopFrames, 4, 0, 60));
    rngHitstop.value = String(hs);
    valHitstop.textContent = `${hs} 帧`;

    const rec = safeNum(
      Number(curveState.recoverySpeed) > 0 ? curveState.recoverySpeed : 1.00,
      1.00,
      0.1,
      10.0
    );
    rngRecoverySpeed.value = String(rec);
    valRecoverySpeed.textContent = `${rec.toFixed(2)}x`;

    chkBakeExport.checked = Boolean(curveState.bakeOnExport ?? true);
  }

  const emitClean = (patch) => {
    cleanState = { ...cleanState, ...patch };
    renderReadouts();
    onCleanOptionsChange?.(patch);
  };

  const emitCurve = (patch) => {
    curveState = { ...curveState, ...patch };
    renderReadouts();
    onCombatCurveChange?.(patch);
  };

  chkDejitter.addEventListener('change', () => emitClean({ deJitter: chkDejitter.checked }));
  chkFootLock.addEventListener('change', () => emitClean({ footLock: chkFootLock.checked }));
  chkKeepFootFlat.addEventListener('change', () => emitClean({ keepFootFlat: chkKeepFootFlat.checked }));
  chkLoopClean.addEventListener('change', () => emitClean({ loopClean: chkLoopClean.checked }));
  chkPreserveRoot.addEventListener('change', () => emitClean({ preserveRootMotion: chkPreserveRoot.checked }));

  rngFilterRadius.addEventListener('input', () =>
    emitClean({ filterRadius: Number.parseInt(rngFilterRadius.value, 10) })
  );
  rngFilterSigma.addEventListener('input', () =>
    emitClean({ filterSigma: Number.parseFloat(rngFilterSigma.value) })
  );
  selContactMode.addEventListener('change', () => emitClean({ contactMode: selContactMode.value }));

  // Auto-switch contactMode to 'threshold' when threshold sliders are dragged so presets respond live
  rngContactHeight.addEventListener('input', () =>
    emitClean({
      contactMode: 'threshold',
      contactHeightThresh: Number.parseFloat(rngContactHeight.value),
    })
  );
  rngContactVel.addEventListener('input', () =>
    emitClean({
      contactMode: 'threshold',
      contactVelThresh: Number.parseFloat(rngContactVel.value),
    })
  );
  rngIkBlend.addEventListener('input', () =>
    emitClean({ ikBlend: Number.parseFloat(rngIkBlend.value) })
  );
  rngForearmTwist.addEventListener('input', () =>
    emitClean({ forearmTwistShare: Number.parseFloat(rngForearmTwist.value) })
  );

  chkSkinHeatmap.addEventListener('change', () => {
    visualState = { ...visualState, showSkinHeatmap: chkSkinHeatmap.checked };
    onVisualsChange?.({ ...visualState });
  });
  chkRawGhost.addEventListener('change', () => {
    visualState = { ...visualState, showRawGhost: chkRawGhost.checked };
    onVisualsChange?.({ ...visualState });
  });

  selCombatMode.addEventListener('change', () => emitCurve({ mode: selCombatMode.value }));
  rngWindupEnd.addEventListener('input', () => {
    const nextW = Number.parseFloat(rngWindupEnd.value);
    const nextS = Math.max(Number(curveState.strikeEnd ?? 0.40), Number((nextW + 0.03).toFixed(2)));
    emitCurve({
      mode: curveState.mode === 'off' ? 'single' : curveState.mode,
      windupEnd: nextW,
      strikeEnd: Math.min(0.95, nextS),
    });
  });
  rngWindupSpeed.addEventListener('input', () =>
    emitCurve({
      mode: curveState.mode === 'off' ? 'single' : curveState.mode,
      windupSpeed: Number.parseFloat(rngWindupSpeed.value),
    })
  );
  rngStrikeEnd.addEventListener('input', () => {
    const nextS = Number.parseFloat(rngStrikeEnd.value);
    const nextW = Math.min(Number(curveState.windupEnd ?? 0.28), Number((nextS - 0.03).toFixed(2)));
    emitCurve({
      mode: curveState.mode === 'off' ? 'single' : curveState.mode,
      windupEnd: Math.max(0.05, nextW),
      strikeEnd: nextS,
    });
  });
  rngStrikeSpeed.addEventListener('input', () =>
    emitCurve({
      mode: curveState.mode === 'off' ? 'single' : curveState.mode,
      strikeSpeed: Number.parseFloat(rngStrikeSpeed.value),
    })
  );
  rngHitstop.addEventListener('input', () =>
    emitCurve({
      mode: curveState.mode === 'off' ? 'single' : curveState.mode,
      hitstopFrames: Number.parseInt(rngHitstop.value, 10),
    })
  );
  rngRecoverySpeed.addEventListener('input', () =>
    emitCurve({
      mode: curveState.mode === 'off' ? 'single' : curveState.mode,
      recoverySpeed: Number.parseFloat(rngRecoverySpeed.value),
    })
  );
  chkBakeExport.addEventListener('change', () =>
    emitCurve({ bakeOnExport: chkBakeExport.checked })
  );

  btnPanelExport.addEventListener('click', () => {
    onExportBVH?.();
  });

  resetBtn.addEventListener('click', () => {
    onResetDefaults?.();
  });

  function setCollapsed(flag) {
    collapsed = Boolean(flag);
    bodyEl.hidden = collapsed;
    containerEl.classList.toggle('is-collapsed', collapsed);
    collapseBtn.textContent = collapsed ? '展开' : '收起';
    onCollapseChange?.(collapsed);
  }

  collapseBtn.addEventListener('click', () => {
    setCollapsed(!collapsed);
  });

  renderReadouts(0);

  return {
    syncState({ cleanOptions, combatCurve, visuals, lastCleanDurationMs }) {
      if (cleanOptions) cleanState = { ...cleanState, ...cleanOptions };
      if (combatCurve) curveState = { ...curveState, ...combatCurve };
      if (visuals) visualState = { ...visualState, ...visuals };
      renderReadouts(lastCleanDurationMs);
    },
    setCollapsed,
    isCollapsed: () => collapsed,
  };
}
