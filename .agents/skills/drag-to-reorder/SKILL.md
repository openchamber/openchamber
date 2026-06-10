---
name: drag-to-reorder
description: Use when implementing drag-to-reorder / sortable lists or chips in OpenChamber with @dnd-kit — covers the correct setup for BOTH desktop and mobile (touch), the variable-width "stretch" fix, the wrapping multi-row strategy choice, and the pitfalls (infinite update loop, offset overlay) we already hit and fixed.
license: MIT
compatibility: opencode
---

## Overview

OpenChamber uses **@dnd-kit** (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`) for drag-to-reorder. Getting it to feel right on both desktop and mobile — especially for chips/tags of **variable width that wrap onto multiple rows** — has several non-obvious gotchas. This skill captures the configuration that works, and the bugs to avoid.

**Reference implementations in this repo:**
- `packages/ui/src/components/chat/DraftPresetChips.tsx` — variable-width chips that wrap (the hardest case; mobile long-press).
- `packages/ui/src/components/ui/sortable-tabs-strip.tsx` — single-row scrollable tabs.

## When to Use

- Adding any reorderable list, row of chips/tags, or sortable grid.
- Fixing an existing sortable that stretches the dragged item, jumps/overlaps across rows, throws "Maximum update depth exceeded", or doesn't work on touch.

## The Five Rules (most important first)

### 1. Translate, not Transform — kills the "stretch to slot width" bug

`CSS.Transform.toString(transform)` emits `translate3d(...) scaleX(..) scaleY(..)`. For variable-width items the sorting strategy puts a non-1 scale on the lifted item so it **stretches to the neighbor/slot width**. Use `CSS.Translate.toString(transform)` — translation only, no scale — and the dragged item keeps its own size. Sibling shifting is unaffected (their scale was 1 anyway).

```tsx
import { CSS } from '@dnd-kit/utilities';
const { transform, transition, isDragging } = useSortable({ id });
<div style={{ transform: CSS.Translate.toString(transform), transition }} />
//                  ^^^^^^^^^ NOT CSS.Transform.toString
```

### 2. Pick the strategy by layout

| Layout | Strategy |
|--------|----------|
| Wraps onto multiple rows / grid / chips of variable width | `rectSortingStrategy` (default — computes 2D positions, so items can shift to other rows) |
| Guaranteed single horizontal row (e.g. scrollable tab strip) | `horizontalListSortingStrategy` |
| Single vertical list | `verticalListSortingStrategy` |

`horizontalListSortingStrategy` on a **wrapping** row is the classic mistake: it assumes one row, so dragging to another row makes items overlap instead of reflowing. Use `rectSortingStrategy` for anything that wraps.

### 3. Desktop + mobile = two sensors (MouseSensor + TouchSensor with delay)

Do NOT use a single `PointerSensor` — a distance constraint makes touch fight scrolling, and a delay constraint would force desktop to hold-before-drag. Split them:

```tsx
import { MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';

const sensors = useSensors(
  // Desktop: drag after a small move; a click still fires.
  useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
  // Touch: long-press to drag — tap fires the element's onClick, a quick swipe scrolls.
  useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
);
```

This gives: tap = activate the item (e.g. submit), **long-press ≈200ms = drag**, swipe = scroll.

### 4. `touch-action: none` on the draggable

Without it the browser hijacks the touch gesture (scrolls) instead of letting dnd-kit drag. Add Tailwind `touch-none` (and usually `select-none`) to the draggable element.

### 5. Reorder on `onDragEnd`, with stable ids and `arrayMove`

```tsx
import { arrayMove } from '@dnd-kit/sortable';
const onDragEnd = (e: DragEndEvent) => {
  const { active, over } = e;
  if (over && active.id !== over.id) {
    // find by id, never by array index
    const from = items.findIndex(i => i.id === active.id);
    const to = items.findIndex(i => i.id === over.id);
    setItems(arrayMove(items, from, to));
  }
};
```

IDs must be **stable per item** (derive from the item's identity, e.g. `type:name`), never the array index — index ids break tracking after the first move.

## Minimal working pattern (wrapping, variable width, desktop + touch)

```tsx
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const Item: React.FC<{ id: string; label: string; onClick: () => void }> = ({ id, label, onClick }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && 'opacity-60')}>
      <button type="button" {...attributes} {...listeners} onClick={onClick} className="touch-none select-none ...">
        {label}
      </button>
    </div>
  );
};

const Row: React.FC<{ items: Item[]; onReorder: (next: Item[]) => void }> = ({ items, onReorder }) => {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = items.findIndex(i => i.id === active.id);
    const to = items.findIndex(i => i.id === over.id);
    onReorder(arrayMove(items, from, to));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map(i => i.id)} strategy={rectSortingStrategy}>
        <div className="flex flex-wrap gap-2">
          {items.map(i => <Item key={i.id} id={i.id} label={i.label} onClick={i.onClick} />)}
        </div>
      </SortableContext>
    </DndContext>
  );
};
```

A clickable element can be draggable at the same time: keep `onClick` on the button and the activation constraint (distance/delay) lets a plain click/tap through.

## Pitfalls we already hit (don't repeat)

| Symptom | Cause | Fix |
|---------|-------|-----|
| Dragged item **stretches** to the target slot width | `CSS.Transform.toString` applies scaleX/scaleY | Use `CSS.Translate.toString` (Rule 1) |
| On narrow/multi-row: items **don't reflow to other rows, overlap**, unclear drop target | `horizontalListSortingStrategy` on a wrapping row | Use `rectSortingStrategy` (Rule 2) |
| **"Maximum update depth exceeded"** during drag + dragged element floats **offset from the cursor** | Live-reorder in `onDragOver` (empty strategy + `setState` each over) oscillates A↔B with variable sizes; the empty `DragOverlay` we paired with it was mispositioned | Don't reorder in `onDragOver`. Reorder once in `onDragEnd` (Rule 5). Only reach for live-reorder if you truly need physical row-reflow, and then guard against oscillation. |
| Touch drag scrolls the page instead of dragging | Missing `touch-action: none` | Add `touch-none` (Rule 4) |
| Touch: every finger move drags, or tap doesn't register | Single `PointerSensor` with distance | Split into MouseSensor + TouchSensor(delay) (Rule 3) |

## If `rectSortingStrategy` still isn't crisp enough

Reordering variable-width chips across wrapped rows is a documented rough edge in dnd-kit's box strategies. `rectSortingStrategy` is the best the strategy-based approach offers without instability. If a design needs bulletproof cross-row feedback, switch UX: render a **drop-position indicator** (a line/gap showing where it will land) and keep items static during the drag (no reorder until drop) — this avoids both overlap and the oscillation loop, at the cost of more code. Discuss before building it.

## Key Files

- Variable-width wrapping chips: `packages/ui/src/components/chat/DraftPresetChips.tsx`
- Single-row tab strip: `packages/ui/src/components/ui/sortable-tabs-strip.tsx`
- Library: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` (already in `packages/ui/package.json`)
