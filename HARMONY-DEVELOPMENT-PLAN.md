# OpenChamber HarmonyOS 开发计划

> 状态：Sprint 1 产品闭环和 Sprint 2 最小 authoritative resume 已完成；API 24 模拟器及 API 24+ 真机均通过连接、密码登录、安全存储、冷启动恢复、主界面、会话、聊天、主题、语言和后台→前台 re-probe 验收。精确 Origin/SSE/WebSocket 独立诊断矩阵仍作为后续证据门禁保留。
> 生成日期：2026-07-22；最近更新：2026-07-23
> 依据：OpenChamber 非官方 HarmonyOS 客户端开发方案（rev 3）
> 适用范围：HarmonyOS 6.1.1（API 24）及以上、Phone、第三方非官方客户端

## 1. 目标与交付边界

在当前 OpenChamber fork 中新增一个 HarmonyOS 原生薄壳，使用户能够连接其自行部署的 OpenChamber Server，并在手机上继续使用既有的 MobileApp 会话体验。

首个可发布版本必须满足：

- 复用 packages/web 和 packages/ui 的 MobileApp；不以 ArkTS 重写认证、会话、流式消息、WebSocket 或 Terminal 业务逻辑。
- 在 packages/harmony 中实现 ArkWeb 宿主、受限桥接、安全存储和 authoritative lifecycle；网络继续复用既有 browser/shared transport。
- 支持手动 URL、UI password 登录、多个实例、token 持久化、SSE、必要的 WebSocket，以及前后台/网络恢复。
- client token 仅进入 HarmonyOS 安全存储；不得写入 localStorage、日志、错误文案、剪贴板或提交产物。
- pairing 仅实现上游 v2；Sprint 3 才进入深链和扫码，且不阻塞密码登录 MVP。

首期明确不做：

- 在手机上运行 OpenCode、Shell 或 PTY。
- 模拟完整 Capacitor 协议，或伪造 window.Capacitor。
- passkey 作为承诺登录路径、Push Kit、应用市场上架、平板/折叠屏、Private Relay 的兼容性承诺。
- 绕过 TLS 错误、用 Access-Control-Allow-Origin: * 规避跨域问题，或用 Native HTTP 掩盖 ArkWeb 运行时传输失败。

## 2. 当前基线与前置结论

当前仓库与开发方案的核对结果如下。实施必须以实际 fork 的固定提交为准，不能把 rev 3 中的路径和行为当作永远有效的事实。

| 项目 | 当前观察 | 对计划的影响 |
| --- | --- | --- |
| 根工作区与 UI | 根工作区、packages/ui 均为 1.16.2 | 方案基线是 1.13.2 / f9ad0de，Sprint 0 必须完成重新基线核对。 |
| 官方移动包 | packages/mobile 为 1.13.2，且已有完整 Capacitor 移动实现 | Harmony 应复用其构建和业务语义，但不复制 Capacitor 代码。 |
| Harmony 工程 | `packages/harmony` 已加载正式 MobileApp；DevEco Studio 6.1.1 可生成 unsigned/signed HAP，API 24 模拟器和 API 24+ 真机产品冒烟通过。rawfile 外发请求已证实为 `Origin: null` | rawfile 不得作为联网 UI，也不得向 CORS / WebSocket allowlist 加 `null` 或 `*`。正式入口保持 `https://localhost` 静态映射；独立传输矩阵继续作为证据门禁。 |
| 原生适配层 | `packages/ui/src/lib/native-mobile` 是唯一读取 Harmony bridge 的共享边界，已提供 Asset Store 安全存储和生命周期能力 | 不提供任意 invoke；Native HTTP 暂不实现，连接与 runtime transport 继续使用既有 TypeScript 状态机。 |
| 平台识别 | `platform.ts` 已提供 `harmony`、`isHarmonyApp()` 和 `isNativeMobileApp()` | `isCapacitorApp()` 保持 iOS/Android 插件专属语义，Harmony 不伪装 Capacitor。 |
| 原生门控 | 通用原生连接、实例和恢复已迁移；StatusBar、Keyboard、back、扫码、深链和 Push 仍按细粒度能力或 Capacitor 专属路径处理 | 后续能力继续逐项验证，不以一个 native 布尔值整体启用。 |
| Server Origin 规则 | HTTP CORS 的 packaged allowlist 含 http://localhost 与 https://localhost；WebSocket request-security 仅含 https://localhost | 最终 ArkWeb origin 必须同时通过 HTTP、SSE 和 WebSocket，不能只验证 CORS。 |

### 2.1 基线冻结动作

在任何生产代码变更前完成以下记录，并把结果写入后续 README-HARMONY.md：

1. 记录当前 fork 的提交、对应 upstream 提交、packages/ui、packages/web、packages/mobile 版本和 Bun 版本。
2. 对照 rev 3 的源码导航重新核对：平台门控、pairing v2、runtime auth、runtime fetch、relay、HTTP CORS、WebSocket request-security。
3. 输出一份原生门控清单；每个调用点只能归入以下一类：平台类型、任意原生移动端、仅 Capacitor、具体原生能力。当前清单见 `packages/harmony/NATIVE-GATE-INVENTORY.md`。
4. 记录不一致项和处理决定。若当前 upstream 的业务模型已变化，先更新本计划与开发方案，再开始 adapter 迁移。

## 3. 架构决策与不可突破的约束

| 决策 | 实施规则 | 验证标准 |
| --- | --- | --- |
| UI 复用 | ArkWeb 加载本地构建出的 MobileApp；不复制 React 业务组件。 | 应用入口为 mobile.html 转换后的资源，能运行既有连接页与会话页。 |
| 平台识别 | 通过受控 Harmony 桥标识 harmony；isCapacitorApp 对 Harmony 始终为 false。 | getClientPlatform 返回 harmony，iOS/Android 既有分支不变。 |
| 适配边界 | 上层只依赖 NativeMobileAdapter，不直接读取 Harmony 全局对象。 | 原生差异集中在 adapter 与少量平台原语，业务状态机没有 ArkTS 副本。 |
| Origin | 先选择一个可维护的 ArkWeb origin，再实现正式连接流程。 | 同一 origin 下 HTTP、preflight、fetch、SSE、WebSocket 全部通过。 |
| 网络职责 | 原生 HTTP 仅用于连接探测、密码登录和 pairing redeem；运行时 fetch/SSE/WS 仍由 ArkWeb 证明可行。 | HTTPS UI 访问 LAN HTTP Server 的全部浏览器侧传输已实测。 |
| 机密管理 | token 使用 HarmonyOS Asset Store（系统面向密码/token 的受保护资产 API）；写成功后才持久化 metadata 或切换 runtime。 | 避免自管 HUKS 密钥/密文格式；token 不在 localStorage、日志或 crash 文本中。 |
| Relay | 保留现有 TypeScript candidate 与 tunnel 状态机；不在 ArkTS 重写加密隧道。 | WebCrypto 能力不足时 relay-only 给出明确失败，不静默降级。 |

建议的能力边界如下：

| 能力 | Web 侧调用语义 | Harmony 实现范围 | 关键限制 |
| --- | --- | --- | --- |
| HTTP | 连接探测、密码登录、pairing redeem | ArkTS 网络请求桥，含超时、错误归一化和 requestId | 不能替代 runtime fetch、EventSource 或 WebSocket。 |
| 安全存储 | 读取、写入、删除每个实例的 token | HarmonyOS Asset Store 持久化实现 | 写入失败必须阻止 runtime 切换。 |
| 生命周期 | resume、pause、网络恢复、返回键 | UIAbility 事件转换成受控 Web 回调 | 恢复必须复用上游 re-probe，不新增第二套同步状态机。 |
| 原生 Chrome | 键盘、安全区、状态栏 | ArkWeb 与 ArkTS 协同适配 | 不把 iOS/Android 专用 CSS 假定为 Harmony 行为。 |
| 扫码/深链 | pairing v2 或 HTTP(S) URL 输入 | Sprint 3 的可选 Scan Kit 与必做深链 | 只处理白名单 scheme 与长度受限 payload。 |
| 外部链接 | 打开经过验证的 HTTP(S) URL | 系统浏览器跳转 | 禁止任意 URI、文件或命令桥接。 |

## 4. 里程碑与工期估算

以下为单名熟悉 TypeScript、ArkTS 和移动联调的开发者估算，不含 DevEco/账号安装等待、签名申请、应用市场审核或外部 Server 故障排查。Sprint 0 是停止线，不应为了赶工跳过。

| 阶段 | 预计工作量 | 入口条件 | 主要产出 | 退出门槛 |
| --- | ---: | --- | --- | --- |
| Sprint 0：可行性与重基线 | 5–8 人日 | 有 API 24 模拟器、API 24+ 真机、DevEco、可控测试 Server | PoC、origin ADR、能力矩阵、门控清单 | 所有关键浏览器传输通过；否则停止并调整架构。 |
| Sprint 1：薄壳与密码 MVP | 8–12 人日 | Sprint 0 的 origin 和桥接方案已签字 | packages/harmony、adapter、资产流水线、密码登录 | HAP 可安装，安全存 token 后能进入会话。 |
| Sprint 2：稳定性与原生交互 | 6–9 人日 | Sprint 1 E2E 可用 | 生命周期/网络恢复、键盘、安全区、Terminal 验证 | 多实例、恢复和 token 撤销满足验收。 |
| Sprint 3：pairing 与深链 | 5–8 人日 | Sprint 2 稳定，pairing v2 当前契约已复核 | pairing v2、深链、可选扫码 | 冷热启动与错误分支均可恢复。 |
| Sprint 4：发布可维护性 | 5–7 人日 | MVP 和配对增强已通过真机回归 | 品牌、文档、CI、HAP 归档 | 可追溯、可复现、可安全侧载。 |

总计约 29–44 人日。若 Sprint 0 的最终 origin 无法同时满足 Origin 校验和 mixed-content，工期不应继续累计；应重新选择方案或缩小产品承诺。

## 5. 分阶段工作分解

### Sprint 0：可行性门禁与重基线

#### 0.1 环境与构建复现

- 固定并记录 Bun、Node、DevEco Studio、HarmonyOS SDK/API 24、Hvigor 和设备系统版本。
- Bun 1.3.14 已安装；需确保后续非交互构建环境也能解析 Bun。
- 已复现现有 Web 与 Mobile 资源构建，确认 mobile.html 到 mobile dist 的转换成功；正式 Harmony 资源已通过脚本生成并在 API 24 模拟器加载。
- 准备至少三类测试 Server：LAN HTTP、LAN/公网 HTTPS、可观察 Origin 头的受控测试服务。
- 准备测试账号和可撤销的客户端 token；测试数据不得是真实生产 token 或私人会话数据。

#### 0.2 ArkWeb PoC

- 远程 URL 模式只用于确认 ArkWeb 的基础渲染、动态 import、IndexedDB、localStorage、clipboard、color-mix、中文输入和长列表。
- 本地资源模式加载由现有 Mobile 构建产生的 dist，记录 window.location.origin、document URL 和实际 HTTP/WS Origin 头。
- 验证 JavaScriptProxy 双向调用：Web 到 ArkTS 请求、ArkTS 到 Web 回调、并发 requestId、超时、JSON 解析失败和未知方法拒绝。
- 验证 WebCrypto P-256/AES-GCM、EventSource、WebSocket、Terminal 基础显示；这一步只验证能力，不在 ArkTS 重写 relay。

#### 0.3 Origin 与传输矩阵

对每个候选 origin 完成下表，所有结果须来自真机抓包或受控 Server 日志：

| 场景 | 必测项 | 通过定义 |
| --- | --- | --- |
| 初始连接 | Native HTTP health、密码登录、pairing redeem | 状态码、超时和 TLS 错误都能被正确表达。 |
| HTTP CORS | 普通请求与 OPTIONS preflight | 仅最终精确 origin 被允许，绝不使用通配符。 |
| 运行时 fetch | HTTPS UI 到 HTTPS Server；HTTPS UI 到 LAN HTTP Server | 同时验证成功、失败提示和 mixed-content 行为。 |
| SSE | 建连、短期 URL token、断线重连 | 不被 CORS、mixed-content 或代理缓冲破坏。 |
| WebSocket | Upgrade、Origin 校验、短期 URL token、消息收发 | Server request-security 与最终 Origin 一致。 |
| Relay 能力 | P-256、AES-GCM、WebSocket | 可复用既有路径，或 relay-only 明确报不支持。 |

候选顺序为：

1. 优先验证 ArkWeb 是否可稳定把本地资源呈现为精确的 https://localhost。
2. 若不能，则以 ArkWeb 的实际 origin 为准，同时修改 HTTP CORS 与 WebSocket allowlist，并为两者增加测试。
3. 内嵌 loopback server 仅为回退候选；随机 http://localhost 端口并非天然安全或零改动方案。

当前证据：rawfile 外发请求的 `Origin` 为 `null`，已拒绝。正式壳以 `https://localhost/index.html` 和静态 `onInterceptRequest` 映射加载完整 MobileApp。API 24 模拟器已通过 `MixedMode.All` 对远程 HTTP Server 完成 `/health`、CORS、密码校验与 client token 签发；首轮 Asset Store 写入失败，metadata/runtime switch 被正确阻断。修复构建已校正 Asset Store alias/secret 字节限制和访问策略，并增加写失败后的服务端客户端自撤销；重新安装前不能标记安全存储、冷启动恢复、SSE 或 WebSocket 已验收。

#### 0.4 原生门控审计

对 platform.ts、MobileApp.tsx、mobileConnections.ts、mobileQrScan.ts、深链、设备、push、键盘和更新逻辑做全量审计。当前已知风险点包括：

- MobileApp 内部存在本地的 isCapacitorMobileApp 判断与生命周期/Chrome helper。
- mobileConnections 直接导入 Capacitor、CapacitorHttp 和 SecureStorage。
- 多处 UI 以 isCapacitorApp 作为“任意原生移动端”的替代判断。
- 设备平台、push 注册、二维码、深链和输入法分支具有不同的“仅 Capacitor”与“任意原生端”语义。

审计输出必须明确每个调用点的迁移方式：保留 Capacitor 专用、切换到 isNativeMobileApp、改经 adapter，或不适用于 Harmony。

#### Sprint 0 交付物与停止条件

交付物：

- 已冻结的基线记录与差异表。
- origin 决策 ADR，包含真实 origin、对应 Server 改动、mixed-content 结论和回退理由。
- ArkWeb 能力报告、传输矩阵原始证据、原生门控清单。
- 一份小型、可独立运行的 Harmony PoC；它不能成为第二套业务实现。

以下任一项失败即停止 Sprint 1：

- 未选出一个同时通过 HTTP CORS、runtime fetch、SSE 与 WebSocket Origin 校验的 origin。
- 平台差异无法收敛到 adapter 和少数平台原语，必须复制 MobileApp 业务状态机。
- ArkWeb 无法满足必要的本地资源、桥接、流式传输或安全存储前置能力。
- 原生门控清单不完整，无法判断 iOS/Android 回归范围。

### Sprint 1：Harmony 薄壳与密码登录 MVP

#### 1.1 正式工程与资源流水线

- 新增 packages/harmony，并将 ArkTS、资源、构建脚本和发布元数据都收敛在此目录。
- 复用 packages/mobile 的资产准备语义，自动将 mobile dist 复制到 Harmony rawfile 目录；不提交手工编辑后的 minified dist。
- 生成构建元数据：Harmony 客户端版本、OpenChamber 版本、绑定 upstream 提交、构建时间和资源摘要。
- 在根 package.json 中仅添加经过评审的最小脚本；脚本命名、输入输出和失败行为写入 README-HARMONY.md。

#### 1.2 NativeMobileAdapter 与平台迁移

- 新建 packages/ui/src/lib/native-mobile，定义最小接口、注册机制、无原生环境的安全默认行为和 Harmony 桥实现。
- 扩展 ClientPlatform 为 harmony；新增 isHarmonyApp 和 isNativeMobileApp。Harmony 不得使 isCapacitorApp 返回 true。
- 把“任意原生移动端”调用迁移到 isNativeMobileApp；保留 Capacitor 插件、iOS/Android push 和现有 Capacitor 专有行为的明确分支。
- 将 MobileApp 本地的 Capacitor-only helper 逐步改为 adapter 能力检查，而不是把 Harmony 判断散落在组件内。
- 把 mobileConnections 的 HTTP、安全存储、设备平台、恢复等能力收敛到 adapter；连接、认证、candidate 选择和 relay 状态机继续保持在 TypeScript 现有业务层。

#### 1.3 安全与连接 MVP

- 实现桥接白名单。每个请求携带方法名、版本、requestId 和受限 JSON 参数；未知方法、超长 payload、重复完成和超时必须可预测地失败。
- 使用 HUKS 或平台官方受保护存储保存 token；保存连接元数据时只记录 hasToken，不存 token 本身。
- 先安全写入 token，再调用 runtime switch；写入失败时停留在登录界面并提供可重试错误。
- 为每个安装生成稳定 device ID，并把 Harmony 作为设备平台传递；device ID 不与 token 等同处理。
- 在最终 origin 下跑通手动 URL、UI password、health probe、实例持久化、自动连接、会话加载和流式回复。
- 若 Sprint 0 选择了自定义 origin，配套实现 Server CORS 与 WebSocket allowlist 的集中修改和回归测试；绝不只改其中之一。

#### Sprint 1 验收

- 真机可安装 Debug HAP，并加载本地打包的 MobileApp。
- HTTP LAN 和 HTTPS Server 可完成手动 URL + UI password 登录。
- token 仅在安全存储中；清除/删除实例后 token 不可再读取。
- 能查看会话、发送消息、接收 SSE 流式回复，并处理关键审批/问题交互。
- iOS/Android 的类型检查、现有移动连接测试和所触及平台判断不出现回归。

### Sprint 2：生命周期、稳定性与原生交互

- 实现 UIAbility 前后台事件、网络状态变更和返回键，全部通过 adapter 回调进入既有 MobileApp re-probe/恢复流程。
- 验证多实例切换、杀进程重开、active 实例自动连接、Wi-Fi/蜂窝切换、飞行模式恢复和 Server 重启。
- 实现安全区、状态栏、中文输入法和键盘布局；只在能力已证实存在时复用 Capacitor 的 CSS/事件假设。
- 验证 Terminal 的 WebSocket Upgrade、输入、滚动、重连和后台恢复；SSE 正常不代表 Terminal 已通过。
- 处理 token 撤销、删除实例、写入失败和网络短暂不可达：失败不得被伪装为“无实例”或清空其他已保存实例。
- 对长会话、长流、长 Terminal 输出和大列表做真机性能冒烟，记录可接受阈值和回归用例。

#### Sprint 2 验收

- 多实例可独立新增、切换和删除；一台 Server 失败不影响其他实例。
- 冷启动、前后台、网络切换和短暂断网后，可恢复或给出可操作的连接状态。
- token 被撤销后回到登录流程，不进行无限重试。
- 最终 origin 下，runtime fetch、SSE、Terminal WebSocket 在 LAN HTTP/HTTPS 所承诺场景均经过真机验证。
- 中文输入、返回键、状态栏和底部安全区无阻塞性问题。

### Sprint 3：pairing v2、深链与扫码

- 使用上游 connectionPayload 解析与 candidate 语义，只接受 v2 pairing 和裸 HTTP(S) URL。
- 实现 openchamber://connect 深链的冷启动、热启动、去重和错误恢复。
- pairing redeem 成功后先安全持久化 token，再切换 runtime。
- 覆盖过期、已使用、取消、非法 scheme、无效 JSON、超长 payload、无可达 candidate 和 token 写入失败。
- 接入 Scan Kit 前先确认许可、依赖和隐私范围；扫码是增强项，必须保留手工粘贴路径。
- ArkWeb 若缺少 relay 所需能力，只在 relay-only 候选时显示明确不支持，不修改既有 candidate 优先级或信任模型。

#### Sprint 3 验收

- pairing v2 深链在冷启动和热启动均可完成。
- 所有 pairing 错误能回到可重试状态，不泄露 secret 或 token。
- 扫码权限拒绝、取消和识别失败均可恢复到手工输入。

### Sprint 4：发布、文档与长期维护

- 使用独立应用名、图标和 bundleName；保留 MIT LICENSE，并增加 NOTICE-HARMONY.md。
- 增加 README-HARMONY.md：环境锁定、构建、安装、调试、已验证 Server 版本矩阵、origin 决策与已知限制。
- 增加 About/License 页面：非官方声明、上游链接、绑定 upstream 提交和客户端版本。
- 自动化 Web 资源构建、Harmony HAP 构建、单元/类型/lint 检查、产物摘要和归档；签名密钥仅放入受控 CI secret，不写入仓库。
- 形成上游同步流程：同步前重新跑门控检索，合并后重建资源、跑定向测试和真机烟测。
- 应用市场材料、隐私政策、Push Kit、签名发布和商标审查作为独立发布任务，不阻塞侧载 MVP。

## 6. 测试与质量门禁

### 6.1 每次代码变更的最小验证

| 变更类型 | 必做验证 |
| --- | --- |
| platform、adapter、mobileConnections | 相关单元测试；packages/ui type-check 与 lint；iOS/Android 目标分支回归。 |
| Server CORS 或 WebSocket security | packages/web 相关测试；HTTP preflight、SSE、WebSocket 的允许/拒绝用例。 |
| Harmony ArkTS / Bridge | ArkTS 编译、受控桥单测或集成测试、真机 PoC/HAP 冒烟。 |
| 资产构建脚本 | 从干净输入重复构建；确认未手工修改 dist，确认 rawfile 内容可加载。 |
| 新增/删除源文件、导出或入口 | 在相关检查之外运行根 dead-code，并人工审阅其报告。 |
| 文档与发布配置 | 窄范围格式/链接/构建元数据校验。 |

实现期应以 package.json 中实际脚本为准。当前可复用的基础检查包括：

    bun run type-check:ui
    bun run lint:ui
    bun run type-check:mobile
    bun run lint:mobile
    bun run build:web
    bun run --cwd packages/web test

Harmony 工程落地后，再把其 Hvigor/HAP 构建加入对应的 package.json 脚本与 CI。不要在文档里宣称尚未存在的脚本已可执行。

### 6.2 端到端最小测试矩阵

| 分类 | 必测场景 |
| --- | --- |
| 认证 | 正确/错误密码、无密码 Server、正常/撤销/缺失 token、token 存储写失败。 |
| 网络 | LAN HTTP、HTTPS、DNS/超时/TLS 错误、Wi-Fi/蜂窝切换、飞行模式恢复、SSE 空闲超时、WebSocket Upgrade。 |
| pairing | 正常、过期、已使用、取消、非法和超长 v2 payload、direct/relay candidate 组合。 |
| 安全 | token 不出现于 localStorage、hilog、console、崩溃文本；实例删除后安全存储已清理；bridge 拒绝未知方法。 |
| UI | 中文/英文输入、键盘开关、长会话、长消息、Terminal、深链冷热启动、安全区与返回键。 |
| 兼容性 | 既有 iOS/Android 平台识别、连接、存储、生命周期与 push gate 的定向回归。 |

## 7. 风险台账与决策规则

| 风险 | 早期信号 | 处理方式 | 不可接受的捷径 |
| --- | --- | --- | --- |
| ArkWeb origin 不兼容 | local resource 的 Origin 不在 Server allowlist | 选择精确 virtual origin，或同步修改 CORS + WS allowlist 并测试 | 只放开 CORS、允许任意 origin、假设随机 localhost 可用。 |
| HTTPS UI 到 LAN HTTP 被拦截 | Native HTTP 成功而 fetch/SSE/WS 失败 | 优先采用官方 ArkWeb 配置或安全 origin/transport；明确缩小承诺 | 用初始 Native HTTP 成功冒充运行时可用。 |
| 原生门控迁移过广 | 扩展 ClientPlatform 后只有少量编译报错 | 以审计清单驱动逐点迁移，并跑 iOS/Android 定向测试 | 只改 platform.ts 或让 Harmony 伪装 Capacitor。 |
| token 泄露或丢失 | localStorage 回退、日志中含 request payload | Asset Store 失败即阻断 runtime switch；脱敏诊断 | 为“兼容性”将 token 写回 Web 存储。 |
| ArkWeb relay 能力不足 | P-256、AES-GCM 或 WS 不完整 | 集中 capability detection；relay-only 明确失败 | 在 ArkTS 重写 relay 加密/状态机。 |
| upstream 漂移 | 移动端、pairing 或 request-security 变更 | 每次同步重新基线、重跑 Sprint 0 核对项 | 长期维护手工 patch 的 minified dist。 |
| 发布凭据/合规未就绪 | 无独立 bundleName、签名、Notice 或隐私材料 | 将其作为 Sprint 4 的受控发布任务 | 提交签名密钥、使用官方身份或宣称官方支持。 |

## 8. 最终交付清单

- packages/harmony 的 ArkTS 工程、构建脚本、受限桥接和 HAP 产物流程。
- packages/ui/src/lib/native-mobile 的 adapter 边界与 Harmony 实现。
- 集中且有测试覆盖的平台识别、连接、安全存储、生命周期和必要 Server Origin 改动。
- 连接、网络、桥接、pairing 与 iOS/Android 回归测试。
- README-HARMONY.md、NOTICE-HARMONY.md、origin ADR、版本矩阵和侧载说明。
- 可追溯到固定 upstream 提交、资源摘要和客户端版本的可安装 HAP。

下列内容不得作为交付物提交：

- 手工编辑后的 minified dist。
- token、pairing secret、真实测试账号、签名私钥或服务端机密。
- 另一套 ArkTS 认证、会话、SSE、WebSocket、Terminal 或 relay 状态机。

## 9. Definition of Done

在标记 0.1.0 MVP 完成前，必须同时满足：

- [ ] Sprint 0 的 origin ADR 和能力报告均通过，且选择的方案已在 API 24 模拟器验证，并在 MVP 前于 API 24+ 真机复验。
- [x] 本地 MobileApp 资源由自动流水线生成并由 ArkWeb 加载（API 24 模拟器，2026-07-22）。
- [ ] UI password 登录可用于 HTTP LAN 与 HTTPS Server；token 仅安全存储。（远程 HTTP + Asset Store 已通过模拟器，HTTPS/真机待补。）
- [ ] 运行时 fetch、SSE 和必要 WebSocket 在最终 origin 和声明的网络模式下均能工作。
- [ ] 会话浏览、发消息、流式回复、审批/问题交互、多实例和重启后自动连接可用。（会话切换与聊天冒烟已通过模拟器，其余待补。）
- [ ] token 撤销、实例删除、网络恢复和安全存储失败均有正确、可恢复的行为。
- [ ] 中文输入、键盘、安全区、返回键和 Terminal 通过真机测试。
- [ ] iOS/Android 定向回归无已知阻塞问题；Harmony 不影响 Capacitor 路径。
- [ ] 非官方身份、MIT、上游版本、构建方式和已知限制已写入应用与文档。

pairing 增强只有在以下项目完成后才可对外承诺：

- [ ] pairing v2 的深链冷热启动、redeem、错误分支和 token 写入顺序均通过。
- [ ] 扫码不可用、权限拒绝或取消时，手工输入路径仍可完整工作。

## 10. 建议的下一步执行顺序

1. 固定当前 fork 与 upstream 的基线并记录差异。
2. 配置 DevEco/API 24 模拟器、API 24+ 真机和三类测试 Server。
3. 复现 Web/Mobile 资源构建，保存输入输出摘要。
4. 创建最小 ArkWeb PoC，先收集真实 origin 和请求头。
5. 完成 HTTP、fetch、SSE、WebSocket、mixed-content 的真机矩阵。
6. 产出 origin ADR；未通过即暂停，不进入业务代码迁移。
7. 完成所有 Capacitor/native gate 的语义清单。（已完成，见 `packages/harmony/NATIVE-GATE-INVENTORY.md`。）
8. 创建正式 packages/harmony 和自动资源流水线。（已完成静态资源阶段，2026-07-22。）
9. 引入 adapter 并以密码登录 MVP 验证安全存储与 runtime switch。（adapter/安全存储桥/既有连接入口已实现并通过构建，模拟器/真机 E2E 待完成。）
10. 按 Sprint 2、3、4 逐步扩大能力；每个阶段结束后更新 README-HARMONY.md 和版本矩阵。
