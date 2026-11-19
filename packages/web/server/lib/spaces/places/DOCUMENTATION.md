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
- Docker CLI JSON gets its types from `docker-wire.ts` only, at the parse.
  Output of a container or of a space's network never takes a wire type.

## Decisions

### Why registry results retain the implementation type

The registry checks method presence only. A generic registration preserves each
implementation's arguments and results without claiming that registration
validated the full place protocol.

### Why Docker CLI output is typed and not validated

The operator decided that the output of the docker CLI is a documented format
of a program OpenChamber runs itself. `docker-wire.ts` declares it once as
named wire interfaces, and the engine and the disk reader apply them where the
JSON is parsed: `parseInspectOutput` for `inspect` and `parseDockerJson` for
the other documents. Each interface holds what Docker documents, restricted to
the fields the code reads. A field is optional or nullable where the code
already guards it. Nothing validates the shapes at run time: the parse keeps
the `docker_output_unreadable` error for text that is not JSON, the first-entry
lookup and the native property reads, so wrong-shaped JSON fails the way it did
before. Adding a validator was rejected because it would change those failures
for a format we do not control and do not need to distrust.

The trusted shapes:

- `inspect --type container`: `Id`, `Name`, `State.Running`,
  `State.ExitCode`, `Config.Labels`, `Config.Env`, `Config.User`, `Mounts`
  (`Type`, `Name`, `Source`, `Destination`, `RW`), `NetworkSettings.Networks`
  (`IPAddress`, `Aliases`, `DNSNames`), and the `HostConfig` fields the
  hardening checkers compare.
- `network inspect`: `Name`, `Labels`, `Internal`, `EnableIPv6`,
  `IPAM.Config[].Gateway`, `Options`.
- `volume inspect`: `Name`, `Labels`.
- `image inspect`: `Id`, `RepoTags`.
- `version --format '{{json .}}'`: `Server` with `Version`, `Os`, `Arch`, or
  null when the daemon does not answer.
- `info --format '{{json .SecurityOptions}}'`: a string list or null.
- `info --format '{{json .Name}}'`: a string.
- `system df --verbose --format '{{json .}}'`: `Volumes` (`Name`, `Size`,
  `Links`, all strings) and `Images` (`ID`, `UniqueSize`).

Labels are string dictionaries, so the label parsers return string ids for
Docker input. The parsers take their value type from the input: unchecked
input still gives `unknown` values, and a missing id, owner or tools key is
refused before the patterns run, as the patterns already refused it.

The decision covers Docker's own output only. What a container prints, what
the server or the gatekeeper inside a space answers, and what crosses a
space's network stay unchecked data with their owner's types. The engine's
failure accessor keeps `code`, `message`, `details` and `errno` of a rejection
`unknown` and still throws a `TypeError` for a nullish rejection.

The tools prune swallows a failed listing or removal on purpose: the next fill
or the next move to new tools tries again.

### Why setup checks command output

Docker memory output and Colima profile lines are external JSON. The memory
reader accepts arrays with a numeric first item unless it is at most zero.
Non-array JSON has no accepted memory result. Profile names must be nonempty
strings; property lookup preserves inherited values and primitive boxing.
Setup failure fields remain unchecked data from a rejected operation and
therefore have `unknown` types. The setup code does not validate them.

### Why live test support remains JavaScript

`escape-suite.js` reads JSON printed by probes inside the space, by its
gatekeeper and by the server inside, and calls string and array methods on it:
`startsWith` on every probe answer, `filter` on the window's `headerNames`,
`flatMap` and `map` on `/api/integration`, the first `set-cookie` header and
the tunnel counts. That is data from a container, which the Docker decision
does not cover. A type would claim a shape nobody checks, and a check would
change how a malformed answer fails: a probe answer that is not a string would
drop out of `connected()` and let an assertion pass on nothing, where today it
throws and fails the test.

`docker-live-support.js` spreads the address list a helper container prints
into the host listener's candidates, which the suite then uses as connection
targets, and returns the window upstream's log lines, which hold what the
space sent, as parsed JSON. Both are container data. Its inspect reads also
destructure the first entry and read `NetworkSettings.Networks` without a
guard and let `JSON.parse` throw its own `SyntaxError`; the wire parser wraps
that error and declares those fields optional because the place guards them.
Typing these reads would either change the failure or add a second inspect
document for one test helper.

### Why fake Docker resources have separate entry types

The fake runner receives fixtures from tests and constructs its own entries.
Those entries have container, network and volume types, distinguished by the
resource kind. They do not describe Docker's unchecked JSON. Container-key
lookups and generated command arguments have required-entry accessors for the
positions populated by the builders; a broken invariant remains a `TypeError`.
Inspect still prints found entries when another requested name is missing.

The fake's container ids are hex strings distinct from names. A seeded
container may use another image. Tokens belong to home volumes and survive a
container replacement; gatekeeper programs belong to tmpfs and disappear on
stop. Timed-out commands finish when the fake's injected wait advances its
clock. A stuck one-shot stays running. A failed create may leave its container.
The tools marker check retains exit 42 for a missing marker and exit 1 for a
daemon failure. Image inspection reports compressed size while disk usage
reports unpacked size. Removal without force preserves running containers,
mounted volumes and images that a container uses.

### Why the memory place keeps its server optional

Each space has separate space and gatekeeper hostnames. Only the space
container gets an HTTP server, after its loopback listener is ready. Its server
and TCP address are required before connecting. Stop and start update the
record without closing this test listener; removal closes it. Looking up a
command target checks the container rather than the space record, so the
contract suite detects a gatekeeper left behind after removal.

The contract suite accepts only the operations it exercises. Its listed ids
remain unchecked because Docker label parsing does not establish strings.
Response chunks are buffers because the request never sets an encoding.
The executable guard follows the existing nonempty-argv assertion. The argv
control-character check uses the code-transfer owner's identical ASCII range.
