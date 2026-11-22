# TODO

- [ ] Supervisor process for upgrades. A small supervisor process owning the managed OpenCode children and the listening socket was the first plan for upgrades with no dropped OpenCode sessions and no port change. Issue #81 shipped the other route instead: the self-handoff takes over to a newer install (handoff protocol 2, with a hello and go exchange before the successor listens, and a rollback that takes the OpenCode claim back), so an upgrade needs no supervisor and no systemd `.socket` unit. The open questions from the first draft are answered by the shipped design: the predecessor keeps the socket until the successor is ready, the hello carries the protocol and state versions, and a failed successor is killed while the predecessor keeps serving. What is left in this item: decide whether a supervisor is still wanted for cases the handoff cannot cover, such as replacing the socket itself.

- [ ] Versioned state store and explicit handoff protocol for managed OpenCode. `state.json` and `draining.json` are version-1 files with ad-hoc validation, and the handoff is inferred from the state at startup rather than from a recorded protocol step. Replace them with one versioned store that records each OpenCode generation (pid, port, binary, args, fingerprint, state: starting, active, draining, closed) and a write-ahead handoff record (predecessor, successor, busy set at switch, outcome). The store needs a migration path from version 1, a reaper that reads it instead of inferring ownership from `ps`, and tests that replay a crash between each step.

- [ ] Anti-slop lint backlog. `bun run lint:anti-slop` (the vendored oxlint plugin in `tools/oxlint/anti-slop`) reports 9,498 errors in 1,086 files, measured 2026-10-11. The counts come from `oxlint --format json`, grouped by rule code and by `packages/<name>`. `check:changed` only stops changed files from gaining findings, so this number falls only when someone works the backlog.

  Every rule asks for a named domain type, a parse at an I/O boundary, or a stated invariant. Lowering severity, silencing a rule, or adding `SAFETY:` comments that do not state a checked invariant does not fix a finding.

  | Rule | Findings | Fix shape |
  |---|---:|---|
  | `no-runtime-typeof` | 4,801 | Parse at the I/O boundary, then branch on the domain value |
  | `require-safety-comment-for-type-assertion` | 2,355 | Remove the assertion, or state the invariant it relies on |
  | `no-unsafe-dictionary-type` | 630 | Owner or schema-derived value type |
  | `no-unknown-parameters` | 500 | Named domain parameter type |
  | `no-conditional-empty-object-spread` | 489 | Build the object in separate statements |
  | `no-known-value-widening` | 410 | Keep inference, or check with `satisfies` |
  | `no-chained-type-assertions` | 189 | Keep the precise type, or parse before narrowing |
  | `no-unknown-returns` | 80 | Named domain return type |
  | `no-module-mocking` | 36 | Dependency injection through a real interface |
  | `no-shape-in-symbol-names` | 3 | Rename for the domain role |
  | `no-object-parameters` | 5 | Named owner type |
  | **Total** | **9,498** | |

  By package: `packages/ui` 5,295, `packages/web` 2,613, `packages/vscode` 1,290, `packages/electron` 221, `scripts` 40, `packages/sdk` 39. The largest files are `packages/vscode/src/quotaProviders.ts` (242), `packages/web/server/lib/opencode/settings-helpers.js` (208), `packages/vscode/src/opencodeConfig.ts` (183), `packages/ui/src/sync/session-actions.test.ts` (161), and `packages/electron/main.mjs` (121).

  Auto-fix: none. No rule in the plugin defines a fixer, so `oxlint --fix` changes none of these. Each fix needs a type or a decision, so the edits are made by hand, with `check:changed` run after each file.

  Phased plan, cheapest first:
  1. Mechanical and behavior-neutral, about 520 findings: `no-shape-in-symbol-names`, `no-conditional-empty-object-spread`, `no-object-parameters`. Check each rename against its consumers, and keep exports in step with knip. Cleared so far: 22 of the 25 shape findings and 1 of the 6 object-parameter findings. The three shape findings left are zod's `ZodObject.shape` reads in `packages/web/server/lib/spaces/journey.js`, a library API that a rename would break. The five object-parameter findings left need a type decision or take deliberately malformed test input. `no-conditional-empty-object-spread` is untouched, because the fix depends on whether each consumer tells a missing key from an explicit `undefined`, so every site needs a read of its consumer.
  2. Owner types at signatures and call sites, about 1,800 findings: `no-unknown-returns`, `no-unknown-parameters`, `no-unsafe-dictionary-type`, `no-chained-type-assertions`, `no-known-value-widening`. Work one module at a time, the stores first. All 189 `no-chained-type-assertions` findings are `as unknown as` casts, and each one needs the value's real type before the cast can go.
  3. Boundary parsing and invariants, about 7,200 findings: `no-runtime-typeof`, `require-safety-comment-for-type-assertion`, `no-module-mocking`. Each boundary needs a schema or a written invariant, so this phase needs a design pass before the edits. The 36 `no-module-mocking` findings are all in test files, and each mock needs a dependency seam in production code.

  Work the backlog with `bun run deslop -- next-batch`, which claims a batch of files, and `bun run deslop -- release --run <run-id>` when the batch is done.
