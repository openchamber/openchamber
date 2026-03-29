# Task: JSON-009 - Integrate JsonTreeViewer into ToolOutputDialog

## Metadata
- Status: pending
- Estimate: 20m
- Depends on: JSON-003, JSON-007

## Files to Modify
- `packages/ui/src/components/chat/message/ToolOutputDialog.tsx`

## Description
Add JSON tree viewer support to the expanded tool output dialog. When a tool output is valid JSON, the dialog should show the interactive tree instead of syntax-highlighted text.

## Requirements

### Detection and Render

In `ToolOutputDialog.tsx`, find where the tool output content is rendered (the main content area). Add a check similar to JSON-008:

```tsx
const jsonResult = React.useMemo(
  () => popup.output ? tryParseJsonOutput(popup.output) : { data: null, isJson: false },
  [popup.output]
);
```

Then in the render, add a branch:

```tsx
{jsonResult.isJson ? (
  <div className="flex-1 overflow-auto p-3">
    <JsonTreeView
      jsonString={popup.output ?? ''}
      initiallyExpandedDepth={3}
      maxHeight="70vh"
    />
  </div>
) : (
  // existing syntax highlighter / virtualized code block
)}
```

### Imports

Add:
```typescript
import { JsonTreeView } from '@/components/ui/JsonTreeView';
import { tryParseJsonOutput } from './toolRenderers';
```

## Verification
```bash
bun run type-check -- packages/ui/src/components/chat/message/ToolOutputDialog.tsx
```

## Notes
- The dialog has more space than inline tool output, so expand to depth 3 initially
- Max height should be `70vh` (dialog is larger than inline)
- Keep existing fallback for non-JSON outputs
- The dialog may receive the output as part of `popup` prop — check the exact prop structure
