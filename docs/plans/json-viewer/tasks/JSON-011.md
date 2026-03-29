# Task: JSON-011 - Run type-check, lint, and build verification

## Metadata
- Status: pending
- Estimate: 15m
- Depends on: ALL (JSON-001 through JSON-010)

## Files to Modify
- (none - verification only)

## Description
Run the project's validation suite to ensure all changes pass TypeScript type checking, lint rules, and build successfully.

## Commands

```bash
cd /Users/nguyenngothuong/.local/share/opencode/worktree/4b2edf73188e5dc63cc6a1deb71c4c5eb0f87de2/bionic-jackal

# Type check
bun run type-check

# Lint
bun run lint

# Full build
bun run build
```

## What to Check

1. **Type-check**: No TS errors in any of the new/modified files
2. **Lint**: No ESLint violations (especially no `any` types, proper imports)
3. **Build**: All packages compile without errors

## If Errors Occur

1. Read the error message carefully
2. Fix in the relevant task file
3. Re-run the failing command
4. Do NOT proceed until all three pass

## Verification
All three commands must exit with code 0 (success).
