# Task: JSON-008 - Integrate JsonTreeViewer into ToolScrollableTextOutput

## Metadata
- Status: pending
- Estimate: 25m
- Depends on: JSON-003, JSON-007

## Files to Modify
- `packages/ui/src/components/chat/message/parts/ToolPart.tsx`

## Description
Modify the `ToolScrollableTextOutput` component (line 527-559) to detect JSON output and render `JsonTreeViewer` instead of `SyntaxHighlighter` when the output is valid JSON.

## Requirements

### Detection Logic

In `ToolScrollableTextOutput` component, before the `SyntaxHighlighter` render, add:

```typescript
const jsonResult = tryParseJsonOutput(output);
```

### Conditional Render

```tsx
// If output is valid JSON, show tree viewer
if (jsonResult.isJson) {
  return (
    <div className="tool-output-surface p-2 rounded-xl w-full min-w-0">
      <JsonTreeViewer
        data={jsonResult.data}
        initiallyExpandedDepth={1}
        maxHeight="400px"
      />
    </div>
  );
}

// Otherwise, existing SyntaxHighlighter render
return (
  <div className={...}>
    <SyntaxHighlighter ...>
```

### Imports

Add to imports at top of ToolPart.tsx:
```typescript
import { JsonTreeViewer } from '@/components/ui/JsonTreeViewer';
import { tryParseJsonOutput } from '../toolRenderers';
```

## Verification
```bash
bun run type-check -- packages/ui/src/components/chat/message/parts/ToolPart.tsx
```

## Notes
- The detection should happen ONCE per render (output string doesn't change often)
- Use `useMemo` if performance is a concern: `const jsonResult = React.useMemo(() => tryParseJsonOutput(output), [output])`
- Keep the existing fallback: if not JSON, use SyntaxHighlighter as before
- Max height should be reasonable for inline display (400px)
- Initially expand to depth 1 only (tool outputs can be large)
