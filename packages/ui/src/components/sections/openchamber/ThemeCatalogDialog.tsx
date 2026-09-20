import React from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { searchThemeCatalog, readThemePackage, type ThemeExtension } from '@/lib/theme/vscode/catalog';
import { SettingsCheckboxRow } from '../shared/SettingsSection';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';

type Variants = Awaited<ReturnType<typeof readThemePackage>>;
type CatalogState =
  | { step: 'search'; status: 'idle' | 'loading' | 'ready' | 'error'; results: ThemeExtension[] }
  | { step: 'package'; status: 'loading' | 'error'; extension: ThemeExtension }
  | { step: 'variants'; extension: ThemeExtension; variants: Variants };

function ExtensionIcon({ extension }: { extension: ThemeExtension }) {
  const [failed, setFailed] = React.useState(false);
  return extension.icon && !failed
    ? <img src={extension.icon} alt="" referrerPolicy="no-referrer" loading="lazy" className="size-9 shrink-0 rounded object-contain" onError={() => setFailed(true)} />
    : <Icon name="palette" className="size-9 shrink-0 text-muted-foreground" />;
}

export function ThemeCatalogDialog({ pickFile, fileBusy, onClose }: { pickFile: () => void; fileBusy: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const mobileLayout = useUIStore((state) => state.isMobile);
  const { isMobile: mobileDevice } = useDeviceInfo();
  const isMobile = mobileLayout || mobileDevice;
  const { importTheme } = useThemeSystem();
  const [query, setQuery] = React.useState('');
  const [state, setState] = React.useState<CatalogState>({ step: 'search', status: 'idle', results: [] });
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

  React.useEffect(() => {
    if (state.step !== 'search') return;
    const controller = new AbortController();
    const text = query.trim();
    const timer = setTimeout(async () => {
      if (!text) { setState({ step: 'search', status: 'idle', results: [] }); return; }
      setState({ step: 'search', status: 'loading', results: [] });
      try {
        const results = await searchThemeCatalog(text, controller.signal);
        if (!controller.signal.aborted) setState({ step: 'search', status: 'ready', results });
      } catch {
        if (!controller.signal.aborted) setState({ step: 'search', status: 'error', results: [] });
      }
    }, 350);
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
      if (!signal.aborted) setState({ step: 'variants', extension, variants });
    } catch {
      if (!signal.aborted) setState({ step: 'package', status: 'error', extension });
    }
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

  const selectable = state.step === 'variants'
    ? state.variants.filter((variant) => variant.status === 'ready' && !saved.has(variant.key))
    : [];
  const allSelected = selectable.length > 0 && selectable.every((variant) => selected.has(variant.key));

  const actions = <>
    {state.step === 'variants' && <Button disabled={!selected.size || saving || fileBusy} onClick={() => void install()}>{t(saving ? 'settings.themeImport.busy' : 'settings.themeImport.importSelected')}</Button>}
    <Button variant="outline" className="self-start" disabled={saving || fileBusy} onClick={pickFile}>{t('settings.themeImport.chooseFile')}</Button>
  </>;

  const content = <>
      {state.step === 'search' ? <>
        <Input autoFocus aria-label={t('settings.themeImport.search')} placeholder={t('settings.themeImport.search')} value={query} maxLength={160} onChange={(event) => setQuery(event.target.value)} />
        <div className={isMobile ? 'space-y-1' : 'max-h-[45dvh] overflow-y-auto space-y-1'} aria-live="polite">
          {state.status === 'loading' && <p className="text-muted-foreground">{t('common.loading')}</p>}
          {state.status === 'error' && <p role="alert" className="text-[var(--status-error-text)]">{t('settings.themeImport.catalogError')}</p>}
          {state.status === 'ready' && !state.results.length && <p className="text-muted-foreground">{t('settings.themeImport.empty')}</p>}
          {state.results.map((extension) => <Button key={`${extension.namespace}.${extension.name}`} variant="ghost" className="h-auto w-full justify-start py-2 text-left" onClick={() => void load(extension)}>
            <ExtensionIcon extension={extension} />
            <span className="min-w-0"><span className="block truncate">{extension.label}</span><span className="block truncate typography-meta text-muted-foreground">{extension.namespace}</span></span>
          </Button>)}
        </div>
      </> : <>
        <Button variant="ghost" size="sm" className="justify-start" disabled={saving || state.step === 'package' && state.status === 'loading'} onClick={() => setState({ step: 'search', status: 'idle', results: [] })}>
          <Icon name="arrow-left" className="size-4" />{t('settings.themeImport.back')}
        </Button>
        <p className="typography-ui-label">{state.extension.label}</p>
        {result === 'partial' && <p role="alert" className="text-[var(--status-error-text)]">{t('settings.themeImport.partialError')}</p>}
        {state.step === 'package' ? state.status === 'loading'
          ? <p role="status">{t('common.loading')}</p>
          : <p role="alert" className="text-[var(--status-error-text)]">{t('settings.themeImport.catalogError')}</p>
          : <>
            {state.variants.length > 1 && <Button variant="ghost" size="sm" className="self-start" disabled={saving || fileBusy || !selectable.length}
              onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((variant) => variant.key)))}>
              {t(allSelected ? 'settings.themeImport.deselectAll' : 'settings.themeImport.selectAll')}
            </Button>}
            <div className={isMobile ? 'space-y-2' : 'max-h-[45dvh] overflow-y-auto space-y-2'}>
              {state.variants.map((variant) => <div key={variant.key} className="flex items-center gap-3">
                {variant.status === 'ready' && <div aria-hidden="true" className="flex w-20 shrink-0 items-center gap-2 rounded px-2 py-3" style={{ backgroundColor: variant.theme.colors.surface.background, color: variant.theme.colors.surface.foreground }}>
                  <span>Aa</span><span className="space-y-1">{[variant.theme.colors.syntax.base.keyword, variant.theme.colors.syntax.base.string, variant.theme.colors.syntax.base.function].map((color, index) => <span key={index} className="block h-1 w-5 rounded" style={{ backgroundColor: color }} />)}</span>
                </div>}
                <div className="min-w-0 flex-1">
                  {saved.has(variant.key)
                    ? <div className="flex items-center gap-2 py-1"><Icon name="check" className="size-4 shrink-0 text-[var(--status-success-text)]" /><span className="typography-ui-label">{variant.name}</span></div>
                    : <SettingsCheckboxRow checked={selected.has(variant.key)} disabled={variant.status !== 'ready' || saving || fileBusy} label={variant.name}
                      onChange={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(variant.key); else next.delete(variant.key); return next; })} />}
                  <p className={saved.has(variant.key) ? 'typography-meta font-medium text-[var(--status-success-text)]' : 'typography-meta text-muted-foreground'}>{variant.status !== 'ready' ? t('settings.themeImport.error.invalid') : saved.has(variant.key) ? t('settings.themeImport.installed') : t(variant.theme.metadata.variant === 'dark' ? 'settings.openchamber.visual.option.themeMode.dark' : 'settings.openchamber.visual.option.themeMode.light')}</p>
                </div>
              </div>)}
            </div>
          </>}
      </>}
  </>;

  if (isMobile) {
    return <MobileOverlayPanel open title={t('settings.themeImport.catalogTitle')} onClose={onClose}
      footer={<div className="flex flex-col gap-2">{actions}</div>}>
      <div className="flex flex-col gap-4 px-1">
        <p className="typography-meta text-muted-foreground">{t('settings.themeImport.catalogHint')}</p>
        {content}
      </div>
    </MobileOverlayPanel>;
  }

  return <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
    <DialogContent className="max-w-lg" backdropProps={{ forceRender: true }}>
      <DialogHeader>
        <DialogTitle>{t('settings.themeImport.catalogTitle')}</DialogTitle>
        <DialogDescription>{t('settings.themeImport.catalogHint')}</DialogDescription>
      </DialogHeader>
      {content}
      {actions}
    </DialogContent>
  </Dialog>;
}
