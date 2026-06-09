# Review Flow Implementation Plan

## Goal

Build an end-to-end OpenChamber review handoff flow that lets one session implement changes and another normal session review them, with OpenChamber metadata connecting the two sessions invisibly.

The agents must not see session IDs, metadata, linked-session wording, or routing details. They should only receive natural prompts:

- Review session initial prompt: a handoff plus an instruction to review it.
- Review-to-implementer prompt: another agent reviewed the changes and left feedback; resolve relevant issues.
- Implementer-to-review prompt: the agent implementing changes responded to previous feedback; review latest state again.

The review session is not a child/subsession. It is a normal session in the same directory as the original session.

## Proposed Command Name

Do not use `/review`, because that overlaps with OpenCode's default review command semantics.

Use `/handoff-review` unless we choose a shorter name before implementation.

Other acceptable names if `/handoff-review` feels too long:

- `/review-handoff`
- `/ask-review`
- `/start-review`

This plan assumes `/handoff-review`.

## Existing Code Paths To Reuse

### Slash Command Routing

Relevant files:

- `packages/ui/src/sync/session-ui-store.ts`
- `packages/ui/src/lib/opencode/client.ts`
- `packages/ui/src/lib/magicPrompts.ts`

Current behavior:

- `routeMessage(...)` detects messages starting with `/`.
- It checks command metadata from `getDirectoryState(requestDirectory)?.command` and `useCommandsStore.getState().commands`.
- If the command exists, it uses `optimisticSend(...)` and calls `opencodeClient.sendCommand(...)`.
- `opencodeClient.sendCommand(...)` calls SDK `client.session.command(...)` with `sessionID`, `command`, `arguments`, selected model, selected agent, variant, files, and client-generated `messageID`.

Reuse this for invoking the handoff-generation command. The review flow should not invent a separate command transport.

### Magic Prompt Registry

Relevant file:

- `packages/ui/src/lib/magicPrompts.ts`

Current examples:

- `session.summary.visible`
- `session.summary.instructions`
- `session.review.visible`
- `session.review.instructions`
- `git.commit.generate.visible`
- `git.commit.generate.instructions`

Add new prompt entries for this flow instead of hardcoding long prompts in components/actions.

Needed prompt entries:

- `session.reviewHandoff.visible`
- `session.reviewHandoff.instructions`
- `session.reviewSession.visible`
- `session.reviewSession.instructions` if we need hidden instructions for the review session starter prompt
- `session.reviewFeedbackToImplementer.visible`
- `session.implementationResponseToReviewer.visible`

The two cross-session prompts must match the agreed wording closely.

Review feedback sent back to the original session:

```md
Another agent reviewed your changes and left the feedback below.

Please review the feedback, resolve the relevant issues, and explain what you changed.

<review feedback>
```

Implementation response sent back to the review session:

```md
The agent implementing the changes has responded to the previous review feedback.

Please review the latest state again and report any remaining issues.

<implementation response / latest assistant message>
```

Initial review session prompt should be similar to:

```md
Please review the changes described in this handoff.

Focus on correctness, regressions, missing implementation, missing tests, and whether the implementation satisfies the stated intent. Provide concise, actionable feedback for the agent implementing the changes.

<handoff>
```

The handoff-generation prompt should be based on the summary command, but explicitly include the user's intent and enough implementation context for another agent to review.

### Handoff Generation Concept

Relevant existing prompt:

- `session.summary.instructions` in `packages/ui/src/lib/magicPrompts.ts`

Current summary instructions already include:

- completed work
- in-progress work
- modified files and why
- open questions and next steps
- user requests, constraints, preferences
- technical decisions and rationale

The new handoff prompt should keep those ideas and make intent explicit:

- What the user wanted and why
- What was implemented
- What files changed and why
- Important design choices
- Known limitations or uncertainty
- Validation/test status if known from the session
- Anything the reviewer should pay special attention to

This is an implementation detail, not a risk. The prompt should be specific enough that the review agent can judge intent and implementation without needing private OpenChamber routing context.

### Active Session Generation Concept

Relevant files:

- `packages/ui/src/lib/gitApi.ts`
- `packages/ui/src/components/views/GitView.tsx`

Current commit-message generation uses:

- `resolveSessionGenerationContext()` to find current session, model, agent, and variant.
- `runStructuredGenerationInActiveSession(...)` to send a visible prompt plus hidden synthetic instructions to the active session.
- `extractAssistantText(...)` and JSON parsing to get output from the assistant response.

Important difference for review flow:

- Commit generation uses `client.session.prompt(...)` and receives the response directly.
- Slash commands use `client.session.command(...)`, are effectively fire-and-forget from the UI path, and rely on SSE to populate messages/status.

For `/handoff-review`, prefer the visible slash command path so the original session contains the generated handoff. Then wait for the resulting assistant output through sync state. Reuse the commit-generation concepts for:

- selected model/agent/variant resolution
- extracting text from assistant message parts
- forcing chat scroll if useful
- timeout/error handling style

Create a small reusable helper for waiting for the next completed assistant text after a known user command message ID.

### Session Create/Update/Delete

Relevant files:

- `packages/ui/src/lib/opencode/client.ts`
- `packages/ui/src/sync/session-actions.ts`
- `packages/ui/src/sync/event-reducer.ts`
- `packages/ui/src/stores/useGlobalSessionsStore.ts`

Current behavior:

- `opencodeClient.createSession(...)` calls `client.session.create(...)` using the legacy OpenCode session API.
- OpenCode supports `metadata` on that API, but OpenChamber currently only forwards `parentID` and `title`.
- `opencodeClient.updateSession(...)` currently only forwards `title` and `time.archived`.
- OpenCode `metadata` update replaces the whole metadata object. It does not deep-merge.
- `deleteSession(...)` and `deleteSessionInDirectory(...)` optimistically remove the session, then call `opencodeClient.deleteSession(...)`, and restore snapshots on failure.
- `event-reducer.ts` replaces session objects from `session.created` and `session.updated` events.

Add metadata support here first. The review flow depends on it.

### Context Panel Session Tabs

Relevant files:

- `packages/ui/src/stores/useUIStore.ts`
- `packages/ui/src/components/session/sidebar/SessionNodeItem.tsx`
- `packages/ui/src/components/layout/ContextPanel.tsx`
- `packages/ui/src/components/chat/message/MessageBody.tsx`
- `packages/ui/src/components/chat/message/parts/ToolPart.tsx`

Current behavior:

- `useUIStore.openContextPanelTab(directory, tab)` opens or upserts context panel tabs.
- Chat tabs use `mode: 'chat'`.
- Existing dedupe key convention for session chat tabs is `session:<sessionID>`.
- Sidebar already opens a session in the side panel with:

```ts
openContextPanelTab(sessionDirectory, {
  mode: 'chat',
  dedupeKey: `session:${session.id}`,
  label: sessionTitle,
})
```

Reuse the same convention for opening the review session in the context panel.

### Assistant Message Action Buttons

Relevant file:

- `packages/ui/src/components/chat/message/MessageBody.tsx`

Current behavior:

- `AssistantMessageActionButtons` renders icon-only buttons for copy, save image, and TTS.
- The buttons use shared `Button`, `Tooltip`, and `Icon` components.
- The shared icon sprite already contains `arrow-left-right`.

Extend this action area with an optional review-transfer action. Do not import icons directly from Remixicon.

## Metadata Contract

Use a namespaced metadata object so we do not collide with user or upstream metadata.

Original session metadata:

```ts
{
  openchamber: {
    reviewSessionID: string
  }
}
```

Review session metadata:

```ts
{
  openchamber: {
    kind: 'review'
    originalSessionID: string
  }
}
```

Rules:

- Only one review session per original session.
- If original metadata already has `openchamber.reviewSessionID`, reuse that session instead of creating a new review session.
- The review session must not have `parentID` set to the original session.
- Both sessions must stay in the same directory.
- Metadata is internal routing state only. Never include it in prompts.
- Metadata updates must preserve unrelated metadata keys.

Recommended helpers:

```ts
type OpenChamberSessionMetadata = {
  openchamber?: {
    kind?: 'review'
    originalSessionID?: string
    reviewSessionID?: string
  }
  [key: string]: unknown
}
```

Helper functions should live in a focused module, for example:

- `packages/ui/src/lib/sessionReviewMetadata.ts`

Functions:

- `getOpenChamberMetadata(session)`
- `isReviewSession(session)`
- `getOriginalSessionID(session)`
- `getReviewSessionID(session)`
- `withReviewSessionLink(metadata, reviewSessionID)`
- `withReviewSessionMarker(metadata, originalSessionID)`
- `withoutReviewSessionLink(metadata, reviewSessionID)`

The helpers should clone only the metadata branch they change and preserve all unrelated metadata.

## Implementation Steps

### 1. Load Required Skills Before Editing

When implementing this plan, load these skills before changing code:

- `ui-api-decoupling` because the work changes SDK data access and session API wrapper behavior.
- `theme-system` because the work adds a UI button/icon.
- `locale-ui-patterns` because the work adds tooltips, aria labels, toasts, and command text.

If the final implementation touches Settings magic prompt UI, also load:

- `settings-ui-patterns`

### 2. Add Metadata Support To OpenCode Client Wrapper

File:

- `packages/ui/src/lib/opencode/client.ts`

Change `createSession` signature from:

```ts
async createSession(params?: { parentID?: string; title?: string }, directory?: string | null): Promise<Session>
```

to:

```ts
async createSession(
  params?: {
    parentID?: string
    title?: string
    metadata?: Record<string, unknown>
  },
  directory?: string | null,
): Promise<Session>
```

Forward `metadata: params?.metadata` only when it is defined.

Change `updateSession` patch type from:

```ts
patch: { title?: string; time?: { archived?: number | null } }
```

to:

```ts
patch: {
  title?: string
  metadata?: Record<string, unknown>
  time?: { archived?: number | null }
}
```

Forward `metadata` when defined.

Important: this method should still replace metadata because the upstream API replaces metadata. Do not hide this with an implicit merge here. Add merge behavior in a separate helper so call sites are explicit.

### 3. Make Session Types Metadata-Aware In OpenChamber

OpenCode SDK response types should include metadata in the current v2 SDK legacy `Session`, but verify local imports and generated types used by OpenChamber.

Files to inspect/update:

- `packages/ui/src/stores/types/sessionTypes.ts`
- Any local `Session` wrapper/normalizer if present
- `packages/ui/src/sync/sanitize.ts`
- `packages/ui/src/sync/event-reducer.ts`
- `packages/ui/src/stores/useGlobalSessionsStore.ts`

Goal:

- `session.metadata` should survive list, get, create, update, SSE event replacement, global sessions, and reconnect recovery.
- Do not strip `metadata` in sanitation helpers.
- Do not create new broad store subscriptions. Use leaf selectors where UI only needs review metadata for one session.

### 4. Add Explicit Metadata Merge Helpers

Add a helper, likely in `packages/ui/src/sync/session-actions.ts` or a small module imported by it:

```ts
async function patchSessionMetadata(
  sessionId: string,
  directory: string | null | undefined,
  updater: (metadata: Record<string, unknown>) => Record<string, unknown>,
): Promise<Session>
```

Behavior:

1. Read the current session with `opencodeClient.getSession(sessionId)` using the correct directory.
2. Read `current.metadata ?? {}`.
3. Apply updater.
4. Call `opencodeClient.updateSession(sessionId, { metadata: nextMetadata }, directory)`.
5. Upsert the returned session into `useGlobalSessionsStore` and the relevant child store if needed.

Do not swallow fetch/update errors. Callers need to know if metadata linkage failed.

### 5. Add Review Flow Magic Prompts

File:

- `packages/ui/src/lib/magicPrompts.ts`

Add these prompt records:

1. `session.reviewHandoff.visible`

Suggested template:

```txt
Prepare a handoff for another agent to review this work.
```

2. `session.reviewHandoff.instructions`

Suggested template:

```txt
Produce a review handoff for another agent. Do not compact or mutate session history. Your output is an assistant message that OpenChamber will send to a separate reviewer agent.

Include:
- The user's original intent and any later clarifications that changed the intent
- What was implemented and why
- Files changed, with brief purpose per file
- Important design decisions and tradeoffs
- Validation/tests run, if known
- Known gaps, uncertainty, or areas the reviewer should inspect closely

Formatting:
- Concise markdown with clear sections
- No preamble like "Here is a handoff"
- Do not mention OpenChamber metadata, linked sessions, session IDs, or routing
- Respond in the same language the user used most in the conversation
```

3. `session.reviewSession.visible`

Suggested template with `{{handoff}}` placeholder:

```txt
Please review the changes described in this handoff.

Focus on correctness, regressions, missing implementation, missing tests, and whether the implementation satisfies the stated intent. Provide concise, actionable feedback for the agent implementing the changes.

{{handoff}}
```

4. `session.reviewFeedbackToImplementer.visible`

Suggested template with `{{review_feedback}}` placeholder:

```txt
Another agent reviewed your changes and left the feedback below.

Please review the feedback, resolve the relevant issues, and explain what you changed.

{{review_feedback}}
```

5. `session.implementationResponseToReviewer.visible`

Suggested template with `{{implementation_response}}` placeholder:

```txt
The agent implementing the changes has responded to the previous review feedback.

Please review the latest state again and report any remaining issues.

{{implementation_response}}
```

### 6. Add Localized UI Strings

Files:

- `packages/ui/src/lib/i18n/messages/en.ts`
- Other locale files as required by the project pattern

Add strings for:

- Command autocomplete description for `/handoff-review`.
- Review flow button aria label on review session: “Send review feedback to implementing agent”.
- Review flow button aria label on original session: “Send implementation response to reviewing agent”.
- Tooltip text for both directions.
- Toasts for starting handoff generation, review session creation/reuse, transfer success, transfer failure, missing linked session, missing assistant text.

Follow locale-ui-patterns. Do not hardcode user-facing text inside components.

### 7. Register The New OpenChamber Slash Command

There are two possible implementation paths. Pick the one matching how OpenChamber-owned commands are currently registered.

Likely locations:

- `packages/ui/src/lib/magicPrompts.ts`
- command autocomplete/store code around `useCommandsStore`
- command rendering in `ChatInput` / command autocomplete components

The command should appear as `/handoff-review` in OpenChamber command autocomplete.

It should be treated as an OpenChamber flow command, not only a raw OpenCode command, because after the handoff assistant output completes OpenChamber must create/reuse/open/send to the review session.

Implementation options:

1. Intercept `/handoff-review` in `routeMessage(...)` before normal OpenCode command lookup.
2. Add it to the command store as an OpenChamber-owned command with a handler.

Prefer the smallest approach consistent with existing command architecture.

### 8. Implement Handoff Generation And Wait Helper

Add a helper that starts the handoff command in the original session and resolves with the assistant handoff text.

Possible module:

- `packages/ui/src/lib/reviewFlow.ts`

Inputs:

```ts
{
  originalSessionID: string
  directory: string
  providerID: string
  modelID: string
  agent?: string
  variant?: string
}
```

Flow:

1. Render `session.reviewHandoff.visible` and `session.reviewHandoff.instructions`.
2. Send a user message to the original session using `opencodeClient.sendMessage(...)` or the existing command route, depending on final command integration.
3. Include the visible handoff request as the visible user text.
4. Include hidden instructions as synthetic additional part if using `sendMessage(...)`.
5. Capture the generated user message ID.
6. Wait until a later assistant message for the same session is complete and has text.
7. Extract text with the same idea as `flattenAssistantTextParts(...)` / `extractAssistantText(...)`.
8. Timeout with a clear failure if no handoff arrives.

Waiting rules:

- Prefer sync store state over polling the server repeatedly.
- Use existing `getSyncMessages(sessionID)` and `getSyncParts(sessionID)` from `sync-refs` if they expose enough data.
- If a subscription-based wait is not easy, use a bounded interval that reads sync refs and stops on timeout or completion.
- Ensure it waits for assistant completion, not just first streaming text.
- Avoid broad store subscriptions in React components.

### 9. Create Or Reuse The Review Session

After handoff text is available:

1. Read original session with `opencodeClient.getSession(originalSessionID)`.
2. Read `original.metadata.openchamber.reviewSessionID`.
3. If it exists:
   - Try to get that review session in the same directory.
   - If it exists and has `metadata.openchamber.kind === 'review'`, reuse it.
   - If it is missing/deleted, clear the stale link and create a new review session.
4. If it does not exist, create a new normal session in the same directory with metadata:

```ts
{
  openchamber: {
    kind: 'review',
    originalSessionID,
  }
}
```

5. Patch original session metadata with:

```ts
{
  openchamber: {
    reviewSessionID: reviewSession.id,
  }
}
```

Preserve unrelated metadata on both sessions.

If metadata patching original fails after creating review session, report failure clearly. Do not silently proceed with an unlinked session.

### 10. Send Initial Prompt To Review Session

After create/reuse:

1. Render `session.reviewSession.visible` with `handoff`.
2. Send it to the review session as a normal user message.
3. Use the same provider/model/agent/variant policy as the current session unless product decision says otherwise.
4. Do not mention session IDs or linked sessions.

Important:

- If reusing an existing review session, still send the new handoff prompt into it.
- Reuse does not mean “do nothing”; it means continue the same review conversation.

### 11. Open Review Session In Context Panel

Use:

```ts
useUIStore.getState().openContextPanelTab(directory, {
  mode: 'chat',
  dedupeKey: `session:${reviewSession.id}`,
  label: reviewSession.title,
})
```

This should happen after the review session exists and the initial prompt has been sent, or immediately after creation if sending happens asynchronously but errors are still surfaced.

### 12. Add Cross-Session Transfer Button On Assistant Messages

File:

- `packages/ui/src/components/chat/message/MessageBody.tsx`

Add optional props to `AssistantMessageActionButtons`:

```ts
reviewTransferAction?: {
  ariaLabel: string
  tooltip: string
  disabled?: boolean
  onClick: () => Promise<void> | void
}
```

Render an icon-only button with:

```tsx
<Icon name="arrow-left-right" ... />
```

Visibility rules:

- Only assistant messages.
- Only messages with copyable text.
- In a review session: show button to send review feedback to the original session.
- In an original session with `metadata.openchamber.reviewSessionID`: show button to send implementation response to the review session.
- Do not show in mini-chat if that surface should avoid extra controls; follow current action-button surface rules.

To avoid button spam:

- Preferred first implementation: show on assistant messages where normal assistant action buttons already show.
- Do not add the button to user messages.
- If this feels too noisy in testing, narrow to latest completed assistant message per session as a follow-up, but not required for initial end-to-end implementation.

### 13. Implement Review Feedback Transfer

When clicking the button in a review session:

1. Get current review session metadata.
2. Resolve `originalSessionID`.
3. Extract the clicked assistant message text.
4. Render `session.reviewFeedbackToImplementer.visible` with `review_feedback`.
5. Send it as a normal user message into the original session.
6. Use original session directory.
7. Optionally open/focus the original session or leave context panel as-is. The agreed behavior only requires sending.
8. Show success/failure toast.

Message sent to the agent must be exactly natural-language feedback, not routing data.

### 14. Implement Implementation Response Transfer

When clicking the button in the original session:

1. Get original session metadata.
2. Resolve `reviewSessionID`.
3. Extract the clicked assistant message text.
4. Render `session.implementationResponseToReviewer.visible` with `implementation_response`.
5. Send it as a normal user message into the review session.
6. Use same directory.
7. Open/focus the review session context panel tab, because review continuation happens there.
8. Show success/failure toast.

### 15. Cleanup Metadata When Deleting Review Session

Files:

- `packages/ui/src/sync/session-actions.ts`
- `packages/ui/src/lib/opencode/client.ts`

Before deleting a session:

1. Read the session being deleted.
2. If it is a review session and has `originalSessionID`, read the original session.
3. If original metadata has `reviewSessionID` equal to the deleted review session ID, patch original metadata to remove it.
4. Then delete the review session.

Failure behavior:

- If metadata cleanup fails, do not delete silently. Return failure and show the existing delete failure path/toast.
- If original session no longer exists, continue deleting the review session; there is nothing to clean.
- If delete fails after metadata cleanup succeeded, restore the original metadata link as part of rollback if possible. At minimum, log and surface the delete failure.

Also apply this to `deleteSessionInDirectory(...)`.

### 16. Cleanup Stale Link When Reusing Review Session

If original metadata points to a review session that no longer exists:

1. Patch original metadata to remove stale `reviewSessionID`.
2. Create a fresh review session.
3. Patch original metadata with the fresh review session ID.

This is not a background reconciler. It only happens when the user starts the review flow.

### 17. Tests

Add focused tests for helpers and flow boundaries.

Likely files:

- New `packages/ui/src/lib/sessionReviewMetadata.test.ts`
- Existing `packages/ui/src/sync/session-actions.test.ts`
- Component test around `MessageBody` only if nearby test patterns exist

Test cases:

1. Metadata helper marks review session without removing unrelated metadata.
2. Metadata helper links original session without removing unrelated metadata.
3. Metadata helper removes review link only when it matches the deleted review session ID.
4. `createSession` forwards metadata to SDK client.
5. `updateSession` forwards metadata to SDK client.
6. Review flow reuses existing review session ID instead of creating another.
7. Review flow clears stale review session ID when referenced review session is missing.
8. Delete review session cleans original metadata before deleting.
9. Transfer prompt for review-to-implementer contains no session ID / metadata / linked-session wording.
10. Transfer prompt for implementer-to-reviewer contains no session ID / metadata / linked-session wording.

### 18. Validation

Run:

```sh
bun run type-check
bun run lint
```

Manual validation checklist:

1. Start `/handoff-review` in a normal session.
2. Confirm a handoff assistant message appears in original session.
3. Confirm a normal review session is created in the same directory, not as a child.
4. Confirm original metadata has `openchamber.reviewSessionID`.
5. Confirm review metadata has `openchamber.kind === 'review'` and `openchamber.originalSessionID`.
6. Confirm review session opens in context panel.
7. Confirm review session receives the initial handoff review prompt.
8. Confirm arrow-left-right appears on review assistant message actions.
9. Click it and confirm original session receives the agreed review feedback prompt.
10. Confirm arrow-left-right appears on original assistant message actions when original has review metadata.
11. Click it and confirm review session receives the agreed implementation response prompt.
12. Run `/handoff-review` again on the same original session and confirm it reuses the existing review session.
13. Delete the review session and confirm original metadata link is removed.
14. Delete original session and confirm no review cleanup crash occurs.

## Non-Goals

- Do not add a review status state machine.
- Do not allow multiple review sessions for one original session in this first implementation.
- Do not expose metadata, linked sessions, or session IDs to agents.
- Do not use parent/child session relationships for this feature.
- Do not change OpenCode core or SDK unless OpenChamber cannot access metadata from the existing SDK types.
- Do not make a background metadata reconciler.

## Main Implementation Risks To Watch While Coding

These are coding concerns, not product blockers:

- Metadata replacement must not drop unrelated metadata.
- Event/store sanitation must not strip `metadata` from session records.
- The handoff wait helper must wait for completed assistant output, not first streaming text.
- Cross-session sends must use the correct directory dynamically, not cached closure values.
- Message action buttons must not subscribe broad chat rows to global session collections.
- Delete cleanup should not delete the review session if cleanup fails in a way that would leave confusing metadata behind.
