import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { selectAgentsForDirectory, useAgentsStore, type AgentConfig, type AgentEntity, type AgentEntityEnvelope, type AgentMutationResult, type AgentRequest, type AgentRequestBody, type AgentScope, type AgentWithExtras } from '@/stores/useAgentsStore';
import { useShallow } from 'zustand/react/shallow';
import { ModelSelector } from './ModelSelector';
import { useI18n } from '@/lib/i18n';
import { formatModelSelection, parseModelIdentifier, parseModelSelection } from '@/lib/modelIdentifier';
import { useConfigStore } from '@/stores/useConfigStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  useAutosave,
  AUTOSAVE_SAVED,
  AUTOSAVE_UNCHANGED,
  autosaveFailed,
  type AutosaveResult,
} from '@/components/sections/shared/SettingsAutosave';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsStackedField,
  SettingsChipGroup,
  SETTINGS_SELECT_SIZE,
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { AgentPermissionsEditor } from './AgentPermissionsEditor';
import { SettingsLegacyFormatNote } from '@/components/sections/shared/SettingsLegacyFormatNote';

type AgentVariantProvider = {
  id: string;
  models: Array<{ modelID: string; variants: Array<{ id: string }> }>;
};

const getVariantOptionsForModel = (
  providers: AgentVariantProvider[],
  modelValue: string,
): string[] => {
  const parsedModel = parseModelIdentifier(modelValue);
  if (!parsedModel) {
    return [];
  }

  const provider = providers.find((item) => item.id === parsedModel.providerId);
  const model = provider?.models.find((item) => item.modelID === parsedModel.modelId);
  return model?.variants.map((variant) => variant.id) ?? [];
};
/** Everything the page writes into the agent's config file. */
interface FormState {
  draftName: string;
  draftScope: AgentScope;
  description: string;
  mode: 'primary' | 'subagent' | 'all';
  model: string;
  variant: string;
  steps: number | undefined;
  temperature: number | undefined;
  topP: number | undefined;
  system: string;
}

export const AgentsPage: React.FC = () => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers) as AgentVariantProvider[];
  const {
    selectedAgentName,
    getAgentByName,
    createAgent,
    updateAgent,
    fetchAgentEntity,
    agentDraft,
    setAgentDraft,
    setSelectedAgent,
  } = useAgentsStore(useShallow((s) => ({
    selectedAgentName: s.selectedAgentName,
    getAgentByName: s.getAgentByName,
    createAgent: s.createAgent,
    updateAgent: s.updateAgent,
    fetchAgentEntity: s.fetchAgentEntity,
    agentDraft: s.agentDraft,
    setAgentDraft: s.setAgentDraft,
    setSelectedAgent: s.setSelectedAgent,
  })));

  // Settings browses whichever project its own selector points at; the app
  // stays where it is.
  const settingsDirectory = useSettingsDirectory();
  const agents = useAgentsStore((state) => selectAgentsForDirectory(state, settingsDirectory));
  // SAFETY: the agents store attaches scope, group, path and legacy to every
  // entry it loads (`AgentWithExtras`); the editable fields are read from the
  // stored entry, not from the resolved `AgentInfo`.
  const selectedAgent = (selectedAgentName ? getAgentByName(selectedAgentName, settingsDirectory) : null) as AgentWithExtras | null;
  const isNewAgent = Boolean(agentDraft && agentDraft.name === selectedAgentName && !selectedAgent);
  // The resolved runtime values (built-in defaults, plugin-injected agents) are
  // shown only as placeholder hints; the form state stays the stored entry, so
  // a save never writes them back.
  const runtimeDescription = isNewAgent ? '' : selectedAgent?.description?.trim() ?? '';
  const runtimeSystem = isNewAgent ? '' : selectedAgent?.system?.trim() ?? '';

  const [draftName, setDraftName] = React.useState('');
  const [draftScope, setDraftScope] = React.useState<AgentScope>('user');
  const [description, setDescription] = React.useState('');
  const [mode, setMode] = React.useState<'primary' | 'subagent' | 'all'>('subagent');
  const [model, setModel] = React.useState('');
  const [variant, setVariant] = React.useState('');
  const [steps, setSteps] = React.useState<number | undefined>(undefined);
  const [temperature, setTemperature] = React.useState<number | undefined>(undefined);
  const [topP, setTopP] = React.useState<number | undefined>(undefined);
  const [system, setSystem] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);
  const [storedAt, setStoredAt] = React.useState<{ legacy: boolean; path: string | null; source: AgentEntityEnvelope['source'] } | null>(null);

  /**
   * The agent's stored entry. A save rewrites `request` wholesale, so the
   * headers and body keys this form does not expose are carried over from here
   * instead of being dropped.
   */
  const entityRef = React.useRef<AgentEntity>({});

  /**
   * The permissions section's save routine. It writes its own request, but the
   * page owns the indicator, so the page's save runs it too and reports one
   * outcome for both.
   */
  const permissionsSaveRef = React.useRef<(() => Promise<AutosaveResult>) | null>(null);
  const registerPermissionsSave = React.useCallback(
    (routine: (() => Promise<AutosaveResult>) | null) => {
      permissionsSaveRef.current = routine;
    },
    [],
  );

  // What the agent's config file currently holds. A save writes only when the
  // form differs from it, and an incoming refresh only repopulates the form
  // when the stored value moved away from it.
  const savedRef = React.useRef<FormState | null>(null);
  const selectionKey = JSON.stringify([selectedAgentName, settingsDirectory, isNewAgent]);
  const selectionRef = React.useRef(selectionKey);
  selectionRef.current = selectionKey;
  const hydratedSelectionRef = React.useRef<string | null>(null);
  const currentFields = { description, mode, model, variant, steps, temperature, topP, system };
  const currentFieldsRef = React.useRef(currentFields);
  currentFieldsRef.current = currentFields;

  const variantOptions = React.useMemo(() => getVariantOptionsForModel(providers, model), [model, providers]);
  const hasVariantOptions = variantOptions.length > 0;
  const selectedVariantValue = variant || '__default';
  const shouldUseVariantSelect = hasVariantOptions;
  const variantSelectOptions = React.useMemo(() => (
    variant && !variantOptions.includes(variant) ? [variant, ...variantOptions] : variantOptions
  ), [variant, variantOptions]);

  React.useEffect(() => {
    if (!isNewAgent || !agentDraft) return;
    hydratedSelectionRef.current = null;
    const parsedModel = parseModelSelection(agentDraft.model);
    const draftNameValue = agentDraft.name || '';
    const draftScopeValue = agentDraft.scope || 'user';
    const descriptionValue = agentDraft.description || '';
    const modeValue = agentDraft.mode || 'subagent';
    const modelValue = parsedModel ? `${parsedModel.providerID}/${parsedModel.modelID}` : '';
    const variantValue = parsedModel?.variant || '';
    const stepsValue = agentDraft.steps ?? undefined;
    const temperatureValue = agentDraft.temperature ?? undefined;
    const topPValue = agentDraft.top_p ?? undefined;
    const systemValue = agentDraft.system || '';

    entityRef.current = {};
    setStoredAt(null);
    setDraftName(draftNameValue);
    setDraftScope(draftScopeValue);
    setDescription(descriptionValue);
    setMode(modeValue);
    setModel(modelValue);
    setVariant(variantValue);
    setSteps(stepsValue);
    setTemperature(temperatureValue);
    setTopP(topPValue);
    setSystem(systemValue);

    savedRef.current = {
      draftName: draftNameValue,
      draftScope: draftScopeValue,
      description: descriptionValue,
      mode: modeValue,
      model: modelValue,
      variant: variantValue,
      steps: stepsValue,
      temperature: temperatureValue,
      topP: topPValue,
      system: systemValue,
    };
  }, [agentDraft, isNewAgent]);

  // An existing agent is edited from its OWN stored entry, not from the
  // resolved `AgentInfo`: the resolved view already merges built-in defaults
  // and global config, and writing that back would bake them into the file.
  React.useEffect(() => {
    if (isNewAgent || !selectedAgentName) return;
    let cancelled = false;
    void (async () => {
      const envelope = await fetchAgentEntity(selectedAgentName, settingsDirectory);
      if (cancelled || selectionRef.current !== selectionKey || !envelope) return;
      const entity = envelope.config;
      entityRef.current = entity;
      const parsedModel = parseModelSelection(entity.model);
      const body = entity.request?.body;
      const next: FormState = {
        draftName: '',
        draftScope: 'user',
        description: entity.description || '',
        // A stored override often omits `mode` (built-in build/plan); fall back
        // to the resolved mode so an unrelated edit never writes `subagent`.
        mode: entity.mode || selectedAgent?.mode || 'subagent',
        model: parsedModel ? `${parsedModel.providerID}/${parsedModel.modelID}` : '',
        variant: parsedModel?.variant || '',
        steps: entity.steps ?? undefined,
        temperature: body?.temperature,
        topP: body?.top_p,
        system: entity.system || '',
      };

      const saved = savedRef.current;
      const current = currentFieldsRef.current;
      const dirty = saved !== null && (
        current.description !== saved.description || current.mode !== saved.mode ||
        current.model !== saved.model || current.variant !== saved.variant ||
        current.steps !== saved.steps || current.temperature !== saved.temperature ||
        current.topP !== saved.topP || current.system !== saved.system
      );
      setStoredAt({ legacy: envelope.legacy === true, path: envelope.path, source: envelope.source });
      // A refresh can publish an older write while the next draft is still being edited.
      if (hydratedSelectionRef.current === selectionKey && dirty) return;
      hydratedSelectionRef.current = selectionKey;

      setDescription(next.description);
      setMode(next.mode);
      setModel(next.model);
      setVariant(next.variant);
      setSteps(next.steps);
      setTemperature(next.temperature);
      setTopP(next.topP);
      setSystem(next.system);
      savedRef.current = next;
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchAgentEntity, isNewAgent, selectedAgent, selectedAgentName, settingsDirectory, selectionKey]);

  const buildConfig = React.useCallback((agentName: string): AgentConfig => {
    const parsedModel = parseModelIdentifier(model.trim());
    const joinedModel = parsedModel
      ? formatModelSelection({
          providerID: parsedModel.providerId,
          modelID: parsedModel.modelId,
          variant: variant.trim() || undefined,
        })
      : null;

    // `request` is replaced as a whole on write, so the headers and any body
    // keys this form does not own are carried over from the stored entry.
    const storedRequest = entityRef.current.request;
    const body: AgentRequestBody = { ...storedRequest?.body };
    if (temperature === undefined) delete body.temperature;
    else body.temperature = temperature;
    if (topP === undefined) delete body.top_p;
    else body.top_p = topP;

    const headers = storedRequest?.headers;
    const request: AgentRequest = {};
    if (headers && Object.keys(headers).length > 0) request.headers = headers;
    if (Object.keys(body).length > 0) request.body = body;

    const trimmedDescription = description.trim();
    const trimmedSystem = system.trim();
    const config: AgentConfig = {
      name: agentName,
      mode,
      model: joinedModel,
      steps: steps ?? null,
      system: trimmedSystem || (isNewAgent ? undefined : null),
      request: Object.keys(request).length > 0 ? request : null,
    };
    if (trimmedDescription) config.description = trimmedDescription;
    if (isNewAgent && draftScope) config.scope = draftScope;
    // A duplicate carries the source agent's rules; the permissions editor only
    // appears once the agent exists, so this is the one path that writes them
    // at creation time.
    if (isNewAgent && agentDraft?.permissions?.length) {
      config.permissions = agentDraft.permissions;
    }
    return config;
  }, [agentDraft, description, draftScope, isNewAgent, mode, model, steps, system, temperature, topP, variant]);

  // An existing agent writes itself; a new one is only created once the user
  // confirms it, so an abandoned draft never reaches disk.
  const save = React.useCallback(async (): Promise<AutosaveResult> => {
    const saved = savedRef.current;
    const agentName = selectedAgentName?.trim();
    if (isNewAgent || !saved || !agentName) return AUTOSAVE_UNCHANGED;

    // The permissions section is part of this page, so its write goes out with
    // the page's and both report through one indicator.
    const permissionsResult = permissionsSaveRef.current
      ? await permissionsSaveRef.current()
      : AUTOSAVE_UNCHANGED;

    const unchanged =
      description === saved.description &&
      mode === saved.mode &&
      model === saved.model &&
      variant === saved.variant &&
      steps === saved.steps &&
      temperature === saved.temperature &&
      topP === saved.topP &&
      system === saved.system;
    if (unchanged) return permissionsResult;
    if (!permissionsResult.ok) return permissionsResult;

    const config = buildConfig(agentName);
    const result: AgentMutationResult = await updateAgent(agentName, config, settingsDirectory);
    if (!result.ok) return autosaveFailed(t('settings.agents.page.toast.updateFailed'));
    if (selectionRef.current !== selectionKey) return AUTOSAVE_SAVED;

    entityRef.current = {
      ...entityRef.current,
      model: config.model,
      system: config.system ?? undefined,
      steps: config.steps,
      request: config.request ?? undefined,
    };
    savedRef.current = {
      ...saved,
      description,
      mode,
      model,
      variant,
      steps,
      temperature,
      topP,
      system,
    };
    return AUTOSAVE_SAVED;
  }, [
    buildConfig,
    description,
    isNewAgent,
    mode,
    model,
    selectedAgentName,
    selectionKey,
    settingsDirectory,
    steps,
    system,
    t,
    temperature,
    topP,
    updateAgent,
    variant,
  ]);

  const autosave = useAutosave(save);
  const { requestSave } = autosave;

  const handleCreate = async () => {
    const agentName = draftName.trim().replace(/\s+/g, '-');
    if (!agentName) {
      toast.error(t('settings.agents.sidebar.toast.agentNameRequired'));
      return;
    }
    if (agents.some((a) => a.name === agentName)) {
      toast.error(t('settings.agents.sidebar.toast.agentExists'));
      return;
    }

    setIsCreating(true);
    try {
      const result = await createAgent(buildConfig(agentName), settingsDirectory);
      if (result.ok) {
        setAgentDraft(null);
        toast.success(t('settings.agents.page.toast.created'));
      } else {
        toast.error(t('settings.agents.page.toast.createFailed'));
      }
    } catch (error) {
      console.error('Error creating agent:', error);
      const message = error instanceof Error && error.message ? error.message : t('settings.agents.page.toast.saveUnexpectedError');
      toast.error(message);
    } finally {
      setIsCreating(false);
    }
  };

  const handleCancelCreate = () => {
    setAgentDraft(null);
    setSelectedAgent(null);
  };

  if (!selectedAgentName) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="robot-2" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.agents.page.empty.title')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.agents.page.empty.description')}</p>
        </div>
      </div>
    );
  }

  return (
    <SettingsPageLayout
      title={isNewAgent ? t('settings.agents.page.title.new') : selectedAgentName}
      description={isNewAgent ? t('settings.agents.page.subtitle.new') : t('settings.agents.page.subtitle.edit')}
      onBlurCapture={autosave.onBlurCapture}
    >
      {!isNewAgent && storedAt && (
        <SettingsLegacyFormatNote legacy={storedAt.legacy} path={storedAt.path} />
      )}
      {!isNewAgent && storedAt?.source === 'none' && (
        <p className={`mb-4 flex items-start gap-1.5 ${SETTINGS_HELPER_CLASS}`}>
          <Icon name="information" className="mt-[0.2em] h-3.5 w-3.5 shrink-0 opacity-70" />
          <span>{t('settings.agents.page.runtimeProvided.note')}</span>
        </p>
      )}
      <SettingsSection
        title={t('settings.agents.page.section.identityRole')}
        divider={false}
        contentClassName="space-y-0"
      >
        {isNewAgent && (
          <SettingsFieldRow
            settingsItem="agents.name"
            label={t('settings.agents.page.field.agentName')}
          >
            <div className="flex items-center">
              <span className="typography-ui-label text-muted-foreground mr-1">@</span>
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t('settings.agents.page.field.agentNamePlaceholder')}
                className="h-7 w-40 px-2"
              />
            </div>
            <Select value={draftScope} onValueChange={(v) => setDraftScope(v as AgentScope)}>
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-fit min-w-[100px]">
                <SelectValue placeholder={t('settings.agents.page.field.scopePlaceholder')} />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="user">
                  <div className="flex items-center gap-2">
                    <Icon name="user-3" className="h-3.5 w-3.5" />
                    <span>{t('settings.common.scope.global')}</span>
                  </div>
                </SelectItem>
                <SelectItem value="project">
                  <div className="flex items-center gap-2">
                    <Icon name="folder" className="h-3.5 w-3.5" />
                    <span>{t('settings.common.scope.project')}</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        )}

        <SettingsStackedField
          label={t('settings.common.field.description')}
          controlClassName="w-full max-w-none"
        >
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={runtimeDescription || t('settings.agents.page.field.descriptionPlaceholder')}
            rows={2}
            className="w-full resize-none min-h-[60px] bg-transparent"
          />
        </SettingsStackedField>

        <SettingsStackedField
          settingsItem="agents.mode"
          label={t('settings.agents.page.field.mode')}
          info={t('settings.agents.page.field.modeTooltip')}
        >
          <SettingsChipGroup
            aria-label={t('settings.agents.page.field.mode')}
            value={mode}
            onChange={(next) => {
              setMode(next);
              requestSave();
            }}
            options={[
              { value: 'primary', label: t('settings.agents.page.mode.primary') },
              { value: 'subagent', label: t('settings.agents.page.mode.subagent') },
              { value: 'all', label: t('settings.agents.page.mode.all') },
            ]}
          />
        </SettingsStackedField>
      </SettingsSection>

      <SettingsSection
        title={t('settings.agents.page.section.modelParameters')}
        contentClassName="space-y-3"
      >
        <SettingsFieldRow
          settingsItem="agents.model"
          label={t('settings.agents.page.field.overrideModel')}
        >
          <ModelSelector
            providerId={parseModelIdentifier(model)?.providerId ?? ''}
            modelId={parseModelIdentifier(model)?.modelId ?? ''}
            onChange={(providerId: string, modelId: string) => {
              if (providerId && modelId) {
                setModel(`${providerId}/${modelId}`);
              } else {
                setModel('');
              }
              setVariant('');
              requestSave();
            }}
            className={SETTINGS_CUSTOM_TRIGGER_CLASS}
          />
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="agents.variant"
          label={t('settings.agents.page.field.variant')}
          info={(
            <div className="space-y-1">
              <p>{t('settings.agents.page.field.variantTooltip')}</p>
              <p>{t('settings.agents.page.field.variantHint')}</p>
            </div>
          )}
        >
          {shouldUseVariantSelect ? (
            <Select
              value={selectedVariantValue}
              onValueChange={(value) => {
                setVariant(value === '__default' ? '' : value);
                requestSave();
              }}
            >
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                <SelectValue placeholder={t('settings.agents.page.field.variantPlaceholder')}>
                  {(value) => value === '__default' ? t('chat.modelControls.default') : value}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default">{t('chat.modelControls.default')}</SelectItem>
                {variantSelectOptions.map((variantOption) => (
                  <SelectItem key={variantOption} value={variantOption}>{variantOption}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <>
              <Input
                value={variant}
                onChange={(event) => setVariant(event.target.value)}
                placeholder={t('settings.agents.page.field.variantPlaceholder')}
                disabled={!model && !variant}
                className="h-8 w-40 rounded-md px-3"
              />
              {variant && (
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setVariant('');
                    requestSave();
                  }}
                  className={SETTINGS_ICON_BUTTON_CLASS}
                  aria-label={t('settings.common.actions.clear')}
                  title={t('settings.common.actions.clear')}
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </Button>
              )}
            </>
          )}
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="agents.temperature"
          label={t('settings.agents.page.field.temperature')}
          info={(
            <div className="space-y-1">
              <p>{t('settings.agents.page.field.temperatureTooltip')}</p>
              <p>{t('settings.agents.page.field.temperatureRange')}</p>
            </div>
          )}
        >
          <NumberInput
            value={temperature}
            fallbackValue={0.7}
            onValueChange={setTemperature}
            onClear={() => {
              setTemperature(undefined);
              requestSave();
            }}
            min={0}
            max={2}
            step={0.1}
            inputMode="decimal"
            placeholder="—"
            emptyLabel="—"
            className={SETTINGS_NUMBER_INPUT_CLASS}
          />
          {temperature !== undefined && (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setTemperature(undefined);
                requestSave();
              }}
              className={SETTINGS_ICON_BUTTON_CLASS}
              aria-label={t('settings.agents.page.field.clearTemperatureAria')}
              title={t('settings.common.actions.clear')}
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </Button>
          )}
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="agents.top-p"
          label={t('settings.agents.page.field.topP')}
          info={(
            <div className="space-y-1">
              <p>{t('settings.agents.page.field.topPTooltip')}</p>
              <p>{t('settings.agents.page.field.topPRange')}</p>
            </div>
          )}
        >
          <NumberInput
            value={topP}
            fallbackValue={0.9}
            onValueChange={setTopP}
            onClear={() => {
              setTopP(undefined);
              requestSave();
            }}
            min={0}
            max={1}
            step={0.1}
            inputMode="decimal"
            placeholder="—"
            emptyLabel="—"
            className={SETTINGS_NUMBER_INPUT_CLASS}
          />
          {topP !== undefined && (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setTopP(undefined);
                requestSave();
              }}
              className={SETTINGS_ICON_BUTTON_CLASS}
              aria-label={t('settings.agents.page.field.clearTopPAria')}
              title={t('settings.common.actions.clear')}
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </Button>
          )}
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="agents.steps"
          label={t('settings.agents.page.field.steps')}
          info={t('settings.agents.page.field.stepsTooltip')}
        >
          <NumberInput
            value={steps}
            fallbackValue={20}
            onValueChange={setSteps}
            onClear={() => {
              setSteps(undefined);
              requestSave();
            }}
            min={1}
            max={1000}
            step={1}
            inputMode="numeric"
            placeholder="—"
            emptyLabel="—"
            className={SETTINGS_NUMBER_INPUT_CLASS}
          />
          {steps !== undefined && (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setSteps(undefined);
                requestSave();
              }}
              className={SETTINGS_ICON_BUTTON_CLASS}
              aria-label={t('settings.agents.page.field.clearStepsAria')}
              title={t('settings.common.actions.clear')}
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </Button>
          )}
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t('settings.agents.page.section.systemPrompt')}
        settingsItem="agents.system-prompt"
      >
        <Textarea
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          placeholder={runtimeSystem || t('settings.agents.page.field.systemPromptPlaceholder')}
          rows={8}
          className="w-full font-mono typography-meta min-h-[120px] max-h-[60vh] bg-transparent"
        />
      </SettingsSection>

      {!isNewAgent && selectedAgent && (
        <AgentPermissionsEditor
          agent={selectedAgent}
          registerSave={registerPermissionsSave}
          requestSave={requestSave}
        />
      )}

      {isNewAgent && (
        <div className="flex items-center gap-2 pb-8">
          <Button
            onClick={() => void handleCreate()}
            disabled={isCreating || !draftName.trim()}
            size="xs"
            className="!font-normal"
          >
            {isCreating ? t('settings.common.actions.saving') : t('settings.common.actions.create')}
          </Button>
          <Button
            variant="ghost"
            onClick={handleCancelCreate}
            disabled={isCreating}
            size="xs"
            className="!font-normal"
          >
            {t('settings.common.actions.cancel')}
          </Button>
        </div>
      )}
    </SettingsPageLayout>
  );
};
