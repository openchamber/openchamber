import React from 'react';

import { ButtonSmall } from '@/components/ui/button-small';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { AnimatedTabs } from '@/components/ui/animated-tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ButtonLarge } from '@/components/ui/button-large';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { RiAddLine, RiDeleteBinLine, RiRefreshLine, RiDownloadLine, RiStarLine, RiSearchLine } from '@remixicon/react';

import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { cn } from '@/lib/utils';
import type { SkillsCatalogItem } from '@/lib/api/types';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { updateDesktopSettings } from '@/lib/persistence';
import type { DesktopSettings, SkillCatalogConfig } from '@/lib/desktop';

import { AddCatalogDialog } from './AddCatalogDialog';
import { InstallSkillDialog } from './InstallSkillDialog';

type SkillsMode = 'manual' | 'external';

interface SkillsCatalogPageProps {
  mode: SkillsMode;
  onModeChange: (mode: SkillsMode) => void;
  showModeTabs?: boolean;
}

const loadSettings = async (): Promise<DesktopSettings | null> => {
  try {
    const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
    if (runtimeSettings) {
      const result = await runtimeSettings.load();
      return (result?.settings || {}) as DesktopSettings;
    }

    const response = await fetch('/api/config/settings', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json().catch(() => null)) as DesktopSettings | null;
  } catch {
    return null;
  }
};

export const SkillsCatalogPage: React.FC<SkillsCatalogPageProps> = ({ mode, onModeChange, showModeTabs = true }) => {
  const {
    sources,
    itemsBySource,
    selectedSourceId,
    setSelectedSource,
    loadCatalog,
    loadSource,
    loadMoreClawdHub,
    isLoadingCatalog,
    isLoadingSource,
    isLoadingMore,
    loadedSourceIds,
    clawdhubHasMoreBySource,
    lastCatalogError,
  } = useSkillsCatalogStore();

  const [search, setSearch] = React.useState('');
  const [addCatalogOpen, setAddCatalogOpen] = React.useState(false);
  const [installDialogOpen, setInstallDialogOpen] = React.useState(false);
  const [installItem, setInstallItem] = React.useState<SkillsCatalogItem | null>(null);
  const [isRemovingCatalog, setIsRemovingCatalog] = React.useState(false);
  const [isRemoveCatalogDialogOpen, setIsRemoveCatalogDialogOpen] = React.useState(false);

  React.useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  React.useEffect(() => {
    if (!selectedSourceId) {
      return;
    }
    if (!loadedSourceIds[selectedSourceId]) {
      void loadSource(selectedSourceId);
    }
  }, [selectedSourceId, loadedSourceIds, loadSource]);

  const items = React.useMemo(() => {
    if (!selectedSourceId) return [];
    return itemsBySource[selectedSourceId] || [];
  }, [itemsBySource, selectedSourceId]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const name = item.skillName.toLowerCase();
      const desc = (item.description || '').toLowerCase();
      const fm = (item.frontmatterName || '').toLowerCase();
      return name.includes(q) || desc.includes(q) || fm.includes(q);
    });
  }, [items, search]);

  const selectedSource = React.useMemo(() => sources.find((s) => s.id === selectedSourceId) || null, [sources, selectedSourceId]);

  const isCustomSource = Boolean(selectedSourceId && selectedSourceId.startsWith('custom:'));
  const isClawdHubSource = selectedSource?.source === 'clawdhub:registry' || selectedSource?.sourceType === 'clawdhub';
  const hasMoreClawdHub = Boolean(
    selectedSourceId && (clawdhubHasMoreBySource[selectedSourceId] ?? true)
  );

  const removeSelectedCatalog = async () => {
    if (!selectedSourceId || !isCustomSource) {
      return;
    }

    setIsRemovingCatalog(true);
    try {
      const settings = await loadSettings();
      const catalogs = (Array.isArray(settings?.skillCatalogs) ? settings?.skillCatalogs : []) as SkillCatalogConfig[];
      const updated = catalogs.filter((c) => c.id !== selectedSourceId);
      await updateDesktopSettings({ skillCatalogs: updated });
      await loadCatalog({ refresh: true });
      setIsRemoveCatalogDialogOpen(false);
    } finally {
      setIsRemovingCatalog(false);
    }
  };

  return (
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4">
          {showModeTabs && (
            <div className="mb-4">
              <AnimatedTabs
                tabs={[
                  { value: 'manual', label: 'Manual' },
                  { value: 'external', label: 'External' },
                ]}
                value={mode}
                onValueChange={onModeChange}
                animate={false}
              />
            </div>
          )}
          <h2 className="typography-ui-header font-semibold text-foreground px-1">Skills Catalog</h2>
        </div>

        {/* Source & Search */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">Source Repository</h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0">
            <div className="flex flex-wrap items-center gap-2 py-1.5">
              <Select
                value={selectedSourceId || ''}
                onValueChange={(v) => setSelectedSource(v)}
              >
                <SelectTrigger className="w-fit">
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent align="start">
                  {sources.map((src) => (
                    <SelectItem key={src.id} value={src.id}>
                      {src.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <ButtonSmall
                variant="outline"
                size="xs"
                className="!font-normal h-6 w-6 px-0"
                onClick={() => {
                  if (selectedSourceId) {
                    void loadSource(selectedSourceId, { refresh: true });
                  } else {
                    void loadCatalog({ refresh: true });
                  }
                }}
                disabled={isLoadingCatalog || isLoadingSource}
                title="Refresh"
              >
                <RiRefreshLine className={cn("h-3.5 w-3.5", (isLoadingCatalog || isLoadingSource) && "animate-spin")} />
              </ButtonSmall>

              {isCustomSource && (
                <ButtonSmall
                  variant="ghost"
                  size="xs"
                  className="!font-normal h-6 w-6 px-0 text-[var(--status-error)] hover:text-[var(--status-error)]"
                  onClick={() => setIsRemoveCatalogDialogOpen(true)}
                  disabled={isRemovingCatalog}
                  title="Remove Catalog"
                >
                  <RiDeleteBinLine className="h-3.5 w-3.5" />
                </ButtonSmall>
              )}

              <ButtonSmall
                size="xs"
                className="!font-normal gap-1"
                onClick={() => setAddCatalogOpen(true)}
              >
                <RiAddLine className="h-3.5 w-3.5" /> Add Catalog
              </ButtonSmall>
            </div>

            <div className="py-1.5">
              <div className="relative">
                <RiSearchLine className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search skills..."
                  className="h-7 pl-8 w-full sm:w-64"
                />
              </div>
              <span className="typography-meta text-muted-foreground mt-1 block">
                {isLoadingCatalog ? 'Loading...' : `${filtered.length} skill(s) found`}
              </span>
            </div>
          </section>
        </div>

        {/* Error State */}
        {lastCatalogError && (
          <div className="mb-8 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3">
            <div className="typography-ui-label font-medium text-[var(--status-error)]">Catalog error</div>
            <div className="typography-meta text-[var(--status-error)]/80 mt-1">{lastCatalogError.message}</div>
          </div>
        )}

        {/* Skills List */}
        <div className="mb-8">
          <section className="px-2 pb-2 pt-0">
            {filtered.length === 0 && !isLoadingSource ? (
              <div className="py-8 text-center text-muted-foreground">
                <p className="typography-body">No skills found</p>
                <p className="typography-meta mt-1 opacity-75">Try a different search or refresh the catalog</p>
              </div>
            ) : isLoadingSource ? (
              <div className="py-8 text-center text-muted-foreground">
                <RiRefreshLine className="mx-auto mb-3 h-5 w-5 animate-spin opacity-50" />
                <p className="typography-meta">Loading skills...</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--surface-subtle)]">
                {filtered.map((item) => {
                  const installed = item.installed?.isInstalled;
                  const installedScope = item.installed?.scope;

                  return (
                    <div key={`${item.sourceId}:${item.skillDir}`} className="py-2">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="typography-ui-label font-medium text-foreground truncate">{item.skillName}</span>
                            {installed && (
                              <span className="typography-micro text-[var(--status-success)] bg-[var(--status-success)]/10 px-1.5 py-0.5 rounded flex-shrink-0">
                                installed ({installedScope || 'unknown'})
                              </span>
                            )}
                            {!item.installable && (
                              <span className="typography-micro text-[var(--status-warning)] bg-[var(--status-warning)]/10 px-1.5 py-0.5 rounded flex-shrink-0">
                                not installable
                              </span>
                            )}
                          </div>

                          {item.description ? (
                            <div className="typography-meta text-muted-foreground mt-0.5 line-clamp-2">{item.description}</div>
                          ) : (
                            <div className="typography-meta text-muted-foreground/50 mt-0.5 italic">No description provided</div>
                          )}

                          {item.clawdhub && (
                            <div className="typography-micro text-muted-foreground mt-1.5 flex items-center gap-3">
                              {item.clawdhub.owner && (
                                <span>by <span className="font-medium text-foreground/80">{item.clawdhub.owner}</span></span>
                              )}
                              <span className="flex items-center gap-1">
                                <RiDownloadLine className="h-3 w-3" />
                                {item.clawdhub.downloads?.toLocaleString() ?? 0}
                              </span>
                              {(item.clawdhub.stars ?? 0) > 0 && (
                                <span className="flex items-center gap-1">
                                  <RiStarLine className="h-3 w-3" />
                                  {item.clawdhub.stars}
                                </span>
                              )}
                              <span className="bg-[var(--surface-muted)] px-1.5 py-0.5 rounded">v{item.clawdhub.version}</span>
                            </div>
                          )}

                          {item.warnings?.length ? (
                            <div className="typography-micro text-[var(--status-warning)] mt-1.5 bg-[var(--status-warning)]/10 px-2 py-1 rounded w-fit">
                              {item.warnings.join(' · ')}
                            </div>
                          ) : null}
                        </div>

                        <ButtonSmall
                          variant="outline"
                          size="xs"
                          className="!font-normal shrink-0"
                          disabled={!item.installable}
                          onClick={() => {
                            setInstallItem(item);
                            setInstallDialogOpen(true);
                          }}
                        >
                          Install
                        </ButtonSmall>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {isClawdHubSource && hasMoreClawdHub && !isLoadingSource && filtered.length > 0 && (
            <div className="flex justify-center mt-2 px-2">
              <ButtonSmall
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => void loadMoreClawdHub()}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? 'Loading...' : 'Load More Skills'}
              </ButtonSmall>
            </div>
          )}
        </div>

        {/* Dialogs */}
        <AddCatalogDialog open={addCatalogOpen} onOpenChange={setAddCatalogOpen} />
        <InstallSkillDialog open={installDialogOpen} onOpenChange={setInstallDialogOpen} item={installItem} />

        <Dialog
          open={isRemoveCatalogDialogOpen}
          onOpenChange={(open) => {
            if (!isRemovingCatalog) {
              setIsRemoveCatalogDialogOpen(open);
            }
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Remove Catalog</DialogTitle>
              <DialogDescription>Are you sure you want to remove this catalog?</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <ButtonLarge
                variant="ghost"
                onClick={() => setIsRemoveCatalogDialogOpen(false)}
                disabled={isRemovingCatalog}
              >
                Cancel
              </ButtonLarge>
              <ButtonLarge className="bg-[var(--status-error)] hover:bg-[var(--status-error)]/90 text-white" onClick={() => void removeSelectedCatalog()} disabled={isRemovingCatalog}>
                Remove Catalog
              </ButtonLarge>
            </DialogFooter>
          </DialogContent>
        </Dialog>

      </div>
    </ScrollableOverlay>
  );
};
