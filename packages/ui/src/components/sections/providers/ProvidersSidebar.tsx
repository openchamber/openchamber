import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ButtonSmall } from '@/components/ui/button-small';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { RiAddLine, RiStackLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { opencodeClient } from '@/lib/opencode/client';

const ADD_PROVIDER_ID = '__add_provider__';

interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

interface ProviderSources {
  auth: ProviderSourceInfo;
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
}

const getCurrentDirectory = (): string | null => {
  const dir = opencodeClient.getDirectory();
  if (typeof dir === 'string' && dir.trim().length > 0) {
    return dir.trim();
  }
  return null;
};

interface ProvidersSidebarProps {
  onItemSelect?: () => void;
}

export const ProvidersSidebar: React.FC<ProvidersSidebarProps> = ({ onItemSelect }) => {
  const providers = useConfigStore((state) => state.providers);
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const [sourcesByProvider, setSourcesByProvider] = React.useState<Record<string, ProviderSources>>({});
  const directory = React.useMemo(() => {
    // tie refresh to active project changes (directory is stored in the client)
    void activeProjectId;
    return getCurrentDirectory();
  }, [activeProjectId]);

  React.useEffect(() => {
    if (providers.length === 0) {
      setSourcesByProvider({});
      return;
    }

    let cancelled = false;

    const loadAllSources = async () => {
      const tasks = providers.map(async (provider) => {
        try {
          const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
          const response = await fetch(`/api/provider/${encodeURIComponent(provider.id)}/source${query}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (!response.ok) {
            return;
          }
          const payload = await response.json().catch(() => null);
          const sources = (payload?.sources ?? payload?.data?.sources) as ProviderSources | undefined;
          if (!sources) {
            return;
          }
          if (cancelled) {
            return;
          }
          setSourcesByProvider((prev) => ({
            ...prev,
            [provider.id]: sources,
          }));
        } catch {
          // ignore
        }
      });

      await Promise.all(tasks);
    };

    void loadAllSources();

    return () => {
      cancelled = true;
    };
  }, [directory, providers]);

  const bgClass = 'bg-background';

  const projectProviders = React.useMemo(() => {
    return providers.filter((p) => Boolean(sourcesByProvider[p.id]?.project?.exists));
  }, [providers, sourcesByProvider]);

  const userProviders = React.useMemo(() => {
    return providers.filter((p) => !sourcesByProvider[p.id]?.project?.exists);
  }, [providers, sourcesByProvider]);

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground mb-3">Providers</h2>
        <SettingsProjectSelector className="mb-3" />
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">Total {providers.length}</span>
          <ButtonSmall
            variant="ghost"
            className="h-7 w-7 px-0 -my-1 text-muted-foreground"
            onClick={() => {
              setSelectedProvider(ADD_PROVIDER_ID);
              onItemSelect?.();
            }}
            aria-label="Connect provider"
            title="Connect provider"
          >
            <RiAddLine className="h-3.5 w-3.5" />
          </ButtonSmall>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {providers.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <RiStackLine className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">No providers found</p>
            <p className="typography-meta mt-1 opacity-75">Check your OpenCode configuration</p>
          </div>
        ) : (
          <>
            {userProviders.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  User Providers
                </div>
                {userProviders.map((provider) => (
                  <ProviderListItem
                    key={provider.id}
                    provider={provider}
                    selectedProviderId={selectedProviderId}
                    onSelect={() => {
                      setSelectedProvider(provider.id);
                      onItemSelect?.();
                    }}
                  />
                ))}
              </>
            )}

            {projectProviders.length > 0 && (
              <>
                <div className={cn('px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground', userProviders.length > 0 ? 'pt-3' : 'pt-2')}>
                  Project Providers
                </div>
                {projectProviders.map((provider) => (
                  <ProviderListItem
                    key={provider.id}
                    provider={provider}
                    selectedProviderId={selectedProviderId}
                    onSelect={() => {
                      setSelectedProvider(provider.id);
                      onItemSelect?.();
                    }}
                  />
                ))}
              </>
            )}
          </>
        )}
      </ScrollableOverlay>
    </div>
  );
};

const ProviderListItem: React.FC<{
  provider: { id: string; name?: string; models?: unknown[] };
  selectedProviderId: string;
  onSelect: () => void;
}> = ({ provider, selectedProviderId, onSelect }) => {
  const modelCount = Array.isArray(provider.models) ? provider.models.length : 0;
  const isSelected = provider.id === selectedProviderId;

  return (
    <div
      key={provider.id}
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200',
        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        tabIndex={0}
      >
        <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />
        <span className="typography-ui-label font-normal truncate flex-1 min-w-0 text-foreground">
          {provider.name || provider.id}
        </span>
        <span className="typography-micro text-muted-foreground/60 flex-shrink-0">
          {modelCount}
        </span>
      </button>
    </div>
  );
};
