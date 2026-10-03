import React from 'react';
import { z } from 'zod';
import { Textarea } from '@/components/ui/textarea';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
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
import { runtimeFetch } from '@/lib/runtime-fetch';
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
  SettingsCheckboxRow,
  SettingsFieldRow,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { resolveBehaviorPrompt, type BehaviorPromptSource } from './behaviorPrompt';

const agentsMdResponseSchema = z.object({
  content: z.string(),
  exists: z.boolean(),
  path: z.string().min(1).optional(),
});

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

export const BehaviorPage: React.FC = () => {
  const { t } = useI18n();
  const [prompt, setPrompt] = React.useState('');
  const [agentsMdPath, setAgentsMdPath] = React.useState('AGENTS.md');
  const [responseStyleEnabled, setResponseStyleEnabled] = React.useState(DEFAULT_BEHAVIOR_SETTINGS.responseStyleEnabled);
  const [responseStylePreset, setResponseStylePreset] = React.useState<ResponseStyleValue>(DEFAULT_BEHAVIOR_SETTINGS.responseStylePreset);
  const [responseStyleCustomInstructions, setResponseStyleCustomInstructions] = React.useState(DEFAULT_BEHAVIOR_SETTINGS.responseStyleCustomInstructions);
  const [isLoading, setIsLoading] = React.useState(true);
  // What is currently on disk. Every field is compared against this, so a save
  // writes only what actually changed and a refreshed value is never clobbered.
  const savedRef = React.useRef<BehaviorSettingsState | null>(null);
  // AGENTS.md exactly as last read or written (null: no file). A save sends it
  // so the server refuses to overwrite a file edited elsewhere in the meantime.
  const agentsMdOnDiskRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const abort = new AbortController();

    const load = async () => {
      try {
        const [data, agentsMdRes] = await Promise.all([
          loadDesktopSettings(),
          runtimeFetch('/api/behavior/agents-md', {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: abort.signal,
          }),
        ]);

        let nextSettings: BehaviorSettingsState = DEFAULT_BEHAVIOR_SETTINGS;
        let settingsGlobalBehaviorPrompt: string | undefined;
        if (data) {
          nextSettings = {
            ...nextSettings,
            responseStyleEnabled: data.responseStyleEnabled === true,
            responseStylePreset: sanitizeResponseStylePreset(data.responseStylePreset),
            responseStyleCustomInstructions: data.responseStyleCustomInstructions ?? '',
          };
          if (data.globalBehaviorPrompt !== undefined) {
            settingsGlobalBehaviorPrompt = data.globalBehaviorPrompt;
          }
        }

        // AGENTS.md is the source of truth OpenCode reads at runtime, so an
        // existing file is authoritative even when it is empty. The persisted
        // copy (globalBehaviorPrompt) is only a fallback for a missing file or
        // a failed read.
        let promptSource: BehaviorPromptSource = { kind: 'missing' };
        if (agentsMdRes.ok) {
          const agentsData = agentsMdResponseSchema.parse(await agentsMdRes.json());
          if (abort.signal.aborted) return;
          setAgentsMdPath(agentsData.path ?? 'AGENTS.md');
          agentsMdOnDiskRef.current = agentsData.exists ? agentsData.content : null;
          if (agentsData.exists) {
            promptSource = { kind: 'file', content: agentsData.content };
          }
        }
        nextSettings = {
          ...nextSettings,
          prompt: resolveBehaviorPrompt(promptSource, settingsGlobalBehaviorPrompt),
        };

        setPrompt(nextSettings.prompt);
        setResponseStyleEnabled(nextSettings.responseStyleEnabled);
        setResponseStylePreset(nextSettings.responseStylePreset);
        setResponseStyleCustomInstructions(nextSettings.responseStyleCustomInstructions);
        savedRef.current = nextSettings;
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

  // AGENTS.md is often edited in another editor while this page stays open.
  // Coming back to the window re-reads it; the editor follows only when it
  // holds no edit of its own, and a pending edit is guarded by the save.
  const promptRef = React.useRef(prompt);
  promptRef.current = prompt;
  React.useEffect(() => {
    let abort: AbortController | null = null;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || !savedRef.current) return;
      abort?.abort();
      const controller = new AbortController();
      abort = controller;
      try {
        const response = await runtimeFetch('/api/behavior/agents-md', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = agentsMdResponseSchema.parse(await response.json());
        const saved = savedRef.current;
        if (controller.signal.aborted || !saved || !data.exists) return;
        if (data.content === agentsMdOnDiskRef.current || promptRef.current !== saved.prompt) return;
        agentsMdOnDiskRef.current = data.content;
        savedRef.current = { ...saved, prompt: data.content };
        setPrompt(data.content);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) console.warn('Failed to refresh AGENTS.md:', error);
      }
    };
    const onRefresh = () => { void refresh(); };
    window.addEventListener('focus', onRefresh);
    document.addEventListener('visibilitychange', onRefresh);
    return () => {
      abort?.abort();
      window.removeEventListener('focus', onRefresh);
      document.removeEventListener('visibilitychange', onRefresh);
    };
  }, []);

  const save = React.useCallback(async (): Promise<AutosaveResult> => {
    const saved = savedRef.current;
    if (!saved || isLoading) return AUTOSAVE_UNCHANGED;

    const promptChanged = prompt !== saved.prompt;
    const settingsChanged =
      responseStyleEnabled !== saved.responseStyleEnabled ||
      responseStylePreset !== saved.responseStylePreset ||
      responseStyleCustomInstructions !== saved.responseStyleCustomInstructions;

    if (!promptChanged && !settingsChanged) return AUTOSAVE_UNCHANGED;

    // The prompt lives in AGENTS.md; the rest lives in OpenChamber settings.
    const content = promptChanged ? normalizeAgentsMdContent(prompt) : saved.prompt;
    if (promptChanged) {
      const response = await runtimeFetch('/api/behavior/agents-md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ content, expectedContent: agentsMdOnDiskRef.current }),
      });
      if (response.status === 409) {
        return autosaveFailed(t('settings.behavior.page.toast.agentsMdChangedOnDisk'));
      }
      if (!response.ok) {
        return autosaveFailed(await readApiError(response, t('settings.behavior.page.toast.saveFailed')));
      }
      agentsMdOnDiskRef.current = content;
      // Normalize only the submitted draft. A newer edit must survive this
      // response so the autosave follow-up can still write it.
      setPrompt((current) => current === prompt ? content : current);
    }

    const result = await updateDesktopSettings({
      ...(promptChanged ? { globalBehaviorPrompt: content } : {}),
      responseStyleEnabled,
      responseStylePreset,
      responseStyleCustomInstructions,
    });
    if (!result.ok) {
      return autosaveFailed(t('settings.behavior.page.toast.saveFailed'));
    }

    savedRef.current = {
      prompt: content,
      responseStyleEnabled,
      responseStylePreset,
      responseStyleCustomInstructions,
    };
    return AUTOSAVE_SAVED;
  }, [
    isLoading,
    prompt,
    responseStyleCustomInstructions,
    responseStyleEnabled,
    responseStylePreset,
    t,
  ]);

  const autosave = useAutosave(save);
  const { requestSave } = autosave;

  const responseStylePreview = getResponseStylePreview(responseStylePreset, responseStyleCustomInstructions);

  return (
    <SettingsPageLayout
      title={t('settings.behavior.page.title')}
      description={t('settings.page.behavior.description')}
      onBlurCapture={autosave.onBlurCapture}
    >
      <SettingsSection
        title={t('settings.behavior.page.section.systemPrompt')}
        divider={false}
        info={(
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {t('settings.behavior.page.warning.title')}
            </p>
            <p>
              {t('settings.behavior.page.warning.description', { path: agentsMdPath })}
            </p>
          </div>
        )}
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
      </SettingsSection>

      <SettingsSection
        title={t('settings.behavior.page.section.responseStyle')}
        info={t('settings.behavior.page.responseStyle.tooltip')}
        settingsItem="behavior.response-style"
        contentClassName="space-y-3"
      >
        <SettingsCheckboxRow
          checked={responseStyleEnabled}
          onChange={(next) => {
            setResponseStyleEnabled(next);
            requestSave();
          }}
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
            onValueChange={(value) => {
              setResponseStylePreset(value);
              requestSave();
            }}
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
