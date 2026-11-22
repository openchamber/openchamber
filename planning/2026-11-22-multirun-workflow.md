# Multi-run workflow

## Requested behavior

The existing multi-model run remains the home for individual sessions, parent
conversation, fusion passes, and combined final results. Viewing changes no
membership. Removing a member requires confirmation and keeps its conversation,
files, and worktree. Every fusion or combination creates another result and
retains its sources. Cleanup remains a separate explicit choice.

Prompt generation accepts a description of variations, new prompts, or both.
Selected models generate candidates through OpenCode's existing text generation
API. Users review and select candidates before adding them as ordinary prompt
variants in the existing parallel composer.

## Runtime behavior

| Runtime | Behavior |
| --- | --- |
| Web | Shared overview, membership actions, parent chat, fusion and composer generation |
| Electron | Same shared UI and web runtime APIs; no new native capability |
| VS Code | Same shared UI through existing OpenCode and metadata bridges |
| Hosted mobile | Existing overview and chat support viewing, membership, parent and fusion; launch and prompt generation remain unavailable |
| Capacitor mobile | Same overview and chat behavior through the selected server; launch and prompt generation remain unavailable |

## Decisions raised in the session

Questions about parent steering, combining results, and automatic fusion timed
out. The stated defaults stay within the requested workflow:

- Parent guidance affects the parent conversation and subsequent fusion inputs.
  Steering a member uses that member's conversation. Completed work does not
  change until another instruction runs.
- Combining final results creates another retained result session and, for code,
  another worktree. Applying it to a branch uses the existing Git workflow.
- Manual review remains the default; automatic fusion remains an optional first
  pass, followed by manual passes.

## Correctness and validation

### Provider and network boundary

Prompt generation uses the selected model through OpenCode's `generate.text`.
Parent messages and fusion inputs go to their selected OpenCode session provider.
These flows use only providers configured in OpenCode and keep `provider.use`
policy enforcement there. They add no provider-entry route, external service,
telemetry, or production listener. Membership and receipts stay on the session's
OpenCode backend. This behavior is unchanged in enterprise mode on every runtime
where the workflow is available. Mobile still has no prompt-generation launcher.

- Session metadata owns membership. Revalidate the member and target before a
  write; reject stale scope and cross-run moves. Failed writes publish nothing.
- Confirmation cancellation performs no membership write or cleanup.
- View actions change selection only. They remain available during source review.
- Fusion inputs identify each session, source result, and source-specific guidance.
  Result creation never archives, removes, or modifies source worktrees.
- Candidate output is parsed at the generation boundary. Partial generation
  failure preserves successful candidates and existing prompt variants.
- Test oracles are the requested membership state transitions, retention
  invariants, and the candidate JSON schema. Exercise real UI controls for
  confirmation and multiselection. Cover repeated fusion and failure behavior.
- User-triggered parent requests may read member results. Streaming updates add
  no network requests, timers, or all-project reads.
