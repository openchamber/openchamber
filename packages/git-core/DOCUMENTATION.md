# `@openchamber/git-core`

Shared pull-request resolution and worktree-related git plumbing shared
between the web server runtime and the VS Code extension host.

## Why this package exists

Prior to extraction, the same pull-request resolution helpers lived verbatim in
`packages/web/server/lib/git/service.js` and
`packages/vscode/src/gitService.ts`:

- `parseGitHubPullRequestHeadRef`
- `resolvePullRequestSourceInput` (+ `hasPullRequestIdentity`,
  `resolvePullRequestHeadBranch`)
- `resolvePullRequestForkRemote` (collision-safe)
- `checkRemoteBranchExists`, `fetchRemoteBranchRef`
- `checkPullRequestSourceAvailability`
- `resolvePullRequestSource` (+ `fetchPullRequestForkBranch`,
  `fetchPullRequestHeadRef`)
- `clearBranchTracking`

Web consumed them via its `simple-git` factory, VS Code via its
`child_process` executor. Both call sites were kept in lock-step by
duplicated parity tests, which is fragile when one side fixes a bug
and the other lags behind.

`@openchamber/git-core` replaces both with a single TS implementation
that takes a `GitRunner` interface — a thin executor with one method:

```ts
interface GitRunner {
  run(cwd: string, args: string[]): Promise<GitCommandResult>;
}
```

Both consumers wrap their existing `runGitCommand` /
`execGit` helpers in a `GitRunner` adapter and pass it in.

## Layout

```
src/
├── types.ts            # Public types + the `GitRunner` contract
├── errors.ts           # PullRequestSourceUnavailableError + factory
├── gitRunner.ts        # createChildProcessGitRunner (default factory)
├── branchName.ts       # cleanBranchName (small local helper)
├── parseGitHubPullRequestHeadRef.ts
├── resolvePullRequestSourceInput.ts
├── resolvePullRequestForkRemote.ts
├── remote.ts           # fetchRemoteBranchRef, checkRemoteBranchExists
├── availability.ts     # checkPullRequestSourceAvailability
├── resolvePullRequestSource.ts   # orchestrator + fetch helpers
├── clearBranchTracking.ts
└── index.ts            # barrel
__tests__/              # vitest unit tests against real temp git repos
```

## Public API

All functions are independent of host-runtime concerns. Pass a `GitRunner` and
the absolute path to the git working directory; the core never reads
`process.env`, never reaches into `vscode`, and never imports Express.

### Pull-request source input

```ts
import {
  hasPullRequestIdentity,
  resolvePullRequestSourceInput,
} from '@openchamber/git-core';

const source = resolvePullRequestSourceInput({
  prNumber: 42,
  upstreamBranch: 'feature/cool',
  ensureRemoteName: 'fork',
  ensureRemoteUrl: 'git@github.com:fork/repo.git',
  baseRemote: 'origin',
});
if (!source) {
  // No PR attached — short-circuit.
}
```

### Resolving a PR to a checkout ref

```ts
import { resolvePullRequestSource } from '@openchamber/git-core';

try {
  const resolved = await resolvePullRequestSource(runner, primaryWorktree, source);
  // resolved.checkoutRef, resolved.headBranch, resolved.upstream
  // A fork is preferred; otherwise the base remote's refs/pull/<n>/head ref
  // is fetched into refs/remotes/<base>/pull/<n>/head.
} catch (error) {
  if (error instanceof PullRequestSourceUnavailableError) {
    // Map to `pull_request_unavailable` transport code.
  }
}
```

### Collision-safe fork remote

```ts
import { resolvePullRequestForkRemote } from '@openchamber/git-core';

const fork = await resolvePullRequestForkRemote(runner, primaryWorktree, source);
if (!fork) {
  // Exhausted the suffix space — surface as failure.
}
```

### Branch tracking cleanup

```ts
import { clearBranchTracking } from '@openchamber/git-core';

await clearBranchTracking(runner, worktreeDirectory, localBranch);
```

## `GitRunner` adapters

The shared core ships a `createChildProcessGitRunner` factory. The web
server wraps its existing `runGitCommand`; the VS Code extension host
wraps `execGit`. Either is fine — the contract is just
`(cwd, args) -> Promise<GitCommandResult>`.

## Testing

`bun --filter @openchamber/git-core test` runs the vitest suite
against real temp git repos (`mkdtemp` + `git init`). No mocks of git
are used — the suite asserts both success and failure paths against
real `git` invocations.
