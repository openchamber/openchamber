'use strict';

// The program of the gatekeeper container: the space's only way out.
//
// It runs on the Node of the base image, with nothing but the standard library, and it is
// delivered over `exec` on stdin into the container's tmpfs. Nothing about it is written to
// disk on the host side of a space, and it holds every secret in memory only.
//
// Three listeners:
//   corridor  an HTTP CONNECT proxy for the space, on the space-facing interface
//   window    a reverse proxy that adds a secret the space never sees, on the same interface
//   control   the host's channel, on the gatekeeper's own loopback, which the space cannot reach
//
// Arguments: <space-facing bind host> <corridor port> <window port> <control port>
// [<window deadline in ms>]. They are arguments so that the container command and the tests run
// the very same program; the last one lets a test watch a deadline pass without waiting five
// minutes for it. None of them changes a decision this program makes. The bind host is an
// address, or the path of a file that holds one: the container command names the file, and the
// host writes the gatekeeper's own address on the space's network into it before the program,
// because the host knows that address and this program has no say in where it listens.
//
// Everything the space sends is hostile input. Nothing it can send may end the process:
// a crash of the gatekeeper is a denial of service the agent could trigger at will.

const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');

const [bindArgument, corridorPort, windowPort, controlPort, windowDeadline, corridorCap, windowCap, controlCap] = process.argv.slice(2);

/**
 * A cap given on the command line, or the production number when there is none.
 *
 * The caps are arguments for the same reason the window's deadline is: they are lengths, not
 * decisions, and a test that has to exceed one needs it small. A drop only happens when more
 * connections are *accepted* than the cap allows, and a busy machine accepts slowly while the
 * kernel's backlog keeps taking handshakes — so a flood of 300 clients against a cap of 128 can
 * leave every one of them connected and nothing accepted past the cap, and the flood goes
 * unrecorded. At a cap of 4 that cannot happen. The container command carries the production
 * numbers and the hardening test asserts the command, so nothing here can raise them.
 */
const cap = (given, production) => (Number.isInteger(Number(given)) && Number(given) > 0 ? Number(given) : production);
const CONTROL_HOST = '127.0.0.1';

// 443 and nothing else, in both modes, for two reasons.
//
// A space that could reach any port could attack a third party from the user's address: a port
// scan, an SSH brute-force, mail abuse, with the user as the apparent origin. Data can leave over
// 443 whatever anyone does here, but attacking a service that does not listen on 443 cannot, so
// this is a real restriction and not a speed bump.
//
// And it costs almost nothing. Services on other ports are overwhelmingly private ones, internal
// registries and internal git, and the private-address block already refuses those in both modes
// at every port. Public HTTPS is essentially all 443. When a port is genuinely needed, it belongs
// in the grant dialog as an explicit `address:port` the user opens, never in a mode-wide rule.
const ALLOWED_PORT = 443;
// Refused in both modes, whatever the allowlist says. In allowlist mode that makes it
// unreachable. In open mode it only makes it harder: the space reaches every public host on 443,
// so it can go through a third-party intermediary and the corridor sees only that name. What
// holds in both modes is that the long-lived refresh token is never inside the space at all.
const ALWAYS_REFUSED = ['auth.openai.com'];

// The space can open connections without end, so all of these are caps it cannot lift.
const MAX_TUNNELS = 64;
// Sockets that are not tunnels yet: a client has ten seconds to send its request line, and
// MAX_TUNNELS counts only what is established. Twice the tunnel cap leaves room for every
// handshake a working space makes and still refuses a flood, which the space can otherwise use
// to have this process killed and the journal of what it tried killed with it.
const MAX_CORRIDOR_CONNECTIONS = cap(corridorCap, 2 * MAX_TUNNELS);
// The window serves one request per connection at a time, and each one holds a socket out.
// The same number in and out, so the outgoing side can never grow past the incoming one.
const MAX_WINDOW_CONNECTIONS = cap(windowCap, 64);
// No byte from the upstream for this long and the request is over. The same number as a tunnel's
// idle limit and for the same reason: a model answer streams, so what matters is silence, not
// how long the whole answer takes. Without it an upstream that accepts and never answers holds
// its socket in and its socket out for the life of the space, and 64 of those are every slot
// the window has. The space cannot choose a grant's upstream, so this is about one provider
// going quiet rather than about the agent.
const WINDOW_IDLE_MS = Number(windowDeadline) > 0 ? Number(windowDeadline) : 300_000;
// Only the host talks to the control channel, one request at a time.
const MAX_CONTROL_CONNECTIONS = cap(controlCap, 8);
// Traffic that never reached a decision is journalled at most this often, per listener and per
// kind. The flood is the point of the record, and 500 records of it would erase everything else.
const NOTE_INTERVAL_MS = 60_000;
// No byte in either direction for this long and the tunnel goes. A model answer streams,
// and a long turn can be quiet for minutes, so this is generous on purpose.
const TUNNEL_IDLE_MS = 300_000;
const CONNECT_TIMEOUT_MS = 15_000;

const MAX_HEADER_BYTES = 16 * 1024;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CONTROL_BODY_BYTES = 1024 * 1024;

// The journal is small on purpose: it is a record of attempts, not a log.
const JOURNAL_RECORDS = 500;
// The same field caps the host channel reads back with, so a full ring always fits its answer.
const MAX_JOURNAL_HOST = 256;
const MAX_JOURNAL_DECISION = 64;
const MAX_ALLOWED_DOMAINS = 500;

const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
// A last label that is a number or hex is an address in one of the spellings `getaddrinfo` takes.
const NUMERIC_LABEL = /^(\d+|0x[0-9a-f]+)$/;
const GRANT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_SECRET_LENGTH = 8192;

/**
 * The address the corridor and the window listen on. An argument that starts with `/` is the
 * file the host wrote beside this program, holding the gatekeeper's own address on the space's
 * network; anything else is the address itself, which is what the tests pass. Whichever it is,
 * it must be the address of one interface: a file that is missing or empty, or anything that is
 * not an address or names every interface, ends the program. On a Linux Docker host every local
 * process can reach the bridge, and a window that listens there spends the user's key for anyone
 * on the machine. That includes a gatekeeper made before stage 5b, whose command still says
 * `0.0.0.0` and whose checker never compared the command: it no longer starts, and such a
 * space has to be made again. Failing to start is the safe answer.
 */
function readBindHost(argument) {
  const given = String(argument ?? '');
  let text = given;
  if (given.startsWith('/')) {
    try {
      text = fs.readFileSync(given, 'utf8').trim();
    } catch (error) {
      console.error(`gatekeeper: cannot read the bind address from ${given} (${error.code || error.message})`);
      process.exit(2);
    }
  }
  if (net.isIP(text) === 0 || text === '0.0.0.0' || text === '::') {
    console.error(`gatekeeper: ${given} is not the address of one interface`);
    process.exit(2);
  }
  return text;
}
// Everything the host sets, in memory only. Never a file, never an environment variable,
// never an argument, never a label. A restart starts from "nothing is allowed".
let networkMode = 'allowlist';
let allowedDomains = new Set();
const grants = new Map();

// When this program started, for the journal: nothing before it is on record.
const STARTED_AT = new Date().toISOString();
const journal = [];
let journalDropped = 0;

/**
 * One record per attempt: when, which listener, where to, and what was decided. Never a path,
 * never a query, never a body, never a header value, never a grant's secret. When the ring is
 * full the oldest record goes and `dropped` counts it, so the host can say that it is not
 * looking at the whole story.
 *
 * The host is cut to the length the host channel reads back. A plain proxy request may carry a
 * 16 KiB request line, and without this cut a space could make the whole journal too large to
 * read and hold it that way, which would take the user's only view of what it tried.
 */
function record(listener, host, port, decision) {
  journal.push({
    at: new Date().toISOString(),
    listener,
    host: String(host || '').slice(0, MAX_JOURNAL_HOST),
    port: Number(port) || 0,
    decision: String(decision).slice(0, MAX_JOURNAL_DECISION),
  });
  if (journal.length > JOURNAL_RECORDS) {
    journal.shift();
    journalDropped += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Addresses
//
// Refusal is by resolved address, in both network modes. The list covers the ranges that lead
// back to the user's own machine, to their network, or to a cloud metadata service.
// ---------------------------------------------------------------------------------------------

function parseIPv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/** 16 bytes, or null when this is not an IPv6 address. A zone id is cut off first. */
function parseIPv6(text) {
  const address = String(text).split('%')[0];
  if (!address.includes(':')) return null;
  const [head, tail, ...rest] = address.split('::');
  if (rest.length > 0) return null;
  const readGroups = (part) => {
    if (part === undefined || part === '') return [];
    const groups = [];
    const pieces = part.split(':');
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      // The last group may be a dotted IPv4 address: ::ffff:127.0.0.1 and friends.
      if (index === pieces.length - 1 && piece.includes('.')) {
        const embedded = parseIPv4(piece);
        if (!embedded) return null;
        groups.push(embedded[0] * 256 + embedded[1], embedded[2] * 256 + embedded[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const left = readGroups(head);
  const right = tail === undefined ? [] : readGroups(tail);
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [...left, ...new Array(tail === undefined ? 0 : missing).fill(0), ...right];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  return bytes;
}

function blockedIPv4(bytes) {
  const [a, b, c] = bytes;
  return a === 0 // 0.0.0.0/8, "this network"
    || a === 10 // 10.0.0.0/8
    || (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10, carrier-grade NAT
    || a === 127 // 127.0.0.0/8, loopback
    || (a === 169 && b === 254) // 169.254.0.0/16, link-local and the cloud metadata address
    || (a === 172 && b >= 16 && b <= 31) // 172.16.0.0/12
    || (a === 192 && b === 0 && c === 0) // 192.0.0.0/24, IETF protocol assignments
    || (a === 192 && b === 168) // 192.168.0.0/16
    || (a === 198 && (b === 18 || b === 19)) // 198.18.0.0/15, benchmarking
    || a >= 224; // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved, broadcast included
}

/** The IPv4 address inside an IPv6 one, for the three forms that carry one, or null. */
function embeddedIPv4(bytes) {
  const zeros = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);
  // ::ffff:0:0/96, the IPv4-mapped form, and the deprecated IPv4-compatible ::a.b.c.d.
  if (zeros(0, 10) && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0 && !zeros(12, 16)))) {
    return bytes.slice(12, 16);
  }
  // 64:ff9b::/96, NAT64.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) {
    return bytes.slice(12, 16);
  }
  // 2002::/16, 6to4: the IPv4 address sits in the next four bytes.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return bytes.slice(2, 6);
  }
  return null;
}

function blockedIPv6(bytes) {
  const embedded = embeddedIPv4(bytes);
  if (embedded) return blockedIPv4(embedded);
  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true; // ::1
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7, unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10, link-local
  if (bytes[0] === 0xff) return true; // ff00::/8, multicast
  return false;
}

/** True for an address that leads back to the user's machine, their network, or a metadata service. */
function isBlockedAddress(text) {
  const v4 = parseIPv4(text);
  if (v4) return blockedIPv4(v4);
  const v6 = parseIPv6(text);
  if (v6) return blockedIPv6(v6);
  // Not an address we can read is not an address we let through.
  return true;
}

const lookupAll = (host) => new Promise((resolve) => {
  dns.lookup(host, { all: true, verbatim: true }, (error, answers) => {
    if (error || !Array.isArray(answers) || answers.length === 0) {
      resolve({ addresses: [], reason: error ? String(error.code || error.message) : 'no address' });
      return;
    }
    resolve({ addresses: answers, reason: '' });
  });
});

/**
 * Which of the resolved answers to connect to. IPv4 first, whatever order the resolver gave them,
 * because the gatekeeper's outer network is created with `--ipv6=false` and an IPv6 address there
 * is a connection that cannot be made. A resolver that answers AAAA first would otherwise turn a
 * perfectly allowed host into a 502 that names nothing. An IPv6-only host is still attempted, and
 * fails with a message that says what happened.
 *
 * This changes which checked address is used and never whether it was checked: every answer goes
 * through the block list before any of them is chosen.
 */
const chooseAddress = (addresses) => addresses.find((answer) => answer.family === 4) ?? addresses[0];

/**
 * Resolves the name itself and refuses when any answer is a blocked address, then hands back the
 * one address the caller must connect to. The caller never resolves the name again: a second
 * lookup is where DNS rebinding gets in.
 */
async function resolveAllowedAddress(host) {
  const { addresses, reason } = await lookupAll(host);
  if (addresses.length === 0) return { error: `unresolved:${reason}` };
  if (addresses.some((answer) => isBlockedAddress(answer.address))) return { error: 'blocked-address' };
  const chosen = chooseAddress(addresses);
  return { address: chosen.address, family: chosen.family };
}

/** A lookup that answers with the one address that was already checked, in either shape Node asks for. */
const fixedLookup = (address, family) => (hostname, options, callback) => {
  if (options && options.all) callback(null, [{ address, family }]);
  else callback(null, address, family);
};

// ---------------------------------------------------------------------------------------------
// Corridor
// ---------------------------------------------------------------------------------------------

/** `host:port` or `[v6]:port` from a CONNECT line. Null for anything else. */
function splitTarget(text) {
  const value = String(text || '');
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;
  const port = Number(value.slice(separator + 1));
  let host = value.slice(0, separator);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length === 0 || host.length > 255) return null;
  if (/[\s/@]/.test(host)) return null;
  return { host, port };
}

const normalizeName = (host) => String(host).trim().toLowerCase().replace(/\.$/, '');

/**
 * Why this target may not pass, or null when it may. Names match exactly: no wildcards, no suffixes.
 *
 * The corridor takes names and never addresses, in both modes. A literal address walks past
 * every rule that is about a name: `auth.openai.com` is refused and its address was not, and a
 * space can learn that address from a public DNS-over-HTTPS resolver through this same corridor.
 * Comparing resolved addresses instead would be unreliable in both directions, because a CDN's
 * answers rotate. The space has no public resolver of its own, so every CONNECT it can make on
 * purpose is already by name and nothing it needs is lost.
 *
 * Reading four dotted octets is not enough to know an address when you see one. `getaddrinfo`
 * on this image's C library also takes `1746020849`, `0x01010101`, `1.1.257` and
 * `0x1.0x1.0x1.0x1`, and the block list only catches private ranges, so a public address in one
 * of those spellings went straight out. So the target must look like a domain name instead: the
 * same name rule the allowlist uses, and a last label that is not a number and not hex, because
 * no top-level domain is either. That closes every one of those spellings at once, and it keeps
 * non-ASCII out as well: `auth.openai.com。` with an ideographic full stop resolves on this C
 * library exactly like the name it imitates, and today only the HTTP parser stands in the way.
 */
function refuseTarget(host, port) {
  const name = normalizeName(host);
  if (ALWAYS_REFUSED.includes(name)) return 'deny:always-refused';
  if (parseIPv4(name) || parseIPv6(name) || !isDomainName(name)) return 'deny:not-a-name';
  if (port !== ALLOWED_PORT) return 'deny:port';
  if (networkMode === 'open') return null;
  return allowedDomains.has(name) ? null : 'deny:not-on-allowlist';
}

/** A name with an ordinary last label: not a number, not hex, and the label rules of a domain. */
const isDomainName = (name) => DOMAIN_PATTERN.test(name) && !NUMERIC_LABEL.test(name.slice(name.lastIndexOf('.') + 1));

let openTunnels = 0;

// The two things the space is told apart, and the only two. `refused` covers every reason the
// gatekeeper said no; `unreachable` means it said yes and the connection out did not happen.
//
// The reason why it said no stays in the journal, where the user reads it. Telling the space
// would hand it a resolver oracle: walking a list of names and sorting `deny:blocked-address`
// from `deny:unresolved` would map the user's internal DNS without reaching any of it, and
// telling `deny:not-on-allowlist` from `deny:not-a-name` says which mode the space is in.
// How many refused clients may be waited on at once, against the corridor's cap of 128. Small
// on purpose: waiting is a courtesy to a client that is still talking, not a place it can hold.
const MAX_LINGERING_REFUSALS = 16;
const lingeringRefusals = new Set();

const REFUSED = 'refused';
const UNREACHABLE = 'unreachable';

/**
 * The corridor's answer to a client it will not serve. The reason header is what tells a reader
 * "the gatekeeper refused this" from "the gatekeeper allowed it and the connection out failed",
 * which is a difference nobody could see in a bare 502, and nothing more than that.
 */
function refuse(socket, status, text, reason) {
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nx-gatekeeper-reason: ${reason}\r\nConnection: close\r\n\r\n`);
    // Drain whatever the client is still sending, and wait for it to finish before closing.
    // Closing a socket that still has unread bytes in its receive queue sends a reset, and a
    // reset throws away what the client has received and not yet read: measured, a client that
    // wrote a megabyte after its CONNECT lost its 403 to it in three runs out of five. The
    // refusal stands either way — nothing gets through — but the reason header is the only
    // thing that tells the space why, so it should arrive.
    socket.resume();
    // And the socket still has to be let go, or this is the wedge again: an `http.Server` socket
    // allows half-open, the request timeouts stop applying once a CONNECT has been handed over,
    // and the tunnel's idle timeout is only armed on a tunnel that exists, so a client that never
    // closes keeps its socket for as long as it likes. Measured before this: 140 of those filled
    // the connection cap and the corridor answered nothing, with nothing at all open. So a client
    // that finishes gets its socket closed properly, and only the last few are ever waited on:
    // past that the oldest goes, which costs it a readable reason and costs the corridor nothing.
    const release = () => { lingeringRefusals.delete(socket); if (!socket.destroyed) socket.destroySoon(); };
    lingeringRefusals.add(socket);
    socket.on('close', () => lingeringRefusals.delete(socket));
    socket.on('error', release);
    socket.on('end', release);
    while (lingeringRefusals.size > MAX_LINGERING_REFUSALS) {
      const oldest = lingeringRefusals.values().next().value;
      lingeringRefusals.delete(oldest);
      oldest.destroy();
    }
  } catch {
    socket.destroy();
  }
}

async function openTunnel(request, clientSocket, head) {
  // Without this an error on a socket we are not reading yet ends the process. Stage 0 lost a
  // corridor to a client that reset the connection after a refusal.
  clientSocket.on('error', () => {});
  // A client that leaves while its name is being resolved, or while the connection out is still
  // being made, must free its place at once. `end` matters as much as `close`: a socket the
  // corridor has not started reading from stays half-open after the client's FIN, and without
  // this the space could hold every place in the corridor by opening and leaving.
  let release = () => {};
  const clientLeft = () => release();
  clientSocket.on('close', clientLeft);
  clientSocket.on('end', clientLeft);

  const target = splitTarget(request.url);
  if (!target) {
    record('corridor', '', 0, 'deny:malformed');
    refuse(clientSocket, 400, 'Bad Request', REFUSED);
    return;
  }
  const { host, port } = target;
  const refusal = refuseTarget(host, port);
  if (refusal) {
    record('corridor', normalizeName(host), port, refusal);
    refuse(clientSocket, 403, 'Forbidden', REFUSED);
    return;
  }
  if (openTunnels >= MAX_TUNNELS) {
    record('corridor', normalizeName(host), port, 'deny:too-many-tunnels');
    refuse(clientSocket, 503, 'Service Unavailable', REFUSED);
    return;
  }
  // The place is taken before the name is looked up, not after. Otherwise a burst of clients
  // would all pass the check while they wait for DNS, and the cap would be one in name only.
  openTunnels += 1;
  let counted = true;
  const releasePlace = () => {
    if (counted) {
      counted = false;
      openTunnels -= 1;
    }
  };
  release = releasePlace;

  // The name that was checked is the name that is resolved. Anything else leaves a gap between
  // the two for input that normalises into something else.
  const resolved = await resolveAllowedAddress(normalizeName(host));
  if (resolved.error) {
    releasePlace();
    record('corridor', normalizeName(host), port, `deny:${resolved.error}`);
    refuse(clientSocket, 403, 'Forbidden', REFUSED);
    return;
  }
  record('corridor', normalizeName(host), port, 'allow');

  // The connection goes to the address that was just checked. The name is never resolved again.
  // `allowHalfOpen`, because a tunnel passes a close in each direction on its own. Without it
  // Node ends our side to the upstream the moment the upstream sends FIN, and anything the space
  // writes afterwards is lost: measured against the real program, an upstream that half-closes
  // and keeps reading never received what the space sent next. The cost is that a half-open
  // tunnel holds its place until one side closes or the idle timeout ends it, and the tunnel cap
  // bounds how many of those a space can hold.
  const upstream = net.connect({ host: resolved.address, port, allowHalfOpen: true });
  // Pulling the plug: for an error, a timeout, or a client that left before the tunnel existed.
  const abort = () => {
    releasePlace();
    upstream.destroy();
    clientSocket.destroy();
  };
  let carrying = false;
  upstream.on('error', (error) => {
    // Allowed, and the connection out did not happen. The user's view must say that, or an
    // unreachable host reads as a refusal in the journal and nobody can tell them apart.
    const code = String(error.code || 'error').slice(0, 32);
    record('corridor', normalizeName(host), port, `failed:${code}`);
    // Only while the socket still belongs to the proxy. Once the tunnel carries somebody's
    // bytes, writing `HTTP/1.1 502` into them puts proxy protocol in the middle of a TLS
    // stream: a reset halfway through a download would reach the space as a record error
    // instead of a reset. It is the same mistake as the teardown that truncated transfers.
    if (!carrying && !clientSocket.destroyed && !clientSocket.writableEnded) {
      // `refuse` owns the client socket from here: it drains what the space is still sending and
      // closes when the space is done, because closing on a full receive queue sends a reset and
      // the reset takes the answer with it. `abort` would do exactly that in the same tick, and
      // what would be lost is `x-gatekeeper-reason: unreachable` — the one line that tells the
      // space this host was allowed and could not be reached, rather than refused.
      refuse(clientSocket, 502, 'Bad Gateway', UNREACHABLE);
      releasePlace();
      upstream.destroy();
      return;
    }
    abort();
  });
  upstream.setTimeout(CONNECT_TIMEOUT_MS, abort);
  upstream.on('connect', () => {
    upstream.setTimeout(TUNNEL_IDLE_MS, abort);
    clientSocket.setTimeout(TUNNEL_IDLE_MS, abort);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);
    // From here the two sockets carry somebody's bytes, and a teardown written for an empty
    // socket would throw them away. `release` was that teardown; it is done now, and so is
    // every answer this proxy is still entitled to write into that socket.
    carrying = true;
    release = () => {};
    joinSockets(clientSocket, upstream, releasePlace);
  });
  release = abort;
  // The client may have left while its name was being resolved.
  if (clientSocket.destroyed || clientSocket.readableEnded) abort();
}

/**
 * Two sockets, joined for as long as they both live, and the place given back when they are
 * both gone.
 *
 * `pipe` is what carries a close across: when one side sends FIN, pipe ends the other side once
 * what is buffered has gone out. Destroying on `end` instead is how a proxy truncates a
 * download, and the larger the answer and the slower the reader, the more of it goes missing.
 * The last draft did exactly that, and nothing in the suite noticed, because every test read the
 * status line and stopped.
 */
function joinSockets(clientSocket, upstream, done) {
  let closed = 0;
  const bothGone = () => {
    closed += 1;
    if (closed >= 2) done();
  };
  // `pipe` carries a FIN across, and that is what keeps a transfer whole. It cannot carry a
  // death: when one socket is destroyed, pipe unpipes its peer, the peer goes paused, and a
  // paused socket never notices that the other end is gone. So a peer whose partner died is told
  // to go too, with `destroySoon`, which writes out what it still holds before it closes.
  const follow = (peer) => () => {
    if (!peer.destroyed) peer.destroySoon();
    bothGone();
  };
  upstream.on('close', follow(clientSocket));
  clientSocket.on('close', follow(upstream));
  upstream.pipe(clientSocket);
  clientSocket.pipe(upstream);
}

/** Anything but CONNECT. Stage 0 proved that OpenCode, curl, npm and git all use CONNECT for https. */
function refusePlainProxy(request, response) {
  let host = '';
  try {
    host = normalizeName(new URL(request.url).hostname);
  } catch {
    host = '';
  }
  record('corridor', host, 0, 'deny:not-connect');
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end('{"error":"the corridor takes CONNECT only"}');
}

// ---------------------------------------------------------------------------------------------
// Window
//
// Built for any upstream and any header name, because git over https and a private npm registry
// go through the same mechanism later. Only the model-provider path is wired and tested here.
// ---------------------------------------------------------------------------------------------

const WINDOW_PATH = /^\/model\/([A-Za-z0-9._-]{1,64})([/?][^]*)?$/;

/**
 * Does the rest of a window path walk out of its grant?
 *
 * A grant opens a place on a host, not the host, so a rest that climbs above it has to go. A
 * literal `..` is the least of it: the rest reaches the upstream verbatim, and a server that
 * decodes before it resolves reads `%2e%2e`, `.%2e`, `..%2f`, `..%5c` and `..;` as the same
 * climb. Refusing every rest carrying a `%` would be simpler and would be wrong, because a
 * scoped npm package is fetched as `/@scope%2fname` and that window is half the reason this
 * rule exists. So the rest is decoded until decoding changes nothing, and each round is split on
 * every separator a server might honour before `..` is compared. A rest that will not decode is
 * refused: nothing legitimate sends a `%` that is not an escape, and the alternative is guessing
 * which of two readings the upstream will take.
 *
 * Decoding to a fixed point rather than a fixed number of rounds, because a bound on the rounds
 * is a hole at the round after it: at three, a four-times-encoded `..` went through verbatim.
 * The loop ends on its own — every round that changes anything replaces at least one three-byte
 * escape with one byte, so the rest strictly shortens until a round decodes to itself.
 *
 * Not an escape today — a grant's upstream and its key belong together — and a trap left armed
 * for the stage that puts git and a private registry behind the same window.
 */
function walksOutOfGrant(rest) {
  let form = String(rest ?? '');
  for (;;) {
    if (form.split(/[/\\;?#]/).includes('..')) return true;
    if (!form.includes('%')) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(form);
    } catch {
      return true;
    }
    if (decoded === form) return false;
    form = decoded;
  }
}

// The window's own sockets out, capped the same way its sockets in are. Requests past the cap
// wait for a socket instead of opening one, and the listener's own cap bounds how many can wait.
const agentOptions = { keepAlive: false, maxSockets: MAX_WINDOW_CONNECTIONS, maxTotalSockets: MAX_WINDOW_CONNECTIONS };
const windowAgents = { 'http:': new http.Agent(agentOptions), 'https:': new https.Agent(agentOptions) };

const answerJson = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

/**
 * The gatekeeper's own listeners are not an upstream. A grant is the host's decision, and the
 * user's private network is a legitimate place for one, so only this refusal stands in the way.
 *
 * Every address this container has, not only loopback: the corridor and the window listen on
 * the gatekeeper's address on the inner network, and a grant pointing there, or at any other
 * address of its own, would feed the window into itself until its 64 sockets out were gone.
 */
const ownListenerPorts = new Set([Number(corridorPort), Number(windowPort), Number(controlPort)]);
const ownAddresses = new Set(Object.values(os.networkInterfaces())
  .flat()
  .filter(Boolean)
  .map((entry) => String(entry.address).toLowerCase()));

function isLoopback(address) {
  const v4 = parseIPv4(address);
  if (v4) return v4[0] === 127;
  const v6 = parseIPv6(address);
  if (!v6) return false;
  const embedded = embeddedIPv4(v6);
  if (embedded) return embedded[0] === 127;
  return v6.slice(0, 15).every((byte) => byte === 0) && v6[15] === 1;
}

const isOwnListener = (address, port) => (isLoopback(address) || ownAddresses.has(String(address).toLowerCase())) && ownListenerPorts.has(Number(port));

async function serveWindow(request, response) {
  request.on('error', () => {});
  const match = WINDOW_PATH.exec(request.url || '');
  if (match && walksOutOfGrant(match[2] || '')) {
    // Its own decision, because the journal is the user's only view: "tried to walk out of its
    // path" and "guessed a grant id" are different things and should not read as one. The answer
    // to the space stays identical to the one below, so it cannot sort a real id from a wrong one.
    record('window', 'grant-path', 0, 'deny:path-walks-out');
    answerJson(response, 403, { error: 'no such grant' });
    return;
  }
  const grant = match ? grants.get(match[1]) : null;
  if (!grant) {
    // The id is not a secret, and the journal keeps no path, so the destination is all it says.
    record('window', 'unknown-grant', 0, 'deny:no-grant');
    answerJson(response, 403, { error: 'no such grant' });
    return;
  }

  const upstream = new URL(grant.upstream);
  const port = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));
  if (ALWAYS_REFUSED.includes(normalizeName(upstream.hostname))) {
    record('window', normalizeName(upstream.hostname), port, 'deny:always-refused');
    answerJson(response, 403, { error: 'refused destination' });
    return;
  }
  const resolved = await lookupAll(upstream.hostname);
  if (resolved.addresses.length === 0) {
    record('window', normalizeName(upstream.hostname), port, `deny:unresolved:${resolved.reason}`);
    answerJson(response, 502, { error: 'the upstream of this grant does not resolve' });
    return;
  }
  const chosen = chooseAddress(resolved.addresses);
  if (isOwnListener(chosen.address, port)) {
    record('window', normalizeName(upstream.hostname), port, 'deny:own-listener');
    answerJson(response, 403, { error: 'refused destination' });
    return;
  }

  // Whatever the space sent as credentials goes, and the grant's own header takes its place. A
  // grant without a secret, an opened domain, adds nothing: the upstream sees the request as the
  // space made it, less the credential headers.
  const headers = { ...request.headers };
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (['authorization', 'x-api-key', 'proxy-authorization'].includes(lower) || lower === grant.header) delete headers[name];
  }
  headers.host = upstream.host;
  if (grant.secret !== null) {
    headers[grant.header] = grant.header === 'authorization' ? `Bearer ${grant.secret}` : grant.secret;
  }

  record('window', normalizeName(upstream.hostname), port, 'allow');
  const transport = upstream.protocol === 'https:' ? https : http;
  const outgoing = transport.request({
    hostname: upstream.hostname,
    port,
    method: request.method,
    path: upstream.pathname.replace(/\/$/, '') + (match[2] || ''),
    headers,
    agent: windowAgents[upstream.protocol],
    // The address was checked a moment ago, and this is the address the request goes to.
    lookup: fixedLookup(chosen.address, chosen.family),
  }, (answer) => {
    response.writeHead(answer.statusCode || 502, answer.headers);
    answer.on('error', () => { response.destroy(); });
    answer.pipe(response);
  });
  // The deadline covers the whole exchange, silence by silence. `given` keeps the record to one
  // per request: the destroy below makes the socket error, and that is this timeout, not news.
  let given = false;
  outgoing.setTimeout(WINDOW_IDLE_MS, () => {
    given = true;
    record('window', normalizeName(upstream.hostname), port, 'failed:timeout');
    if (!response.headersSent) answerJson(response, 504, { error: 'the upstream did not answer in time' });
    else response.destroy();
    outgoing.destroy();
  });
  outgoing.on('error', (error) => {
    if (given) return;
    given = true;
    // Allowed, and the connection out did not happen, which is not the same as a refusal.
    // The message can hold the upstream's name, never a header or a body.
    const code = String(error.code || 'error').slice(0, 32);
    record('window', normalizeName(upstream.hostname), port, `failed:${code}`);
    if (!response.headersSent) answerJson(response, 502, { error: 'the upstream did not answer' });
    else response.destroy();
  });
  response.on('close', () => {
    // A finished answer has already ended this socket; destroying then would be the same defect
    // the corridor had. This is for an answer that stopped short, where the client went away.
    if (!response.writableFinished) outgoing.destroy();
  });
  request.pipe(outgoing);
}

// ---------------------------------------------------------------------------------------------
// Control, on loopback only
// ---------------------------------------------------------------------------------------------

const readBody = (request) => new Promise((resolve) => {
  let text = '';
  let tooLarge = false;
  request.on('data', (chunk) => {
    if (tooLarge) return;
    text += chunk;
    if (text.length > CONTROL_BODY_BYTES) {
      tooLarge = true;
      text = '';
    }
  });
  request.on('error', () => resolve(null));
  request.on('end', () => resolve(tooLarge ? null : text));
});

/**
 * One field of a control request as text. A name, a header name and a secret are text; a list,
 * an object or nothing at all is none of those, and comes out as the empty string that every
 * check below refuses.
 */
const asText = (value) => (value === null || value === undefined || value instanceof Object ? '' : String(value));

function setNetwork(body) {
  if (body.mode !== 'allowlist' && body.mode !== 'open') return 'mode is "allowlist" or "open"';
  const domains = Array.isArray(body.domains) ? body.domains : [];
  if (domains.length > MAX_ALLOWED_DOMAINS) return `at most ${MAX_ALLOWED_DOMAINS} domains`;
  const names = domains.map((domain) => normalizeName(asText(domain)));
  // The same rule a target passes, so the host never puts an entry on the list that the corridor
  // would always refuse. An address on it would be a way around the ranges this refuses anyway.
  const wrong = names.find((name) => !isDomainName(name) || parseIPv4(name) || parseIPv6(name));
  if (wrong !== undefined) return `'${wrong}' is not a domain name. The allowlist holds exact names, no wildcards and no addresses.`;
  networkMode = body.mode;
  allowedDomains = new Set(names);
  return null;
}

/**
 * A grant with a secret names the header that carries it; a grant without one, an opened domain,
 * names no header and the window adds nothing. A body with a header and no secret, or a secret
 * and no header, is refused: either the grant hides a credential or it does not.
 */
function addGrant(body) {
  const id = asText(body.id);
  if (!GRANT_ID_PATTERN.test(id)) return 'a grant id is 1 to 64 letters, digits, dots, dashes or underscores';
  const withSecret = body.secret !== undefined || body.header !== undefined;
  const header = withSecret ? asText(body.header).toLowerCase() : null;
  const secret = withSecret ? asText(body.secret) : null;
  if (withSecret && !HEADER_NAME_PATTERN.test(header)) return 'a header name is 1 to 64 letters, digits or dashes';
  if (withSecret && (secret.length === 0 || secret.length > MAX_SECRET_LENGTH)) return 'a grant with a header needs a secret';
  let upstream;
  try {
    upstream = new URL(asText(body.upstream));
  } catch {
    return 'the upstream of a grant is a URL';
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') return 'the upstream of a grant is http or https';
  grants.set(id, { upstream: upstream.toString(), header, secret });
  return null;
}

async function serveControl(request, response) {
  request.on('error', () => {});
  const path = String(request.url || '').split('?')[0];
  if (request.method === 'GET' && path === '/health') {
    answerJson(response, 200, { ready: true, mode: networkMode, domains: allowedDomains.size, grants: grants.size });
    return;
  }
  if (request.method === 'GET' && path === '/policy') {
    // What the host last said, so it can tell a gatekeeper that forgot from one that remembers.
    // Ids and names only: a secret is never read back, not even by the host.
    answerJson(response, 200, { mode: networkMode, domains: Array.from(allowedDomains), grants: Array.from(grants.keys()) });
    return;
  }
  if (request.method === 'GET' && path === '/journal') {
    // Since when: the journal is memory only, so the host says that nothing older exists.
    answerJson(response, 200, { records: journal.slice(), dropped: journalDropped, since: STARTED_AT });
    return;
  }
  if (request.method !== 'POST' || (path !== '/network' && path !== '/grants')) {
    answerJson(response, 404, { error: 'no such control endpoint' });
    return;
  }
  const text = await readBody(request);
  let body = null;
  try {
    body = JSON.parse(text ?? '');
  } catch {
    answerJson(response, 400, { error: 'the body is not JSON' });
    return;
  }
  if (!(body instanceof Object) || Array.isArray(body)) {
    answerJson(response, 400, { error: 'the body is not an object' });
    return;
  }
  const problem = path === '/network' ? setNetwork(body) : addGrant(body);
  if (problem) answerJson(response, 400, { error: problem });
  else answerJson(response, 200, { ok: true });
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

let listening = false;
const lastNote = new Map();

/**
 * Traffic that never reached a decision: a connection the socket cap refused, or a request the
 * HTTP parser threw out. Recorded at most once a minute per listener and per kind, because the
 * flood is the point of the record and 500 notes of it would erase everything else.
 */
function noteRefusedTraffic(listener, decision) {
  const key = `${listener}:${decision}`;
  const last = lastNote.get(key) ?? 0;
  if (Date.now() - last < NOTE_INTERVAL_MS) return;
  lastNote.set(key, Date.now());
  record(listener, '', 0, decision);
}

function makeServer(listener, maxConnections, handler) {
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, handler);
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  // Sockets, not requests. Without this the space can hold thousands of connections open in the
  // header window and have the process killed for its memory, which would take the journal too.
  server.maxConnections = maxConnections;
  server.on('drop', () => noteRefusedTraffic(listener, 'deny:too-many-connections'));
  // A client that sends nonsense gets an answer and its own socket destroyed, and no other client
  // notices. It is journalled the same way a refused connection is, rate-limited: a request the
  // parser threw out never reaches a decision, and without a record here a space could probe with
  // targets the parser rejects and leave the user's view of its attempts blind by construction.
  server.on('clientError', (error, socket) => {
    noteRefusedTraffic(listener, 'deny:unreadable-request');
    if (!socket.destroyed && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  server.on('error', (error) => {
    // A port that cannot be taken must end the start. Afterwards, a failed accept is the
    // space's doing, for example by running the process out of file descriptors, and
    // ending the gatekeeper on that would be a denial of service it can trigger at will.
    console.error(`gatekeeper: listener error ${error.code || error.message}`);
    if (!listening) process.exit(1);
  });
  return server;
}

const corridor = makeServer('corridor', MAX_CORRIDOR_CONNECTIONS, refusePlainProxy);
corridor.on('connect', (request, socket, head) => {
  openTunnel(request, socket, head).catch(() => { socket.destroy(); });
});
const windowServer = makeServer('window', MAX_WINDOW_CONNECTIONS, (request, response) => {
  serveWindow(request, response).catch(() => {
    if (!response.headersSent) answerJson(response, 502, { error: 'the window could not serve this request' });
    else response.destroy();
  });
});
const control = makeServer('control', MAX_CONTROL_CONNECTIONS, (request, response) => {
  serveControl(request, response).catch(() => {
    if (!response.headersSent) answerJson(response, 500, { error: 'the control channel could not serve this request' });
    else response.destroy();
  });
});

const listen = (server, port, host) => new Promise((resolve) => { server.listen(Number(port), host, resolve); });

async function main() {
  // Here and not at the top: requiring this file from a test must not read the runner's argv.
  const bindHost = readBindHost(bindArgument);
  if (!bindHost || !corridorPort || !windowPort || !controlPort) {
    console.error('gatekeeper: arguments are <bind host> <corridor port> <window port> <control port>');
    process.exit(2);
  }
  await listen(corridor, corridorPort, bindHost);
  await listen(windowServer, windowPort, bindHost);
  // Last, and on loopback only: an answer from here means all three are up.
  await listen(control, controlPort, CONTROL_HOST);
  listening = true;
  // Only now. A listener that cannot bind must still end the process.
  //
  // What this line may say is limited on purpose. An error's message can carry what the space
  // sent, a header value or a piece of a body among it, and the container log is not a place for
  // that. The name, the code and the frame where it happened say where to look without it.
  process.on('uncaughtException', (error) => {
    console.error(`gatekeeper: kept running after ${describeFailure(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`gatekeeper: kept running after a rejected promise, ${describeFailure(reason)}`);
  });
  console.log(`gatekeeper: corridor ${corridorPort}, window ${windowPort}, control ${CONTROL_HOST}:${controlPort}`);
}

/** The kind of failure and where it happened, and nothing that came from outside. */
function describeFailure(error) {
  if (!(error instanceof Error)) return 'something that is not an error';
  const frame = String(error.stack ?? '').split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
  return `${error.name}${error.code ? ` (${error.code})` : ''}${frame ? ` ${frame.trim()}` : ''}`;
}

// The container runs this file as its main module. A test can require it instead and call the
// rules directly, so every range and every target form is covered without a listener and without
// a switch that changes a decision.
if (require.main === module) {
  main();
} else {
  module.exports = { addGrant, chooseAddress, isBlockedAddress, isDomainName, joinSockets, parseIPv4, parseIPv6, refuseTarget, setNetwork, splitTarget, walksOutOfGrant };
}
