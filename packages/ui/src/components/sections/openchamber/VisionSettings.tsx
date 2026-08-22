import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsStackedField,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_CONTROL_CLUSTER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { cn } from '@/lib/utils';
import type { ModelMetadata } from '@/types';

const VISION_PROMPT_MAX_LENGTH = 4000;

interface VisionConfig {
  model: string;
  prompt?: string;
}

interface VisionSettingsResponse {
  config: VisionConfig | null;
  defaultPrompt: string;
}

// Only image-input models make sense here; models the catalog cannot judge are
// kept visible so custom providers are not silently dropped — the server
// re-validates the capability before every run.
const isVisionCapableModel = (metadata: ModelMetadata | undefined): boolean => {
  if (!metadata) return true;
  const input = metadata.modalities?.input;
  if (Array.isArray(input) && input.length > 0) return input.includes('image');
  if (typeof metadata.attachment === 'boolean') return metadata.attachment;
  return true;
};

const readApiError = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = await response.json();
    if (typeof body?.error === 'string' && body.error.trim().length > 0) {
      return body.error;
    }
  } catch {
    // fall through to the generic message
  }
  return fallback;
};

export const VisionSettings: React.FC = () => {
  const { t } = useI18n();
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);

  const [config, setConfig] = React.useState<VisionConfig | null>(null);
  const [defaultPrompt, setDefaultPrompt] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [model, setModel] = React.useState('');
  const [promptDraft, setPromptDraft] = React.useState('');

  const isModelAllowed = React.useCallback(
    (providerId: string, modelId: string) => isVisionCapableModel(getModelMetadata(providerId, modelId)),
    [getModelMetadata],
  );

  const isPromptDirty = promptDraft !== (config?.prompt?.trim() ? config.prompt : defaultPrompt);

  React.useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await runtimeFetch('/api/openchamber/vision', { signal: controller.signal });
        if (!response.ok) {
          throw new Error(await readApiError(response, t('settings.vision.toast.loadFailed')));
        }
        const data = (await response.json()) as VisionSettingsResponse;
        if (controller.signal.aborted) return;
        const loadedConfig = data.config;
        setConfig(loadedConfig);
        setDefaultPrompt(data.defaultPrompt);
        setModel(loadedConfig?.model ?? '');
        setPromptDraft(loadedConfig?.prompt?.trim() ? loadedConfig.prompt : data.defaultPrompt);
      } catch {
        if (controller.signal.aborted) return;
        toast.error(t('settings.vision.toast.loadFailed'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [t]);

  const persistConfig = React.useCallback(async (next: { model?: string; prompt?: string }): Promise<VisionConfig | null> => {
    reportSettingsSaveState('saving');
    try {
      const response = await runtimeFetch('/api/openchamber/vision', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(next),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, t('settings.vision.toast.saveFailed')));
      }
      const data = (await response.json()) as { config?: VisionConfig | null };
      reportSettingsSaveState('saved');
      // The server returns the merged config (authoritative); fall back to
      // merging the submitted fields over the last known config if absent.
      if (data.config) return data.config;
      const fallbackModel = next.model ?? config?.model;
      return fallbackModel ? { model: fallbackModel, ...(next.prompt !== undefined ? { prompt: next.prompt } : {}) } : null;
    } catch (error) {
      reportSettingsSaveState('error');
      throw error;
    }
  }, [config, t]);

  const handleModelChange = React.useCallback(async (providerId: string, modelId: string) => {
    const nextModel = providerId && modelId ? `${providerId}/${modelId}` : '';
    setModel(nextModel);
    if (!nextModel) return;
    try {
      // Send only the model; the server merges it with the persisted prompt,
      // so a concurrent prompt save is never clobbered by a stale model save.
      const persisted = await persistConfig({ model: nextModel });
      setConfig(persisted);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.vision.toast.saveFailed'));
    }
  }, [persistConfig, t]);

  const handleSavePrompt = React.useCallback(async () => {
    setSaving(true);
    try {
      // Send only the prompt; the server merges it with the persisted model,
      // so a concurrent model change is never clobbered by a stale prompt save.
      const persisted = await persistConfig({ prompt: promptDraft });
      setConfig(persisted);
      setPromptDraft(promptDraft.trim() || defaultPrompt);
      toast.success(t('settings.vision.toast.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.vision.toast.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [defaultPrompt, persistConfig, promptDraft, t]);

  const handleResetPrompt = React.useCallback(() => {
    setPromptDraft(defaultPrompt);
    if (!model) return;
    void (async () => {
      try {
        setSaving(true);
        // An empty prompt clears the persisted prompt (the server default
        // applies at call time) while keeping the model.
        const persisted = await persistConfig({ prompt: '' });
        setConfig(persisted);
        toast.success(t('settings.vision.toast.saved'));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('settings.vision.toast.saveFailed'));
      } finally {
        setSaving(false);
      }
    })();
  }, [defaultPrompt, model, persistConfig, t]);

  const parsedModel = React.useMemo(() => parseModelIdentifier(model), [model]);

  return (
    <SettingsSection title={t('settings.vision.section.title')} info={t('settings.vision.section.info')} divider={false}>
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <SettingsFieldRow
          label={t('settings.vision.model.label')}
          info={t('settings.vision.model.info')}
          settingsItem="vision.model"
        >
          <div className={cn(SETTINGS_CONTROL_CLUSTER_CLASS, 'min-w-0')}>
            <ModelSelector
              providerId={parsedModel?.providerId ?? ''}
              modelId={parsedModel?.modelId ?? ''}
              onChange={handleModelChange}
              isModelAllowed={isModelAllowed}
              placeholder={loading ? t('common.loading') : t('settings.vision.model.notSelected')}
            />
          </div>
        </SettingsFieldRow>

        <SettingsStackedField
          label={t('settings.vision.prompt.label')}
          info={t('settings.vision.prompt.info')}
          settingsItem="vision.prompt"
        >
          <Textarea
            value={promptDraft}
            onChange={(event) => setPromptDraft(event.target.value)}
            placeholder={t('settings.vision.prompt.placeholder')}
            rows={8}
            disabled={loading || saving}
            maxLength={VISION_PROMPT_MAX_LENGTH}
            outerClassName="min-h-[140px] max-h-[60vh]"
            className="w-full font-mono typography-meta bg-transparent"
            aria-label={t('settings.vision.prompt.label')}
          />
          <div className="flex items-center justify-between gap-2">
            <span className={SETTINGS_HELPER_CLASS}>
              {promptDraft.length} / {VISION_PROMPT_MAX_LENGTH}
            </span>
            <div className="flex items-center gap-2">
              {promptDraft !== defaultPrompt && (
                <Button variant="ghost" size="xs" onClick={handleResetPrompt} disabled={saving}>
                  <Icon name="refresh" className="size-3.5" />
                  {t('settings.vision.prompt.reset')}
                </Button>
              )}
              <Button variant="default" size="sm" onClick={handleSavePrompt} disabled={saving || !model || !isPromptDirty}>
                {t('settings.vision.prompt.save')}
              </Button>
            </div>
          </div>
          {!model && !loading && (
            <p className="typography-meta text-[var(--status-warning)]">{t('settings.vision.model.required')}</p>
          )}
        </SettingsStackedField>
      </div>
    </SettingsSection>
  );
};
