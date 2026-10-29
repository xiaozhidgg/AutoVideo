# AutoVideo 开发者文档

面向后续维护者的开发说明：架构、消息协议、扩展指南、版本管理约定。

## 1. 项目概览

- 技术栈：**Manifest V3** + 原生 JavaScript（无框架、无构建步骤），兼容 Edge / Chrome 及所有 Chromium 内核浏览器
- 定位：在抖音、快手、TikTok、Instagram、Facebook 上自动浏览短视频——每个视频停留指定时长后切换到下一个
- 三个运行时组件：

```
┌──────────┐   chrome.tabs.sendMessage    ┌──────────────┐
│  popup   │ ───────────────────────────▶ │  content.js  │  页面上下文
│ (弹窗UI) │ ◀─────────────────────────── │  (核心引擎+  │  注入到 5 个平台
└────┬─────┘   runtime.sendMessage(广播)  │   悬浮条)    │
     │                                     └──────┬───────┘
     │ chrome.commands / chrome.action            │ AUTOVIEW_BADGE
     ▼                                            ▼
┌──────────────┐                          ┌──────────────┐
│ background   │ ◀── 快捷键 Alt+Shift+A ──│  浏览器/页面  │
│ (快捷键+角标) │ ──▶ AUTOVIEW_TOGGLE      └──────────────┘
└──────────────┘
```

## 2. 文件结构

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | MV3 清单：域名匹配、权限、快捷键；**版本号的唯一来源**（见 §5） |
| `content.js` | 核心引擎：平台识别、视频检测、切换策略、网页悬浮条 |
| `background.js` | 后台 service worker：全局快捷键、工具栏角标 |
| `popup.html` / `popup.css` / `popup.js` | 弹窗控制面板 |
| `icons/` | 插件图标 16/32/48/128（由 `tools/make-icons.ps1` 生成） |
| `tools/make-icons.ps1` | 图标生成脚本（Windows PowerShell，System.Drawing） |
| `README.md` | 用户文档：安装、使用、常见问题 |
| `DEVELOPER.md` | 本文档 |

## 3. 核心架构

### 3.1 平台配置（content.js 顶部）

`PLATFORMS` 数组是唯一需要按平台维护的配置点。每个平台包含：

```js
{
  name: '抖音',                       // 展示名
  domains: ['douyin.com'],           // 域名匹配（HOST === d 或 HOST.endsWith('.' + d)）
  next:  [ /* 全屏播放页策略链 */ ],
  feed:  [ /* 信息流页面策略链 */ ],
}
```

策略链由 `nextChain(clickSelectors, keys)` / `feedChain(clickSelectors, keys)` 生成：

- `next`（全屏播放页）：`click → key → scroll`，点击优先（按钮最精准）
- `feed`（信息流/瀑布流，如抖音精选）：`scroll → key → click`，滚动优先（这类页面没有"下一个"按钮）

每个策略项为 `{ type, ... }`，类型在 `applyNext()` 中分发：

| type | 行为 |
| --- | --- |
| `click` | 依次尝试 `selectors`，命中后点击（自动上溯到最近的 button/a/[role=button]），并附带 pointerdown/mousedown |
| `key` | 模拟按键（见 3.3），`keys` 数组依次尝试 |
| `scroll` | 找到滚动范围最大的容器，按 `clientHeight × 0.92` 平滑滚动 |

**新增策略类型**：在 `applyNext()` 中加一个 `type` 分支即可。

### 3.2 引擎状态机（主循环）

`tick()` 每秒执行一次（`setInterval(TICK_MS)`，仅启动时创建）：

```
tick
 ├─ 未运行 → return
 ├─ document.hidden → status='hidden'（标签页隐藏暂停，切回自动恢复）
 ├─ 无 video 元素 → status='waiting'/'no-video'，每 6 秒滚动一次尝试刷出视频
 │    （底部保护：已在页面底部则不滚动），**不自动停止**
 ├─ 静音设置 → 强制 muted
 ├─ isNewVideo()？→ onNewVideo()：换新视频，重置计时，watched++
 ├─ 已到达页面底部？→ 降频（每 30 秒才允许一次 advance），status='bottom'
 └─ 正常判断
      ├─ 视频已播完(v.ended) 且 advanceOnEnd → advance()
      ├─ sinceChange ≥ nextTarget（含 ±15% 随机抖动）→ advance()
      └─ 视频暂停（手动暂停/自动播放被拦截/加载卡住）超过 8 秒 → advance()
```

**切换机制（v1.1.4 重设计，核心简化）**：

`advance()` 不再"等待检测到新视频来确认成功"（旧机制的等待/重试在检测不到新视频时会陷入死结）。新机制：

```
advance()
 ├─ 距上次切换 < 3 秒 → return（防连点，给页面反应时间）
 ├─ 依次尝试当前策略链（currentChain：默认按页面形态自适应，受阻后换备用链）
 ├─ 执行成功后：
 │    ├─ failStreak++（连续切换未换到新视频的次数，onNewVideo 清零）
 │    ├─ failStreak ≥ 2 → 切换备用策略链（next ↔ feed 互换）
 │    ├─ failStreak ≥ 3 → status='stuck'（持续提示，直到换到新视频）
 │    └─ 立即重新采样：把当前视频当作新的计时起点
 │         （不触发 watched++；真正的切换由 onNewVideo 计数）
 └─ 全部策略失败（仅当链上全是 click 且选择器未命中）→ 换备用链
```

**为什么不会卡死**：无论切换成功与否，`advance()` 都会重置计时，节奏恒为 interval；
切换成功时页面变化触发 `onNewVideo` 再次校准计时；切换失败时 failStreak 累积自动换链。
不存在"等待确认"的中间状态，也就没有可卡住的挂起状态。

关键字段（content.js 顶层闭包变量）：

| 字段 | 含义 |
| --- | --- |
| `lastSig` / `sinceChange` | 当前视频签名（元素+src+time）与已停留秒数 |
| `nextTarget` | 本次停留目标（`effectiveInterval()` 采样一次，避免每 tick 重随机） |
| `lastAdvanceAt` | 上次执行切换的时间戳（防连点 3 秒 + 页面底部降频 30 秒） |
| `failStreak` / `chainOverride` | 连续切换未生效的次数（≥2 换备用链，≥3 提示受阻）；备用链 `null/'next'/'feed'` |
| `lastNewVideoAt` | 元素抖动保护：2 秒内重复"新视频"判定只更新签名、不重置计时 |
| `noVideoTicks` / `pausedTicks` | 无视频 / 视频暂停 的容错计数 |
| `lastStatusBroadcast` | 状态去重：只在状态变化时广播，避免每秒向 popup 发消息 |

**受阻恢复**：`onNewVideo()` 触发时清除 failStreak/备用链并恢复 running 状态。

**视频变更判定（v1.1.5 起，带候选确认）**：`onTickVideo()` 只认两个强信号——视频元素引用变化、`currentSrc` 变化；信号变化后需**连续 2 个 tick 稳定**（候选确认，过滤滚动动画/虚拟列表的元素抖动）才真正触发 `onNewVideo`。
**有意移除了"播放时间回退"判定**：短视频普遍循环播放，播完从头播的 `currentTime` 回退曾被误判为新视频，导致计时被无限重置、永不切换（现象：已刷计数 +1 但视频重复播放）。循环回退现在被视为"同一视频"，计时正常推进。

**布局自适应** `isFullscreenLayout()`：主视频面积 ≥ 视口面积 × 45% 判定为全屏播放页，决定走 `next` 还是 `feed` 策略链；无视频时返回 false（信息流滚动优先）。

### 3.3 键盘模拟（pressKeys）

目标：让页面像收到真实 ↓ 键一样响应。实现：

1. 先 `video.focus({preventScroll:true})`，让焦点进入视频
2. 对每个按键，构造带完整字段的 `KeyboardEvent`（`key/code/keyCode/which/charCode/bubbles/cancelable/composed`）
3. 依次派发 `keydown → keypress → keyup`
4. 派发目标：`document.activeElement → video → body → document → window` 五层，覆盖不同站点的监听位置

已知限制：合成事件的 `isTrusted` 为 false，个别对 `isTrusted` 严格校验的站点可能忽略——所以键盘策略后面总有 `scroll` 兜底。

### 3.4 网页悬浮条

- 通过 content script 注入 `<div id="autoview-float-host">`（`position:fixed; z-index:2147483647`），内部样式全部放在 **shadow DOM** 中（`FLOAT_CSS`），与站点样式完全隔离
- 状态：展开面板 ⇄ 折叠胶囊（pill），由 `floatCollapsed` 控制
- 拖拽：mousedown/mousemove/mouseup，位移 < 4px 视为点击而非拖动；拖动结束把位置写入 `floatX/floatY`
- 关闭：`floating: false`（写入 sync storage），popup 勾选可重新开启
- 刷新：所有状态变化统一走 `broadcast()` → `syncFloat()`

## 4. 消息协议

统一前缀 `AUTOVIEW_`，所有消息为 `{ type, ...载荷 }`：

| 消息 | 方向 | 载荷 | 作用 |
| --- | --- | --- | --- |
| `AUTOVIEW_GET_STATE` | popup → content | — | 查询状态（同步 sendResponse） |
| `AUTOVIEW_SET_RUNNING` | popup → content | `value: bool` | 开始/停止 |
| `AUTOVIEW_TOGGLE` | background → content | — | 快捷键开关 |
| `AUTOVIEW_UPDATE_SETTINGS` | popup → content | `settings: object` | 即时应用设置 |
| `AUTOVIEW_STATE` | content → popup | `state: object` | 状态广播（popup 打开时实时刷新） |
| `AUTOVIEW_BADGE` | content → background | `running: bool` | 更新工具栏角标 |

`chrome.storage.onChanged` 是另一条同步通道：popup 改 storage 后，所有已注入的内容脚本自动响应（设置、悬浮条开关/位置/折叠）。

## 5. 存储键（chrome.storage.sync）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `interval` | number | 15 | 每个视频停留秒数（3–120） |
| `mute` | bool | false | 静音播放 |
| `advanceOnEnd` | bool | true | 视频播完立即切换 |
| `jitter` | bool | true | 停留时长 ±15% 随机抖动 |
| `floating` | bool | true | 网页悬浮条是否显示 |
| `floatX` / `floatY` | number/null | null | 悬浮条拖拽位置（null=默认右上角） |
| `floatCollapsed` | bool | false | 悬浮条是否折叠成胶囊 |

## 6. 如何扩展

### 6.1 新增平台

1. `manifest.json`：在 `content_scripts.matches` 和 `host_permissions` 中添加 `https://*.域名/*`
2. `content.js`：在 `PLATFORMS` 中追加条目（name / domains / next / feed），优先用平台自带"下一个"按钮的稳定选择器
3. 加载扩展并实测：全屏播放页和信息流页各验证一次，必要时在文档 §6.2 调整策略

### 6.2 平台改版导致失效

按钮选择器变了 → 只改对应平台的 `selectors`（这是最常见的维护操作）。键盘/滚动兜底一般不受影响；若页面结构变化导致滚动容器判断错误，检查 `getScroller()`。

### 6.3 新增设置项

1. `content.js`：`DEFAULTS` 加默认值，`tick()`/相关逻辑使用
2. `popup.html` / `popup.js`：加控件并写入 storage（`readSettings()` / `applySettings()` / storage.get 默认值三处同步改）
3. `content.js` 的 `AUTOVIEW_UPDATE_SETTINGS` 分支和 `storage.onChanged` 分支（如需即时生效）
4. 本文档 §5 存储键表补充

## 7. 版本管理约定（必须遵守）

- **版本号唯一来源**：`manifest.json` 的 `"version"` 字段，格式 `major.minor.patch`
- **每次代码变更（功能、修复、选择器更新）都必须同步升级版本号**，并在 §8 版本历史中记录；只改文档无需升版
- 规则：
  - `minor`（如 1.0 → 1.1）：新功能（新增平台、新设置、悬浮条等）
  - `patch`（如 1.1.0 → 1.1.1）：Bug 修复、选择器更新、微调
  - `major`：破坏性变更（架构重写、权限模型变化）
- 升级版本号时同时更新 `README.md`（如功能列表变化）与本文档 §8
- 本地加载场景下 Edge 每次"重新加载"都会应用新代码，版本号的意义在于：用户已安装副本的更新提示、故障排查时定位代码版本

## 8. 版本历史

| 版本 | 变更 |
| --- | --- |
| 1.1.5 | **修复循环播放误判（重要）**：移除"播放时间回退 = 新视频"判定——短视频循环播放（播完从头播）会被误判为新视频，导致计时被无限重置、永不切换（现象：已刷 +1 但视频重复播放，各平台皆是）；新视频判定改为双强信号（元素/src 变化）+ 候选确认（连续 2 tick 稳定），过滤元素抖动 |
| 1.1.4 | **切换策略重设计**：去掉"等待检测新视频确认成功"的 pendingAdvance 状态机（检测不到时会卡死）——切换后立即重新采样计时，节奏恒为 interval；连续 2 次切换未生效自动换备用链，≥3 次提示"切换受阻"；页面底部降频为 30 秒重试 |
| 1.1.3 | 修复"刷一阵后停止切换"：切换策略有效性检测（滚动位置判断）+ 失败自动切换备用策略链 + "推进受阻"状态（30 秒降频重试、用户滚动自动恢复、悬浮条可见提示）；2 秒元素抖动保护（防止虚拟列表/滚动动画导致计时永不到期） |
| 1.1.2 | 弹窗底部显示版本号（从 manifest 动态读取）与作者署名「小志」 |
| 1.1.1 | 修复"有时候不自动切换"：无视频不再自动停止（改为持续尝试滚动，含底部保护）；视频暂停超时 8 秒强制切换；新视频判定增加元素引用检查；切换等待/重试节奏调整（5 秒 × 4 次）；状态广播去重 |
| 1.1.0 | 新增网页悬浮条（状态置顶、可拖拽/折叠/关闭）；新增信息流页面自适应策略（滚动优先，适配抖音精选等瀑布流）；键盘模拟增强（聚焦视频 + 五层派发 + keypress） |
| 1.0.0 | 初始版本：5 平台支持、全屏页点击/按键/滚动策略、弹窗控制面板 |

## 9. 开发与调试

1. `edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」选择项目根目录；改代码后在扩展卡片点「重新加载」
2. **内容脚本调试**：在目标页面按 F12，Console 上下文选择页面本身（非扩展）；`content.js` 的日志/异常会显示在这里
3. **后台调试**：扩展卡片点「service worker」链接，Console 显示 `background.js` 日志
4. **消息调试**：在页面 Console 执行 `chrome.runtime.sendMessage({type:'AUTOVIEW_GET_STATE'}, r => console.log(r))` 验证引擎响应
5. **语法校验**（无构建步骤，改完必跑）：
   ```bash
   node --check content.js && node --check background.js && node --check popup.js
   node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('OK')"
   ```
6. **重新生成图标**：`powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-icons.ps1`

## 10. 发布打包

- 手动打包：将 `manifest.json`、`content.js`、`background.js`、`popup.*`、`icons/` 打成 zip（**manifest.json 必须在 zip 根目录**）
- Edge 商店上架需额外准备：图标、说明文案、隐私政策（本插件仅用 `storage` 权限，无网络请求、不收集数据）
