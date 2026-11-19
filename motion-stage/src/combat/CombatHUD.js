/**
 * Scoped Wuxia Combat Arena HUD (`CombatHUD.js`).
 * Uses dirty-checked DOM mutations (`tabular-nums`, `scaleX` transforms) for zero-jank 60fps updates.
 */

export class CombatHUD {
  constructor(rootEl, handlers = {}, options = {}) {
    this.rootEl = rootEl;
    this.handlers = handlers;
    this.embedded = Boolean(options.embedded);

    const titleHeaderHtml = this.embedded
      ? ''
      : `<h1 id="combat-stage-title">MotionStage · 武侠肉鸽战斗验证台</h1>
        <div class="combat-divider combat-title-divider"></div>`;

    this.hudLayer = document.createElement('div');
    this.hudLayer.className = 'combat-hud-layer';
    this.hudLayer.innerHTML = `
      <header id="combat-top-bar" class="combat-glass-bar" role="toolbar" aria-label="演武台控制栏">
        ${titleHeaderHtml}
        <button type="button" id="btn-combat-lockon" class="combat-btn">Tab · 视角自由</button>
        <div class="combat-segmented" role="group" aria-label="陪练木桩模式">
          <button type="button" id="btn-dummy-mode-1" class="combat-btn is-selected">1 静置木桩</button>
          <button type="button" id="btn-dummy-mode-2" class="combat-btn">2 轻击陪练</button>
          <button type="button" id="btn-dummy-mode-3" class="combat-btn">3 重击击飞</button>
        </div>
        <button type="button" id="btn-combat-reset" class="combat-btn">重置演武</button>
      </header>

      <section id="combat-dummy-hud" class="combat-glass-bar" aria-label="陪练木桩状态">
        <div class="combat-dummy-head">
          <span id="lbl-dummy-title">玄铁机关木桩</span>
          <span id="lbl-dummy-ai-state">静置木桩戒备</span>
        </div>
        <div class="combat-meter-row">
          <span class="combat-meter-label">气血</span>
          <div class="combat-meter-track"><div id="bar-dummy-hp-fill" class="combat-meter-fill"></div></div>
          <span id="lbl-dummy-hp" class="combat-meter-val">1000 / 1000</span>
        </div>
        <div class="combat-meter-row">
          <span class="combat-meter-label">定力</span>
          <div class="combat-meter-track"><div id="bar-dummy-poise-fill" class="combat-meter-fill"></div></div>
          <span id="lbl-dummy-poise" class="combat-meter-val">100 / 100</span>
        </div>
      </section>

      <aside id="combat-telemetry-hud" class="combat-glass-bar" aria-label="状态机与上下半身分层混合遥测">
        <div class="combat-telem-header">
          <span id="lbl-fsm-state">Idle · 持剑戒备待机</span>
          <span id="lbl-fsm-priority">Prio 0</span>
        </div>
        <div class="combat-meter-row">
          <span class="combat-meter-label">相位</span>
          <div class="combat-meter-track"><div id="bar-fsm-u-fill" class="combat-meter-fill"></div></div>
          <span id="lbl-fsm-u" class="combat-meter-val">0.00</span>
        </div>
        <div class="combat-badge-row">
          <span id="badge-iframe" class="combat-window-pill">无敌帧</span>
          <span id="badge-parry" class="combat-window-pill">无痕弹反窗</span>
          <span id="badge-combo" class="combat-window-pill">连段缓冲</span>
          <span id="badge-wuhen-buff" class="combat-window-pill">剑意加持</span>
        </div>
        <div class="combat-layer-grid">
          <span class="combat-layer-key">下盘驱动</span>
          <span id="lbl-base-clip" class="combat-layer-val">taibai_01b</span>
          <span class="combat-layer-key">上盘覆写</span>
          <span id="lbl-upper-clip" class="combat-layer-val">— (全身轨道)</span>
        </div>
        <div class="combat-meter-row">
          <span class="combat-meter-label">混合</span>
          <div class="combat-meter-track"><div id="bar-upper-alpha-fill" class="combat-meter-fill"></div></div>
          <span id="lbl-upper-alpha" class="combat-meter-val">0.00</span>
        </div>
        <div id="lbl-bone-weights-summary">Hips/Legs 0% · Spine 55% · Chest 85% · Arms 100%</div>
        <div id="lbl-player-pos" class="combat-layer-val">WASD 移动 · X 0.00m · Z 0.00m</div>
      </aside>

      <div id="combat-combo-hud" aria-live="polite">
        <div id="combat-combo-wrap" class="combat-combo-wrap">
          <span id="lbl-combo-counter">0</span>
          <span class="combat-combo-unit">连击</span>
        </div>
        <div id="lbl-combat-banner"></div>
      </div>

      <nav id="combat-skill-dock" class="combat-glass-bar" aria-label="武侠招式快捷栏">
        <button type="button" id="btn-action-attack" class="combat-skill-btn">
          <span class="combat-keycap">J / 左键</span>
          <span class="combat-skill-name">云台三落</span>
        </button>
        <button type="button" id="btn-action-dash" class="combat-skill-btn">
          <span class="combat-keycap">Shift</span>
          <span class="combat-skill-name">苍龙出水</span>
        </button>
        <button type="button" id="btn-action-roll" class="combat-skill-btn">
          <span class="combat-keycap">C</span>
          <span class="combat-skill-name">翻滚闪避</span>
        </button>
        <button type="button" id="btn-action-jump" class="combat-skill-btn">
          <span class="combat-keycap">Space</span>
          <span class="combat-skill-name">轻功/打挺</span>
        </button>
        <button type="button" id="btn-action-wuhen" class="combat-skill-btn">
          <span class="combat-keycap">Q</span>
          <span class="combat-skill-name">无痕剑意</span>
        </button>
        <button type="button" id="btn-action-yuluo" class="combat-skill-btn">
          <span class="combat-keycap">E</span>
          <span class="combat-skill-name">雨落云飞</span>
        </button>
        <button type="button" id="btn-action-feiyan" class="combat-skill-btn">
          <span class="combat-keycap">R</span>
          <span class="combat-skill-name">飞燕逐月</span>
        </button>
        <button type="button" id="btn-action-kick" class="combat-skill-btn">
          <span class="combat-keycap">F</span>
          <span class="combat-skill-name">正蹬破防</span>
        </button>
        <button type="button" id="btn-action-backflip" class="combat-skill-btn">
          <span id="keycap-backflip" class="combat-keycap">V</span>
          <span class="combat-skill-name">燕回朝阳</span>
        </button>
      </nav>
    `;

    this.rootEl.appendChild(this.hudLayer);

    // Cache DOM elements once
    const q = (sel) => this.hudLayer.querySelector(sel);
    this.els = {
      btnLockOn: q('#btn-combat-lockon'),
      btnMode1: q('#btn-dummy-mode-1'),
      btnMode2: q('#btn-dummy-mode-2'),
      btnMode3: q('#btn-dummy-mode-3'),
      btnReset: q('#btn-combat-reset'),
      lblDummyAi: q('#lbl-dummy-ai-state'),
      barDummyHp: q('#bar-dummy-hp-fill'),
      lblDummyHp: q('#lbl-dummy-hp'),
      barDummyPoise: q('#bar-dummy-poise-fill'),
      lblDummyPoise: q('#lbl-dummy-poise'),
      lblFsmState: q('#lbl-fsm-state'),
      lblFsmPrio: q('#lbl-fsm-priority'),
      barFsmU: q('#bar-fsm-u-fill'),
      lblFsmU: q('#lbl-fsm-u'),
      badgeIframe: q('#badge-iframe'),
      badgeParry: q('#badge-parry'),
      badgeCombo: q('#badge-combo'),
      badgeWuhen: q('#badge-wuhen-buff'),
      lblBaseClip: q('#lbl-base-clip'),
      lblUpperClip: q('#lbl-upper-clip'),
      barUpperAlpha: q('#bar-upper-alpha-fill'),
      lblUpperAlpha: q('#lbl-upper-alpha'),
      lblPlayerPos: q('#lbl-player-pos'),
      comboWrap: q('#combat-combo-wrap'),
      lblCombo: q('#lbl-combo-counter'),
      lblBanner: q('#lbl-combat-banner'),
      btnAttack: q('#btn-action-attack'),
      btnDash: q('#btn-action-dash'),
      btnRoll: q('#btn-action-roll'),
      btnJump: q('#btn-action-jump'),
      btnWuhen: q('#btn-action-wuhen'),
      btnYuluo: q('#btn-action-yuluo'),
      btnFeiyan: q('#btn-action-feiyan'),
      btnKick: q('#btn-action-kick'),
      btnBackflip: q('#btn-action-backflip'),
      keycapBackflip: q('#keycap-backflip'),
    };

    this._cache = {};
    this._abortCtrl = new AbortController();
    this._wireButtons();
  }

  _wireButtons() {
    const sig = { signal: this._abortCtrl.signal };
    const dispatch = (act, payload) => {
      if (typeof this.handlers.onDispatch === 'function') {
        this.handlers.onDispatch(act, payload);
      }
    };

    this.els.btnLockOn.addEventListener('click', () => dispatch('ToggleLockOn'), sig);
    this.els.btnMode1.addEventListener('click', () => dispatch('SetDummyMode', 1), sig);
    this.els.btnMode2.addEventListener('click', () => dispatch('SetDummyMode', 2), sig);
    this.els.btnMode3.addEventListener('click', () => dispatch('SetDummyMode', 3), sig);
    this.els.btnReset.addEventListener('click', () => dispatch('ResetArena'), sig);

    this.els.btnAttack.addEventListener('click', () => dispatch('Attack'), sig);
    this.els.btnDash.addEventListener('click', () => dispatch('Dodge_Dash'), sig);
    this.els.btnRoll.addEventListener('click', () => dispatch('Dodge_Roll'), sig);
    this.els.btnJump.addEventListener('click', () => dispatch('Jump'), sig);
    this.els.btnWuhen.addEventListener('click', () => dispatch('Skill_Wuhen'), sig);
    this.els.btnYuluo.addEventListener('click', () => dispatch('Skill_Yuluo'), sig);
    this.els.btnFeiyan.addEventListener('click', () => dispatch('Skill_Feiyan'), sig);
    this.els.btnKick.addEventListener('click', () => dispatch('Skill_Kick'), sig);
    this.els.btnBackflip.addEventListener('click', () => dispatch('Evade_Backflip'), sig);
  }

  _setText(key, el, val) {
    if (this._cache[key] !== val) {
      this._cache[key] = val;
      el.textContent = val;
    }
  }

  _setScaleX(key, el, ratio) {
    const q = Math.max(0, Math.min(1, ratio)).toFixed(3);
    if (this._cache[key] !== q) {
      this._cache[key] = q;
      el.style.transform = `scaleX(${q})`;
    }
  }

  _setClass(key, el, className, active) {
    const b = Boolean(active);
    if (this._cache[key] !== b) {
      this._cache[key] = b;
      el.classList.toggle(className, b);
    }
  }

  update(snapshot) {
    const {
      currentState,
      wuxiaName,
      stateNormalizedTime,
      priority,
      isInvulnerable,
      inParryWindow,
      canComboChain,
      wuhenBuffRemainingMs,
      backflipCooldownMs,
      baseClipId,
      upperClipId,
      upperLayerAlpha,
      playerWorldPos,
      isLockedOn,
      strafeSector,
      dummyMode,
      dummyHp,
      dummyMaxHp = 1000,
      dummyPoise,
      dummyMaxPoise = 100,
      dummyAiLabel,
      comboCount,
      bannerText,
    } = snapshot;

    this._setText('lockTxt', this.els.btnLockOn, isLockedOn ? `Tab · 锁定中 (${strafeSector})` : 'Tab · 视角自由');
    this._setClass('lockCls', this.els.btnLockOn, 'is-active-jade', isLockedOn);

    this._setClass('m1', this.els.btnMode1, 'is-selected', dummyMode === 1);
    this._setClass('m2', this.els.btnMode2, 'is-selected', dummyMode === 2);
    this._setClass('m3', this.els.btnMode3, 'is-selected', dummyMode === 3);

    this._setText('dAi', this.els.lblDummyAi, dummyAiLabel || '');
    this._setScaleX('dHpB', this.els.barDummyHp, dummyHp / dummyMaxHp);
    this._setText('dHpT', this.els.lblDummyHp, `${Math.round(dummyHp)} / ${dummyMaxHp}`);
    this._setScaleX('dPsB', this.els.barDummyPoise, dummyPoise / dummyMaxPoise);
    this._setText('dPsT', this.els.lblDummyPoise, `${Math.round(dummyPoise)} / ${dummyMaxPoise}`);

    this._setText('fsmS', this.els.lblFsmState, `${currentState} · ${wuxiaName || ''}`);
    this._setText('fsmP', this.els.lblFsmPrio, `Prio ${priority}`);
    this._setScaleX('fsmUB', this.els.barFsmU, stateNormalizedTime);
    this._setText('fsmUT', this.els.lblFsmU, stateNormalizedTime.toFixed(2));

    this._setClass('bIf', this.els.badgeIframe, 'is-lit-jade', isInvulnerable);
    this._setClass('bPa', this.els.badgeParry, 'is-lit-amber', inParryWindow);
    this._setClass('bCo', this.els.badgeCombo, 'is-lit-jade', canComboChain);
    this._setClass('bWu', this.els.badgeWuhen, 'is-lit-amber', wuhenBuffRemainingMs > 0);

    this._setText('lBase', this.els.lblBaseClip, baseClipId || '—');
    this._setText(
      'lUp',
      this.els.lblUpperClip,
      upperClipId ? `${upperClipId} (移动挥砍)` : '— (全身轨道)'
    );
    this._setScaleX('uAlB', this.els.barUpperAlpha, upperLayerAlpha);
    this._setText('uAlT', this.els.lblUpperAlpha, upperLayerAlpha.toFixed(2));

    this._setText(
      'pPos',
      this.els.lblPlayerPos,
      `X ${playerWorldPos.x.toFixed(2)}m · Y ${playerWorldPos.y.toFixed(2)}m · Z ${playerWorldPos.z.toFixed(2)}m`
    );

    this._setClass('cVis', this.els.comboWrap, 'is-visible', comboCount > 0);
    if (comboCount > 0) {
      this._setText('cNum', this.els.lblCombo, String(comboCount));
    }

    const hasBanner = Boolean(bannerText);
    this._setClass('bnVis', this.els.lblBanner, 'is-visible', hasBanner);
    if (hasBanner) {
      this._setText('bnTxt', this.els.lblBanner, bannerText);
    }

    // Highlight active skill pill & backflip cooldown
    this._setClass('skAtk', this.els.btnAttack, 'is-active-skill', currentState.startsWith('Attack_Combo'));
    this._setClass('skDash', this.els.btnDash, 'is-active-skill', currentState === 'Dodge_Dash');
    this._setClass('skRoll', this.els.btnRoll, 'is-active-skill', currentState === 'Dodge_Roll');
    this._setClass(
      'skJump',
      this.els.btnJump,
      'is-active-skill',
      currentState === 'Jump' || currentState === 'Air_Jump_Double' || currentState === 'KipUp'
    );
    this._setClass('skWu', this.els.btnWuhen, 'is-active-skill', currentState === 'Skill_Wuhen');
    this._setClass('skYu', this.els.btnYuluo, 'is-active-skill', currentState === 'Skill_Yuluo');
    this._setClass('skFe', this.els.btnFeiyan, 'is-active-skill', currentState === 'Skill_Feiyan');
    this._setClass('skKi', this.els.btnKick, 'is-active-skill', currentState === 'Skill_Kick');
    this._setClass('skBf', this.els.btnBackflip, 'is-active-skill', currentState === 'Evade_Backflip');

    const bfOnCd = backflipCooldownMs > 50;
    this._setClass('bfCd', this.els.btnBackflip, 'is-on-cooldown', bfOnCd);
    this._setText(
      'bfKey',
      this.els.keycapBackflip,
      bfOnCd ? `${(backflipCooldownMs / 1000).toFixed(1)}s` : 'V'
    );
  }

  destroy() {
    this._abortCtrl.abort();
    this.hudLayer.remove();
  }
}
