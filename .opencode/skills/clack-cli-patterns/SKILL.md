---
name: clack-cli-patterns
description: Use when creating or modifying terminal CLI commands, prompts, or output formatting in OpenChamber. Enforces Clack UX standards with strict parity and safety across TTY/non-TTY, --quiet, and --json modes.
license: MIT
compatibility: opencode
---

## Overview

OpenChamber terminal CLI uses `@clack/prompts` for interactive UX, but command policy and validation must be mode-agnostic.

**Core principle:** policy-first, UX-second. Clack is presentation, not enforcement.

## Scope

Use this skill for terminal CLI work only (for example `packages/web/bin/*`).

Do not use this skill for web UI or VS Code webview styling work.

## Mandatory Rules

1. **Validation first**
   - Safety and correctness checks must run in all modes.
   - Prompts may help collect input, but cannot be the only guard.

2. **Mode parity is required**
   - Behavior must be equivalent in:
     - Interactive TTY
     - Non-interactive shells
     - `--quiet`
     - `--json`
     - Fully pre-specified flags
   - Invalid operations must fail deterministically with non-zero exit code.

3. **Prompt guard contract**
   - Only prompt when all are true:
     - stdout is TTY
     - not `--quiet`
     - not `--json`
     - not automated/non-interactive context

4. **Output contract**
   - `--json`: machine-readable output only.
   - `--quiet`: suppress non-essential output only.
   - Neither mode weakens policy enforcement.

5. **Cancellation contract**
   - Handle prompt cancellation with `isCancel` + `cancel(...)`.
   - Handle SIGINT cleanly and use consistent exit semantics.

## Clack Primitive Standard

- **Flow framing:** `intro`, `outro`, `cancel`
- **Status lines:** `log.info`, `log.success`, `log.warn`, `log.error`, `log.step`
- **Guidance blocks:**
  - default: `note`
  - high-severity warnings only: `box`
- **Prompts:** `select`, `confirm`, `text`, `password`
- **Long-running feedback:**
  - unknown duration: `spinner`
  - known duration: `progress`
  - multi-stage: `tasks`

## Preferred Pattern

Centralize Clack imports and formatting helpers in one adapter module (for example `cli-output.js`) so command logic stays focused on behavior and policy.

## Copy/Paste Snippets

### Prompt Guard

```js
const shouldPrompt = !options.json && !options.quiet && isTTY;
if (shouldPrompt) {
  const value = await select({
    message: 'Choose an option',
    options: [{ value: 'a', label: 'Option A' }],
  });
  if (isCancel(value)) {
    cancel('Operation cancelled.');
    return;
  }
}
```

### Non-Interactive Fallback

```js
if (!resolvedValue) {
  if (!options.json && !options.quiet && isTTY) {
    // prompt path
  } else {
    throw new Error('Missing required value. Provide --flag <value>.');
  }
}
```

### Spinner Guard

```js
const useSpinner = !options.json && !options.quiet && isTTY;
const spin = useSpinner ? spinner() : null;
spin?.start('Running operation...');
// ...work...
spin?.stop('Done');
```

### JSON vs Human Output

```js
if (options.json) {
  console.log(JSON.stringify({ ok: true, data }, null, 2));
  return;
}

intro('Operation');
log.success('Completed');
outro('done');
```

## Implementation Checklist

1. Add or update core validators first.
2. Ensure validators execute in all modes.
3. Add interactive Clack UX only as enhancement.
4. Verify parity between interactive and non-interactive flows.
5. Ensure script-safe deterministic failure behavior.

## References

- Policy source: `AGENTS.md` (CLI Parity and Safety Policy)
- Terminal CLI precedent: `packages/web/bin/cli.js`
- Output adapter precedent: `packages/web/bin/cli-output.js`
