import type { I18nKey } from '@/lib/i18n';
import type { IntegrationCatalog } from '@/lib/opencode/integration-catalog';
import { isWebSearchIntegration } from '@/lib/opencode/websearch';

export interface ConnectableProvider {
  id: string;
  name: string;
}

interface PopularProvider {
  id: string;
  noteKey: I18nKey;
  recommended: boolean;
}

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

export const listConnectableProviders = (
  catalog: IntegrationCatalog,
  listedProviderIds: ReadonlySet<string>,
): ConnectableProvider[] => catalog.integrations
  .filter((integration) => integration.connections.length === 0
    && !integration.id.startsWith('mcp_')
    && !catalog.webSearchIds?.has(integration.id)
    && !isWebSearchIntegration(integration)
    && !listedProviderIds.has(integration.id))
  .map((integration) => ({ id: integration.id, name: integration.name || integration.id }))
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

interface ConnectableProviderGroups {
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
