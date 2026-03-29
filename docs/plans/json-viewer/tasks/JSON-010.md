# Task: JSON-010 - Add virtualization for large JSON files

## Metadata
- Status: pending
- Estimate: 30m
- Depends on: JSON-002

## Files to Modify
- `packages/ui/src/components/ui/JsonTreeViewer.tsx`

## Description
Add virtual scrolling to the JSON tree viewer for handling large JSON files (>200 visible nodes). Use `@tanstack/react-virtual` which is already a project dependency.

## Requirements

### Threshold

```typescript
const VIRTUALIZE_THRESHOLD = 200; // visible nodes
const ROW_HEIGHT = 24; // px per row
```

### Implementation

1. After flattening the tree, check visible node count
2. If `flatNodes.length > VIRTUALIZE_THRESHOLD`, use `useVirtualizer`
3. Otherwise, render all nodes directly (no overhead)

```tsx
const flatNodes = React.useMemo(
  () => flattenTree(treeRoot, collapsedPaths),
  [treeRoot, collapsedPaths]
);

const shouldVirtualize = flatNodes.length > VIRTUALIZE_THRESHOLD;

if (shouldVirtualize) {
  // Use @tanstack/react-virtual
  const parentRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });
  
  return (
    <div ref={parentRef} className="overflow-auto" style={{ maxHeight }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const node = flatNodes[virtualRow.index];
          return (
            <div
              key={node.node.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <JsonRow node={node} onToggle={handleToggle} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Non-virtualized: render all nodes
return (
  <div className="overflow-auto" style={{ maxHeight }}>
    {flatNodes.map((node) => (
      <JsonRow key={node.node.id} node={node} onToggle={handleToggle} />
    ))}
  </div>
);
```

### Extract `JsonRow` Component

Extract the row rendering into a `React.memo`-wrapped component for performance:

```tsx
const JsonRow = React.memo(({ node, onToggle }: { node: FlatJsonNode; onToggle: (id: string) => void }) => {
  // Render single row: indent, arrow, key, value/preview
});
```

## Verification
```bash
bun run type-check -- packages/ui/src/components/ui/JsonTreeViewer.tsx
```

## Notes
- Import `useVirtualizer` from `@tanstack/react-virtual` (already in package.json)
- The `ROW_HEIGHT` must match the actual rendered height (use `typography-code` line-height)
- Overscan of 20 rows ensures smooth scrolling
- Make sure the scroll container has a fixed `maxHeight`
