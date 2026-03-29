# Task: JSON-001 - Create JSON tree types and parse utility

## Metadata
- Status: pending
- Estimate: 30m
- Depends on: (none)

## Files to Modify
- `packages/ui/src/lib/jsonTreeUtils.ts` (CREATE)

## Description
Create the foundational types and utility functions for the JSON tree viewer. This module handles parsing JSON text into a tree structure and provides path utilities for collapse state tracking.

## Requirements

### Types to Define

```
Interface JsonTreeNode:
  - id: string (unique path like "root.data[0].name")
  - key: string (display key name)
  - value: unknown (original value)
  - type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  - depth: number (nesting level, 0-based)
  - children?: JsonTreeNode[] (only for object/array)
  - path: string[] (array of path segments)
  - isExpandable: boolean

Interface FlatJsonNode:
  - node: JsonTreeNode
  - isExpanded: boolean
  - isVisible: boolean

Type JsonTreeOptions:
  - maxDepth?: number (default: 50, for safety)
  - maxNodes?: number (default: 100000, for safety)
  - initiallyExpandedDepth?: number (default: 2)
```

### Functions to Implement

1. `parseJsonToTree(text: string, options?: JsonTreeOptions): JsonTreeNode | null`
   - Parse JSON text and build tree structure
   - Return null for invalid JSON
   - Apply maxDepth/maxNodes limits

2. `flattenTree(root: JsonTreeNode, collapsedPaths: Set<string>): FlatJsonNode[]`
   - Convert tree to flat list of visible nodes
   - Skip children of collapsed nodes
   - Used for virtualization

3. `getNodePath(pathSegments: string[]): string`
   - Convert path array to string key (e.g., `["data", "items", "0"]` → `root.data.items[0]`)

4. `parseNodePath(pathKey: string): string[]`
   - Reverse of getNodePath

5. `isJsonParseable(text: string): boolean`
   - Quick check if text is valid JSON (try/catch with trim and first-char check)

## Verification
```bash
bun run type-check -- packages/ui/src/lib/jsonTreeUtils.ts
```

## Notes
- Keep this file pure (no React, no DOM)
- Handle edge cases: empty strings, `undefined`, circular references (use seen Set)
- The path format `root.data[0].name` should be consistent with `getNodePath` output
