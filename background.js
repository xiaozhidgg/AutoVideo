// AutoVideo 后台服务：全局快捷键开关 + 工具栏角标状态
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-autoscroll') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'AUTOVIEW_TOGGLE' });
    if (resp) setBadge(tab.id, !!resp.running);
  } catch (e) {
    // 当前页面没有 AutoVideo 内容脚本（不支持的站点），忽略
  }
});

// 内容脚本上报运行状态，用于更新工具栏角标
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'AUTOVIEW_BADGE' && sender.tab && sender.tab.id != null) {
    setBadge(sender.tab.id, !!msg.running);
  }
});

function setBadge(tabId, running) {
  if (running) {
    chrome.action.setBadgeBackgroundColor({ color: '#ff4d30', tabId });
    chrome.action.setBadgeText({ text: '▶', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}
