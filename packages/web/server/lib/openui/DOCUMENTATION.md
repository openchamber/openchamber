# OpenUI server integration

## Ownership

This module owns OpenUI prompt admission, saved-source verification,
instruction reads, and feature revocation through `runtime.js`.
The control service creates the runtime for prompt and answer routes.
`answers.js` owns live waits, JSON limits and exactly-once settlement. The official
`@openuidev/lang-core` parser and evaluator run through ordinary shared ESM
source in `packages/web/shared/`. Server code never imports the React catalog.

For prompt text, example or disclosure changes, read
[OpenUI context](context/DOCUMENTATION.md). It covers the context-as-skill mapping,
content sources and managed-tool delivery choice. Context sources, generation,
reading and tests live there; this module owns program admission and waits.
Media uses the existing stat/raw routes in `../fs/`; shared UI owns media
selection, format checks and each HtmlView's page budget.

## Invariants

- Instruction reads use fixed group names and module-relative assets. Missing,
  empty or oversized instruction assets return 503. The server requires the
  exported catalog at startup.
- `prompt_openui` waits in the runtime's session/call map. Its source revision is
  a SHA-256 digest of the complete UTF-8 program. The chat answers through
  `POST /api/openchamber/openui/answer`, with a summary of at most 500 characters
  and data of at most 16,000 characters as JSON. Settled or unknown calls return 404.
- Before announcing a wait, the runtime checks the calling session's inbox.
  An earlier user steer returns `chat-sent-earlier` with a note that the message
  was written without seeing the page. Queued and synthetic messages do not
  prevent waiting; an inbox read failure also leaves the prompt waiting.
  Disable and request cancellation still apply while the inbox read is pending.
- Answers must match the live revision and the saved `prompt_openui` input.
  Source reads page newest-first with the prompt request's abort signal. A
  complete read that finds a replaced or missing call returns 409 and retires
  that wait. A failed read returns 503 and leaves the wait available for retry.
  Feature disable returns 403 and cancels OpenUI waits, including requests still
  reading the setting or resolving the calling session's directory before
  admission. Re-enabling permits new prompts without
  reviving cancelled admissions. A late validation can
  settle or retire only the wait that started it.
- `bun run openui:generate` exports reference text and catalog schema/spec with
  one content-addressed revision. Catalog changes require regeneration and the
  live-schema parity test. Generation prepares all data before replacing files;
  failures must not publish placeholders. Builds and packaging use the checked-in
  assets; `gen.schema.json` is validator data, not injected prompt text.
- Official parser diagnostics retain component, property path, statement and
  signature details. Admission returns them through `OpenChamberControlError`
  before registering a wait. The existing agent-tool error envelope returns
  them to the model; this module creates no messages or automatic repair loop.
- Server-owned parser calls use the official telemetry disable flag.

## Decisions

### Why check the inbox before waiting

OpenCode delivers a steered message after the current tool call returns. Waiting
for a page answer would hold that earlier message back and let the page answer
reach the agent first. A queued message waits for the turn to end, so returning
the tool call does not deliver it.

### Why media uses existing file routes

Authenticated file reads already support outside-workspace paths. Re-reading
messages and parsing OpenUI on the server adds no file-read authorization.
Markdown and OpenUI share stat/raw loading and media validation in the UI.
Native media uses authenticated file URLs, and HtmlView retains its validation
of the bytes it embeds. Initial-source selection and complete-page budgets stay
with rendering. A separate media endpoint would duplicate file access.

### Why cancellation covers pending admission

Settings reads can return a stale enabled value after the disable callback has
cancelled existing waits. A runtime-local cancellation generation also retires
those pending admissions, including across a disable/re-enable cycle. Managed
prompts enter the runtime before directory resolution so that lookup belongs to
the same admission lifetime.

### Why export catalog data

The managed plugin runs in a server-only installation where React aliases and
UI development dependencies are unavailable. Exported schema/spec data keeps
the model instructions and server parser aligned with the actual UI library.

### Why shared ESM source

Both browser and server inspect complete programs through the official parser.
The UI owns Markdown parsing and canonical code-block closure checks.
The Web package ships the shared JavaScript and its declaration files through
its existing package contract; Docker copies that source and Electron uses its
Web dependency. This avoids a separate executable bundle or a copied parser.
