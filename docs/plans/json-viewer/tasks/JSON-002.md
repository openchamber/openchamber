# Task: JSON-002 - Create JsonTreeViewer core component

## Metadata
- Status: pending
- Estimate: 1h
- Depends on: JSON-001

## Files to Modify
- `packages/ui/src/components/ui/JsonTreeViewer.tsx` (CREATE)

## Description
Build the core JSON tree viewer component with collapse/expand functionality and rainbow-colored nesting levels. This is the heart of the feature.

## Requirements

### Component Props

```
Interface JsonTreeViewerProps:
  - data: unknown (parsed JSON value, NOT string)
  - className?: string
  - maxHeight?: string (default: '100%')
  - initiallyExpandedDepth?: number (default: 2)
  - showLineNumbers?: boolean (default: false)
  - onCopyPath?: (path: string) => void
```

### Visual Design

1. **Collapse/Expand Indicators**
   - Use `RiArrowDownSLine` / `RiArrowRightSLine` icons (already imported in project)
   - Arrow + key name + type hint (e.g., `{5 items}` or `[12]`)
   - Clicking the arrow or key name toggles collapse

2. **Rainbow Colors by Depth**
   - Use CSS `color-mix()` with syntax theme tokens for key colors
   - Depth 0 keys: `var(--syntax-key, var(--foreground))`
   - Depth 1: `color-mix(in oklch, var(--syntax-key) 85%, var(--syntax-string))`
   - Depth 2: `color-mix(in oklch, var(--syntax-key) 70%, var(--syntax-number))`
   - Depth 3+: cycle through `syntax-function`, `syntax-type`, `syntax-keyword`
   - Use inline styles with CSS variables (theme-safe)

3. **Value Colors**
   - Strings: `var(--syntax-string)`
   - Numbers: `var(--syntax-number)`
   - Booleans: `var(--syntax-keyword)`
   - Null: `var(--syntax-comment)`

4. **Collapsed State**
   - Show preview: `{ "key1": ..., "key2": ... }` or `[12 items]`
   - Preview text in `var(--surface-mutedForeground)`

### Implementation Details

- Parse JSON once with `useMemo`, build tree with `parseJsonToTree` from jsonTreeUtils
- Track collapsed paths in `useState<Set<string>>`
- Use `flattenTree` to get visible nodes
- Conditionally use `@tanstack/react-virtual` when visible nodes > 200
- Use `useCallback` for toggle handler to avoid re-renders

### Important: Theme Integration

**DO NOT** use hardcoded hex colors. All colors MUST use CSS variables from the theme system:
- `var(--syntax-key)` for keys
- `var(--syntax-string)` for strings
- `var(--syntax-number)` for numbers
- `var(--syntax-keyword)` for booleans
- `var(--syntax-comment)` for null
- `var(--surface-foreground)` for structural chars (`{`, `}`, `[`, `]`, `,`)
- `var(--surface-mutedForeground)` for collapse previews

For rainbow effect, use `color-mix()` to blend existing tokens:
```css
color: color-mix(in oklch, var(--syntax-key) 85%, var(--syntax-string));
```

## Verification
```bash
bun run type-check -- packages/ui/src/components/ui/JsonTreeViewer.tsx
```

## Notes
- Keep component under 300 lines
- Use `React.memo` to prevent unnecessary re-renders
- Handle edge cases: empty objects `{}`, empty arrays `[]`, very long strings (truncate with `...`)
- Use `typography-code` class for font styling (consistent with code blocks)
