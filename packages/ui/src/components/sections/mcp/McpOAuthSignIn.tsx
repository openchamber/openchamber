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
  /**
   * Off when the caller starts the sign-in from its own button (with
   * `autoStart`). A server with several sign-in methods keeps its start
   * buttons anyway: `autoStart` starts only a single method, so the user picks.
   */
  showStartButton?: boolean;
  /**
   * Told while a sign-in runs. Starting one from another machine writes the
   * server's redirect, and OpenCode reports the server `pending` while it
   * reconnects, so a caller that mounts this only for `needs_auth` must keep
   * it mounted until the sign-in ends: unmounting cancels the attempt.
   */
  onActiveChange?: (active: boolean) => void;
  /** Runs once when no sign-in can be offered, so the caller can say so. */
  onUnavailable?: () => void;
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
  onActiveChange,
  onUnavailable,
}) => {
  const integration = useMcpOAuthIntegration(serverName, directory, true, onUnavailable);
  if (!integration) return null;
  const methods = getMcpOAuthMethods(integration);

  return (
    <ProviderOAuthMethods
      key={integration.id}
      integrationId={integration.id}
      methods={methods}
      directory={directory}
      onConnected={onConnected}
      autoStart={autoStart}
      connectLabel={connectLabel}
      showStartButton={(showStartButton ?? true) || methods.length > 1}
      onActiveChange={onActiveChange}
    />
  );
};
