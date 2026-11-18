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

The remaining implementations are `docker.js`, `docker-tools.js` and
`docker-disk.js`. Their parent contracts are still JavaScript.

`../labels.js` infers `labelFilterArgs.spaceId` and
`toolsLabelFilterArgs.role` and `.key` as `null | undefined`, although the
Docker place and tools operations supply strings. These parameters need
`string | null` defaults in their owning module. The `startConfig` parameter
of `../hardening.js`'s `buildSpaceCreateArgs` likewise needs `string | null`.
The first mismatch blocks `docker.js`; the tools filters also block
`docker-tools.js`. These are inferred JavaScript signatures, not declared
TypeScript types that can be corrected in place. Both `labels.js` and
`hardening.js` exceed the 200-line allowance for converting an outside helper.
Adding replacement declarations or JSDoc comments would violate the conversion
rules.

These boundaries remain in the current source tree. The compiler rejects string
arguments to all four defaulted fields above with TS2322. There are no declared
types to widen or export in those two modules. Dependency augmentation cannot
correct these local JavaScript implementations.

Raw Docker inspect data needs a contract shared with
`../hardening.js`'s `findHardeningViolations` and
`findGatekeeperHardeningViolations` checkers and `../labels.js`'s
`parseSpaceLabels` and `parseToolsLabels`. The engine establishes JSON syntax
only. Its first-entry lookup, `entryLabels` and the consumers' nested property
reads do not establish an inspect shape. Unchecked entries and label fields
cannot be declared validated containers or string dictionaries. The disk reader
and tools operations use these same unchecked entries. This boundary involves
all three remaining implementations. The shared contract must represent
unchecked fields as `unknown`, with narrowing owned by the operations that
inspect them. The label parsers must retain `unknown` for fields their existing
checks do not validate, including project, name, creation time and description.
The disk reader also calls `map` on unchecked `system df` fields and `every` on
unchecked image tags. Declaring those fields as arrays would promise validation
that did not happen. Adding array refusals would replace the existing native
method-call failures.

`../tools.js`'s `requireToolsSource`, `createRegistryToolsSource` and
`createPackedToolsSource` also need to preserve a common source type with
`description: string`, `packageJson: string` and
`files: { name: string; bytes: Buffer }[]`, plus each factory's canonical
description. The `WeakSet` check alone establishes no shape. This boundary
blocks `docker-tools.js` and the Docker place that constructs it.

`../tools.js` is 114 lines and fits the outside-helper conversion allowance, but
converting it alone does not resolve the label-filter or unchecked-inspect
boundaries. `docker-disk.js` does not pass the mismatched filter arguments, but
still consumes unchecked `findByLabel` and `inspect` results and unchecked usage
arrays. Giving those results array or inspect interfaces would promise checks
the engine never performs.

### Why the engine returns unchecked entries

JSON syntax does not establish an inspect array, an entry object or label
values. `inspect` retains the original first-property lookup, including
array-like objects and strings; `findByLabel` returns the parsed value unchanged.
The engine's field accessor establishes only that a value is not null or
undefined. Every exposed field remains `unknown`, including rejected command
messages. It preserves inherited properties and primitive boxing without
asserting that the input is a validated object.

### Why setup checks command output

Docker memory output and Colima profile lines are external JSON. The memory
reader accepts arrays with a numeric first item unless it is at most zero.
Non-array JSON has no accepted memory result. Profile names must be nonempty
strings; property lookup preserves inherited values and primitive boxing.
Setup failure fields remain unchecked data from a rejected operation and
therefore have `unknown` types. The setup code does not validate them.

The contract and escape suites, fake Docker runner, memory place and live
Docker helpers are test support. They remain JavaScript with the test files.
