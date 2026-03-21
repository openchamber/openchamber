# So sánh: OpenWork vs OpenChamber

> **Ngày cập nhật:** 13/03/2026
> **Nguồn:** Phân tích trực tiếp từ cả hai repo
> - OpenWork: `different-ai/openwork` (v0.11.142)
> - OpenChamber: `btriapitsyn/openchamber` (v1.8.5)
> *(So sánh lần trước: 20/02/2026 — OpenWork v0.11.99 · OpenChamber v1.7.2)*

---

## TL;DR

|                | OpenWork                                        | OpenChamber                         |
| -------------- | ----------------------------------------------- | ----------------------------------- |
| **Tác giả**    | different-ai (commercial, có team)              | btriapitsyn (fan-made, community)   |
| **Status**     | Active — v0.11.142, đang mở rộng cloud          | Active — v1.8.5, tốc độ ship cực cao |
| **Mục tiêu**   | "OpenCode cho mọi người" (Susan in accounting)  | "OpenCode trên mọi device"          |
| **Philosophy** | Thin layer — dùng tối đa OpenCode primitives    | Full-featured — tự build nhiều thứ  |
| **Approach**   | Safety-first, non-tech users, cloud workers     | Feature-rich, developer-focused, community-driven |

---

## Thay đổi từ lần so sánh trước (20/02 → 13/03/2026)

### OpenWork: v0.11.99 → v0.11.142 — Hướng Cloud & Den Workers

**Chiến lược lớn nhất:** OpenWork đang xây dựng **Den cloud workers** — một runtime mới chạy trên cloud của họ. User có thể "Add worker → Connect remote" thay vì tự host. Đây là bước chuyển từ pure self-hosted sang SaaS hybrid.

Điểm nổi bật:
- **Den Worker Runtime**: worker có thể chạy trên OpenWork Cloud, không cần máy local
- **Google Auth cho Den signup**: onboarding cloud được streamline
- **Share bundles as workers**: `openwork-share` replatform thành worker packager — skills/bundles có thể share dưới dạng workers
- **MCP auth flows**: stabilize kết nối MCP authentication
- **Debug report export**: xuất báo cáo diagnostic từ settings
- **Virtualized message rendering**: hiệu năng scroll trong long sessions
- **Oversized markdown collapse**: tự collapse markdown block lớn theo mặc định
- **Loại bỏ Soul Mode**: `refactor(app): remove soul mode surfaces` — simplify product surface
- **Revert "unified status bar indicator"**: một số thay đổi UI bị revert — thấy sự cẩn trọng về UX

### OpenChamber: v1.7.2 → v1.8.5 — Bùng nổ tính năng UI/UX

**Tốc độ shipping ấn tượng:** 21 ngày, 30+ tính năng lớn, community contributors đông đảo.

Điểm nổi bật nhất:
- **Workspace Shell Redesign** (v1.6.9): context panel + tabbed sidebars — thay đổi lớn về UX layout
- **Session Folders + Drag DnD** (v1.7.3–1.7.4): tổ chức sessions theo folder, drag-to-folder
- **MCP Config Manager UI** (v1.7.4): quản lý MCP configs trực tiếp từ UI
- **Docker Deployment** (v1.8.0): self-hosted qua Docker dễ hơn
- **SSH Remote Instances** (v1.8.0): kết nối SSH từ desktop
- **Share as Image** (v1.8.2): export message thành ảnh
- **PWA Pre-install Naming** (v1.8.4): install UX được cải thiện
- **Clickable File References** (v1.8.4): jump từ chat text thẳng vào file
- **Worktrees streamlined** (v1.7.4–1.8.4): upstream-first worktree flow
- **NanoGPT + Ollama Cloud + MiniMax quota providers**: mở rộng quota tracking
- **Mobile DnD project editing** (v1.8.4): long-press + drag-to-reorder trên mobile
- **Favorite model cycling shortcuts**: keyboard shortcut để cycle starred models
- **Active-project session search** (v1.8.4): tìm session theo project trong sidebar
- **VS Code**: diff view với line focus, clickable file refs
- **Nav Rail expand/collapse** (v1.8.0): toggle project rail với names

---

## Kiến trúc

|                   | OpenWork                                  | OpenChamber                                    |
| ----------------- | ----------------------------------------- | ---------------------------------------------- |
| **UI Framework**  | SolidJS + TailwindCSS                     | React 19 + Tailwind v4                         |
| **State**         | Solid stores + IndexedDB                  | Zustand (multi-store, Facade pattern)          |
| **Desktop shell** | Tauri 2.x                                 | Tauri 2.x (macOS + Windows)                   |
| **Backend**       | `packages/server` (binary sidecar)        | `packages/web/server` (Express.js, mini-app)   |
| **OpenCode SDK**  | `@opencode-ai/sdk/v2` (official, v2)      | `@opencode-ai/sdk/v2` (HTTP + SSE)             |
| **Platforms**     | Desktop · Mobile (client) · Den Cloud     | Web/PWA · Desktop · VS Code · Docker          |
| **Tooling**       | pnpm + Rust (Cargo)                       | Bun · Node >=20                                |
| **Cloud runtime** | Den Workers (hosted)                      | Self-hosted only (Cloudflare Tunnel for remote) |

---

## Model tiếp cận Mobile

Đây là điểm khác biệt lớn nhất về kiến trúc:

### OpenWork — Host/Client split + Den Cloud

```
Host (laptop/desktop) — Mode A
  └── chạy OpenCode engine locally
  └── expose port qua LAN hoặc tunnel

Client (phone/tablet) — Mode B
  └── kết nối remote qua QR code / one-time token
  └── remote controller — không cần engine trên device

Den Cloud Worker — Mode C (mới)
  └── user sign in OpenWork Cloud
  └── launch worker trên cloud
  └── connect từ app: Add worker → Connect remote
```

- Mobile là "remote controller", UI native (Tauri)
- Pairing qua QR + secure transport
- Engine không cần chạy trên mobile device
- **Mới**: Den Cloud Workers — không cần máy host, engine chạy trên cloud của OpenWork

### OpenChamber — Web-first + PWA + Docker

```
Express server (máy host)
  └── quản lý OpenCode process lifecycle
  └── expose HTTP API + SSE

Browser (bất kỳ device nào)
  └── truy cập qua http://host:port (LAN)
  └── hoặc qua Cloudflare Tunnel (HTTPS, public URL)
  └── hoặc SSH Remote Instance (desktop)
  └── hoặc Docker container (self-hosted)
```

- Mobile access qua browser thuần + PWA — không cần cài app
- Cloudflare Tunnel: expose ra internet không cần port forward
- Docker: `docker-compose up` là đủ
- SSH Remote Instances: connect từ desktop tới remote machine

---

## Tính năng so sánh đầy đủ

| Tính năng                              | OpenWork | OpenChamber |
| -------------------------------------- | :------: | :---------: |
| **Mobile access**                      | ✅ (native Tauri) | ✅ (browser/PWA) |
| **VS Code Extension**                  | ❌       | ✅ (diff view + line focus) |
| **Cloudflare Tunnel + QR code**        | ❌       | ✅          |
| **Docker deployment**                  | ❌       | ✅ (v1.8.0+) |
| **SSH Remote Instances**               | ❌       | ✅ (v1.8.0+) |
| **OS-level Push Notifications**        | ❌       | ✅          |
| **Message Queue (offline resilient)**  | ❌       | ✅          |
| **Memory Windowing (bg sessions)**     | ❌       | ✅          |
| **Gitignore-aware fuzzy file search**  | ❌       | ✅          |
| **Per-clientId attention state**       | ❌       | ✅          |
| **Settings Migration Chain**           | ❌       | ✅          |
| **Daemon mode (`--daemon`)**           | ❌       | ✅          |
| **Terminal PTY embedded**              | via OpenCode | ✅ (bun-pty/ghostty) |
| **Git integration UI**                 | via OpenCode | ✅ (simple-git, full PR flow) |
| **Session Folders + DnD**             | ❌       | ✅ (v1.7.3+) |
| **MCP Config Manager UI**              | ❌       | ✅ (v1.7.4+) |
| **Share message as image**             | ❌       | ✅ (v1.8.2+) |
| **Multi-quota providers**              | ❌       | ✅ (NanoGPT, Ollama, MiniMax, etc.) |
| **Mermaid diagram rendering**          | ❌       | ✅ (inline + fullscreen) |
| **Per-session draft persistence**      | ❌       | ✅          |
| **Expandable focus mode input**        | ❌       | ✅          |
| **Voice input + TTS**                  | ❌       | ✅          |
| **Multi-window support (desktop)**     | ❌       | ✅          |
| **Favorite model cycling shortcuts**   | ❌       | ✅ (v1.8.4+) |
| **Active-project session search**      | ❌       | ✅ (v1.8.4+) |
| **Custom themes (18+ built-in)**       | ❌       | ✅          |
| **Structured output tool rendering**   | ❌       | ✅          |
| **Clickable file references in chat**  | ❌       | ✅ (v1.8.4+) |
| **Spell check toggle**                 | ❌       | ✅          |
| **Workspace abstraction**              | ✅       | ❌          |
| **Permission Audit Log**               | ✅       | ❌          |
| **Den Cloud Workers**                  | ✅ (new) | ❌          |
| **Google Auth / Cloud signup**         | ✅ (new) | ❌          |
| **Share bundles as workers**           | ✅ (new) | ❌          |
| **Skills/Plugins/Agents UI**           | ✅       | ✅ (aligned w/ OpenCode API, v1.7.1+) |
| **Artifacts view per run**             | ✅       | ❌          |
| **Cross-device session continuity**    | ✅       | ✅          |
| **Self-hosted**                        | ✅       | ✅          |
| **Local file access**                  | ✅       | ✅          |
| **60fps UI target**                    | ✅       | ✅ (virtualized rendering, rAF batching) |
| **Hot reload (skills/agents)**         | ✅       | partial (manual reload) |
| **Worktrees support**                  | ✅       | ✅ (upstream-first flow, v1.7.4+) |
| **Debug report export**                | ✅ (new) | partial     |
| **MCP auth stabilization**             | ✅ (new) | ✅          |

---

## Philosophy so sánh trực tiếp

### OpenWork — Explicitly thin layer, cloud-extending

Từ `VISION.md`:
> "OpenCode is the **engine**. OpenWork is the **experience**: onboarding, safety, permissions, progress, artifacts, and a premium-feeling UI."

Từ `AGENTS.md`:
> "Ejectable: OpenWork is powered by OpenCode, so anything OpenCode can do is available in OpenWork, even before a dedicated UI exists."
> "Prefer OpenCode primitives... before introducing new abstractions."

Chiến lược runtime mới 3 mode:
1. **Desktop-hosted** — local, tự host
2. **CLI-hosted** — `openwork-orchestrator` trên máy trusted
3. **Hosted OpenWork Cloud** — Den Workers, cloud của OpenWork

**Hệ quả**: OpenWork đang tiến hóa từ "desktop app" sang "cloud-ready agentic platform". Thin layer philosophy vẫn giữ, nhưng bổ sung cloud runtime layer.

### OpenChamber — Build what's needed, community-powered

Ngược lại, OpenChamber tiếp tục tự xây mọi thứ nhưng với community đông hơn:
- Custom fuzzy search riêng, gitignore-aware
- Tự quản lý OpenCode process lifecycle (spawn, kill, restart)
- Filesystem API riêng (`/api/fs/*`)
- Terminal PTY riêng (`bun-pty`/ghostty-web)
- Git operations riêng (`simple-git`)
- Docker deployment tự cấu hình
- SSH remote instances tự implement
- Quota tracking cho 10+ providers

**Hệ quả**: Maintenance burden cao hơn, nhưng **community contributors đang gánh một phần** — changelog v1.7.2–v1.8.5 có đóng góp từ chục contributors khác nhau.

---

## Target Users

### OpenWork

- **Bob the IT guy**: power user, setup agents/workflows, chia sẻ với team qua workspaces
- **Susan in accounting**: non-tech, cần UI đơn giản, guided flow, không cần terminal
- **Mobile-first user**: start/monitor tasks từ phone
- **Admin/host**: quản lý shared machine + profiles
- **Den Cloud user** *(mới)*: dùng cloud workers không cần setup local

**KPI**: < 5 phút để chạy task đầu tiên từ fresh install.

### OpenChamber

- **Developers** đang dùng OpenCode CLI, muốn UI đẹp hơn
- **Mobile users** muốn truy cập từ phone mà không cài app
- **Remote workers** cần truy cập từ xa không qua VPN
- **Self-hosters** muốn Docker setup đơn giản *(mới)*
- **Community contributors** muốn tham gia open-source

---

## State Management chi tiết

### OpenWork (SolidJS)

- Solid stores — reactive primitives, không cần selector
- IndexedDB cho persistence
- Scoped async state (tránh global `busy()` deadlock)
- Event-driven từ OpenCode SSE stream

### OpenChamber (Zustand)

- Multi-store, Facade pattern qua `sessionStore`
- `sessionStore.sendMessage()` → orchestrate các stores khác
- Optimistic UI: update trước khi server confirm
- **Batch SSE events via rAF** (v1.7.4+): buffer SSE parts qua `requestAnimationFrame` → ít jank hơn
- Selective persistence: metadata vào localStorage, messages KHÔNG persist (quá lớn)
- Virtualized message rendering cho long sessions (v1.8.0+)

---

## Monorepo structure

### OpenWork

```
openwork/
├── VISION.md
├── ARCHITECTURE.md
├── PRINCIPLES.md
├── PRODUCT.md
├── INFRASTRUCTURE.md
├── DESIGN-LANGUAGE.md    # mới, design system chính thức
├── packages/
│   ├── app/              # SolidJS frontend
│   ├── desktop/          # Tauri 2.x shell (Rust)
│   ├── server/           # OpenWork server (binary sidecar)
│   └── orchestrator/     # npm package (openwork-orchestrator)
```

### OpenChamber

```
openchamber/
├── packages/
│   ├── ui/               # Shared React components + stores + hooks
│   │   └── src/
│   │       ├── components/
│   │       │   ├── chat/
│   │       │   ├── sections/  # Settings sections incl. skills/
│   │       │   └── terminal/
│   │       ├── stores/        # Zustand stores
│   │       └── lib/
│   │           ├── theme/     # Token-based theming, 18+ themes
│   │           └── typography.ts
│   ├── web/              # Web app + Express server + CLI
│   │   ├── src/          # Frontend (Vite/React)
│   │   ├── server/       # Express + lib/ modules
│   │   │   └── lib/      # quota, git, github, opencode, tts, skills-catalog, terminal
│   │   └── bin/          # CLI entrypoint
│   ├── desktop/          # Tauri 2.x shell
│   └── vscode/           # VS Code extension + webview
```

---

## Kết luận: Nên dùng cái nào?

### Chọn OpenChamber nếu:

- Cần truy cập từ browser trên bất kỳ device nào — không muốn cài app
- Cần Cloudflare Tunnel để chia sẻ remote access ngay lập tức
- Cần VS Code integration (side panel, diff view, line targeting)
- Cần Docker deployment đơn giản cho self-hosted setup
- Cần SSH remote instance support
- Mạng flaky — cần message queue resilience
- Cần push notifications khi AI xong task dài
- Developer biết dùng terminal, muốn feature-rich UI
- Muốn tham gia community active với 30+ contributors
- Cần quota tracking cho nhiều provider (NanoGPT, Ollama, MiniMax, etc.)

### Chọn OpenWork nếu:

- Muốn native app experience (60fps, Tauri, SolidJS reactivity)
- Cần permission auditing và safety guardrails rõ ràng
- Cần workspace abstraction để chia sẻ config với team
- Cần cloud workers — không muốn tự host engine (Den Cloud)
- Muốn share skills/bundles dưới dạng workers
- Prefer dự án có team commercial đứng sau (long-term support)
- Target users là non-tech (onboarding guided flow)
- Cần hot-reload config/skills trong active sessions (Living System)

### Nhận xét tổng thể (cập nhật 13/03/2026)

**Khoảng cách về tính năng UX vẫn tiếp tục giãn ra theo hướng có lợi cho OpenChamber.** Trong 21 ngày (20/02 → 13/03), OpenChamber ship ~30 tính năng lớn với community contributors ngày càng đông. OpenWork ship ít hơn về số lượng nhưng có hướng đi chiến lược rõ ràng hơn: **Den Cloud Workers** — chuyển dịch sang SaaS hybrid, không còn pure self-hosted.

**Sự khác biệt về triết lý ngày càng sắc nét:**
- OpenWork: "Thin layer on OpenCode + Cloud Runtime" — ít build custom, leverage OpenCode APIs tối đa, scale qua cloud
- OpenChamber: "Build everything needed + Community power" — nhiều custom code hơn, nhưng community gánh được maintenance

**Rủi ro mới của OpenChamber:** Với Den Cloud, OpenWork đang build moat bằng cloud infrastructure. Nếu Den Workers thành công, OpenWork sẽ có revenue stream + lock-in mà OpenChamber không có. OpenChamber sẽ cần tìm điểm khác biệt ngoài feature parity.

**Rủi ro mới của OpenWork:** Một số revert (unified status bar, session loss fix) cho thấy tốc độ ship đang tạo ra instability. OpenWork vẫn thiếu nhiều UX features mà OpenChamber có (session folders, MCP UI, share as image, voice, etc.).

**Bottom line:** OpenChamber là lựa chọn tốt hơn cho hầu hết developer cần full-featured self-hosted UI ngay bây giờ. OpenWork là cược dài hạn cho ai muốn cloud-native agentic platform với safety-first design.

---

*Tài liệu này được tạo từ phân tích repo tại: OpenWork v0.11.142 · OpenChamber v1.8.5. Cập nhật lần cuối: 13/03/2026. Lần so sánh trước: 20/02/2026 (OpenWork v0.11.99 · OpenChamber v1.7.2).*
