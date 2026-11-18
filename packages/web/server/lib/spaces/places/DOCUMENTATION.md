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

`labels.js` still infers `labelFilterArgs.spaceId` and
`toolsLabelFilterArgs.role` and `.key` as `null | undefined`, although the
Docker place and tools operations supply strings. These parameters need
`string | null` defaults in their owning module. The `startConfig` parameter
of `hardening.js`'s `buildSpaceCreateArgs` likewise needs `string | null`.

Raw Docker inspect data needs a contract shared with the parent
`findHardeningViolations` and `findGatekeeperHardeningViolations` checkers and
`parseSpaceLabels` and `parseToolsLabels`. The engine establishes JSON syntax
only. Unchecked entries and label fields cannot be declared validated
containers or string dictionaries. The disk reader and tools operations use
these same unchecked entries. The shared contract must represent unchecked
fields as `unknown`, with narrowing owned by the operations that inspect them.
`tools.js`'s `requireToolsSource` also needs to preserve the source type
established by its factories; its WeakSet check alone establishes no shape.

### Why setup checks command output

Docker memory output and Colima profile lines are external JSON. The memory
reader accepts arrays with a numeric first item unless it is at most zero.
Non-array JSON has no accepted memory result. Profile names must be nonempty
strings; property lookup preserves inherited values and primitive boxing.
Setup failure fields remain unchecked data from a rejected operation and
therefore have `unknown` types. The setup code does not validate them.

The contract and escape suites, fake Docker runner, memory place and live
Docker helpers are test support. They remain JavaScript with the test files.
