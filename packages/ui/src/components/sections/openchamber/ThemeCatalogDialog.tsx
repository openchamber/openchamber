import React from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { searchThemeCatalog, readThemePackage, type ThemeExtension } from '@/lib/theme/vscode/catalog';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { cn } from '@/lib/utils';
import { SettingsInfoHint } from '../shared/SettingsInfoHint';
import { ThemeSchematic } from './ThemeSchematic';

type Variants = Awaited<ReturnType<typeof readThemePackage>>;
type Variant = Variants[number];
type CatalogState =
  | { step: 'search'; status: 'loading' | 'ready' | 'error'; results: ThemeExtension[] }
  | { step: 'package'; status: 'loading' | 'error'; extension: ThemeExtension }
  | { step: 'variants'; extension: ThemeExtension; variants: Variants };

const SKELETON_ROWS = 6;

function ExtensionIcon({ extension }: { extension: ThemeExtension }) {
  const [failed, setFailed] = React.useState(false);
  return extension.icon && !failed
    ? <img src={extension.icon} alt="" referrerPolicy="no-referrer" loading="lazy" className="size-9 shrink-0 rounded object-contain" onError={() => setFailed(true)} />
    : <Icon name="palette" className="size-9 shrink-0 text-muted-foreground" />;
}

/** Rows standing in for results while the catalog answers, the same height as a result. */
function ResultSkeleton() {
  const { t } = useI18n();
  const blink = useWaitingBlink(true);
  return (
    <>
    <span role="status" className="sr-only">{t('common.loading')}</span>
    <div aria-hidden className={cn('space-y-1', blink)}>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="flex items-center gap-2 px-2 py-2">
          <span className="size-9 shrink-0 rounded oc-tile-inset" />
          <span className="flex-1 space-y-1.5">
            <span className="block h-3 w-32 rounded oc-tile-inset" />
            <span className="block h-2.5 w-20 rounded oc-tile-inset" />
          </span>
        </div>
      ))}
    </div>
    </>
  );
}

/**
 * Open VSX theme catalog behind "Browse themes". It opens on the most
 * downloaded themes, so nobody has to know a name first; a click on one
 * reads its package and shows each variant drawn the way the app will look,
 * all of them selected, so importing is one more click.
 */
export function ThemeCatalogDialog({ pickFile, fileBusy, onClose }: { pickFile: () => void; fileBusy: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const mobileLayout = useUIStore((state) => state.isMobile);
  const { isMobile: mobileDevice } = useDeviceInfo();
  const isMobile = mobileLayout || mobileDevice;
  const { importTheme } = useThemeSystem();
  const [query, setQuery] = React.useState('');
  const [state, setState] = React.useState<CatalogState>({ step: 'search', status: 'loading', results: [] });
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [saved, setSaved] = React.useState<Set<string>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [result, setResult] = React.useState<'partial' | null>(null);
  const lifetime = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const unsubscribe = subscribeRuntimeEndpointChanged(() => controller.abort());
    return () => { unsubscribe(); controller.abort(); };
  }, []);

  // An empty query asks the server for the most downloaded themes.
  React.useEffect(() => {
    if (state.step !== 'search') return;
    const controller = new AbortController();
    const text = query.trim();
    const timer = setTimeout(async () => {
      setState({ step: 'search', status: 'loading', results: [] });
      try {
        const results = await searchThemeCatalog(text, controller.signal);
        if (!controller.signal.aborted) setState({ step: 'search', status: 'ready', results });
      } catch {
        if (!controller.signal.aborted) setState({ step: 'search', status: 'error', results: [] });
      }
    }, text ? 350 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, state.step]);

  const load = async (extension: ThemeExtension) => {
    const signal = lifetime.current?.signal;
    if (!signal) return;
    setState({ step: 'package', status: 'loading', extension });
    setSaved(new Set());
    setResult(null);
    setSelected(new Set());
    try {
      const variants = await readThemePackage(extension, signal);
      if (signal.aborted) return;
      setState({ step: 'variants', extension, variants });
      setSelected(new Set(variants.filter((variant) => variant.status === 'ready').map((variant) => variant.key)));
    } catch {
      if (!signal.aborted) setState({ step: 'package', status: 'error', extension });
    }
  };

  const backToSearch = () => {
    setResult(null);
    setState({ step: 'search', status: 'loading', results: [] });
  };

  const install = async () => {
    if (state.step !== 'variants' || saving) return;
    const signal = lifetime.current?.signal;
    if (!signal) return;
    setSaving(true);
    setResult(null);
    let failed = false;
    for (const variant of state.variants) {
      if (signal.aborted) break;
      if (variant.status !== 'ready' || !selected.has(variant.key) || saved.has(variant.key)) continue;
      try {
        await importTheme(variant.definition, { activate: false });
        if (signal.aborted) break;
        setSaved((current) => new Set(current).add(variant.key));
        setSelected((current) => { const next = new Set(current); next.delete(variant.key); return next; });
      } catch { failed = true; }
    }
    if (!signal.aborted) {
      setSaving(false);
      setResult(failed ? 'partial' : null);
      if (failed) toast.error(t('settings.themeImport.partialError'));
      else toast.success(t('settings.themeImport.complete'));
    }
  };

  const toggle = (key: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const selectable = state.step === 'variants'
    ? state.variants.filter((variant) => variant.status === 'ready' && !saved.has(variant.key))
    : [];
  const allSelected = selectable.length > 0 && selectable.every((variant) => selected.has(variant.key));
  const busy = saving || fileBusy;
  const title = state.step === 'search' ? t('settings.themeImport.action') : state.extension.label;

  const backButton = state.step === 'search' ? null : (
    <Button
      variant="ghost"
      size="sm"
      className="w-7 shrink-0 px-0"
      aria-label={t('settings.themeImport.back')}
      title={t('settings.themeImport.back')}
      disabled={saving || (state.step === 'package' && state.status === 'loading')}
      onClick={backToSearch}
    >
      <Icon name="arrow-left" className="size-4" />
    </Button>
  );

  const selectAll = state.step === 'variants' && selectable.length > 1 ? (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      disabled={busy}
      onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((variant) => variant.key)))}
    >
      {t(allSelected ? 'settings.themeImport.deselectAll' : 'settings.themeImport.selectAll')}
    </Button>
  ) : null;

  // The search field leads the header row at a query's width on desktop and spans the sheet on a phone.
  const searchField = state.step === 'search' ? (
    <div className={cn('relative min-w-0', isMobile ? 'w-full' : 'w-72')}>
      <Icon name="search" className="pointer-events-none absolute inset-s-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        autoFocus={!isMobile}
        inputSize="compact"
        aria-label={t('settings.themeImport.search')}
        placeholder={t('settings.themeImport.search')}
        value={query}
        maxLength={160}
        onChange={(event) => setQuery(event.target.value)}
        className="ps-7"
      />
    </div>
  ) : null;

  const message = (text: string, alert = false) => (
    <p role={alert ? 'alert' : 'status'} className={cn('px-2 py-6 text-center typography-ui-label', alert ? 'text-[var(--status-error-text)]' : 'text-muted-foreground')}>
      {text}
    </p>
  );

  const body = (() => {
    if (state.step === 'search') {
      if (state.status === 'loading') return <ResultSkeleton />;
      if (state.status === 'error') return message(t('settings.themeImport.catalogError'), true);
      if (!state.results.length) return message(t('settings.themeImport.empty'));
      return (
        <div className="space-y-1">
          {state.results.map((extension) => (
            <Button key={`${extension.namespace}.${extension.name}`} variant="ghost" className="h-auto w-full justify-start py-2 text-start" onClick={() => void load(extension)}>
              <ExtensionIcon extension={extension} />
              <span className="min-w-0">
                <span className="block truncate" dir="auto">{extension.label}</span>
                <span className="block truncate typography-meta text-muted-foreground">{extension.namespace}</span>
              </span>
            </Button>
          ))}
        </div>
      );
    }
    if (state.step === 'package') {
      return state.status === 'loading' ? <VariantSkeleton columns={isMobile ? 2 : 3} /> : message(t('settings.themeImport.catalogError'), true);
    }
    if (!state.variants.some((variant) => variant.status === 'ready')) return message(t('settings.themeImport.noReadableThemes'), true);
    return (
      <div className={cn('grid gap-2', isMobile ? 'grid-cols-2' : 'grid-cols-3')}>
        {state.variants.map((variant) => (
          <VariantCard
            key={variant.key}
            variant={variant}
            selected={selected.has(variant.key)}
            saved={saved.has(variant.key)}
            disabled={busy}
            onToggle={() => toggle(variant.key)}
          />
        ))}
      </div>
    );
  })();

  const footer = (
    <div className={cn('flex items-center gap-2', isMobile ? 'flex-col-reverse items-stretch' : 'justify-between')}>
      <Button variant="ghost" className={cn('text-muted-foreground hover:text-foreground', !isMobile && '-ms-2')} disabled={busy} onClick={pickFile}>
        <Icon name="file-upload" className="size-4" />
        {t('settings.themeImport.chooseFile')}
      </Button>
      {state.step === 'variants' ? (
        <Button disabled={!selected.size || busy} onClick={() => void install()}>
          {t(saving ? 'settings.themeImport.busy' : 'settings.themeImport.importSelected')}
        </Button>
      ) : null}
    </div>
  );

  // One reserved line under the list: a partial import says so here without moving the footer.
  const statusLine = (
    <p role="alert" className="min-h-5 truncate typography-meta text-[var(--status-error-text)]">
      {result === 'partial' ? t('settings.themeImport.partialError') : null}
    </p>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open
        title={title}
        onClose={onClose}
        renderHeader={(closeButton) => (
          <div className="flex items-center gap-1 border-b border-edge-muted py-2 ps-3 pe-3">
            {backButton}
            <h2 dir="auto" className="min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground">{title}</h2>
            {selectAll}
            {closeButton}
          </div>
        )}
        subheader={searchField}
        footer={<div className="space-y-1">{statusLine}{footer}</div>}
      >
        <div className="px-1" aria-live="polite">{body}</div>
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      {/* The close button sits in the header row, centred with the title and the search field. */}
      <DialogContent className="max-w-2xl gap-3" backdropProps={{ forceRender: true }} showCloseButton={false}>
        {/* Search opens on the search field itself, the button already named the dialog;
            a theme's page names the theme. */}
        <div className="flex min-h-7 items-center gap-1">
          {backButton}
          <DialogTitle className={cn('min-w-0 truncate', state.step === 'search' && 'sr-only')} dir="auto">{title}</DialogTitle>
          {searchField}
          {state.step === 'search' ? <SettingsInfoHint>{t('settings.themeImport.catalogHint')}</SettingsInfoHint> : null}
          <span className="flex-1" />
          {selectAll}
          <Button
            variant="ghost"
            size="sm"
            className="ms-1 w-7 shrink-0 px-0 text-muted-foreground hover:text-foreground"
            aria-label={t('dialog.common.actions.close')}
            onClick={onClose}
          >
            <Icon name="close" className="size-4" />
          </Button>
        </div>
        <DialogDescription className="sr-only">{t('settings.themeImport.catalogHint')}</DialogDescription>
        {/* The search field lives in the header row, so search and variants share one list height. */}
        <ScrollableOverlay outerClassName="h-[31rem]" className="pe-1" aria-live="polite" disableHorizontal>
          {body}
        </ScrollableOverlay>
        {statusLine}
        {footer}
      </DialogContent>
    </Dialog>
  );
}

function VariantSkeleton({ columns }: { columns: number }) {
  const { t } = useI18n();
  const blink = useWaitingBlink(true);
  return (
    <>
    <span role="status" className="sr-only">{t('common.loading')}</span>
    <div aria-hidden className={cn('grid gap-2', columns === 3 ? 'grid-cols-3' : 'grid-cols-2', blink)}>
      {Array.from({ length: columns }, (_, index) => index).map((index) => (
        <div key={index} className="space-y-2 rounded-xl p-1.5 oc-tile">
          <span className="block aspect-[8/5] rounded-lg oc-tile-inset" />
          <span className="block h-3 w-24 rounded oc-tile-inset" />
        </div>
      ))}
    </div>
    </>
  );
}

/**
 * One variant of a theme package, drawn with the same schematic as the
 * Appearance cards. A card toggles its selection; an imported one is done and
 * an unreadable one says so.
 */
function VariantCard({ variant, selected, saved, disabled, onToggle }: {
  variant: Variant;
  selected: boolean;
  saved: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const ready = variant.status === 'ready';
  const interactive = ready && !saved && !disabled;
  return (
    // A div, not a button: index.css clears the fill of every svg shape inside a button.
    <div
      role="checkbox"
      aria-checked={saved || selected}
      aria-disabled={!interactive}
      tabIndex={interactive ? 0 : -1}
      onClick={interactive ? onToggle : undefined}
      onKeyDown={(event) => {
        if (!interactive || (event.key !== ' ' && event.key !== 'Enter')) return;
        event.preventDefault();
        onToggle();
      }}
      className={cn(
        'flex min-w-0 select-none flex-col gap-1.5 rounded-xl p-1.5 focus-visible:outline-none',
        interactive && 'cursor-pointer',
        // Selection shows in the box before the name, so no fill tints the drawing.
        'oc-tile',
        interactive && 'oc-tile-hover focus-visible:bg-interactive-hover',
        !ready && 'opacity-60',
      )}
    >
      {ready
        ? <ThemeSchematic layout="desktop" theme={variant.theme} className="w-full rounded-lg" />
        : <span className="flex aspect-[8/5] items-center justify-center rounded-lg oc-tile-inset"><Icon name="palette" className="size-6 text-muted-foreground" /></span>}
      <div className="flex min-w-0 items-start gap-2 px-1 pb-0.5">
        {saved
          ? <Icon name="check" className="mt-0.5 size-4 shrink-0 text-[var(--status-success-text)]" />
          : (
            <span
              aria-hidden
              className={cn(
                'mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border',
                selected
                  ? 'border-[color:color-mix(in_srgb,var(--foreground)_60%,var(--interactive-border))]'
                  : 'border-[color:color-mix(in_srgb,var(--foreground)_40%,var(--interactive-border))]',
              )}
            >
              {selected ? <Icon name="check" className="size-2.5 text-foreground" /> : null}
            </span>
          )}
        {/* The drawing already shows light or dark; the caption speaks only for a done or broken variant. */}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 truncate typography-ui-label" dir="auto">{variant.name}</span>
            {saved ? <span className="shrink-0 typography-meta text-[var(--status-success-text)]">{t('settings.themeImport.installed')}</span> : null}
          </span>
          {!ready ? <span className="block truncate typography-meta text-[var(--status-error-text)]">{t('settings.themeImport.error.invalid')}</span> : null}
        </span>
      </div>
    </div>
  );
}
