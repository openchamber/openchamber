# Session Labels & Recent Reorder Design

## Summary

Add two features to the OpenChamber session sidebar:

1. **Session color labels** -- predefined colors with user-customizable names, assigned per session for quick visual classification, with sidebar filtering.
2. **Recent section drag-to-reorder** -- manual reordering of sessions within the "Recent"/"Active Now" top section via `@dnd-kit`.

---

## Feature 1: Session Color Labels

### Data Model

```typescript
interface SessionLabel {
  id: string;           // stable unique ID (nanoid, 8 chars)
  color: LabelColorKey; // one of 8 predefined keys
  name: string;         // user-editable display name (default = color name)
}

type LabelColorKey =
  | 'red' | 'orange' | 'yellow' | 'green'
  | 'blue' | 'purple' | 'pink' | 'gray';
```

- 8 predefined colors, each mapped to a CSS variable pair (light/dark theme).
- Each label has a default English name matching the color; user can rename freely.
- A session can have 0 or 1 label (single assignment, no multi-label).

### Store: `useSessionLabelsStore`

New Zustand store at `packages/ui/src/stores/useSessionLabelsStore.ts`.

```typescript
interface SessionLabelsState {
  // Label definitions (initialized with 8 defaults on first load)
  labels: SessionLabel[];

  // Session -> label assignment
  sessionLabelMap: Record<string, string>; // sessionId -> labelId

  // Active filter state
  activeFilterLabelIds: Set<string>;

  // Actions
  renameLabel(labelId: string, name: string): void;
  assignLabel(sessionId: string, labelId: string): void;
  removeLabel(sessionId: string): void;
  toggleFilter(labelId: string): void;
  clearFilters(): void;
}
```

**Persistence:** localStorage key `oc.session-labels`. Serialize `labels` + `sessionLabelMap`. `activeFilterLabelIds` is ephemeral (resets on page load).

**Scope rule:** Labels are global and follow the session, not the group or project. Moving a session between worktrees/projects does not affect its label assignment.

### UI: Session Row Color Dot

**Location:** Left edge of `SessionNodeItem`, before the session title.

**Behavior:**
- **No label assigned:** On hover, show a faint gray circle (click affordance).
- **Label assigned:** Always show a filled circle in the label's color.
- **Click:** Opens a popover (anchored to the dot) with the label picker.

### UI: Label Picker Popover (`SessionLabelPopover.tsx`)

New component at `packages/ui/src/components/session/sidebar/SessionLabelPopover.tsx`.

**Contents:**
- Grid or vertical list of all 8 labels: colored circle + name.
- Currently assigned label has a checkmark or highlight.
- Click a label to assign; click the already-assigned label to remove.
- Bottom row: "Manage labels" link -> navigates to Settings labels section.

**Positioning:** Use Base UI popover (consistent with existing sidebar popovers).

### UI: Label Filter

**Location:** Sidebar header area, below or beside the search input.

**Appearance:**
- A row of small colored circles representing labels that are currently in use (i.e., at least one session has this label).
- Unused labels are hidden to save space.
- Active filters have a ring/highlight; inactive are plain.

**Behavior:**
- Click a circle to toggle that label filter ON/OFF.
- Multiple labels can be active (OR logic: show sessions with ANY of the selected labels).
- When filters are active, session lists in all groups only show matching sessions; non-matching sessions are hidden.
- A small "clear" affordance appears when any filter is active.

**Implementation:** Filtering is applied in `useSessionGrouping.ts` (or a wrapper hook) by checking `activeFilterLabelIds` against `sessionLabelMap` before building the grouped tree.

### Settings: Label Management Section

**Location:** Settings view, new section "Labels" (or localized equivalent).

**Contents:**
- List of 8 label rows, each showing: color swatch + editable name input.
- Inline edit: click name to edit, blur/enter to save (calls `renameLabel`).
- No delete action (colors are predefined and permanent).
- Reset button per label to restore default name.

### Theme Integration

Add 8 label color CSS variable pairs to the theme system:

```css
/* Light */
--label-red: ...;
--label-orange: ...;
/* etc. */

/* Dark */
--label-red: ...;
--label-orange: ...;
/* etc. */
```

The exact values should be chosen to be visible against both sidebar backgrounds and consistent with the existing project color palette (reference `useProjectsStore` color choices).

---

## Feature 2: Recent Section Drag-to-Reorder

### Scope

Only the "Recent" / "Active Now" section at the top of the sidebar. Other groups (project root, worktrees, archived) keep their existing sort (pinned + updatedAt).

### Store: `useRecentOrderStore`

New Zustand store at `packages/ui/src/stores/useRecentOrderStore.ts`.

```typescript
interface RecentOrderState {
  // Ordered list of session IDs that have been manually positioned.
  manualOrder: string[];

  // Actions
  reorder(activeId: string, overId: string): void; // move activeId before/after overId
  removeSession(sessionId: string): void;          // cleanup on archive/delete
}
```

**Persistence:** localStorage key `oc.recent-order`.

### Ordering Logic

The Recent section currently shows sessions sorted by `updatedAt` descending.

New logic:
1. Sessions in `manualOrder` appear first, in their stored order.
2. Sessions NOT in `manualOrder` appear after, sorted by `updatedAt` descending (original behavior).
3. When a session is dragged, it enters `manualOrder` at its new position.
4. When a session is archived or deleted, it is removed from `manualOrder`.

This means:
- A freshly created session appears below any manually ordered ones (natural time sort).
- Once manually moved, it stays where the user put it until explicitly removed.

### DnD Implementation

**Location:** `SidebarActivitySections.tsx` (or a new wrapper around its session list).

**Approach:**
- Wrap the Recent session list in a `DndContext` + `SortableContext` from `@dnd-kit/sortable`.
- Each session row in the Recent section uses `useSortable`.
- On `onDragEnd`, call `useRecentOrderStore.reorder(activeId, overId)`.
- Use existing sidebar DnD styling patterns (drag overlay, placeholder).

**Conflict with session-to-folder DnD:** The Recent section currently participates in `SessionFolderDndScope`. Nesting a sortable DnD inside the folder DnD requires careful scope isolation. Strategy:
- The sortable DnD only activates on vertical drag within the Recent section.
- Horizontal drag (or drag outside the section boundary) remains handled by the folder DnD scope.
- Use `@dnd-kit` collision detection + activation constraints to separate the two intents.

---

## File Change Map

| Area | Action | File |
|------|--------|------|
| Store | NEW | `packages/ui/src/stores/useSessionLabelsStore.ts` |
| Store | NEW | `packages/ui/src/stores/useRecentOrderStore.ts` |
| Component | NEW | `packages/ui/src/components/session/sidebar/SessionLabelPopover.tsx` |
| Component | NEW | `packages/ui/src/components/session/sidebar/LabelFilter.tsx` |
| Component | MODIFY | `packages/ui/src/components/session/sidebar/SessionNodeItem.tsx` (add color dot) |
| Component | MODIFY | `packages/ui/src/components/session/sidebar/SidebarActivitySections.tsx` (add DnD) |
| Component | MODIFY | `packages/ui/src/components/session/sidebar/SidebarHeader.tsx` (add filter row) |
| Hook | MODIFY | `packages/ui/src/components/session/sidebar/hooks/useSessionGrouping.ts` (label filter) |
| Hook | MODIFY | `packages/ui/src/components/session/sidebar/activitySections.ts` (manual order merge) |
| Settings | NEW | `packages/ui/src/components/sections/labels/LabelsSection.tsx` (or similar) |
| Settings | MODIFY | `packages/ui/src/components/views/SettingsView.tsx` (register new section) |
| Theme | MODIFY | Theme CSS/vars file (add 8 label color variables) |

---

## Performance Considerations

- `useSessionLabelsStore` is low-frequency (user clicks). Safe as a standalone store.
- `activeFilterLabelIds` is ephemeral and only read by the grouping hook (narrow subscriber).
- `useRecentOrderStore` is low-frequency (drag events). Standalone store, not merged into global sessions.
- Color dot rendering in `SessionNodeItem` reads a single value from `sessionLabelMap[sessionId]` via leaf selector -- no broad subscription.
- Label filter in sidebar header subscribes to `activeFilterLabelIds` only (narrow).

---

## Out of Scope (Future)

- Multi-label per session
- Label-based grouping (auto-group sessions by label)
- Server-side persistence of labels (currently localStorage only)
- Label assignment via right-click context menu (can add later alongside popover)
- Drag-to-reorder in non-Recent groups
