import React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { importVSCodeTheme } from '@/lib/theme/vscode/import';
import { MAX_THEME_IMPORT_BYTES, ThemeImportError } from '@/lib/theme/importErrors';
import { SettingsInfoHint } from '../shared/SettingsInfoHint';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { ThemeCatalogDialog } from './ThemeCatalogDialog';

export function ThemeImportButton() {
  const { t } = useI18n();
  const { importTheme, customThemesLoading } = useThemeSystem();
  const apis = useRuntimeAPIs();
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const runtimeGenerationRef = React.useRef(0);
  const pickerRuntimeRef = React.useRef<{ key: string; generation: number } | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => { runtimeGenerationRef.current += 1; setOpen(false); }), []);

  const importFile = async (file: { name: string; size: number; text: () => Promise<string> }, scope: { key: string; generation: number }) => {
    setBusy(true);
    try {
      if (file.size > MAX_THEME_IMPORT_BYTES) throw new ThemeImportError('size');
      const text = await file.text();
      if (scope.key !== getRuntimeKey() || scope.generation !== runtimeGenerationRef.current) throw new ThemeImportError('connection');
      const theme = await importTheme(importVSCodeTheme(text, file.name));
      toast.success(t('settings.themeImport.success', { name: theme.metadata.name }));
      setOpen(false);
    } catch (error) {
      const code = error instanceof ThemeImportError ? error.code : 'invalid';
      toast.error(t(`settings.themeImport.error.${code}`));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async () => {
    if (busy) return;
    const scope = { key: getRuntimeKey(), generation: runtimeGenerationRef.current };
    pickerRuntimeRef.current = scope;
    if (!apis.themeFiles) { inputRef.current?.click(); return; }
    setBusy(true);
    try {
      const result = await apis.themeFiles.pick();
      if (result?.status === 'picked') {
        if (result.file) {
          const file = result.file;
          await importFile({ name: file.name, size: file.size, text: async () => file.text }, scope);
        }
        return;
      }
      inputRef.current?.click();
    } catch { toast.error(t('settings.themeImport.error.invalid')); }
    finally { setBusy(false); }
  };

  const handleFile: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file && !busy && pickerRuntimeRef.current) await importFile(file, pickerRuntimeRef.current);
  };

  return (
    <div className="flex items-center gap-2" data-settings-item="appearance.import-theme">
      <Button variant="outline" size="sm" disabled={busy || customThemesLoading} onClick={() => setOpen(true)}>
        <Icon name={busy ? 'loader' : 'add'} className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />
        {t(busy ? 'settings.themeImport.busy' : 'settings.themeImport.action')}
      </Button>
      <SettingsInfoHint>{t('settings.themeImport.catalogHint')}</SettingsInfoHint>
      <input ref={inputRef} type="file" accept=".json,.jsonc" className="hidden" aria-label={t('settings.themeImport.action')} onChange={handleFile} />
      {open && <ThemeCatalogDialog pickFile={() => void pickFile()} fileBusy={busy} onClose={close} />}
    </div>
  );
}
