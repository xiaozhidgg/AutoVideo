// AutoVideo —— 自动刷视频内容脚本
// 支持平台：抖音（含抖音精选信息流）/ 快手 / TikTok / Instagram / Facebook
// 工作方式：每秒检查一次主视频，停留设置时长后切换下一个视频。
// 切换策略自适应：
//   全屏播放页：点击"下一个"按钮 -> 模拟键盘 ↓ -> 滚动
//   信息流页面（抖音精选/瀑布流）：滚动 -> 模拟键盘 ↓ -> 点击按钮
// 另注入网页悬浮条：置顶显示运行状态，可拖拽、可折叠。
(() => {
  if (window.__AUTOVIEW_INSTALLED__) return;
  window.__AUTOVIEW_INSTALLED__ = true;

  const HOST = location.hostname.replace(/^www\./, '');

  // 策略链生成：next = 全屏播放页，feed = 信息流页
  function nextChain(clickSelectors, keys) {
    return [
      { type: 'click', selectors: clickSelectors },
      { type: 'key', keys },
      { type: 'scroll' },
    ];
  }
  function feedChain(clickSelectors, keys) {
    return [
      { type: 'scroll' },
      { type: 'key', keys },
      { type: 'click', selectors: clickSelectors },
    ];
  }

  const PLATFORMS = [
    {
      name: '抖音',
      domains: ['douyin.com'],
      next: nextChain(['[aria-label*="下一个"]', '[aria-label*="next" i]'], ['ArrowDown', 'PageDown', ' ']),
      feed: feedChain(['[aria-label*="下一个"]', '[aria-label*="next" i]'], ['ArrowDown', 'PageDown', ' ']),
    },
    {
      name: '快手',
      domains: ['kuaishou.com'],
      next: nextChain(['[aria-label*="下一个"]', '[aria-label*="next" i]'], ['ArrowDown', 'PageDown', ' ']),
      feed: feedChain(['[aria-label*="下一个"]', '[aria-label*="next" i]'], ['ArrowDown', 'PageDown', ' ']),
    },
    {
      name: 'TikTok',
      domains: ['tiktok.com'],
      next: nextChain(['[data-e2e="browse-next"]'], ['ArrowDown', 'PageDown', ' ']),
      feed: feedChain(['[data-e2e="browse-next"]'], ['ArrowDown', 'PageDown', ' ']),
    },
    {
      name: 'Instagram',
      domains: ['instagram.com'],
      next: nextChain(['svg[aria-label="Next"]', '[aria-label="Next"]', '[aria-label="Next video"]'], ['ArrowDown', 'PageDown']),
      feed: feedChain(['svg[aria-label="Next"]', '[aria-label="Next"]', '[aria-label="Next video"]'], ['ArrowDown', 'PageDown']),
    },
    {
      name: 'Facebook',
      domains: ['facebook.com'],
      next: nextChain(['[aria-label="Next video"]', '[aria-label="Next"]'], ['ArrowDown', 'PageDown']),
      feed: feedChain(['[aria-label="Next video"]', '[aria-label="Next"]'], ['ArrowDown', 'PageDown']),
    },
  ];

  const platform = PLATFORMS.find((p) => p.domains.some((d) => HOST === d || HOST.endsWith('.' + d)));
  if (!platform) return; // 不支持的页面

  // ---------- 设置与状态 ----------
  const DEFAULTS = { interval: 15, mute: false, jitter: true, advanceOnEnd: true };
  let settings = { ...DEFAULTS };

  let running = false;
  let status = 'idle'; // idle | starting | running | waiting | no-video | hidden | stopped
  let stopReason = '';
  let watched = 0;
  let startedAt = 0;

  let lastSig = null;
  let sinceChange = 0;
  let nextTarget = 0;
  let pausedTicks = 0; // 视频暂停未恢复的连续秒数
  let lastStatusBroadcast = '';
  let noVideoTicks = 0;
  let lastAdvanceAt = 0;   // 上次执行切换的时间（防连点 + 页面底部降频）
  let failStreak = 0;      // 连续未换到新视频的周期数（≥3 切换备用策略链）
  let chainOverride = null; // 备用策略链：null | 'next' | 'feed'
  let lastNewVideoAt = 0;  // 元素抖动保护：2 秒内的重复"新视频"判定视为抖动
  let cand = null;         // 候选确认：{ el, src, ticks } 信号变化后需连续 2 tick 稳定

  const TICK_MS = 1000;
  let timer = null;

  // ---------- 工具函数 ----------
  function broadcast() {
    chrome.runtime
      .sendMessage({ type: 'AUTOVIEW_STATE', state: { running, status, watched, platform: platform.name, startedAt, stopReason } })
      .catch(() => {});
    chrome.runtime.sendMessage({ type: 'AUTOVIEW_BADGE', running }).catch(() => {});
    syncFloat();
  }

  function setStatus(s, reason = '') {
    status = s;
    stopReason = reason;
  }

  // 只在状态变化时广播，避免每秒向 popup 发消息
  function broadcastStatus(s) {
    if (s !== lastStatusBroadcast) {
      lastStatusBroadcast = s;
      broadcast();
    }
  }

  // 找出视口内面积最大的视频元素（当前主视频）
  function getMainVideo() {
    const vids = document.querySelectorAll('video');
    let best = null;
    let bestArea = 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const x = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const y = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const area = x * y;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  // 当前视频是否全屏播放（占视口较大比例）→ 决定用全屏策略还是信息流策略
  function isFullscreenLayout() {
    const v = getMainVideo();
    if (!v) return false; // 无视频时按信息流策略走（滚动优先，例如图片帖区域）
    const r = v.getBoundingClientRect();
    return r.width * r.height >= window.innerWidth * window.innerHeight * 0.45;
  }

  function isScrollable(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2;
  }

  // 找到可滚动范围最大的容器（信息流页面可能有嵌套滚动容器）
  function getScroller(v) {
    const cands = [];
    let el = v && v.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      if (isScrollable(el)) cands.push(el);
      el = el.parentElement;
    }
    cands.push(document.scrollingElement || document.documentElement);
    cands.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return cands[0];
  }

  // ---- 模拟键盘（增强版）：先聚焦视频，再把 keydown/keypress/keyup
  // 派发到 activeElement、视频、body、document、window 各层
  const KEY_SPEC = {
    ArrowDown: { code: 'ArrowDown', keyCode: 40, charCode: 0 },
    PageDown: { code: 'PageDown', keyCode: 34, charCode: 0 },
    ' ': { code: 'Space', keyCode: 32, charCode: 32 },
  };

  function pressKeys(keys) {
    const v = getMainVideo();
    if (v) {
      try {
        v.focus({ preventScroll: true });
      } catch (e) {}
    }
    const targets = [document.activeElement, v, document.body, document, window];
    for (const key of keys) {
      const spec = KEY_SPEC[key] || { code: key, keyCode: 0, charCode: 0 };
      for (const t of targets) {
        if (!t) continue;
        for (const type of ['keydown', 'keypress', 'keyup']) {
          const opts = {
            key,
            code: spec.code,
            keyCode: spec.keyCode,
            which: spec.keyCode,
            charCode: spec.charCode,
            bubbles: true,
            cancelable: true,
            composed: true,
          };
          t.dispatchEvent(new KeyboardEvent(type, opts));
        }
      }
    }
  }

  function clickEl(el) {
    const clickable = el.closest('button, a, [role="button"], [role="link"]') || el;
    clickable.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    clickable.click();
  }

  function applyNext(strategy) {
    if (strategy.type === 'click') {
      for (const sel of strategy.selectors) {
        const el = document.querySelector(sel);
        if (el) {
          clickEl(el);
          return true;
        }
      }
      return false;
    }
    if (strategy.type === 'key') {
      pressKeys(strategy.keys);
      return true;
    }
    if (strategy.type === 'scroll') {
      const scroller = getScroller(getMainVideo());
      const step = (scroller.clientHeight || window.innerHeight) * 0.92;
      scroller.scrollBy({ top: step, behavior: 'smooth' });
      return true;
    }
    return false;
  }

  // 当前策略链：默认按页面形态自适应；切换受阻后切换到备用链
  function currentChain() {
    if (chainOverride) return chainOverride === 'next' ? platform.next : platform.feed;
    return isFullscreenLayout() ? platform.next : platform.feed;
  }

  // 执行切换。核心思路（v1.1.4 重设计）：
  // 不再"等待检测到新视频来确认切换成功"——那套等待/重试机制在检测不到
  // 新视频时容易陷入死结。改为：执行切换动作后立即把当前视频当作新的计时
  // 起点（下个 tick 起正常计时）。切换真正生效时 onTickVideo 的候选确认会
  // 触发 onNewVideo 再次重置计时；切换无效时则继续计时，failStreak 累积后换链。
  // 这样无论切换成功与否，节奏都是稳定的 interval，且永远不会卡死。
  function advance() {
    const now = Date.now();
    if (now - lastAdvanceAt < 3000) return; // 防连点：给页面反应时间
    const chain = currentChain();
    for (const s of chain) {
      if (applyNext(s)) {
        lastAdvanceAt = now;
        // 立即重新采样：把当前视频当作计时起点（不触发 watched++，
        // 真正的切换由 onNewVideo 计数）
        const v = getMainVideo();
        if (v) {
          lastSig = { el: v, src: v.currentSrc || v.src, time: v.currentTime };
          cand = null;
          sinceChange = 0;
          pausedTicks = 0;
          nextTarget = effectiveInterval();
        }
        return;
      }
    }
    // 策略链全部失败（仅当链上全是 click 且选择器都没命中时）→ 换备用链
    chainOverride = chain === platform.next ? 'feed' : 'next';
  }

  function effectiveInterval() {
    if (!settings.jitter) return settings.interval;
    const j = settings.interval * 0.15; // 正负 15% 抖动，更像真人
    return settings.interval + (Math.random() * 2 - 1) * j;
  }

  // 检测是否换到了新视频（带候选确认），返回 true 表示本 tick 被占用。
  //
  // 判定信号只有两个强信号：视频元素变化 / src 变化。
  // 故意移除"播放时间回退"判定——短视频普遍循环播放，播完从头播时
  // currentTime 回退会被误判为新视频，导致计时被无限重置、永远不切换
  // （现象：已刷计数 +1，但视频一直在重复播放）。
  //
  // 候选确认：信号变化后需连续 2 个 tick 保持稳定才算真正的新视频，
  // 过滤滚动动画/虚拟列表造成的元素抖动（A→B→A 来回跳）。
  function onTickVideo(v) {
    const src = v.currentSrc || v.src;
    if (!lastSig) {
      onNewVideo(v);
      return true;
    }
    if (v !== lastSig.el || (src && lastSig.src && src !== lastSig.src)) {
      if (!cand || cand.el !== v || cand.src !== src) {
        cand = { el: v, src, ticks: 1 };
      } else if (++cand.ticks >= 2) {
        cand = null;
        onNewVideo(v);
      }
      return true; // 本 tick 不推进计时，等候选确认
    }
    cand = null;
    return false;
  }

  function onNewVideo(v) {
    const now = Date.now();
    if (now - lastNewVideoAt < 2000) {
      // 2 秒内再次判定为新视频：多为页面元素抖动（滚动动画/虚拟列表重建），
      // 只更新签名，不重置计时，避免 sinceChange 永远到不了切换时间
      lastSig = { el: v, src: v.currentSrc || v.src, time: v.currentTime };
      return;
    }
    lastNewVideoAt = now;
    lastSig = { el: v, src: v.currentSrc || v.src, time: v.currentTime };
    cand = null;
    sinceChange = 0;
    pausedTicks = 0;
    nextTarget = effectiveInterval();
    // 新视频出现说明推进恢复：清除失败计数、备用链与受阻提示
    failStreak = 0;
    chainOverride = null;
    setStatus('running');
    lastStatusBroadcast = '';
    watched++;
    if (settings.mute) v.muted = true;
    broadcast();
  }

  // ---------- 主循环 ----------
  function tick() {
    if (!running) return;

    // 标签页被隐藏时不动作（切换回来自动恢复）
    if (document.hidden) {
      setStatus('hidden');
      broadcastStatus('hidden');
      return;
    }

    const v = getMainVideo();
    const sc = getScroller(v);

    // 视口内没有视频（图片帖 / 懒加载 / 未登录）：持续尝试滚动而不是停止
    if (!v) {
      noVideoTicks++;
      // 每 6 秒滚一次尝试刷出视频；已在页面底部则等待，避免空转
      if (noVideoTicks > 4 && noVideoTicks % 6 === 0 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 150) {
        sc.scrollBy({ top: sc.clientHeight * 0.92, behavior: 'smooth' });
      }
      broadcastStatus(noVideoTicks > 4 ? 'no-video' : 'waiting');
      return;
    }
    noVideoTicks = 0;

    if (settings.mute && !v.muted) v.muted = true;

    if (onTickVideo(v)) return;

    lastSig.time = v.currentTime;
    sinceChange++;

    // 已到达页面底部：降频重试（每 30 秒一次），并提示用户
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 150;
    if (atBottom && Date.now() - lastAdvanceAt < 30000) {
      broadcastStatus('bottom');
      return;
    }

    // 受阻提示持续显示，直到换到新视频（onNewVideo 恢复）
    if (status !== 'stuck') {
      broadcastStatus('running');
    }
    if (settings.advanceOnEnd && v.ended && sinceChange >= 3) {
      advance();
      return;
    }
    if (sinceChange >= nextTarget) {
      advance();
      return;
    }
    // 视频暂停超时（手动暂停 / 自动播放被拦截 / 加载卡住）-> 强制切换
    if (!v.ended && v.paused) {
      if (++pausedTicks > 8) {
        advance();
        return;
      }
    } else {
      pausedTicks = 0;
    }
  }

  // ---------- 启动 / 停止 ----------
  function start() {
    if (running) return;
    running = true;
    watched = 0;
    startedAt = Date.now();
    lastSig = null;
    noVideoTicks = 0;
    failStreak = 0;
    chainOverride = null;
    lastAdvanceAt = 0;
    lastNewVideoAt = 0;
    cand = null;
    lastStatusBroadcast = '';
    setStatus('starting');
    broadcast();
    if (!timer) timer = setInterval(tick, TICK_MS);
    tick();
  }

  function stop(reason = '') {
    running = false;
    setStatus(reason ? 'stopped' : 'idle', reason);
    broadcast();
  }

  // ---------- 网页悬浮条 ----------
  const FLOAT_DEFAULTS = { floating: true, floatX: null, floatY: null, floatCollapsed: false };
  let floatOpts = { ...FLOAT_DEFAULTS };
  let floatRoot = null;
  let shadowEls = null;
  let dragMoved = false;

  const FLOAT_CSS = `
    .pill{width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#ff4d30,#ff9e00);
      color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;
      box-shadow:0 2px 12px rgba(0,0,0,.35);user-select:none;font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;}
    .pill.on{background:linear-gradient(135deg,#2e9e5b,#1f7a45);}
    .panel{width:232px;background:rgba(20,21,26,.95);color:#f2f3f7;border-radius:12px;
      box-shadow:0 4px 24px rgba(0,0,0,.45);font:13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden;}
    .head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
      border-bottom:1px solid rgba(255,255,255,.08);cursor:move;user-select:none;}
    .title{font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;}
    .dot{width:8px;height:8px;border-radius:50%;background:#666;flex-shrink:0;}
    .dot.on{background:#3ddc84;}
    .dot.err{background:#ff4d30;}
    .headbtns{display:flex;gap:2px;align-items:center;}
    .ibtn{background:none;border:none;color:#9aa0b0;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;}
    .body{padding:10px 12px;}
    .status{color:#ffc46b;font-size:12px;margin-bottom:4px;min-height:16px;}
    .stats{color:#9aa0b0;font-size:12px;margin-bottom:10px;}
    .btn{width:100%;padding:8px;border:none;border-radius:8px;
      background:linear-gradient(135deg,#ff4d30,#ff9e00);color:#fff;font-size:13px;font-weight:600;cursor:pointer;}
    .btn.on{background:linear-gradient(135deg,#2e9e5b,#1f7a45);}
    .interval{display:flex;align-items:center;justify-content:space-between;margin-top:8px;color:#9aa0b0;font-size:12px;}
    .interval button{width:26px;height:26px;border-radius:6px;border:1px solid #3a3e4d;background:#2a2d38;
      color:#fff;cursor:pointer;font-size:14px;line-height:1;}
    .hidden{display:none !important;}
  `;

  function statusText() {
    if (status === 'stopped' && stopReason) return stopReason;
    return (
      {
        idle: '未在运行',
        starting: '启动中…',
        running: '自动浏览中',
        waiting: '等待视频加载…',
        'no-video': '未检测到视频，持续滚动中',
        stuck: '切换受阻，自动重试中（可手动滚动页面恢复）',
        bottom: '已到达页面底部，等待新内容',
        hidden: '标签页已隐藏，已暂停',
        stopped: '已停止',
      }[status] || status
    );
  }

  function syncFloat() {
    if (!floatRoot || !shadowEls) return;
    shadowEls.pill.textContent = running ? '⏸' : '▶';
    shadowEls.pill.classList.toggle('on', running);
    shadowEls.dot.className = 'dot' + (running ? ' on' : status === 'no-video' || status === 'stopped' ? ' err' : '');
    shadowEls.statusEl.textContent = running || status !== 'idle' ? statusText() : '未在运行';
    shadowEls.statsEl.textContent = watched > 0 ? `已刷 ${watched} 个视频` : '本次已刷 0 个视频';
    shadowEls.btn.textContent = running ? '⏸ 停止' : '▶ 开始';
    shadowEls.btn.classList.toggle('on', running);
    shadowEls.intervalVal.textContent = settings.interval + ' 秒';
  }

  function setFloatVisible(visible) {
    if (!floatRoot) return;
    floatRoot.style.display = visible ? 'block' : 'none';
  }

  function applyFloatOpts() {
    if (!floatRoot) return;
    if (floatOpts.x != null && floatOpts.y != null) {
      floatRoot.style.left = floatOpts.x + 'px';
      floatRoot.style.top = floatOpts.y + 'px';
      floatRoot.style.right = 'auto';
    }
    setFloatVisible(floatOpts.floating);
    shadowEls.panel.classList.toggle('hidden', !!floatOpts.floatCollapsed);
    shadowEls.pill.classList.toggle('hidden', !floatOpts.floatCollapsed);
    syncFloat();
  }

  function saveFloatOpts(patch) {
    Object.assign(floatOpts, patch);
    chrome.storage.sync.set(patch);
    applyFloatOpts();
  }

  // 拖拽：位移超过 4px 视为拖动，否则视为点击
  function startDrag(e) {
    if (e.button !== 0) return;
    const rect = floatRoot.getBoundingClientRect();
    const start = { mx: e.clientX, my: e.clientY, lx: rect.left, ly: rect.top };
    dragMoved = false;
    const onMove = (ev) => {
      const dx = ev.clientX - start.mx;
      const dy = ev.clientY - start.my;
      if (!dragMoved && Math.hypot(dx, dy) < 4) return;
      dragMoved = true;
      floatRoot.style.left = Math.max(0, Math.min(window.innerWidth - 60, start.lx + dx)) + 'px';
      floatRoot.style.top = Math.max(0, Math.min(window.innerHeight - 40, start.ly + dy)) + 'px';
      floatRoot.style.right = 'auto';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragMoved) {
        chrome.storage.sync.set({ floatX: parseFloat(floatRoot.style.left), floatY: parseFloat(floatRoot.style.top) });
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function initFloatUI() {
    if (floatRoot || document.getElementById('autoview-float-host')) return;
    floatRoot = document.createElement('div');
    floatRoot.id = 'autoview-float-host';
    floatRoot.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
    const shadow = floatRoot.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${FLOAT_CSS}</style>
      <div class="pill hidden">▶</div>
      <div class="panel hidden">
        <div class="head">
          <div class="title"><span class="dot"></span>AutoVideo · ${platform.name}</div>
          <div class="headbtns">
            <button class="ibtn" title="折叠">—</button>
            <button class="ibtn" title="关闭悬浮条">✕</button>
          </div>
        </div>
        <div class="body">
          <div class="status">未在运行</div>
          <div class="stats">本次已刷 0 个视频</div>
          <button class="btn">▶ 开始</button>
          <div class="interval">
            <button class="minus">−</button>
            <span class="ival">15 秒</span>
            <button class="plus">＋</button>
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(floatRoot);

    shadowEls = {
      pill: shadow.querySelector('.pill'),
      panel: shadow.querySelector('.panel'),
      dot: shadow.querySelector('.dot'),
      statusEl: shadow.querySelector('.status'),
      statsEl: shadow.querySelector('.stats'),
      btn: shadow.querySelector('.btn'),
      intervalVal: shadow.querySelector('.ival'),
      head: shadow.querySelector('.head'),
      minus: shadow.querySelector('.minus'),
      plus: shadow.querySelector('.plus'),
    };
    const [collapseBtn, closeBtn] = shadow.querySelectorAll('.ibtn');

    // 拖拽（胶囊与面板头部）
    shadowEls.pill.addEventListener('mousedown', startDrag);
    shadowEls.head.addEventListener('mousedown', startDrag);

    // 胶囊点击 -> 展开面板
    shadowEls.pill.addEventListener('click', (e) => {
      if (dragMoved) return;
      saveFloatOpts({ floatCollapsed: false });
    });

    // 面板按钮
    shadowEls.btn.addEventListener('click', () => {
      if (running) stop();
      else start();
    });
    collapseBtn.addEventListener('click', () => saveFloatOpts({ floatCollapsed: true }));
    closeBtn.addEventListener('click', () => {
      chrome.storage.sync.set({ floating: false });
      setFloatVisible(false);
    });
    shadowEls.minus.addEventListener('click', () => {
      settings.interval = Math.max(3, settings.interval - 5);
      saveSettings();
    });
    shadowEls.plus.addEventListener('click', () => {
      settings.interval = Math.min(120, settings.interval + 5);
      saveSettings();
    });

    // 防抖：面板内按钮的 mousedown 不触发拖拽
    for (const el of shadow.querySelectorAll('.btn, .ibtn, .interval button')) {
      el.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    chrome.storage.sync.get(FLOAT_DEFAULTS, (saved) => {
      floatOpts = { ...FLOAT_DEFAULTS, ...saved };
      applyFloatOpts();
    });
  }

  function saveSettings() {
    chrome.storage.sync.set(settings);
    syncFloat();
  }

  // ---------- 消息与设置 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'AUTOVIEW_GET_STATE':
        sendResponse({ running, status, watched, platform: platform.name, startedAt, stopReason });
        break;
      case 'AUTOVIEW_SET_RUNNING':
        if (msg.value) start();
        else stop();
        sendResponse({ running, status });
        break;
      case 'AUTOVIEW_TOGGLE':
        if (running) stop();
        else start();
        sendResponse({ running, status });
        break;
      case 'AUTOVIEW_UPDATE_SETTINGS':
        Object.assign(settings, msg.settings);
        if (settings.mute) {
          const v = getMainVideo();
          if (v) v.muted = true;
        }
        if (!running) {
          nextTarget = effectiveInterval();
          sinceChange = 0;
        }
        syncFloat();
        sendResponse({ ok: true });
        break;
    }
    return false; // 同步响应
  });

  chrome.storage.sync.get(DEFAULTS, (saved) => {
    settings = { ...DEFAULTS, ...saved };
  });

  // 其他页面（如 popup）修改设置或悬浮条选项时实时响应
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.interval || changes.mute || changes.advanceOnEnd || changes.jitter) {
      chrome.storage.sync.get(DEFAULTS, (saved) => {
        settings = { ...DEFAULTS, ...saved };
        if (settings.mute) {
          const v = getMainVideo();
          if (v) v.muted = true;
        }
        syncFloat();
      });
    }
    if (changes.floating) {
      floatOpts.floating = !!changes.floating.newValue;
      setFloatVisible(floatOpts.floating);
    }
    if (changes.floatX) floatOpts.x = changes.floatX.newValue;
    if (changes.floatY) floatOpts.y = changes.floatY.newValue;
  });

  initFloatUI();
})();
