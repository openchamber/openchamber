# Session automation admission

## Ownership

Owns exclusive admission for Auto Review, PR fix-loop writers, queued sends,
pull-request wakes and restart continuations in one OpenChamber server.
`server/index.js` injects one instance. Each server inside a Space has its own
instance and sees only its own OpenCode. The owning runtimes retain their state
machines, trust checks, worker confinement and publication authority.

## Invariants

- `ready()` restores both authoritative files before autonomous sends. Failed
  restores keep admission closed. Conflicting restored owners block both until
  one is explicitly stopped or removed.
- Auto Review reserves both participants for the whole run. A fix loop reserves
  its host session and canonical PR across directories and accounts. A retained
  approval receipt or review job keeps that reservation while stopped.
- Session keys use exact IDs. PR keys use provider, instance, case-folded owner
  and repository, and number. Passive `pr.watch` tracking reserves nothing.
- Claims precede persistence and work. Failed activation releases its claim.
  Successful stop releases after the state write succeeds. Short operation
  leases remain exclusive through awaits even after their owner stops.
- Queue sends revalidate fix-loop authority before model, agent, knowledge,
  goal and content writes. Auto Review checks stop between admissions.
- A pull-request wake leases both session and PR keys at final admission. An
  owned wake stays persisted and releases re-arm it. A held manual restart
  continuation retains its existing notice.
- Automatic restart recovery leases the same session keys. An ownership hold
  keeps its timer pending without sending or consuming its recovery budget.
- Only releases matching an ownership-held wake re-arm it. Failed sends keep
  their own retry deadlines, and unrelated owners cause no wake reads.

## Decisions

### Why existing persisted owners restore the reservations

The Auto Review and fix-loop files already contain the identities and lifecycle
that authorize work. Restoring them together closes startup ordering without
a second durable registry that could disagree with them.

### Why short send leases accompany whole-run reservations

A hold checked before an async read can become stale before a model switch or
prompt. The lease prevents a new automation taking over during that preparation
and dispatch interval.

## Runtimes and proof

Web, Electron, hosted mobile and Capacitor use this server admission. VS Code
has none of these server automations. Spaces retain their own queues and Auto
Review; PR watches remain unavailable inside them.

Focused suites cover restore failure and conflicts, both review participants,
canonical PR ownership, async queue and wake admission, stops during routing
and worker resume, and reply attribution. Approval suites own immutable
receipts, exact head leases and durable mutation receipts. Controlled loopback
drivers exercise public HTTP routes without credentials or live GitHub writes.
