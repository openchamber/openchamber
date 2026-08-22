# Pets 宠物状态气泡 — 开发文档

## 1. 背景与目标

复刻 codex CLI 的 `/pets` 宠物状态角标体验：会话运行期间在聊天区角落显示一只宠物，用动画与气泡文案反映会话状态（运行中/等待输入/已完成/受阻）。复用 OpenChamber 既有斜杠命令系统与设置/i18n 基础设施，不新造轮子；资产运行时按需下载，不膨胀仓库。

## 2. 领域模型与词汇表

| 术语 | 定义 |
|---|---|
| **Pet（宠物）** | 可展示的虚拟形象。拥有 `id`、名称、CDN 资产。共 8 只（数量与文件名需前置验证） |
| **PetState（宠物状态）** | 四态：`running` / `needs-input` / `ready` / `blocked`，语义对齐 codex，文案本地化 |
| **PetBubble（宠物气泡）** | 聊天区左下角浮动 UI 载体（Web/移动运行时）；桌面端由全局悬浮窗（PetOverlay）承载。长按可拖动，不可点击切换 |
| **PetOverlayWindow（宠物悬浮窗）** | 桌面端（Electron）独立 always-on-top 透明窗口，渲染 `pet-overlay.html`；状态由主窗口经 IPC 单向推送，位置持久化到桌面设置 |
| **PetAssetCache（资产缓存）** | CDN 资产按需下载后的本地缓存；Electron 落磁盘、Web/移动落 IndexedDB |
| **showPet（设置）** | 全局布尔设置，走正式设置系统；默认值按运行时平台区分 |
| **PetPreference（宠物偏好）** | 当前选中宠物 id，存 localStorage，不跨端同步 |

## 3. 决策记录（ADR 摘要）

详见 `docs/adr/0003-pets-pet-status-bubble.md`，本文档为实施视角的展开。

| 编号 | 决策 | 依据 |
|---|---|---|
| ADR-001 | 资产运行时从 `https://persistent.oaistatic.com/codex/pets/v1/*.webp` 按需下载 + 本地缓存，**不打包进仓库** | Q7-A；仓库不膨胀，失败可优雅降级 |
| ADR-002 | 气泡文案本地化（运行中/等待输入/已完成/受阻），不逐字复刻英文 | Q8-B；项目 i18n 硬规范（`locale-ui-patterns`） |
| ADR-003 | 桌面/Web 默认显示；Capacitor 与 hosted mobile 默认隐藏、设置可开启 | Q9-B；共享契约覆盖全部 5 运行时 |
| ADR-004 | `/pets` 为 UI 操作型命令（切换开关）：`/pets` 显隐、`/pets <name>` 选宠；不产生消息、不经 LLM；无会话可用 | Q1-A；复用 `builtInCommands` + `handleSubmit` 斜杠分支（同 undo/redo/timeline 模式） |
| ADR-005 | 默认单只宠物，~~点击循环切换~~（已作废，见 ADR-012）；换宠走设置页列表与 `/pets` 命令；偏好持久化到 localStorage | Q2-A、Q4-A；渲染可控，多只/按状态换宠留作增强 |
| ADR-006 | 四态信号全部用真实数据：`busy`→运行中、`retry`→受阻、idle 且有 pending permission/question→等待输入、其余 idle→已完成 | Q5-A；`session.error` 归约 idle 的事实决定"受阻"用 retry 而非 error |
| ADR-007 | 有消息的会话即显示，无会话/无消息隐藏 | Q6-A |
| ADR-008 | 加载中显示静态占位帧；单只失败隐藏 + 一次性提示；全部失败显示离线气泡；下次会话重试；**失败不伪装成成功** | Q7-A；AGENTS.md 不变量 |
| ADR-009 | `showPet` 进正式设置系统（跨端同步）；宠物偏好本地存储 | Q8-A；设置系统 5 处契约 + 服务端白名单 |
| ADR-010 | 气泡挂聊天区左下角（`left-3 bottom-3`），z-index 低于 autocomplete(z-100)/抽屉(z-60)；桌面端由独立置顶悬浮窗承载（ADR-011），Web/移动保持应用内挂载 | Q3-A；实测左下角无既有浮层，与右上角 WorkStatusPanel 对角线不冲突 |

## 4. 状态映射规范

输入信号（事实已核验）：

- `useSessionActivity(sessionId)` → `phase: 'idle'|'busy'|'retry'`（`useSessionActivity.ts:30`）
- **注意**：pending permission/question 时该 hook 强制返回 idle（:41），须先查再判
- `useSessionPermissions` / `useSessionQuestions` → 等待输入的判据

| 显示态 | 判定（按序） | 气泡文案 |
|---|---|---|
| 运行中 | `phase === 'busy'` | 运行中 |
| 受阻 | `phase === 'retry'` | 受阻 |
| 等待输入 | `phase === 'idle'` 且 pending permission/question 非空 | 等待输入 |
| 已完成 | 其余 idle | 已完成 |

## 5. 技术设计

### 5.1 命令注册

- `CommandAutocomplete.tsx:141` `builtInCommands` 增加 `{ name: 'pets', source: 'openchamber', isBuiltIn: true, description: t(...) }`；`getCommandIcon`（:337）加 `case 'pets'`
- `ChatInput.tsx` `handleSubmit` 斜杠分支：解析 `pets` 与可选参数 → 切换显隐 / 设置选中宠物；**不进入发送流程**（参照 undo/redo/timeline 一类）
- `slashCommands.ts` 的 `MAGIC_PROMPT_COMMANDS` 不适用（该表为"发送 prompt 对"命令）

### 5.2 资产获取与缓存

- URL 模式：`https://persistent.oaistatic.com/codex/pets/v1/{id}-spritesheet-v4.webp`
- **前置验证已完成（实测）**：8 只内置宠物来自 Codex App 目录——`codex` / `dewey` / `fireball` / `rocky` / `seedy` / `stacky` / `bsod` / `null-signal`。资产是**静态精灵图**（1536×1872，8 列×9 行帧，每帧 192×208），单张 0.49–1.03MB，总计约 6.5MB（修正了早期"8 个独立动画 webp、约 32MB"的估算）。动画由运行时按帧网格裁切播放，轨道与 Codex 目录一致（idle 行 0 / running 行 7 / waiting 行 6 / review 行 8 / failed 行 5）
- 缓存键 = CDN 文件名（版本化，更新即换文件名）；统一 IndexedDB（共享 UI 无磁盘 API，Electron/Web/移动行为一致）；已缓存资产点击切换零网络
- 资产状态机：`idle` / `loading` / `ok` / `failed`，显式区分，绝不把失败渲染成成功；失败后点击或下次会话重试

### 5.3 状态订阅

- 单会话场景：`useSessionActivity` + `useSessionPermissions`/`useSessionQuestions`
- 跨会话聚合（如多会话场景）可仿 `SessionSidebar.tsx:228` 的 `hasBusySession`，但本版先按"当前会话"实现（ADR-007 范围内）

### 5.4 渲染

- Web/移动挂载点：`ChatContainer.tsx` 的 `data-composer-bound` relative 容器（:1244）；桌面端（Electron）不渲染应用内气泡，由独立 always-on-top 透明悬浮窗（`pet-overlay.html`）承载
- 桌面悬浮窗：主进程创建（transparent/frameless/`alwaysOnTop('floating')`/skipTaskbar/focusable:false/`hasShadow:false`；macOS 上 `type: 'panel'`），与主窗口同 origin 共享 IndexedDB 资产缓存；状态与回复预览由主窗口 `PetOverlayBridge` 经 `pet_overlay_show|hide|update` IPC 单向推送，主进程重放最新载荷；窗口位置存 `settings.json#desktopPetOverlayPosition`
- 多桌面（macOS Spaces）：悬浮窗 `setVisibleOnAllWorkspaces(true)` 在所有 Space 可见；`type: 'panel'`（NSPanel）保证**点击/拖拽宠物不激活 app**——normal 窗口点击会激活宿主 app 并把用户带回 app 所在 Space，面板窗口不会；`app.on('activate')` 的候选窗口过滤 `__ocPetOverlay`，Dock 点击永不聚焦宠物窗口
- 渲染：不使用 `<canvas>`，宠物用 `<div>` + `background-image`（blob/data URL 雪碧图）+ rAF 更新 `background-position` 播放帧动画，彻底消除画布背景；`background-size` 必须按网格缩放到 div 尺寸（`SPRITESHEET_COLUMNS * displayWidth` × `9 * displayHeight`），动画位移用缩放后的网格坐标（`(sprite % 8) * displayWidth` / `floor(sprite / 8) * displayHeight`）——若直接使用雪碧图原始尺寸（1536×1872）与原始帧坐标，div 窗口只会显示每帧约 1/4 的切片，宠物呈现为被裁剪的局部放大图（canvas 版 drawImage 裁剪完整帧后缩放，不会出现此问题）
- 悬浮窗透明：窗口 `transparent: true` + `pet-overlay.html` 内联 `html, body, #root { background: transparent !important }` + `src/pet-overlay.css`（在共享 `@openchamber/ui/index.css` 之后加载，`!important` 强制透明）——共享样式的 `body { background-color: var(--background) }` 在构建产物中位于内联样式之后，若不在 `@layer` 内会胜出，浅色主题下会画出白色背景块；悬浮窗页面不得引入任何会为 `body`/`#root` 上色的规则
- 悬浮窗气泡：`PetStatusBubble` 增加 `translucent` 选项，悬浮窗（`PetOverlay`）传入后用 `color-mix(in srgb, var(--popover) 55%, transparent)` 半透明表面替代纯 `--popover` 背景——浅色主题下 `--popover` 为纯白，实心气泡会在透明悬浮窗上呈现为紧贴宠物的白色矩形；应用内气泡（`PetBubble`）保持实心 popover 表面不变
- 气泡方向翻转：气泡始终在宠物正上方，"方向"= 水平对齐（`items-end` ↔ `items-start`，尾巴 `right-4` ↔ `left-4` 跟随）。宠物中心越过所在中线（应用内 = 视口中线，桌面 = 窗口所在显示器工作区中线，由主进程 `pet-overlay-work-area` 事件推送）即翻转，±24px 滞回死区防抖；拖拽实时生效（应用内 effect 监听 offset/resize，桌面 rAF 循环读 `window.screenX`）；翻转经 `key={align}` 重挂播放 200ms 滑入淡入（`pet-bubble-slide-in-*`，仅 transform/opacity）。应用内气泡另加 `capToViewportHalf` 把最大宽度限制为 `min(16rem*petSize, 50vw - 1.5rem)`，小窗+大宠物尺寸翻转后也不越界；桌面窗口本身被 clamp 在工作区内，无需此约束
- 窗口尺寸：按宠物实际宽度与气泡最大宽度（`16rem * petSize` + padding/border）计算宽度；高度 = 宠物高度 + 气泡区预留 `PET_OVERLAY_BUBBLE_SPACE_HEIGHT`（112px，main.mjs 与 PetOverlay.tsx 两处常量保持一致），预留值按 3 行预览的最大气泡高度计算，防止气泡把宠物顶出窗口顶部；默认 `setIgnoreMouseEvents(true, { forward: true })`，鼠标进入宠物/气泡区域才切 interactive
- 交互：**不可点击切换宠物**；桌面端按下即拖动（`longPressMs: 0`），以绝对屏幕坐标 `pet_overlay_move_to` 移动窗口并持久化；Web/移动仍长按 400ms 后以 transform 偏移并持久化到 localStorage
- 动画：状态触发后持续保持（running/needs-input/blocked 主帧循环，`loopStart: 0`），直至状态变化；`ready` 为呼吸循环；空闲时鼠标悬停宠物播放 hover 反应动画（帧 33-36 连续跳跃 3 遍后回 idle；雪碧图帧 37-39 为空白帧，不入轨道，`loopStart: null` 使一次性停止逻辑生效，每次移入重新触发）；拖拽时播放 `running` 奔跑动画；气泡文案同样持续显示
- 气泡：`ready` 态只显示回复预览气泡（不显示"已完成"状态文字）；其他状态仍显示状态文字
- Dock：`app.whenReady()` 内 `setActivationPolicy('regular')`，防止 Launch Services 将应用误分类为 UIElement 导致 Dock 无运行点/无退出菜单
- 性能：仅渲染当前宠物；`document.hidden` 时暂停动画；拖拽移动经 `requestAnimationFrame` 合并，减少 IPC；宠物外层明确 `bg-transparent outline-none`

### 5.5 设置项（5 处契约 + 服务端）

1. `lib/desktop.ts:47` `DesktopSettings` 加 `showPet?: boolean`
2. `lib/api/types.ts:634` `SettingsPayload` 加 `showPet?: boolean`
3. `stores/useUIStore.ts`：interface + 默认值 + setter + `partialize`（4 处）
4. `lib/persistence.ts`：`materializeAuthoritativeUiSettings` 默认值（桌面 true / 移动 false，仿 `mobileKeyboardMode` 平台分默认先例）、`applyDesktopUiPreferences`、`sanitizeWebSettings`
5. `packages/web/server/lib/opencode/settings-helpers.js:124` `sanitizeSettingsUpdate` 白名单加 `showPet` 校验（不加则设置写不进磁盘）
6. UI：`OpenChamberVisualSettings.tsx`（`VisibleSetting` :281、`shouldShow`、`SettingsCheckboxRow` + `settingsItem`）、`OpenChamberPage.tsx` `visibleSettings`、`lib/settings/search.ts` 条目（id 与 settingsItem 一致）

### 5.6 i18n（11 语言 × 2 文件，缺 key 编译失败）

- 命令描述：`chat.commandAutocomplete.command.petsDescription`
- 气泡文案：`chat.pets.state.{running,needsInput,ready,blocked}`
- 设置项：`settings.openchamber.visual.field.showPet` + `...Aria`
- 所有 11 种 locale 全量补齐（`Record<I18nKey, string>` 类型强制 + `messages.test.ts` key parity）

## 6. 文件改动清单

| 文件 | 改动 |
|---|---|
| `packages/ui/src/lib/desktop.ts:47` | `DesktopSettings` 加 `showPet?: boolean` |
| `packages/ui/src/lib/api/types.ts:634` | `SettingsPayload` 加 `showPet?: boolean` |
| `packages/ui/src/stores/useUIStore.ts` | interface / 默认值 / setter / `partialize` 4 处 |
| `packages/ui/src/lib/persistence.ts` | `materializeAuthoritativeUiSettings` 平台默认（桌面 true/移动 false）、`applyDesktopUiPreferences`、`sanitizeWebSettings` |
| `packages/web/server/lib/opencode/settings-helpers.js:124` | 白名单加 `showPet` 校验 |
| `packages/web/server/lib/opencode/settings-helpers.test.js` | sanitize 用例 |
| `packages/ui/src/components/chat/CommandAutocomplete.tsx:141,337` | `builtInCommands` 加 `pets` + 图标 case |
| `packages/ui/src/components/chat/ChatInput.tsx` | `handleSubmit` 斜杠分支：`pets`/`pets <name>` 显隐与选宠，不产生消息 |
| `packages/ui/src/components/sections/openchamber/OpenChamberVisualSettings.tsx:281` + `OpenChamberPage.tsx` + `lib/settings/search.ts` | 设置 UI 与搜索索引 |
| 新增 `packages/ui/src/components/chat/pets/` | `catalog.ts`（宠物目录）、`animations.ts`（帧网格与动画轨道；含 `PetAnimationState`、`hover` 开心轨与 `trackDuration`）、`petAssetStore.ts`（下载/IndexedDB 缓存/状态机）、`usePetState.ts`（四态映射）、`petPreference.ts`（本地偏好）、`PetBubble.tsx`（应用内 div 雪碧动画气泡；桌面平台守卫防重复渲染）、`PetStatusBubble.tsx`（状态气泡，双端共享，popover token 背景，ready 只显示预览）、`usePetDrag.ts`（长按拖拽；桌面用 `onDragMoveTo` 绝对坐标）、`usePetAssistantPreview.ts`（回复预览）、`PetOverlay.tsx`（悬浮窗 div 渲染；hover/drag 动画切换、透明无框）、`PetOverlayBridge.tsx`（桌面状态桥接） |
| 新增 `packages/web/pet-overlay.html` + `src/pet-overlay-main.tsx` | 悬浮窗页面与入口（vite 多入口 `petOverlay`） |
| `packages/electron/main.mjs` | 悬浮窗窗口生命周期、`pet_overlay_show/hide/update/move_to` IPC、按气泡/宠物宽度动态计算窗口尺寸、位置持久化与恢复、退出清理 |
| `packages/ui/src/lib/i18n/messages/*`（11 语言） | `chat.pets.state.*`、`chat.commandAutocomplete.command.petsDescription`、`settings.openchamber.visual.field.showPet`(+Aria) |

## 7. 验证计划

| 检查 | 命令 |
|---|---|
| 类型/i18n key | `bun run --cwd packages/ui type-check` |
| 服务端白名单 | `bun run --cwd packages/web test`（settings-helpers 用例） |
| 死代码/导出形状 | `bun run dead-code` |
| 手动 | 桌面/Web 默认显示、移动默认隐藏；断网降级；点击切换 |
| 手动（气泡翻转） | 应用内与桌面双端：宠物拖到屏幕最左/最右气泡不越界、中线往返翻转、±24px 内小幅拖动不抖动、翻转动画、窗口 resize 后方向正确、刷新/重启后按持久化位置显示正确方向；桌面端多显示器时气泡按窗口所在显示器中线翻转 |
| 手动（多桌面） | macOS 两个以上 Space：宠物在每个 Space 可见；在其他 Space 点击/拖拽宠物不切回 app 所在桌面；Dock 点击不聚焦宠物窗口；宠物窗口不出现在 Mission Control 窗口切换器（panel 行为） |

## 8. 失败与回滚考量

- CDN 不可用：全部 `failed` → 离线气泡 + 一次性提示；`/pets` 命令仍可显隐切换
- 设置保存失败：白名单缺失时静默丢弃——以 `settings-helpers.test.js` 用例兜底防回归
- 回滚：`showPet` 默认值改 false 即全局隐藏；命令与气泡共用同一开关
- 键盘/遮挡回归：移动端键盘开合动画不影响气泡挂载层（挂 app shell 而非 composer）
