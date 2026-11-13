# Web runtime API adapters

## Upstream push evidence

The source-control adapter parses upstream replies into `ProjectUpstream`.
For every provider, a supplied `viewerCanPush` must be boolean; null and other
nonboolean values fail the read. Explicit true and false remain unchanged.
GitHub requires the field on both github.com and Enterprise instances.

### Why other providers may omit push evidence

Existing provider and SDK extension replies do not all report it. The adapter
preserves omission rather than inventing false or rejecting those replies;
omission means unavailable evidence, not permission to mutate. GitHub's boolean
is positive-access evidence: missing permission metadata currently produces
false, which is not proof of an authoritative denial.

## Pull request stacks

`pull-stacks.ts` implements the stack methods exposed through
`SourceControlAPI`. Provider reads and mutations send the bound repository
context in query parameters. Mutations send canonical bound context, an explicit
idempotency key and the captured target head SHA in JSON. The adapter validates
the durable receipt's actor, repository, binding, PR and head before returning
its parsed stack result. Mutations serialize only their contract fields.
All successful answers are Zod-parsed; HTTP errors preserve the server's
message and optional code. A failed read never becomes an empty stack.

Callers capture the target from the displayed stack. After creating a stacked
PR, the Git view reads that newly created PR's live head before registering it,
and derives a separate registration key from the completed create action.

Local restack start and control routes return a `RestackRun` directly. The GET
route returns `{ run }` and takes `directory` in the query. Start takes the
directory, nullable session ID, remote, trunk and ordered branches in JSON.
The local server does no fetch or push for this operation. The shared UI owns
its bound fetch before starting and its lease-protected pushes after completion.

The same adapter serves web, Electron, hosted mobile and Capacitor. VS Code
keeps all stack operations explicitly unsupported in its own adapter.
