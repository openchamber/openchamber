# OpenChamber — Tổng hợp kiến thức phân tích repo

> **Ngày tạo:** 20/02/2026  
> **Nguồn:** Phân tích trực tiếp từ repo [btriapitsyn/openchamber](https://github.com/btriapitsyn/openchamber)  
> **Version phân tích:** v1.7.2

---

## Mục lục

1. [OpenChamber là gì?](#1-openchamber-là-gì)
2. [Kiến trúc tổng thể](#2-kiến-trúc-tổng-thể)
3. [Luồng hoạt động chat với AI](#3-luồng-hoạt-động-chat-với-ai)
4. [Tính năng kỹ thuật nổi bật](#4-tính-năng-kỹ-thuật-nổi-bật)
5. [Cách cài đặt & sử dụng](#5-cách-cài-đặt--sử-dụng)
6. [Logic load session cũ](#6-logic-load-session-cũ)
7. [State Management](#7-state-management)
8. [So sánh với các tool khác](#8-so-sánh-với-các-tool-khác)

---

## 1. OpenChamber là gì?

OpenChamber là **GUI wrapper fan-made** cho [OpenCode](https://github.com/opencode-ai/opencode) — AI coding agent chạy trên terminal. Đây **không phải** sản phẩm official của OpenCode team.

### Điểm đặc biệt

| Đặc điểm | Chi tiết |
|-----------|----------|
| **Nguồn gốc** | Fan-made, không official |
| **Cách build** | Toàn bộ dự án được viết bằng chính AI coding agents |
| **Mục đích** | Cung cấp UI đẹp cho OpenCode thay vì dùng terminal thuần |
| **Platforms** | Web/PWA · Desktop (macOS/Tauri) · VS Code Extension |
| **Version** | 1.7.2 (tại thời điểm phân tích) |
| **Repo** | https://github.com/btriapitsyn/openchamber |

### 3 Platforms

```
┌─────────────────────────────────────────────────────┐
│                   OpenChamber                       │
├──────────────┬──────────────────┬───────────────────┤
│  Web / PWA   │ Desktop (macOS)  │  VS Code Extension│
│              │                  │                   │
│ Browser-based│ Tauri v2 shell   │ Webview embedded  │
│ Mobile OK    │ Load web local   │ Side panel        │
│ PWA install  │ Native menus     │ Editor integration│
└──────────────┴──────────────────┴───────────────────┘
```

---

## 2. Kiến trúc tổng thể

### Monorepo structure

```
openchamber/
├── packages/
│   ├── ui/          # Shared React components, stores, hooks
│   ├── web/         # Web app + Express server + CLI
│   │   ├── src/     # Frontend Vite/React
│   │   ├── server/  # Express server (mini-application)
│   │   └── bin/     # CLI entrypoint
│   ├── desktop/     # Tauri v2 shell (macOS)
│   │   └── src-tauri/
│   └── vscode/      # VS Code extension + webview
├── CLAUDE.md
└── CHANGELOG.md
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime/Tooling** | Bun · Node >=20 |
| **UI Framework** | React 19 · TypeScript · Vite 7 |
| **Styling** | Tailwind v4 |
| **State** | Zustand (31 stores) |
| **UI Primitives** | Radix UI · HeroUI · Remixicon |
| **Server** | Express.js |
| **Desktop** | Tauri v2 (Rust shell) |
| **AI Integration** | `@opencode-ai/sdk` via HTTP + SSE |

### Kiến trúc quan trọng cần hiểu

> ⚠️ **Desktop KHÔNG phải là backend riêng.** Desktop chỉ là Tauri shell mỏng:
> - Spawn web server sidecar
> - Load web UI từ `http://127.0.0.1:<port>`
> - Tauri chỉ dùng cho: native menu, dialog (open folder), notifications, updater, deep-links

> ⚠️ **`packages/web/server/index.js` là mini-application**, không chỉ là proxy:
> - Khởi động/quản lý OpenCode process
> - Cung cấp filesystem API (`/api/fs/*`)
> - Terminal PTY (`bun-pty`/`node-pty`)
> - Git operations (`simple-git`)
> - Skills catalog
> - Cloudflare Tunnel integration

---

## 3. Luồng hoạt động chat với AI

### Happy path (toàn bộ pipeline)

```
User nhập message
      │
      ▼
ChatInput (UI component)
      │
      ▼
sessionStore.sendMessage()          ← Zustand store (Facade)
      │
      ├─ Optimistic update UI ngay   ← Hiện message ngay ko cần đợi
      │
      ▼
HTTP POST → Express Server (/api/chat)
      │
      ▼
OpenCode Server (local process)
      │
      ▼
SSE Stream response
      │
      ▼
useEventStream.ts                   ← Custom hook
      │  batch 50ms window
      ▼
messageStore.update()               ← Zustand store
      │
      ▼
React re-render                     ← UI cập nhật
```

### Chi tiết các bước

| Bước | File | Mô tả |
|------|------|-------|
| Input capture | `packages/ui/src/components/chat/ChatInput.tsx` | Nhận input user |
| Store facade | `packages/ui/src/stores/sessionStore.ts` | Điều phối logic |
| HTTP proxy | `packages/web/server/index.js` | Chuyển tiếp đến OpenCode |
| SSE processing | `packages/ui/src/hooks/useEventStream.ts` | Parse + batch SSE events |
| Message state | `packages/ui/src/stores/messageStore.ts` | Lưu messages |
| AI SDK | `packages/ui/src/lib/opencode/client.ts` | Wrap `@opencode-ai/sdk` |

---

## 4. Tính năng kỹ thuật nổi bật

### 🔥 7 tính năng "wow factor"

#### 1. Message Queue + Persist (localStorage)

```
Khi mất kết nối → messages được queue
Kết nối lại → tự động retry queue
localStorage → persist queue across refresh
```

Đảm bảo không mất message khi network flaky.

#### 2. Custom Fuzzy Search (gitignore-aware)

- **Tự viết** fuzzy search, không dùng thư viện ngoài
- Đọc `.gitignore` patterns để skip files không liên quan
- Search trong file tree của project
- Tốt hơn naive search vì biết context của dev workspace

#### 3. Session Attention State per-clientId

```
clientId A (tab 1) → session active   → full memory window
clientId B (mobile) → session passive → reduced memory
```

Mỗi client (tab/device) có attention state riêng. Cho phép multi-device mà không conflict.

#### 4. WebPush Notifications (OS-level)

- Push notification thực sự đến OS (không phải browser alert)
- Hữu ích khi AI xử lý task dài → notify khi done
- Hoạt động ngay cả khi tab background/minimized

#### 5. Memory Windowing

```
Active session:     giữ 100 messages trong memory
Background session: giữ 30 messages trong memory
Overflow:           lazy load từ server khi scroll up
```

Tránh memory leak khi có nhiều sessions mở cùng lúc.

#### 6. Cloudflare Tunnel (zero config + QR code)

```bash
# Tự động khi start:
openchamber --tunnel

# Output:
✓ Tunnel active: https://random-name.trycloudflare.com
[QR CODE ở đây]  ← Scan từ phone để truy cập ngay
```

Không cần cấu hình gì, không cần tài khoản Cloudflare. Dùng free tunnel của CF.

#### 7. Settings Migration Chain

```
v1.0 config → migrator_1_to_2() → v2.0 config
                                        │
                                        ▼
                               migrator_2_to_3() → v3.0 config
```

Settings tự động upgrade khi update app. Không bao giờ mất config của user.

---

## 5. Cách cài đặt & sử dụng

### Yêu cầu

- [OpenCode CLI](https://github.com/opencode-ai/opencode) đã cài và configured
- Node.js >= 20
- Bun (recommended) hoặc npm/pnpm

### Cài đặt

```bash
# Cài global
bun add -g @openchamber/web

# Hoặc dùng npx (không cần cài)
npx @openchamber/web
```

### Sử dụng

```bash
# Khởi động (foreground)
openchamber

# Khởi động với port custom + daemon mode
openchamber --port 23412 --daemon

# Khởi động với Cloudflare tunnel
openchamber --tunnel

# Dừng daemon
openchamber stop

# Xem status
openchamber status
```

### Entry points

| Runtime | Entry point |
|---------|------------|
| Web frontend | `packages/web/src/main.tsx` |
| Express server | `packages/web/server/index.js` |
| CLI | `packages/web/bin/cli.js` |
| Desktop (Tauri) | `packages/desktop/src-tauri/src/main.rs` |
| VS Code extension | `packages/vscode/src/extension.ts` |
| VS Code webview | `packages/vscode/webview/main.tsx` |

---

## 6. Logic load session cũ

### 3 cơ chế lưu trữ (theo priority)

```
┌─────────────────────────────────────────────────────┐
│  Priority 1: Server Disk (Ground Truth)             │
│  → OpenCode lưu sessions trên filesystem            │
│  → Fetch qua /api/sessions khi app load             │
│  → Đây là source of truth                           │
├─────────────────────────────────────────────────────┤
│  Priority 2: localStorage "session-store"           │
│  → Cache danh sách sessions (metadata only)         │
│  → Hiện ngay khi load (trước khi server respond)    │
│  → Optimistic display, sau đó sync với server       │
├─────────────────────────────────────────────────────┤
│  Priority 3: localStorage "oc.sessionSelByDirectory"│
│  → Map: directory path → last selected sessionId    │
│  → Restore: "user đang làm gì ở project này?"       │
│  → Mỗi project nhớ session riêng                    │
└─────────────────────────────────────────────────────┘
```

### Messages — hoàn toàn lazy

> ⚠️ **Messages KHÔNG được persist** trong localStorage.

```
Switch session:
  1. messageStore.clear()         ← Xóa messages cũ
  2. Hiện loading skeleton
  3. Fetch /api/messages/:sessionId
  4. Trim xuống còn 100 (active) hoặc 30 (background)
  5. Render

Scroll up đến top:
  → Trigger load thêm messages cũ (virtual scroll)
```

**Lý do không persist messages:** Messages có thể rất lớn (code diffs, long responses). Persist chúng vào localStorage sẽ hit storage limit và làm chậm app.

---

## 7. State Management

### Zustand — 31 stores

```
packages/ui/src/stores/
├── sessionStore.ts       ← FACADE store (quan trọng nhất)
├── messageStore.ts       ← Messages của active session
├── fileStore.ts          ← File tree, fuzzy search
├── settingsStore.ts      ← User preferences + migration
├── notificationStore.ts  ← WebPush state
├── terminalStore.ts      ← Terminal sessions
└── ... (25 stores khác)
```

### useSessionStore — Facade Pattern

```typescript
// sessionStore KHÔNG tự quản lý state
// Nó là Facade: điều phối các stores khác

sessionStore.sendMessage() → {
  messageStore.addOptimistic()   // Thêm vào UI ngay
  apiClient.send()               // Gọi server
  // SSE response → messageStore.update()
}

sessionStore.switchSession() → {
  messageStore.clear()           // Xóa messages cũ
  fileStore.reset()              // Reset file context
  messageStore.loadFor(newId)    // Load messages mới
}
```

### Key patterns

| Pattern | Mô tả |
|---------|-------|
| **Optimistic UI** | Update UI trước khi server confirm |
| **Batch SSE (50ms)** | Gom nhiều SSE events thành 1 render |
| **Memory windowing** | Giới hạn messages trong memory |
| **Lazy loading** | Load data chỉ khi cần |
| **Persist selective** | Chỉ persist metadata, không persist content |

---

## 8. So sánh với các tool khác

### OpenChamber vs Competitors

| Tính năng | OpenChamber | Claude.ai | Cursor | OpenCode CLI |
|-----------|:-----------:|:---------:|:------:|:------------:|
| Mobile access | ✅ | ✅ | ❌ | ❌ |
| Cross-device session | ✅ | ✅ | ❌ | ❌ |
| Remote access (CF Tunnel) | ✅ | N/A | ❌ | ❌ |
| Persistent message queue | ✅ | ✅ | ❌ | ❌ |
| Push notifications | ✅ | ❌ | ❌ | ❌ |
| Local file access | ✅ | ❌ | ✅ | ✅ |
| Self-hosted | ✅ | ❌ | ❌ | ✅ |
| VS Code integration | ✅ | ❌ | ✅ | ❌ |
| Terminal PTY | ✅ | ❌ | ✅ | ✅ |
| Git integration | ✅ | ❌ | ✅ | ✅ |

### OpenChamber thắng độc quyền

> OpenChamber là **tool duy nhất** cung cấp đồng thời:
> 1. **Mobile access** qua browser (PWA)
> 2. **Cross-device session** (phone + laptop cùng 1 session)
> 3. **Remote access** không cần port forward (Cloudflare Tunnel)
> 4. **Persistent message queue** khi mất mạng
> 5. **OS-level push notifications** khi AI xong task

Đây là lý do tồn tại của OpenChamber: làm OpenCode trở nên accessible trên mọi device, không chỉ terminal.

---

## Ghi chú bổ sung

### Build commands

```bash
# Type check
bun run type-check

# Lint
bun run lint

# Build tất cả
bun run build

# Build desktop
bun run desktop:build

# Build VS Code extension
bun run vscode:build
```

### Connect tới OpenCode instance có sẵn

```bash
# Skip auto-start, connect tới external instance
OPENCODE_PORT=3000 OPENCODE_SKIP_START=true openchamber
```

### Key files để đọc khi debug

| Vấn đề | File cần đọc |
|--------|-------------|
| Chat không hoạt động | `packages/ui/src/hooks/useEventStream.ts` |
| Session không load | `packages/ui/src/stores/sessionStore.ts` |
| Server error | `packages/web/server/index.js` |
| Settings bị reset | `packages/ui/src/stores/settingsStore.ts` |
| Desktop crash | `packages/desktop/src-tauri/src/main.rs` |
| AI client error | `packages/ui/src/lib/opencode/client.ts` |

---

*Tài liệu này được tạo từ phân tích repo tại commit `v1.7.2`. Cập nhật lần cuối: 20/02/2026.*
