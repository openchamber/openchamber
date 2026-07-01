# OpenCode v1.17.12 SDK Migration

## Why this matters

OpenChamber currently runs on SDK v1.17.9. Version 1.17.12 adds several methods that directly fix real user-facing problems. Plus there are methods already in the SDK that we simply aren't using — and we should.

In short: **this is not a "bump the version" chore. It's concrete fixes for hangs, lag, and wasted tokens.**

---

## What actually improves for the user

### 1. The STOP button will actually stop generation

**Today:** when the user presses STOP, OpenChamber sends `session.abort()` to the server. The server marks the session as idle, but **does not cancel the HTTP request to the LLM provider** (OpenAI, Anthropic, etc.). The provider keeps generating, tokens keep burning, and the user thinks everything stopped. Worse — sometimes the abort itself hangs and never reaches the server (known OpenCode bug #29975).

**After the update:** `session.interrupt()` — new in v1.17.12 — doesn't just mark the session idle. It **actually tears down the HTTP request to the provider**. The provider stops generating, tokens stop burning, the session frees up immediately. This is the direct fix from OpenCode PR #34467.

**Where it gets better:** no more "I pressed STOP but it's still thinking for 10 more seconds."

---

### 2. Chat stops lagging when switching sessions

**Today:** all events from all sessions flow into a single global stream (`global.event()`). OpenChamber has to manually parse this firehose — 300+ lines of code in `sync-context.tsx` exist solely to figure out "which chat gets which event." This is slow, complex, and events occasionally leak into the wrong chat.

**After the update:** `session.events()` — new in v1.17.12 — lets us subscribe to events for **a single session**. The chat listens only to its own session. No global firehose parsing, no guessing "whose event is this."

**Where it gets better:**
- Session switching is instant, no lag
- Events don't "leak" between chats
- Lower CPU from event parsing (especially noticeable with 5+ open sessions)

---

### 3. Long sessions (100+ messages) load without freezing

**Today:** when loading message history, OpenChamber requests "the last N messages" via `session.messages({ limit: 50 })`. To load older messages, it requests "everything before message X" via `before`. This works, but:

- You can't say "give me the next page" — only "give me everything before X"
- Reopening a session reloads the same chunk from scratch
- No cursor — the server rescans history from the beginning every time

**After the update:** `Session3.messages({ cursor })` — the V2 API with cursor-based pagination (already in the SDK, but we use the old `Session2`). Works like flipping pages: load page 1 → get a cursor → request page 2 by cursor → server returns the continuation without rescanning.

**Where it gets better:**
- Long sessions open faster
- Scrolling up for history — smooth, no jank or redundant loads
- Less server load (no rescanning from scratch)

---

### 4. Targeted message fetch instead of loading the entire history

**Today:** when we need one specific message (e.g., for revert or fork), the code searches the already-loaded history. If the message isn't cached — the entire session history is loaded just to find one message.

**After the update:** `session.message({ messageID })` — this method already exists in SDK v1.17.9, but we don't use it. It fetches **one specific message by ID**, without loading the full history.

**Where it gets better:** revert and fork complete instantly, even when the session has been evicted from cache.

---

### 5. Permissions — programmatic create and fetch

**Today:** permissions are handled reactively — an SSE event `permission.asked` arrives, the UI shows a dialog, the user responds. Auto-accept works by iterating all pending permissions and calling `reply()`.

**After the update:** `session.permission.create` and `session.permission.fetch` — new in v1.17.12. Enables programmatic permission creation and status checks before responding. Useful for auto-accept: before auto-approving, we can verify the permission is still relevant.

**Where it gets better:** fewer false auto-accepts on already-answered permissions.

---

## What will NOT change (and why)

### Tool timeout hangs (issue #1950) — not fixable via SDK

The problem "tool hangs for 5 minutes → session silently dies → UI stuck on thinking" is an **OpenCode server bug**, not an SDK issue. No SDK method can force the server to emit `session.idle` when it doesn't. This can only be fixed in OpenCode itself (default timeout, stream watchdog, correct `session.idle` emission).

**What the SDK does help with:** `session.interrupt()` lets the user **manually** kill a hung tool via STOP. Previously STOP didn't guarantee provider cancellation — now it does.

---

## Phase plan

| # | What | Priority | Effort | User impact |
|---|------|----------|--------|-------------|
| 1 | `session.interrupt()` replaces `session.abort()` | 🔴 High | Small | STOP actually stops generation |
| 2 | `session.events()` — per-session event subscription | 🔴 High | Medium | No lag on session switch, no event leaks |
| 3 | `session.message()` — targeted message fetch | 🟡 Medium | Small | Revert/fork without loading full history |
| 4 | `Session3.messages()` — cursor pagination | 🟡 Medium | Medium | Long sessions load without freezing |
| 5 | `session.permission` — programmatic endpoints | 🟢 Low | Small | More reliable auto-accept |

---

## What already works — don't touch

- `global.event()` — global event stream. Used, works, no changes needed.
- Custom WebSocket/SSE in `event-pipeline.ts` — this is OpenChamber-specific wrapping (coalescing, routing, backpressure), not an SDK replacement. Stays as-is.

---

## Validation

| Phase | Command |
|-------|---------|
| 1-5 | `bun run type-check` in affected packages |
| 1 | `bun test packages/ui/src/sync/session-actions.test.ts` |
| 2 | Manual: open a session, send a message, switch sessions — events don't leak |
| 3-4 | Manual: load a session with 100+ messages, scroll up — smooth, no jank |
| 5 | Manual: verify auto-accept permissions |

---

## References

- OpenCode v1.17.12 release: https://github.com/anomalyco/opencode/releases/tag/v1.17.12
- OpenChamber issue #1950: https://github.com/openchamber/openchamber/issues/1950
- SDK types: `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts`
