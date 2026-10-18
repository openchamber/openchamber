import React from 'react';
import { z } from 'zod';
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { CredentialConnection } from './providerAuth';

const rotationSchema = z.object({ enabled: z.boolean(), accountIds: z.array(z.string()) });
type RotationConfig = z.infer<typeof rotationSchema>;
type LoadState = { status: 'loading' } | { status: 'unsupported' } | { status: 'error' }
  | { status: 'ready'; config: RotationConfig };

/** Goals run on the OpenChamber server; VS Code explicitly returns 501. */
export function AccountRotationSettings({ accounts, directory }: {
  accounts: readonly CredentialConnection[];
  directory: string | null;
}) {
  const { t } = useI18n();
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const [saving, setSaving] = React.useState(false);
  const [saveFailed, setSaveFailed] = React.useState(false);
  const [revision, reload] = React.useReducer((value: number) => value + 1, 0);
  const generation = React.useRef(0);
  React.useEffect(() => {
    const current = ++generation.current;
    const runtime = getRuntimeKey();
    const controller = new AbortController();
    setState({ status: 'loading' });
    setSaving(false);
    setSaveFailed(false);
    void (async () => {
      try {
        const response = await runtimeFetch('/api/provider/account-rotation', { signal: controller.signal });
        if (response.status === 501 || response.status === 404) {
          if (current === generation.current && runtime === getRuntimeKey()) setState({ status: 'unsupported' });
          return;
        }
        if (!response.ok) throw new Error('Account rotation read failed');
        const config = rotationSchema.parse(await response.json());
        if (current === generation.current && runtime === getRuntimeKey()) setState({ status: 'ready', config });
      } catch {
        if (!controller.signal.aborted && current === generation.current && runtime === getRuntimeKey()) setState({ status: 'error' });
      }
    })();
    return () => { controller.abort(); generation.current += 1; };
  }, [directory, revision]);

  if (state.status === 'unsupported') return null;
  const config = state.status === 'ready' ? state.config : null;
  const available = accounts.filter((account) => account.method === 'oauth' && !account.status);
  const ids = Array.from(new Set([...available.map((account) => account.id), ...(config?.accountIds ?? [])]));
  const edit = (next: RotationConfig) => { setSaveFailed(false); setState({ status: 'ready', config: next }); };
  const save = async () => {
    if (!config || saving) return;
    const current = generation.current;
    const runtime = getRuntimeKey();
    setSaving(true);
    setSaveFailed(false);
    reportSettingsSaveState('saving');
    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (directory) headers['x-opencode-directory'] = directory;
      const response = await runtimeFetch('/api/provider/account-rotation', {
        method: 'PUT',
        headers,
        body: JSON.stringify(config),
      });
      if (!response.ok) throw new Error('Account rotation save failed');
      const saved = rotationSchema.parse(await response.json());
      if (current === generation.current && runtime === getRuntimeKey()) {
        setState({ status: 'ready', config: saved });
        reportSettingsSaveState('saved');
      }
    } catch {
      if (current === generation.current && runtime === getRuntimeKey()) {
        setSaveFailed(true);
        reportSettingsSaveState('error');
      }
    } finally {
      if (current === generation.current && runtime === getRuntimeKey()) setSaving(false);
    }
  };

  return (
    <SettingsSection title={t('settings.providers.rotation.title')} info={t('settings.providers.rotation.info')} contentClassName="space-y-3">
      <SettingsCheckboxRow
        label={t('settings.providers.rotation.enabled')}
        ariaLabel={t('settings.providers.rotation.enabled')}
        description={t('settings.providers.rotation.warning')}
        checked={config?.enabled ?? false}
        disabled={!config || saving}
        onChange={(enabled) => { if (config) edit({ ...config, enabled }); }}
      />
      <div className="space-y-1.5 ps-6">
        {ids.map((id) => (
          <SettingsCheckboxRow
            key={id}
            label={<span dir="auto">{accounts.find((account) => account.id === id)?.label ?? id}</span>}
            ariaLabel={accounts.find((account) => account.id === id)?.label ?? id}
            checked={config?.accountIds.includes(id) ?? false}
            disabled={!config || saving}
            onChange={(included) => {
              if (config) edit({ ...config, accountIds: included ? [...config.accountIds, id] : config.accountIds.filter((value) => value !== id) });
            }}
          />
        ))}
      </div>
      <div className="flex min-h-8 items-center gap-3">
        {state.status === 'error' ? (
          <Button variant="outline" size="sm" onClick={reload}>{t('settings.providers.rotation.retry')}</Button>
        ) : (
          <Button variant="outline" size="sm" disabled={!config || saving || (config.enabled && config.accountIds.length < 2)} onClick={() => void save()}>
            {t('settings.providers.accounts.save')}
          </Button>
        )}
        <span role="status" className="truncate typography-meta text-muted-foreground">
          {state.status === 'error' || saveFailed ? t('settings.providers.rotation.failed') : config && config.accountIds.length < 2 ? t('settings.providers.rotation.minimum') : ''}
        </span>
      </div>
    </SettingsSection>
  );
}
