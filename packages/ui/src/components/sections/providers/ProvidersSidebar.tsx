import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { cn } from '@/lib/utils';
import { orderProvidersByUserOrder } from '@/lib/providerOrdering';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { Icon } from "@/components/icon/Icon";
import { opencodeClient } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';

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

interface SidebarProvider {
  id: string;
  name?: string;
  models?: unknown[];
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
  const { t } = useI18n();
  // Settings browses whichever project its own selector points at; the app
  // stays where it is.
  const settingsDirectory = useSettingsDirectory();
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, settingsDirectory));
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const providerOrder = useUIStore((state) => state.providerOrder);
  const setProviderOrder = useUIStore((state) => state.setProviderOrder);
  const disabledProviders = useUIStore((state) => state.disabledProviders);
  const toggleProviderDisabled = useUIStore((state) => state.toggleProviderDisabled);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const [sourcesByProvider, setSourcesByProvider] = React.useState<Record<string, ProviderSources>>({});
  const directory = React.useMemo(() => {
    if (settingsDirectory) return settingsDirectory;
    // tie refresh to active project changes (directory is stored in the client)
    void activeProjectId;
    return getCurrentDirectory();
  }, [activeProjectId, settingsDirectory]);

  // The app only loads providers for the project it is on; Settings has to ask
  // for the one it is looking at.
  const loadProviders = useConfigStore((state) => state.loadProviders);
  React.useEffect(() => {
    if (!settingsDirectory) return;
    void loadProviders({ directory: settingsDirectory, source: 'settings:providers' });
  }, [loadProviders, settingsDirectory]);

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
          // OpenChamber-only metadata endpoint: the SDK exposes provider data but
          // not local auth/source-file provenance used by this settings sidebar.
          const response = await runtimeFetch(`/api/provider/${encodeURIComponent(provider.id)}/source${query}`, {
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

  // Desktop drags after a small move (a click still selects); touch needs a
  // long-press so taps select and swipes scroll the sidebar.
  const reorderSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const bgClass = 'bg-background';

  const disabledProviderSet = React.useMemo(
    () => new Set(disabledProviders),
    [disabledProviders],
  );

  // One user-defined order shared with the chat model picker; disabled
  // providers keep their place in it so re-enabling restores the position.
  const orderedProviders = React.useMemo(
    () => orderProvidersByUserOrder(providers, providerOrder),
    [providers, providerOrder],
  );

  const enabledProviders = React.useMemo(
    () => orderedProviders.filter((provider) => !disabledProviderSet.has(provider.id)),
    [orderedProviders, disabledProviderSet],
  );

  const disabledProviderList = React.useMemo(
    () => orderedProviders.filter((provider) => disabledProviderSet.has(provider.id)),
    [orderedProviders, disabledProviderSet],
  );

  const projectProviders = React.useMemo(() => {
    return enabledProviders.filter((p) => Boolean(sourcesByProvider[p.id]?.project?.exists));
  }, [enabledProviders, sourcesByProvider]);

  const userProviders = React.useMemo(() => {
    return enabledProviders.filter((p) => !sourcesByProvider[p.id]?.project?.exists);
  }, [enabledProviders, sourcesByProvider]);

  const selectProvider = React.useCallback((providerId: string) => {
    setSelectedProvider(providerId);
    onItemSelect?.();
  }, [onItemSelect, setSelectedProvider]);

  // Move within the full ordered list (including disabled providers) so the
  // chat picker's order stays consistent with what the sidebar shows.
  const handleReorderDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = orderedProviders.map((provider) => provider.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    setProviderOrder(arrayMove(ids, from, to));
  }, [orderedProviders, setProviderOrder]);

  const renderSortableSection = (sectionProviders: SidebarProvider[]) => {
    if (sectionProviders.length === 0) return null;
    const sortable = sectionProviders.length > 1;
    const items = sectionProviders.map((provider) => (
      sortable ? (
        <SortableProviderListItem
          key={provider.id}
          provider={provider}
          selectedProviderId={selectedProviderId}
          onSelect={selectProvider}
          reorderTitle={t('settings.providers.sidebar.actions.reorderProviderTitle')}
          reorderAriaLabel={t('settings.providers.sidebar.actions.reorderProviderAria')}
        />
      ) : (
        <ProviderListItem
          key={provider.id}
          provider={provider}
          selectedProviderId={selectedProviderId}
          onSelect={() => selectProvider(provider.id)}
        />
      )
    ));
    if (!sortable) return items;
    return (
      <DndContext sensors={reorderSensors} collisionDetection={closestCenter} onDragEnd={handleReorderDragEnd}>
        <SortableContext items={sectionProviders.map((provider) => provider.id)} strategy={verticalListSortingStrategy}>
          {items}
        </SortableContext>
      </DndContext>
    );
  };

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className={`${SETTINGS_PANEL_TITLE_CLASS} mb-3`}>{t('settings.providers.sidebar.title')}</h2>
        <SettingsProjectSelector className="mb-3" />
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">{t('settings.providers.sidebar.total', { count: providers.length })}</span>
          <Button size="sm"
            variant="ghost"
            className="h-7 w-7 px-0 -my-1 text-muted-foreground"
            onClick={() => {
              setSelectedProvider(ADD_PROVIDER_ID);
              onItemSelect?.();
            }}
            aria-label={t('settings.providers.sidebar.actions.connectProviderAria')}
            title={t('settings.providers.sidebar.actions.connectProviderTitle')}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {providers.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <Icon name="stack" className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">{t('settings.providers.sidebar.empty.title')}</p>
            <p className="typography-meta mt-1 opacity-75">{t('settings.providers.sidebar.empty.description')}</p>
          </div>
        ) : (
          <>
            {userProviders.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('settings.providers.sidebar.section.userProviders')}
                </div>
                {renderSortableSection(userProviders)}
              </>
            )}

            {projectProviders.length > 0 && (
              <>
                <div className={cn('px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground', userProviders.length > 0 ? 'pt-3' : 'pt-2')}>
                  {t('settings.providers.sidebar.section.projectProviders')}
                </div>
                {renderSortableSection(projectProviders)}
              </>
            )}

            {disabledProviderList.length > 0 && (
              <>
                <div className={cn('px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground', enabledProviders.length > 0 ? 'pt-3' : 'pt-2')}>
                  {t('settings.providers.sidebar.section.disabled')}
                </div>
                {disabledProviderList.map((provider) => (
                  <ProviderListItem
                    key={provider.id}
                    provider={provider}
                    selectedProviderId={selectedProviderId}
                    onSelect={() => selectProvider(provider.id)}
                    disabled
                    trailing={(
                      <Button
                        size="xs"
                        variant="ghost"
                        className="h-6 shrink-0 !font-normal text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleProviderDisabled(provider.id);
                        }}
                      >
                        {t('settings.providers.sidebar.actions.enableProvider')}
                      </Button>
                    )}
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

const SortableProviderListItem: React.FC<{
  provider: SidebarProvider;
  selectedProviderId: string;
  onSelect: (providerId: string) => void;
  reorderTitle: string;
  reorderAriaLabel: string;
}> = ({ provider, selectedProviderId, onSelect, reorderTitle, reorderAriaLabel }) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: provider.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('select-none', isDragging && 'opacity-60')}
    >
      <ProviderListItem
        provider={provider}
        selectedProviderId={selectedProviderId}
        onSelect={() => onSelect(provider.id)}
        leading={(
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
            className="flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
            aria-label={reorderAriaLabel}
            title={reorderTitle}
          >
            <Icon name="draggable" className="size-3.5" />
          </button>
        )}
      />
    </div>
  );
};

const ProviderListItem: React.FC<{
  provider: SidebarProvider;
  selectedProviderId: string;
  onSelect: () => void;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  disabled?: boolean;
}> = ({ provider, selectedProviderId, onSelect, leading, trailing, disabled }) => {
  const modelCount = Array.isArray(provider.models) ? provider.models.length : 0;
  const isSelected = provider.id === selectedProviderId;

  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200',
        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
        disabled && 'opacity-60',
      )}
    >
      {leading}
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
        {disabled ? (
          <Icon name="eye-off" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />
        ) : (
          <span className="typography-micro text-muted-foreground/60 flex-shrink-0">
            {modelCount}
          </span>
        )}
      </button>
      {trailing}
    </div>
  );
};
