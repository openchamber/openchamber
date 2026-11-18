# Space places

## Ownership

This folder owns place registration, Docker operations, local Docker setup and
SSH destination parsing. The parent spaces module owns resource labels,
hardening verification, command execution and space errors. Its
`DOCUMENTATION.md` defines the place lifecycle and isolation guarantees.

## Invariants

- Registration normalizes the lookup key and stores the original place.
  Required operations must remain callable, including inherited methods.
  Registration does not validate their arguments or results.
- The registry preserves the registered implementation's type. Its callable
  constraint does not invent result contracts for unconverted places.
- SSH destinations are parsed by `sshHostSchema`. Missing, empty and invalid
  settings produce no Docker host. Relative imports retain `.js` specifiers.
- Docker JSON and command failures retain their existing acceptance and failure
  behavior. Resource verification belongs to the parent hardening module.

## Decisions

### Why registry results retain the implementation type

The registry checks method presence only. A generic registration preserves each
implementation's arguments and results without claiming that registration
validated the full place protocol.

### Why Docker conversion depends on the parent contracts

The JavaScript error constructor infers `details` as `null`, although callers
pass structured failure details. Label-filter helpers infer their optional
space id, role and tools key as `null`, although Docker operations supply
strings. These contracts need correction in their owning folder before their
callers can convert without casts or changed failure behavior. Raw Docker
inspect data also needs a contract shared with the parent hardening checkers;
declaring a validated inspect result in the command engine would overstate
what that engine checks.
