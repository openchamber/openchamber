import net from 'node:net';

// Node caps each happy-eyeballs connect attempt at 250ms by default
// (autoSelectFamilyAttemptTimeout). TCP handshakes to provider endpoints that are
// geographically distant routinely take 300-1500ms, so fetch() from a Node process
// aborts every attempt (ETIMEDOUT) and surfaces "fetch failed" even though the host
// is reachable — e.g. the z.ai quota endpoint from an IPv4-only egress (#3399).
//
// Every Node process entrypoint that performs provider fetches raises the
// per-attempt cap. Family autoselection itself stays enabled, so the IPv6→IPv4
// fallback and ::1/localhost servers keep working; disabling it instead breaks
// local MCP servers. Runtimes without the setter (Bun's fetch path, older Node)
// are a no-op.
export const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

export const applyConnectAttemptTimeout = (netModule = net) => {
  try {
    netModule.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
};
