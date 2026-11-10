---
name: isolated-space-boundary
description: "Use when changing isolated-space trust boundaries: container hardening, networks and gatekeeper policy, exec and lifecycle, grants and credentials, code transfer and apply, dispatcher isolation, preview content, or tests of these protections."
---

# Isolated Space Boundary

Treat the agent inside a space as hostile. A restriction must hold even when the agent changes its own files, environment, tools and server responses. The agreed guarantees belong to *Design* in `packages/web/server/lib/spaces/DOCUMENTATION.md`; this skill guides changes to their enforcement and evidence.

## Read The Owning Contract

Read *Design* in `packages/web/server/lib/spaces/DOCUMENTATION.md`, the boundary rule, the words and the numbered decisions, and the escape checks and the evidence rule under *Tests* there.

Then load the branch-specific context before editing:

| Change | Required context in `packages/web/server/lib/spaces/DOCUMENTATION.md` |
|---|---|
| Container restrictions, networks, environment, command or lifecycle | *Hardening*, *The gatekeeper container*, *Lifecycle*, and the owning section for the changed operation |
| Corridor, window, control or journal | The matching section under *The gatekeeper*, including *Known limits* |
| Exec requests, server token or responses from inside | *Token*, *The exec channel* and *Process rules* |
| Grants or credentials | *Design* (words, decisions 4, 5 and 13), *Window*, *Control* and *Grants* |
| Code transfer or apply | *Code in* and *Code out*, with decision 7 under *Design* |
| Dispatcher, session identity or preview content | *Dispatcher* and *Preview*, and the nearest documentation for the changed route, transport or state owner |

`openchamber-change-discipline` owns change scope and validation risk. Follow `desktop-shell` for child processes. Dispatcher and event changes also use `ui-api-decoupling`, `relay-transport` and `sync-state-invariants` for their respective contracts.

## Trace The Guarantee

Before changing enforcement, identify each affected guarantee, what the user authorized, what the agent controls, and which host, gatekeeper or runtime mechanism enforces it. Name the existing test or the missing proof. Context gathering is complete when every affected guarantee has that mapping.

Ask **what could the agent do from inside to undo or bypass this restriction?** Trace the request or data through the actual enforcement point, including parsing, normalization and the operation that consumes it. A space's configuration can help tools cooperate, but enforcement must survive the agent replacing that configuration.

Keep these distinctions explicit:

- **Corridor and window have different authority.** The corridor applies network-mode policy to agent-selected destinations. The window serves an upstream the host granted from the user's decision, which may be private. Read each contract before applying one path's restrictions to the other. Space-provided requests are untrusted input to a host decision, never authority to create a grant.
- **Host, gatekeeper and space are different secret holders.** A "uses without seeing" credential lives in the gatekeeper and stays hidden from the space. A "handed over" credential is deliberately readable by the agent. The space server's token is also readable by the agent; it protects against others. Classify the credential before deciding whether its presence is a leak.
- **Create arguments are intent; inspected state is evidence.** Keep each hardening builder aligned with its own checker and behavior test. Verify before starting either container, and preserve the manager's verification of the place's result. For changes to start or restart, trace policy loss and re-granting against the documented lifecycle rather than assuming memory survived.
- **Space output stays untrusted on the host.** Check where it can become a command, filesystem write, session identity or browser content. For transfer and apply, follow the quarantine and host-built patch contract. For forwarding, follow the credential-stripping, directory, identity and origin rules under *Dispatcher* in the module documentation.

Preserve the fail-closed start and account for the known limits in the owning contract. A change that needs a broader permission must make that user decision explicit rather than quietly weakening a mode.

## Prove The Protection

Choose the test level where the failure can occur. Container and network guarantees need attempts from inside a real space. Parser and socket-lifecycle defects may need controlled local tests to expose the exact failure. Use the module documentation's *Tests* section for the required suites and the escape checks.

For a new or changed protection, or an escape test whose assertion or setup changes:

1. Make the regression discriminate. It must fail on the defective behavior and pass with the protection. A refusal caused by a missing tool, failed DNS or an offline upstream is not proof; establish the applicable positive control.
2. Prove it by removing it. In a disposable copy, remove the protection or restore the original defect, run the test that claims to prove it, and watch it go red. The run is the evidence: a mutation you describe and do not run proves nothing. Confirm it fails for the promised violation, not a setup error. If an independent protection still blocks the attempt, identify it and isolate the changed layer's test. A surviving defense is not itself a test defect.
3. Restore the protection, run the test again, and watch it go green. Record the mutation, control, result and any blocked verification in the validation evidence. Update owning documentation when the guarantee, mechanism or known limit changes. Keep transient run history in the task or PR evidence.

For a behavior-preserving refactor, establish the existing behavior and rerun the affected regression tests. Add a sensitivity check when the refactor changes what those tests exercise or exposes a gap in their proof.

Exercise the interaction that caused the defect: a one-directional download test passed with a broken tunnel teardown that a full-duplex test exposed.

Use these controls where they apply:

- For name filtering, include alternative address spellings and normalization, then verify the connection uses the checked address without a second lookup. The corridor's exact name and address rules live in *Corridor*.
- For secret containment, prove a disposable credential works at a controlled upstream. Collect the space's observable data and search it on the host. Sending the hidden credential into the space as a search pattern invalidates that proof.
- For refusals and journal changes, verify both what the space learns and what the host can still read under hostile input. Internal policy reasons belong in the journal; the public refusal contract belongs to the relevant listener.
- For connection caps, use a small test cap and confirm server acceptance before exceeding it. Completed client handshakes alone do not prove the server accepted the connections.
- For journal assertions, identify records produced by the attempt without depending on cross-process clock precision. Keep controlled DNS and upstreams local as the escape-test rules require, with their explicit internet-baseline exception.

## Completion

Every affected guarantee has evidence or an explicit blocker, and the normal allowed operation still works. Report unit, live and mutation results separately, with platform and runtime conditions for measurements. A local test does not establish container isolation; a live refusal does not establish correct transfer teardown. Keep the documented promise within what the evidence proves.
