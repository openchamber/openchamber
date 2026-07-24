import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getResponseStylePresetInstructions,
  isResponseStylePreset,
  RESPONSE_STYLE_PRESETS,
  type ResponseStylePreset,
} from '@/lib/responseStyle';
import type { DesktopSettings } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';

const AGENTS_MD_PATH = '~/.config/opencode/AGENTS.md';

const readApiError = async (response: Response, fallback: string) => {
  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof data?.error === 'string' && data.error.trim() ? data.error : fallback;
};

const normalizeAgentsMdContent = (content: string) => {
  return content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
};

type ResponseStyleValue = ResponseStylePreset | 'custom';

type BehaviorSettingsState = {
  prompt: string;
  responseStyleEnabled: boolean;
  responseStylePreset: ResponseStyleValue;
  responseStyleCustomInstructions: string;
};

const DEFAULT_BEHAVIOR_SETTINGS: BehaviorSettingsState = {
  prompt: '',
  responseStyleEnabled: false,
  responseStylePreset: 'concise',
  responseStyleCustomInstructions: '',
};

const getResponseStylePreview = (preset: ResponseStyleValue, customInstructions: string) => {
  return preset === 'custom' ? customInstructions : getResponseStylePresetInstructions(preset);
};

const sanitizeResponseStylePreset = (value: unknown): ResponseStyleValue => {
  if (value === 'custom') return 'custom';
  return isResponseStylePreset(value) ? value : 'concise';
};

const RESPONSE_STYLE_OPTION_LABEL_KEYS: Record<ResponseStylePreset, I18nKey> = {
  concise: 'settings.behavior.page.responseStyle.option.concise',
  detailed: 'settings.behavior.page.responseStyle.option.detailed',
  mentor: 'settings.behavior.page.responseStyle.option.mentor',
  pushback: 'settings.behavior.page.responseStyle.option.pushback',
  noFiller: 'settings.behavior.page.responseStyle.option.noFiller',
  matchEnergy: 'settings.behavior.page.responseStyle.option.matchEnergy',
  warmPeer: 'settings.behavior.page.responseStyle.option.warmPeer',
};

const saveBehaviorSetting = async (settings: Partial<DesktopSettings>, fallbackError: string) => {
  reportSettingsSaveState('saving');
  try {
    const response = await runtimeFetch('/api/config/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(settings),
    });

    if (!response.ok) {
      throw new Error(await readApiError(response, fallbackError));
    }
    reportSettingsSaveState('saved');
  } catch (error) {
    reportSettingsSaveState('error');
    throw error;
  }
};

export const BehaviorPage: React.FC = () => {
  const { t } = useI18n();
  const [prompt, setPrompt] = React.useState('');
  const [responseStyleEnabled, setResponseStyleEnabled] = React.useState(DEFAULT_BEHAVIOR_SETTINGS.responseStyleEnabled);
  const [responseStylePreset, setResponseStylePreset] = React.useState<ResponseStyleValue>(DEFAULT_BEHAVIOR_SETTINGS.responseStylePreset);
  const [responseStyleCustomInstructions, setResponseStyleCustomInstructions] = React.useState(DEFAULT_BEHAVIOR_SETTINGS.responseStyleCustomInstructions);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [initialPrompt, setInitialPrompt] = React.useState('');
  const lastSavedResponseStyleRef = React.useRef<{
    enabled: boolean;
    preset: ResponseStyleValue;
    custom: string;
  } | null>(null);

  React.useEffect(() => {
    const abort = new AbortController();

    const load = async () => {
      try {
        const [settingsRes, agentsMdRes] = await Promise.all([
          runtimeFetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: abort.signal,
          }),
          runtimeFetch('/api/behavior/agents-md', {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: abort.signal,
          }),
        ]);

        let nextSettings: BehaviorSettingsState = DEFAULT_BEHAVIOR_SETTINGS;
        let settingsGlobalBehaviorPrompt: string | undefined;
        if (settingsRes.ok) {
          const data = (await settingsRes.json()) as Record<string, unknown>;
          nextSettings = {
            ...nextSettings,
            responseStyleEnabled: data.responseStyleEnabled === true,
            responseStylePreset: sanitizeResponseStylePreset(data.responseStylePreset),
            responseStyleCustomInstructions: typeof data.responseStyleCustomInstructions === 'string'
              ? data.responseStyleCustomInstructions
              : '',
          };
          if (typeof data.globalBehaviorPrompt === 'string') {
            settingsGlobalBehaviorPrompt = data.globalBehaviorPrompt;
          }
        }

        // AGENTS.md is the source of truth for the system prompt — read it
        // first so that external edits are always reflected. Only fall back to
        // the persisted copy (globalBehaviorPrompt) when the file is missing
        // or empty.
        if (agentsMdRes.ok) {
          const agentsData = await agentsMdRes.json();
          if (typeof agentsData.content === 'string' && agentsData.content.trim()) {
            nextSettings = { ...nextSettings, prompt: agentsData.content };
          }
        }
        if (!nextSettings.prompt.trim() && typeof settingsGlobalBehaviorPrompt === 'string') {
          nextSettings = { ...nextSettings, prompt: settingsGlobalBehaviorPrompt };
        }

        setPrompt(nextSettings.prompt);
        setResponseStyleEnabled(nextSettings.responseStyleEnabled);
        setResponseStylePreset(nextSettings.responseStylePreset);
        setResponseStyleCustomInstructions(nextSettings.responseStyleCustomInstructions);
        setInitialPrompt(nextSettings.prompt);
        lastSavedResponseStyleRef.current = {
          enabled: nextSettings.responseStyleEnabled,
          preset: nextSettings.responseStylePreset,
          custom: nextSettings.responseStyleCustomInstructions,
        };
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.warn('Failed to load behavior settings:', error);
        }
      } finally {
        setIsLoading(false);
      }
    };

    void load();
    return () => abort.abort();
  }, []);

  React.useEffect(() => {
    if (isLoading) return;
    const last = lastSavedResponseStyleRef.current;
    if (
      last &&
      last.enabled === responseStyleEnabled &&
      last.preset === responseStylePreset &&
      last.custom === responseStyleCustomInstructions
    ) {
      return;
    }

    const next = {
      enabled: responseStyleEnabled,
      preset: responseStylePreset,
      custom: responseStyleCustomInstructions,
    };

    const timer = setTimeout(async () => {
      try {
        await saveBehaviorSetting({
          responseStyleEnabled: next.enabled,
          responseStylePreset: next.preset,
          responseStyleCustomInstructions: next.custom,
        }, t('settings.behavior.page.toast.saveFailed'));
        lastSavedResponseStyleRef.current = next;
      } catch (error) {
        const message = error instanceof Error ? error.message : t('settings.behavior.page.toast.saveFailed');
        toast.error(message);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [responseStyleEnabled, responseStylePreset, responseStyleCustomInstructions, isLoading, t]);

  const responseStylePreview = getResponseStylePreview(responseStylePreset, responseStyleCustomInstructions);
  const isPromptDirty = prompt !== initialPrompt;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const content = normalizeAgentsMdContent(prompt);
      const response = await runtimeFetch('/api/behavior/agents-md', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, t('settings.behavior.page.toast.saveFailed')));
      }

      await saveBehaviorSetting({
        globalBehaviorPrompt: content,
      }, t('settings.behavior.page.toast.saveFailed'));

      setPrompt(content);
      setInitialPrompt(content);
      toast.success(t('settings.behavior.page.toast.saved'));
    } catch (error) {
      console.error('Failed to save behavior:', error);
      const message = error instanceof Error ? error.message : t('settings.behavior.page.toast.saveFailed');
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SettingsPageLayout
      title={t('settings.behavior.page.title')}
      description={t('settings.page.behavior.description')}
      showSaveStatus
    >
      <SettingsSection
        title={t('settings.behavior.page.section.systemPrompt')}
        info={(
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {t('settings.behavior.page.warning.title')}
            </p>
            <p>
              {t('settings.behavior.page.warning.description', { path: AGENTS_MD_PATH })}
            </p>
          </div>
        )}
        divider={false}
        settingsItem="behavior.system-prompt"
        contentClassName="space-y-3"
      >
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('settings.behavior.page.field.systemPromptPlaceholder')}
          rows={12}
          disabled={isLoading}
          outerClassName="min-h-[160px] max-h-[70vh]"
          className="w-full font-mono typography-meta bg-transparent"
        />
        <Button
          onClick={handleSave}
          disabled={isSaving || !isPromptDirty || isLoading}
          size="xs"
          className="!font-normal"
        >
          {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
        </Button>
      </SettingsSection>

      <SettingsSection
        title={t('settings.behavior.page.section.responseStyle')}
        info={t('settings.behavior.page.responseStyle.tooltip')}
        settingsItem="behavior.response-style"
        contentClassName="space-y-3"
      >
        <SettingsCheckboxRow
          checked={responseStyleEnabled}
          onChange={setResponseStyleEnabled}
          disabled={isLoading}
          label={t('settings.behavior.page.responseStyle.enable')}
          ariaLabel={t('settings.behavior.page.responseStyle.enableAria')}
        />

        <SettingsFieldRow
          label={t('settings.behavior.page.responseStyle.preset')}
          alignEnd={false}
        >
          <Select<ResponseStyleValue>
            value={responseStylePreset}
            onValueChange={(value) => setResponseStylePreset(value)}
            disabled={isLoading || !responseStyleEnabled}
          >
            <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
              <SelectValue>
                {(value) => {
                  if (value === 'custom') return t('settings.behavior.page.responseStyle.option.custom');
                  if (isResponseStylePreset(value)) return t(RESPONSE_STYLE_OPTION_LABEL_KEYS[value]);
                  return null;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {RESPONSE_STYLE_PRESETS.map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {t(RESPONSE_STYLE_OPTION_LABEL_KEYS[preset])}
                </SelectItem>
              ))}
              <SelectItem value="custom">
                {t('settings.behavior.page.responseStyle.option.custom')}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsFieldRow>

        <Textarea
          value={responseStylePreview}
          onChange={(event) => setResponseStyleCustomInstructions(event.target.value)}
          placeholder={t('settings.behavior.page.responseStyle.customPlaceholder')}
          rows={5}
          disabled={isLoading || !responseStyleEnabled || responseStylePreset !== 'custom'}
          outerClassName="min-h-[120px]"
          className="w-full font-mono typography-meta bg-transparent"
        />
      </SettingsSection>
    </SettingsPageLayout>
  );
};
