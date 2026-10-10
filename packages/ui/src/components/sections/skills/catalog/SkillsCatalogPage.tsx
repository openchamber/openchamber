import { rankByQuery } from '@/lib/search/fuzzySearch';
import React from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';

import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { toast } from '@/components/ui';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import type { SkillsCatalogItem, SkillsCatalogSource } from '@/lib/api/types';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';

import { AddCatalogDialog } from './AddCatalogDialog';
import { InstallSkillDialog } from './InstallSkillDialog';

type SkillsMode = 'manual' | 'external';

interface SkillsCatalogPageProps {
  mode: SkillsMode;
  onModeChange: (mode: SkillsMode) => void;
  showModeTabs?: boolean;
}

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const getRepoUrl = (source: string): string | null => {
  const trimmed = source.trim();
  if (!GITHUB_REPO_PATTERN.test(trimmed)) {
    return null;
  }
  return `https://github.com/${trimmed}`;
};

const getSkillUrl = (item: SkillsCatalogItem): string | null => {
  const repoUrl = getRepoUrl(item.repoSource);
  if (!repoUrl) {
    return null;
  }
  const skillPath = [item.repoSubpath, item.skillDir].filter(Boolean).join('/');
  return skillPath ? `${repoUrl}/tree/HEAD/${skillPath}` : repoUrl;
};

let cachedStarsFormatter: { locale: string; formatter: Intl.NumberFormat } | null = null;

const formatStars = (stars: number): string => {
  const locale = getCurrentIntlLocale();
  if (!cachedStarsFormatter || cachedStarsFormatter.locale !== locale) {
    cachedStarsFormatter = { locale, formatter: new Intl.NumberFormat(locale, { notation: 'compact' }) };
  }
  return cachedStarsFormatter.formatter.format(stars);
};

type RelativeTimeKey =
  | 'common.relative.justNow'
  | 'common.relative.minutesAgoShort'
  | 'common.relative.hoursAgoShort'
  | 'common.relative.daysAgoShort'
  | 'common.relative.weeksAgoShort'
  | 'common.relative.yearsAgoShort';

const formatRelativeShort = (isoDate: string): { key: RelativeTimeKey; count: number } | null => {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) {
    return { key: 'common.relative.justNow', count: 0 };
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return { key: 'common.relative.minutesAgoShort', count: minutes };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { key: 'common.relative.hoursAgoShort', count: hours };
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return { key: 'common.relative.daysAgoShort', count: days };
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 52) {
    return { key: 'common.relative.weeksAgoShort', count: weeks };
  }
  return { key: 'common.relative.yearsAgoShort', count: Math.floor(days / 365) };
};

const SourceCard: React.FC<{
  source: SkillsCatalogSource;
  isActive: boolean;
  isLoading: boolean;
  skillsCount: number | null;
  onSelect: () => void;
  t: ReturnType<typeof useI18n>['t'];
}> = ({ source, isActive, isLoading, skillsCount, onSelect, t }) => {
  const stars = source.stars ?? null;
  const updated = source.repoUpdatedAt ? formatRelativeShort(source.repoUpdatedAt) : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isActive}
      className={cn(
        'oc-surface-elevated w-full min-h-24 text-left rounded-lg border bg-surface-elevated p-3.5 flex gap-3 items-start transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive
          ? 'border-border bg-interactive-selection text-interactive-selection-foreground'
          : 'border-border hover:border-interactive-border-hover'
      )}
    >
      <span className="min-w-0 flex-1 block">
        <span className="flex items-center gap-2">
          <span className="typography-ui-label font-medium text-foreground truncate">{source.label}</span>
          {isLoading ? (
            <Icon name="refresh" className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />
          ) : (
            skillsCount !== null && (
              <span className="typography-micro text-muted-foreground shrink-0">
                {t('settings.skills.catalog.page.source.skillsCount', { count: skillsCount })}
              </span>
            )
          )}
        </span>
        <span className="typography-micro font-mono text-muted-foreground block mt-0.5 truncate">{source.source}</span>
        <span className="flex items-center gap-3 mt-1">
          {stars !== null && (
            <span
              className="typography-micro text-muted-foreground flex items-center gap-1"
              title={t('settings.skills.catalog.page.source.stars', { count: stars })}
            >
              <Icon name="star" className="h-3 w-3" />
              {formatStars(stars)}
            </span>
          )}
          {updated && (
            <span className="typography-micro text-muted-foreground">
              {updated.key === 'common.relative.justNow'
                ? t(updated.key)
                : t('settings.skills.catalog.page.source.updated', { time: t(updated.key, { count: updated.count }) })}
            </span>
          )}
        </span>
      </span>
    </button>
  );
};

export const SkillsCatalogPage: React.FC<SkillsCatalogPageProps> = ({ mode, onModeChange, showModeTabs = true }) => {
  const { t } = useI18n();
  const {
    sources,
    itemsBySource,
    selectedSourceId,
    setSelectedSource,
    loadCatalog,
    loadSource,
    isLoadingCatalog,
    isLoadingSource,
    loadedSourceIds,
    lastCatalogError,
  } = useSkillsCatalogStore(useShallow((s) => ({
    sources: s.sources,
    itemsBySource: s.itemsBySource,
    selectedSourceId: s.selectedSourceId,
    setSelectedSource: s.setSelectedSource,
    loadCatalog: s.loadCatalog,
    loadSource: s.loadSource,
    isLoadingCatalog: s.isLoadingCatalog,
    isLoadingSource: s.isLoadingSource,
    loadedSourceIds: s.loadedSourceIds,
    lastCatalogError: s.lastCatalogError,
  })));

  const [search, setSearch] = React.useState('');
  const [catalogDialogOpen, setCatalogDialogOpen] = React.useState(false);
  const [editingCatalogId, setEditingCatalogId] = React.useState<string | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = React.useState(false);
  const [installItems, setInstallItems] = React.useState<SkillsCatalogItem[]>([]);
  const [selectedSkillKeys, setSelectedSkillKeys] = React.useState<Set<string>>(new Set());
  const [uninstallItems, setUninstallItems] = React.useState<SkillsCatalogItem[]>([]);
  const [isUninstalling, setIsUninstalling] = React.useState(false);
  const [isRemovingCatalog, setIsRemovingCatalog] = React.useState(false);
  const [isRemoveCatalogDialogOpen, setIsRemoveCatalogDialogOpen] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const deleteSkill = useSkillsStore((state) => state.deleteSkill);
  const settingsDirectory = useSettingsDirectory();

  React.useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Load every source in the background so global search covers all of them.
  React.useEffect(() => {
    const unloaded = sources.filter((src) => !loadedSourceIds[src.id]);
    if (unloaded.length === 0) {
      return;
    }
    let cancelled = false;
    const loadRest = async () => {
      for (const src of unloaded) {
        if (cancelled) {
          return;
        }
        await loadSource(src.id);
      }
    };
    void loadRest();
    return () => {
      cancelled = true;
    };
  }, [sources, loadedSourceIds, loadSource]);

  React.useEffect(() => {
    if (!selectedSourceId || loadedSourceIds[selectedSourceId]) {
      return;
    }
    void loadSource(selectedSourceId);
  }, [selectedSourceId, loadedSourceIds, loadSource]);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const isSearching = search.trim().length > 0;

  const filtered = React.useMemo(() => {
    if (isSearching) {
      return rankByQuery(
        sources.flatMap((src) => itemsBySource[src.id] || []),
        search,
        (item) => [item.skillName, item.frontmatterName, item.description],
      );
    }
    if (!selectedSourceId) {
      return [];
    }
    return itemsBySource[selectedSourceId] || [];
  }, [sources, itemsBySource, selectedSourceId, search, isSearching]);

  const selectedSource = React.useMemo(() => sources.find((s) => s.id === selectedSourceId) || null, [sources, selectedSourceId]);

  const isCustomSource = Boolean(selectedSourceId && selectedSourceId.startsWith('custom:'));

  const itemKey = React.useCallback((item: SkillsCatalogItem) => `${item.sourceId}:${item.skillDir}`, []);
  const selectedItems = React.useMemo(
    () => filtered.filter((item) => selectedSkillKeys.has(itemKey(item))),
    [filtered, itemKey, selectedSkillKeys],
  );
  const selectedSourceForBatch = selectedItems[0]?.sourceId ?? (isSearching
    ? filtered.find((item) => item.installable || item.installed?.isInstalled)?.sourceId
    : selectedSourceId);
  const selectedToInstall = selectedItems.filter((item) => !item.installed?.isInstalled);
  const selectedToUninstall = selectedItems.filter((item) => item.installed?.isInstalled);
  const selectableItems = filtered.filter((item) => (
    (item.installable || item.installed?.isInstalled)
    && item.sourceId === selectedSourceForBatch
  ));
  const batchSourceLabel = sources.find((source) => source.id === selectedSourceForBatch)?.label;
  const allSelected = selectableItems.length > 0 && selectableItems.every((item) => selectedSkillKeys.has(itemKey(item)));

  React.useEffect(() => {
    const availableKeys = new Set(filtered.filter((item) => item.installable || item.installed?.isInstalled).map(itemKey));
    setSelectedSkillKeys((current) => new Set([...current].filter((key) => availableKeys.has(key))));
  }, [filtered, itemKey]);

  const toggleSelectedSkill = (item: SkillsCatalogItem, checked: boolean) => {
    const key = itemKey(item);
    setSelectedSkillKeys((current) => {
      const selected = filtered.find((candidate) => current.has(itemKey(candidate)));
      if (checked && selected && selected.sourceId !== item.sourceId) return current;
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleAllSkills = (checked: boolean) => {
    setSelectedSkillKeys((current) => {
      const next = new Set(current);
      for (const item of selectableItems) {
        if (checked) next.add(itemKey(item));
        else next.delete(itemKey(item));
      }
      return next;
    });
  };

  const openInstallDialog = (items: SkillsCatalogItem[]) => {
    if (items.length === 0) return;
    setInstallItems(items);
    setInstallDialogOpen(true);
  };

  const uninstallSelectedSkill = async () => {
    if (uninstallItems.length === 0) return;
    setIsUninstalling(true);
    const remaining: SkillsCatalogItem[] = [];
    const refreshedSources = new Set<string>();
    for (const item of uninstallItems) {
      const directory = item.installed?.scope === 'project' ? settingsDirectory : null;
      const success = (item.installed?.scope !== 'project' || Boolean(directory))
        && await deleteSkill(item.skillName, directory);
      if (success) {
        refreshedSources.add(item.sourceId);
        setSelectedSkillKeys((current) => {
          const next = new Set(current);
          next.delete(itemKey(item));
          return next;
        });
      } else {
        remaining.push(item);
      }
    }
    setUninstallItems(remaining);
    await Promise.all([...refreshedSources].map((sourceId) => loadSource(sourceId, { refresh: true })));
    if (remaining.length > 0) toast.error(t('settings.skills.sidebar.toast.deleteSkillFailed'));
    else if (uninstallItems.length === 1) toast.success(t('settings.skills.sidebar.toast.skillDeleted', { name: uninstallItems[0].skillName }));
    else toast.success(t('settings.skills.catalog.page.toast.deleted', { count: uninstallItems.length }));
    setIsUninstalling(false);
  };

  const removeSelectedCatalog = async () => {
    if (!selectedSourceId || !isCustomSource) {
      return;
    }

    setIsRemovingCatalog(true);
    try {
      const settings = await loadDesktopSettings();
      // A failed load is not an empty list: writing [] here would drop every
      // other catalog along with the selected one.
      if (!settings) {
        toast.error(t('settings.skills.catalog.add.toast.saveFailed'));
        return;
      }
      const catalogs = settings.skillCatalogs ?? [];
      const updated = catalogs.filter((c) => c.id !== selectedSourceId);
      const saved = await updateDesktopSettings({ skillCatalogs: updated });
      if (!saved.ok) {
        toast.error(t('settings.skills.catalog.add.toast.saveFailed'));
        return;
      }
      if (!await loadCatalog({ refresh: true })) {
        toast.error(t('settings.skills.catalog.add.toast.saveFailed'));
        return;
      }
      setIsRemoveCatalogDialogOpen(false);
    } catch {
      toast.error(t('settings.skills.catalog.add.toast.saveFailed'));
    } finally {
      setIsRemovingCatalog(false);
    }
  };

  const listTitle = isSearching
    ? t('settings.skills.catalog.page.list.searchTitle')
    : (selectedSource?.label ?? '');

  // The selected source has no items yet and a load is in flight — show the
  // loading state instead of a stale list from the previously selected source.
  const isSelectedSourceLoading = !isSearching
    && selectedSourceId !== null
    && !loadedSourceIds[selectedSourceId]
    && (isLoadingSource || isLoadingCatalog);

  return (
    <>
      <SettingsPageLayout
        title={t('settings.skills.catalog.page.title')}
        showSaveStatus={false}
      >
      {showModeTabs && (
            <div className="mb-4">
              <div className="h-7">
                <SortableTabsStrip
                  items={[
                    { id: 'manual', label: t('settings.skills.catalog.page.mode.manual') },
                    { id: 'external', label: t('settings.skills.catalog.page.mode.external') },
                  ]}
                  activeId={mode}
                  onSelect={(next) => {
                    if (next === 'manual' || next === 'external') onModeChange(next);
                  }}
                  layoutMode="fit"
                  variant="animated"
                  animateActivePill={false}
                  className="h-full"
                />
              </div>
            </div>
          )}

        <p className="typography-meta text-muted-foreground mb-4">
          {t('settings.skills.catalog.page.subtitle')}
        </p>

        <div data-settings-item="skills.catalog.search" className="mb-5">
          <div className="relative max-w-md">
            <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('settings.skills.catalog.page.searchAllPlaceholder')}
              className={cn('h-8 pl-8 w-full', search && 'pr-8')}
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  searchInputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center h-4 w-4 rounded text-muted-foreground hover:text-foreground transition-colors"
                title={t('settings.skills.catalog.page.search.clear')}
              >
                <Icon name="close" className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        <SettingsSection
          title={t('settings.skills.catalog.page.section.sources')}
          divider={false}
          settingsItem="skills.catalog.source"
          contentClassName="space-y-0"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1.5">
            {sources.map((src) => (
              <SourceCard
                key={src.id}
                source={src}
                isActive={src.id === selectedSourceId}
                isLoading={isLoadingSource && !loadedSourceIds[src.id]}
                skillsCount={loadedSourceIds[src.id] ? (itemsBySource[src.id] || []).length : null}
                onSelect={() => setSelectedSource(src.id)}
                t={t}
              />
            ))}

            <button
              type="button"
              data-settings-item="skills.catalog.add-catalog"
              onClick={() => {
                setEditingCatalogId(null);
                setCatalogDialogOpen(true);
              }}
              className="min-h-24 text-left rounded-lg border border-dashed border-[var(--interactive-border)] hover:border-[var(--interactive-border-hover)] hover:bg-[var(--surface-muted)] p-3.5 flex gap-3 items-start transition-colors"
            >
              <span className="flex items-center justify-center rounded-md bg-transparent text-muted-foreground w-8 h-8 shrink-0">
                <Icon name="add" className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="typography-ui-label text-muted-foreground block">
                  {t('settings.skills.catalog.page.source.addOwnTitle')}
                </span>
                <span className="typography-micro text-muted-foreground/70 block mt-0.5">
                  {t('settings.skills.catalog.page.source.addOwnDescription')}
                </span>
              </span>
            </button>
          </div>
        </SettingsSection>

        {lastCatalogError && (
          <SettingsSection>
            <div className="rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3">
              <div className="typography-ui-label font-medium text-[var(--status-error)]">{t('settings.skills.catalog.page.error.catalogTitle')}</div>
              <div className="typography-meta text-[var(--status-error)]/80 mt-1">{lastCatalogError.message}</div>
              {lastCatalogError.kind === 'authRequired' && isCustomSource && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setEditingCatalogId(selectedSourceId);
                    setCatalogDialogOpen(true);
                  }}
                >
                  {t('settings.skills.catalog.page.actions.editCatalog')}
                </Button>
              )}
            </div>
          </SettingsSection>
        )}

        <SettingsSection>
          <div className="flex items-center justify-between gap-2 pb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="typography-micro font-medium uppercase tracking-wide text-muted-foreground truncate">
                {listTitle}
              </span>
              <span className="typography-micro text-muted-foreground/70 shrink-0">
                {t('settings.skills.catalog.page.foundCount', { count: filtered.length })}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="xs"
                className="!font-normal h-6 w-6 px-0"
                onClick={() => {
                  if (selectedSourceId && !isSearching) {
                    void loadSource(selectedSourceId, { refresh: true });
                  } else {
                    void loadCatalog({ refresh: true });
                  }
                }}
                disabled={isLoadingCatalog || isLoadingSource}
                title={t('settings.skills.catalog.page.actions.refreshTitle')}
              >
                <Icon name="refresh" className={cn('h-3.5 w-3.5', (isLoadingCatalog || isLoadingSource) && 'animate-spin')} />
              </Button>
              {isCustomSource && !isSearching && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="!font-normal h-6 w-6 px-0"
                  onClick={() => {
                    setEditingCatalogId(selectedSourceId);
                    setCatalogDialogOpen(true);
                  }}
                  title={t('settings.skills.catalog.page.actions.editCatalog')}
                >
                  <Icon name="edit" className="h-3.5 w-3.5" />
                </Button>
              )}
              {isCustomSource && !isSearching && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="!font-normal h-6 w-6 px-0 text-[var(--status-error)] hover:text-[var(--status-error)]"
                  onClick={() => setIsRemoveCatalogDialogOpen(true)}
                  disabled={isRemovingCatalog}
                  title={t('settings.skills.catalog.page.actions.removeCatalogTitle')}
                >
                  <Icon name="delete-bin" className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>

          {selectableItems.length > 0 && (
            <div className="flex items-center justify-between gap-3 pb-2 min-h-8">
              <div className="flex items-center gap-2 typography-meta text-muted-foreground">
                <Checkbox
                  checked={allSelected}
                  indeterminate={selectedItems.length > 0 && !allSelected}
                  onChange={(checked) => toggleAllSkills(checked)}
                  ariaLabel={t(allSelected ? 'settings.skills.catalog.page.actions.deselectAll' : 'settings.skills.catalog.installFromRepo.actions.selectAll')}
                />
                <span>
                  {t(allSelected ? 'settings.skills.catalog.page.actions.deselectAll' : 'settings.skills.catalog.installFromRepo.actions.selectAll')}
                  {isSearching && batchSourceLabel ? ` · ${batchSourceLabel}` : ''}
                </span>
              </div>
              {selectedItems.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="typography-meta text-muted-foreground">
                    {t('settings.skills.catalog.installFromRepo.selectedCount', { selected: selectedItems.length, total: selectableItems.length })}
                  </span>
                  {selectedToInstall.length > 0 && (
                    <Button size="xs" onClick={() => openInstallDialog(selectedToInstall)}>
                      {t('settings.skills.catalog.installFromRepo.actions.installSelected')}
                    </Button>
                  )}
                  {selectedToUninstall.length > 0 && (
                    <Button size="xs" variant="destructive" onClick={() => setUninstallItems(selectedToUninstall)}>
                      {t('settings.skills.catalog.page.actions.delete')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {isSelectedSourceLoading || (isLoadingSource && filtered.length === 0) || (isLoadingCatalog && sources.length === 0) ? (
              <div className="py-8 text-center text-muted-foreground">
                <Icon name="refresh" className="mx-auto mb-3 h-5 w-5 animate-spin opacity-50" />
                <p className="typography-meta">{t('settings.skills.catalog.page.loading.skills')}</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                <p className="typography-body">{t('settings.skills.catalog.page.empty.noSkillsTitle')}</p>
                <p className="typography-meta mt-1 opacity-75">{t('settings.skills.catalog.page.empty.noSkillsDescription')}</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--surface-subtle)]">
                {filtered.map((item) => {
                  const installed = item.installed?.isInstalled;
                  const installedScope = item.installed?.scope;
                  const skillUrl = getSkillUrl(item);

                  return (
                    <div key={`${item.sourceId}:${item.skillDir}`} className="py-2">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Checkbox
                              checked={selectedSkillKeys.has(itemKey(item))}
                              onChange={(checked) => toggleSelectedSkill(item, checked)}
                              disabled={(!installed && !item.installable) || Boolean(selectedItems.length > 0 && selectedSourceForBatch !== item.sourceId)}
                              ariaLabel={`${installed ? t('settings.skills.catalog.page.actions.delete') : t('settings.skills.catalog.shared.actions.install')} ${item.skillName}`}
                            />
                            <span className="typography-ui-label font-medium text-foreground truncate">{item.skillName}</span>
                            {installed && (
                              <span className="typography-micro text-[var(--status-success)] bg-[var(--status-success)]/10 px-1.5 py-0.5 rounded flex-shrink-0">
                                {t('settings.skills.catalog.page.badge.installed', { scope: installedScope || t('settings.skills.catalog.page.badge.unknown') })}
                              </span>
                            )}
                            {!item.installable && (
                              <span className="typography-micro text-[var(--status-warning)] bg-[var(--status-warning)]/10 px-1.5 py-0.5 rounded flex-shrink-0">
                                {t('settings.skills.catalog.page.badge.notInstallable')}
                              </span>
                            )}
                          </div>

                          {item.description ? (
                            <div className="typography-meta text-muted-foreground mt-0.5 line-clamp-2">{item.description}</div>
                          ) : (
                            <div className="typography-meta text-muted-foreground/50 mt-0.5 italic">{t('settings.skills.catalog.shared.noDescription')}</div>
                          )}

                          <div className="typography-micro text-muted-foreground/80 mt-1 flex items-center gap-2 min-w-0">
                            {skillUrl ? (
                              <a
                                href={skillUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono hover:underline truncate inline-flex items-center gap-1"
                                title={t('settings.skills.catalog.page.skill.viewOnGithub')}
                              >
                                <Icon name="github" className="h-3 w-3 shrink-0" />
                                {item.repoSource}
                              </a>
                            ) : (
                              <span className="font-mono truncate">{item.repoSource}</span>
                            )}
                            {item.skillDir && (
                              <>
                                <span className="opacity-40">·</span>
                                <span className="truncate">{item.skillDir}</span>
                              </>
                            )}
                          </div>

                          {item.warnings?.length ? (
                            <div className="typography-micro text-[var(--status-warning)] mt-1.5 bg-[var(--status-warning)]/10 px-2 py-1 rounded w-fit">
                              {item.warnings.join(' · ')}
                            </div>
                          ) : null}
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {skillUrl && (
                            <Button
                              variant="ghost"
                              size="xs"
                              className="!font-normal h-6 w-6 px-0"
                              onClick={() => window.open(skillUrl, '_blank', 'noreferrer')}
                              title={t('settings.skills.catalog.page.skill.viewOnGithub')}
                            >
                              <Icon name="external-link" className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {installed ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              className="!font-normal h-7 w-7 px-0 text-[var(--status-success)] hover:text-[var(--status-error)]"
                              onClick={() => setUninstallItems([item])}
                              title={t('settings.skills.sidebar.deleteDialog.title')}
                            >
                              <Icon name="check" className="h-4 w-4" />
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="xs"
                              className="!font-normal"
                              disabled={!item.installable}
                              onClick={() => {
                                openInstallDialog([item]);
                              }}
                            >
                              {t('settings.skills.catalog.shared.actions.install')}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </SettingsSection>
      </SettingsPageLayout>

        {/* Dialogs */}
        <AddCatalogDialog open={catalogDialogOpen} onOpenChange={setCatalogDialogOpen} catalogId={editingCatalogId} />
        <InstallSkillDialog open={installDialogOpen} onOpenChange={setInstallDialogOpen} items={installItems} />

        <Dialog open={uninstallItems.length > 0} onOpenChange={(open) => !open && !isUninstalling && setUninstallItems([])}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('settings.skills.sidebar.deleteDialog.title')}</DialogTitle>
              <DialogDescription>
                {uninstallItems.length === 1
                  ? t('settings.skills.sidebar.deleteDialog.description', { name: uninstallItems[0].skillName })
                  : uninstallItems.map((item) => item.skillName).join(', ')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={() => setUninstallItems([])} disabled={isUninstalling}>
                {t('settings.common.actions.cancel')}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void uninstallSelectedSkill()} disabled={isUninstalling}>
                {t('settings.common.actions.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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
              <DialogTitle>{t('settings.skills.catalog.page.removeDialog.title')}</DialogTitle>
              <DialogDescription>{t('settings.skills.catalog.page.removeDialog.description')}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setIsRemoveCatalogDialogOpen(false)}
                disabled={isRemovingCatalog}
              >
                {t('settings.common.actions.cancel')}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void removeSelectedCatalog()} disabled={isRemovingCatalog}>
                {t('settings.skills.catalog.page.actions.removeCatalog')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

    </>
  );
};
