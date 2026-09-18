import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import {
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
} from '@/components/sections/shared/SettingsSection';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { RoutingCategory, RoutingConfig } from '@/lib/routing/routingApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { useRoutingStore } from '@/stores/useRoutingStore';

const DEFAULT_VARIANT_VALUE = '__default__';
const SAVE_DEBOUNCE_MS = 500;


const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

/** The thinking levels OpenCode reports for one model; empty when the model has none. */
const useModelVariants = (providerID: string | null | undefined, modelID: string | null | undefined): string[] => {
  const providers = useConfigStore((state) => state.providers);
  return React.useMemo(() => {
    if (!providerID || !modelID) return [];
    const provider = providers.find((entry) => entry.id === providerID);
    const model = provider?.models.find((entry) => entry.id === modelID);
    return model?.variants ? Object.keys(model.variants) : [];
  }, [modelID, providerID, providers]);
};

const VariantSelect: React.FC<{
  providerID: string | null | undefined;
  modelID: string | null | undefined;
  value: string | null;
  onChange: (variant: string | null) => void;
  ariaLabel: string;
  className?: string;
}> = ({ providerID, modelID, value, onChange, ariaLabel, className }) => {
  const { t } = useI18n();
  const variants = useModelVariants(providerID, modelID);
  const label = (variant: string) => (variant === DEFAULT_VARIANT_VALUE
    ? t('settings.routing.thinking.default')
    : variant.charAt(0).toUpperCase() + variant.slice(1));
  return (
    <Select value={value ?? DEFAULT_VARIANT_VALUE} onValueChange={(next) => onChange(next === DEFAULT_VARIANT_VALUE ? null : next)} disabled={variants.length === 0}>
      <SelectTrigger size={SETTINGS_SELECT_SIZE} className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, className)} aria-label={ariaLabel}>
        <SelectValue>{label(value ?? DEFAULT_VARIANT_VALUE)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_VARIANT_VALUE}>{label(DEFAULT_VARIANT_VALUE)}</SelectItem>
        {variants.map((variant) => (
          <SelectItem key={variant} value={variant}>{label(variant)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};


/** One category: a summary row that expands into its editor. */
const CategoryRow: React.FC<{
  category: RoutingCategory;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<RoutingCategory>) => void;
  onReset: (() => void) | null;
  onRemove: () => void;
}> = ({ category, expanded, onToggle, onChange, onReset, onRemove }) => {
  const { t } = useI18n();
  const modelLabel = category.model
    ? `${category.model.modelID}${category.variant ? ` / ${category.variant}` : ''}`
    : t('settings.routing.model.useFallback');
  const summary = [modelLabel, category.agent].filter(Boolean).join(' · ');
  return (
    <div className={cn('py-1', !category.enabled && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-4 flex-shrink-0 text-muted-foreground" />
          <span className="typography-ui-label font-medium text-foreground truncate">{category.name || category.id}</span>
          <span className="typography-meta text-muted-foreground truncate">{summary}</span>
        </button>
        <Switch
          checked={category.enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked })}
          aria-label={t('settings.routing.category.enabledAria', { name: category.name })}
        />
      </div>
      {expanded ? (
        <div className="space-y-4 px-1 pb-4 pt-2">
          <SettingsTwoColumn>
            <SettingsStackedField label={t('settings.routing.category.name')} controlClassName="max-w-none">
              <Input
                value={category.name}
                onChange={(event) => onChange({ name: event.target.value })}
                aria-label={t('settings.routing.category.name')}
                className="h-8 w-full rounded-md px-3"
                maxLength={60}
              />
            </SettingsStackedField>
            <SettingsStackedField label={t('settings.routing.category.agent')} info={t('settings.routing.category.agentInfo')} controlClassName="max-w-none">
              <AgentSelector
                agentName={category.agent ?? ''}
                onChange={(agentName) => onChange({ agent: agentName || null })}
                filter={(agent) => isPrimaryMode(agent.mode)}
                className={cn(SETTINGS_CUSTOM_TRIGGER_CLASS, 'w-full')}
              />
            </SettingsStackedField>
            <SettingsStackedField label={t('settings.routing.category.model')} info={t('settings.routing.category.modelInfo')} controlClassName="max-w-none">
              <ModelSelector
                providerId={category.model?.providerID ?? ''}
                modelId={category.model?.modelID ?? ''}
                onChange={(providerID, modelID) => onChange({ model: { providerID, modelID }, variant: null })}
                className={cn(SETTINGS_CUSTOM_TRIGGER_CLASS, 'w-full')}
                placeholder={t('settings.routing.model.useFallback')}
              />
            </SettingsStackedField>
            <SettingsStackedField label={t('settings.routing.category.thinking')} controlClassName="max-w-none">
              <VariantSelect
                providerID={category.model?.providerID}
                modelID={category.model?.modelID}
                value={category.variant}
                onChange={(variant) => onChange({ variant })}
                ariaLabel={t('settings.routing.category.thinking')}
                className="w-full"
              />
            </SettingsStackedField>
          </SettingsTwoColumn>
          <SettingsStackedField
            label={t('settings.routing.category.description')}
            info={t('settings.routing.category.descriptionInfo')}
            controlClassName="max-w-none"
          >
            <Textarea
              value={category.description}
              onChange={(event) => onChange({ description: event.target.value })}
              aria-label={t('settings.routing.category.description')}
              rows={5}
              maxLength={2000}
              className="w-full"
            />
          </SettingsStackedField>
          <div className="flex flex-wrap items-center gap-2">
            {onReset ? (
              <Button size="sm" variant="outline" onClick={onReset}>{t('settings.routing.category.reset')}</Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onRemove}>{t('settings.routing.category.remove')}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const RoutingPage: React.FC = () => {
  const { t } = useI18n();
  const available = useRoutingStore((state) => state.available);
  const autoReady = useRoutingStore((state) => state.autoReady);
  const tokenPresent = useRoutingStore((state) => state.tokenPresent);
  const serverConfig = useRoutingStore((state) => state.config);
  const builtins = useRoutingStore((state) => state.builtins);
  const loaded = useRoutingStore((state) => state.loaded);
  const loadError = useRoutingStore((state) => state.loadError);
  const load = useRoutingStore((state) => state.load);
  const saveConfig = useRoutingStore((state) => state.saveConfig);
  const setToken = useRoutingStore((state) => state.setToken);
  const clearToken = useRoutingStore((state) => state.clearToken);

  const [draft, setDraft] = React.useState<RoutingConfig | null>(serverConfig);
  const [tokenInput, setTokenInput] = React.useState('');
  const [tokenBusy, setTokenBusy] = React.useState(false);
  const [tokenError, setTokenError] = React.useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = React.useState('');
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  // A pending edit remembers the server it was made against; a save that would
  // run after a runtime switch is dropped rather than sent to the new server.
  const pendingRef = React.useRef<{ config: RoutingConfig; runtimeKey: string } | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Saves run one after another, and the server's copy is adopted only while
  // nothing is pending or in flight, so an older response cannot replace a
  // newer draft.
  const saveChainRef = React.useRef<Promise<void>>(Promise.resolve());
  const savesInFlightRef = React.useRef(0);

  React.useEffect(() => {
    void load();
  }, [load]);

  // The server is authoritative; adopt its config whenever nothing is mid-edit.
  React.useEffect(() => {
    if (!pendingRef.current && savesInFlightRef.current === 0) setDraft(serverConfig);
  }, [serverConfig]);

  const flush = React.useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return saveChainRef.current;
    pendingRef.current = null;
    if (pending.runtimeKey !== getRuntimeKey()) return saveChainRef.current;
    savesInFlightRef.current += 1;
    reportSettingsSaveState('saving');
    const run = saveChainRef.current.then(async () => {
      try {
        if (pending.runtimeKey !== getRuntimeKey()) {
          reportSettingsSaveState('saved');
          return;
        }
        await saveConfig(pending.config);
        reportSettingsSaveState('saved');
      } catch {
        reportSettingsSaveState('error');
      } finally {
        savesInFlightRef.current -= 1;
      }
    });
    saveChainRef.current = run;
    return run;
  }, [saveConfig]);

  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void flush();
  }, [flush]);

  // A first visit starts from the session defaults: the model the user already
  // chose for new sessions is the natural fallback, and it saves a required step.
  const settingsDefaultModel = useConfigStore((state) => state.settingsDefaultModel);
  const settingsDefaultVariant = useConfigStore((state) => state.settingsDefaultVariant);
  const prefilledRef = React.useRef(false);
  React.useEffect(() => {
    if (prefilledRef.current || !loaded || !serverConfig || serverConfig.fallback) return;
    const parsed = parseModelIdentifier(settingsDefaultModel);
    if (!parsed) return;
    prefilledRef.current = true;
    update((config) => (config.fallback ? config : {
      ...config,
      fallback: { model: { providerID: parsed.providerId, modelID: parsed.modelId }, variant: settingsDefaultVariant ?? null },
    }));
  // `update` is stable; the effect keys on what decides whether to prefill.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, serverConfig, settingsDefaultModel, settingsDefaultVariant]);

  const update = React.useCallback((mutate: (config: RoutingConfig) => RoutingConfig) => {
    setDraft((current) => {
      if (!current) return current;
      const next = mutate(current);
      pendingRef.current = { config: next, runtimeKey: getRuntimeKey() };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { timerRef.current = null; void flush(); }, SAVE_DEBOUNCE_MS);
      return next;
    });
  }, [flush]);

  const updateCategory = React.useCallback((id: string, patch: Partial<RoutingCategory>) => {
    update((config) => ({ ...config, categories: config.categories.map((category) => (category.id === id ? { ...category, ...patch } : category)) }));
  }, [update]);

  const handleSaveToken = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      await setToken(token);
      setTokenInput('');
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : String(error));
    } finally {
      setTokenBusy(false);
    }
  };

  const handleClearToken = async () => {
    setTokenBusy(true);
    setTokenError(null);
    try {
      await clearToken();
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : String(error));
    } finally {
      setTokenBusy(false);
    }
  };

  const addCategory = () => {
    const name = newCategoryName.trim();
    if (!name || !draft) return;
    const base = slugify(name) || `category-${Date.now()}`;
    let id = base;
    let counter = 2;
    while (draft.categories.some((category) => category.id === id)) id = `${base}-${counter++}`;
    update((config) => ({
      ...config,
      categories: [...config.categories, { id, builtin: false, enabled: true, name, description: '', model: null, variant: null, agent: null }],
    }));
    setNewCategoryName('');
    setExpandedId(id);
  };

  const resetCategory = (id: string) => {
    const builtin = builtins.find((entry) => entry.id === id);
    if (!builtin) return;
    updateCategory(id, { name: builtin.name, description: builtin.description, model: null, variant: null, agent: null, enabled: true });
  };

  const restoreCategory = (id: string) => {
    const builtin = builtins.find((entry) => entry.id === id);
    if (!builtin) return;
    update((config) => ({
      ...config,
      categories: [...config.categories, { id, builtin: true, enabled: true, name: builtin.name, description: builtin.description, model: null, variant: null, agent: null }],
    }));
  };

  const removeCategory = (id: string) => {
    update((config) => ({ ...config, categories: config.categories.filter((category) => category.id !== id) }));
  };

  const enabledCount = draft?.categories.filter((category) => category.enabled).length ?? 0;
  const removedBuiltins = builtins.filter((builtin) => !draft?.categories.some((category) => category.id === builtin.id));

  const readinessText = !tokenPresent
    ? t('settings.routing.status.noToken')
    : !draft?.enabled
      ? t('settings.routing.status.disabled')
      : !draft.fallback
        ? t('settings.routing.status.noFallback')
        : enabledCount < 2
          ? t('settings.routing.status.tooFewCategories')
          : autoReady
            ? t('settings.routing.status.ready')
            : t('settings.routing.status.notReady');

  return (
    <SettingsPageLayout
      title={t('settings.page.routing.title')}
      description={t('settings.page.routing.description')}
      showSaveStatus
    >
      {loadError ? <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.routing.loadError', { error: loadError })}</p> : null}
      {!loaded || !draft ? null : !available ? (
        <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.routing.unavailable')}</p>
      ) : (
        <>
          <SettingsSection title={t('settings.routing.token.title')} divider={false}>
            <div className={SETTINGS_FIELDS_STACK_CLASS}>
              <p className={SETTINGS_HELPER_CLASS}>
                {tokenPresent ? t('settings.routing.token.present') : t('settings.routing.token.missing')}
              </p>
              <SettingsFieldRow
                settingsItem="routing.token"
                label={t('settings.routing.token.label')}
                info={t('settings.routing.token.info')}
              >
                <div className="flex w-full min-w-0 items-center gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={tokenInput}
                    onChange={(event) => setTokenInput(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') void handleSaveToken(); }}
                    placeholder={tokenPresent ? t('settings.routing.token.replacePlaceholder') : t('settings.routing.token.placeholder')}
                    aria-label={t('settings.routing.token.label')}
                    className="h-8 rounded-md px-3 min-w-0 flex-1"
                    disabled={tokenBusy}
                  />
                  <Button size="sm" variant="outline" onClick={() => void handleSaveToken()} disabled={tokenBusy || tokenInput.trim().length === 0}>
                    {t('settings.routing.token.save')}
                  </Button>
                  {tokenPresent ? (
                    <Button size="sm" variant="ghost" onClick={() => void handleClearToken()} disabled={tokenBusy}>
                      {t('settings.routing.token.remove')}
                    </Button>
                  ) : null}
                </div>
              </SettingsFieldRow>
              {tokenError ? <p className={SETTINGS_DESCRIPTION_CLASS}>{tokenError}</p> : null}
            </div>
          </SettingsSection>

          <SettingsSection title={t('settings.routing.auto.title')}>
            <div className={SETTINGS_FIELDS_STACK_CLASS}>
              <div className={SETTINGS_OPTION_STACK_CLASS}>
                <SettingsCheckboxRow
                  settingsItem="routing.enabled"
                  checked={draft.enabled}
                  onChange={(checked) => update((config) => ({ ...config, enabled: checked }))}
                  label={t('settings.routing.auto.enable')}
                  ariaLabel={t('settings.routing.auto.enable')}
                  info={t('settings.routing.auto.enableInfo')}
                />
              </div>
              <p className={SETTINGS_HELPER_CLASS}>{readinessText}</p>
              <SettingsFieldRow
                settingsItem="routing.fallback-model"
                label={t('settings.routing.auto.fallbackModel')}
                info={t('settings.routing.auto.fallbackModelInfo')}
              >
                <ModelSelector
                  providerId={draft.fallback?.model.providerID ?? ''}
                  modelId={draft.fallback?.model.modelID ?? ''}
                  onChange={(providerID, modelID) => update((config) => ({ ...config, fallback: { model: { providerID, modelID }, variant: null } }))}
                  className={SETTINGS_CUSTOM_TRIGGER_CLASS}
                  placeholder={t('settings.routing.model.placeholder')}
                />
              </SettingsFieldRow>
              <SettingsFieldRow
                settingsItem="routing.fallback-thinking"
                label={t('settings.routing.auto.fallbackThinking')}
                info={t('settings.routing.auto.fallbackThinkingInfo')}
              >
                <VariantSelect
                  providerID={draft.fallback?.model.providerID}
                  modelID={draft.fallback?.model.modelID}
                  value={draft.fallback?.variant ?? null}
                  onChange={(variant) => update((config) => (config.fallback ? { ...config, fallback: { ...config.fallback, variant } } : config))}
                  ariaLabel={t('settings.routing.auto.fallbackThinking')}
                />
              </SettingsFieldRow>
            </div>
          </SettingsSection>

          <SettingsSection title={t('settings.routing.categories.title')}>
            <div className={SETTINGS_FIELDS_STACK_CLASS}>
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.routing.categories.description')}</p>
              <div className="divide-y divide-border/40 border-y border-border/40">
                {draft.categories.map((category) => (
                  <CategoryRow
                    key={category.id}
                    category={category}
                    expanded={expandedId === category.id}
                    onToggle={() => setExpandedId((current) => (current === category.id ? null : category.id))}
                    onChange={(patch) => updateCategory(category.id, patch)}
                    onReset={category.builtin ? () => resetCategory(category.id) : null}
                    onRemove={() => removeCategory(category.id)}
                  />
                ))}
              </div>
              {removedBuiltins.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  {removedBuiltins.map((builtin) => (
                    <Button key={builtin.id} size="sm" variant="outline" onClick={() => restoreCategory(builtin.id)}>
                      {t('settings.routing.category.restore', { name: builtin.name })}
                    </Button>
                  ))}
                </div>
              ) : null}
              <SettingsFieldRow label={t('settings.routing.categories.addLabel')} settingsItem="routing.add-category">
                <div className="flex w-full min-w-0 items-center gap-2">
                  <Input
                    value={newCategoryName}
                    onChange={(event) => setNewCategoryName(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') addCategory(); }}
                    placeholder={t('settings.routing.categories.addPlaceholder')}
                    aria-label={t('settings.routing.categories.addLabel')}
                    className="h-8 rounded-md px-3 min-w-0 flex-1"
                    maxLength={60}
                  />
                  <Button size="sm" variant="outline" onClick={addCategory} disabled={newCategoryName.trim().length === 0}>
                    {t('settings.routing.categories.add')}
                  </Button>
                </div>
              </SettingsFieldRow>
            </div>
          </SettingsSection>
          <SettingsSection title={t('settings.routing.safety.title')}>
            <div className={SETTINGS_FIELDS_STACK_CLASS}>
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.routing.safety.description')}</p>
              <div className={SETTINGS_OPTION_STACK_CLASS}>
                <SettingsCheckboxRow
                  settingsItem="routing.safety-enabled"
                  checked={draft.safetyNet.enabled}
                  onChange={(checked) => update((config) => ({ ...config, safetyNet: { ...config.safetyNet, enabled: checked } }))}
                  label={t('settings.routing.safety.enable')}
                  ariaLabel={t('settings.routing.safety.enable')}
                  info={t('settings.routing.safety.enableInfo')}
                />
              </div>
            </div>
          </SettingsSection>

        </>
      )}
    </SettingsPageLayout>
  );
};
