# HarmonyOS native gate 审计与迁移状态

## 结论

现有 `packages/ui` 的移动端能力可分为三类：

1. 可以提升为“任意原生移动壳”判断的**平台语义**；
2. 需要由未来 `NativeMobileAdapter` 提供、并经真机验证后才能在 Harmony 启用的**宿主能力**；
3. 明确属于 Capacitor/iOS/Android 实现、首个 Harmony MVP 不应伪装支持的**平台专属能力**。

因此，Harmony 接入不需要复制 `mobileConnections.ts` 的认证、pairing、候选地址、relay 或传输状态机。当前窄适配层只提供安全存储与生命周期；HTTP、SSE、WebSocket 与 UI 运行时仍由既有 browser/shared transport 负责。

本清单原为 adapter 实现前审计，现同步记录真机产品冒烟与 Sprint 2 最小生命周期迁移。平台识别、Asset Store bridge、shared UI 连接入口、真机主流程和 Ability 后台→前台 re-probe 均已通过。任何 `isCapacitorApp()` 仍只能按下列语义逐点迁移。

## 审计范围

| 位置 | 现有依赖 | 分类 | Sprint 建议 |
| --- | --- | --- | --- |
| `packages/ui/src/lib/platform.ts` | `window.Capacitor`、`capacitor:` | 平台语义 | 已完成：新增 `harmony` 与 `isNativeMobileApp()`；`isCapacitorApp()` 保持 iOS/Android 专属语义。 |
| `packages/ui/src/lib/device.ts` | `isCapacitorApp()` | 平台语义 | 已完成：通用原生移动壳强制 mobile-first；iPad 特化仍仅 Capacitor iOS。 |
| `packages/ui/src/apps/mobileConnections.ts` | CapacitorHttp、SecureStorage、Capacitor platform | 宿主能力 + 业务状态机 | 部分完成：平台元数据与安全存储已适配，连接/认证状态机复用；Harmony Native HTTP 未实现，runtime 依赖 ArkWeb mixed mode。 |
| `packages/ui/src/apps/MobileApp.tsx` | App、StatusBar、Keyboard、Capacitor | 混合 | 通用连接/Instances 使用 `isNativeMobileApp()`；Harmony lifecycle 复用 resume re-probe；状态栏、键盘和 back 明确保持 `isCapacitorApp()`。 |
| `packages/ui/src/hooks/usePushVisibilityBeacon.ts` | Capacitor App lifecycle | 生命周期宿主能力 | Sprint 2：用已验证的生命周期能力提供 authoritative active/background 信号；不能只靠 `document.visibilityState`。 |
| `packages/ui/src/apps/deepLinkNavigation.ts` | `@capacitor/app`、`@capacitor/push-notifications` | Capacitor 专属 | Sprint 3：另行定义 Harmony deep-link 来源；首个 MVP 不接入。 |
| `packages/ui/src/apps/mobileQrScan.ts` | `window.Capacitor.Plugins.BarcodeScanner`、Android module install | Capacitor 专属 | Sprint 3：单独定义 `scanQr`；未实现前保持 unsupported。 |
| `packages/ui/src/apps/useNativePushRegistration.ts` | Capacitor Push、APNS/FCM | Capacitor 专属 | Phase 2：需要 Push Kit、服务端契约与产品决策后另行实现。 |
| `packages/ui/src/components/sections/openchamber/NotificationSettings.tsx` | Capacitor Local Notifications 语义 | 平台能力差异 | Sprint 1：不能把 Harmony 标记为已有 native notification；先定义“不支持/未接入”的清晰表现。 |
| `packages/ui/src/components/sections/openchamber/OpenChamberPage.tsx` | `isCapacitorApp()` 隐藏 WebAuthn | 平台语义 | 已完成：所有支持的原生移动壳隐藏 passkey 设置。 |
| `packages/ui/src/components/chat/ChatInput.tsx` | Capacitor 键盘 choreography | 宿主能力 | Sprint 2：以 `keyboardChoreography` 等细粒度能力取代泛化 native 判断，先做真机输入法验证。 |
| `packages/ui/src/stores/useUpdateStore.ts` | `isCapacitorApp()` | 平台语义 | Sprint 1：已验证 Harmony 打包/更新策略后，才归类为 mobile runtime。 |
| `packages/ui/src/components/update/MobileAppUpdateToast.tsx` | Android update | Capacitor/Android 专属 | 保持 Android-only，Harmony 更新器另行设计。 |

## 目标适配层

下列接口描述当前边界；实现位于 `packages/ui/src/lib/native-mobile/`，具体 ArkTS 绑定留在 `packages/harmony`，shared UI 其他模块不直接读取 `window.openChamberHarmony`。当前实现 `platform: harmony`、`secureStorage` 与 `lifecycle`，其余能力保持 false/缺失。

```ts
type NativeMobileCapabilities = {
  http: boolean;
  secureStorage: boolean;
  lifecycle: boolean;
  keyboardChoreography: boolean;
  deepLinks: boolean;
  scanQr: boolean;
  push: boolean;
  updater: boolean;
};

type NativeMobileAdapter = {
  platform: 'ios' | 'android' | 'harmony';
  capabilities: NativeMobileCapabilities;
  http?: { request(input: NativeHttpRequest): Promise<NativeHttpResponse> };
  secureStorage?: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
  lifecycle?: { onAppStateChange(listener: (active: boolean) => void): () => void };
};
```

接口细节应在真正开始 Sprint 1 时结合现有类型与测试先例确认。尤其注意：不提供 `bridge.invoke(method, args)` 一类任意方法分发，也不把 token、密码或 pairing secret 放入日志或 `runJavaScript` 字符串。

## 各类迁移规则

### 1. 平台语义：可以抽象，但须在最终 Origin 与运行时验证之后启用

- `getClientPlatform()` 将来可返回 `harmony`，供设备元数据和服务器可观测性使用。
- `isNativeMobileApp()` 可覆盖经过验证的 Capacitor 与 Harmony 壳，用于 mobile-first 布局、排除浏览器专属 WebAuthn UI，以及通用 mobile runtime 分类。
- `isIPadApp()` 仍是 iOS/Capacitor 专属，不应因 Harmony 存在而改变。
- `isCapacitorApp()` 继续表达“可调用 Capacitor API”，不应改成通用原生端 alias。

### 2. 宿主能力：必须能力探测、限权并提供失败路径

#### HTTP 与安全存储

`mobileConnections.ts` 的核心价值是已有的配对、认证、token 轮换、candidate 排序与回退状态机。Harmony 当前只替换安全存储宿主边缘：

- 将 client token 保存到 HarmonyOS Asset Store，连接元数据仍留在现有可恢复存储。
- 返回明确失败而非空成功；安全存储读写超时必须保留现有状态机的错误/登录回退路径。
- 不由 ArkTS 独立实现登录、pairing、WebSocket、SSE、relay 或 Token URL 规则。

启用前必须实测：最终 Origin 下的 runtime fetch、EventSource、WebSocket、HTTPS UI 对 LAN HTTP 的 mixed-content 行为，以及 HTTP 失败不会让 UI 误判为已连接。

当前没有 Harmony Native HTTP。远程 HTTP Server 已通过真机产品连接，但自签名证书、LAN 策略或服务端 Origin 配置导致的 browser fetch 失败仍会显示既有“无法连接”错误。只有出现可复现真机失败案例后，才考虑仅覆盖 connect probe/password/pairing redeem 的受限 Native HTTP；禁止任意 URL、禁止替代 runtime fetch/SSE/WebSocket，也不得放宽服务端 CORS 到 `*` 或 `null`。

#### 生命周期

`MobileApp.tsx` 现通过 `NativeMobileAdapter.lifecycle` 接收 Harmony Ability 的 `onForeground`/`onBackground`，并复用既有 `handleNativeResume`。实现满足：

- 监听可解除，页面卸载后不残留回调；
- 初始 active 不触发额外 resume，只有真实 background→foreground 才触发；
- 前后台切换后只触发必要的同步/reprobe，不重建会话状态机；
- Ability authoritative 状态与网页 `visibilitychange` 互为恢复信号，并通过同一 inactive guard 保证一次切换只 re-probe 一次。

`usePushVisibilityBeacon.ts` 仍是独立消费者，尚未迁移到 Harmony lifecycle；本次能力只用于 MobileApp 的连接恢复，不能据此宣称 Harmony Push 生命周期已完成。

#### 键盘、状态栏与 back

这些不是一个“native”布尔值可以表达的能力。`MobileApp.tsx` 的 StatusBar/Keyboard 逻辑、`ChatInput.tsx` 的 `preventScroll` 与 keyboard event choreography、以及 Android back handler 都依赖具体 WebView 行为。Harmony 先以浏览器回退行为运行；只有真机确认系统键盘、safe-area、viewport 和返回键语义后，才逐项启用对应能力。

### 3. 平台专属能力：首个 Harmony MVP 保持关闭或 unsupported

- Push：现有实现面向 Capacitor 的 iOS/Android APNS/FCM 注册，非 Harmony 的泛化实现。Harmony Push Kit 需要独立的客户端、服务端、权限与隐私设计。
- 扫码：不得伪造 `window.Capacitor.Plugins`。将来由适配层显式声明 `scanQr`；未声明时 UI 走既有 unsupported 分支。
- 深链与通知跳转：必须在 Harmony Ability 生命周期、URI scheme/app-link 及 payload 校验设计完成后再接入。
- 应用更新：Android `MobileAppUpdateToast` 不适用于 HAP 更新。Harmony 的版本发现、下载、签名和回滚模型另行确定。

## 按 Sprint 的实施顺序

| 阶段 | 可以开始的条件 | 允许的改动 | 明确不做 |
| --- | --- | --- | --- |
| Sprint 0 | 无 | ArkWeb 原生/Origin/bridge 证据、正式 MobileApp 静态资源接入、此审计文档 | 修改 Server allowlist。 |
| Sprint 1 | API 24 模拟器与 API 24+ 真机通过 Origin、CORS、runtime fetch、SSE、WebSocket 门禁 | `platform.ts` 语义、最小 adapter、HUKS/HTTP、连接流程复用 | 新的 UI 状态机、Push/扫码/深链。 |
| Sprint 2 | Sprint 1 认证和重连稳定 | 生命周期、键盘/状态栏的已验证能力、首包性能 | 根据 Capacitor 经验猜测 ArkWeb 行为。 |
| Sprint 3 | MVP 稳定且产品需求确认 | 扫码、深链、外部链接等独立能力 | 将任一能力设为默认可用但无实际 bridge。 |
| Phase 2 | Push/更新产品与服务端协议批准 | Push Kit、Harmony 更新策略 | 重用 Android-only 更新或 APNS/FCM 代码。 |

## 验收与回归清单

在触碰 `packages/ui` 前，至少应新增或扩展下列测试：

- 平台识别：web、desktop、VS Code、Capacitor iOS/Android、Harmony、未知 bridge 都有明确结果。
- adapter 缺失：每一项能力走安全回退，不能抛出或假称成功。
- 安全存储：token 不进入连接元数据、日志或 URL；超时/失败不破坏已保存的其他连接。
- HTTP：方法、header、URL、超时、错误映射受到限制；拒绝未授权 scheme 或不符合产品策略的 endpoint。
- 生命周期：前后台、重复订阅、清理和 reconnect/reprobe 都可验证。
- 同一 shared UI 测试集继续覆盖 web、desktop、VS Code 和 Capacitor，Harmony 不得改变它们的运行时判定。

## 相关证据

- 设计和边界：`packages/harmony/DESIGN.md`
- 原生/Origin 真机记录：`packages/harmony/SPRINT0-CHECKLIST.md`
- 开发路线：`HARMONY-DEVELOPMENT-PLAN.md`

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-07-22 | 完成 Sprint 0 Capacitor/native gate 静态审计，确定先抽象宿主能力、后启用 Harmony 行为的边界。 |
| 2026-07-22 | 正式 MobileApp 已在 Harmony HAP/API 24 模拟器渲染；仍保持 Web/Capacitor gate 不变，等待 adapter 与传输门禁。 |
| 2026-07-22 | 完成最小 adapter、Harmony 平台语义、Asset Store token bridge、连接 metadata 隔离和安全写失败测试；更新 HAP 的运行时复验待完成。 |
| 2026-07-22 | API 24+ 真机产品冒烟通过；新增 Ability→bridge→NativeMobileAdapter lifecycle，复用 MobileApp resume re-probe，同时记录无 Native HTTP 的明确限制。 |
| 2026-07-23 | bridge 0.4.0 的 authoritative resume 在 API 24+ 真机通过后台→前台运行验收。 |
