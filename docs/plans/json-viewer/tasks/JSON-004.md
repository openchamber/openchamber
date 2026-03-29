# Task: JSON-004 - Add isJsonFile helper and jsonViewMode state to FilesView

## Metadata
- Status: pending
- Estimate: 20m
- Depends on: (none)

## Files to Modify
- `packages/ui/src/components/views/FilesView.tsx`

## Description
Add the foundational plumbing for JSON tree view mode in FilesView: detection function and state management. Follow the existing `isMarkdownFile` / `mdViewMode` pattern exactly.

## Requirements

### 1. Add `isJsonFile` helper (near line 260, after `isMarkdownFile`)

```typescript
const isJsonFile = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'json' || ext === 'jsonc' || ext === 'json5' || ext === 'geojson';
};
```

### 2. Add `jsonViewMode` state (near line 468, after `mdViewMode`)

```typescript
const [jsonViewMode, setJsonViewMode] = React.useState<'tree' | 'text'>('tree');
```

Default to `'tree'` — the new tree view is the preferred way to view JSON.

### 3. Add computed boolean (near line 1634, after `isMarkdown`)

```typescript
const isJson = Boolean(selectedFile?.path && isJsonFile(selectedFile.path));
```

### 4. Persist to localStorage (follow `MD_VIEWER_MODE_KEY` pattern on line 1674)

Add `JSON_VIEWER_MODE_KEY = 'openchamber:files:json-viewer-mode'` and load/save logic matching the md viewer pattern.

### 5. Reset view mode on file change

In the effect at line 1670-1672 (which resets `textViewMode` on path change), add similar reset for `jsonViewMode`:

```typescript
React.useEffect(() => {
  setTextViewMode('edit');
  // jsonViewMode persists via localStorage, not reset on file change
}, [selectedFile?.path]);
```

## Verification
```bash
bun run type-check -- packages/ui/src/components/views/FilesView.tsx
```

## Notes
- This task only adds plumbing, no rendering changes yet
- Follow the exact same patterns as markdown (`mdViewMode`, `MD_VIEWER_MODE_KEY`)
- Keep `canUseShikiFileView` unchanged — it excludes markdown but NOT JSON (JSON falls through to CodeMirror by default)
