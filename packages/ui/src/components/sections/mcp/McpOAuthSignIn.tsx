import React from 'react';
import { ProviderOAuthMethods } from '@/components/sections/providers/ProviderOAuthMethods';
import { getMcpOAuthMethods } from './mcpOAuthIntegration';
import { useMcpOAuthIntegration } from './useMcpOAuthIntegration';

interface McpOAuthSignInProps {
  serverName: string;
  directory: string | null;
  onConnected: () => void | Promise<void>;
  autoStart?: boolean;
  connectLabel?: string;
  showStartButton?: boolean;
  onActiveChange?: (active: boolean) => void;
  onUnavailable?: () => void;
}

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
