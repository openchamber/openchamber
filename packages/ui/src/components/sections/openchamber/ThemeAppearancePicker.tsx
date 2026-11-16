import React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { Theme, ThemeMode } from '@/types/theme';
import {
  SettingsChipGroup,
  SettingsSection,
} from '../shared/SettingsSection';
import { ThemeImportButton } from './ThemeImportButton';
import { ThemeSchematic, type ThemeSchematicLayout } from './ThemeSchematic';
import { useThemeVariantTabStore, type ThemeVariant } from './themeVariantTab';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { SettingsCardSearch } from '../shared/SettingsCards';


const MODE_OPTIONS: Array<{ value: ThemeMode; labelKey: 'settings.openchamber.visual.option.themeMode.system' | 'settings.openchamber.visual.option.themeMode.light' | 'settings.openchamber.visual.option.themeMode.dark' }> = [
  { value: 'system', labelKey: 'settings.openchamber.visual.option.themeMode.system' },
  { value: 'light', labelKey: 'settings.openchamber.visual.option.themeMode.light' },
  { value: 'dark', labelKey: 'settings.openchamber.visual.option.themeMode.dark' },
];

const LIST_FADE_PX = 12;

const themeLabel = (theme: Theme): string => {
  const suffix = theme.metadata.variant === 'dark' ? ' Dark' : ' Light';
  const name = theme.metadata.name;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

const filterThemes = (themes: Theme[], query: string): Theme[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return themes;
  const rank = (name: string) => {
    if (name.startsWith(needle)) return 0;
    if (name.split(/[\s()\-_]+/).some((word) => word.startsWith(needle))) return 1;
    return name.includes(needle) ? 2 : -1;
  };
  return themes
    .map((theme) => ({ theme, rank: rank(themeLabel(theme).toLowerCase()) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.theme);
};

export function ThemeAppearancePicker() {
  const { t, direction } = useI18n();
  const { isMobile } = useDeviceInfo();
  const {
    currentTheme,
    themeMode,
    setThemeMode,
    availableThemes,
    lightThemeId,
    darkThemeId,
    setLightThemePreference,
    setDarkThemePreference,
  } = useThemeSystem();
  const layout: ThemeSchematicLayout = isMobile ? 'phone' : 'desktop';

  const chosenVariant = useThemeVariantTabStore((state) => state.variant);
  const setVariant = useThemeVariantTabStore((state) => state.setVariant);
  const variant: ThemeVariant = chosenVariant ?? (themeMode === 'system' ? currentTheme.metadata.variant : themeMode);
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');

  const themesByVariant = React.useMemo(() => {
    const sorted = [...availableThemes].sort((a, b) => themeLabel(a).localeCompare(themeLabel(b)));
    return {
      light: sorted.filter((theme) => theme.metadata.variant === 'light'),
      dark: sorted.filter((theme) => theme.metadata.variant === 'dark'),
    };
  }, [availableThemes]);

  const selectedLight = themesByVariant.light.find((theme) => theme.metadata.id === lightThemeId) ?? themesByVariant.light[0];
  const selectedDark = themesByVariant.dark.find((theme) => theme.metadata.id === darkThemeId) ?? themesByVariant.dark[0];
  const preview = previewId ? availableThemes.find((theme) => theme.metadata.id === previewId) : undefined;
  const shownLight = preview?.metadata.variant === 'light' ? preview : selectedLight;
  const shownDark = preview?.metadata.variant === 'dark' ? preview : selectedDark;

  const selectMode = (mode: ThemeMode) => {
    setThemeMode(mode);
    if (mode !== 'system') setVariant(mode);
  };

  const selectTheme = (theme: Theme) => {
    setPreviewId(null);
    if (theme.metadata.variant === 'light') setLightThemePreference(theme.metadata.id);
    else setDarkThemePreference(theme.metadata.id);
  };

  return (
    <>
      <SettingsSection
        title={t('settings.openchamber.visual.section.colorMode')}
        settingsItem="appearance.color-mode"
      >
        <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.colorMode')} className="oc-recessed grid grid-cols-3 gap-1 rounded-2xl bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-1 @xl:gap-1.5">
          {MODE_OPTIONS.map((option, index) => {
            const selected = themeMode === option.value;
            return (
              <div
                key={option.value}
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectMode(option.value)}
                onKeyDown={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault();
                    selectMode(option.value);
                    return;
                  }
                  const forward = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
                  const backward = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
                  const step = event.key === forward || event.key === 'ArrowDown' ? 1
                    : event.key === backward || event.key === 'ArrowUp' ? -1 : 0;
                  if (!step) return;
                  event.preventDefault();
                  const next = MODE_OPTIONS[(index + step + MODE_OPTIONS.length) % MODE_OPTIONS.length];
                  selectMode(next.value);
                  const group = event.currentTarget.parentElement;
                  window.requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
                }}
                className={cn(
                  'cursor-pointer select-none',
                  'flex min-w-0 flex-col items-center gap-0.5 rounded-xl px-1.5 pt-1.5 pb-0.5 typography-ui-label focus-visible:outline-none',
                  selected
                    ? 'oc-raised bg-[var(--surface-background)] text-foreground dark:bg-[var(--surface-elevated)]'
                    : 'text-muted-foreground hover:text-foreground focus-visible:bg-interactive-hover',
                )}
              >
                {selectedLight && selectedDark ? (
                  <ThemeSchematic
                    layout={layout}
                    theme={option.value === 'light' ? shownLight : shownDark}
                    splitWith={option.value === 'system' ? shownLight : undefined}
                    className="w-full rounded-lg"
                  />
                ) : null}
                <span className="w-full truncate text-center">{t(option.labelKey)}</span>
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.openchamber.visual.section.themes')}
        className="pt-4"
        info={(
          <>
            <span className="block">{t('settings.openchamber.visual.field.themeImportInfoTooltip')}</span>
            <span className="mt-1 block">{t('settings.themeImport.catalogHint')}</span>
          </>
        )}
        headerAction={<ThemeImportButton />}
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
          <SettingsChipGroup<ThemeVariant>
            value={variant}
            onChange={setVariant}
            aria-label={t('settings.openchamber.visual.section.themes')}
            className="max-w-full"
            options={[
              {
                value: 'light',
                label: (
                  <span className="inline-flex min-w-0 items-center gap-1.5" data-settings-item="appearance.light-theme">
                    <Icon name="sun" className="size-3.5 shrink-0" />
                    {t('settings.openchamber.visual.option.themeMode.light')}
                  </span>
                ),
              },
              {
                value: 'dark',
                label: (
                  <span className="inline-flex min-w-0 items-center gap-1.5" data-settings-item="appearance.dark-theme">
                    <Icon name="moon" className="size-3.5 shrink-0" />
                    {t('settings.openchamber.visual.option.themeMode.dark')}
                  </span>
                ),
              },
            ]}
          />
          <SettingsCardSearch
            value={query}
            onChange={setQuery}
            placeholder={t('settings.themeImport.search')}
            compact
            className={cn('mb-0', isMobile ? 'w-full max-w-none' : 'w-56')}
          />
          </div>
          <ThemeList
            key={variant}
            themes={filterThemes(themesByVariant[variant], query)}
            emptyText={query.trim() ? t('settings.openchamber.visual.field.noThemesMatch', { query: query.trim() }) : null}
            selectedId={(variant === 'light' ? selectedLight : selectedDark)?.metadata.id}
            ariaLabel={t(variant === 'light' ? 'settings.openchamber.visual.field.lightTheme' : 'settings.openchamber.visual.field.darkTheme')}
            touch={isMobile}
            onSelect={selectTheme}
            onPreview={setPreviewId}
          />
        </div>
      </SettingsSection>
    </>
  );
}

interface ThemeListProps {
  themes: Theme[];
  emptyText: string | null;
  selectedId: string | undefined;
  ariaLabel: string;
  touch: boolean;
  onSelect: (theme: Theme) => void;
  onPreview: (id: string | null) => void;
}

function ThemeList({ themes, emptyText, selectedId, ariaLabel, touch, onSelect, onPreview }: ThemeListProps) {
  const { t } = useI18n();
  const { deleteImportedTheme, customThemeIds } = useThemeSystem();
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const [fade, setFade] = React.useState({ top: false, bottom: false });
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const tabStopId = themes.some((theme) => theme.metadata.id === focusedId)
    ? focusedId
    : (selectedId ?? themes[0]?.metadata.id ?? null);

  const updateFade = React.useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.scrollTop > 1;
    const bottom = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
    setFade((current) => (current.top === top && current.bottom === bottom ? current : { top, bottom }));
  }, []);

  const revealSelected = React.useCallback((onlyIfHidden: boolean) => {
    const scroller = scrollerRef.current;
    const row = scroller?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!scroller || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const visible = top >= scroller.scrollTop && bottom <= scroller.scrollTop + scroller.clientHeight;
    if (onlyIfHidden && visible) return;
    const centred = Math.max(0, top - (scroller.clientHeight - row.offsetHeight) / 2);
    const rowTops = [...new Set(Array.from(scroller.querySelectorAll<HTMLElement>('[role="option"]'), (option) => option.offsetTop))];
    const anchor = rowTops.filter((rowTop) => rowTop - LIST_FADE_PX <= centred).pop();
    scroller.scrollTop = anchor === undefined ? 0 : Math.max(0, anchor - LIST_FADE_PX);
  }, []);

  React.useLayoutEffect(() => {
    revealSelected(false);
    updateFade();
  }, [revealSelected, updateFade]);

  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => {
      revealSelected(true);
      updateFade();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [revealSelected, updateFade]);

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    const row = listRef.current?.querySelector<HTMLElement>(`[data-theme-id="${CSS.escape(id)}"]`);
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
  };

  const remove = async (theme: Theme, index: number) => {
    if (deletingId) return;
    const id = theme.metadata.id;
    const neighbour = themes[index + 1] ?? themes[index - 1];
    const hadFocus = listRef.current?.contains(document.activeElement) ?? false;
    setDeletingId(id);
    try {
      await deleteImportedTheme(id);
      onPreview(null);
      if (hadFocus) window.requestAnimationFrame(() => focusRow(neighbour?.metadata.id));
    } catch {
      toast.error(t('settings.themeImport.deleteError'));
    } finally {
      setDeletingId(null);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, theme: Theme, index: number) => {
    const move = (key: string) => {
      const target = key === 'ArrowDown' ? themes[index + 1]
        : key === 'ArrowUp' ? themes[index - 1]
          : key === 'Home' ? themes[0]
            : key === 'End' ? themes[themes.length - 1]
              : undefined;
      if (!target) return;
      focusRow(target.metadata.id);
      onPreview(target.metadata.id);
    };
    if (handleDropdownNavigationKey(event, move)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(theme);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && customThemeIds.includes(theme.metadata.id)) {
      event.preventDefault();
      void remove(theme, index);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      move(event.key);
    }
  };

  return (
    <div
      ref={scrollerRef}
      onScroll={updateFade}
      onPointerLeave={() => onPreview(null)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) onPreview(null);
      }}
      className={cn(
        'oc-tile relative max-h-[20.5rem] scroll-py-3 overflow-y-auto rounded-xl px-1 py-3',
        fade.top && fade.bottom && '[mask-image:linear-gradient(transparent,#000_0.75rem,#000_calc(100%-0.75rem),transparent)]',
        fade.top && !fade.bottom && '[mask-image:linear-gradient(transparent,#000_0.75rem)]',
        !fade.top && fade.bottom && '[mask-image:linear-gradient(#000_calc(100%-0.75rem),transparent)]',
      )}
    >
      {themes.length === 0 && emptyText ? (
        <p role="status" className="px-2 py-6 text-center typography-ui-label text-muted-foreground">{emptyText}</p>
      ) : null}
      <div ref={listRef} role="listbox" aria-label={ariaLabel} className="grid grid-cols-1 gap-x-1 @xl:grid-cols-2">
        {themes.map((theme, index) => {
          const id = theme.metadata.id;
          const selected = id === selectedId;
          const label = themeLabel(theme);
          const deletable = customThemeIds.includes(id);
          const isDeleting = deletingId === id;
          return (
            <div
              key={id}
              role="option"
              aria-selected={selected}
              data-theme-id={id}
              tabIndex={id === tabStopId ? 0 : -1}
              onClick={() => onSelect(theme)}
              onKeyDown={(event) => handleKeyDown(event, theme, index)}
              onFocus={() => setFocusedId(id)}
              onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') onPreview(id);
              }}
              className={cn(
                'relative flex min-w-0 cursor-pointer select-none items-center gap-2.5 rounded-md ps-2 typography-ui-label focus-visible:outline-none',
                touch ? 'min-h-11' : 'h-8',
                deletable ? 'pe-1' : 'pe-2',
                selected
                  ? 'oc-selected text-interactive-selection-foreground'
                  : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:bg-interactive-hover focus-visible:text-foreground',
              )}
            >
              <ThemeSwatch theme={theme} />
              <span className="min-w-0 flex-1 truncate" dir="auto">{label}</span>
              {selected ? <Icon name="check" className="size-4 shrink-0 text-muted-foreground" /> : null}
              {deletable ? (
                <Button
                  variant="ghost"
                  size="icon"
                  tabIndex={-1}
                  className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={isDeleting}
                  aria-label={t('settings.themeImport.delete', { name: label })}
                  onClick={(event) => {
                    event.stopPropagation();
                    void remove(theme, index);
                  }}
                >
                  <Icon name={isDeleting ? 'loader' : 'delete-bin'} className={isDeleting ? 'size-4 animate-spin' : 'size-4'} />
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ThemeSwatch({ theme }: { theme: Theme }) {
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-md"
      style={{
        backgroundColor: theme.colors.surface.background,
        boxShadow: `inset 0 0 0 1px ${theme.metadata.variant === 'dark' ? 'rgb(255 255 255 / 0.12)' : 'rgb(0 0 0 / 0.12)'}`,
      }}
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: theme.colors.primary.base }} />
    </span>
  );
}
