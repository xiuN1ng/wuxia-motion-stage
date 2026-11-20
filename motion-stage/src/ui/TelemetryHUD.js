/**
 * High-DPI Canvas Telemetry HUD (`#telemetry-hud`) for `F9`:
 * Displays frame-by-frame Raw (`#f09b36`) vs Cleaned (`#34b89a`) Foot-Slip (`cm/s`),
 * High-Frequency Jitter, Combat Time-Warp `warpedU(u)` + Hitstop amber bands,
 * `L`/`R` stance contact jade strips, live playhead sync, and pointer scrubbing.
 */
export function createTelemetryHUD(containerEl, { onScrubNormalizedTime } = {}) {
  let activeTab = 'slip'; // 'slip' | 'jitter' | 'warp'
  let collapsed = false;
  let currentData = null;
  let playheadU = 0;
  let playheadWarpedU = 0;
  let playheadHitstop = false;
  let isScrubbing = false;

  const offscreen = document.createElement('canvas');
  let staticDirty = true;

  containerEl.innerHTML = `
    <div class="hud-header">
      <div class="hud-tabs" role="tablist" aria-label="动作遥测误差曲线切换">
        <button type="button" id="hud-tab-slip" class="hud-tab active" data-tab="slip" role="tab" aria-selected="true">
          滑步 Slip cm/s
        </button>
        <button type="button" id="hud-tab-jitter" class="hud-tab" data-tab="jitter" role="tab" aria-selected="false">
          抖动 Jitter
        </button>
        <button type="button" id="hud-tab-warp" class="hud-tab" data-tab="warp" role="tab" aria-selected="false">
          节奏曲线 Warp
        </button>
      </div>
      <button type="button" id="btn-collapse-telemetry" class="wb-mini-btn" title="折叠或展开遥测曲线图">收起</button>
    </div>

    <div class="hud-origin-row" id="hud-origin-row">
      <span id="badge-origin-type" class="hud-origin-pill is-origin-mocap">开源 · MakeHuman</span>
      <span id="lbl-origin-detail" class="hud-origin-detail" title="">avatar_sword_strike_R.bvh (CC0)</span>
    </div>

    <div class="hud-badges">
      <span id="badge-slip-stats" class="hud-stat-badge">滑步 RMS 0.0 → 0.0 cm/s</span>
      <span id="badge-jitter-stats" class="hud-stat-badge">抖动 RMS 0.00 → 0.00</span>
    </div>

    <div class="hud-canvas-wrap" id="hud-canvas-wrap">
      <canvas id="telemetry-canvas" width="336" height="112" aria-label="滑步与抖动帧级对比曲线"></canvas>
      <div class="hud-legend">
        <span class="hud-leg-raw"><i></i>原始 Raw</span>
        <span class="hud-leg-clean"><i></i>修复 Clean</span>
        <span class="hud-leg-stance"><i></i>L/R 锁脚区间</span>
      </div>
    </div>
  `;

  const canvas = containerEl.querySelector('#telemetry-canvas');
  const canvasWrap = containerEl.querySelector('#hud-canvas-wrap');
  const originBadge = containerEl.querySelector('#badge-origin-type');
  const originDetail = containerEl.querySelector('#lbl-origin-detail');
  const slipBadge = containerEl.querySelector('#badge-slip-stats');
  const jitterBadge = containerEl.querySelector('#badge-jitter-stats');
  const collapseBtn = containerEl.querySelector('#btn-collapse-telemetry');
  const tabBtns = Array.from(containerEl.querySelectorAll('.hud-tab'));

  const PAD = { left: 32, right: 8, top: 8, bottom: 18 };
  let cssWidth = 336;
  let cssHeight = 112;
  let dpr = 1;

  function formatReduction(rawVal, cleanVal) {
    if (!Number.isFinite(rawVal) || !Number.isFinite(cleanVal) || rawVal <= 1e-3) {
      return '';
    }
    const pct = Math.round((1 - cleanVal / rawVal) * 100);
    if (!Number.isFinite(pct) || pct === 0) return '';
    return pct > 0 ? ` (-${pct}%)` : ` (+${Math.abs(pct)}%)`;
  }

  function updateBadges() {
    const prov = currentData?.provenance;
    if (prov && originBadge && originDetail) {
      originBadge.textContent = prov.badgeLabel || prov.tagShort || '开源动捕库';
      originBadge.classList.toggle('is-origin-ai', prov.originGroup === 'ai_extracted');
      originBadge.classList.toggle('is-origin-mocap', prov.originGroup === 'open_mocap');
      originBadge.classList.toggle('is-origin-custom', prov.originGroup === 'custom_bvh');
      originDetail.textContent = prov.upstreamText || '';
      originDetail.title = `${prov.badgeLabel || ''} — ${prov.upstreamText || ''}`;
    }

    if (!currentData?.rawTelemetry || !currentData?.cleanTelemetry) return;
    const rawT = currentData.rawTelemetry;
    const clnT = currentData.cleanTelemetry;

    const rSlip = Number(rawT.rmsSlipCmS || 0);
    const cSlip = Number(clnT.rmsSlipCmS || 0);
    const cMax = Number(clnT.maxSlipCmS || 0);
    slipBadge.textContent = `滑步 RMS ${rSlip.toFixed(1)}→${cSlip.toFixed(1)} cm/s${formatReduction(rSlip, cSlip)} · Max ${cMax.toFixed(1)}`;

    const rJit = Number(rawT.rmsJitter || 0);
    const cJit = Number(clnT.rmsJitter || 0);
    jitterBadge.textContent = `抖动 RMS ${rJit.toFixed(2)}→${cJit.toFixed(2)}${formatReduction(rJit, cJit)}`;
  }

  function syncCanvasDimensions() {
    const rect = canvas.getBoundingClientRect();
    const targetW = Math.max(220, Math.round(rect.width || 336));
    const targetH = Math.max(84, Math.round(rect.height || 112));
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);

    if (targetW !== cssWidth || targetH !== cssHeight || nextDpr !== dpr) {
      cssWidth = targetW;
      cssHeight = targetH;
      dpr = nextDpr;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      offscreen.width = canvas.width;
      offscreen.height = canvas.height;
      staticDirty = true;
    }
  }

  function renderStaticLayer() {
    staticDirty = false;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const plotW = Math.max(20, cssWidth - PAD.left - PAD.right);
    const plotH = Math.max(20, cssHeight - PAD.top - PAD.bottom);

    // Subtle plot background
    ctx.fillStyle = 'hsla(218, 18%, 7%, 0.78)';
    ctx.fillRect(PAD.left, PAD.top, plotW, plotH);

    // Horizontal reference grid lines
    ctx.strokeStyle = 'hsla(214, 15%, 78%, 0.08)';
    ctx.lineWidth = 1;
    for (const frac of [0, 0.5, 1]) {
      const y = PAD.top + plotH * (1 - frac);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + plotW, y);
      ctx.stroke();
    }

    if (!currentData) {
      ctx.restore();
      return;
    }

    const { clip, cleanedFrames, rawTelemetry, cleanTelemetry, remapFn } = currentData;

    // 1. Sample hitstop freeze bands along [0..1]
    if (typeof remapFn === 'function') {
      const steps = 120;
      ctx.fillStyle = 'hsla(34, 86%, 56%, 0.16)';
      for (let i = 0; i < steps; i++) {
        const uMid = (i + 0.5) / steps;
        const r = remapFn(uMid);
        if (r?.inHitstop) {
          const x0 = PAD.left + (i / steps) * plotW;
          ctx.fillRect(x0, PAD.top, plotW / steps + 0.5, plotH);
        }
      }
    }

    // 2. Bottom L/R Stance Contact Jade Strips
    const stanceL = cleanTelemetry?.stanceLSeries;
    const stanceR = cleanTelemetry?.stanceRSeries;
    const nStance = stanceL?.length || cleanedFrames?.length || 0;
    if (nStance > 0) {
      const stripY = PAD.top + plotH + 4;
      const segW = plotW / nStance;
      for (let f = 0; f < nStance; f++) {
        const lOn = stanceL ? stanceL[f] > 0 : (cleanedFrames?.[f]?.lockWeightL || 0) > 0.5;
        const rOn = stanceR ? stanceR[f] > 0 : (cleanedFrames?.[f]?.lockWeightR || 0) > 0.5;
        const x = PAD.left + f * segW;
        if (lOn) {
          ctx.fillStyle = 'hsla(166, 62%, 48%, 0.72)';
          ctx.fillRect(x, stripY, Math.max(1, segW + 0.4), 4);
        }
        if (rOn) {
          ctx.fillStyle = 'hsla(186, 64%, 56%, 0.72)';
          ctx.fillRect(x, stripY + 5.5, Math.max(1, segW + 0.4), 4);
        }
      }
      ctx.fillStyle = 'hsla(214, 12%, 62%, 0.75)';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText('L/R', PAD.left - 4, stripY + 8);
    }

    // 3. Plot curves according to activeTab
    if (activeTab === 'warp') {
      ctx.fillStyle = 'hsla(214, 12%, 66%, 0.85)';
      ctx.font = '9.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText('1.0', PAD.left - 4, PAD.top + 8);
      ctx.fillText('0.0', PAD.left - 4, PAD.top + plotH);

      // Linear reference diagonal (Raw uniform time)
      ctx.strokeStyle = 'hsla(34, 82%, 58%, 0.58)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(PAD.left, PAD.top + plotH);
      ctx.lineTo(PAD.left + plotW, PAD.top);
      ctx.stroke();
      ctx.setLineDash([]);

      // Warped combat time curve
      if (typeof remapFn === 'function') {
        ctx.strokeStyle = 'hsl(166, 58%, 48%)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        const samples = 120;
        for (let i = 0; i <= samples; i++) {
          const u = i / samples;
          const { warpedU } = remapFn(u);
          const x = PAD.left + u * plotW;
          const y = PAD.top + (1 - Math.max(0, Math.min(1, warpedU))) * plotH;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    } else {
      const rawArr =
        activeTab === 'slip'
          ? rawTelemetry?.slipSeriesCmS || Array.from(rawTelemetry?.slipSeries || [], (v) => v * 100)
          : rawTelemetry?.jitterSeries || [];
      const clnArr =
        activeTab === 'slip'
          ? cleanTelemetry?.slipSeriesCmS || Array.from(cleanTelemetry?.slipSeries || [], (v) => v * 100)
          : cleanTelemetry?.jitterSeries || [];

      let peak = activeTab === 'slip' ? 20 : 2.0;
      for (let i = 0; i < rawArr.length; i++) {
        if (Number.isFinite(rawArr[i]) && rawArr[i] > peak) peak = rawArr[i];
      }
      for (let i = 0; i < clnArr.length; i++) {
        if (Number.isFinite(clnArr[i]) && clnArr[i] > peak) peak = clnArr[i];
      }
      peak *= 1.08;

      ctx.fillStyle = 'hsla(214, 12%, 66%, 0.85)';
      ctx.font = '9.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(activeTab === 'slip' ? `${Math.round(peak)}` : peak.toFixed(1), PAD.left - 4, PAD.top + 8);
      ctx.fillText('0', PAD.left - 4, PAD.top + plotH);

      const drawSeries = (arr, strokeStyle, fillStyle, lineWidth) => {
        const len = arr.length;
        if (!len) return;
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
          const u = len > 1 ? i / (len - 1) : 0;
          const v = Number.isFinite(arr[i]) ? Math.max(0, arr[i]) : 0;
          const x = PAD.left + u * plotW;
          const y = PAD.top + (1 - Math.min(1, v / peak)) * plotH;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.stroke();

        if (fillStyle && len > 1) {
          ctx.lineTo(PAD.left + plotW, PAD.top + plotH);
          ctx.lineTo(PAD.left, PAD.top + plotH);
          ctx.closePath();
          ctx.fillStyle = fillStyle;
          ctx.fill();
        }
      };

      drawSeries(rawArr, 'hsla(34, 84%, 58%, 0.90)', 'hsla(34, 84%, 58%, 0.10)', 1.35);
      drawSeries(clnArr, 'hsl(166, 60%, 48%)', 'hsla(166, 60%, 48%, 0.16)', 1.75);
      void clip;
    }

    ctx.restore();
  }

  function drawFrame() {
    if (collapsed) return;
    syncCanvasDimensions();
    if (staticDirty) {
      renderStaticLayer();
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(offscreen, 0, 0);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const plotW = Math.max(20, cssWidth - PAD.left - PAD.right);
    const plotH = Math.max(20, cssHeight - PAD.top - PAD.bottom);

    const needleU = activeTab === 'warp' ? playheadU : playheadWarpedU;
    const x = PAD.left + Math.max(0, Math.min(1, needleU)) * plotW;

    ctx.strokeStyle = playheadHitstop ? 'hsl(34, 92%, 64%)' : 'hsla(210, 30%, 96%, 0.88)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + plotH + 10);
    ctx.stroke();

    if (activeTab === 'warp') {
      const y = PAD.top + (1 - Math.max(0, Math.min(1, playheadWarpedU))) * plotH;
      ctx.fillStyle = playheadHitstop ? 'hsl(34, 92%, 64%)' : 'hsl(166, 62%, 52%)';
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function setMode(nextTab) {
    if (!['slip', 'jitter', 'warp'].includes(nextTab)) return;
    activeTab = nextTab;
    tabBtns.forEach((btn) => {
      const active = btn.dataset.tab === activeTab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    staticDirty = true;
    drawFrame();
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.tab));
  });

  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    canvasWrap.hidden = collapsed;
    containerEl.classList.toggle('is-collapsed', collapsed);
    collapseBtn.textContent = collapsed ? '展开' : '收起';
    if (!collapsed) {
      staticDirty = true;
      drawFrame();
    }
  });

  const scrubAtEvent = (e) => {
    const rect = canvas.getBoundingClientRect();
    const plotW = Math.max(20, rect.width - PAD.left - PAD.right);
    const localX = e.clientX - rect.left - PAD.left;
    const u = Math.max(0, Math.min(1, localX / plotW));
    onScrubNormalizedTime?.(u);
  };

  canvas.addEventListener('pointerdown', (e) => {
    isScrubbing = true;
    canvas.setPointerCapture?.(e.pointerId);
    scrubAtEvent(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!isScrubbing) return;
    scrubAtEvent(e);
  });
  const endScrub = (e) => {
    if (!isScrubbing) return;
    isScrubbing = false;
    try {
      canvas.releasePointerCapture?.(e.pointerId);
    } catch {
      // Ignore pointer capture release errors
    }
  };
  canvas.addEventListener('pointerup', endScrub);
  canvas.addEventListener('pointercancel', endScrub);

  return {
    updateData(data) {
      currentData = data;
      updateBadges();
      staticDirty = true;
      drawFrame();
    },
    updatePlayhead(normalizedTime, warpedU = normalizedTime, inHitstop = false) {
      playheadU = normalizedTime;
      playheadWarpedU = warpedU;
      playheadHitstop = Boolean(inHitstop);
      drawFrame();
    },
    setMode,
    getMode: () => activeTab,
    resize() {
      staticDirty = true;
      drawFrame();
    },
  };
}
