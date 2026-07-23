# OpenChamber HarmonyOS

HarmonyOS 6.1.1/API 24+ Phone 客户端的原生壳工程。它是第三方、非官方 OpenChamber 客户端的一部分，直接加载既有 MobileApp，不在 ArkTS 中重写业务 UI。

当前已完成 Sprint 1 最小产品闭环，并已在 API 24 模拟器和 API 24+ 真机完成产品冒烟：`packages/mobile` 的构建产物会被自动复制到 HAP，ArkWeb 在 `https://localhost` 下加载真正的 MobileApp；共享 UI 能识别 `harmony` 原生移动壳并复用现有实例连接、密码登录与 runtime switch 流程；client token 通过受限 ArkWeb bridge 保存到 HarmonyOS Asset Store，连接元数据仍留在 localStorage 且只记录 `hasToken`。远程 HTTP Server 的连接、密码验证、主界面、会话切换、聊天、主题和语言设置均已由用户实测。bridge `0.4.0` 继续使用请求 ID + ArkTS 完成后回调页面的安全存储协议，并新增 Ability 前后台状态回调；安全写失败仍会撤销刚签发的服务端客户端记录。包含 bridge `0.4.0` 的 HAP 已通过真机后台→前台恢复与 re-probe 验收。

## 当前范围

- Stage 模型的最小 HAP 工程，入口模块仅面向 Phone。
- `bun run harmony:build-assets` 复用现有 Mobile 构建，再把 `packages/mobile/dist` 原样生成到 `entry/src/main/resources/rawfile/mobile`；生成目录不提交。
- ArkWeb 入口为 `https://localhost/index.html`。宿主只拦截 `/assets/*` 和根目录静态文件，并从 HAP rawfile 返回；`/api`、`/auth`、`/health` 及其他运行时请求继续交给 ArkWeb 网络栈。
- `poc/*` 和诊断服务仅保留为 Sprint 0 历史证据，不再是应用启动页。
- EntryAbility 使用独立的 PNG 图标和纯黑启动背景，满足 API 24 的启动页资源要求。
- Web 到 ArkTS 暴露平台名、bridge 版本、能力声明、Ability 前后台状态，以及受 key 前缀/长度限制的 token `get/set/remove`；不提供任意方法分发。
- ArkWeb 显式启用 mixed content；正式 MobileApp 根据用户连接、恢复和同步操作使用既有 browser fetch/SSE/WebSocket。Sprint 0 诊断页仅保留为历史证据，不是启动入口，也不代表正式应用默认无网络行为。

当前仍不包含：

- Harmony Native HTTP、扫码、深链、Push、更新器或 Harmony 专属 relay 实现。
- 新的 ArkTS 认证、会话、SSE、WebSocket 或 relay 状态机；这些继续复用既有 TypeScript 实现。
- 服务端 CORS 或 WebSocket Origin allowlist 修改。
- 任何凭据、签名材料、测试账号或用户数据。

## 运行前提

需要 DevEco Studio、HarmonyOS 6.1.1/API 24+ SDK 和 Phone 模拟器或真机。当前开发机已检测到 DevEco Studio 6.1.1、Hvigor 6.24.3、Bun 1.3.14 与 API 24 Phone 系统镜像；DevEco 的 SDK 设置也确认 HarmonyOS 6.1.1 Release 已内置并安装。

HarmonyOS 模式的命令行 Hvigor 通过 `DEVECO_SDK_HOME` 获取 SDK 路径；DevEco 的内置终端会自动提供该环境。独立终端调用尚未继承 IDE 的内置 SDK 发现配置时，可能错误报告 `SDK component missing`；应优先通过 DevEco 的 Build 菜单或 IDE Terminal 运行本工程，不把该诊断误作 SDK 未安装。本机绝对路径不应写入项目配置。

1. 在仓库根目录运行 `bun run harmony:build-assets`，构建并生成 MobileApp 资源。已有最新 `packages/mobile/dist` 时，可只运行 `bun run harmony:prepare-assets`。
2. 在 DevEco Studio 中打开 packages/harmony。
3. 仓库提交的 `build-profile.json5` 不包含签名材料，因此默认可执行 unsigned 构建。真机 Debug 前，在 DevEco Studio 的 Signing Configs 中创建或选择本地签名方案；IDE 会在本地为 `products.default.signingConfig` 写入对应名称。该本地差异以及 `.p12`、`.p7b`、证书和密码不得提交。
4. 真机安装前确认输出目录存在 `entry-default-signed.hap`，而不是只存在 `entry-default-unsigned.hap`；模拟器或静态构建校验可使用 unsigned 产物。
5. 选择 API 24 Phone 模拟器或 API 24+ 真机，执行 Build Hap(s)/APP(s) 并安装。
6. 打开应用。未保存实例时应进入既有 `MobileConnectionWelcome` 原生实例连接页，而不是 Web `SessionAuthGate`。连接 HTTPS 或 LAN HTTP Server 的结果仍必须按当前设备和 Server 配置实测。

### Sprint 0 传输诊断

本仓库提供一个只返回固定诊断数据的测试服务，用于记录 ArkWeb 发出的真实 Origin。它不接收 token、密码、pairing payload 或 OpenChamber 请求，且默认只监听本机回环地址：

```bash
bun run harmony:probe-server
```

如果模拟器无法通过回环地址访问宿主机，可仅在受信任局域网中显式监听所有网卡：

```bash
bun run harmony:probe-server -- --host 0.0.0.0
```

默认允许的精确 Origin 是 `https://localhost`。命令会打印可填写到 PoC 页面的地址；PoC 中只填写该诊断服务地址，点击“开始无凭据诊断”，并保存终端中显示的 Origin 接受/拒绝记录。若验证其他候选 Origin，可用 `--origin <精确 scheme://host>` 修改允许值；绝不使用 `*`。这一步不等同于 OpenChamber Server 已通过，也不允许填写真实 token 或密码。

已完成的 rawfile 基线页面虽然显示 `resource://rawfile`，但受控服务实际收到的 HTTP、preflight、SSE 和 WebSocket 请求均是 `Origin: null`，因此被精确来源校验拒绝。这是预期的安全结果：不要把 `null` 或 `*` 加入任何生产 allowlist。

不要把资源页面显示正常、Native HTTP 可用或单个诊断项成功，当作 runtime fetch、SSE、WebSocket 或 mixed-content 已通过的证据。当前 API 24 结果正是反例：`https://localhost` 候选页的 bridge/回调正常，但访问 LAN HTTP 诊断服务时只有 WebCrypto 通过、服务端没有收到 HTTP/SSE/WebSocket 请求；这应记录为 mixed-content 候选，而非 CORS/Origin 结论。

## 已知网络限制

Harmony 当前没有 Native HTTP fallback。连接探测、密码请求和运行时 API 都使用 ArkWeb browser fetch；LAN HTTP 依赖 `MixedMode.All`，服务器仍必须接受精确的 `Origin: https://localhost`。远程 HTTP Server 已在模拟器和真机完成产品连接验证，但自签名/不受信任 HTTPS 证书、被设备网络策略阻止的 LAN 地址或不接受该 Origin 的服务器仍会按既有“无法连接到服务器”路径失败。

这项限制是刻意保留的：不能用可访问任意 URL 的原生桥绕过浏览器和服务端安全策略，也不能让仅用于连接探测的 Native HTTP 成功掩盖 runtime fetch、SSE 或 WebSocket 失败。若以后有真机失败案例需要原生探测，只允许为 connect probe/password/pairing redeem 定义精确 URL、方法、超时和响应上限；不得替代通用 runtime transport，且不得把 CORS 放宽为 `*` 或 `null`。

## 资源构建

```bash
# 从 packages/web 构建 MobileApp，并生成 Harmony rawfile
bun run harmony:build-assets

# 仅从已有 packages/mobile/dist 重新生成 Harmony rawfile
bun run harmony:prepare-assets
```

准备脚本先完整复制到同级临时目录，再替换现有资源；输入缺少 `index.html` 时不会破坏上一次生成结果。DevEco 不自动调用 Bun，因此每次 MobileApp 变化后必须先运行上述命令再构建 HAP。

## 目录

    packages/harmony/
    ├── AppScope/                          应用标识、全局名称与图标资源
    ├── build-profile.json5                工程级 Hvigor 配置
    ├── hvigor/hvigor-config.json5         Hvigor 执行配置
    ├── entry/
    │   ├── build-profile.json5            Stage 模块配置
    │   ├── src/main/ets/
    │   │   ├── bridge/HarmonyMobileBridge.ets
    │   │   ├── entryability/EntryAbility.ets
    │   │   ├── pages/Index.ets
    │   │   └── runtime/
    │   │       ├── HarmonyLifecycleChannel.ets
    │   │       └── PackagedMobileAssets.ets
    │   └── src/main/resources/rawfile/
    │       ├── mobile/                   生成的 MobileApp 资源（不提交）
    │       └── poc/                      Sprint 0 历史诊断页
    ├── tools/prepare-mobile-assets.mjs   MobileApp → HAP 资源准备
    ├── tools/sprint0-probe-server.mjs    无凭据 Origin/传输诊断服务
    ├── DESIGN.md                          架构与安全边界
    ├── ORIGIN-ADR.md                      Origin 决策与运行时证据
    ├── NATIVE-GATE-INVENTORY.md            Capacitor/native 能力迁移审计
    └── SPRINT0-CHECKLIST.md               真机验证记录

## Bridge 安全边界

Index.ets 只向 `https://localhost` 虚拟页面注册 openChamberHarmony。静态资源是否来自 HAP 由 `PackagedMobileAssets` 的精确 URL 分类决定；`/api`、`/auth` 等请求不会被伪装成静态成功。

桥对象不提供：

- 文件、Shell、任意 ArkTS 调用或反射能力。
- HTTP 请求、pairing secret、密码、剪贴板、日志导出或外部 URI 处理。
- token 枚举、批量读取或任意 key：只接受 `openchamber.mobile.token.` 前缀，且 ArkTS 不记录 key/value 或底层错误。

安全存储调用使用请求 ID 发起；ArkTS 完成异步 Asset Store 操作后，通过固定页面回调返回 `{ ok, value? }` JSON envelope。ArkWeb 的异步代理调用本身不承载返回值；“不存在”和“存储不可用”具有不同结果。生命周期通道只发送 `active: boolean`，不携带 URL、token 或应用状态。任何后续桥方法都必须具备明确的接口契约、调用方 URL 白名单、输入大小/类型限制、超时/错误语义和安全测试。

## 相关文档

- HARMONY-DEVELOPMENT-PLAN.md：完整开发路线与 Sprint 门禁。
- DESIGN.md：当前 PoC 架构、已知限制和后续迁移边界。
- ORIGIN-ADR.md：rawfile 拒绝结论、当前 `https://localhost` 候选和退出门槛。
- NATIVE-GATE-INVENTORY.md：现有 Capacitor 能力的保留、抽象与延后实现边界。
- SPRINT0-CHECKLIST.md：真机环境、Origin、HTTP、SSE、WebSocket 的证据记录。
- 上游移动壳说明：packages/mobile/README.md 与 packages/mobile/HANDOFF.md。
