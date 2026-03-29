# Task: JSON-005 - Add JSON tree view toggle button in FilesView toolbar

## Metadata
- Status: pending
- Estimate: 15m
- Depends on: JSON-004

## Files to Modify
- `packages/ui/src/components/views/FilesView.tsx`

## Description
Add a toggle button in the file toolbar that lets users switch between "Tree" and "Text" view modes for JSON files. Follow the existing `PreviewToggleButton` pattern used for markdown.

## Requirements

### Toggle Button Placement

Add near line 2238 (where the markdown `PreviewToggleButton` is rendered):

```tsx
{isJson && (
  <JsonViewToggleButton
    currentMode={jsonViewMode}
    onToggle={() => {
      const newMode = jsonViewMode === 'tree' ? 'text' : 'tree';
      setJsonViewMode(newMode);
      saveJsonViewMode(newMode);
    }}
  />
)}
```

### Create `JsonViewToggleButton` component

Either inline it in FilesView (simple enough) or create a small helper. Use icons:
- Tree mode icon: `RiNodeTree` or `RiMindMap` from `@remixicon/react`
- Text mode icon: `RiCodeSSlashLine` from `@remixicon/react`

The button should show what you'll SWITCH TO (like PreviewToggleButton):
- In tree mode → show text icon with tooltip "Text View"
- In text mode → show tree icon with tooltip "Tree View"

### Styling

Use the same pattern as PreviewToggleButton:
```tsx
<Button variant="ghost" size="sm" className="h-5 w-5 p-0">
  {currentMode === 'tree' ? <RiCodeSSlashLine ... /> : <RiMindMap ... />}
</Button>
```

Wrap in Tooltip like existing buttons.

## Verification
```bash
bun run type-check -- packages/ui/src/components/views/FilesView.tsx
```

## Notes
- Only show the toggle when a JSON file is selected (`isJson`)
- Import needed icons from `@remixicon/react` (check if already imported)
- Keep the button consistent with existing toolbar buttons (same size, variant)
