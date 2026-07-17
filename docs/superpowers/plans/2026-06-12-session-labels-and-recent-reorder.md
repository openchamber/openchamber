# Session Labels & Recent Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session color labels (predefined colors with custom names, popover assignment, sidebar filtering) and drag-to-reorder for the Recent section.

**Architecture:** Two new Zustand stores (`useSessionLabelsStore`, `useRecentOrderStore`) with localStorage persistence following the existing `useSessionPinnedStore` pattern. Label UI integrates into `SessionNodeItem` (color dot + popover) and `SidebarHeader` (filter row). Recent reorder uses `@dnd-kit/sortable` wrapping the activity section item list. Settings adds a "Labels" page via the existing `SettingsPageSlug` + `OpenChamberSection` registration pattern.

**Tech Stack:** React 19, Zustand 5, `@dnd-kit/sortable` (already installed), Base UI popover, Tailwind v4, existing theme CSS vars (`--syntax-*`, `--status-*`)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| CREATE | `packages/ui/src/stores/useSessionLabelsStore.ts` | Label definitions, session-label map, filter state, persistence |
| CREATE | `packages/ui/src/stores/useRecentOrderStore.ts` | Manual Recent order, persistence |
| CREATE | `packages/ui/src/components/session/sidebar/SessionLabelPopover.tsx` | Popover with label grid for assignment |
| CREATE | `packages/ui/src/components/session/sidebar/LabelFilter.tsx` | Color dot filter row for sidebar header |
| CREATE | `packages/ui/src/components/sections/openchamber/LabelsSettings.tsx` | Settings section for label name management |
| MODIFY | `packages/ui/src/components/session/sidebar/SessionNodeItem.tsx` | Add color dot to session rows |
| MODIFY | `packages/ui/src/components/session/sidebar/SidebarActivitySections.tsx` | Wrap items in DnD sortable context |
| MODIFY | `packages/ui/src/components/session/sidebar/SidebarHeader.tsx` | Render LabelFilter below search |
| MODIFY | `packages/ui/src/components/session/sidebar/hooks/useSessionGrouping.ts` | Apply label filter before grouping |
| MODIFY | `packages/ui/src/components/session/sidebar/activitySections.ts` | Merge manual order into Recent derivation |
| MODIFY | `packages/ui/src/components/sections/openchamber/types.ts` | Add `'labels'` to `OpenChamberSection` |
| MODIFY | `packages/ui/src/components/sections/openchamber/OpenChamberPage.tsx` | Route `'labels'` to `LabelsSettings` |
| MODIFY | `packages/ui/src/components/views/SettingsView.tsx` | Add `'labels'` slug and mapping |
| MODIFY | `packages/ui/src/lib/settings/metadata.ts` | Register `'labels'` page metadata |
| MODIFY | `packages/ui/src/lib/i18n/messages/en.settings.ts` | Add label-related i18n keys |

---

## Task 1: Create `useSessionLabelsStore`

**Files:**
- Create: `packages/ui/src/stores/useSessionLabelsStore.ts`

- [ ] **Step 1: Create the store file with types and defaults**

```typescript
// packages/ui/src/stores/useSessionLabelsStore.ts
import { create } from 'zustand';
import { getSafeStorage } from './utils/safeStorage';

// --- Types ---

export type LabelColorKey =
  | 'red' | 'orange' | 'yellow' | 'green'
  | 'blue' | 'purple' | 'pink' | 'gray';

export interface SessionLabel {
  id: string;
  color: LabelColorKey;
  name: string;
}

// --- Constants ---

const STORAGE_KEY = 'oc.session-labels';

export const LABEL_COLOR_CSS_MAP: Record<LabelColorKey, string> = {
  red: 'var(--status-error)',
  orange: 'var(--syntax-type)',
  yellow: 'var(--status-warning)',
  green: 'var(--status-success)',
  blue: 'var(--primary)',
  purple: 'var(--syntax-keyword)',
  pink: 'var(--syntax-number)',
  gray: 'var(--syntax-comment)',
};

const DEFAULT_LABELS: SessionLabel[] = [
  { id: 'lbl-red', color: 'red', name: 'Red' },
  { id: 'lbl-orange', color: 'orange', name: 'Orange' },
  { id: 'lbl-yellow', color: 'yellow', name: 'Yellow' },
  { id: 'lbl-green', color: 'green', name: 'Green' },
  { id: 'lbl-blue', color: 'blue', name: 'Blue' },
  { id: 'lbl-purple', color: 'purple', name: 'Purple' },
  { id: 'lbl-pink', color: 'pink', name: 'Pink' },
  { id: 'lbl-gray', color: 'gray', name: 'Gray' },
];

// --- Persistence ---

interface PersistedData {
  labels: SessionLabel[];
  sessionLabelMap: Record<string, string>;
}

const safeStorage = getSafeStorage();

function readFromStorage(): PersistedData {
  try {
    const raw = safeStorage.getItem(STORAGE_KEY);
    if (!raw) return { labels: DEFAULT_LABELS, sessionLabelMap: {} };
    const parsed = JSON.parse(raw) as Partial<PersistedData>;
    return {
      labels: Array.isArray(parsed.labels) && parsed.labels.length === 8
        ? parsed.labels
        : DEFAULT_LABELS,
      sessionLabelMap: parsed.sessionLabelMap && typeof parsed.sessionLabelMap === 'object'
        ? parsed.sessionLabelMap
        : {},
    };
  } catch {
    return { labels: DEFAULT_LABELS, sessionLabelMap: {} };
  }
}

function persistToStorage(labels: SessionLabel[], sessionLabelMap: Record<string, string>): void {
  try {
    safeStorage.setItem(STORAGE_KEY, JSON.stringify({ labels, sessionLabelMap }));
  } catch {
    // ignore quota errors
  }
}

// --- Store ---

interface SessionLabelsState {
  labels: SessionLabel[];
  sessionLabelMap: Record<string, string>; // sessionId -> labelId
  activeFilterLabelIds: Set<string>;       // ephemeral filter state
}

interface SessionLabelsActions {
  renameLabel: (labelId: string, name: string) => void;
  assignLabel: (sessionId: string, labelId: string) => void;
  removeLabel: (sessionId: string) => void;
  toggleFilter: (labelId: string) => void;
  clearFilters: () => void;
  resetLabelName: (labelId: string) => void;
}

type SessionLabelsStore = SessionLabelsState & SessionLabelsActions;

const initial = readFromStorage();

export const useSessionLabelsStore = create<SessionLabelsStore>((set, get) => ({
  labels: initial.labels,
  sessionLabelMap: initial.sessionLabelMap,
  activeFilterLabelIds: new Set(),

  renameLabel: (labelId, name) => {
    const { labels, sessionLabelMap } = get();
    const next = labels.map((l) => (l.id === labelId ? { ...l, name } : l));
    set({ labels: next });
    persistToStorage(next, sessionLabelMap);
  },

  assignLabel: (sessionId, labelId) => {
    const { labels, sessionLabelMap } = get();
    const next = { ...sessionLabelMap, [sessionId]: labelId };
    set({ sessionLabelMap: next });
    persistToStorage(labels, next);
  },

  removeLabel: (sessionId) => {
    const { labels, sessionLabelMap } = get();
    const next = { ...sessionLabelMap };
    delete next[sessionId];
    set({ sessionLabelMap: next });
    persistToStorage(labels, next);
  },

  toggleFilter: (labelId) => {
    const { activeFilterLabelIds } = get();
    const next = new Set(activeFilterLabelIds);
    if (next.has(labelId)) {
      next.delete(labelId);
    } else {
      next.add(labelId);
    }
    set({ activeFilterLabelIds: next });
  },

  clearFilters: () => {
    set({ activeFilterLabelIds: new Set() });
  },

  resetLabelName: (labelId) => {
    const { labels, sessionLabelMap } = get();
    const defaultLabel = DEFAULT_LABELS.find((l) => l.id === labelId);
    if (!defaultLabel) return;
    const next = labels.map((l) => (l.id === labelId ? { ...l, name: defaultLabel.name } : l));
    set({ labels: next });
    persistToStorage(next, sessionLabelMap);
  },
}));
```

- [ ] **Step 2: Verify the store compiles**

Run: `bun run type-check:ui`
Expected: PASS (no type errors related to the new file)

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/stores/useSessionLabelsStore.ts
git commit -m "feat: add useSessionLabelsStore with label definitions and persistence"
```

---

## Task 2: Create `useRecentOrderStore`

**Files:**
- Create: `packages/ui/src/stores/useRecentOrderStore.ts`

- [ ] **Step 1: Create the store file**

```typescript
// packages/ui/src/stores/useRecentOrderStore.ts
import { create } from 'zustand';
import { getSafeStorage } from './utils/safeStorage';

const STORAGE_KEY = 'oc.recent-order';
const safeStorage = getSafeStorage();

function readOrder(): string[] {
  try {
    const raw = safeStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function persistOrder(order: string[]): void {
  try {
    safeStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // ignore
  }
}

interface RecentOrderState {
  manualOrder: string[];
}

interface RecentOrderActions {
  reorder: (activeId: string, overId: string) => void;
  removeSession: (sessionId: string) => void;
  ensureInOrder: (sessionId: string) => void;
}

type RecentOrderStore = RecentOrderState & RecentOrderActions;

export const useRecentOrderStore = create<RecentOrderStore>((set, get) => ({
  manualOrder: readOrder(),

  reorder: (activeId, overId) => {
    const { manualOrder } = get();
    const oldIndex = manualOrder.indexOf(activeId);
    const overIndex = manualOrder.indexOf(overId);

    let next: string[];

    if (oldIndex === -1 && overIndex === -1) {
      // Neither in manual order yet -- add both
      next = [activeId, overId];
    } else if (oldIndex === -1) {
      // activeId not in list yet -- insert before overId
      next = [...manualOrder];
      next.splice(overIndex, 0, activeId);
    } else if (overIndex === -1) {
      // overId not in list -- add activeId at end
      next = manualOrder.filter((id) => id !== activeId);
      next.push(activeId);
    } else {
      // Both exist -- move activeId to overId position
      next = [...manualOrder];
      next.splice(oldIndex, 1);
      const newOverIndex = next.indexOf(overId);
      next.splice(newOverIndex, 0, activeId);
    }

    set({ manualOrder: next });
    persistOrder(next);
  },

  removeSession: (sessionId) => {
    const { manualOrder } = get();
    if (!manualOrder.includes(sessionId)) return;
    const next = manualOrder.filter((id) => id !== sessionId);
    set({ manualOrder: next });
    persistOrder(next);
  },

  ensureInOrder: (sessionId) => {
    const { manualOrder } = get();
    if (manualOrder.includes(sessionId)) return;
    const next = [...manualOrder, sessionId];
    set({ manualOrder: next });
    persistOrder(next);
  },
}));
```

- [ ] **Step 2: Verify the store compiles**

Run: `bun run type-check:ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/stores/useRecentOrderStore.ts
git commit -m "feat: add useRecentOrderStore for manual Recent section ordering"
```

---

## Task 3: Add i18n Keys

**Files:**
- Modify: `packages/ui/src/lib/i18n/messages/en.settings.ts`

- [ ] **Step 1: Add label-related translation keys**

Add these entries to the `settingsDict` object in `en.settings.ts`:

```typescript
// Session labels
'settings.labels.title': 'Labels',
'settings.labels.description': 'Customize color labels for organizing sessions.',
'settings.labels.nameLabel': 'Name',
'settings.labels.resetName': 'Reset to default',
'settings.labels.manageLabels': 'Manage labels',
'sidebar.labels.filter.clear': 'Clear filters',
'sidebar.labels.assign': 'Assign label',
'sidebar.labels.remove': 'Remove label',
'sidebar.labels.noLabel': 'No label',
```

- [ ] **Step 2: Verify compilation**

Run: `bun run type-check:ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/lib/i18n/messages/en.settings.ts
git commit -m "feat: add i18n keys for session labels feature"
```

---

## Task 4: Create `SessionLabelPopover`

**Files:**
- Create: `packages/ui/src/components/session/sidebar/SessionLabelPopover.tsx`

- [ ] **Step 1: Create the popover component**

```typescript
// packages/ui/src/components/session/sidebar/SessionLabelPopover.tsx
import React from 'react';
import { Popover } from '@base-ui/react/Popover';
import { cn } from '@/lib/utils';
import { useSessionLabelsStore, LABEL_COLOR_CSS_MAP } from '@/stores/useSessionLabelsStore';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';

interface SessionLabelPopoverProps {
  sessionId: string;
  children: React.ReactElement; // trigger element
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const SessionLabelPopover: React.FC<SessionLabelPopoverProps> = ({
  sessionId,
  children,
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const labels = useSessionLabelsStore((s) => s.labels);
  const currentLabelId = useSessionLabelsStore((s) => s.sessionLabelMap[sessionId]);
  const assignLabel = useSessionLabelsStore((s) => s.assignLabel);
  const removeLabel = useSessionLabelsStore((s) => s.removeLabel);

  const handleSelect = (labelId: string) => {
    if (currentLabelId === labelId) {
      removeLabel(sessionId);
    } else {
      assignLabel(sessionId, labelId);
    }
    onOpenChange(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger render={children} />
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start">
          <Popover.Popup
            className="z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1.5 shadow-md"
          >
            <div className="flex flex-col gap-0.5">
              {labels.map((label) => (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => handleSelect(label.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-muted',
                    currentLabelId === label.id && 'bg-muted/60'
                  )}
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: LABEL_COLOR_CSS_MAP[label.color] }}
                  />
                  <span className="flex-1 truncate text-left">{label.name}</span>
                  {currentLabelId === label.id && (
                    <Icon name="check-line" className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
              ))}
              {currentLabelId && (
                <>
                  <div className="my-1 border-t border-border/40" />
                  <button
                    type="button"
                    onClick={() => { removeLabel(sessionId); onOpenChange(false); }}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
                  >
                    <Icon name="close-line" className="h-3.5 w-3.5" />
                    <span>{t('sidebar.labels.remove')}</span>
                  </button>
                </>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
```

- [ ] **Step 2: Verify compilation**

Run: `bun run type-check:ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/session/sidebar/SessionLabelPopover.tsx
git commit -m "feat: add SessionLabelPopover for assigning labels to sessions"
```

---

## Task 5: Add Color Dot to `SessionNodeItem`

**Files:**
- Modify: `packages/ui/src/components/session/sidebar/SessionNodeItem.tsx`

- [ ] **Step 1: Add color dot before session title**

At the top of the file, add imports:
```typescript
import { useSessionLabelsStore, LABEL_COLOR_CSS_MAP } from '@/stores/useSessionLabelsStore';
import { SessionLabelPopover } from './SessionLabelPopover';
```

Inside the component, before the session title/name rendering, add:
```typescript
const labelId = useSessionLabelsStore((s) => s.sessionLabelMap[node.session.id]);
const labelColor = useSessionLabelsStore((s) => {
  const lid = s.sessionLabelMap[node.session.id];
  if (!lid) return null;
  const label = s.labels.find((l) => l.id === lid);
  return label ? LABEL_COLOR_CSS_MAP[label.color] : null;
});
const [labelPopoverOpen, setLabelPopoverOpen] = React.useState(false);
```

In the JSX, insert the color dot element as the first child of the session row content area (left of the title). The dot renders inside the existing row structure:
```tsx
<SessionLabelPopover
  sessionId={node.session.id}
  open={labelPopoverOpen}
  onOpenChange={setLabelPopoverOpen}
>
  <button
    type="button"
    className={cn(
      'h-2.5 w-2.5 shrink-0 rounded-full transition-opacity',
      labelColor ? 'opacity-100' : 'opacity-0 group-hover/session-row:opacity-40'
    )}
    style={{ backgroundColor: labelColor ?? 'currentColor' }}
    onClick={(e) => { e.stopPropagation(); setLabelPopoverOpen(true); }}
  />
</SessionLabelPopover>
```

Note: The exact insertion point depends on the JSX structure of `SessionNodeItem`. Find the element that contains the session title text and insert the dot as its first sibling. The session row likely has a `group/session-row` class for hover states (or add one if absent).

- [ ] **Step 2: Verify the component renders and type-checks**

Run: `bun run type-check:ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/session/sidebar/SessionNodeItem.tsx
git commit -m "feat: add color dot with label popover to session rows"
```

---

## Task 6: Create `LabelFilter` Component

**Files:**
- Create: `packages/ui/src/components/session/sidebar/LabelFilter.tsx`

- [ ] **Step 1: Create the filter component**

```typescript
// packages/ui/src/components/session/sidebar/LabelFilter.tsx
import React from 'react';
import { cn } from '@/lib/utils';
import { useSessionLabelsStore, LABEL_COLOR_CSS_MAP } from '@/stores/useSessionLabelsStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';

export const LabelFilter: React.FC = () => {
  const { t } = useI18n();
  const labels = useSessionLabelsStore((s) => s.labels);
  const sessionLabelMap = useSessionLabelsStore((s) => s.sessionLabelMap);
  const activeFilterLabelIds = useSessionLabelsStore((s) => s.activeFilterLabelIds);
  const toggleFilter = useSessionLabelsStore((s) => s.toggleFilter);
  const clearFilters = useSessionLabelsStore((s) => s.clearFilters);

  // Only show labels that are actually in use
  const usedLabelIds = React.useMemo(() => {
    const used = new Set<string>();
    for (const labelId of Object.values(sessionLabelMap)) {
      used.add(labelId);
    }
    return used;
  }, [sessionLabelMap]);

  const visibleLabels = React.useMemo(
    () => labels.filter((l) => usedLabelIds.has(l.id)),
    [labels, usedLabelIds]
  );

  if (visibleLabels.length === 0) return null;

  const hasActiveFilters = activeFilterLabelIds.size > 0;

  return (
    <div className="flex items-center gap-1 px-2 pb-1">
      {visibleLabels.map((label) => {
        const isActive = activeFilterLabelIds.has(label.id);
        return (
          <Tooltip key={label.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => toggleFilter(label.id)}
                className={cn(
                  'h-3 w-3 rounded-full transition-all',
                  isActive
                    ? 'ring-2 ring-primary/50 ring-offset-1 ring-offset-background scale-110'
                    : 'opacity-60 hover:opacity-100'
                )}
                style={{ backgroundColor: LABEL_COLOR_CSS_MAP[label.color] }}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {label.name}
            </TooltipContent>
          </Tooltip>
        );
      })}
      {hasActiveFilters && (
        <button
          type="button"
          onClick={clearFilters}
          className="ml-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('sidebar.labels.filter.clear')}
        </button>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Verify compilation**

Run: `bun run type-check:ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/session/sidebar/LabelFilter.tsx
git commit -m "feat: add LabelFilter for sidebar color-based session filtering"
```

---

## Task 7: Integrate `LabelFilter` into `SidebarHeader`

**Files:**
- Modify: `packages/ui/src/components/session/sidebar/SidebarHeader.tsx`

- [ ] **Step 1: Import and render `LabelFilter`**

At the top of `SidebarHeader.tsx`, add:
```typescript
import { LabelFilter } from './LabelFilter';
```

At the bottom of the component's returned JSX (after the existing header content, before the closing `</div>` or fragment), add:
```tsx
<LabelFilter />
```

This places the filter row below the search/action bar in the sidebar header area.

- [ ] **Step 2: Verify compilation and visual placement**

Run: `bun run type-check:ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/session/sidebar/SidebarHeader.tsx
git commit -m "feat: integrate LabelFilter into sidebar header"
```

---

## Task 8: Apply Label Filter in Session Grouping

**Files:**
- Modify: `packages/ui/src/components/session/sidebar/hooks/useSessionGrouping.ts`

- [ ] **Step 1: Add label filter logic**

Import the store at the top:
```typescript
import { useSessionLabelsStore } from '@/stores/useSessionLabelsStore';
```

In the hook that calls `buildGroupedSessions` (find where `projectSessions` is passed in), add a pre-filter step. The filter should be applied before sessions enter the grouping logic:

```typescript
// Inside the hook/callback that prepares sessions for grouping:
const activeFilterLabelIds = useSessionLabelsStore.getState().activeFilterLabelIds;
const sessionLabelMap = useSessionLabelsStore.getState().sessionLabelMap;

const filteredSessions = activeFilterLabelIds.size > 0
  ? projectSessions.filter((session) => {
      const labelId = sessionLabelMap[session.id];
      return labelId != null && activeFilterLabelIds.has(labelId);
    })
  : projectSessions;
```

Pass `filteredSessions` instead of `projectSessions` to `buildGroupedSessions`.

**Important:** This must be reactive. If `useSessionGrouping` is a hook with memoized callbacks, you need to subscribe to `activeFilterLabelIds` and `sessionLabelMap` from the store. The cleanest approach is to pass them as parameters from the parent component that calls this hook, or use `useSessionLabelsStore()` selector inside the hook if it's a React hook (not a plain callback).

Check whether `useSessionGrouping` is a React hook (uses `React.useCallback`/`useMemo`) or a plain function. If it's a hook, subscribe to the store via selector. If it's a callback factory, the caller must pass filter state as a parameter.

- [ ] **Step 2: Verify type-check and that the filter works end-to-end with the store**

Run: `bun run type-check:ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/session/sidebar/hooks/useSessionGrouping.ts
git commit -m "feat: apply label filter in session grouping hook"
```

---

## Task 9: Recent Section Drag-to-Reorder

**Files:**
- Modify: `packages/ui/src/components/session/sidebar/SidebarActivitySections.tsx`
- Modify: `packages/ui/src/components/session/sidebar/activitySections.ts`

- [ ] **Step 1: Integrate manual order into activity section derivation**

In `activitySections.ts`, modify `deriveActiveNowSessions` (or the function that produces the final Recent session list) to apply manual ordering:

```typescript
import { useRecentOrderStore } from '@/stores/useRecentOrderStore';

/**
 * Apply manual order: sessions in manualOrder appear first (in their stored order),
 * remaining sessions follow sorted by updatedAt descending.
 */
export function applyManualRecentOrder(
  sessions: Session[],
  manualOrder: string[]
): Session[] {
  if (manualOrder.length === 0) return sessions;

  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const ordered: Session[] = [];
  const seen = new Set<string>();

  // First: sessions in manual order (preserving manual sequence)
  for (const id of manualOrder) {
    const session = sessionMap.get(id);
    if (session) {
      ordered.push(session);
      seen.add(id);
    }
  }

  // Then: remaining sessions in original (time-sorted) order
  for (const session of sessions) {
    if (!seen.has(session.id)) {
      ordered.push(session);
    }
  }

  return ordered;
}
```

- [ ] **Step 2: Add DnD to `SidebarActivitySections`**

In `SidebarActivitySections.tsx`, add imports:
```typescript
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useRecentOrderStore } from '@/stores/useRecentOrderStore';
```

Wrap the items rendering block with DnD context:
```tsx
const reorder = useRecentOrderStore((s) => s.reorder);
const manualOrder = useRecentOrderStore((s) => s.manualOrder);

const handleDragEnd = React.useCallback((event: DragEndEvent) => {
  const { active, over } = event;
  if (!over || active.id === over.id) return;
  reorder(String(active.id), String(over.id));
}, [reorder]);

// In the render, wrap the item list:
<DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
  <SortableContext
    items={section.items.map((item) => item.node.session.id)}
    strategy={verticalListSortingStrategy}
  >
    {visibleItems.map((item) => (
      <SortableRecentItem key={item.node.session.id} id={item.node.session.id}>
        {renderSessionNode(item.node, 0, item.groupDirectory, item.projectId, false, item.secondaryMeta, 'recent')}
      </SortableRecentItem>
    ))}
  </SortableContext>
</DndContext>
```

Add the sortable wrapper component in the same file:
```tsx
function SortableRecentItem({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Wire `applyManualRecentOrder` into the data flow**

Find where the Recent/Active Now section's items are prepared (likely in `useSessionSidebarSections.ts` or the parent component that calls `SidebarActivitySections`). After the time-sorted list is built, apply:

```typescript
import { applyManualRecentOrder } from '../activitySections';
import { useRecentOrderStore } from '@/stores/useRecentOrderStore';

const manualOrder = useRecentOrderStore((s) => s.manualOrder);
const orderedSessions = applyManualRecentOrder(recentSessions, manualOrder);
```

- [ ] **Step 4: Verify type-check**

Run: `bun run type-check:ui`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/session/sidebar/SidebarActivitySections.tsx
git add packages/ui/src/components/session/sidebar/activitySections.ts
git commit -m "feat: add drag-to-reorder in Recent section using @dnd-kit"
```

---

## Task 10: Labels Settings Page

**Files:**
- Create: `packages/ui/src/components/sections/openchamber/LabelsSettings.tsx`
- Modify: `packages/ui/src/components/sections/openchamber/types.ts`
- Modify: `packages/ui/src/components/sections/openchamber/OpenChamberPage.tsx`
- Modify: `packages/ui/src/lib/settings/metadata.ts`
- Modify: `packages/ui/src/components/views/SettingsView.tsx`

- [ ] **Step 1: Add `'labels'` to `OpenChamberSection` type**

In `packages/ui/src/components/sections/openchamber/types.ts`:
```typescript
export type OpenChamberSection =
  | 'visual'
  | 'chat'
  | 'shortcuts'
  | 'sessions'
  | 'git'
  | 'github'
  | 'notifications'
  | 'voice'
  | 'tunnel'
  | 'labels'; // <-- add this
```

- [ ] **Step 2: Create `LabelsSettings.tsx`**

```typescript
// packages/ui/src/components/sections/openchamber/LabelsSettings.tsx
import React from 'react';
import { useSessionLabelsStore, LABEL_COLOR_CSS_MAP } from '@/stores/useSessionLabelsStore';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const LabelsSettings: React.FC = () => {
  const { t } = useI18n();
  const labels = useSessionLabelsStore((s) => s.labels);
  const renameLabel = useSessionLabelsStore((s) => s.renameLabel);
  const resetLabelName = useSessionLabelsStore((s) => s.resetLabelName);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="typography-ui-header font-semibold text-foreground">
          {t('settings.labels.title')}
        </h3>
        <p className="typography-meta text-muted-foreground">
          {t('settings.labels.description')}
        </p>
      </div>
      <div className="space-y-2">
        {labels.map((label) => (
          <div key={label.id} className="flex items-center gap-3 rounded-md border border-border/40 px-3 py-2">
            <span
              className="h-4 w-4 shrink-0 rounded-full"
              style={{ backgroundColor: LABEL_COLOR_CSS_MAP[label.color] }}
            />
            <input
              type="text"
              value={label.name}
              onChange={(e) => renameLabel(label.id, e.target.value)}
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder={label.color}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => resetLabelName(label.id)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Icon name="refresh-line" className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('settings.labels.resetName')}</TooltipContent>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
};
```

- [ ] **Step 3: Route the section in `OpenChamberPage.tsx`**

In the `switch` statement in `OpenChamberPage.tsx`, add:
```typescript
case 'labels': return <LabelsSettings />;
```

And add the import at the top:
```typescript
import { LabelsSettings } from './LabelsSettings';
```

- [ ] **Step 4: Register in settings metadata**

In `packages/ui/src/lib/settings/metadata.ts`, add `'labels'` to the `SettingsPageSlug` type:
```typescript
export type SettingsPageSlug =
  | 'home'
  | 'projects'
  // ... existing ...
  | 'labels'  // <-- add
  | 'about';
```

Add a metadata entry to `SETTINGS_PAGE_METADATA`:
```typescript
{
  slug: 'labels',
  title: 'Labels',
  group: 'general',
  kind: 'single',
  keywords: ['label', 'color', 'tag', 'session', 'category'],
},
```

- [ ] **Step 5: Wire in `SettingsView.tsx`**

In the `pageOrder` array, add `'labels'` after `'sessions'`:
```typescript
const pageOrder: SettingsPageSlug[] = [
  'appearance', 'chat', 'notifications', 'sessions', 'labels', 'shortcuts', 'git',
  // ...
];
```

In `openChamberSectionBySlug`, add:
```typescript
labels: 'labels',
```

- [ ] **Step 6: Verify full type-check and lint**

Run: `bun run type-check && bun run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/components/sections/openchamber/LabelsSettings.tsx
git add packages/ui/src/components/sections/openchamber/types.ts
git add packages/ui/src/components/sections/openchamber/OpenChamberPage.tsx
git add packages/ui/src/lib/settings/metadata.ts
git add packages/ui/src/components/views/SettingsView.tsx
git commit -m "feat: add Labels settings page for managing session label names"
```

---

## Task 11: Final Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full validation suite**

```bash
bun run type-check
bun run lint
bun run build
```

Expected: All PASS

- [ ] **Step 2: Manual verification checklist**

Run `bun run dev` and verify:
1. Session rows show a faint dot on hover (no label) or colored dot (with label)
2. Clicking the dot opens the label popover
3. Assigning a label persists across page refresh
4. Label filter appears in sidebar header when labels are in use
5. Clicking filter dots shows only matching sessions
6. Recent section items can be dragged to reorder
7. Manual order persists across page refresh
8. Settings > Labels page shows all 8 labels with editable names
9. Renaming a label updates the popover and filter immediately
10. Light and dark theme both show label colors correctly

- [ ] **Step 3: Final commit (if any adjustments were needed)**

```bash
git add -A
git commit -m "feat: session labels and Recent drag-to-reorder - integration fixes"
```
