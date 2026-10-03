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
}

/**
 * The OAuth sign-in for a remote MCP server. OpenCode registers such a server
 * as an integration with one `oauth` method, so the sign-in is the same
 * connect / status / complete flow the Providers page runs; only the lookup
 * (by server name, in the server's Location) is MCP-specific. Renders nothing
 * while the integration is unknown.
 */
export const McpOAuthSignIn: React.FC<McpOAuthSignInProps> = ({ serverName, directory, onConnected }) => {
  const [integration, setIntegration] = React.useState<IntegrationInfo | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setIntegration(null);
    const sdk = directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient();
    const load = async () => {
      try {
        const { data } = await sdk.integration.list();
        if (!cancelled) setIntegration(findMcpIntegration(data, serverName) ?? null);
      } catch (error) {
        console.error('Failed to load MCP integrations:', error);
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
    />
  );
};
