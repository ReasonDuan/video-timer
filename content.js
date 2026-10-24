// 注入到优酷、爱奇艺、腾讯视频的所有页面（含 iframe）：上报播放进度、判断换集、休息时暂停视频并显示遮罩。

(() => {
  const isTop = window === window.top;
  const MIN_MAIN_DURATION = 180; // 短于 3 分钟的视频视为广告，不参与“剩余时间/本集结束”判断
  const BLOCKED_EVENTS = ['keydown', 'keyup', 'keypress', 'wheel', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart'];
  const RESUME_EVENTS = ['keydown', 'mousedown', 'touchstart']; // 休息结束后，按任意键/鼠标键即继续播放

  let state = null;
  let pausedByUs = false;     // 本 frame 中是否有视频是被休息打断的
  let watchedHere = false;    // 休息开始时本 frame 是否正在播放（即“原页面”）
  let awaitingResume = false; // 休息已结束，等孩子点击“继续播放”
  let swallowUntil = 0;       // 继续播放后短暂吞掉同一次按键/点击的后续事件，避免点到播放器又把视频暂停
  let lastTickAt = 0;
  let lastKey = null;
  let host = null;
  let sections = null;        // 遮罩的三种内容：rest 休息倒计时 / ready 休息结束 / locked 今日已达上限
  let countdownEl = null;
  let dailyEl = null;
  let ticks = 0;
  let toastEl = null;
  let resumeBtn = null;

  const resting = () => state?.phase === 'resting';
  const lockedToday = () => state?.phase === 'locked';
  const locked = () => resting() || lockedToday() || awaitingResume;

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      // 扩展被重新加载后旧页面里的脚本会失效，忽略即可
    }
  }

  // ---------- 视频识别 ----------

  const videos = () => [...document.querySelectorAll('video')];
  const isPlaying = (v) => !v.paused && !v.ended && v.readyState > 2;

  function mainVideo() {
    return videos()
      .filter((v) => isFinite(v.duration) && v.duration >= MIN_MAIN_DURATION)
      .sort((a, b) => b.duration - a.duration)[0] || null;
  }

  // 用页面路径 + 时长标识“哪一集”，网站自动连播下一集时会变化
  // 时长按分钟取整，避免加载过程中时长的细微变化被误判为换集
  const episodeKey = (v) => `${location.pathname}|${Math.round(v.duration / 60)}`;

  // ---------- 休息：暂停 + 遮罩 ----------

  function enforceRest() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    for (const v of videos()) {
      if (!v.paused) {
        v.pause();
        pausedByUs = true;
      }
    }
  }

  function buildOverlay() {
    host = document.createElement('youku-timer-overlay');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        [hidden] { display: none !important; }
        .mask {
          position: fixed; inset: 0; z-index: 2147483647;
          display: flex; align-items: center; justify-content: center; text-align: center;
          background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(3px);
          color: #fff; font-family: "Microsoft YaHei", system-ui, sans-serif;
          text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
          user-select: none; cursor: default;
        }
        .title { font-size: 40px; font-weight: 700; margin-bottom: 12px; }
        .sub { font-size: 18px; opacity: 0.75; margin-bottom: 32px; }
        .time { font-size: 96px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 4px; }
        .hint { font-size: 16px; opacity: 0.8; margin-top: 28px; }
      </style>
      <div class="mask">
        <div class="rest">
          <div class="title">休息一下吧</div>
          <div class="sub">看看远处，活动活动身体</div>
          <div class="time">--:--</div>
          <div class="hint">动画片已暂停，休息结束后就能接着看</div>
        </div>
        <div class="ready" hidden>
          <div class="title">休息结束啦</div>
          <div class="sub">按键盘任意键或点一下鼠标，继续播放</div>
        </div>
        <div class="locked" hidden>
          <div class="title">今天就看到这里啦</div>
          <div class="sub">今天已经看了 <b class="daily"></b></div>
          <div class="hint">明天再接着看吧</div>
        </div>
      </div>`;
    sections = {
      rest: root.querySelector('.rest'),
      ready: root.querySelector('.ready'),
      locked: root.querySelector('.locked'),
    };
    countdownEl = root.querySelector('.time');
    dailyEl = root.querySelector('.daily');
  }

  function formatDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
  }

  function showOverlay(mode = 'rest') {
    if (!host) buildOverlay();
    for (const [name, el] of Object.entries(sections)) el.hidden = name !== mode;
    if (mode === 'locked') dailyEl.textContent = formatDuration(state.dailySec || 0);
    if (!host.isConnected) document.documentElement.appendChild(host);
    updateCountdown();
  }

  function hideOverlay() {
    host?.remove();
  }

  function updateCountdown() {
    if (!resting()) return;
    const left = Math.max(0, Math.ceil((state.restEndAt - Date.now()) / 1000));
    if (countdownEl) {
      const m = String(Math.floor(left / 60)).padStart(2, '0');
      const s = String(left % 60).padStart(2, '0');
      countdownEl.textContent = `${m}:${s}`;
    }
    if (left === 0) send({ type: 'checkRestEnd' });
  }

  // ---------- 休息结束 ----------

  // 原页面（休息前正在看的）保留遮罩并显示“继续播放”按钮；其他页面直接取消遮罩
  function onRestEnd() {
    const isOrigin = pausedByUs || watchedHere;
    pausedByUs = false;
    watchedHere = false;
    if (!isOrigin) {
      if (isTop) hideOverlay();
      return;
    }
    awaitingResume = true;
    if (isTop) showOverlay('ready');
    else showResumeButton(); // 视频在 iframe 里时，顶层遮罩已取消，按钮放在 iframe 内
  }

  function continuePlay() {
    awaitingResume = false;
    hideOverlay();
    resumeBtn?.remove();
    const v = mainVideo() || videos()[0];
    v?.play().catch(() => {});
  }

  function showResumeButton() {
    resumeBtn?.remove();
    resumeBtn = document.createElement('button');
    resumeBtn.textContent = '休息结束，点击继续播放';
    resumeBtn.style.cssText =
      'position:fixed;left:50%;top:40%;transform:translateX(-50%);z-index:2147483647;' +
      'padding:16px 32px;font-size:20px;border:none;border-radius:12px;cursor:pointer;' +
      'background:#2563eb;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.3);';
    resumeBtn.addEventListener('click', continuePlay);
    document.documentElement.appendChild(resumeBtn);
  }

  const waitingEpisodeEnd = () => state?.phase === 'watching' && (state.pendingStop || state.pendingLock);

  // ---------- 等待本集结束的提示 ----------

  function updateToast() {
    if (!waitingEpisodeEnd()) {
      toastEl?.remove();
      return;
    }
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:2147483646;padding:10px 16px;border-radius:8px;' +
        'background:rgba(234,88,12,.92);color:#fff;font:14px "Microsoft YaHei",sans-serif;pointer-events:none;';
    }
    toastEl.textContent = state.pendingLock
      ? '⏰ 今天的观看时间到了，看完这一集就结束'
      : '⏰ 时间到了，看完这一集就休息';
    if (!toastEl.isConnected) document.documentElement.appendChild(toastEl);
  }

  // ---------- 状态同步 ----------

  function applyState(next) {
    const prev = state;
    state = next;
    if (resting()) {
      if (prev && prev.phase !== 'resting') watchedHere = Date.now() - lastTickAt < 10000;
      awaitingResume = false;
      resumeBtn?.remove();
      enforceRest();
      if (isTop) showOverlay();
    } else if (lockedToday()) {
      awaitingResume = false;
      resumeBtn?.remove();
      enforceRest();
      pausedByUs = false;
      if (isTop) showOverlay('locked');
    } else if (prev?.phase === 'resting') {
      onRestEnd();
    } else if (prev?.phase === 'locked' && isTop) {
      hideOverlay(); // 跨天或家长重置后解除锁定
    }
    if (isTop) updateToast();
  }

  chrome.storage.local.get('state').then(({ state: s }) => applyState(s || { phase: 'watching' }));
  send({ type: 'refresh' }); // 让后台检查是否跨天、休息是否已结束

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.state) applyState(changes.state.newValue || { phase: 'watching' });
  });

  // ---------- 事件拦截 ----------

  // 休息中屏蔽键盘/鼠标（例如空格键播放）；休息结束后任意键/鼠标键触发继续播放
  for (const type of BLOCKED_EVENTS) {
    window.addEventListener(type, (e) => {
      const resume = awaitingResume && RESUME_EVENTS.includes(type);
      if (!resume && !locked() && Date.now() >= swallowUntil) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (resume) {
        swallowUntil = Date.now() + 800;
        continuePlay();
      }
    }, true);
  }

  // 媒体事件不冒泡，但能在 document 捕获阶段拿到
  document.addEventListener('play', (e) => {
    if (locked() && e.target instanceof HTMLMediaElement) {
      e.target.pause();
      if (resting()) pausedByUs = true;
    }
  }, true);

  document.addEventListener('ended', (e) => {
    const v = e.target;
    if (state?.phase === 'watching' && v instanceof HTMLVideoElement && v.duration >= MIN_MAIN_DURATION) {
      send({ type: 'episodeEnded', duration: v.duration });
    }
  }, true);

  document.addEventListener('fullscreenchange', () => {
    if (locked() && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  });

  // 遮罩被移除时补回去
  if (isTop) {
    new MutationObserver(() => {
      if (locked() && host && !host.isConnected) document.documentElement.appendChild(host);
    }).observe(document.documentElement, { childList: true });
  }

  // ---------- 每秒心跳 ----------

  setInterval(() => {
    if (!state || awaitingResume) return;
    if (resting()) {
      enforceRest();
      if (isTop) {
        showOverlay();
        updateCountdown();
      }
      return;
    }
    if (lockedToday()) {
      enforceRest();
      if (isTop) showOverlay('locked');
      if (++ticks % 60 === 0) send({ type: 'refresh' });
      return;
    }

    const main = mainVideo();
    if (main) {
      const key = episodeKey(main);
      // 新一集开始（自动连播/换集，或新打开的页面从头播放）：让后台用真实时长判断是否现在停
      const isNewEpisode = lastKey ? key !== lastKey : main.currentTime < 60;
      if (isNewEpisode) send({ type: 'episodeStart', remaining: main.duration - main.currentTime });
      lastKey = key;
    }

    if (!videos().some(isPlaying)) return;
    const remaining = main && isPlaying(main) ? main.duration - main.currentTime : null;
    lastTickAt = Date.now();
    send({ type: 'tick', remaining });
  }, 1000);
})();
