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

### Why the live suites check what a container prints

`escape-suite.ts` reads JSON printed by probes inside the space, by its
gatekeeper and by the server inside. `docker-live-support.ts` reads the address
list a helper container prints and the log of the stand-in upstream, which
holds what the space sent. Docker's own output keeps the wire decision above;
these do not, so each has a parser that refuses the wrong shape:
`parseProbeAnswers`, `parseWindowSeen`, `parseTunnelCounts`,
`parseIntegrationConnections`, `sessionCookieOf`, `parseListenerAddresses` and
`parseUpstreamLog`. Before, a probe answer that was not text, or a candidate
address that was not text, travelled on unchecked; a malformed answer now fails
the test at the parse with the reason, never by passing an assertion on
nothing. A probe answer must be `connected:<ip>` or `failed:<reason>`, so an empty or
unknown answer cannot count as a refusal, and tunnel counts must be the probe's
`done:` report of nonnegative counts that add up to its 80 attempts. Upstream
records keep every field they carry and the original log line, because the
grant tests search the whole record for a leaked key and a parse drops an own
`__proto__` property. `escape-suite.test.js` pins each
refusal.

The live helpers read inspect output through `parseInspectOutput`; an inspect
that names no networks fails with a message instead of a `TypeError`.

### Why the escape suite is built the way it is

The suite runs inside a real space as the attacker and passes only when the
attempt fails; every place runs it. Its `host` is the test's own view from
outside the space, `EscapeHost`; the Docker implementation is
`createLiveDockerPlace` in `docker-live-support.ts`. That helper gives each run
an owner id and a tools volume of its own, so parallel runs and real spaces stay
apart, and `dispose` removes helpers first, because a network with a container
on it cannot go, and then asserts that Docker holds nothing with the owner
label. Helper containers carry the marker and the owner, so the leftover check
sees them. `OPENCHAMBER_TEST_DOCKER_HOST=ssh://<machine>` runs every live suite
against that machine's daemon through the Docker over SSH place.

Choices a later reader could undo by mistake:

- Every probe prints one line and exits 0 within ten seconds, so a refusal is
  an answer and not a hang. A probe is inconclusive, never passed, when its
  positive control fails: the internet baseline, a 502 from the corridor (the
  Docker machine's link, not the restriction), a name that does not resolve
  on the host. The refusals themselves stay hard assertions.
- Memory is 1 GiB: the server and OpenCode take about 370 MiB at rest, so the
  process that allocates without end is the largest when the limit is hit and
  the one that gets killed.
- The host listener runs with `--network host` and prints every IPv4 address of
  the Docker host from the kernel's local route table, because
  `os.networkInterfaces()` misses a bridge without a running container. A plain
  internal network is created first, so its gateway is among those addresses,
  and a probe from that network must reach the host, or the test could never
  fail. The `.1` address of the space's own subnet belongs to the gatekeeper,
  the first container there (measured on Docker 29.2.1), and is never read as
  the host.
- Only the kernel's "Read-only file system" counts for the tools mount: root
  owns those files, so "Permission denied" would stop the space user on a
  writable mount too. Appending to the launcher is the one attempt the mount
  does not answer, so that test proves the ownership.
- The corridor's positive control carries to IANA's documentation domains only.
  A product service once answered 502 on one machine and reported a failed
  restriction where it had worked. There is deliberately no live large
  download: `joinSockets` in `gatekeeper-program.test.js` proves a byte-exact
  full-duplex transfer without a network.
- In open mode the refusal of `auth.openai.com` is a lock, not a guarantee: the
  space reaches every public host on 443 and could use an intermediary. The
  guarantee in both modes is that no long-lived credential is inside the space.
  Every form of a refused address is refused too (integer, hex, three-part,
  IPv4-mapped, 6to4), because in open mode the space could resolve a name
  through a DNS-over-HTTPS resolver; the integer form once carried a real TLS
  session in an earlier draft.
- The blocked-address rule is proved with a name of our own on the space's
  outer network, answered by Docker's resolver, because third-party wildcard
  DNS made runs inconclusive. That name not resolving is a suite bug, not an
  inconclusive run.
- Journal checks use a mark counted in records ever written, never a time: the
  record's stamp comes from a clock inside a container, and on Windows the two
  clocks disagreed by a timer tick.
- The window listens on the gatekeeper's inner address only: on a Linux Docker
  host every local process reaches the outer bridge. A neighbour on the outer
  network stands in for such a process.
- The model key is made on the host and never sent inside, not even as a search
  pattern; the host searches what the space prints. The stand-in upstream
  answers with hashes of what it saw.
- The credential search reads binary files as text (`-a`), because OpenCode 2
  keeps logins in `opencode.db`, and prints only the matched shape. Its patterns
  carry punctuation so a log line saying "refresh" does not match. The clean
  search runs before the control plants decoys, because SQLite keeps a deleted
  row's bytes in its write-ahead log. The control writes an OAuth row and a
  custom provider's key straight into OpenCode's `credential` table with Node's
  SQLite, waiting for OpenCode's lock, and reads the table back, because
  OpenCode's integration listing cannot see a provider its catalog does not
  know.
- The second space shares the owner's tools volume, so its create costs seconds.

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
