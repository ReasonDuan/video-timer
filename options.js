const DEFAULTS = { watchMin: 20, restMin: 5, graceMin: 10, dailyMaxMin: 60, dailyGraceMin: 20, autoFullscreen: true };
const MIN_VALUE = { graceMin: 0, dailyGraceMin: 0 };
const MAX_VALUE = { dailyMaxMin: 1440 };
const NUMBER_FIELDS = ['watchMin', 'restMin', 'graceMin', 'dailyMaxMin', 'dailyGraceMin'];

const $ = (id) => document.getElementById(id);
const fmt = (sec) => `${Math.floor(sec / 60)} 分 ${String(Math.floor(sec % 60)).padStart(2, '0')} 秒`;

function flash(text) {
  $('msg').textContent = text;
  setTimeout(() => ($('msg').textContent = ''), 2000);
}

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  for (const k of NUMBER_FIELDS) $(k).value = settings[k];
  $('autoFullscreen').checked = settings.autoFullscreen;
}

$('save').addEventListener('click', async () => {
  const next = { autoFullscreen: $('autoFullscreen').checked };
  for (const k of NUMBER_FIELDS) {
    const min = MIN_VALUE[k] ?? 1;
    const max = MAX_VALUE[k] ?? 600;
    const n = Math.round(Number($(k).value));
    if (!Number.isFinite(n) || n < min || n > max) {
      flash(`请输入 ${min}~${max} 之间的整数`);
      return;
    }
    next[k] = n;
  }
  await chrome.storage.sync.set(next);
  flash('已保存');
});

$('reset').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reset' });
  flash('已重置本次和今日计时，并解除休息/锁定');
});

async function refreshStatus() {
  const { watchMin, dailyMaxMin } = await chrome.storage.sync.get(DEFAULTS);
  const { state } = await chrome.storage.local.get('state');
  const s = { phase: 'watching', watchedSec: 0, dailySec: 0, ...state };
  let html;
  if (s.phase === 'locked') {
    html = '状态：<b>今日已达上限</b>';
  } else if (s.phase === 'resting') {
    const left = Math.max(0, (s.restEndAt - Date.now()) / 1000);
    html = `状态：<b>休息中</b><br>剩余：${fmt(left)}`;
  } else if (s.pendingLock) {
    html = '状态：<b>等待本集结束后结束今天的观看</b>';
  } else if (s.pendingStop) {
    html = `状态：<b>等待本集结束后休息</b><br>本次已观看：${fmt(s.watchedSec)}`;
  } else {
    html = `状态：<b>观看中</b><br>本次已观看：${fmt(s.watchedSec)} / ${watchMin} 分钟`;
  }
  html += `<br>今日累计：${fmt(s.dailySec)} / ${dailyMaxMin} 分钟`;
  $('status').innerHTML = html;
}

load();
refreshStatus();
setInterval(refreshStatus, 1000);
