/**
 * The managed usage credentials the webview answers locally, by bridging to the
 * extension host instead of forwarding to OpenCode.
 *
 * Owned here rather than inlined in `main.tsx` so the id list is testable
 * without importing the app entrypoint, and so it has one place to agree with
 * the extension host's `api:quota:credentials` handler. An id missing from this
 * list falls through to the OpenCode upstream, which has no credential routes,
 * so the provider's secret cannot be saved from the extension at all — which is
 * what happened to exe.dev before it was listed.
 *
 * Ollama Cloud is deliberately absent: its usage comes from `GET /api/usage`
 * with the API key OpenCode already holds, so there is nothing to paste.
 */
export const MANAGED_CREDENTIAL_PROVIDERS = ['exe-dev', 'cursor', 'zenmux'] as const;

const QUOTA_CREDENTIAL_ROUTE = new RegExp(
  `^/api/quota/credentials/(${MANAGED_CREDENTIAL_PROVIDERS.join('|')})(?:/(validate|import))?$`,
);

export interface QuotaCredentialBridge {
  providerId: string;
  /** `GET`/`PUT`/`DELETE`, or the named operation for `/validate` and `/import`. */
  method: string;
}

/**
 * The bridge message for a local credential request, or null when the path is
 * not one of ours and must be forwarded upstream instead.
 */
export const matchQuotaCredentialRoute = (pathname: string, method: string): QuotaCredentialBridge | null => {
  const match = QUOTA_CREDENTIAL_ROUTE.exec(pathname);
  if (!match) return null;
  return { providerId: match[1], method: match[2]?.toUpperCase() || method };
};
