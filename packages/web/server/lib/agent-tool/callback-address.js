/**
 * Where a managed OpenCode child reaches the OpenChamber server, and which
 * peers count as that child.
 *
 * Every callback the server hands its child (agent tool, shell boundary,
 * credential helper) is plain HTTP with a per-child token, so all of them
 * share one answer: point at loopback unless the listener is bound to one
 * concrete address, which does not answer on loopback, and accept a peer
 * only when it is that same machine.
 */

// `server.address()` and `socket.remoteAddress` yield a string or nothing.
// Node reports an IPv4 peer on a dual-stack socket as `::ffff:<ipv4>`.
const normalizeAddress = (value) => {
  const address = String(value ?? '').trim().toLowerCase();
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
};

const isLoopbackAddress = (value) => {
  const address = normalizeAddress(value);
  return address === '127.0.0.1' || address === '::1';
};

const WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::']);

// A wildcard listener answers on loopback. A listener bound to one concrete
// address answers only there, so that address is the only way back in.
const resolveConcreteBoundAddress = (value) => {
  const address = normalizeAddress(value);
  return address && !WILDCARD_ADDRESSES.has(address) ? address : null;
};

/**
 * `getActiveHost` reads the listener's bound address at call time; a pipe
 * listener or a server that is not up yet yields null, which means loopback.
 */
export const createCallbackAddress = (getActiveHost = () => null) => {
  const getConcreteBoundAddress = () => resolveConcreteBoundAddress(getActiveHost());

  /** The host part of a callback URL, bracketed when it is IPv6. */
  const callbackHost = () => {
    const address = getConcreteBoundAddress() || '127.0.0.1';
    return address.includes(':') ? `[${address}]` : address;
  };

  // The managed child runs on this machine. Reaching a listener bound to one
  // concrete address makes the OS source the connection from that same address,
  // so it stands in for loopback there; any other machine arrives as itself.
  const isSameMachineAddress = (value) => {
    if (isLoopbackAddress(value)) return true;
    const boundAddress = getConcreteBoundAddress();
    return boundAddress !== null && normalizeAddress(value) === boundAddress;
  };

  return Object.freeze({ callbackHost, isSameMachineAddress });
};
