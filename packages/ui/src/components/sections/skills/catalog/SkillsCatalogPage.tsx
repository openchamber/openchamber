import React from 'react';

import { Button } from '@/components/ui/button';
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
import { useDeviceInfo } from '@/lib/device';
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
  const { isMobile } = useDeviceInfo();
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
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full bg-background">
      <div className="openchamber-page-body mx-auto w-full max-w-3xl space-y-6 p-3 sm:p-6 sm:pt-8">
        
        {/* Header */}
        <div className="mb-8">
          <div className="mb-3 px-1">
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

            <h1 className="typography-ui-header font-semibold text-foreground">Skills Catalog</h1>
            <p className="typography-meta text-muted-foreground mt-0.5">
              Browse curated repositories and install skills into your OpenCode configuration.
            </p>
          </div>
        </div>

        {/* Filters and Actions */}
        <div className="mb-8 rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
          <div className={cn("px-4 py-3 border-b border-[var(--surface-subtle)]", isMobile ? "flex flex-col gap-3" : "flex flex-col sm:flex-row sm:items-center justify-between gap-4")}>
            <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "sm:w-1/3 shrink-0")}>
              <span className="typography-ui-label text-foreground">Source Repository</span>
              <span className="typography-meta text-muted-foreground">Select a catalog to browse</span>
            </div>
            <div className={cn("flex items-center gap-2 flex-wrap", isMobile ? "w-full" : "flex-1 justify-end")}>
              <Select
                value={selectedSourceId || ''}
                onValueChange={(v) => setSelectedSource(v)}
              >
                <SelectTrigger className="w-fit min-w-[160px] h-8">
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent align="end">
                  {sources.map((src) => (
                    <SelectItem key={src.id} value={src.id}>
                      {src.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <ButtonSmall
                variant="outline"
                onClick={() => {
                  if (selectedSourceId) {
                    void loadSource(selectedSourceId, { refresh: true });
                  } else {
                    void loadCatalog({ refresh: true });
                  }
                }}
                disabled={isLoadingCatalog || isLoadingSource}
                title="Refresh"
                className="px-2"
              >
                <RiRefreshLine className={cn("h-4 w-4", (isLoadingCatalog || isLoadingSource) && "animate-spin")} />
              </ButtonSmall>
              
              {isCustomSource && (
                <ButtonSmall
                  variant="outline"
                  onClick={() => setIsRemoveCatalogDialogOpen(true)}
                  disabled={isRemovingCatalog}
                  className="text-[var(--status-error)] hover:text-[var(--status-error)] border-[var(--status-error)]/30 hover:bg-[var(--status-error)]/10"
                  title="Remove Catalog"
                >
                  <RiDeleteBinLine className="h-4 w-4" />
                </ButtonSmall>
              )}
              
              <ButtonSmall
                variant="default"
                onClick={() => setAddCatalogOpen(true)}
              >
                <RiAddLine className="h-4 w-4 mr-1" /> Add Catalog
              </ButtonSmall>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
              <span className="typography-ui-label text-foreground">Search Skills</span>
              <span className="typography-meta text-muted-foreground">
                {isLoadingCatalog ? 'Loading…' : `${filtered.length} skill(s) found`}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-1 justify-end relative max-w-sm">
              <RiSearchLine className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="h-8 pl-8 focus-visible:ring-[var(--primary-base)]"
              />
            </div>
          </div>
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
          <div className="rounded-lg bg-[var(--surface-elevated)]/70 py-1 border border-[var(--surface-subtle)]">
            {filtered.length === 0 && !isLoadingSource ? (
              <div className="py-12 text-center text-muted-foreground">
                <p className="typography-body">No skills found</p>
                <p className="typography-meta mt-1 opacity-75">Try a different search or refresh the catalog</p>
              </div>
            ) : isLoadingSource ? (
              <div className="py-12 text-center text-muted-foreground">
                <RiRefreshLine className="mx-auto mb-3 h-6 w-6 animate-spin opacity-50" />
                <p className="typography-meta">Loading skills…</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--surface-subtle)]">
                {filtered.map((item) => {
                  const installed = item.installed?.isInstalled;
                  const installedScope = item.installed?.scope;

                  return (
                    <div
                      key={`${item.sourceId}:${item.skillDir}`}
                      className="px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="typography-ui-label font-semibold text-foreground truncate">{item.skillName}</span>
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
                            <div className="typography-meta text-muted-foreground mt-1 line-clamp-2">{item.description}</div>
                          ) : (
                            <div className="typography-meta text-muted-foreground/50 mt-1 italic">No description provided</div>
                          )}
                          
                          {item.clawdhub && (
                            <div className="typography-micro text-muted-foreground mt-2 flex items-center gap-3">
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
                            <div className="typography-micro text-[var(--status-warning)] mt-2 bg-[var(--status-warning)]/10 px-2 py-1 rounded w-fit">
                              {item.warnings.join(' · ')}
                            </div>
                          ) : null}
                        </div>

                        <ButtonSmall
                          variant="outline"
                          disabled={!item.installable}
                          onClick={() => {
                            setInstallItem(item);
                            setInstallDialogOpen(true);
                          }}
                          className="shrink-0"
                        >
                          Install
                        </ButtonSmall>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          
          {isClawdHubSource && hasMoreClawdHub && !isLoadingSource && filtered.length > 0 && (
            <div className="flex justify-center mt-4">
              <ButtonSmall
                variant="outline"
                onClick={() => void loadMoreClawdHub()}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? 'Loading…' : 'Load More Skills'}
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
              <Button
                variant="ghost"
                onClick={() => setIsRemoveCatalogDialogOpen(false)}
                disabled={isRemovingCatalog}
              >
                Cancel
              </Button>
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
