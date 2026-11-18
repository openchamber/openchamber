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

### Why the CLI runtime remains JavaScript

The shared Knip configuration includes `bin/**/*.js` in the web project and
omits TypeScript. Converting `cli-runtime.js` makes Knip miss its imports and
report 20 live exports from `bin/lib` as unused, including `createServeCommand`
and `createTunnelCommand`. The coordinator must include TypeScript in the shared
project configuration before this runtime can pass the unchanged gate.
