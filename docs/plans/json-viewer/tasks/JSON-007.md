# Task: JSON-007 - Add isJsonOutput helper to toolRenderers

## Metadata
- Status: pending
- Estimate: 15m
- Depends on: (none)

## Files to Modify
- `packages/ui/src/components/chat/message/toolRenderers.tsx`

## Description
Add a utility function that detects whether a tool's output string is valid JSON. This will be used by both ToolPart.tsx and ToolOutputDialog.tsx to decide whether to render the JSON tree viewer.

## Requirements

### Function to Add

```typescript
/**
 * Detects if the output string is a valid JSON object or array.
 * Returns the parsed value if valid, null otherwise.
 */
export const tryParseJsonOutput = (output: string): { data: unknown; isJson: boolean } => {
  if (!output || typeof output !== 'string') {
    return { data: null, isJson: false };
  }
  
  const trimmed = output.trim();
  
  // Quick check: must start with { or [
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { data: null, isJson: false };
  }
  
  // Must end with } or ]
  if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
    return { data: null, isJson: false };
  }
  
  // Minimum length sanity check
  if (trimmed.length < 2) {
    return { data: null, isJson: false };
  }
  
  try {
    const parsed = JSON.parse(trimmed);
    // Only accept objects and arrays (not primitives like `42` or `"hello"`)
    if (parsed !== null && typeof parsed === 'object') {
      return { data: parsed, isJson: true };
    }
    return { data: null, isJson: false };
  } catch {
    return { data: null, isJson: false };
  }
};
```

### Placement

Add after the existing `formatInputForDisplay` function (around line 29) and before `formatEditOutput`.

## Verification
```bash
bun run type-check -- packages/ui/src/components/chat/message/toolRenderers.tsx
```

## Notes
- Must be exported (used by ToolPart and ToolOutputDialog)
- Only detect objects/arrays, not JSON primitives (those are fine with syntax highlighter)
- Performance: JSON.parse is fast enough for typical tool outputs (<100KB)
- Edge case: tool outputs that START with JSON but have trailing text → trim handles this
