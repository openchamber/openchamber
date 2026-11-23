# CLI entry and output

## Ownership

This folder owns execution detection, command wiring, process error handlers and
the terminal output adapter. `lib` owns command implementations and parsing.
`cli.js` remains a JavaScript bootstrap so plain Node registers the source hook
before loading TypeScript through the existing `.js` import specifiers.

## Invariants

- Execution detection resolves symlinks and retains the `openchamber` wrapper-name
  fallback. Missing, non-string and blank entry values fail detection.
- JSON output copies non-array objects, wraps other values in `data` and preserves
  explicit status fields, including invalid ones. Message arrays are checked at
  runtime before their entries contribute warning or error status.
- Provider names are trimmed and lowercased. Icon lookup retains ordinary object
  lookup semantics, including inherited properties.
- Prompts require both input and output TTYs and are disabled in JSON and quiet
  modes. Progress receives the installed Clack configuration type.

## Decisions

### Why external representation checks remain

Entry paths, environment paths, provider names, JSON envelopes and message arrays
cross file, process or JavaScript boundaries. Their original checks remain.
The JSON envelope guard establishes only the container; its `messages`, `status`
and `data` properties remain unchecked until consumed.

### Why the command table is built from named factory results

The command factories run in their original order, then one object literal
lists the commands in their original key order. The factories receive the
serve and stop functions directly instead of copies bound to the command
table: neither function reads `this`, and `restart` still reads `stop` and
`serve` from the table it is called on. Dispatch accepts a command name with
`in`, so inherited property names reach the same call as before.

### Why the CLI login-shell probe names two failing dependencies

`checkOpenCodeCLI` only calls `applyLoginShellEnvSnapshot` on its OpenCode
environment runtime. The runtime contract requires a directory normalizer and
a settings reader that only binary-resolution paths use. The CLI passes
functions that throw the same `TypeError` a missing function would, so the
contract holds without a settings dependency the CLI never had.
