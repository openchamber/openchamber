---
name: commander-cli-patterns
description: Use when creating or modifying OpenChamber CLI flag parsing, per-command option schemas, help text, or command dispatch tables.
license: MIT
compatibility: opencode
---

## Overview

OpenChamber CLI uses commander as its parsing layer. `packages/web/bin/lib/cli-commander.js` is the single source of truth for which flags each command accepts.

**Core principle:** schema-first. The flag pool decides what parses, `cli-args.js` decides what values mean, command modules decide what happens.

## Scope

Use this skill for CLI flag/schema/help/dispatch work: `cli-commander.js`, `cli-args.js` (parsing and `show*Help` functions), and the `commandDispatch` table in `cli.js`.

Output parity across modes (`--quiet`, `--json`, non-TTY), prompts, and rendering belong to `clack-cli-patterns`.

## Commander Containment

Commander never prints and never exits.

- Build `Command` instances with `exitOverride()` and call `parseOptions(tokens)`; use the returned `{ opts, unknown }`.
- Declare every value-taking option with optional `[value]` syntax (for example `--host [address]`) so a missing argument never triggers commander's own exit.
- Enforce required values in `cli-args.js` (`REQUIRED_VALUE_FLAGS`: `--port`, `--host`, `--server`) so usage messages stay stable across modes, including the `-p -1` negative-value lookahead.

## Flag Pools

`GLOBAL_OPTION_FLAGS` apply to every command (`--port`, `--host`, `--ui-password`, `--json`, `--quiet`, `--plain`). `COMMAND_OPTION_FLAGS[command]` lists command-specific flags, derived from what the command module actually consumes.

### Per-subcommand pools

When subcommands consume different flags, give each a dedicated `<command> <sub>` key and export the subcommand names (`TUNNEL_SUBCOMMAND_NAMES`, `STARTUP_SUBCOMMAND_NAMES`); `cli-args.js` resolves the pool key from the parsed positionals. The base command key stays the union pool, used for its `--help` overview and unknown subcommands.

Example: `tunnel start` accepts `--dry-run`; `tunnel status` fails with `Unknown option '--dry-run' for command 'tunnel status'.`

### Unknown and removed flags

- Unknown flags flow through `removedFlagErrors` (exit 1 in every mode), named against the resolved pool with a closest-match suggestion from that pool. Flags typed before any known command omit the command context.
- Removed flags (`--tunnel-qr`, `--try-cf-tunnel`, ...) keep their migration message on any command and are stripped before commander parsing.

## Help Structure

- Bare `openchamber --help` renders the global overview (`showHelp()`, guarded by `commandExplicit`); a command present always renders that command's help.
- Every command owns a `show<Command>Help()` function. Multi-action commands accept a focus argument and render focused help per action or subcommand (`openchamber session list --help`, `openchamber tunnel start --help`), falling back to a compact overview that lists commands and points to focused help.
- Overviews list the `COMMANDS:` block first, then a `FOCUSED HELP:` pointer, then only genuinely shared options. A subcommand's flags appear only in its own focused help.
- Use `COMMANDS:` as the header everywhere; avoid `ACTIONS:`/`SUBCOMMANDS:`.

## Dispatch

`cli.js` routes through the `commandDispatch` table (`run`/`help` per entry); its keys are the source of truth for unknown-command suggestions. Wire a new command in three places: its flag pool, its dispatch entry, and its help function.

## Adding a Flag

1. Add it to the owning pool in `cli-commander.js` (command key or per-subcommand key).
2. Map the commander option onto the flat options bag in `cli-args.js`.
3. Update the owning help text so the flag appears only under the command that consumes it.
4. Extend the completion scripts in `cli-args.js` when the flag should complete.

Complete when the flag parses in every mode, wrong-command use fails with a suggestion, help shows it only under its owner, and `bun run test -- bin/` passes from `packages/web`.

## References

- Precedent: `packages/web/bin/lib/cli-commander.js`, `packages/web/bin/lib/cli-args.js`
- Output parity and interactive UX: `clack-cli-patterns`
- Module map: `packages/web/bin/lib/DOCUMENTATION.md`
