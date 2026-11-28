import React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsPageLayout } from '../shared/SettingsPageLayout';
import { SettingsFieldRow, SettingsSection, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '../shared/SettingsSection';
import { SettingsColorField } from '../shared/SettingsColorField';
import { ThemeSchematic } from './ThemeSchematic';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { isDesktopTransparentWindow } from '@/lib/desktopRuntime';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { reportSettingsSaveState } from '@/lib/persistence';
import { MAX_THEME_IMPORT_BYTES, ThemeImportError } from '@/lib/theme/importErrors';
import { editorTheme, changeThemeColor, changeBackgroundOpacity, colorOpacity, parseEditorTheme, themeColorFields } from '@/lib/theme/editor';
import { compactTheme } from '@/lib/theme/definition';
import { withOpacity } from '@/lib/theme/color';
import type { Theme } from '@/types/theme';

export function ThemeEditorPage() {
  const { currentTheme, availableThemes, importTheme } = useThemeSystem();
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  const isMobile = useUIStore((state) => state.isMobile);
  const [draft, setDraft] = React.useState<Theme>(() => editorTheme(currentTheme));
  const [group, setGroup] = React.useState('surface');
  const [busy, setBusy] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const fields = themeColorFields(draft.colors);
  const groups = [...new Set(fields.map((field) => field.path.split('.')[0]))];
  const fail = (error: unknown) => toast.error(t(error instanceof ThemeImportError && error.code !== 'invalid'
    ? `settings.themeImport.error.${error.code}` : 'settings.themeEditor.invalid'));
  const replace = (value: Theme) => {
    try { setDraft(editorTheme(value)); } catch (error) { fail(error); }
  };
  const readFile = async (file: { size: number; text: () => Promise<string> }, runtime: string) => {
    if (file.size > MAX_THEME_IMPORT_BYTES) throw new ThemeImportError('size');
    const text = await file.text();
    if (!input.current || runtime !== getRuntimeKey()) throw new ThemeImportError('connection');
    setDraft(parseEditorTheme(text));
  };
  const load = async () => {
    const runtime = getRuntimeKey();
    if (!apis.themeFiles) { input.current?.click(); return; }
    setBusy(true);
    try {
      const result = await apis.themeFiles.pick();
      if (result.status === 'unsupported') input.current?.click();
      else if (result.file) {
        const file = result.file;
        await readFile({ size: file.size, text: async () => file.text }, runtime);
      }
    } catch (error) { fail(error); }
    finally { if (input.current) setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    reportSettingsSaveState('saving');
    try {
      await importTheme(compactTheme(draft));
      reportSettingsSaveState('saved');
    } catch (error) { reportSettingsSaveState('error'); fail(error); }
    finally { if (input.current) setBusy(false); }
  };
  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(compactTheme(draft), null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'openchamber-theme.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) { fail(error); }
  };
  return (
    <SettingsPageLayout title={t('settings.themeEditor.title')} namedBySidebar showSaveStatus>
      <SettingsSection title={t('settings.themeEditor.title')}>
        <SettingsFieldRow label={t('settings.themeEditor.base')} settingsItem="theme-editor.base">
          <Select value={draft.metadata.id} onValueChange={(id) => {
            const theme = availableThemes.find((item) => item.metadata.id === id);
            if (theme) replace(theme);
          }} disabled={busy}>
            <SelectTrigger size={isMobile ? 'touch' : 'default'} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.themeEditor.base')}>
              <SelectValue>{draft.metadata.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>{availableThemes.map((theme) => <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
              <span dir="auto">{theme.metadata.name}</span>
            </SelectItem>)}</SelectContent>
          </Select>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.themeEditor.name')}>
          <Input value={draft.metadata.name} maxLength={160} disabled={busy} aria-label={t('settings.themeEditor.name')}
            className="w-64 max-w-full pointer-coarse:min-h-9" onChange={(event) => setDraft({ ...draft, metadata: { ...draft.metadata, name: event.target.value } })} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.themeEditor.files')} info={t('settings.themeEditor.saveHint')} settingsItem="theme-editor.files">
          <div className="flex items-center gap-2">
            <Button variant="outline" size={isMobile ? 'lg' : 'sm'} onClick={() => void load()} disabled={busy}>{t('settings.themeEditor.load')}</Button>
            <Button variant="outline" size={isMobile ? 'lg' : 'sm'} onClick={download} disabled={busy} aria-label={t('settings.themeEditor.export')}>
              {isMobile ? <Icon name="download" className="size-4" /> : t('settings.themeEditor.export')}
            </Button>
            <Button size={isMobile ? 'lg' : 'sm'} onClick={() => void save()} disabled={busy || !draft.metadata.name.trim()}>{t('settings.themeEditor.save')}</Button>
          </div>
          <input ref={input} type="file" accept=".json,application/json" className="hidden" aria-label={t('settings.themeEditor.load')}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setBusy(true);
              try { await readFile(file, getRuntimeKey()); } catch (error) { fail(error); }
              finally { if (input.current) setBusy(false); }
            }} />
        </SettingsFieldRow>
      </SettingsSection>
      <SettingsSection title={t('settings.themeEditor.preview')} info={t('settings.themeEditor.previewHint')}>
        <ThemeSchematic theme={draft} layout="desktop" translucentPreview className="w-full max-w-md rounded-md bg-[repeating-conic-gradient(var(--surface-muted)_0%_25%,var(--surface-elevated)_0%_50%)] bg-[length:16px_16px]" />
      </SettingsSection>
      <SettingsSection title={t('settings.themeEditor.colors')}>
        <SettingsFieldRow label={t('settings.themeEditor.group')}>
          <Select value={group} onValueChange={setGroup} disabled={busy}>
            <SelectTrigger size={isMobile ? 'touch' : 'default'} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.themeEditor.group')}><SelectValue /></SelectTrigger>
            <SelectContent>{groups.map((name) => <SelectItem key={name} value={name}><code dir="ltr">{name}</code></SelectItem>)}</SelectContent>
          </Select>
        </SettingsFieldRow>
        {fields.filter((field) => field.path.startsWith(`${group}.`)).map((field) =>
          <SettingsFieldRow key={field.path} label={<code dir="ltr">{field.path}</code>}>
            <div className="flex flex-wrap items-center gap-2">
              <SettingsColorField compact disabled={busy} value={field.value.slice(0, 7)} onChange={(value) => {
                setDraft(changeThemeColor(draft, field.path, field.background ? withOpacity(value, colorOpacity(field.value)) : value));
              }} labels={{
                empty: t('settings.themeEditor.color', { path: field.path }),
                swatch: (color) => color,
                custom: t('settings.themeEditor.color', { path: field.path }),
                hex: t('settings.themeEditor.color', { path: field.path }),
              }} />
              {field.background && <input type="range" min={0} max={1} step={0.01} value={colorOpacity(field.value)} disabled={busy}
                aria-label={t('settings.themeEditor.opacity', { path: field.path })} className="w-24 pointer-coarse:min-h-9"
                onChange={(event) => setDraft(changeBackgroundOpacity(draft, field.path, Number(event.target.value)))} />}
              {field.background && <span className="typography-meta text-muted-foreground" dir="ltr">{Math.round(colorOpacity(field.value) * 100)}%</span>}
            </div>
          </SettingsFieldRow>)}
      </SettingsSection>
      <SettingsSection title={t('settings.themeEditor.window')} settingsItem="theme-editor.window" info={t('settings.themeEditor.windowHint')}>
        <SettingsFieldRow label={t('settings.themeEditor.window')} description={!isDesktopTransparentWindow() ? t('settings.themeEditor.windowUnavailable') : undefined}>
          <input type="range" min={0.01} max={1} step={0.01} value={draft.config?.backgroundOpacity ?? 1} disabled={busy || !isDesktopTransparentWindow()}
            aria-label={t('settings.themeEditor.window')} className="w-40 pointer-coarse:min-h-9"
            onChange={(event) => setDraft({ ...draft, config: { ...draft.config, backgroundOpacity: Number(event.target.value) } })} />
          <span className="typography-meta text-muted-foreground" dir="ltr">{Math.round((draft.config?.backgroundOpacity ?? 1) * 100)}%</span>
        </SettingsFieldRow>
      </SettingsSection>
    </SettingsPageLayout>
  );
}
