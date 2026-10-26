import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type {
  WebSearchConnectAnswer,
  WebSearchConnectMethod,
  WebSearchProvider,
  WebSearchProviderAccess,
  WebSearchSelection,
} from '@/lib/opencode/websearch';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsBackButton,
  SettingsCard,
  SettingsCardIcon,
  SettingsCardPill,
  type SettingsCardAction,
} from '@/components/sections/shared/SettingsCards';
import {
  SettingsChipGroup,
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { getWebSearchScopeKey, useWebSearchStore, type WebSearchSnapshot } from '@/stores/useWebSearchStore';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

/**
 * Settings → Web search: which provider OpenCode's `websearch` tool uses, and
 * the API key (or, for a server the user runs, the address) each provider
 * takes. Both belong to OpenCode: the choice is the `websearch` key of its
 * config, the keys are integration credentials, so the page reads them from
 * OpenCode and writes them back.
 *
 * The page opens on the mode (default, any provider, off) and a card per
 * provider; a card opens the provider, where its key is added and it is
 * chosen for search. A plugin provider OpenCode offers only once connected
 * has a card too, so its key goes in where it is chosen.
 */

const sameSelection = (a: WebSearchSelection, b: WebSearchSelection): boolean =>
  a.kind === b.kind && (a.kind !== 'provider' || (b.kind === 'provider' && a.id === b.id));

/** One provider as the page shows it: offered for search, or waiting for its key. */
type ProviderEntry = {
  provider: WebSearchProvider;
  access: WebSearchProviderAccess | null;
  /** False for a plugin provider OpenCode offers only once connected. */
  usable: boolean;
};

const providerEntries = (snapshot: WebSearchSnapshot): ProviderEntry[] => [
  ...snapshot.providers.map((provider) => ({ provider, access: snapshot.access?.[provider.id] ?? null, usable: true })),
  ...snapshot.connectable.map((provider) => ({ provider, access: snapshot.access?.[provider.id] ?? null, usable: false })),
].sort((a, b) => a.provider.name.localeCompare(b.provider.name, undefined, { sensitivity: 'base' }));

const useChoose = (snapshot: WebSearchSnapshot) => {
  const { t } = useI18n();
  const setSelection = useWebSearchStore((store) => store.setSelection);
  // A project config's `websearch` wins over the file Settings writes, so a
  // choice here would snap back.
  const locked = snapshot.projectOverride !== null;
  const choose = (selection: WebSearchSelection) => {
    if (locked || sameSelection(selection, snapshot.selection)) return;
    void setSelection(selection).then((ok) => {
      if (!ok) toast.error(t('settings.webSearch.toast.saveFailed'));
    });
  };
  return { choose, locked };
};

type ModeValue = 'default' | 'random' | 'off' | 'provider';

const ModeSection: React.FC<{ snapshot: WebSearchSnapshot }> = ({ snapshot }) => {
  const { t } = useI18n();
  const { choose, locked } = useChoose(snapshot);
  const selected = snapshot.selection;
  const providerName = selected.kind === 'provider'
    ? snapshot.providers.find((provider) => provider.id === selected.id)?.name ?? null
    : null;

  const options: Array<{ value: ModeValue; label: string; disabled?: boolean }> = [
    { value: 'default', label: t('settings.webSearch.option.default'), disabled: locked },
    ...(snapshot.providers.length > 0
      ? [{ value: 'random' as const, label: t('settings.webSearch.option.random'), disabled: locked }]
      : []),
    { value: 'off', label: t('settings.webSearch.option.off'), disabled: locked },
  ];

  const status = selected.kind === 'default'
    ? t('settings.webSearch.option.defaultDescription')
    : selected.kind === 'random'
      ? t('settings.webSearch.option.randomDescription')
      : selected.kind === 'off'
        ? t('settings.webSearch.mode.offDescription')
        : providerName
          // A configured provider OpenCode no longer offers (plugin removed,
          // typo in the file) is named, so the user can see why search fails.
          ? t('settings.webSearch.mode.providerDescription', { provider: providerName })
          : t('settings.webSearch.mode.missingDescription', { provider: selected.id });

  return (
    <SettingsSection
      title={t('settings.webSearch.section.provider')}
      info={t('settings.webSearch.section.providerInfo')}
      divider={false}
      settingsItem="web-search.provider"
    >
      <div className="space-y-2">
        <SettingsChipGroup<ModeValue>
          aria-label={t('settings.webSearch.section.provider')}
          value={selected.kind}
          options={options}
          onChange={(value) => {
            if (value !== 'provider') choose({ kind: value });
          }}
        />
        <p className={SETTINGS_HELPER_CLASS}>{status}</p>
        {snapshot.projectOverride ? (
          <p className={`${SETTINGS_HELPER_CLASS} break-all`}>
            {t('settings.webSearch.state.projectOverride', { path: snapshot.projectOverride })}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
};

const ProviderCard: React.FC<{ entry: ProviderEntry; snapshot: WebSearchSnapshot; onOpen: () => void }> = ({ entry, snapshot, onOpen }) => {
  const { t } = useI18n();
  const { choose, locked } = useChoose(snapshot);
  const { provider, access, usable } = entry;
  const inUse = snapshot.selection.kind === 'provider' && snapshot.selection.id === provider.id;
  const key = access?.key;
  const takesKey = access?.connect?.kind === 'key';

  const pill = inUse
    ? <SettingsCardPill tone="success">{t('settings.webSearch.card.inUse')}</SettingsCardPill>
    : !usable && key?.kind === 'none'
      ? <SettingsCardPill tone="warning">{takesKey ? t('settings.webSearch.card.needsKey') : t('settings.webSearch.card.needsSetup')}</SettingsCardPill>
      : null;

  const footer = key?.kind === 'stored'
    ? (takesKey ? t('settings.webSearch.keys.saved') : t('settings.webSearch.keys.connected'))
    : key?.kind === 'env'
      ? t('settings.webSearch.keys.fromEnv', { name: key.name })
      : usable && key?.kind === 'none'
        ? t('settings.webSearch.card.keyOptional')
        : null;

  const actions: SettingsCardAction[] = usable && !inUse && !locked
    ? [{ label: t('settings.webSearch.actions.use'), icon: 'check', onSelect: () => choose({ kind: 'provider', id: provider.id }) }]
    : [];

  return (
    <SettingsCard
      // Search providers have no logos in the app; one mark keeps the grid even.
      icon={<SettingsCardIcon name="global" />}
      title={provider.name}
      badges={pill}
      footer={footer ? <span className="min-w-0 truncate">{footer}</span> : null}
      muted={!usable && key?.kind === 'none'}
      onOpen={onOpen}
      actions={actions}
      actionsLabel={t('settings.webSearch.card.actions', { provider: provider.name })}
    />
  );
};

const ProviderKeyRow: React.FC<{ provider: WebSearchProvider; access: WebSearchProviderAccess; connect: WebSearchConnectMethod; locked: boolean }> = ({ provider, access, connect, locked }) => {
  const { t } = useI18n();
  const saveKey = useWebSearchStore((store) => store.saveKey);
  const removeKey = useWebSearchStore((store) => store.removeKey);
  const [draft, setDraft] = React.useState('');
  const [answer, setAnswer] = React.useState<WebSearchConnectAnswer>({});
  const [busy, setBusy] = React.useState(false);
  const takesKey = connect.kind === 'key';
  const names = access.envNames.join(', ');
  // Field explanations and examples live behind the info icon: a URL example
  // does not fit in the field, so the field shows only its label.
  const hintLines = [
    ...connect.fields.flatMap((field) => [
      field.description,
      field.placeholder ? t('settings.webSearch.keys.fieldExample', { example: field.placeholder }) : null,
    ]),
    access.envNames.length === 0
      ? null
      : takesKey ? t('settings.webSearch.keys.envHint', { names }) : t('settings.webSearch.keys.envHintForm', { names }),
  ].filter((line): line is string => Boolean(line));
  const info = hintLines.length > 0
    ? hintLines.map((line) => <span key={line} className="block">{line}</span>)
    : undefined;
  const filledAnswer = Object.fromEntries(
    Object.entries(answer).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value !== ''),
  );
  const complete = (!takesKey || draft.trim() !== '') && connect.fields.every((field) => !field.required || filledAnswer[field.key] !== undefined);

  const handleSave = async () => {
    if (!complete) return;
    setBusy(true);
    const ok = await saveKey(provider.id, { key: draft.trim(), answer: filledAnswer });
    setBusy(false);
    if (ok) {
      setDraft('');
      setAnswer({});
      toast.success(takesKey
        ? t('settings.webSearch.toast.keySaved', { provider: provider.name })
        : t('settings.webSearch.toast.connected', { provider: provider.name }));
    } else {
      toast.error(takesKey ? t('settings.webSearch.toast.keySaveFailed') : t('settings.webSearch.toast.connectFailed', { provider: provider.name }));
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    const ok = await removeKey(provider.id);
    setBusy(false);
    if (!ok) toast.error(t('settings.webSearch.toast.keyRemoveFailed'));
  };

  const submitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') void handleSave();
  };
  const inputClassName = 'h-8 min-w-0 flex-1 rounded-md px-3 font-mono text-xs';
  const inputs: React.ReactNode[] = connect.fields.map((field) => (
    <Input
      key={field.key}
      type={field.url ? 'url' : 'text'}
      value={answer[field.key] ?? ''}
      onChange={(event) => setAnswer((current) => ({ ...current, [field.key]: event.target.value }))}
      onKeyDown={submitOnEnter}
      placeholder={field.label}
      aria-label={t('settings.webSearch.keys.fieldAria', { provider: provider.name, field: field.label })}
      className={inputClassName}
    />
  ));
  if (takesKey) {
    inputs.push(
      <Input
        key="key"
        type="password"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={submitOnEnter}
        placeholder={t('settings.webSearch.keys.placeholder')}
        aria-label={t('settings.webSearch.keys.inputAria', { provider: provider.name })}
        className={inputClassName}
      />,
    );
  }
  const saveButton = (
    <Button size="xs" disabled={busy || !complete} onClick={() => void handleSave()}>
      {t('settings.webSearch.keys.save')}
    </Button>
  );

  const status = access.key;
  const rowLabel = takesKey
    ? t('settings.webSearch.keys.label')
    : connect.fields.length === 1 && connect.fields[0] ? connect.fields[0].label : t('settings.webSearch.keys.connectionLabel');
  return (
    <SettingsFieldRow label={rowLabel} info={info}>
      {status.kind === 'stored' ? (
        <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex items-center justify-end gap-2`}>
          <span className="typography-meta text-muted-foreground">
            {takesKey ? t('settings.webSearch.keys.saved') : t('settings.webSearch.keys.connected')}
          </span>
          <Button variant="outline" size="xs" disabled={busy} onClick={() => void handleRemove()}>
            {t('settings.webSearch.keys.remove')}
          </Button>
        </div>
      ) : status.kind === 'env' ? (
        <span className="typography-meta text-muted-foreground">
          {t('settings.webSearch.keys.fromEnv', { name: status.name })}
        </span>
      ) : locked ? null : inputs.length === 1 ? (
        <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex items-center gap-2`}>
          {inputs}
          {saveButton}
        </div>
      ) : (
        // Several fields stack, with Save after the last one.
        <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex flex-col gap-2`}>
          {inputs.slice(0, -1).map((input, index) => (
            <div key={index} className="flex">{input}</div>
          ))}
          <div className="flex items-center gap-2">
            {inputs.at(-1)}
            {saveButton}
          </div>
        </div>
      )}
    </SettingsFieldRow>
  );
};

const ProviderDetail: React.FC<{ entry: ProviderEntry; snapshot: WebSearchSnapshot; onBack: () => void }> = ({ entry, snapshot, onBack }) => {
  const { t } = useI18n();
  const { choose, locked } = useChoose(snapshot);
  // Enterprise mode: the server refuses new keys (they connect through the
  // same OpenCode route as model providers); saved ones can still be removed.
  const keysLocked = useEnterpriseMode();
  const { provider, access, usable } = entry;
  const inUse = snapshot.selection.kind === 'provider' && snapshot.selection.id === provider.id;
  const connect = access?.connect ?? null;

  const useLine = inUse
    ? t('settings.webSearch.mode.providerDescription', { provider: provider.name })
    : usable
      ? null
      : connect?.kind === 'form'
        ? t('settings.webSearch.detail.needsSetup', { provider: provider.name })
        : t('settings.webSearch.detail.needsKey', { provider: provider.name });

  return (
    <SettingsPageLayout
      title={provider.name}
      titleLeading={<SettingsBackButton label={t('settings.webSearch.detail.back')} onClick={onBack} />}
      showSaveStatus
    >
      <SettingsSection divider={false}>
        <div className="space-y-2">
          {useLine ? <p className="typography-meta text-foreground">{useLine}</p> : null}
          {usable && !inUse ? (
            <Button size="sm" disabled={locked} onClick={() => choose({ kind: 'provider', id: provider.id })}>
              {t('settings.webSearch.actions.use')}
            </Button>
          ) : null}
          {snapshot.projectOverride ? (
            <p className={`${SETTINGS_HELPER_CLASS} break-all`}>
              {t('settings.webSearch.state.projectOverride', { path: snapshot.projectOverride })}
            </p>
          ) : null}
        </div>
      </SettingsSection>
      <SettingsSection>
        <div className="space-y-4">
          {keysLocked ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.webSearch.keys.enterpriseMode')}</p> : null}
          {access === null ? (
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.webSearch.state.keysUnavailable')}</p>
          ) : connect ? (
            <ProviderKeyRow provider={provider} access={access} connect={connect} locked={keysLocked} />
          ) : (
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.webSearch.detail.noKey')}</p>
          )}
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
};

export const WebSearchPage: React.FC = () => {
  const { t } = useI18n();
  const state = useWebSearchStore((store) => store.state);
  const load = useWebSearchStore((store) => store.load);
  const [openId, setOpenId] = React.useState<string | null>(null);

  // Read on open, and again when the page is opened for another project or
  // runtime (the snapshot is scoped to both).
  const scope = getWebSearchScopeKey();
  React.useEffect(() => {
    void load();
  }, [load, scope]);

  const snapshot = state.kind === 'ready' && state.snapshot.scope === scope ? state.snapshot : null;
  const entries = snapshot ? providerEntries(snapshot) : [];
  // A provider that went away (plugin removed) closes its screen.
  const open = openId ? entries.find((entry) => entry.provider.id === openId) ?? null : null;

  if (snapshot && open) {
    return <ProviderDetail entry={open} snapshot={snapshot} onBack={() => setOpenId(null)} />;
  }

  return (
    <SettingsPageLayout
      title={t('settings.page.webSearch.title')}
      description={t('settings.page.webSearch.description')}
      showSaveStatus
    >
      {snapshot ? (
        <>
          <ModeSection snapshot={snapshot} />
          <SettingsSection
            title={t('settings.webSearch.section.providers')}
            info={t('settings.webSearch.section.providersInfo')}
            settingsItem="web-search.providers"
          >
            {entries.length === 0 ? (
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.webSearch.state.noProviders')}</p>
            ) : (
              <div className={SETTINGS_CARD_GRID_CLASS}>
                {entries.map((entry) => (
                  <ProviderCard key={entry.provider.id} entry={entry} snapshot={snapshot} onOpen={() => setOpenId(entry.provider.id)} />
                ))}
              </div>
            )}
            {snapshot.access === null ? (
              <p className={`${SETTINGS_HELPER_CLASS} mt-3`}>{t('settings.webSearch.state.keysUnavailable')}</p>
            ) : null}
          </SettingsSection>
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
