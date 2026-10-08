import type { I18nKey } from '@/lib/i18n';
import type { IntegrationCatalog } from '@/lib/opencode/integration-catalog';

export interface ConnectableProvider {
  id: string;
  name: string;
}

interface PopularProvider {
  id: string;
  /** One line saying what the provider gives you. */
  noteKey: I18nKey;
  recommended: boolean;
}

/**
 * Leads the connect page, in this order. Recommended providers come first; a
 * provider that is already listed (connected, or found in the environment)
 * drops out, because it connects from its own page.
 */
export const POPULAR_PROVIDERS: readonly PopularProvider[] = [
  { id: 'openai', noteKey: 'settings.providers.connect.note.openai', recommended: true },
  { id: 'opencode-go', noteKey: 'settings.providers.connect.note.opencodeGo', recommended: true },
  { id: 'openrouter', noteKey: 'settings.providers.connect.note.openrouter', recommended: true },
  { id: 'anthropic', noteKey: 'settings.providers.connect.note.anthropic', recommended: false },
  { id: 'github-copilot', noteKey: 'settings.providers.connect.note.githubCopilot', recommended: false },
  { id: 'google', noteKey: 'settings.providers.connect.note.google', recommended: false },
  { id: 'vercel', noteKey: 'settings.providers.connect.note.vercel', recommended: false },
];

const POPULAR_IDS = new Set(POPULAR_PROVIDERS.map((provider) => provider.id));

/**
 * What can still be connected. v2's provider list holds only what is
 * configured or connected right now, so the candidates are the integrations,
 * minus those with any connection, MCP OAuth registrations (`mcp_*`), web
 * search providers (their keys live in Settings → Web search) and providers
 * OpenCode already lists. Sorted by name.
 */
export const listConnectableProviders = (
  catalog: IntegrationCatalog,
  listedProviderIds: ReadonlySet<string>,
): ConnectableProvider[] => catalog.integrations
  .filter((integration) => integration.connections.length === 0
    && !integration.id.startsWith('mcp_')
    && !catalog.webSearchIds?.has(integration.id)
    && !listedProviderIds.has(integration.id))
  .map((integration) => ({ id: integration.id, name: integration.name || integration.id }))
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

interface ConnectableProviderGroups {
  /** Popular providers that can still be connected, in `POPULAR_PROVIDERS` order. */
  popular: Array<ConnectableProvider & PopularProvider>;
  others: ConnectableProvider[];
}

export const splitConnectableProviders = (providers: readonly ConnectableProvider[]): ConnectableProviderGroups => {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    popular: POPULAR_PROVIDERS.flatMap((popular) => {
      const provider = byId.get(popular.id);
      return provider ? [{ ...provider, ...popular }] : [];
    }),
    others: providers.filter((provider) => !POPULAR_IDS.has(provider.id)),
  };
};
