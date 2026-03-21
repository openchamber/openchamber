# Plan: Session Folders — Nhóm Chat Sessions

## Metadata
- Created: 2026-02-20
- Status: ready
- Domain: UI / State Management

---

## Overview

Thêm tính năng **Session Folders** — user tự tạo folder để nhóm các chat session lại cho dễ quản lý. Folder được lưu localStorage theo từng project (scoped per-project). Không cần thay đổi backend hay OpenCode SDK.

**UX sau khi hoàn thành:**
```
📁 Feature Auth (3)          ← folder header, click to collapse
  • OAuth integration
  • JWT refresh
  • Logout flow
📁 Bug Fixes (1)
  • Fix null error in getTotal
📂 Uncategorized             ← sessions không thuộc folder nào
  • Untitled Session
  • Database schema
```

---

## Technical Approach

### Lưu trữ: localStorage (client-only, no backend)

Data model: `Record<projectId, SessionFolder[]>` lưu tại key `oc.sessions.folders`.

```
SessionFolder {
  id: string          // nanoid or crypto.randomUUID()
  name: string        // tên folder do user đặt
  sessionIds: string[] // danh sách session ID trong folder
  createdAt: number
}
```

### Store: `useSessionFoldersStore.ts`

Zustand + devtools, pattern giống `useProjectsStore.ts`. Persist bằng `getSafeStorage()`.

Actions chính:
- `createFolder(projectId, name)` → tạo folder mới
- `renameFolder(projectId, folderId, name)` → đổi tên
- `deleteFolder(projectId, folderId)` → xóa folder (sessions không bị xóa, chỉ ungrouped)
- `addSessionToFolder(projectId, folderId, sessionId)` → chuyển session vào folder (auto remove from current folder)
- `removeSessionFromFolder(projectId, sessionId)` → ungroup session
- `cleanupSessions(projectId, existingSessionIds)` → xóa session IDs không còn tồn tại
- `getFoldersForProject(projectId)` → get folders với collapsed state
- `toggleFolderCollapse(projectId, folderId)`

### Component: `SessionFolderItem.tsx`

Standalone component render một folder:
- Header: folder icon + tên + số session + collapse arrow + action buttons (rename, delete)
- Body: danh sách sessions (render qua callback `renderSessionNode` được pass vào)
- Inline rename (pattern giống existing session/project rename)
- Empty folder state

### Integration: `SessionSidebar.tsx`

4 thay đổi nhỏ, sequential:
1. Import store + init state
2. "Move to folder" submenu trong session context menu (dùng `DropdownMenuSub` đã export sẵn)
3. Render folder section trước "Uncategorized" sessions
4. "New folder" button trong header + cleanup effect

---

## 💡 Tại sao chọn approach này?

### Alternatives đã xem xét

| Option | Không chọn vì |
|--------|---------------|
| **Backend tags/labels** | Cần thay đổi OpenCode SDK, server-side schema — quá phức tạp cho UX đơn giản |
| **Reuse parentID tree** | parentID đã có semantic riêng (sub-sessions), dùng cho folder sẽ confuse data model |
| **Date-based auto groups** | Không flexible, user không tự đặt tên được |
| **Global folder (cross-project)** | Sessions đã scoped by project → folder cross-project gây confusing khi sessions không hiện |

### Trade-offs của approach localStorage

**Ưu điểm:**
- Zero backend change
- Instant persist/restore
- Pattern đã có sẵn trong codebase (`useProjectsStore`, pinned sessions, group order đều dùng localStorage)
- Đơn giản implement

**Nhược điểm:**
- Không sync giữa các máy/browser
- Mất khi clear browser data

### Khi nào nên dùng approach khác?

| Nếu... | Thì dùng... |
|--------|-------------|
| Cần sync cross-device | Backend tags trên session object |
| Sessions có nhiều nhóm cùng lúc | Tag system (nhiều tags/session) |
| Team chia sẻ session folders | Server-side folder với access control |

### Patterns áp dụng

| Pattern | Áp dụng ở đâu | Tại sao |
|---------|---------------|---------|
| Zustand store + devtools | `useSessionFoldersStore.ts` | Consistent với toàn bộ codebase |
| `getSafeStorage()` | Persist folders | Pattern chuẩn của project — handle localStorage failure |
| `DropdownMenuSub` | "Move to folder" menu | Đã export sẵn, consistent UI |
| Callback `renderSessionNode` | `SessionFolderItem` | Reuse logic render session thay vì duplicate |
| Per-project scoping | `Record<projectId, SessionFolder[]>` | Match cách `groupOrderByProject` hoạt động |

---

## Files Affected

### New Files

| File | Purpose |
|------|---------|
| `packages/ui/src/stores/useSessionFoldersStore.ts` | Zustand store quản lý folders |
| `packages/ui/src/components/session/SessionFolderItem.tsx` | Component render folder header + body |

### Modified Files

| File | Thay đổi |
|------|---------|
| `packages/ui/src/components/session/SessionSidebar.tsx` | 4 thay đổi: import store, context menu, render, new folder button |

---

## Task Breakdown

### Phase 1: Foundation
| ID | Task | Files | Estimate | Depends |
|----|------|-------|----------|---------|
| ST-001 | Tạo useSessionFoldersStore với types, CRUD, persistence | useSessionFoldersStore.ts (NEW) | 45m | — |

### Phase 2: UI Component
| ID | Task | Files | Estimate | Depends |
|----|------|-------|----------|---------|
| UI-001 | Tạo SessionFolderItem component | SessionFolderItem.tsx (NEW) | 30m | ST-001 |

### Phase 3: Integration vào SessionSidebar (phải sequential)
| ID | Task | Files | Estimate | Depends |
|----|------|-------|----------|---------|
| SS-001 | Import store + init state vào SessionSidebar | SessionSidebar.tsx | 15m | ST-001 |
| SS-002 | Thêm "Move to folder" submenu trong session context menu | SessionSidebar.tsx | 25m | SS-001 |
| SS-003 | Render folder section trước ungrouped sessions | SessionSidebar.tsx | 30m | UI-001, SS-001 |
| SS-004 | Thêm New Folder button + cleanup effect | SessionSidebar.tsx | 20m | SS-001 |

---

## Execution Order

```
Phase 1 (parallel-safe):
  ST-001

Phase 2 (after ST-001):
  UI-001

Phase 3 (after ST-001 + UI-001, sequential trong Sidebar):
  SS-001 → SS-002 → SS-003 → SS-004
```

> ⚠️ SS-001 → SS-004 đều sửa `SessionSidebar.tsx` — phải thực hiện TUẦN TỰ, không parallel.

---

## Summary

| Metric | Value |
|--------|-------|
| Total tasks | 6 |
| Estimated time | ~2h 45m |
| New files | 2 |
| Modified files | 1 |
| Backend changes | None |
| New dependencies | None (dùng @dnd-kit đã có) |

---

## Task Files

- [ST-001](./tasks/ST-001.md) — Store
- [UI-001](./tasks/UI-001.md) — SessionFolderItem component
- [SS-001](./tasks/SS-001.md) — Import + state init
- [SS-002](./tasks/SS-002.md) — Context menu
- [SS-003](./tasks/SS-003.md) — Render folders
- [SS-004](./tasks/SS-004.md) — New folder button + cleanup
