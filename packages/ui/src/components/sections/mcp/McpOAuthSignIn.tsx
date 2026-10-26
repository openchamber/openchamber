import React from 'react';
import type { IntegrationInfo } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import { ProviderOAuthMethods } from '@/components/sections/providers/ProviderOAuthMethods';
import { findMcpIntegration, getMcpOAuthMethods } from './mcpOAuthIntegration';

interface McpOAuthSignInProps {
  serverName: string;
  /** The Location whose config declares the server; its integration lives there. */
  directory: string | null;
  /** Runs after OpenCode has stored the credential, so the caller can reconnect. */
  onConnected: () => void | Promise<void>;
  /** Start the sign-in as soon as the integration shows up. */
  autoStart?: boolean;
}

/**
 * The OAuth sign-in for a remote MCP server. OpenCode registers such a server
 * as an integration with one `oauth` method, so the sign-in is the same
 * connect / status / complete flow the Providers page runs; only the lookup
 * (by server name, in the server's Location) is MCP-specific. Renders nothing
 * while the integration is unknown.
 */
export const McpOAuthSignIn: React.FC<McpOAuthSignInProps> = ({ serverName, directory, onConnected, autoStart }) => {
  const [integration, setIntegration] = React.useState<IntegrationInfo | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setIntegration(null);
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
          return;
        }
        if (attempt < 8) {
          setTimeout(() => { void load(attempt + 1); }, 750);
        }
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to load MCP integrations:', error);
        if (attempt < 8) {
          setTimeout(() => { void load(attempt + 1); }, 750);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [directory, serverName]);

  const methods = getMcpOAuthMethods(integration ?? undefined);
  if (!integration || methods.length === 0) return null;

  return (
    <ProviderOAuthMethods
      key={integration.id}
      integrationId={integration.id}
      methods={methods}
      directory={directory}
      onConnected={onConnected}
      autoStart={autoStart}
    />
  );
};
