# Sprint 0 真机可行性检查表

本清单记录 HarmonyOS 原生壳的证据，而不是设计假设。每一项应记录设备/SDK 版本、日期、截图或 Server 日志位置；不要在此文件写入 token、pairing payload、用户 URL 或敏感会话内容。

## A. 环境

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| DevEco Studio 已安装 | 已验证 | 6.1.1（2026-07-22） |
| HarmonyOS 6.1.1/API 24+ SDK 已安装 | 已验证 | DevEco SDK 设置显示 HarmonyOS 6.1.1 Release 已安装（截图，2026-07-22）。 |
| API 24 Phone 模拟器可用 | 已验证 | HarmonyOS 6.1.0.125/API 24 模拟器已启动并运行 PoC（2026-07-22）。 |
| DevEco/Hvigor 可构建 Debug HAP | 已验证 | DevEco 6.1.1 的 `assembleHap` 成功，生成 Debug HAP 并可启动；Hot Reload 插件空指针已在本地运行配置中关闭（2026-07-22）。 |
| 真机 Debug 签名与安装 | 已验证 | 当次本地 `products.default` 已绑定 `default` 签名方案；signed HAP 成功安装到 API 24+ 真机并运行（用户实测，2026-07-22）。仓库基准不提交该本地签名配置。 |
| Bun 可复现 Web/Mobile 资产构建 | 已验证 | Bun 1.3.14；Web build + Mobile asset preparation 成功，生成 355 个移动端资源文件（2026-07-22）。 |

## B. 本地 ArkWeb 与 bridge

安装当前 PoC 后，记录页面显示的实际值。

| 检查项 | 期望 | 结果 |
| --- | --- | --- |
| rawfile 页面加载 | 显示 PoC 页面 | 已验证：API 24 模拟器截图（2026-07-22）。 |
| 页面 URL | 记录原始值 | 已验证：`resource://rawfile/poc/index.html`。 |
| 页面 Origin | 记录原始值，不预设为 https://localhost | 已验证：`resource://rawfile`。 |
| 原生平台 | harmony | 已验证：`harmony`。 |
| bridge 版本 | 0.1.0-poc | 已验证：`0.1.0-poc`。 |
| 能力声明 | 全部为 false | 已验证：`nativeHttp`、`secureStorage`、`lifecycle`、`scanQr` 均为 `false`，scope 为 `sprint-0-poc`。 |
| ArkTS 回调 | 显示 runJavaScript 回调成功 | 已验证：页面显示 ArkTS `runJavaScript` 回调成功。 |
| rawfile 外发请求 Origin | 记录服务端实际值 | 已验证：HTTP GET、OPTIONS preflight、SSE、WebSocket 均为 `Origin: null`，被仅允许精确 Origin 的诊断服务拒绝（2026-07-22）。 |
| `loadData` 候选页、bridge 与回调 | 显示候选页，bridge/回调可用 | 已验证：API 24 模拟器显示 `loadData` 候选页，三个 bridge 值和 ArkTS 回调均成功（截图，2026-07-22）；页面 URL/Origin 顶部值仍需单独留存。 |
| 正式 MobileApp 打包与静态映射 | 显示既有 MobileApp，而非 PoC | 已验证：355 个 Mobile 资源进入约 35 MB HAP；ArkTS/PackageHap 成功，API 24 模拟器显示真实原生实例连接页（截图，2026-07-22）。 |
| 非白名单页面调用 bridge | 被拒绝 | 待验证 |

## C. Origin 决策矩阵

仅在确定最终页面 Origin 后，才开始生产 adapter 或 Server allowlist 变更。

| 候选加载方式 | 实际 Origin | HTTP CORS | runtime fetch | SSE | WebSocket | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| rawfile resource | 页面为 `resource://rawfile`，实际请求头为 `null` | 已拒绝 | 已拒绝 | 已拒绝 | 已拒绝 | 不可作为联网 UI Origin；不得放宽到 `null` 或 `*`。 |
| `loadData` 精确 https://localhost 映射 | 顶部值待留存 | LAN HTTP 未到达服务端 | LAN HTTP 未到达服务端 | LAN HTTP 未到达服务端 | LAN HTTP 未到达服务端 | 候选页/bridge 已运行；HTTPS 页面到 LAN HTTP 的 1/5 结果疑似 mixed-content 前置拦截，不能据此判定精确 Origin 请求头。需要受信任 HTTPS 服务继续验证。 |
| `onInterceptRequest` + 正式 MobileApp | ArkWeb 入口配置为 `https://localhost/index.html`；服务端实际接受 `Origin: https://localhost` | 已验证：远程 HTTP `/health`、preflight、`/auth/session` 和密码 POST 到达并返回 | 已验证连接/认证请求；会话 API 待 Asset Store 修复后验证 | 待验证 | 待验证 | `MixedMode.All` 已证明基础 browser fetch 可用；SSE/WS 不得据此推断。 |
| 最终自定义 Origin + Server allowlist | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 回退候选 |
| loopback server | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 仅最后回退 |

每个网络格必须覆盖直接 HTTPS、声明支持的 LAN HTTP，以及失败路径。初始 Native HTTP 成功不可以填充 runtime fetch、SSE 或 WebSocket 结果。

## D. 继续/停止判定

可以进入 Sprint 1 的前提：

- [ ] 最终 Origin 已确定，且桥白名单可以安全限定到它。
- [ ] HTTP CORS、runtime fetch、SSE 和 WebSocket 全部在该 Origin 下通过。
- [ ] HTTPS UI 到支持的 LAN HTTP Server 的 mixed-content 行为已实测且可接受。
- [x] 原生 gate 审计完成，未发现需要复制 TypeScript 业务状态机的路径（2026-07-22）。
- [x] HAP 和 PoC 已在 API 24 Phone 模拟器验证（2026-07-22）。
- [x] 正式 MobileApp 资源已由自动脚本生成、打包并在 API 24 模拟器渲染（2026-07-22）。
- [ ] MVP 前在 API 24+ 真机复验 HAP、Origin、bridge 与传输矩阵。

任一前提不满足时，不得把 Sprint 1 或网络能力标记为已验收；即使产品主线实现先行，也必须保留失败证据并补齐运行时矩阵。

## E. Sprint 1 产品主线进度

用户确认优先推进现有 MobileApp 产品主线后，以下实现已完成静态/构建门禁，但不能替代上面的运行时网络证据：

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Harmony 平台识别 | 已通过静态测试 | `getClientPlatform() === 'harmony'`；`isNativeMobileApp() === true`；`isCapacitorApp() === false`。 |
| NativeMobileAdapter | 已通过单元测试 | 缺失/错误 bridge 安全回退；只有三项完整方法存在时声明 secure storage。 |
| token 元数据隔离 | 已通过单元测试 | Harmony `localStorage` 仅含 `hasToken`，不含 `clientToken` 或 token 值。 |
| 安全写失败 | 已通过单元测试 | Asset Store bridge 返回失败时不写连接 metadata，不切换 runtime。 |
| ArkTS/PackageHap | 已通过 | 显式 `DEVECO_SDK_HOME` 与 DevEco JBR 环境下 `CompileArkTS`、`PackageHap`、`assembleHap` 成功（2026-07-22）。 |
| 更新 HAP 模拟器运行 | 已验证 | 用户手动启动 API 24 包：原生连接页、远程 HTTP `/health`、CORS、密码校验、client token 签发、安全写入和 runtime switch 通过（2026-07-22）。 |
| Asset Store 兼容修复 | 已验证 | bridge 0.3.0 在 API 24 模拟器完成 token 写入并进入主界面；失败路径的专用错误和签发后自撤销已在前序复验中确认。 |
| ArkWeb 异步 bridge 返回协议 | 已验证 | 请求 ID + ArkTS 页面回调消除 `invalid-response`，模拟器安全存储写入成功；2.5 秒超时负责清理未完成请求（2026-07-22）。 |
| Sprint 1 产品冒烟 | 已验证 | 用户完成主界面进入、会话切换、聊天、主题切换和语言切换，未发现阻塞问题（API 24 模拟器，2026-07-22）。 |
| API 24+ 真机产品冒烟 | 已验证 | 签名安装、冷启动保留实例、密码连接、主界面、会话切换、聊天、主题和语言均由用户实测通过（2026-07-22）。 |
| Sprint 2 authoritative resume | 已验证 | bridge 0.4.0 已接入 Ability background/foreground 并复用 `handleNativeResume`；新版 HAP 在 API 24+ 真机完成后台→前台恢复与 re-probe，未发现异常（用户实测，2026-07-23）。 |
