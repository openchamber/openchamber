/**
 * Settings search reveal for the Tunnel page managed sections (#1764).
 *
 * The tunnel.managed-remote and tunnel.managed-local-config search entries
 * point at sections the Tunnel page renders only for the SAVED tunnel mode,
 * so picking a result for the other managed mode mounted nothing and the
 * reveal loop silently gave up. Search preparation maps each of those
 * results to the mode its section needs and hands it over through the UI
 * store (the providers.classification request-flag pattern); the Tunnel
 * page consumes it as a VIEW-ONLY reveal.
 *
 * View-only is the load-bearing property: the mode selector persists
 * through handleModeChange, so revealing must never route through it, and
 * no save may derive its mode from the revealed mode. The saved mode stays
 * the only mode persistence and tunnel-start logic ever see; the revealed
 * mode decides only which mode sections render.
 */
type TunnelSearchRevealMode = "managed-remote" | "managed-local";

const TUNNEL_SEARCH_REVEAL_MODES: Readonly<Record<string, TunnelSearchRevealMode>> = {
  "tunnel.managed-remote": "managed-remote",
  "tunnel.managed-local-config": "managed-local",
};

/** The managed mode a settings search result needs revealed, or null for every other result. */
export const tunnelSearchRevealModeForResult = (resultId: string): TunnelSearchRevealMode | null =>
  TUNNEL_SEARCH_REVEAL_MODES[resultId] ?? null;

export const isTunnelSearchRevealMode = (value: string | null): value is TunnelSearchRevealMode =>
  value === "managed-remote" || value === "managed-local";

/**
 * The mode the Tunnel page renders its mode sections for: a pending search
 * reveal wins over the saved mode. Purely presentational — callers keep
 * using the saved mode for every save and for starting the tunnel.
 */
export const displayedTunnelMode = <Mode extends string>(savedMode: Mode, revealedMode: Mode | null): Mode =>
  revealedMode ?? savedMode;
