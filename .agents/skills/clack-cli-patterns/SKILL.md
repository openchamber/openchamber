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

### Thin framework (recommended)

Use a small shared helper surface rather than command-specific formatting logic.

- `isJsonMode(options)`
- `isQuietMode(options)`
- `shouldRenderHumanOutput(options)`
- `canPrompt(options)`
- `createSpinner(options)`
- `createProgress(options, config)`
- `printJson(payload)`

Keep this layer minimal. Do not hide core validation or command semantics inside output helpers.

## Output Contracts by Mode

### `--quiet` contract

`--quiet` should still return essential result data.

- Read/list commands: emit concise machine-friendly lines (not framed Clack blocks).
- Action commands: emit one minimal success line and concise errors.
- Do not suppress required outcomes entirely.

Quiet output should still be complete enough for scripts and quick human scanning.

- Status-like commands should list all active items, not only `running`/`ok`.
- Prefer compact stable key tokens in quiet lines (for example `port 3000 pass:yes`).

### `--json` contract (strict)

- Output must be JSON only (no extra text before/after payload).
- Warnings/info should be represented in JSON fields (for example `status`, `messages`).
- Preserve non-zero exit codes for failures.

## Human UX Consistency

### Framing completeness

- If human flow uses `intro`, close with `outro` (or `outro('')` when you want structure without text).
- Avoid orphan frame/spinner artifacts (prefer `spinner.clear()` when a trailing spinner line is not wanted).
- If a structured summary section immediately follows a spinner, prefer `spinner.clear()` to avoid duplicate success lines.

### Progress feedback for visible operations

- For operations users wait on (start/stop/restart/tunnel lifecycle), show in-progress spinner in interactive mode.
- Resolve each spinner explicitly to done/error so users can see completion state at the same visual location.
- Keep quiet/json modes non-animated.

### Prompt flow design

- Ask required inputs in dependency order (for example hostname before token when token depends on chosen host/mode context).
- When offering save-vs-run flows, ask intent before collecting optional metadata (for example profile name only if user chooses save).
- Prefill editable values with `initialValue` (not only `placeholder`) so users can accept or edit quickly.
- Reuse latest relevant values when safe (for example last managed-local config path, last managed-remote hostname).

### Readability on narrow terminals

- Prefer short lines.
- Split long guidance into multiple detail lines.
- Use warning/info codes (`[CODE]`) when the message has follow-up docs or repeat use.

### Guidance tone

- Use `Optional Tips` for non-required next actions.
- Avoid wording that implies mandatory follow-up unless it is truly required.

### Guidance rendering style (preferred)

- Prefer structured status lines for reusable hints:
  - `logStatus('info', '[CODE]', '<actionable command or short guidance>')`
- Use short, stable codes (for example `[START_PROFILE]`, `[PORT_MISMATCH]`) so users can quickly scan and recognize repeated guidance.
- Prefer this style over boxed notes for routine follow-up actions.
- Reserve `note`/boxed callouts for rare, high-context guidance where a long paragraph is truly necessary.

## Parity Verification Matrix

For each command/subcommand, manually verify:

1. default interactive TTY output
2. `--quiet` output (minimal but informative)
3. `--json` output (JSON-only)
4. non-TTY behavior (e.g. piped)
5. error path in both human and json modes

## Copy/Paste Snippets

### Prompt Guard

```js
if (canPrompt(options)) {
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
  if (canPrompt(options)) {
    // prompt path
  } else {
    throw new Error('Missing required value. Provide --flag <value>.');
  }
}
```

### Spinner Guard

```js
const spin = createSpinner(options);
spin?.start('Running operation...');
// ...work...
spin?.stop('Done');
```

### JSON vs Human Output

```js
if (options.json) {
  printJson({ ok: true, data });
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
