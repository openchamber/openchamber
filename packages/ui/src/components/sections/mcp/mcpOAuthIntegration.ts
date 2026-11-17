import type { IntegrationInfo, IntegrationOAuthMethod } from '@opencode/client';

export const findMcpIntegration = (
  integrations: readonly IntegrationInfo[],
  serverName: string,
): IntegrationInfo | undefined =>
  integrations.find(
    (integration) =>
      integration.id.startsWith('mcp_')
      && integration.metadata?.source === 'mcp'
      && integration.name === serverName,
  );

export const getMcpOAuthMethods = (integration: IntegrationInfo | undefined): IntegrationOAuthMethod[] =>
  (integration?.methods ?? []).filter((method): method is IntegrationOAuthMethod => method.type === 'oauth');
