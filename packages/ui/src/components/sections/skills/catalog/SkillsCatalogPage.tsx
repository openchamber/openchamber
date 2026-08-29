import { rankByQuery } from '@/lib/search/fuzzySearch';
import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

import { Button } from '@/components/ui/button';
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
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import type { SkillsCatalogItem, SkillsCatalogSource } from '@/lib/api/types';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { updateDesktopSettings } from '@/lib/persistence';
import type { DesktopSettings, SkillCatalogConfig } from '@/lib/desktop';
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

const loadSettings = async (): Promise<DesktopSettings | null> => {
  try {
    const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
    if (runtimeSettings) {
      const result = await runtimeSettings.load();
      return (result?.settings || {}) as DesktopSettings;
    }

    const response = await runtimeFetch('/api/config/settings', {
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
        'w-full min-h-24 text-left rounded-lg border bg-[var(--surface-elevated)] p-3.5 flex gap-3 items-start transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive
          ? 'border-primary'
          : 'border-[var(--surface-subtle)] hover:border-[var(--interactive-border-hover)]'
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
  const [addCatalogOpen, setAddCatalogOpen] = React.useState(false);
  const [installDialogOpen, setInstallDialogOpen] = React.useState(false);
  const [installItem, setInstallItem] = React.useState<SkillsCatalogItem | null>(null);
  const [isRemovingCatalog, setIsRemovingCatalog] = React.useState(false);
  const [isRemoveCatalogDialogOpen, setIsRemoveCatalogDialogOpen] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

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
              <div className="h-10">
                <SortableTabsStrip
                  items={[
                    { id: 'manual', label: t('settings.skills.catalog.page.mode.manual') },
                    { id: 'external', label: t('settings.skills.catalog.page.mode.external') },
                  ]}
                  activeId={mode}
                  onSelect={(next) => onModeChange(next as 'manual' | 'external')}
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
              onClick={() => setAddCatalogOpen(true)}
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

          {isSelectedSourceLoading || (isLoadingSource && filtered.length === 0) ? (
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
                            <span className="text-[var(--status-success)] flex items-center justify-center w-7 h-7" title={t('settings.skills.catalog.page.badge.installed', { scope: installedScope || '' })}>
                              <Icon name="check" className="h-4 w-4" />
                            </span>
                          ) : (
                            <Button
                              variant="outline"
                              size="xs"
                              className="!font-normal"
                              disabled={!item.installable}
                              onClick={() => {
                                setInstallItem(item);
                                setInstallDialogOpen(true);
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
