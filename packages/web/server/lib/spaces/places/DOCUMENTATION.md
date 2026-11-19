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
`docker-disk.js`. Labels and tools sources now have TypeScript owners.
`labelFilterArgs.spaceId`, `toolsLabelFilterArgs.role` and
`toolsLabelFilterArgs.key` accept strings. `ToolsSource` retains the factories'
description, package text, files and canonical content.

`../hardening.js` still infers `buildSpaceCreateArgs.startConfig` as
`null | undefined`, although its implementation interpolates a supplied string
into an environment argument. A string argument produces TS2322. There is no
declared type to correct or export; converting this 392-line module exceeds the
200-line outside-helper allowance. Dependency augmentation cannot correct a
local JavaScript implementation, and replacement declarations or JSDoc comments
are outside the conversion rules.

Raw Docker inspect data needs a contract shared with
`../hardening.js`'s `findHardeningViolations` and
`findGatekeeperHardeningViolations` checkers and `../labels.js`'s
`parseSpaceLabels` and `parseToolsLabels`. The engine establishes JSON syntax
only. Its first-entry lookup, `entryLabels` and the consumers' nested property
reads do not establish an inspect shape. Unchecked entries and label fields
cannot be declared validated containers or string dictionaries. Calling
`filter` on `findByLabel` output produces TS18046; reading `.Labels` from an
unchecked inspect entry produces TS2339. Passing `entryLabels` output to a
typed label parser produces TS2345. The disk reader
and tools operations use these same unchecked entries. This boundary involves
all three remaining implementations. The shared contract must represent
unchecked fields as `unknown`, with narrowing owned by the operations that
inspect them. The label parsers retain `unknown` for fields their existing
checks do not validate, including id, owner, project, name, creation time and
description. Coercing regular expressions do not establish string types:
passing a parsed space id to `spaceResourceName` produces TS2345. Widening that
helper's parameter alone cannot type the unchanged regular-expression checks
it calls.
The disk reader also calls `map` on unchecked `system df` fields and `every` on
unchecked image tags. Declaring those fields as arrays would promise validation
that did not happen. Adding array refusals would replace the existing native
method-call failures.

`docker-tools.js` and `docker-disk.js` no longer have the filter-argument or
tools-source mismatches. Both still consume unchecked `findByLabel` and
`inspect` results; disk usage and image tags also remain unchecked. Giving those
results array or inspect interfaces would promise checks the engine never
performs. These files stay JavaScript until that boundary can be typed without
adding validation or replacing native method-call failures.

Correcting declared types in neighbouring modules does not resolve these
unchecked method calls. `createDockerEngine().findByLabel` returns `unknown`,
and its implementation validates JSON syntax only. The place iterates that
value, tools calls its `filter`, and disk calls its `flatMap`. An array return
type would claim a check that the engine does not perform. A new array guard
would change the existing failure path for valid JSON with the wrong shape.

The same restriction applies to the disk reader's `Volumes.map`, `Images.map`
and `RepoTags.every`, and to the place's `Config.Env.find` and `Mounts.find`.
Exporting an inspect interface cannot establish those methods on unchecked
JSON. Dependency augmentation and conversion of a small outside helper cannot
establish them either. The engine must keep its unchecked result contract
until a separate behavior change defines validation and malformed-output errors.

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
