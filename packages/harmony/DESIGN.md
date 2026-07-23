# HarmonyOS 原生壳设计

## 状态

Sprint 1 的平台识别、最小 NativeMobileAdapter、原生实例连接入口和 Asset Store token bridge 已落地；API 24 模拟器和 API 24+ 真机均完成远程 HTTP Server 产品冒烟。安全写失败时客户端按不变量停留在登录页且不保存 token 或切换 runtime；待认证的地址/名称元数据会保留，便于重试。bridge `0.4.0` 在原有请求 ID + 页面回调安全存储协议上新增 Ability 前后台状态通道，供 shared UI 前台恢复时复用现有 re-probe；该生命周期路径已通过真机运行验收。

## 目标

- 复用 `packages/mobile` 的正式构建产物，并以可重复脚本生成 HAP 内资源。
- 让 ArkWeb 在 `https://localhost` 下加载完整 MobileApp，同时只拦截打包静态资源。
- 保持 OpenChamber 的认证、会话、SSE、WebSocket 和 Terminal 状态机在既有 TypeScript 代码中。
- token 不进入普通 Web 存储，Harmony 不伪装成 Capacitor。

## 非目标

- 不模拟 Capacitor，也不让 isCapacitorApp 对 Harmony 返回 true。
- 不在 ArkTS 中复制连接、认证、runtime switch、SSE、WebSocket 或 relay 状态机。
- 不实施 Native HTTP、深链、扫码、Push、更新器或外部链接能力。
- 不基于 rawfile 或未验证的候选 Origin 放宽 Server CORS 或 WebSocket request-security。

## 当前架构

    ┌───────────────────────────────────────────────────────┐
    │ Harmony HAP                                           │
    │                                                       │
    │ EntryAbility ── foreground/background                 │
    │   └─ Index ArkUI Page ── HarmonyLifecycleChannel      │
    │       └─ ArkWeb https://localhost/index.html          │
    │          ├─ PackagedMobileAssets                      │
    │          │  ├─ /assets/*、根静态文件 → HAP rawfile      │
    │          │  └─ /api、/auth、/health → ArkWeb 网络       │
    │          └─ 既有 MobileApp bundle                      │
    │             └─ NativeMobileAdapter → Asset Store       │
    │                                                       │
    │ HarmonyMobileBridge                                   │
    │   ├─ 平台/能力声明 + active boolean                     │
    │   └─ 受限 token get/set/remove → Asset Store           │
    └───────────────────────────────────────────────────────┘

## 组件职责

| 组件 | 职责 | 不承担的职责 |
| --- | --- | --- |
| EntryAbility | 创建 ArkUI 页面；发布前台/后台布尔状态 | 网络、认证、token 或业务状态管理。 |
| Index | 创建 ArkWeb、设置 `https://localhost` 入口、启用 LAN mixed content、安装静态资源拦截和 bridge 白名单、转发/清理生命周期订阅 | 认证、网络代理、token 或业务状态。 |
| PackagedMobileAssets | 将允许的虚拟静态 URL 映射到 `rawfile/mobile`，返回正确 MIME；未知和运行时路由不拦截 | 代理 `/api`、伪造后端成功或接受路径穿越。 |
| HarmonyMobileBridge | 返回平台/能力；通过 Asset Store 读写受限 token key；向页面发送 active boolean；区分未找到与存储失败 | HTTP、密码/pairing、文件、命令、URI、批量 secret 或任意 key 访问。 |
| NativeMobileAdapter | 唯一读取 `window.openChamberHarmony` 的共享 UI 边界；验证 bridge/capability/envelope | 认证状态机、任意 native dispatch 或未声明能力的乐观回退。 |
| tools/prepare-mobile-assets.mjs | 从现有 Mobile dist 原子准备生成资源；输入无效时保留旧资源 | 构建或修改 React 业务代码。 |
| poc/* | 保留 Sprint 0 的 Origin/bridge 证据 | 作为应用启动页。 |

## 设计决策

| 决策 | 原因 | 影响 |
| --- | --- | --- |
| 拒绝 rawfile 作为联网 UI Origin | 页面显示 `resource://rawfile`，但受控服务对 HTTP、preflight、SSE、WebSocket 实际都收到 `Origin: null`。 | 不添加 `null` / `*` allowlist；rawfile 仅保留离线基线。 |
| 以 `https://localhost` 拦截打包静态资源 | 该 Origin 已是现有 OpenChamber HTTP CORS 与 WebSocket security 的 packaged-client 候选；API 24 已成功渲染真实 MobileApp。 | 静态加载已通过；实际 HTTP/SSE/WS 仍需 HTTPS Server 和真机证据。 |
| 仅拦截静态形状 | 避免 `/api`、`/auth`、`/health` 失败被 HAP 文件或空页面伪装成成功。 | 运行时请求继续由既有 browser/realtime transport 管理。 |
| 不将 Harmony 伪装成 Capacitor | Capacitor 路径会调用其插件；伪装会造成错误能力声明。 | `isCapacitorApp()` 保持原义，`isNativeMobileApp()` 覆盖受支持原生壳。 |
| Bridge 名称为 openChamberHarmony | 与开发方案中长期 bridge 名称保持一致。 | 生产版仍需通过 NativeMobileAdapter 封装，UI 代码不得直接读取 window 全局。 |
| 仅对白名单 `https://localhost` 注册 bridge | 原生 bridge 是高信任边界，只有当前的固定虚拟页面候选可调用。 | 若最终 UI Origin 改变，必须先更新 Origin ADR，再重新配置白名单。 |
| 传输诊断使用直接浏览器 API | `poc/index.js` 仅对固定、无凭据的诊断服务发起 `fetch`、`EventSource` 和 `WebSocket`，以记录 ArkWeb 能力与实际 Origin。 | 该代码绝不进入 MobileApp 或 OpenChamber runtime；生产 WebSocket 仍必须通过既有 `openRuntimeWebSocket` 与 URL-token 流程。 |
| 使用 Asset Store 保存 token | Asset Store 是 HarmonyOS 面向密码/token 的受保护资产 API，避免自管 HUKS 密钥、IV 和密文文件格式。 | token 写成功后才持久化 `hasToken` 或切换 runtime；bridge 不记录 key/value。 |
| 显式启用 `MixedMode.All` | 与现有 Android mobile shell 的 LAN HTTP 产品能力一致，并让既有 fetch/SSE/WebSocket 状态机继续工作。 | 只改变 ArkWeb mixed-content 策略，不绕过 Server CORS/Origin；必须补齐模拟器/真机网络矩阵。 |
| 生命周期只发送 active boolean | Ability 是 Harmony 前后台状态的权威来源，shared UI 已有 re-probe/恢复逻辑。 | ArkTS 不复制同步状态机；页面卸载会解除订阅，Capacitor 路径保持不变。 |

## 安全模型

| 资产或边界 | 威胁 | 当前控制 |
| --- | --- | --- |
| ArkTS bridge | 远程/iframe 页面调用高权限原生能力 | ArkWeb `https://localhost` URL 白名单；固定方法白名单；token key 前缀/长度和值长度校验。 |
| 日志 | URL、token 或用户数据泄露 | ArkTS bridge 不输出 key、value 或底层异常；共享层只记录已有的连接 key 与布尔结果，不记录 token。 |
| 安全存储 | 失败被误判为不存在或写入成功 | bridge envelope 区分 `value: null` 与 `ok: false`；写失败阻止 metadata/runtime switch。 |
| 本地资源 | 混淆 Origin 与 native 身份 | 只有同时满足固定 bridge 平台值和能力契约时才识别为 Harmony。 |

## Sprint 1 迁移边界

Sprint 1 已按以下边界落位：

    packages/harmony/                 ArkTS 宿主、Asset Store、mixed-content 策略、资源复制
    packages/ui/src/lib/native-mobile 共享 NativeMobileAdapter 接口与 Harmony 实现入口
    packages/ui/src/lib/platform.ts   harmony 平台识别与语义明确的 native guard

业务认证、pairing、candidate、SSE、WebSocket、Terminal 和 relay 状态机继续留在既有 TypeScript 代码。任何新增 WebSocket 仍须经过既有 runtime socket 与 URL-token 流程，不得在 Harmony 页面中直连。

## 已知限制

- DevEco 构建、API 24 模拟器和 API 24+ 真机安装/产品冒烟已验证；精确 Origin、SSE 与 WebSocket 的独立诊断证据仍不完整。
- rawfile 的实际 URL 为 `resource://rawfile/poc/index.html`，页面 Origin 为 `resource://rawfile`，但其外发网络请求 Origin 为 `null`，已被拒绝作为联网 UI 候选；Iframe 行为与非白名单页面调用 bridge 仍待验证。
- `MixedMode.All` 已在 API 24 模拟器证明可让 `https://localhost` MobileApp 对远程 HTTP Server 完成 `/health`、`/auth/session` 和密码 POST；这不证明 SSE/WebSocket 已通过。
- Harmony 没有 Native HTTP fallback。证书信任、LAN 网络策略或 Origin 校验导致的 browser fetch 失败会保持“无法连接”语义；不会绕过 CORS，也不会以探测成功替代 runtime fetch/SSE/WebSocket。
- 已定义并验证 bundle asset pipeline 与静态 virtual-origin 映射；尚未验证该 Origin 到真实 Server 的 SSE/WebSocket 完整矩阵。
- 共享 UI 已把有效 Harmony bridge 识别为 native mobile 并绕过 Web SessionAuthGate；真实连接页、密码校验、token 签发、安全写入、runtime switch、冷启动恢复和主界面冒烟已在真机通过。
- Ability→bridge→shared UI 的 authoritative resume 已实现；包含 bridge `0.4.0` 的 HAP 已通过真机后台→前台恢复与 re-probe 验收。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-07-22 | 创建最小 Stage/ArkWeb PoC，限制 bridge 到 resource/rawfile。 |
| 2026-07-22 | 在 API 24 模拟器验证 rawfile Origin、受限 bridge 与 ArkTS 回调；增加手动、无凭据的传输诊断入口。 |
| 2026-07-22 | 受控服务记录 rawfile 的实际请求 Origin 为 `null`，拒绝其联网 UI 资格；加入 `loadData` 的 `https://localhost` 候选，等待运行时验证。 |
| 2026-07-22 | API 24 模拟器渲染 `loadData` 候选，bridge 与回调成功；LAN HTTP 传输仅 WebCrypto 通过且服务端零请求，继续以受信任 HTTPS 服务验证。 |
| 2026-07-22 | 接入正式 MobileApp 资源流水线，以 `https://localhost` 静态拦截加载完整 bundle；DevEco ArkTS/PackageHap 成功，API 24 模拟器显示真实 SessionAuthGate 页面。 |
| 2026-07-22 | 接入 Harmony NativeMobileAdapter、原生实例连接语义、Asset Store token bridge 和 mixed-content 配置；共享 UI 测试/类型检查/构建及 ArkTS/PackageHap 通过，模拟器更新包运行待补。 |
| 2026-07-22 | API 24 模拟器完成远程 HTTP `/health`、CORS、密码校验与 client token 签发；首轮 Asset Store 写入失败并留下未使用客户端记录。后续构建校正 Asset Store 参数、分流安全存储错误，并在失败时以刚签发的 token 尝试自撤销该记录。 |
| 2026-07-22 | 模拟器复验确认写入仍失败且新客户端会立即自撤销；第二轮把 Asset Store add 收窄到官方最小属性集，重复 alias 使用 update，并向测试界面暴露不含敏感数据的稳定失败原因。 |
| 2026-07-22 | `invalid-response` 证明 ArkWeb 异步代理调用不会直接返回 Promise 结果；bridge 0.3.0 改用受限请求 ID 和页面结果回调，补充成功/失败/畸形响应测试。 |
| 2026-07-22 | bridge 0.3.0 在 API 24 模拟器完成 Asset Store 写入与 runtime switch；用户验证主界面、会话切换、聊天、主题和语言设置无阻塞问题。 |
| 2026-07-22 | API 24+ 真机完成签名安装、冷启动恢复、连接与主界面产品冒烟；新增 bridge 0.4.0 Ability 生命周期回调与 shared UI resume re-probe。 |
| 2026-07-23 | bridge 0.4.0 在 API 24+ 真机完成后台→前台恢复与 re-probe 验收，未发现异常。 |
