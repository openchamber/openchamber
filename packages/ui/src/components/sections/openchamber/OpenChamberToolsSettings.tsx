import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SettingsControlGroup, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { BUILTIN_BROWSER_PROVIDER, browserProviderGuests } from '@/lib/guests/browser-providers';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { useGuestsStore } from '@/lib/guests/store';
import { opencodeClient } from '@/lib/opencode/client';
import { updateDesktopSettings } from '@/lib/persistence';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { listModelVariantIds } from '@/lib/modelVariants';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { ModelVariantSelect } from './ModelVariantSelect';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

interface ToolRowProps {
  icon: IconName;
  title: string;
  /** Carries what is worth knowing before turning it on (safety, cost), so the row needs no info hint. */
  summary: string;
  ariaLabel: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  settingsItem: string;
  /** A setting of this tool alone, under its summary. */
  children?: React.ReactNode;
}

/** Rows of one group: flat, apart by spacing, like the rest of Settings. */
const TOOL_LIST_CLASS = 'max-w-[44rem] space-y-1';
const TOOL_OPTION_TRIGGER_CLASS = 'ms-auto w-auto min-w-0 max-w-[16rem]';

const ToolRow: React.FC<ToolRowProps> = ({ icon, title, summary, ariaLabel, checked, onChange, settingsItem, children }) => (
  <div className="py-2">
    <div data-settings-item={settingsItem} className="flex items-start gap-3">
      {/* The switch alone says "off": dimming the row would read as disabled.
          The icon sits on the title's line, so a two-line summary leaves it there. */}
      <Icon name={icon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate typography-ui-label text-foreground">{title}</div>
        <p className="typography-meta text-muted-foreground">{summary}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={ariaLabel} className="mt-0.5" />
    </div>
    {children}
  </div>
);

/** The one setting a tool has: under its summary, from the tool's text to the switch's edge. */
const ToolOption: React.FC<{ settingsItem: string; label: string; info?: string; children: React.ReactNode }> = ({ settingsItem, label, info, children }) => (
  <div data-settings-item={settingsItem} className="mt-2 flex min-w-0 items-center gap-2 ps-7">
    <span className="truncate typography-meta text-muted-foreground">{label}</span>
    {info ? <SettingsInfoHint>{info}</SettingsInfoHint> : null}
    {children}
  </div>
);

/**
 * Which OpenChamber capabilities agents are given.
 *
 * Each entry is one tool the managed OpenCode child is handed, so the choices
 * belong together and not under the CLI's own configuration — the binary path
 * is about which OpenCode runs, these are about what it can do.
 *
 * A toggle only writes the setting: the server keeps OpenChamber's plugin
 * injection in a watched file, so OpenCode picks the change up on its own and
 * the tool list is live without a restart.
 *
 * Each tool is a row with a switch because each one adds or removes a whole
 * capability, and the one-line summary says what without opening the hint.
 * The rows are grouped by what they give the agent (running work, the chat,
 * what it knows) and named by that thing alone: the section title already says
 * they are tools. A setting of one tool alone shows under it while the tool is on.
 */
export const OpenChamberToolsSettings: React.FC = () => {
  const { t } = useI18n();
  const agentControlToolEnabled = useUIStore((state) => state.agentControlToolEnabled);
  const setAgentControlToolEnabled = useUIStore((state) => state.setAgentControlToolEnabled);
  const agentScheduleToolEnabled = useUIStore((state) => state.agentScheduleToolEnabled);
  const setAgentScheduleToolEnabled = useUIStore((state) => state.setAgentScheduleToolEnabled);
  const agentWebToolEnabled = useUIStore((state) => state.agentWebToolEnabled);
  const setAgentWebToolEnabled = useUIStore((state) => state.setAgentWebToolEnabled);
  const browserProvider = useUIStore((state) => state.browserProvider);
  const setBrowserProvider = useUIStore((state) => state.setBrowserProvider);
  const guests = useGuestsStore((state) => state.guests);
  const agentMemoryToolEnabled = useUIStore((state) => state.agentMemoryToolEnabled);
  // Absent where no OpenChamber server answers settings (VS Code).
  const agentMemoryAvailable = useUIStore((state) => state.agentMemoryFeatureAvailable);
  const setAgentMemoryToolEnabled = useUIStore((state) => state.setAgentMemoryToolEnabled);
  const agentMemoryDreamingEnabled = useUIStore((state) => state.agentMemoryDreamingEnabled);
  const setAgentMemoryDreamingEnabled = useUIStore((state) => state.setAgentMemoryDreamingEnabled);
  const agentMemoryDreamingModel = useUIStore((state) => state.agentMemoryDreamingModel);
  const setAgentMemoryDreamingModel = useUIStore((state) => state.setAgentMemoryDreamingModel);
  const agentMemoryDreamingVariant = useUIStore((state) => state.agentMemoryDreamingVariant);
  const setAgentMemoryDreamingVariant = useUIStore((state) => state.setAgentMemoryDreamingVariant);
  const providers = useConfigStore((state) => state.providers);
  const agentKnowledgeToolEnabled = useUIStore((state) => state.agentKnowledgeToolEnabled);
  const setAgentKnowledgeToolEnabled = useUIStore((state) => state.setAgentKnowledgeToolEnabled);
  const agentNotifyToolEnabled = useUIStore((state) => state.agentNotifyToolEnabled);
  const setAgentNotifyToolEnabled = useUIStore((state) => state.setAgentNotifyToolEnabled);
  const agentUsageToolEnabled = useUIStore((state) => state.agentUsageToolEnabled);
  const setAgentUsageToolEnabled = useUIStore((state) => state.setAgentUsageToolEnabled);
  const agentRenderToolEnabled = useUIStore((state) => state.agentRenderToolEnabled);
  const setAgentRenderToolEnabled = useUIStore((state) => state.setAgentRenderToolEnabled);
  const agentImageToolEnabled = useUIStore((state) => state.agentImageToolEnabled);
  const setAgentImageToolEnabled = useUIStore((state) => state.setAgentImageToolEnabled);
  const agentImageModel = useUIStore((state) => state.agentImageModel);
  const setAgentImageModel = useUIStore((state) => state.setAgentImageModel);
  const agentSecretToolEnabled = useUIStore((state) => state.agentSecretToolEnabled);
  const setAgentSecretToolEnabled = useUIStore((state) => state.setAgentSecretToolEnabled);
  // Absent without an OpenChamber server, like memory.
  const agentWorkflowAvailable = useUIStore((state) => state.agentWorkflowFeatureAvailable);
  const agentWorkflowToolEnabled = useUIStore((state) => state.agentWorkflowToolEnabled);
  const setAgentWorkflowToolEnabled = useUIStore((state) => state.setAgentWorkflowToolEnabled);

  const handleAgentControlToolChange = React.useCallback((enabled: boolean) => {
    setAgentControlToolEnabled(enabled);
    void updateDesktopSettings({ agentControlToolEnabled: enabled });
  }, [setAgentControlToolEnabled]);

  const handleAgentScheduleToolChange = React.useCallback((enabled: boolean) => {
    setAgentScheduleToolEnabled(enabled);
    void updateDesktopSettings({ agentScheduleToolEnabled: enabled });
  }, [setAgentScheduleToolEnabled]);

  const handleAgentWebToolChange = React.useCallback((enabled: boolean) => {
    setAgentWebToolEnabled(enabled);
    void updateDesktopSettings({ agentWebToolEnabled: enabled });
  }, [setAgentWebToolEnabled]);

  const handleAgentNotifyToolChange = React.useCallback((enabled: boolean) => {
    setAgentNotifyToolEnabled(enabled);
    void updateDesktopSettings({ agentNotifyToolEnabled: enabled });
  }, [setAgentNotifyToolEnabled]);

  const handleAgentUsageToolChange = React.useCallback((enabled: boolean) => {
    setAgentUsageToolEnabled(enabled);
    void updateDesktopSettings({ agentUsageToolEnabled: enabled });
  }, [setAgentUsageToolEnabled]);

  const handleAgentRenderToolChange = React.useCallback((enabled: boolean) => {
    setAgentRenderToolEnabled(enabled);
    void updateDesktopSettings({ agentRenderToolEnabled: enabled });
  }, [setAgentRenderToolEnabled]);

  const handleAgentImageToolChange = React.useCallback((enabled: boolean) => {
    setAgentImageToolEnabled(enabled);
    void updateDesktopSettings({ agentImageToolEnabled: enabled });
  }, [setAgentImageToolEnabled]);

  // Read by the server on every call; no OpenCode restart involved.
  const handleAgentImageModelChange = React.useCallback((value: string) => {
    setAgentImageModel(value);
    void updateDesktopSettings({ agentImageModel: value });
  }, [setAgentImageModel]);

  // Only models that generate images, read when the page opens: a provider
  // connected meanwhile shows up on the next visit.
  const [imageModels, setImageModels] = React.useState<{ status: 'loading' | 'failed' } | { status: 'ready'; models: Array<{ value: string; name: string; providerID: string }> }>({ status: 'loading' });
  React.useEffect(() => {
    let cancelled = false;
    opencodeClient.listImageModels().then(
      (models) => { if (!cancelled) setImageModels({ status: 'ready', models }); },
      () => { if (!cancelled) setImageModels({ status: 'failed' }); },
    );
    return () => { cancelled = true; };
  }, []);
  const imageModelOptions = imageModels.status === 'ready' ? imageModels.models : [];
  const imageModelKnown = imageModelOptions.some((model) => model.value === agentImageModel);

  const handleAgentSecretToolChange = React.useCallback((enabled: boolean) => {
    setAgentSecretToolEnabled(enabled);
    void updateDesktopSettings({ agentSecretToolEnabled: enabled });
  }, [setAgentSecretToolEnabled]);

  const handleAgentKnowledgeToolChange = React.useCallback((enabled: boolean) => {
    setAgentKnowledgeToolEnabled(enabled);
    void updateDesktopSettings({ agentKnowledgeToolEnabled: enabled });
  }, [setAgentKnowledgeToolEnabled]);

  const handleAgentWorkflowToolChange = React.useCallback((enabled: boolean) => {
    setAgentWorkflowToolEnabled(enabled);
    void updateDesktopSettings({ agentWorkflowToolEnabled: enabled });
  }, [setAgentWorkflowToolEnabled]);

  // The dropdown lists installed extensions, so the catalog has to be loaded
  // here too: this page can be the first thing opened after a fresh start.
  React.useEffect(() => {
    void loadGuestCatalog();
  }, []);
  const providerGuests = React.useMemo(() => browserProviderGuests(guests), [guests]);
  // A selection whose extension is gone shows as the built-in: the server
  // already routes to it and resets the setting on the next action.
  const providerValue = providerGuests.some((guest) => guest.id === browserProvider)
    ? browserProvider
    : BUILTIN_BROWSER_PROVIDER;

  // Read by the server on the next browser action; no OpenCode restart involved.
  const handleBrowserProviderChange = React.useCallback((value: string) => {
    setBrowserProvider(value);
    void updateDesktopSettings({ browserProvider: value });
  }, [setBrowserProvider]);

  // Turning memory off removes the whole feature, not just the tool: the panel
  // tab goes with it and sessions stop being given the index. Showing the user
  // what is stored would be pointless once the agent can no longer manage it.
  const handleAgentMemoryToolChange = React.useCallback((enabled: boolean) => {
    setAgentMemoryToolEnabled(enabled);
    // Re-read after the write lands, not before. The switch flips the client
    // immediately, which makes the panel ask the server straight away — and
    // while the setting is still being written the server truthfully answers
    // "disabled", which used to leave the tab hidden until a restart.
    void updateDesktopSettings({ agentMemoryToolEnabled: enabled })
      .finally(() => {
        if (enabled) {
          void useAgentMemoryStore.getState().refresh();
        }
      });
  }, [setAgentMemoryToolEnabled]);

  // Read by the server on its next look; dreaming runs a few minutes after start and hourly after.
  const handleDreamingChange = React.useCallback((enabled: boolean) => {
    setAgentMemoryDreamingEnabled(enabled);
    void updateDesktopSettings({ agentMemoryDreamingEnabled: enabled });
  }, [setAgentMemoryDreamingEnabled]);

  // Cleared, dreaming runs on the default model. A thinking level belongs to the model it was picked for.
  const handleDreamingModelChange = React.useCallback((providerId: string, modelId: string) => {
    const value = providerId && modelId ? `${providerId}/${modelId}` : '';
    setAgentMemoryDreamingModel(value);
    setAgentMemoryDreamingVariant('');
    void updateDesktopSettings({ agentMemoryDreamingModel: value, agentMemoryDreamingVariant: '' });
  }, [setAgentMemoryDreamingModel, setAgentMemoryDreamingVariant]);

  const handleDreamingVariantChange = React.useCallback((variant: string | undefined) => {
    setAgentMemoryDreamingVariant(variant ?? '');
    void updateDesktopSettings({ agentMemoryDreamingVariant: variant ?? '' });
  }, [setAgentMemoryDreamingVariant]);

  const dreamingModel = parseModelIdentifier(agentMemoryDreamingModel) ?? { providerId: '', modelId: '' };
  const dreamingVariants = React.useMemo(() => {
    if (!dreamingModel.providerId || !dreamingModel.modelId) return [];
    const provider = providers.find((candidate) => candidate.id === dreamingModel.providerId);
    return listModelVariantIds(provider?.models.find((model) => model.id === dreamingModel.modelId)?.variants);
  }, [dreamingModel.modelId, dreamingModel.providerId, providers]);

  return (
    <SettingsSection title={t('settings.openchamber.tools.title')} contentClassName="space-y-6">
      <SettingsControlGroup title={t('settings.openchamber.tools.group.work')} contentClassName={TOOL_LIST_CLASS}>
        <ToolRow
          icon="node-tree"
          settingsItem="sessions.agent-control-tool"
          checked={agentControlToolEnabled}
          onChange={handleAgentControlToolChange}
          title={t('settings.openchamber.tools.name.control')}
          summary={t('settings.openchamber.tools.field.agentControlToolSummary')}
          ariaLabel={t('settings.openchamber.tools.field.agentControlToolAria')}
        />
        {agentWorkflowAvailable ? (
          <ToolRow
            icon="flow-chart"
            settingsItem="sessions.agent-workflow-tool"
            checked={agentWorkflowToolEnabled}
            onChange={handleAgentWorkflowToolChange}
            title={t('settings.openchamber.tools.name.workflow')}
            summary={t('settings.openchamber.tools.field.agentWorkflowToolSummary')}
            ariaLabel={t('settings.openchamber.tools.field.agentWorkflowToolAria')}
          />
        ) : null}
        <ToolRow
          icon="calendar-schedule"
          settingsItem="sessions.agent-schedule-tool"
          checked={agentScheduleToolEnabled}
          onChange={handleAgentScheduleToolChange}
          title={t('settings.openchamber.tools.name.schedule')}
          summary={t('settings.openchamber.tools.field.agentScheduleToolSummary')}
          ariaLabel={t('settings.openchamber.tools.field.agentScheduleToolAria')}
        />
        <ToolRow
          icon="global"
          settingsItem="sessions.agent-web-tool"
          checked={agentWebToolEnabled}
          onChange={handleAgentWebToolChange}
          title={t('settings.openchamber.tools.name.web')}
          summary={t('settings.openchamber.tools.field.agentWebToolSummary')}
          ariaLabel={t('settings.openchamber.tools.field.agentWebToolAria')}
        >
          {/* Shown even with nothing to choose: the hint is how people
              learn that browser-provider extensions exist. */}
          {agentWebToolEnabled ? (
            <ToolOption
              settingsItem="sessions.browser-provider"
              label={t('settings.openchamber.tools.browserProvider.label')}
              info={t('settings.openchamber.tools.browserProvider.info')}
            >
              <Select<string>
                value={providerValue}
                onValueChange={handleBrowserProviderChange}
                disabled={providerGuests.length === 0}
              >
                <SelectTrigger
                  className={TOOL_OPTION_TRIGGER_CLASS}
                  aria-label={t('settings.openchamber.tools.browserProvider.aria')}
                >
                  <SelectValue>
                    {(value) => (
                      value === BUILTIN_BROWSER_PROVIDER
                        ? t('settings.openchamber.tools.browserProvider.option.builtin')
                        : providerGuests.find((guest) => guest.id === value)?.name ?? null
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BUILTIN_BROWSER_PROVIDER}>
                    {t('settings.openchamber.tools.browserProvider.option.builtin')}
                  </SelectItem>
                  {providerGuests.map((guest) => (
                    <SelectItem key={guest.id} value={guest.id}>{guest.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ToolOption>
          ) : null}
        </ToolRow>
      </SettingsControlGroup>

      <SettingsControlGroup title={t('settings.openchamber.tools.group.chat')} contentClassName={TOOL_LIST_CLASS}>
        <ToolRow
          icon="bar-chart-box"
          settingsItem="sessions.agent-render-tool"
          checked={agentRenderToolEnabled}
          onChange={handleAgentRenderToolChange}
          title={t('settings.openchamber.tools.name.render')}
          summary={t('settings.openchamber.tools.field.agentRenderToolSummary')}
          ariaLabel={t('settings.openchamber.tools.field.agentRenderToolAria')}
        />
        <ToolRow
          icon="image"
          settingsItem="sessions.agent-image-tool"
          checked={agentImageToolEnabled}
          onChange={handleAgentImageToolChange}
          title={t('settings.openchamber.tools.name.image')}
          summary={t('settings.openchamber.tools.field.agentImageToolSummary')}
          ariaLabel={t('settings.openchamber.tools.field.agentImageToolAria')}
        >
          {agentImageToolEnabled ? (
            <ToolOption
              settingsItem="sessions.agent-image-model"
              label={t('settings.openchamber.tools.imageModel.label')}
            >
              <Select<string>
                value={agentImageModel}
                onValueChange={handleAgentImageModelChange}
                disabled={imageModelOptions.length === 0}
              >
                <SelectTrigger
                  className={TOOL_OPTION_TRIGGER_CLASS}
                  aria-label={t('settings.openchamber.tools.imageModel.aria')}
                >
                  <SelectValue>
                    {(value) => {
                      if (imageModels.status === 'failed' && !value) return t('settings.openchamber.tools.imageModel.loadFailed');
                      if (imageModels.status === 'ready' && imageModelOptions.length === 0 && !value) return t('settings.openchamber.tools.imageModel.empty');
                      if (!value) return t('settings.openchamber.tools.imageModel.placeholder');
                      const known = imageModelOptions.find((model) => model.value === value);
                      if (known) return known.name;
                      // A model gone from the catalog stays named rather than swapped for another.
                      return imageModels.status === 'ready'
                        ? t('settings.openchamber.tools.imageModel.unavailable', { model: value })
                        : value;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {agentImageModel && !imageModelKnown && imageModels.status === 'ready' ? (
                    <SelectItem value={agentImageModel} disabled>
                      {t('settings.openchamber.tools.imageModel.unavailable', { model: agentImageModel })}
                    </SelectItem>
                  ) : null}
                  {imageModelOptions.map((model) => (
                    <SelectItem key={model.value} value={model.value}>
                      <span className="truncate">{model.name}</span>
                      <span className="ms-2 truncate typography-meta text-muted-foreground">{model.providerID}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ToolOption>
          ) : null}
        </ToolRow>
        <ToolRow
          icon="shield-keyhole"
          settingsItem="sessions.agent-secret-tool"
          checked={agentSecretToolEnabled}
          onChange={handleAgentSecretToolChange}
          title={t('settings.openchamber.tools.name.secret')}
          summary={t('settings.openchamber.tools.field.agentSecretToolSummary')}
          ariaLabel={t('settings.openchamber.tools.field.agentSecretToolAria')}
        />
        <ToolRow
          icon="notification-3"
          settingsItem="sessions.agent-notify-tool"
          checked={agentNotifyToolEnabled}
          onChange={handleAgentNotifyToolChange}
          title={t('settings.openchamber.tools.name.notify')}
          summary={t('settings.openchamber.tools.field.agentNotifyToolSummary')}
          ariaLabel={t('settings.openchamber.tools.field.agentNotifyToolAria')}
        />
      </SettingsControlGroup>

      <SettingsControlGroup title={t('settings.openchamber.tools.group.knowledge')} contentClassName={TOOL_LIST_CLASS}>
        {agentMemoryAvailable ? (
          <ToolRow
            icon="brain"
            settingsItem="sessions.agent-memory-tool"
            checked={agentMemoryToolEnabled}
            onChange={handleAgentMemoryToolChange}
            title={t('settings.openchamber.tools.name.memory')}
            summary={t('settings.openchamber.tools.field.agentMemoryToolSummary')}
            ariaLabel={t('settings.openchamber.tools.field.agentMemoryToolAria')}
          >
            {agentMemoryToolEnabled ? (
              // One row that never changes height: the checkbox turns organizing on, and
              // the model beside it stays in place, disabled, while it is off.
              <div data-settings-item="sessions.agent-memory-dreaming" className="mt-2 flex min-w-0 items-center gap-2 ps-7">
                <Checkbox
                  checked={agentMemoryDreamingEnabled}
                  onChange={handleDreamingChange}
                  ariaLabel={t('settings.openchamber.tools.dreaming.aria')}
                />
                <button
                  type="button"
                  className="truncate typography-meta text-muted-foreground"
                  onClick={() => handleDreamingChange(!agentMemoryDreamingEnabled)}
                >
                  {t('settings.openchamber.tools.dreaming.label')}
                </button>
                <SettingsInfoHint>{t('settings.openchamber.tools.dreaming.info')}</SettingsInfoHint>
                <div data-settings-item="sessions.agent-memory-dreaming-model" className="ms-auto flex min-w-0 items-center gap-2">
                  <ModelSelector
                    providerId={dreamingModel.providerId}
                    modelId={dreamingModel.modelId}
                    onChange={handleDreamingModelChange}
                    placeholder={t('settings.openchamber.tools.dreamingModel.default')}
                    className="min-w-0 max-w-[16rem]"
                    disabled={!agentMemoryDreamingEnabled}
                  />
                  <ModelVariantSelect
                    variants={dreamingVariants}
                    value={agentMemoryDreamingVariant || undefined}
                    onChange={handleDreamingVariantChange}
                    ariaLabel={t('settings.openchamber.tools.dreamingModel.thinking')}
                    triggerClassName="w-auto min-w-0"
                    disabled={!agentMemoryDreamingEnabled}
                  />
                </div>
              </div>
            ) : null}
          </ToolRow>
        ) : null}
        <ToolRow
          icon="sticky-note"
          settingsItem="sessions.agent-knowledge-tool"
          checked={agentKnowledgeToolEnabled}
          onChange={handleAgentKnowledgeToolChange}
          title={t('settings.openchamber.tools.name.knowledge')}
          summary={t('settings.openchamber.tools.field.agentKnowledgeToolSummary')}
          ariaLabel={t('settings.openchamber.tools.field.agentKnowledgeToolAria')}
        />
        <ToolRow
          icon="bar-chart-2"
          settingsItem="sessions.agent-usage-tool"
          checked={agentUsageToolEnabled}
          onChange={handleAgentUsageToolChange}
          title={t('settings.openchamber.tools.name.usage')}
          summary={t('settings.openchamber.tools.field.agentUsageToolSummary')}
          ariaLabel={t('settings.openchamber.tools.field.agentUsageToolAria')}
        />
      </SettingsControlGroup>
    </SettingsSection>
  );
};
