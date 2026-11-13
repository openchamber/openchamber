import React from 'react';
import { ProviderOAuthMethods } from '@/components/sections/providers/ProviderOAuthMethods';
import { getMcpOAuthMethods } from './mcpOAuthIntegration';
import { useMcpOAuthIntegration } from './useMcpOAuthIntegration';

interface McpOAuthSignInProps {
  serverName: string;
  /** The Location whose config declares the server; its integration lives there. */
  directory: string | null;
  /** Runs after OpenCode has stored the credential, so the caller can reconnect. */
  onConnected: () => void | Promise<void>;
  /** Start the sign-in as soon as the integration shows up. */
  autoStart?: boolean;
  /** The start button's text; "Connect" when absent. */
  connectLabel?: string;
  /** Off when the caller starts the sign-in from its own button (with `autoStart`). */
  showStartButton?: boolean;
}

/**
 * The OAuth sign-in for a remote MCP server. OpenCode registers such a server
 * as an integration with one `oauth` method, so the sign-in is the same
 * connect / status / complete flow the Providers page runs; only the lookup
 * (by server name, in the server's Location) is MCP-specific. Renders nothing
 * while the integration is unknown.
 */
export const McpOAuthSignIn: React.FC<McpOAuthSignInProps> = ({
  serverName,
  directory,
  onConnected,
  autoStart,
  connectLabel,
  showStartButton,
}) => {
  const integration = useMcpOAuthIntegration(serverName, directory);
  if (!integration) return null;

  return (
    <ProviderOAuthMethods
      key={integration.id}
      integrationId={integration.id}
      methods={getMcpOAuthMethods(integration)}
      directory={directory}
      onConnected={onConnected}
      autoStart={autoStart}
      connectLabel={connectLabel}
      showStartButton={showStartButton}
    />
  );
};
