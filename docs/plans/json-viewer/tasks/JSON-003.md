# Task: JSON-003 - Create JsonTreeView wrapper with toolbar

## Metadata
- Status: pending
- Estimate: 30m
- Depends on: JSON-002

## Files to Modify
- `packages/ui/src/components/ui/JsonTreeView.tsx` (CREATE)

## Description
Create a wrapper component around `JsonTreeViewer` that adds a toolbar with expand all / collapse all buttons and a copy path action. This component handles the full "tree view" experience.

## Requirements

### Component Props

```
Interface JsonTreeViewProps:
  - jsonString: string (raw JSON text)
  - className?: string
  - maxHeight?: string
  - initiallyExpandedDepth?: number (default: 2)
```

### Toolbar Features

1. **Expand All** button - expands all nodes (use `RiArrowDownDoubleLine` icon)
2. **Collapse All** button - collapses to initial depth (use `RiArrowUpDoubleLine` icon)
3. **Error State** - if JSON is invalid, show error message with syntax-highlighted raw text fallback

### Layout

```
┌─────────────────────────────────────┐
│ [▼ Expand All] [▲ Collapse All]    │  ← toolbar
├─────────────────────────────────────┤
│                                     │
│  {                                   │
│    "name": "OpenChamber",           │  ← JsonTreeViewer
│    "version": "1.0.0",              │
│    "features": [12 items]           │
│  }                                   │
│                                     │
└─────────────────────────────────────┘
```

### Styling

- Toolbar: `border-b border-[var(--interactive-border)]` with `px-2 py-1`
- Toolbar buttons: `variant="ghost" size="xs"` (existing Button component)
- Container: `bg-[var(--syntax-base-background)] rounded-md overflow-auto`
- Error state: show raw text with `react-syntax-highlighter` (existing pattern from ToolPart.tsx)

## Verification
```bash
bun run type-check -- packages/ui/src/components/ui/JsonTreeView.tsx
```

## Notes
- Parse JSON with `try/catch` - if invalid, render error fallback
- Use `useMemo` for parsed data
- Use `useCallback` for toolbar handlers
- Keep component under 120 lines
