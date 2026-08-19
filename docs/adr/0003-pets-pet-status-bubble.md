# Pets 宠物状态气泡：运行时资产下载、文案本地化与平台显隐策略

OpenChamber 将复刻 codex CLI 的 `/pets` 宠物状态角标：会话运行期间在聊天区角落显示宠物，以动画与文案反映会话状态（运行中/等待输入/已完成/受阻）。围绕三个方向性问题做出以下决策。

## 资产：运行时按需下载 + 本地缓存，不打包进仓库

- 资产来自 `https://persistent.oaistatic.com/codex/pets/v1/*.webp`（8 只 × 约 1-4MB，需实施前置实测确认清单）。
- 选择运行时下载：仓库不膨胀（约 32MB），资产更新无需发版，与 codex 行为一致。
- 缓存：Electron 落磁盘（userData），Web 与移动端落 IndexedDB；缓存键含版本戳。
- 失败语义（AGENTS.md 不变量："fetch 失败不得伪装成权威成功"）：加载中显示静态占位帧；单只失败隐藏并一次性提示；全部失败显示离线气泡；下次会话重试。绝不把失败渲染成成功状态。
- 不选打包进仓库：体积大、更新要发版、增加第三方资产的分发面。

## 文案：本地化而非逐字复刻英文

- codex 显示 `Running / Needs input / Ready / Blocked`；OpenChamber 用户可见文案必须走项目 i18n（`locale-ui-patterns` 硬规范）。
- 四态语义对齐：运行中 / 等待输入 / 已完成 / 受阻。key 全量补齐 11 种语言，缺 key 由 `Record<I18nKey, string>` 类型强制 + `messages.test.ts` key parity 拦截。

## 平台显隐：桌面/Web 默认显示，移动端默认隐藏可配置

- `showPet` 布尔设置走正式设置系统（跨端同步，服务端白名单持久化）。
- 默认值按平台区分（仿 `mobileKeyboardMode` 先例）：桌面（含 VS Code webview）为 true，Capacitor 与 hosted mobile web（`isMobileSurfaceRuntime()`）为 false，设置页可开启。
- 选哪只宠物属本地偏好（localStorage），不跨端同步——显隐是全局契约，审美偏好是本地事实。

**Consequences**: 资产依赖第三方 CDN 可用性，离线时降级为离线气泡（功能可用性不依赖资产成功加载）；移动端用户默认不可见，需主动开启；设置项增加服务端白名单维护面（`sanitizeSettingsUpdate` 未加条目则保存被静默丢弃，以单测兜底）。

## 桌面呈现：独立置顶透明悬浮窗（ADR-011）

原设计将宠物渲染为聊天区内的 DOM 元素（ADR-010）。桌面端（Electron）改为**独立 always-on-top 透明悬浮窗**承载宠物，浮于系统所有程序之上：

- Electron 主进程创建 `pet-overlay.html` 窗口（`transparent`、`frame:false`、`alwaysOnTop('screen-saver')`、`skipTaskbar`、`focusable:false`、`resizable:false`），与主窗口同 origin（`openchamber-ui://app`），共享 IndexedDB 资产缓存。
- 权威状态在主窗口：`PetOverlayBridge` 订阅 `showPet`/`petSize`/宠物偏好/`usePetState`/回复预览，经 `pet_overlay_show|hide|update` IPC 推送；主进程持有最新载荷并在窗口（重新）创建时重放，overlay 永不过期渲染。
- 位置持久化在 `~/.config/openchamber/settings.json` 的 `desktopPetOverlayPosition`，启动恢复并 clamp 到可见工作区。
- 非桌面运行时（Web/VS Code/移动）保持应用内渲染（`PetBubble`），共享同一套交互与动画。
- IPC 命令（`pet_overlay_*`）不进 `COMMANDS_SAFE_FOR_REMOTE`，仅本地页面可用。

**Consequences**: Linux 透明窗依赖合成器（个别环境可能黑底，功能不受损）；overlay 与主窗口的状态契约是单向推送，任何一端重启后由载荷重放恢复；窗口层级提升带来跨应用遮挡管理（用户可拖动、可收起）。

## 交互与状态语义（ADR-012）

- **点击不再循环切换宠物**（ADR-005 作废）：换宠只在设置页列表与 `/pets` 命令完成；宠物本体不可点击。
- **长按拖动**：按住宠物 400ms（位移 <8px）进入拖动；桌面端经 `pet_overlay_move` 移动窗口并持久化位置，应用内（Web/移动）以 transform 偏移并持久化到 localStorage。
- **状态触发后持续保持**：running/needs-input/blocked 动画轨道循环播放主帧（`loopStart: 0`），不再播完退回 idle 呼吸；气泡文案同样持续显示，直至状态变化。`ready` 仍为呼吸循环。
