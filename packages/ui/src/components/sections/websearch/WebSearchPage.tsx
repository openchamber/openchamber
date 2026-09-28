import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { WebSearchProvider, WebSearchProviderAccess, WebSearchSelection } from '@/lib/opencode/websearch';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsFieldRow,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { getWebSearchScopeKey, useWebSearchStore, type WebSearchSnapshot } from '@/stores/useWebSearchStore';

/**
 * Settings → Web search: which provider OpenCode's `websearch` tool uses, and
 * the optional API key each provider takes. Both belong to OpenCode: the
 * choice is the `websearch` key of its config, the keys are integration
 * credentials, so the page reads them from OpenCode and writes them back.
 */

const sameSelection = (a: WebSearchSelection, b: WebSearchSelection): boolean =>
  a.kind === b.kind && (a.kind !== 'provider' || (b.kind === 'provider' && a.id === b.id));

const SelectionSection: React.FC<{ snapshot: WebSearchSnapshot }> = ({ snapshot }) => {
  const { t } = useI18n();
  const setSelection = useWebSearchStore((store) => store.setSelection);
  const selected = snapshot.selection;
  // A project config's `websearch` wins over the file Settings writes, so a
  // choice here would snap back; show where it comes from instead.
  const locked = snapshot.projectOverride !== null;

  const choose = (selection: WebSearchSelection) => {
    if (locked || sameSelection(selection, selected)) return;
    void setSelection(selection).then((ok) => {
      if (!ok) toast.error(t('settings.webSearch.toast.saveFailed'));
    });
  };

  // A configured provider OpenCode no longer offers (plugin removed, typo in
  // the file) stays visible so the user can see why search does not run.
  const missingProvider = selected.kind === 'provider' && !snapshot.providers.some((provider) => provider.id === selected.id)
    ? selected.id
    : null;

  return (
    <SettingsSection
      title={t('settings.webSearch.section.provider')}
      info={t('settings.webSearch.section.providerInfo')}
      divider={false}
      settingsItem="web-search.provider"
    >
      <div>
        <SettingsRadioGroup aria-label={t('settings.webSearch.section.provider')}>
          <SettingsRadioOption
            selected={selected.kind === 'default'}
            onSelect={() => choose({ kind: 'default' })}
            disabled={locked}
            label={t('settings.webSearch.option.default')}
            description={t('settings.webSearch.option.defaultDescription')}
          />
          {snapshot.providers.length > 0 ? (
            <SettingsRadioOption
              selected={selected.kind === 'random'}
              onSelect={() => choose({ kind: 'random' })}
              disabled={locked}
              label={t('settings.webSearch.option.random')}
              description={t('settings.webSearch.option.randomDescription')}
            />
          ) : null}
          {snapshot.providers.map((provider) => (
            <SettingsRadioOption
              key={provider.id}
              selected={selected.kind === 'provider' && selected.id === provider.id}
              onSelect={() => choose({ kind: 'provider', id: provider.id })}
              disabled={locked}
              label={provider.name}
            />
          ))}
          {missingProvider ? (
            <SettingsRadioOption
              selected
              onSelect={() => undefined}
              label={missingProvider}
              description={t('settings.webSearch.option.missing')}
            />
          ) : null}
          <SettingsRadioOption
            selected={selected.kind === 'off'}
            onSelect={() => choose({ kind: 'off' })}
            disabled={locked}
            label={t('settings.webSearch.option.off')}
          />
        </SettingsRadioGroup>
        {snapshot.projectOverride ? (
          <p className={`${SETTINGS_HELPER_CLASS} mt-2 break-all`}>
            {t('settings.webSearch.state.projectOverride', { path: snapshot.projectOverride })}
          </p>
        ) : null}
        {snapshot.providers.length === 0 ? (
          <p className={`${SETTINGS_HELPER_CLASS} mt-2`}>{t('settings.webSearch.state.noProviders')}</p>
        ) : null}
      </div>
    </SettingsSection>
  );
};

const ProviderKeyRow: React.FC<{ provider: WebSearchProvider; access: WebSearchProviderAccess }> = ({ provider, access }) => {
  const { t } = useI18n();
  const saveKey = useWebSearchStore((store) => store.saveKey);
  const removeKey = useWebSearchStore((store) => store.removeKey);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const envHint = access.envNames.length > 0 ? t('settings.webSearch.keys.envHint', { names: access.envNames.join(', ') }) : undefined;

  const handleSave = async () => {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    const ok = await saveKey(provider.id, key);
    setBusy(false);
    if (ok) {
      setDraft('');
      toast.success(t('settings.webSearch.toast.keySaved', { provider: provider.name }));
    } else {
      toast.error(t('settings.webSearch.toast.keySaveFailed'));
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    const ok = await removeKey(provider.id);
    setBusy(false);
    if (!ok) toast.error(t('settings.webSearch.toast.keyRemoveFailed'));
  };

  const status = access.key;
  return (
    <SettingsFieldRow label={provider.name} info={envHint}>
      {status.kind === 'stored' ? (
        <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex items-center justify-end gap-2`}>
          <span className="typography-meta text-muted-foreground">{t('settings.webSearch.keys.saved')}</span>
          <Button variant="outline" size="xs" disabled={busy} onClick={() => void handleRemove()}>
            {t('settings.webSearch.keys.remove')}
          </Button>
        </div>
      ) : status.kind === 'env' ? (
        <span className="typography-meta text-muted-foreground">
          {t('settings.webSearch.keys.fromEnv', { name: status.name })}
        </span>
      ) : (
        <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex items-center gap-2`}>
          <Input
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleSave();
            }}
            placeholder={t('settings.webSearch.keys.placeholder')}
            aria-label={t('settings.webSearch.keys.inputAria', { provider: provider.name })}
            className="h-8 min-w-0 flex-1 rounded-md px-3 font-mono text-xs"
          />
          <Button size="xs" disabled={busy || draft.trim().length === 0} onClick={() => void handleSave()}>
            {t('settings.webSearch.keys.save')}
          </Button>
        </div>
      )}
    </SettingsFieldRow>
  );
};

const KeysSection: React.FC<{ snapshot: WebSearchSnapshot }> = ({ snapshot }) => {
  const { t } = useI18n();
  const access = snapshot.access;
  const keyed = access
    ? snapshot.providers.flatMap((provider) => {
        const entry = access[provider.id];
        return entry && entry.key.kind !== 'unsupported' ? [{ provider, access: entry }] : [];
      })
    : [];
  if (access && keyed.length === 0) return null;

  return (
    <SettingsSection
      title={t('settings.webSearch.section.keys')}
      info={t('settings.webSearch.section.keysInfo')}
      settingsItem="web-search.keys"
    >
      <div className="space-y-4">
        {access === null ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.webSearch.state.keysUnavailable')}</p>
        ) : (
          keyed.map(({ provider, access: entry }) => (
            <ProviderKeyRow key={provider.id} provider={provider} access={entry} />
          ))
        )}
      </div>
    </SettingsSection>
  );
};

export const WebSearchPage: React.FC = () => {
  const { t } = useI18n();
  const state = useWebSearchStore((store) => store.state);
  const load = useWebSearchStore((store) => store.load);

  // Read on open, and again when the page is opened for another project or
  // runtime (the snapshot is scoped to both).
  const scope = getWebSearchScopeKey();
  React.useEffect(() => {
    void load();
  }, [load, scope]);

  const snapshot = state.kind === 'ready' && state.snapshot.scope === scope ? state.snapshot : null;

  return (
    <SettingsPageLayout
      title={t('settings.page.webSearch.title')}
      description={t('settings.page.webSearch.description')}
      showSaveStatus
    >
      {snapshot ? (
        <>
          <SelectionSection snapshot={snapshot} />
          <KeysSection snapshot={snapshot} />
        </>
      ) : state.kind === 'failed' ? (
        <SettingsSection divider={false}>
          <div className="flex flex-wrap items-center gap-3">
            <p className="typography-meta text-[var(--status-error)]">{t('settings.webSearch.state.loadFailed')}</p>
            <Button variant="outline" size="xs" onClick={() => void load()}>
              {t('settings.webSearch.actions.retry')}
            </Button>
          </div>
        </SettingsSection>
      ) : (
        <SettingsSection divider={false}>
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.webSearch.state.loading')}</p>
        </SettingsSection>
      )}
    </SettingsPageLayout>
  );
};
