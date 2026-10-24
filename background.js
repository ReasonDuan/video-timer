// 后台状态机：
//   watching（观看中，可能处于 pendingStop 等本集结束后休息 / pendingLock 等本集结束后锁定）
//   → resting（休息中）→ watching
//   → locked（今日观看已达上限，次日零点解除）
// 状态存在 storage.local，所有视频网站页面通过 storage.onChanged 同步。
//
// 何时停：尽量在一集的结尾或开头停，不在半集打断。
//   - 一集播完时：按“下一集和这集一样长”估算，比较“现在停（少看）”和“看完下一集再停（多看）”，取偏差小的；
//   - 下一集开始时：用它的真实时长再判断一次，这集会超时太多也现在停；
//   - 播放中途时间到：剩余不超过允许超时就等这集播完，否则立即停（电影等长视频的兜底）。

const DEFAULTS = { watchMin: 20, restMin: 5, graceMin: 10, dailyMaxMin: 60, dailyGraceMin: 20 };
const INITIAL = {
  phase: 'watching', watchedSec: 0, pendingStop: false, pendingLock: false,
  restEndAt: 0, lastCountAt: 0, dailySec: 0, day: '',
};

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function nextMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return { ...INITIAL, ...state };
}

function setState(state) {
  return chrome.storage.local.set({ state });
}

// 跨天后清零今日累计并解除锁定；返回是否有变化
function rollDay(state) {
  const d = today();
  if (state.day === d) return false;
  state.day = d;
  state.dailySec = 0;
  if (state.phase === 'locked') Object.assign(state, { phase: 'watching', watchedSec: 0 });
  return true;
}

// 在集边界（结尾或开头）判断是否现在停。
// watched: 已看秒数；len: 接下来这一集要看的秒数；target: 目标秒数；grace: 允许超时秒数
function shouldStopAtBoundary(watched, len, target, grace) {
  if (watched >= target) return true;
  if (watched < target / 2) return false; // 还没看到一半，不提前停（长视频由中途时间到兜底）
  const under = target - watched;      // 现在停，比目标少看多少
  const over = watched + len - target; // 看完这一集再停，比目标多看多少
  if (over <= 0) return false;
  // 取偏差更小的一边；这集会超时太多也现在停
  return under <= over || over > grace;
}

// 休息时长按实际观看时长等比例调整，最少 1 分钟，最多标准休息的 2 倍
function restSeconds(state, settings) {
  const base = settings.restMin * 60;
  const scaled = Math.round(base * state.watchedSec / (settings.watchMin * 60));
  return Math.min(base * 2, Math.max(60, scaled));
}

// 多个标签页同时发消息时串行处理，避免读改写互相覆盖
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(() => fn());
  queue = p.catch(() => {});
  return p;
}

async function startRest(state, settings) {
  const restEndAt = Date.now() + restSeconds(state, settings) * 1000;
  await setState({ ...state, phase: 'resting', restEndAt, watchedSec: 0, pendingStop: false, pendingLock: false });
  await chrome.alarms.create('restEnd', { when: restEndAt });
}

async function lock(state) {
  await setState({ ...state, phase: 'locked', watchedSec: 0, pendingStop: false, pendingLock: false });
  await chrome.alarms.create('dayReset', { when: nextMidnight() + 1000 });
}

// 等待结束（本集播完或换了视频）后，按等待的类型锁定或休息
const finishWaiting = (state, settings) => (state.pendingLock ? lock(state) : startRest(state, settings));

async function refresh() {
  const state = await getState();
  let changed = rollDay(state);
  if (state.phase === 'resting' && Date.now() >= state.restEndAt - 500) {
    Object.assign(state, { phase: 'watching', restEndAt: 0 });
    changed = true;
  }
  if (changed) await setState(state);
}

async function onTick(msg) {
  const state = await getState();
  rollDay(state);
  if (state.phase !== 'watching') return;

  // 多个标签页同时在播时，每秒最多累计 1 秒
  const now = Date.now();
  if (now - state.lastCountAt < 900) return;
  state.watchedSec += 1;
  state.dailySec += 1;
  state.lastCountAt = now;

  const s = await getSettings();
  const { remaining } = msg; // 正片剩余秒数；当前只有广告在播时为 null
  if (remaining == null) return setState(state);

  if (state.dailySec >= s.dailyMaxMin * 60 && !state.pendingLock) {
    if (remaining <= s.dailyGraceMin * 60) state.pendingLock = true;
    else return lock(state);
  } else if (state.watchedSec >= s.watchMin * 60 && !state.pendingStop && !state.pendingLock) {
    if (remaining <= s.graceMin * 60) state.pendingStop = true;
    else return startRest(state, s);
  } else if (state.pendingStop || state.pendingLock) {
    // 等待期间把进度往回拖等导致剩余变长，不再等待
    const limit = (state.pendingLock ? s.dailyGraceMin : s.graceMin) * 60;
    if (remaining > limit + 30) return finishWaiting(state, s);
  }
  await setState(state);
}

// 集边界：episodeEnded 带本集时长（估算下一集），episodeStart 带新一集的剩余时长
async function onBoundary(msg) {
  const state = await getState();
  rollDay(state);
  if (state.phase !== 'watching') return;
  const s = await getSettings();
  if (state.pendingStop || state.pendingLock) return finishWaiting(state, s);

  const len = msg.type === 'episodeEnded' ? msg.duration : msg.remaining;
  if (!(len > 0)) return;
  if (shouldStopAtBoundary(state.dailySec, len, s.dailyMaxMin * 60, s.dailyGraceMin * 60)) return lock(state);
  if (shouldStopAtBoundary(state.watchedSec, len, s.watchMin * 60, s.graceMin * 60)) return startRest(state, s);
}

// 家长重置：清空本次和今日累计，解除休息/锁定
async function reset() {
  await chrome.alarms.clear('restEnd');
  await chrome.alarms.clear('dayReset');
  await setState({ ...INITIAL, day: today() });
}

const handlers = {
  tick: onTick,
  episodeEnded: onBoundary,
  episodeStart: onBoundary,
  checkRestEnd: refresh,
  refresh,
  reset,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  serial(() => handler(msg)).then(() => sendResponse(true), () => sendResponse(false));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'restEnd' || alarm.name === 'dayReset') serial(refresh);
});

chrome.runtime.onStartup.addListener(() => serial(refresh));
