import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SettingsChipGroup,
  SettingsControlGroup,
  SettingsStackedField,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { parseBrowserDebugPortInput, readBrowserRuntimeStatus, type BrowserRuntimeStatus } from '@/lib/browserRuntimeStatus';
import { useUIStore } from '@/stores/useUIStore';

type Status =
  | { readonly kind: 'loading' | 'unavailable' }
  | { readonly kind: 'ready'; readonly value: BrowserRuntimeStatus };

const BrowserDebugPortForm = ({ runtimeKey, statusRevision }: { readonly runtimeKey: string; readonly statusRevision: number }) => {
  const { t } = useI18n();
  const configuredPort = useUIStore((state) => state.serverBrowserDebugPort);
  const [mode, setMode] = React.useState<'automatic' | 'fixed'>(configuredPort === 0 ? 'automatic' : 'fixed');
  const [portInput, setPortInput] = React.useState(configuredPort === 0 ? '' : String(configuredPort));
  const [status, setStatus] = React.useState<Status>({ kind: 'loading' });
  const [saving, setSaving] = React.useState(false);
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const request = React.useRef<AbortController | null>(null);
  const mounted = React.useRef(false);
  const validationId = React.useId();

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  React.useEffect(() => {
    setMode(configuredPort === 0 ? 'automatic' : 'fixed');
    setPortInput(configuredPort === 0 ? '' : String(configuredPort));
  }, [configuredPort]);

  const refresh = React.useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus({ kind: 'loading' });
    setCopyState('idle');
    const isCurrent = () => !controller.signal.aborted && getRuntimeKey() === runtimeKey;
    void readBrowserRuntimeStatus(controller.signal).then((value) => {
      if (!isCurrent()) return;
      useUIStore.getState().setServerBrowserDebugPort(value.configuredPort);
      setStatus({ kind: 'ready', value });
    }, () => {
      if (isCurrent()) setStatus({ kind: 'unavailable' });
    });
  }, [runtimeKey]);

  React.useEffect(() => {
    refresh();
    return () => request.current?.abort();
  }, [refresh, statusRevision]);

  const selectedPort = mode === 'automatic' ? 0 : parseBrowserDebugPortInput(portInput);
  const invalid = mode === 'fixed' && selectedPort === null;

  const save = async () => {
    if (selectedPort === null || selectedPort === configuredPort || saving) return;
    request.current?.abort();
    setSaving(true);
    setStatus({ kind: 'loading' });
    setCopyState('idle');
    await updateDesktopSettings({ serverBrowserDebugPort: selectedPort });
    if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
    setSaving(false);
    refresh();
  };

  const activePort = status.kind === 'ready' ? status.value.activePort : null;
  const browserUrl = activePort === null ? null : `http://127.0.0.1:${activePort}`;
  const copy = async () => {
    if (!browserUrl) return;
    const controller = request.current;
    const isCurrent = () => controller === request.current && !controller?.signal.aborted && getRuntimeKey() === runtimeKey;
    const result = await copyTextToClipboard(browserUrl, isCurrent);
    if (isCurrent()) setCopyState(result.ok ? 'copied' : 'failed');
  };

  return (
    <SettingsControlGroup
      title={t('settings.openchamber.tools.browserDebugPort.label')}
      info={t('settings.openchamber.tools.browserDebugPort.info')}
      settingsItem="sessions.server-browser-debug-port"
      className="pt-4"
      contentClassName={SETTINGS_FIELDS_STACK_CLASS}
    >
      <SettingsChipGroup
        value={mode}
        onChange={setMode}
        aria-label={t('settings.openchamber.tools.browserDebugPort.label')}
        options={[
          { value: 'automatic', label: t('settings.openchamber.tools.browserDebugPort.automatic'), disabled: saving },
          { value: 'fixed', label: t('settings.openchamber.tools.browserDebugPort.fixed'), disabled: saving },
        ]}
      />
      {mode === 'fixed' ? (
        <SettingsStackedField label={t('settings.openchamber.tools.browserDebugPort.input')}>
          <Input
            value={portInput}
            onChange={(event) => setPortInput(event.target.value)}
            inputMode="numeric"
            maxLength={5}
            disabled={saving}
            aria-label={t('settings.openchamber.tools.browserDebugPort.input')}
            aria-invalid={invalid}
            aria-describedby={invalid ? validationId : undefined}
            className="h-9 max-w-[16ch] rounded-md px-3"
          />
        </SettingsStackedField>
      ) : null}
      {invalid ? <p id={validationId} role="alert" className="typography-meta text-[var(--status-error)]">{t('settings.openchamber.tools.browserDebugPort.invalid')}</p> : null}
      <Button type="button" size="sm" disabled={invalid || saving || selectedPort === configuredPort} onClick={() => void save()}>
        {t('settings.openchamber.tools.browserDebugPort.save')}
      </Button>
      <div className={SETTINGS_HELPER_CLASS} aria-live="polite">
        <p>{configuredPort === 0
          ? t('settings.openchamber.tools.browserDebugPort.configuredAutomatic')
          : t('settings.openchamber.tools.browserDebugPort.configuredFixed', { port: configuredPort })}</p>
        {status.kind === 'loading' ? <p>{t('settings.openchamber.tools.browserDebugPort.loading')}</p> : null}
        {status.kind === 'unavailable' ? <p>{t('settings.openchamber.tools.browserDebugPort.unavailable')}</p> : null}
        {status.kind === 'ready' ? (
          <>
            <p>{status.value.running
              ? t('settings.openchamber.tools.browserDebugPort.active', { port: status.value.activePort })
              : t('settings.openchamber.tools.browserDebugPort.stopped')}</p>
            {status.value.restartRequired ? <p>{t('settings.openchamber.tools.browserDebugPort.pending')}</p> : null}
          </>
        ) : null}
      </div>
      {browserUrl ? (
        <SettingsStackedField label={<code className="break-all">{browserUrl}</code>} info={t('settings.openchamber.tools.browserDebugPort.connectionInfo')}>
          <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
            {t('settings.openchamber.tools.browserDebugPort.copy')}
          </Button>
        </SettingsStackedField>
      ) : null}
      {copyState === 'copied' ? <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.openchamber.tools.browserDebugPort.copied')}</p> : null}
      {copyState === 'failed' ? <p role="alert" className="typography-meta text-[var(--status-error)]">{t('settings.openchamber.tools.browserDebugPort.copyFailed')}</p> : null}
      <Button type="button" variant="ghost" size="sm" disabled={saving || status.kind === 'loading'} onClick={refresh}>
        {t('settings.openchamber.tools.browserDebugPort.refresh')}
      </Button>
    </SettingsControlGroup>
  );
};

export const BrowserDebugPortSettings = ({ statusRevision }: { readonly statusRevision: number }) => {
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  return <BrowserDebugPortForm key={runtimeKey} runtimeKey={runtimeKey} statusRevision={statusRevision} />;
};
