// AutoVideo 弹窗控制逻辑
const $ = (s) => document.querySelector(s);

let currentTab = null;
let state = null;

const STATUS_TEXT = {
  idle: '未在运行',
  starting: '启动中…',
  running: '自动浏览中',
  waiting: '等待视频加载…',
  'no-video': '未检测到视频，持续滚动中',
  stuck: '切换受阻，自动重试中',
  bottom: '已到达页面底部，等待新内容',
  hidden: '标签页已隐藏，已暂停',
  stopped: '已停止',
};

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function sendToTab(msg) {
  if (!currentTab || currentTab.id == null) return Promise.reject(new Error('no active tab'));
  return chrome.tabs.sendMessage(currentTab.id, msg);
}

async function refresh() {
  currentTab = await getActiveTab();
  let resp = null;
  try {
    resp = await sendToTab({ type: 'AUTOVIEW_GET_STATE' });
  } catch (e) {
    // 该页面没有 AutoVideo 内容脚本
  }
  state = resp;
  const supported = !!resp;
  document.getElementById('unsupported').classList.toggle('hidden', supported);
  document.getElementById('toggle').disabled = !supported;
  document.getElementById('platform').textContent = supported ? resp.platform : '当前页面不支持';
  render();
}

function render() {
  const btn = document.getElementById('toggle');
  const running = !!(state && state.running);
  btn.classList.toggle('on', running);
  btn.textContent = running ? '⏸ 停止自动刷' : '▶ 开始自动刷';

  let statusText = '—';
  if (state) {
    statusText = state.status === 'stopped' && state.stopReason ? state.stopReason : STATUS_TEXT[state.status] || state.status;
  }
  document.getElementById('status').textContent = statusText;

  if (state && state.watched > 0) {
    const mins = state.startedAt ? Math.max(1, Math.round((Date.now() - state.startedAt) / 60000)) : 0;
    document.getElementById('stats').textContent = `本次已刷 ${state.watched} 个视频 · 约 ${mins} 分钟`;
  } else {
    document.getElementById('stats').textContent = '本次已刷 0 个视频';
  }
}

document.getElementById('toggle').addEventListener('click', async () => {
  try {
    await sendToTab({ type: 'AUTOVIEW_SET_RUNNING', value: !(state && state.running) });
  } catch (e) {}
  refresh();
});

// ---- 设置项 ----
const intervalEl = document.getElementById('interval');
const intervalVal = document.getElementById('intervalVal');

function readSettings() {
  return {
    interval: Number(intervalEl.value),
    mute: document.getElementById('mute').checked,
    advanceOnEnd: document.getElementById('advanceOnEnd').checked,
    jitter: document.getElementById('jitter').checked,
  };
}

function applySettings() {
  const settings = readSettings();
  chrome.storage.sync.set(settings);
  sendToTab({ type: 'AUTOVIEW_UPDATE_SETTINGS', settings }).catch(() => {});
}

intervalEl.addEventListener('input', () => {
  intervalVal.textContent = intervalEl.value;
});
intervalEl.addEventListener('change', applySettings);
['mute', 'advanceOnEnd', 'jitter'].forEach((id) => {
  document.getElementById(id).addEventListener('change', applySettings);
});

// 悬浮条开关：内容脚本通过 storage.onChanged 实时响应
document.getElementById('floating').addEventListener('change', (e) => {
  chrome.storage.sync.set({ floating: e.target.checked });
});

// 读取已保存的设置
chrome.storage.sync.get({ interval: 15, mute: false, advanceOnEnd: true, jitter: true, floating: true }, (saved) => {
  intervalEl.value = saved.interval;
  intervalVal.textContent = saved.interval;
  document.getElementById('mute').checked = saved.mute;
  document.getElementById('advanceOnEnd').checked = saved.advanceOnEnd;
  document.getElementById('jitter').checked = saved.jitter;
  document.getElementById('floating').checked = saved.floating;
});

// 内容脚本广播状态变化时实时刷新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'AUTOVIEW_STATE') {
    state = msg.state;
    render();
  }
});

// 版本与作者信息（版本号从 manifest 读取，保持 manifest 为唯一版本来源）
const manifest = chrome.runtime.getManifest();
document.getElementById('version').textContent = `v${manifest.version} · 作者：小志`;

refresh();
