# Proposal: Opt-In Permission Request Decision Hook

**Status:** Design proposal only. This pull request intentionally contains no runtime implementation.

## Intent

OpenChamber already receives permission requests from OpenCode and has an
auto-accept path for sessions that explicitly enable it. This proposal asks
whether that flow should expose a small, product-neutral extension point for
observing or resolving permission requests before OpenChamber sends a reply.

The goal is to make it possible for a local policy component, review UI, or
future integration to participate without coupling OpenChamber to a particular
vendor, hosted service, policy language, or authorization product.

## Proposed shape

The implementation would introduce an opt-in decision-provider interface at
the existing permission-request boundary. The exact API is intentionally left
for maintainer review, but the semantic contract should be equivalent to:

- `once`: approve only the current permission request;
- `reject`: reject the current request; and
- `defer`: do not send a decision yet and leave the request reviewable.

The request supplied to an observer/provider should be a normalized, redacted
record containing only the context needed to make or display a decision, such
as:

- permission request identifier;
- OpenCode session identifier;
- project or directory context, with a clear boundary policy;
- permission class and matched patterns;
- a human-readable description where available; and
- creation time and provider correlation metadata.

Raw prompts, credentials, environment values, arbitrary tool arguments, and
unbounded command output should not be included by default.

## Compatibility requirements

- The feature must be disabled by default.
- Existing permission rules and the current auto-accept behavior must remain
  unchanged when no provider is configured.
- The first implementation should not make network calls from OpenChamber's
  core permission path.
- Provider failure, timeout, malformed output, or duplicate resolution must
  never become an implicit approval.
- A provider must not be able to broaden the configured OpenCode permission
  policy. It can only resolve a request that OpenCode has already surfaced.
- The request must remain bound to its session and project/directory context;
  a response for one request must not resolve another request.
- The provider boundary should be testable with a local fake implementation.

## Suggested sequencing

### Phase 1: observer-only

Expose a typed, redacted callback or event before the existing auto-accept
responder runs. The observer cannot approve, reject, or mutate the request.
This is the smallest change and would validate whether the request shape is
useful without changing execution behavior.

### Phase 2: local decision provider

If Phase 1 is accepted, add an injectable local provider that can return the
three outcomes above. Keep transport and remote service integration outside
the core implementation. Any remote adapter can then be maintained by a
downstream project or a separate OpenChamber integration package.

## Required tests for a future implementation

1. No provider configured: current behavior and default policy are unchanged.
2. Observer receives a redacted request before auto-accept handling.
3. `once` maps to one request only and cannot approve a second request.
4. `reject` reaches the corresponding OpenCode permission request.
5. `defer` leaves the request pending and reviewable.
6. Provider timeout, exception, malformed output, or disconnect never allows.
7. Session, request, and directory binding prevents cross-context resolution.
8. Duplicate responses are idempotent and conflicting responses fail closed.
9. Restart and reconnect behavior is explicit and covered.
10. No credentials, raw prompts, or unbounded command arguments appear in
    provider payloads or logs.

## Explicit non-goals

This proposal does not request:

- a ProvnAI, VEX, CHORA, McpVanguard, or other vendor-specific adapter;
- a new default permission policy;
- a hosted authorization endpoint or mandatory network dependency;
- terminal or filesystem authorization outside OpenCode's existing permission
  model;
- evidence custody, signed receipts, or a new audit protocol;
- automatic approval of requests that OpenCode would otherwise deny; or
- a claim that an observation hook is itself an authorization boundary.

## Maintainer question

Would this generic, opt-in extension point fit OpenChamber's direction? If so,
which seam is preferred: a new permission event/provider module, or a narrow
refactor of the existing auto-accept runtime around an injectable resolver?

The intent is to agree on the boundary and request shape before submitting
runtime code. If the proposal is not useful upstream, it should remain a
downstream integration rather than introduce product-specific surface area.
