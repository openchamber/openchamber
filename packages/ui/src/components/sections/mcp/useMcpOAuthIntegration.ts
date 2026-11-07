import React from 'react';
import type { IntegrationInfo } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import { findMcpIntegration, getMcpOAuthMethods } from './mcpOAuthIntegration';

/**
 * The OAuth integration OpenCode registered for an MCP server, or null while
 * it is unknown or when the server has no OAuth sign-in. Nothing is read
 * while `enabled` is false. `onUnavailable` runs once when the lookup ends
 * without a sign-in to offer: the retries ran out, or the integration has no
 * OAuth method. Null alone cannot tell that apart from "still looking".
 */
export const useMcpOAuthIntegration = (
  serverName: string,
  directory: string | null,
  enabled = true,
  onUnavailable?: () => void,
): IntegrationInfo | null => {
  const [integration, setIntegration] = React.useState<IntegrationInfo | null>(null);
  const onUnavailableRef = React.useRef(onUnavailable);
  React.useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  });

  React.useEffect(() => {
    let cancelled = false;
    setIntegration(null);
    if (!enabled) return;
    const sdk = directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient();
    /**
     * The mcp_* integration is registered by OpenCode on the server's first
     * attempt, so the list read right after an install can race it and miss.
     * Retry on a short interval until it shows up (or the panel unmounts) —
     * a single load here left the sign-in panel empty until it was remounted
     * from another surface.
     */
    const load = async (attempt = 0): Promise<void> => {
      try {
        const { data } = await sdk.integration.list();
        if (cancelled) return;
        const found = findMcpIntegration(data, serverName) ?? null;
        if (found) {
          setIntegration(found);
          if (getMcpOAuthMethods(found).length === 0) onUnavailableRef.current?.();
          return;
        }
        retryOrGiveUp(attempt);
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to load MCP integrations:', error);
        retryOrGiveUp(attempt);
      }
    };
    const retryOrGiveUp = (attempt: number) => {
      if (attempt < 8) {
        setTimeout(() => { void load(attempt + 1); }, 750);
      } else {
        onUnavailableRef.current?.();
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [directory, enabled, serverName]);

  return getMcpOAuthMethods(integration ?? undefined).length > 0 ? integration : null;
};
