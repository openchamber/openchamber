import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useAgentsStore, type AgentConfig, type AgentMutationResult, type AgentScope } from '@/stores/useAgentsStore';
import { useShallow } from 'zustand/react/shallow';
import { ModelSelector } from './ModelSelector';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { useConfigStore } from '@/stores/useConfigStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsStackedField,
  SettingsChipGroup,
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
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

type AgentVariantProvider = {
  id: string;
  models?: Array<{
    id?: string;
    variants?: Record<string, unknown>;
  }>;
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
  const model = provider?.models?.find((item) => item.id === parsedModel.modelId);
  return model?.variants ? Object.keys(model.variants) : [];
};
export const AgentsPage: React.FC = () => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers) as AgentVariantProvider[];
  const {
    selectedAgentName,
    getAgentByName,
    createAgent,
    updateAgent,
    agents,
    agentDraft,
    setAgentDraft,
  } = useAgentsStore(useShallow((s) => ({
    selectedAgentName: s.selectedAgentName,
    getAgentByName: s.getAgentByName,
    createAgent: s.createAgent,
    updateAgent: s.updateAgent,
    agents: s.agents,
    agentDraft: s.agentDraft,
    setAgentDraft: s.setAgentDraft,
  })));

  const selectedAgent = selectedAgentName ? getAgentByName(selectedAgentName) : null;
  const isNewAgent = Boolean(agentDraft && agentDraft.name === selectedAgentName && !selectedAgent);

  const [draftName, setDraftName] = React.useState('');
  const [draftScope, setDraftScope] = React.useState<AgentScope>('user');
  const [description, setDescription] = React.useState('');
  const [mode, setMode] = React.useState<'primary' | 'subagent' | 'all'>('subagent');
  const [model, setModel] = React.useState('');
  const [variant, setVariant] = React.useState('');
  const [temperature, setTemperature] = React.useState<number | undefined>(undefined);
  const [topP, setTopP] = React.useState<number | undefined>(undefined);
  const [prompt, setPrompt] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const initialStateRef = React.useRef<{
    draftName: string;
    draftScope: AgentScope;
    description: string;
    mode: 'primary' | 'subagent' | 'all';
    model: string;
    variant: string;
    temperature: number | undefined;
    topP: number | undefined;
    prompt: string;
  } | null>(null);

  const variantOptions = React.useMemo(() => getVariantOptionsForModel(providers, model), [model, providers]);
  const hasVariantOptions = variantOptions.length > 0;
  const selectedVariantValue = variant || '__default';
  const shouldUseVariantSelect = hasVariantOptions;
  const variantSelectOptions = React.useMemo(() => (
    variant && !variantOptions.includes(variant) ? [variant, ...variantOptions] : variantOptions
  ), [variant, variantOptions]);

  React.useEffect(() => {
    if (isNewAgent && agentDraft) {
      const draftNameValue = agentDraft.name || '';
      const draftScopeValue = agentDraft.scope || 'user';
      const descriptionValue = agentDraft.description || '';
      const modeValue = agentDraft.mode || 'subagent';
      const modelValue = agentDraft.model || '';
      const variantValue = agentDraft.variant || '';
      const temperatureValue = agentDraft.temperature ?? undefined;
      const topPValue = agentDraft.top_p ?? undefined;
      const promptValue = agentDraft.prompt || '';

      setDraftName(draftNameValue);
      setDraftScope(draftScopeValue);
      setDescription(descriptionValue);
      setMode(modeValue);
      setModel(modelValue);
      setVariant(variantValue);
      setTemperature(temperatureValue);
      setTopP(topPValue);
      setPrompt(promptValue);

      initialStateRef.current = {
        draftName: draftNameValue,
        draftScope: draftScopeValue,
        description: descriptionValue,
        mode: modeValue,
        model: modelValue,
        variant: variantValue,
        temperature: temperatureValue,
        topP: topPValue,
        prompt: promptValue,
      };
      return;
    }

    if (selectedAgent && selectedAgentName === selectedAgent.name) {
      const descriptionValue = selectedAgent.description || '';
      const modeValue = selectedAgent.mode || 'subagent';
      const modelValue = selectedAgent.model?.providerID && selectedAgent.model?.modelID
        ? `${selectedAgent.model.providerID}/${selectedAgent.model.modelID}`
        : '';
      const variantValue = selectedAgent.variant || '';
      const temperatureValue = selectedAgent.temperature ?? undefined;
      const topPValue = selectedAgent.topP ?? undefined;
      const promptValue = selectedAgent.prompt || '';

      setDescription(descriptionValue);
      setMode(modeValue);

      setModel(modelValue);
      setVariant(variantValue);
      setTemperature(temperatureValue);
      setTopP(topPValue);
      setPrompt(promptValue);

      initialStateRef.current = {
        draftName: '',
        draftScope: 'user',
        description: descriptionValue,
        mode: modeValue,
        model: modelValue,
        variant: variantValue,
        temperature: temperatureValue,
        topP: topPValue,
        prompt: promptValue,
      };
    }
  }, [agentDraft, isNewAgent, selectedAgent, selectedAgentName]);

  const isDirty = React.useMemo(() => {
    const initial = initialStateRef.current;
    if (!initial) {
      return false;
    }

    if (isNewAgent) {
      if (draftName !== initial.draftName) return true;
      if (draftScope !== initial.draftScope) return true;
    }

    if (description !== initial.description) return true;
    if (mode !== initial.mode) return true;
    if (model !== initial.model) return true;
    if (variant !== initial.variant) return true;
    if (temperature !== initial.temperature) return true;
    if (topP !== initial.topP) return true;
    if (prompt !== initial.prompt) return true;

    return false;
  }, [description, draftName, draftScope, isNewAgent, mode, model, prompt, temperature, topP, variant]);

  const handleSave = async () => {
    const agentName = isNewAgent ? draftName.trim().replace(/\s+/g, '-') : selectedAgentName?.trim();

    if (!agentName) {
      toast.error(t('settings.agents.sidebar.toast.agentNameRequired'));
      return;
    }

    // Check for duplicate name when creating new agent
    if (isNewAgent && agents.some((a) => a.name === agentName)) {
      toast.error(t('settings.agents.sidebar.toast.agentExists'));
      return;
    }

    setIsSaving(true);

    try {
      const trimmedModel = model.trim();
      const trimmedVariant = variant.trim();
      const trimmedPrompt = prompt.trim();
      const config: AgentConfig = {
        name: agentName,
        ...(description.trim() ? { description: description.trim() } : {}),
        mode,
        model: trimmedModel === '' ? null : trimmedModel,
        variant: trimmedVariant === '' ? null : trimmedVariant || undefined,
        temperature: temperature ?? null,
        top_p: topP ?? null,
        prompt: trimmedPrompt || (isNewAgent ? undefined : null),
        ...(isNewAgent && draftScope ? { scope: draftScope } : {}),
      };

      let result: AgentMutationResult;
      if (isNewAgent) {
        result = await createAgent(config);
        if (result.ok) {
          setAgentDraft(null); // Clear draft after successful creation
        }
      } else {
        result = await updateAgent(agentName, config);
      }

      if (result.ok) {
        if (result.requiresManualRestart) {
          toast.warning(t('settings.agents.page.toast.savedManualRestart'));
        } else if (result.deferred) {
          const count = result.pendingActiveSessions ?? 0;
          toast.info(
            count === 1
              ? t('settings.agents.page.toast.savedDeferredSingle')
              : t('settings.agents.page.toast.savedDeferredPlural', { count })
          );
        } else {
          toast.success(isNewAgent ? t('settings.agents.page.toast.created') : t('settings.agents.page.toast.updated'));
        }
      } else {
        toast.error(isNewAgent ? t('settings.agents.page.toast.createFailed') : t('settings.agents.page.toast.updateFailed'));
      }
    } catch (error) {
      console.error('Error saving agent:', error);
      const message = error instanceof Error && error.message ? error.message : t('settings.agents.page.toast.saveUnexpectedError');
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
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
      showSaveStatus={false}
    >
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
            placeholder={t('settings.agents.page.field.descriptionPlaceholder')}
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
            onChange={setMode}
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
              onValueChange={(value) => setVariant(value === '__default' ? '' : value)}
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
                  onClick={() => setVariant('')}
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
            onClear={() => setTemperature(undefined)}
            min={0}
            max={2}
            step={0.1}
            inputMode="decimal"
            placeholder="—"
            emptyLabel="—"
            className="w-16"
          />
          {temperature !== undefined && (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setTemperature(undefined)}
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
            onClear={() => setTopP(undefined)}
            min={0}
            max={1}
            step={0.1}
            inputMode="decimal"
            placeholder="—"
            emptyLabel="—"
            className="w-16"
          />
          {topP !== undefined && (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setTopP(undefined)}
              className={SETTINGS_ICON_BUTTON_CLASS}
              aria-label={t('settings.agents.page.field.clearTopPAria')}
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
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('settings.agents.page.field.systemPromptPlaceholder')}
          rows={8}
          className="w-full font-mono typography-meta min-h-[120px] max-h-[60vh] bg-transparent resize-y"
        />
      </SettingsSection>

      {!isNewAgent && selectedAgent && (
        <AgentPermissionsEditor agent={selectedAgent} />
      )}

      <div className="pb-8">
        <Button
          onClick={handleSave}
          disabled={isSaving || !isDirty}
          size="xs"
          className="!font-normal"
        >
          {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
        </Button>
      </div>
    </SettingsPageLayout>
  );
};
