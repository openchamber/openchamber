import React from 'react';
import type { Integration as IntegrationInfo } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { findMcpIntegration, getMcpOAuthMethods } from './mcpOAuthIntegration';

export const useMcpOAuthIntegration = (
  serverName: string,
  directory: string | null,
  enabled = true,
  onUnavailable?: () => void,
): IntegrationInfo | null => {
  const [result, setResult] = React.useState<{
    serverName: string;
    directory: string | null;
    integration: IntegrationInfo;
  } | null>(null);
  const onUnavailableRef = React.useRef(onUnavailable);
  React.useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  });

  React.useEffect(() => {
    let cancelled = false;
    setResult(null);
    if (!enabled) return;
    const sdk = directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient();
    const load = async (attempt = 0): Promise<void> => {
      try {
        const { data } = await sdk.integration.list();
        if (cancelled) return;
        const found = findMcpIntegration(data, serverName) ?? null;
        if (found) {
          setResult({ serverName, directory, integration: found });
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

  if (!enabled || result?.serverName !== serverName || result.directory !== directory) return null;
  return getMcpOAuthMethods(result.integration).length > 0 ? result.integration : null;
};
