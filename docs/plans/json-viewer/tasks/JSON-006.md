# Task: JSON-006 - Add JSON tree view render branch in FilesView content area

## Metadata
- Status: pending
- Estimate: 25m
- Depends on: JSON-003, JSON-005

## Files to Modify
- `packages/ui/src/components/views/FilesView.tsx`

## Description
Add the actual render logic for showing the JSON tree viewer when a JSON file is open in tree mode. Insert a new branch in the file content rendering conditional chain.

## Requirements

### Render Branch Location

In the file content area (around line 2564, before the Shiki view branch), add a new condition:

```tsx
// Current chain (simplified):
} else if (selectedFile && isMarkdown && getMdViewMode() === 'preview') {
  // markdown preview
} else if (selectedFile && canUseShikiFileView && textViewMode === 'view') {
  // shiki view
} else {
  // code mirror editor
}
```

Add new branch BEFORE the markdown check:

```tsx
} else if (selectedFile && isJson && jsonViewMode === 'tree') {
  // JSON tree view
}
```

### JSON Tree View Rendering

```tsx
{selectedFile && isJson && jsonViewMode === 'tree' ? (
  <ErrorBoundary
    fallback={
      <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
        <div className="mb-1 font-medium text-destructive">JSON viewer unavailable</div>
        <div className="text-sm text-muted-foreground">
          Switch to text mode to view raw content.
        </div>
      </div>
    }
  >
    <div className="h-full overflow-auto p-3">
      <JsonTreeView
        jsonString={fileContent}
        maxHeight="100%"
        initiallyExpandedDepth={2}
      />
    </div>
  </ErrorBoundary>
) : selectedFile && isMarkdown && getMdViewMode() === 'preview' ? (
  // existing markdown preview
```

### Imports

Add at the top of FilesView.tsx:
```typescript
import { JsonTreeView } from '@/components/ui/JsonTreeView';
```

## Verification
```bash
bun run type-check -- packages/ui/src/components/views/FilesView.tsx
bun run lint
```

## Notes
- Use `fileContent` (raw string) not `draftContent` for JSON display (JSON is read-only in tree mode)
- Wrap in `ErrorBoundary` like markdown preview does
- The tree view should fill the available height
- Also apply the same branch in the fullscreen view (around line 2809)
