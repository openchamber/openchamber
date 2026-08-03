# Phase 2E — H1 Health-Client Fix and Process-Boundary Notes

## Scope

Two minimal, focused changes for the Phase 2E worktree:

1. H1 fix in `packages/web/server/lib/guardian/health-client.js`: hoist the
   `proof` binding out of the inner `try` so the `catch` no longer throws an
   unhandled `ReferenceError` when the pre-proof connection is refused.
2. New process-boundary integration test + POSIX script that exercise the
   full credential handoff across real process boundaries (real guardian,
   real managed-child fixture, real `GuardianClient`).

## H1 fix (health-client.js)

The H1 bug:

- Line 339 declared `const proof = ...` (block-scoped to the `try`).
- The `catch {}` at line 393 references `proof`; on a pre-proof connection
  failure, that reference raises `ReferenceError: proof is not defined`,
  masking the intended `credentialFailure` envelope and breaking the
  fail-closed contract for the unauthenticated probe.

The H1 fix:

- Hoist `let proof = null;` to the enclosing function scope.
- Document the contract inline: pre-proof failure → `credentialFailure`,
  post-proof failure → `proofFailure`. Both are structured envelopes
  rather than thrown errors.

The fix is the smallest semantic change that restores the contract. It
does not weaken validation, swallow the error, or alter observable
behavior of any of the 3 existing tests in `health-client.test.js`.

### Validation evidence

- `vitest run server/lib/guardian/health-client.test.js` → 4/4 passed
  (3 existing + 1 new "closed-port returns credentialFailure" case).
- Confirmed the new test fails on the unpatched code with
  `ReferenceError: proof is not defined` and passes on the patched code.
- `node --check` on the patched file: clean.
- `vitest run server/lib/guardian/` → 283 passed / 1 skipped
  (the skipped one is the Windows-only `windows-smoke-script` test).

## Process-boundary coverage

The Phase 2E review gate requires a true web process-boundary E2E.
Booting the bundled web binary (`packages/web/.../dist/...`) is not
feasible in this worktree (no production build is staged; the dev
binary is the same Vite HMR server the E2E shell would have to wait
on). The new coverage uses the closest available local approximation:

- A real `ManagedOpenCodeGuardian` instance bound to a real Unix socket.
- The real `scripts/guardian-test-opencode.js` managed-child fixture,
  spawned by the guardian's spawn flow.
- A real `GuardianClient` driving `spawn → credential → health → stop`
  over authenticated IPC.
- A real Node child process (`scripts/process-boundary-web-harness.mjs`)
  that performs the same operations from a separate process boundary.
- A POSIX shell script (`scripts/web-restart-boundary-posix.sh`) that
  drives the same lifecycle through a separate Node helper
  (`scripts/web-restart-boundary-helper.mjs`).

### What is proven

- The credential is delivered only after a verified proof on the same
  socket (regression: no empty `Authorization` header on a pre-proof
  probe).
- A graceful restart (stop + spawn on a new port with the same owner)
  restores the credential from the encrypted store.
- A wrong-owner / port-swap scenario fails closed: the authenticated
  `credential` RPC rejects a foreign owner, and a pre-proof probe with
  an empty `Authorization` header is not honored.
- The web process never logs the credential (harness stderr is asserted
  to not contain the secret).

### What is not covered (explicit remaining gaps)

- **Native Windows**: both the POSIX script and the vitest
  process-boundary test are gated to Linux. Windows must rely on the
  hard-gated `guardian-windows-baseline.yml` workflow; the change
  adds no new Windows-only assertions locally.
- **True web-binary E2E**: no bundled web binary is launched in this
  worktree. The harness is a separate Node process; the helper script
  uses a separate Node helper. A future change could add a workflow
  that runs `bun run build:web` first and then drives the same harness
  against the real bundled server, but that build is out of scope for
  this fix.
- **Credential storage compromise tests**: the change relies on the
  existing encrypted-at-rest invariant; it does not add a new test for
  encrypted-at-rest properties (already covered in the existing
  `credential-store.test.js`).

## Files changed

- `packages/web/server/lib/guardian/health-client.js` — H1 fix (hoist
  `proof`).
- `packages/web/server/lib/guardian/health-client.test.js` — new
  "closed-port returns credentialFailure" test.
- `packages/web/server/lib/guardian/process-boundary.test.js` — new
  vitest process-boundary test (in-process + harness).
- `scripts/process-boundary-web-harness.mjs` — new Node child fixture
  acting as the "web" process.
- `scripts/web-restart-boundary-posix.sh` — new POSIX script.
- `scripts/web-restart-boundary-helper.mjs` — new Node helper invoked
  by the POSIX script.
- `.github/workflows/guardian-linux-baseline.yml` — new
  hard-gated step that runs the POSIX script.

## Gated actions

- No commits, pushes, branches, tags, or PR changes were made.
- No `git` or `gh` commands were run.
- No OCR or external review was invoked.

The CI workflow step is added in-tree but is not run by this agent
session; the maintainer must run the new workflow on the PR branch to
record the corresponding evidence.
