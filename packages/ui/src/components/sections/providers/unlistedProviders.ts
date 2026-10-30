/**
 * Providers OpenCode reports no entry for, although their integration holds a
 * connection.
 *
 * OpenCode lists a provider only once it has a chat model to serve, so an
 * account that currently serves none (Copilot Free, a plan that ran out, an
 * OAuth login whose models are all disabled) leaves no provider behind. The
 * credential is still stored, so the provider is also gone from the connect
 * page, which drops anything with a connection. Without these entries the
 * account could not be reached at all: no card to open, no way to switch or
 * remove it. Settings shows them as connected with no models so the account
 * stays manageable.
 */

import type { IntegrationInfo } from '@opencode/client';
import type { IntegrationCatalog } from '@/lib/opencode/integration-catalog';
import type { Model, Provider } from '@/lib/opencode/model';
import { isWebSearchIntegration } from '@/lib/opencode/websearch';
import { getProviderIdForSignInIntegration } from './providerAuth';

/** A provider as the grid and the detail page read it: catalog entry plus its models. */
export type ProviderWithModels = Provider & { models: Model[] };

export interface UnlistedConnectedProvider {
  /** The provider id the connection belongs to. */
  id: string;
  name: string;
  /**
   * Set when the connection lives on another integration than the provider's
   * own (OpenCode Go signs in through the Console), so account actions go to
   * the integration that actually holds the credential.
   */
  integrationID?: string;
}

/**
 * Whether an integration holds an account for a provider, rather than being an
 * MCP sign-in or a search key: those connect from their own screens and are
 * not providers whose account could be switched here.
 */
const holdsProviderAccount = (
  integration: IntegrationInfo,
  catalog: IntegrationCatalog,
): boolean => integration.connections.length > 0
  && !integration.id.startsWith('mcp_')
  && !catalog.webSearchIds?.has(integration.id)
  && !isWebSearchIntegration(integration);

/**
 * The connections OpenCode reports no provider for, sorted by name. A provider
 * OpenCode already lists is left out: its own card carries the account.
 */
export const listUnlistedConnectedProviders = (
  catalog: IntegrationCatalog,
  listedProviderIds: ReadonlySet<string>,
): UnlistedConnectedProvider[] => {
  // Keyed by provider id: two integrations can belong to one provider (the
  // Console login and OpenCode Go's own key), and a card is shown once.
  const byProviderId = new Map<string, UnlistedConnectedProvider>();

  for (const integration of catalog.integrations) {
    if (!holdsProviderAccount(integration, catalog)) continue;
    const providerId = getProviderIdForSignInIntegration(integration.id);
    // Either side being listed means the page already has a card for it.
    if (listedProviderIds.has(providerId) || listedProviderIds.has(integration.id)) continue;
    if (byProviderId.has(providerId)) continue;
    byProviderId.set(providerId, {
      id: providerId,
      name: integration.name || providerId,
      integrationID: integration.id === providerId ? undefined : integration.id,
    });
  }

  return [...byProviderId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
};

/**
 * The page's view of such a connection. Nothing beyond its id and name is
 * known, so it carries no models; `activation` is OpenCode's own default and
 * nothing reads it for these cards.
 */
export const toProviderWithModels = (entry: UnlistedConnectedProvider): ProviderWithModels => ({
  id: entry.id,
  name: entry.name,
  activation: 'auto',
  package: '',
  integrationID: entry.integrationID,
  models: [],
});
