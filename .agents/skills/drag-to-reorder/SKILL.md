---
name: drag-to-reorder
description: Use when implementing or modifying OpenChamber sortable or drag-to-reorder behavior, especially `@dnd-kit`, touch/mobile interactions, variable-width items, or wrapping layouts.
license: MIT
compatibility: opencode
---

## Overview

**Reference implementations in this repo:**
- `packages/ui/src/components/chat/DraftPresetChips.tsx` — variable-width chips that wrap (the hardest case; mobile long-press).
- `packages/ui/src/components/ui/sortable-tabs-strip.tsx` — single-row scrollable tabs.

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
| Guaranteed single horizontal row (e.g. scrollable tab strip) | `horizontalListSortingStrategy`; in a right-to-left layout `rectSortingStrategy` (see `rtl-layout`) |
| Single vertical list | `verticalListSortingStrategy` |

`horizontalListSortingStrategy` on a **wrapping** row is the classic mistake: it assumes one row, so dragging to another row makes items overlap instead of reflowing. Use `rectSortingStrategy` for anything that wraps.

### 3. Desktop + mobile = two sensors (MouseSensor + TouchSensor with delay)

Use separate mouse and touch sensors. A distance constraint makes touch fight scrolling, and a delay constraint forces desktop users to hold before dragging:

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

Reorder once in `onDragEnd`. Live reordering in `onDragOver` can oscillate between variable-size items and cause a maximum update depth error. Use live reordering only when physical row reflow is needed, and guard against oscillation.

## Minimal Wiring

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

// Configure sensors per Rule 3, reorder onDragEnd per Rule 5, and choose the
// SortableContext strategy from Rule 2. This item wiring preserves item width.
```

A clickable element can be draggable at the same time: keep `onClick` on the button and the activation constraint (distance/delay) lets a plain click/tap through.

## If `rectSortingStrategy` still isn't crisp enough

Reordering variable-width chips across wrapped rows is a documented rough edge in dnd-kit's box strategies. `rectSortingStrategy` is the best the strategy-based approach offers without instability. If a design needs bulletproof cross-row feedback, switch UX: render a **drop-position indicator** (a line/gap showing where it will land) and keep items static during the drag (no reorder until drop) — this avoids both overlap and the oscillation loop, at the cost of more code. Discuss before building it.

## Completion Criteria

Verify every applicable rule on desktop and touch. Wrapping layouts must preserve item width, reflow across rows, allow taps and scrolling before long-press activation, and reorder exactly once on drag end with stable IDs.
