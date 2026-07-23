# ADR-0001：拒绝 rawfile，并以 `https://localhost` 映射打包 UI

## 状态

`resource://rawfile` 已拒绝。`https://localhost` 已用于正式 MobileApp 的本地静态资源映射和 bridge URL 白名单；ArkWeb 已显式启用 `MixedMode.All`，但它作为完整网络传输 Origin 仍需 HTTP/SSE/WebSocket 运行时门禁。日期：2026-07-22。

## 背景与证据

API 24 模拟器中的基线页面显示：

- 页面 URL：`resource://rawfile/poc/index.html`
- `window.location.origin`：`resource://rawfile`

但对无凭据、精确 Origin 诊断服务发起 HTTP GET、OPTIONS preflight、SSE 和 WebSocket 时，服务端实际全部收到 `Origin: null`，并按精确来源规则拒绝。页面显示的 Origin 不能替代网络请求头证据。

## 决策

- rawfile 只保留为离线加载和 bridge 基线，不可作为 OpenChamber 联网 UI。
- 不向 HTTP CORS 或 WebSocket security allowlist 添加 `null`，也不使用 `Access-Control-Allow-Origin: *`。
- 不修改 `packages/web`：当前 OpenChamber 已将 `https://localhost` 列为 packaged-client 的 HTTP CORS 与 WebSocket security 候选。
- 正式壳以 `https://localhost/index.html` 为入口，通过 ArkWeb `onInterceptRequest` 只把 `/assets/*` 和根目录静态文件映射到 HAP 中的 `rawfile/mobile`。
- `/api`、`/auth`、`/health`、非 GET 和其他 Origin 一律不由静态映射处理，避免把后端失败伪装成静态成功。
- JavaScript bridge 仍只允许 `https://localhost`。当前只提供受 key 前缀/长度限制的 Asset Store token `get/set/remove` 和不含业务数据的 lifecycle active boolean；不提供 HTTP、密码、pairing 或任意 native dispatch。
- ArkWeb 设置 `MixedMode.All`，与现有 Android mobile shell 的 LAN HTTP 产品语义一致；该设置不绕过 Server CORS 或 WebSocket Origin 校验。

## `loadData` 候选的首轮运行时结果

API 24 模拟器已渲染候选页，三个无敏感 bridge 值和固定 ArkTS 回调均成功。对同一受控 LAN HTTP 诊断服务运行五项检测时，只有 WebCrypto 通过；HTTP、preflight、SSE、WebSocket 均失败，且服务端没有收到任何新请求。

此前 rawfile 页面可以到达同一服务，因此该结果表明 HTTPS 虚拟页面很可能在浏览器侧因 mixed-content 而被拦截。这不是 CORS 拒绝，也尚未证明 `https://localhost` 实际请求头是否会被服务端接受。下一步必须使用模拟器信任的 HTTPS 诊断服务，不能通过接受无效证书或放宽 Origin 规则绕过。

## MobileApp 静态映射结果

现有 `packages/mobile` 构建已通过生成脚本装入 HAP，共 355 个文件、约 35 MB。DevEco 的 ArkTS 编译与 `PackageHap` 成功，API 24 模拟器启动后显示真正的 MobileApp `SessionAuthGate` 不可达页面，不再显示 PoC 诊断页。这证明入口 HTML、模块脚本、CSS 与动态 bundle 能从 `https://localhost` 静态映射运行。

后续 HAP 已在 API 24 模拟器和 API 24+ 真机连接远程 HTTP Server，完成密码认证、安全存储、主界面、会话切换与聊天产品冒烟。该结果证明正式 MobileApp 路径可用，但没有逐项保留 SSE/WebSocket 握手日志，因此仍不能替代下列精确传输矩阵证据。

## 退出门槛

在 API 24 模拟器和 API 24+ 真机分别记录以下证据后，才能确定最终 Origin：

1. MobileApp 中记录页面 URL、`window.location.origin`，并验证非白名单页面不能调用 bridge。
2. 受控 HTTPS 服务收到的精确 `Origin: https://localhost`，且 HTTP、preflight、SSE、WebSocket 均通过。
3. 启用 `MixedMode.All` 后，HTTPS 页面访问支持的 LAN HTTP 服务时，fetch/SSE/WebSocket 的成功或阻止行为及其用户可见错误语义。
4. 非白名单页面不能调用 bridge。

任一项失败时，保持 Sprint 0，记录失败并重新选择候选；不要让 Native HTTP 的成功伪装为 ArkWeb 的运行时传输成功。
