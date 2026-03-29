# Plan: Interactive JSON Viewer with Collapse/Expand and Rainbow Colors

## Metadata
- Created: 2026-03-29
- Status: ready
- Domain: ui

## Summary
| Metric | Value |
|--------|-------|
| Total tasks | 11 |
| Estimated time | 4h 15m |
| Files affected | 7 |
| New files | 3 |

## Overview

Add an interactive JSON tree viewer to OpenChamber that lets users collapse/expand JSON objects and arrays, with rainbow-colored nesting levels for visual scanning. The viewer integrates into two places: the Files panel (when opening `.json` files) and the chat tool output area (when tools return JSON).

## Technical Approach

Build a **custom lightweight JSON tree component** rather than using `react-json-tree`. Rationale:

- `react-json-tree` hasn't been updated recently and has limited TypeScript support
- Custom component gives full control over theme integration (must use `syntax.*` tokens, not hardcoded colors)
- Can leverage `@tanstack/react-virtual` (already in deps) for performance with large files
- Keeps dependency surface small

The component will:
1. Parse JSON text into a tree structure once (`useMemo`)
2. Track collapsed node paths in a `Set<string>` state
3. Derive rainbow colors from existing `syntax.*` theme tokens via CSS `color-mix()` — no new theme tokens needed
4. Use `@tanstack/react-virtual` for files with >200 visible lines

### Rainbow Color Strategy

Use CSS `color-mix()` with the existing `syntax.tokens.key` color as the base, rotating hue by depth level. This works across all themes without modifying theme JSON files.

```
depth 0: var(--syntax-key)           (theme's key color)
depth 1: color-mix(in oklch, var(--syntax-key) 80%, var(--syntax-string))
depth 2: color-mix(in oklch, var(--syntax-key) 60%, var(--syntax-number))
depth 3: color-mix(in oklch, var(--syntax-key) 40%, var(--syntax-function))
...and so on, cycling through syntax token colors
```

## 💡 Why This Approach?

### Alternatives Considered

| Option | Description | Considered | Not Chosen Because |
|--------|-------------|------------|-------------------|
| `react-json-tree` | Lightweight npm package | ✅ | Limited TS support, outdated, hard to customize theme integration |
| CodeMirror fold extension | Native folding in editor | ✅ | No rainbow colors, poor JSON-specific UX, no visual hierarchy |
| Monaco Editor | VS Code's editor | ✅ | Heavy (~5MB), overkill for read-only JSON viewing |
| Custom component | Build from scratch | ✅ **Chosen** | Full theme control, virtualization support, small footprint |

### Trade-offs of Custom Component

**Pros:**
- Full control over colors, layout, and interaction
- Integrates perfectly with existing theme system (`syntax.*` tokens)
- Can use `@tanstack/react-virtual` for large files (already in deps)
- No new heavy dependencies
- Consistent with project's "keep diffs tight" philosophy

**Cons:**
- More code to write and maintain (~300 lines for core component)
- Need to handle edge cases (circular refs, very deep nesting, huge arrays)

### When to Use a Different Approach

| If... | Then Use... |
|-------|-------------|
| Need full editing support | Monaco or CodeMirror with fold gutters |
| Only need basic display | Keep existing SyntaxHighlighter |
| Need diff view of two JSONs | Custom diff renderer |

## Integration Points

### 1. FilesView.tsx (Primary)

Follow the existing markdown preview pattern:
- Add `isJsonFile()` helper (like `isMarkdownFile()` on line 260)
- Add `jsonViewMode` state: `'tree' | 'text'` (like `mdViewMode` on line 468)
- Add toggle button in toolbar (like the `PreviewToggleButton` on line 2238)
- Add render branch in the file content area (between markdown preview and CodeMirror editor, around line 2564)

### 2. ToolPart.tsx + ToolOutputDialog.tsx (Secondary)

- In `ToolScrollableTextOutput` (line 527-559): detect if output is valid JSON, render `JsonTreeViewer` instead of `SyntaxHighlighter`
- In `ToolOutputDialog.tsx`: same detection for expanded view

## Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `packages/ui/src/components/ui/JsonTreeViewer.tsx` | Core tree component with collapse/expand and rainbow colors |
| `packages/ui/src/components/ui/JsonTreeView.tsx` | Wrapper with toolbar (expand/collapse all, copy path) |
| `packages/ui/src/lib/jsonTreeUtils.ts` | JSON parsing, path utilities, tree node types |

### Modified Files
| File | Changes |
|------|---------|
| `packages/ui/src/components/views/FilesView.tsx` | Add `isJsonFile()`, `jsonViewMode` state, toggle button, tree view render branch |
| `packages/ui/src/components/chat/message/parts/ToolPart.tsx` | Detect JSON output, render `JsonTreeViewer` in `ToolScrollableTextOutput` |
| `packages/ui/src/components/chat/message/ToolOutputDialog.tsx` | Detect JSON output in expanded dialog, render `JsonTreeViewer` |
| `packages/ui/src/components/chat/message/toolRenderers.tsx` | Add `isJsonOutput()` helper for tool output detection |

## Task Breakdown

### Phase 1: Core Component (can run in parallel)

| ID | Task | Files | Estimate | Depends |
|----|------|-------|----------|---------|
| JSON-001 | Create JSON tree types and parse utility | `packages/ui/src/lib/jsonTreeUtils.ts` | 30m | - |
| JSON-002 | Create JsonTreeViewer core component | `packages/ui/src/components/ui/JsonTreeViewer.tsx` | 1h | JSON-001 |
| JSON-003 | Create JsonTreeView wrapper with toolbar | `packages/ui/src/components/ui/JsonTreeView.tsx` | 30m | JSON-002 |

### Phase 2: FilesView Integration

| ID | Task | Files | Estimate | Depends |
|----|------|-------|----------|---------|
| JSON-004 | Add `isJsonFile()` helper and `jsonViewMode` state | `packages/ui/src/components/views/FilesView.tsx` | 20m | - |
| JSON-005 | Add JSON tree view toggle button in toolbar | `packages/ui/src/components/views/FilesView.tsx` | 15m | JSON-004 |
| JSON-006 | Add JSON tree view render branch in file content area | `packages/ui/src/components/views/FilesView.tsx` | 25m | JSON-003, JSON-005 |

### Phase 3: Tool Output Integration

| ID | Task | Files | Estimate | Depends |
|----|------|-------|----------|---------|
| JSON-007 | Add `isJsonOutput()` helper to toolRenderers | `packages/ui/src/components/chat/message/toolRenderers.tsx` | 15m | - |
| JSON-008 | Integrate JsonTreeViewer into ToolScrollableTextOutput | `packages/ui/src/components/chat/message/parts/ToolPart.tsx` | 25m | JSON-003, JSON-007 |
| JSON-009 | Integrate JsonTreeViewer into ToolOutputDialog | `packages/ui/src/components/chat/message/ToolOutputDialog.tsx` | 20m | JSON-003, JSON-007 |

### Phase 4: Polish & Verification

| ID | Task | Files | Estimate | Depends |
|----|------|-------|----------|---------|
| JSON-010 | Add virtualization for large JSON files (>200 lines) | `packages/ui/src/components/ui/JsonTreeViewer.tsx` | 30m | JSON-002 |
| JSON-011 | Run type-check, lint, build verification | all | 15m | ALL |

## Risks & Assumptions
- **Risk**: Large JSON files (>10K lines) may cause memory issues during parsing. Mitigation: cap at 2MB, show warning.
- **Risk**: Circular references in tool output JSON. Mitigation: use `JSON.stringify` replacer or try/catch.
- **Assumption**: Existing `syntax.*` theme tokens provide enough color variety for rainbow effect across all 60+ themes.
- **Assumption**: CSS `color-mix()` is supported in all target browsers (Chrome 111+, Safari 16.2+, Firefox 113+).

## Verification Steps

After all tasks complete:

```bash
cd /Users/nguyenngothuong/.local/share/opencode/worktree/4b2edf73188e5dc63cc6a1deb71c4c5eb0f87de2/bionic-jackal
bun run type-check
bun run lint
bun run build
```

Manual testing:
1. Open a `.json` file in Files panel → should show tree view by default
2. Toggle between "Tree" and "Text" views → should switch smoothly
3. Collapse/expand nested objects and arrays → should animate smoothly
4. Rainbow colors should be visible at each nesting level
5. Copy a JSON tool output from chat → expanded dialog should show tree view
6. Test with a large JSON file (10K+ lines) → should be responsive

## Execution Order

1. **Phase 1** (parallel): JSON-001, JSON-004, JSON-007
2. **Phase 2** (sequential): JSON-002 → JSON-003
3. **Phase 3** (parallel after JSON-003): JSON-005, JSON-006, JSON-008, JSON-009
4. **Phase 4**: JSON-010, JSON-011

## Task Files
- [JSON-001](./tasks/JSON-001.md)
- [JSON-002](./tasks/JSON-002.md)
- [JSON-003](./tasks/JSON-003.md)
- [JSON-004](./tasks/JSON-004.md)
- [JSON-005](./tasks/JSON-005.md)
- [JSON-006](./tasks/JSON-006.md)
- [JSON-007](./tasks/JSON-007.md)
- [JSON-008](./tasks/JSON-008.md)
- [JSON-009](./tasks/JSON-009.md)
- [JSON-010](./tasks/JSON-010.md)
- [JSON-011](./tasks/JSON-011.md)

## 💡 Learning Outcomes

### Patterns Applied

| Pattern | Why Used | Where |
|---------|----------|-------|
| Component composition | Separate tree logic from toolbar/controls | `JsonTreeViewer.tsx` + `JsonTreeView.tsx` |
| Virtualization | Handle large datasets efficiently | `JsonTreeViewer.tsx` using `@tanstack/react-virtual` |
| CSS custom properties | Theme-aware colors without JS runtime | Rainbow colors via `color-mix()` with `var(--syntax-*)` |
| State-driven rendering | Toggle between tree/text views | `FilesView.tsx` `jsonViewMode` state |
| Memoization | Parse JSON once, re-render on collapse | `useMemo` for tree building, `useCallback` for handlers |

### Key Concepts

- **Tree flattening**: Convert nested JSON tree into flat visible list for virtualization
- **Path-based collapse state**: Use JSON path strings (e.g., `root.data.items[2]`) as collapse keys
- **Deriving colors from theme**: Use CSS `color-mix()` to create variations from existing tokens instead of adding new ones
