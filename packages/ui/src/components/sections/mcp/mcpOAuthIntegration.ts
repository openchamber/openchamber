import type { IntegrationInfo, IntegrationOAuthMethod } from '@opencode/client';

/**
 * The integration OpenCode registers for a remote MCP server's OAuth login.
 *
 * Every remote server with OAuth enabled becomes an integration whose id is
 * `mcp_` plus a hash of the server's name and URL, with `metadata.source`
 * set to `mcp` and the server's name as its own. The hash is upstream's to
 * compute, so the match goes by source and name.
 */
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
