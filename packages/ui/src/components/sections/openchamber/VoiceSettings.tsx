import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDeviceInfo } from '@/lib/device';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Radio } from '@/components/ui/radio';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Icon } from "@/components/icon/Icon";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
    SettingsSection,
    SettingsCheckboxRow,
    SettingsFieldRow,
    SettingsStackedField,
    SettingsChipGroup,
    SETTINGS_NUMBER_INPUT_CLASS,
    SETTINGS_SELECT_ROW_TRIGGER_CLASS,
    SETTINGS_CONTROL_CLUSTER_CLASS,
    SETTINGS_HELPER_CLASS,
    SETTINGS_ICON_BUTTON_CLASS,
    SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { cn } from '@/lib/utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useI18n } from '@/lib/i18n';
import { useLocalTTS } from '@/hooks/useLocalTTS';
import { disposePreviewAudio } from './voicePreviewAudio';
import { toast } from '@/components/ui';
import type { VoiceApiKeyKind } from '@/lib/voiceKeysApi';
import { Spinner } from '@/components/ui/spinner';
import { SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';
import { selectSmallModelAvailability, useSmallModelStore } from '@/stores/useSmallModelStore';
import { useUIStore } from '@/stores/useUIStore';

const VOICE_TEXT_INPUT_CLASS = 'oc-surface-elevated oc-raised oc-field w-full min-w-0 h-8 rounded-md bg-surface-elevated px-3 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none';

// languageHint: the model takes the dictation language instead of detecting it.
const LOCAL_STT_MODELS = [
    {
        id: 'parakeet-tdt-0.6b-v2-int8',
        labelKey: 'settings.voice.page.stt.model.parakeetV2',
        badgeKey: 'settings.voice.page.stt.badge.bestForEnglish',
        accuracy: 5,
        speed: 5,
        size: '460 MB',
        languageHint: false,
    },
    {
        id: 'parakeet-tdt-0.6b-v3-int8',
        labelKey: 'settings.voice.page.stt.model.parakeetV3',
        badgeKey: 'settings.voice.page.stt.badge.bestForMultilingual',
        accuracy: 5,
        speed: 4,
        size: '465 MB',
        languageHint: false,
    },
    {
        id: 'whisper-large-v3-turbo-int8',
        labelKey: 'settings.voice.page.stt.model.whisperTurbo',
        badgeKey: null,
        accuracy: 4,
        speed: 1,
        size: '1 GB',
        languageHint: true,
    },
    {
        id: 'qwen3-asr-0.6b-int8',
        labelKey: 'settings.voice.page.stt.model.qwen3Asr',
        badgeKey: null,
        accuracy: 4,
        speed: 3,
        size: '1 GB',
        languageHint: true,
    },
    {
        id: 'whisper-tiny-int8',
        labelKey: 'settings.voice.page.stt.model.whisperTiny',
        badgeKey: null,
        accuracy: 2,
        speed: 4,
        size: '115 MB',
        languageHint: true,
    },
] as const;

interface DictationModelState {
    id: string;
    description?: string;
    installed: boolean;
    downloading: boolean;
    downloadProgress: number | null;
    downloadError: string | null;
}

const RatingBar = ({ value, label }: { value: number; label: string }) => (
    <span className="flex items-center gap-1.5" title={`${label}: ${value}/5`}>
        <span className="typography-micro text-muted-foreground">{label}</span>
        <span
            className="h-1.5 w-8 flex-shrink-0 overflow-hidden rounded-full bg-[var(--interactive-border)]"
            aria-hidden="true"
        >
            <span
                className="block h-full rounded-full bg-[var(--primary-base)]"
                style={{ width: `${(value / 5) * 100}%` }}
            />
        </span>
    </span>
);

const LocalModelPicker = ({
    savedModelId,
    onSelect,
}: {
    savedModelId: string;
    onSelect: (modelId: string) => void;
}) => {
    const { t } = useI18n();
    const tUnsafe = useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
    const [models, setModels] = useState<Map<string, DictationModelState>>(new Map());
    const [activeModelId, setActiveModelId] = useState<string | null>(null);
    const [requestingId, setRequestingId] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const response = await runtimeFetch('/api/dictation/status', {
                query: { provider: 'local', localModel: savedModelId },
            });
            if (!response.ok) {
                return;
            }
            const data = await response.json();
            if (Array.isArray(data?.models)) {
                setModels(new Map(data.models.map((m: DictationModelState) => [m.id, m])));
            }
            setActiveModelId(data?.activeModel ?? null);
        } catch {
            // Display-only status; keep the previous state on fetch failure.
        }
    }, [savedModelId]);

    // Until the user picks a model, or when the saved one left the list, the
    // server chooses; show its choice as the selected one.
    const selectedModelId = LOCAL_STT_MODELS.some((entry) => entry.id === savedModelId) ? savedModelId : activeModelId;

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const anyDownloading = Array.from(models.values()).some((m) => m.downloading);
    useEffect(() => {
        if (!anyDownloading) {
            return;
        }
        const interval = setInterval(() => {
            void refresh();
        }, 2000);
        return () => clearInterval(interval);
    }, [anyDownloading, refresh]);

    const handleDownload = async (modelId: string) => {
        setRequestingId(modelId);
        try {
            await runtimeFetch(`/api/dictation/models/${encodeURIComponent(modelId)}/download`, {
                method: 'POST',
            });
            await refresh();
        } catch {
            // Status refresh reports errors.
        } finally {
            setRequestingId(null);
        }
    };

    const handleDelete = async (modelId: string) => {
        setRequestingId(modelId);
        try {
            await runtimeFetch(`/api/dictation/models/${encodeURIComponent(modelId)}`, {
                method: 'DELETE',
            });
            await refresh();
        } catch {
            // Status refresh reports errors.
        } finally {
            setRequestingId(null);
        }
    };

    return (
        <div
            role="radiogroup"
            aria-label={t('settings.voice.page.field.model')}
            className="grid w-full grid-cols-1 gap-2 @3xl:grid-cols-2"
        >
            {LOCAL_STT_MODELS.map((entry) => {
                const selected = selectedModelId === entry.id;
                const state = models.get(entry.id) ?? null;
                return (
                    // A tile by tone, the chosen one in the selection colours:
                    // the cards are options, not boxes around options.
                    <div
                        key={entry.id}
                        className={cn(
                            'flex items-start gap-2 rounded-lg px-3 py-2.5',
                            selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'oc-tile',
                        )}
                    >
                        <div
                            className="flex min-w-0 flex-1 cursor-pointer items-start gap-2"
                            role="button"
                            tabIndex={0}
                            onClick={() => onSelect(entry.id)}
                            onKeyDown={(e) => {
                                if (e.key === ' ' || e.key === 'Enter') {
                                    e.preventDefault();
                                    onSelect(entry.id);
                                }
                            }}
                        >
                            <div className="pt-0.5">
                                <Radio
                                    checked={selected}
                                    onChange={() => onSelect(entry.id)}
                                    ariaLabel={tUnsafe(entry.labelKey)}
                                />
                            </div>
                            <div className="min-w-0 flex-1 space-y-1">
                                <div className="typography-ui-label truncate text-foreground" title={tUnsafe(entry.labelKey)}>
                                    {tUnsafe(entry.labelKey)}
                                </div>
                                {entry.badgeKey ? (
                                    <span className="inline-block rounded-full bg-[var(--status-success)]/15 px-2 py-px text-[0.625rem] font-medium text-[var(--status-success)]">
                                        {tUnsafe(entry.badgeKey)}
                                    </span>
                                ) : null}
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <RatingBar value={entry.accuracy} label={t('settings.voice.page.stt.meta.accuracy')} />
                                    <RatingBar value={entry.speed} label={t('settings.voice.page.stt.meta.speed')} />
                                    <span className="typography-micro tabular-nums text-muted-foreground">{entry.size}</span>
                                </div>
                                {state?.downloadError ? (
                                    <p className="typography-meta text-[var(--status-error)]">{state.downloadError}</p>
                                ) : null}
                            </div>
                        </div>
                        <div className="flex h-6 shrink-0 items-center gap-1">
                            {state?.installed ? (
                                <>
                                    <Icon
                                        name="checkbox-circle"
                                        className="h-4 w-4 flex-shrink-0 text-[var(--status-success)]"
                                        aria-label={t('settings.voice.page.stt.modelInstalled')}
                                    />
                                    <Button
                                        variant="ghost"
                                        size="xs"
                                        className="h-6 w-6 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                                        disabled={requestingId === entry.id}
                                        onClick={() => { void handleDelete(entry.id); }}
                                        title={t('settings.voice.page.stt.modelDelete')}
                                        aria-label={t('settings.voice.page.stt.modelDelete')}
                                    >
                                        <Icon name="delete-bin" className="h-4 w-4" />
                                    </Button>
                                </>
                            ) : state?.downloading ? (
                                <span className="flex items-center gap-1.5">
                                    <Spinner className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="typography-ui-compact tabular-nums text-muted-foreground">
                                        {typeof state.downloadProgress === 'number' ? `${state.downloadProgress}%` : ''}
                                    </span>
                                </span>
                            ) : (
                                <Button
                                    variant="ghost"
                                    size="xs"
                                    className="h-6 w-6 p-0"
                                    disabled={requestingId === entry.id}
                                    onClick={() => { void handleDownload(entry.id); }}
                                    title={t('settings.voice.page.stt.modelDownload')}
                                    aria-label={t('settings.voice.page.stt.modelDownload')}
                                >
                                    <Icon name="download" className="h-4 w-4" />
                                </Button>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

const openSmallModelSettings = (): void => {
    useUIStore.getState().requestSettingsJump('sessions', 'sessions.small-model');
};

/**
 * Off by default: the pass sends the dictated text to the Small Model's
 * provider. Without a Small Model the server inserts the text as heard, so
 * the row says so instead of pretending to fix anything.
 */
const TranscriptCorrectionRow = () => {
    const { t } = useI18n();
    const enabled = useConfigStore((state) => state.sttCorrectTranscript);
    const setEnabled = useConfigStore((state) => state.setSttCorrectTranscript);
    const ensureSmallModel = useSmallModelStore((state) => state.ensureFresh);
    const smallModel = useSmallModelStore((state) => selectSmallModelAvailability(state, null));

    useEffect(() => {
        if (enabled) {
            void ensureSmallModel(null);
        }
    }, [enabled, ensureSmallModel]);

    return (
        <SettingsCheckboxRow
            checked={enabled}
            onChange={setEnabled}
            label={t('settings.voice.page.field.correctTranscript')}
            info={t('settings.voice.page.field.correctTranscriptInfo')}
            footer={enabled ? (
                <p className={SETTINGS_HELPER_CLASS}>
                    {smallModel === 'unavailable' ? (
                        <>{t('settings.voice.page.field.correctTranscriptUnavailable')}{' '}</>
                    ) : null}
                    <SettingsInlineLink onClick={openSmallModelSettings}>
                        {t('settings.voice.page.field.correctTranscriptModelLink')}
                    </SettingsInlineLink>
                </p>
            ) : null}
        />
    );
};

/** Kokoro en_v0_19 speaker ids in sherpa-onnx order. */
const KOKORO_VOICE_OPTIONS = [
    { id: 0, label: 'Alloy (af)' },
    { id: 1, label: 'Bella (af)' },
    { id: 2, label: 'Nicole (af)' },
    { id: 3, label: 'Sarah (af)' },
    { id: 4, label: 'Sky (af)' },
    { id: 5, label: 'Adam (am)' },
    { id: 6, label: 'Michael (am)' },
    { id: 7, label: 'Emma (bf)' },
    { id: 8, label: 'Isabella (bf)' },
    { id: 9, label: 'George (bm)' },
    { id: 10, label: 'Lewis (bm)' },
];

const LOCAL_TTS_MODEL_ID = 'kokoro-en-v0_19';

const KOKORO_MULTI_LANG_MODEL_ID = 'kokoro-multi-lang-v1_1';
// A few named speakers out of the 103 in the Chinese/English Kokoro build.
const KOKORO_MULTI_LANG_VOICE_OPTIONS = [
    { id: 0, label: 'Maple (af)' },
    { id: 1, label: 'Sol (af)' },
    { id: 2, label: 'Vale (bf)' },
    { id: 3, label: 'Xiaoxiao (zf)' },
    { id: 58, label: 'Yunxi (zm)' },
];

interface LocalTtsVoiceOption {
    modelId: string;
    speakerId: number;
    label: string;
}

const localTtsVoiceKey = (modelId: string, speakerId: number): string => `${modelId}:${speakerId}`;

/**
 * Local TTS models as the server reports them, plus the actions Settings
 * offers on them. Shared by the model list and the voice picker so both see
 * the same install state.
 */
const useLocalTtsModels = () => {
    const [models, setModels] = useState<DictationModelState[]>([]);
    const [requestingId, setRequestingId] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const response = await runtimeFetch('/api/dictation/status', { query: { provider: 'local' } });
            if (!response.ok) {
                return;
            }
            const data = await response.json();
            if (Array.isArray(data?.ttsModels)) {
                setModels(data.ttsModels);
            }
        } catch {
            // Display-only status; keep the previous state on fetch failure.
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const anyDownloading = models.some((model) => model.downloading);
    useEffect(() => {
        if (!anyDownloading) {
            return;
        }
        const interval = setInterval(() => {
            void refresh();
        }, 2000);
        return () => clearInterval(interval);
    }, [anyDownloading, refresh]);

    const request = useCallback(async (modelId: string, method: 'POST' | 'DELETE') => {
        setRequestingId(modelId);
        try {
            const path = method === 'POST'
                ? `/api/dictation/models/${modelId}/download`
                : `/api/dictation/models/${modelId}`;
            await runtimeFetch(path, { method });
            await refresh();
        } catch {
            // Status refresh reports errors.
        } finally {
            setRequestingId(null);
        }
    }, [refresh]);

    return { models, requestingId, request, refresh };
};

// Voices the picker offers: Kokoro speakers for the Kokoro models, one voice
// per installed Piper model. Only installed models (plus the default) appear,
// so a language model the server fetched on its own becomes selectable once
// it is on disk.
const buildLocalTtsVoiceOptions = (models: DictationModelState[]): LocalTtsVoiceOption[] => {
    const options: LocalTtsVoiceOption[] = KOKORO_VOICE_OPTIONS.map((voice) => ({
        modelId: LOCAL_TTS_MODEL_ID,
        speakerId: voice.id,
        label: voice.label,
    }));
    for (const model of models) {
        if (model.id === LOCAL_TTS_MODEL_ID || !model.installed) continue;
        if (model.id === KOKORO_MULTI_LANG_MODEL_ID) {
            for (const voice of KOKORO_MULTI_LANG_VOICE_OPTIONS) {
                options.push({ modelId: model.id, speakerId: voice.id, label: `${voice.label} · Kokoro zh/en` });
            }
            continue;
        }
        options.push({ modelId: model.id, speakerId: 0, label: model.description ?? model.id });
    }
    return options;
};

const LocalTtsModelRow = ({
    model,
    requestingId,
    request,
    t,
}: {
    model: DictationModelState;
    requestingId: string | null;
    request: (modelId: string, method: 'POST' | 'DELETE') => Promise<void>;
    t: ReturnType<typeof useI18n>['t'];
}) => (
    <div className="flex items-center gap-2 py-1.5">
        <span className="typography-ui-label text-foreground">{model.description ?? model.id}</span>
        {model.installed ? (
            <>
                <Icon
                    name="checkbox-circle"
                    className="h-4 w-4 text-[var(--status-success)]"
                    aria-label={t('settings.voice.page.stt.modelInstalled')}
                />
                <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                    disabled={requestingId !== null}
                    onClick={() => { void request(model.id, 'DELETE'); }}
                    title={t('settings.voice.page.stt.modelDelete')}
                    aria-label={t('settings.voice.page.stt.modelDelete')}
                >
                    <Icon name="delete-bin" className="h-4 w-4" />
                </Button>
            </>
        ) : model.downloading ? (
            <span className="flex items-center gap-1.5">
                <Spinner className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="typography-ui-compact tabular-nums text-muted-foreground">
                    {typeof model.downloadProgress === 'number' ? `${model.downloadProgress}%` : ''}
                </span>
            </span>
        ) : (
            <Button
                variant="ghost"
                size="xs"
                className="h-6 w-6 p-0"
                disabled={requestingId !== null}
                onClick={() => { void request(model.id, 'POST'); }}
                title={t('settings.voice.page.stt.modelDownload')}
                aria-label={t('settings.voice.page.stt.modelDownload')}
            >
                <Icon name="download" className="h-4 w-4" />
            </Button>
        )}
        {model.downloadError ? (
            <span className="typography-meta text-[var(--status-error)]">{model.downloadError}</span>
        ) : null}
    </div>
);

const LocalTtsModelStatus = ({ models, requestingId, request }: ReturnType<typeof useLocalTtsModels>) => {
    const { t } = useI18n();
    const [availableOpen, setAvailableOpen] = useState(false);
    const [filter, setFilter] = useState('');

    if (models.length === 0) {
        return null;
    }

    // Installed models, anything downloading or in an error state, and the
    // default English model stay inline where the user expects them; the rest
    // of the catalog sits behind a collapse so the panel does not flood with
    // 14 rows.
    const inline: DictationModelState[] = [];
    const available: DictationModelState[] = [];
    for (const model of models) {
        if (model.id === LOCAL_TTS_MODEL_ID || model.installed || model.downloading || model.downloadError) {
            inline.push(model);
        } else {
            available.push(model);
        }
    }

    const query = filter.trim().toLowerCase();
    const filtered = query
        ? available.filter((m) =>
            (m.description ?? '').toLowerCase().includes(query) ||
            m.id.toLowerCase().includes(query))
        : available;

    return (
        <div className="flex flex-col">
            {inline.map((model) => (
                <LocalTtsModelRow
                    key={model.id}
                    model={model}
                    requestingId={requestingId}
                    request={request}
                    t={t}
                />
            ))}
            {available.length > 0 ? (
                <Collapsible open={availableOpen} onOpenChange={setAvailableOpen}>
                    <CollapsibleTrigger className="group flex w-full items-center justify-between py-1 hover:bg-transparent">
                        <div className="flex items-center gap-1.5 text-start">
                            <span className="typography-ui-label font-normal text-foreground">
                                {t('settings.voice.page.localTts.availableToDownload')}
                            </span>
                            <span className="typography-micro text-muted-foreground">
                                ({available.length})
                            </span>
                        </div>
                        <Icon
                            name={availableOpen ? 'arrow-down-s' : 'arrow-right-s'}
                            className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground"
                        />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-1">
                        <input
                            type="text"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            placeholder={t('settings.voice.page.localTts.filterPlaceholder')}
                            aria-label={t('settings.voice.page.localTts.filterPlaceholder')}
                            className={cn(VOICE_TEXT_INPUT_CLASS, 'mb-1')}
                        />
                        {filtered.length === 0 ? (
                            <div className="typography-meta py-1.5 text-muted-foreground">
                                {t('settings.voice.page.localTts.filterNoMatch')}
                            </div>
                        ) : (
                            filtered.map((model) => (
                                <LocalTtsModelRow
                                    key={model.id}
                                    model={model}
                                    requestingId={requestingId}
                                    request={request}
                                    t={t}
                                />
                            ))
                        )}
                    </CollapsibleContent>
                </Collapsible>
            ) : null}
        </div>
    );
};

const OPENAI_VOICE_OPTIONS = [
    { value: 'alloy', label: 'Alloy' },
    { value: 'ash', label: 'Ash' },
    { value: 'ballad', label: 'Ballad' },
    { value: 'coral', label: 'Coral' },
    { value: 'echo', label: 'Echo' },
    { value: 'fable', label: 'Fable' },
    { value: 'nova', label: 'Nova' },
    { value: 'onyx', label: 'Onyx' },
    { value: 'sage', label: 'Sage' },
    { value: 'shimmer', label: 'Shimmer' },
    { value: 'verse', label: 'Verse' },
    { value: 'marin', label: 'Marin' },
    { value: 'cedar', label: 'Cedar' },
];

/**
 * A voice API key is kept on the server, never in the browser. The field
 * shows whether one is saved; typing a new key and pressing Enter (or leaving
 * the field) replaces it, the cross removes it.
 */
const VoiceApiKeyField: React.FC<{ kind: VoiceApiKeyKind }> = ({ kind }) => {
    const { t } = useI18n();
    const saved = useConfigStore((state) => state.voiceApiKeys[kind]);
    const setVoiceApiKey = useConfigStore((state) => state.setVoiceApiKey);
    const [draft, setDraft] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const save = useCallback(async (value: string | null) => {
        setIsSaving(true);
        const ok = await setVoiceApiKey(kind, value);
        setIsSaving(false);
        if (ok) {
            setDraft('');
        } else {
            toast.error(t('settings.voice.page.toast.apiKeySaveFailed'));
        }
    }, [kind, setVoiceApiKey, t]);

    const commitDraft = useCallback(() => {
        const value = draft.trim();
        if (value) void save(value);
    }, [draft, save]);

    return (
        <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
            <input
                type="password"
                value={draft}
                disabled={isSaving}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitDraft}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commitDraft();
                }}
                placeholder={saved ? t('settings.voice.page.field.apiKeySavedPlaceholder') : 'sk-...'}
                className={VOICE_TEXT_INPUT_CLASS}
                aria-label={t('settings.voice.page.field.apiKey')}
            />
            {saved && !draft && (
                <button
                    type="button"
                    onClick={() => void save(null)}
                    disabled={isSaving}
                    aria-label={t('settings.voice.page.field.apiKeyRemove')}
                    className="absolute inset-e-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                    <Icon name="close" className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    );
};

export const VoiceSettings: React.FC = () => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const setVoiceProvider = useConfigStore((state) => state.setVoiceProvider);
    const speechRate = useConfigStore((state) => state.speechRate);
    const setSpeechRate = useConfigStore((state) => state.setSpeechRate);
    const speechPitch = useConfigStore((state) => state.speechPitch);
    const setSpeechPitch = useConfigStore((state) => state.setSpeechPitch);
    const speechVolume = useConfigStore((state) => state.speechVolume);
    const setSpeechVolume = useConfigStore((state) => state.setSpeechVolume);
    const sayVoice = useConfigStore((state) => state.sayVoice);
    const setSayVoice = useConfigStore((state) => state.setSayVoice);
    const localTtsVoiceId = useConfigStore((state) => state.localTtsVoiceId);
    const localTtsModelId = useConfigStore((state) => state.localTtsModelId);
    const setLocalTtsModelId = useConfigStore((state) => state.setLocalTtsModelId);
    const localTtsModels = useLocalTtsModels();
    const localTtsVoiceOptions = useMemo(() => buildLocalTtsVoiceOptions(localTtsModels.models), [localTtsModels.models]);
    const ttsFollowTextLanguage = useConfigStore((state) => state.ttsFollowTextLanguage);
    const setTtsFollowTextLanguage = useConfigStore((state) => state.setTtsFollowTextLanguage);
    const setLocalTtsVoiceId = useConfigStore((state) => state.setLocalTtsVoiceId);
    const { speak: speakLocalTts, stop: stopLocalTts, isPlaying: isLocalTtsPlaying, error: localTtsError } = useLocalTTS();

    const previewLocalVoice = useCallback(() => {
        if (isLocalTtsPlaying) {
            stopLocalTts();
            return;
        }
        const voiceLabel = localTtsVoiceOptions.find((v) => v.modelId === localTtsModelId && v.speakerId === localTtsVoiceId)?.label
            ?? String(localTtsVoiceId);
        void speakLocalTts(t('settings.voice.page.preview.voiceLine', { voiceName: voiceLabel }), {
            model: localTtsModelId,
            speakerId: localTtsVoiceId,
            speed: useConfigStore.getState().speechRate,
        });
    }, [isLocalTtsPlaying, localTtsModelId, localTtsVoiceId, localTtsVoiceOptions, speakLocalTts, stopLocalTts, t]);
    const browserVoice = useConfigStore((state) => state.browserVoice);
    const setBrowserVoice = useConfigStore((state) => state.setBrowserVoice);
    const openaiVoice = useConfigStore((state) => state.openaiVoice);
    const setOpenaiVoice = useConfigStore((state) => state.setOpenaiVoice);
    const hasOpenaiApiKey = useConfigStore((state) => state.voiceApiKeys.openai);
    const refreshVoiceApiKeys = useConfigStore((state) => state.refreshVoiceApiKeys);
    const openaiCompatibleUrl = useConfigStore((state) => state.openaiCompatibleUrl);
    const setOpenaiCompatibleUrl = useConfigStore((state) => state.setOpenaiCompatibleUrl);
    const openaiCompatibleVoice = useConfigStore((state) => state.openaiCompatibleVoice);
    const setOpenaiCompatibleVoice = useConfigStore((state) => state.setOpenaiCompatibleVoice);
    const openaiCompatibleTtsModel = useConfigStore((state) => state.openaiCompatibleTtsModel);
    const setOpenaiCompatibleTtsModel = useConfigStore((state) => state.setOpenaiCompatibleTtsModel);
    const openaiCompatibleTtsEndpointPath = useConfigStore((state) => state.openaiCompatibleTtsEndpointPath);
    const setOpenaiCompatibleTtsEndpointPath = useConfigStore((state) => state.setOpenaiCompatibleTtsEndpointPath);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const autoReadAloudEnabled = useConfigStore((state) => state.autoReadAloudEnabled);
    const ttsInputMode = useConfigStore((state) => state.ttsInputMode);
    const setTtsInputMode = useConfigStore((state) => state.setTtsInputMode);
    const ttsChunkedMode = useConfigStore((state) => state.ttsChunkedMode);
    const setTtsChunkedMode = useConfigStore((state) => state.setTtsChunkedMode);
    // STT settings
    const sttProvider = useConfigStore((state) => state.sttProvider);
    const setSttProvider = useConfigStore((state) => state.setSttProvider);
    const sttServerUrl = useConfigStore((state) => state.sttServerUrl);
    const setSttServerUrl = useConfigStore((state) => state.setSttServerUrl);
    const sttModel = useConfigStore((state) => state.sttModel);
    const setSttModel = useConfigStore((state) => state.setSttModel);
    const sttEndpointPath = useConfigStore((state) => state.sttEndpointPath);
    const setSttEndpointPath = useConfigStore((state) => state.setSttEndpointPath);
    const sttLocalModel = useConfigStore((state) => state.sttLocalModel);
    const setSttLocalModel = useConfigStore((state) => state.setSttLocalModel);
    const sttLanguage = useConfigStore((state) => state.sttLanguage);
    const setSttLanguage = useConfigStore((state) => state.setSttLanguage);
    const setShowMessageTTSButtons = useConfigStore((state) => state.setShowMessageTTSButtons);
    const setAutoReadAloudEnabled = useConfigStore((state) => state.setAutoReadAloudEnabled);
    // Voice pickers and previews follow either entry point: the message button
    // or automatic reading.
    const voicePlaybackEnabled = showMessageTTSButtons || autoReadAloudEnabled;
    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const setDictationEnabled = useConfigStore((state) => state.setDictationEnabled);
    const dictationAutoSend = useConfigStore((state) => state.dictationAutoSend);
    const setDictationAutoSend = useConfigStore((state) => state.setDictationAutoSend);

    const [isSayAvailable, setIsSayAvailable] = useState(false);
    const [sayVoices, setSayVoices] = useState<Array<{ name: string; locale: string }>>([]);
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
    const [previewAudio, setPreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [isOpenAIAvailable, setIsOpenAIAvailable] = useState(false);
    // The server refuses cloud speech and remote custom servers; this only explains why.
    const [voiceEnterpriseMode, setVoiceEnterpriseMode] = useState(false);
    const [isOpenAIPreviewPlaying, setIsOpenAIPreviewPlaying] = useState(false);
    const [openaiPreviewAudio, setOpenaiPreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [isCompatiblePreviewPlaying, setIsCompatiblePreviewPlaying] = useState(false);
    const [compatiblePreviewAudio, setCompatiblePreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [isBrowserPreviewPlaying, setIsBrowserPreviewPlaying] = useState(false);

    useEffect(() => {
        const loadVoices = async () => {
            const voices = await browserVoiceService.waitForVoices();
            setBrowserVoices(voices);
        };
        loadVoices();

        if ('speechSynthesis' in window) {
            window.speechSynthesis.onvoiceschanged = () => {
                setBrowserVoices(window.speechSynthesis.getVoices());
            };
        }

        return () => {
            if ('speechSynthesis' in window) {
                window.speechSynthesis.onvoiceschanged = null;
            }
        };
    }, []);

    const filteredBrowserVoices = useMemo(() => {
        return browserVoices
            .filter(v => v.lang)
            .sort((a, b) => {
                const aIsEnglish = a.lang.startsWith('en');
                const bIsEnglish = b.lang.startsWith('en');
                if (aIsEnglish && !bIsEnglish) return -1;
                if (!aIsEnglish && bIsEnglish) return 1;
                const langCompare = a.lang.localeCompare(b.lang);
                if (langCompare !== 0) return langCompare;
                return a.name.localeCompare(b.name);
            });
    }, [browserVoices]);

    const previewBrowserVoice = useCallback(() => {
        if (isBrowserPreviewPlaying) {
            browserVoiceService.cancelSpeech();
            setIsBrowserPreviewPlaying(false);
            return;
        }

        const selectedVoice = browserVoices.find(v => v.name === browserVoice);
        const voiceName = selectedVoice?.name ?? t('settings.voice.page.preview.browserVoiceFallback');
        const previewText = t('settings.voice.page.preview.voiceLine', { voiceName });

        setIsBrowserPreviewPlaying(true);

        const utterance = new SpeechSynthesisUtterance(previewText);
        utterance.rate = speechRate;
        utterance.pitch = speechPitch;
        utterance.volume = speechVolume;

        if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang;
        }

        utterance.onend = () => setIsBrowserPreviewPlaying(false);
        utterance.onerror = () => setIsBrowserPreviewPlaying(false);

        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
    }, [browserVoice, browserVoices, speechRate, speechPitch, speechVolume, isBrowserPreviewPlaying, t]);

    useEffect(() => {
        return () => {
            if (isBrowserPreviewPlaying) {
                browserVoiceService.cancelSpeech();
            }
        };
    }, [isBrowserPreviewPlaying]);

    useEffect(() => {
        void refreshVoiceApiKeys({ force: true });
    }, [refreshVoiceApiKeys]);

    useEffect(() => {
        if (!voicePlaybackEnabled || (voiceProvider !== 'openai' && voiceProvider !== 'openai-compatible')) {
            setIsOpenAIAvailable(hasOpenaiApiKey);
            return;
        }

        const checkOpenAIAvailability = async () => {
            try {
                const response = await runtimeFetch('/api/tts/status');
                const data = await response.json();
                const hasServerKey = data.available;
                const hasSettingsKey = hasOpenaiApiKey;
                const enterpriseMode = data.enterpriseMode === true;
                setVoiceEnterpriseMode(enterpriseMode);
                setIsOpenAIAvailable(!enterpriseMode && (hasServerKey || hasSettingsKey));
            } catch {
                setIsOpenAIAvailable(hasOpenaiApiKey);
            }
        };

        checkOpenAIAvailability();
    }, [hasOpenaiApiKey, voicePlaybackEnabled, voiceProvider]);

    useEffect(() => {
        if (!voicePlaybackEnabled) {
            setIsSayAvailable(false);
            setSayVoices([]);
            return;
        }

        runtimeFetch('/api/tts/say/status')
            .then(res => res.json())
            .then(data => {
                setIsSayAvailable(data.available);
                if (data.voices) {
                    const uniqueVoices = data.voices
                        .filter((v: { name: string; locale: string }, i: number, arr: Array<{ name: string; locale: string }>) =>
                            arr.findIndex((x: { name: string }) => x.name === v.name) === i
                        )
                        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                    setSayVoices(uniqueVoices);
                }
            })
            .catch(() => {
                setIsSayAvailable(false);
            });
    }, [voicePlaybackEnabled]);

    const previewVoice = useCallback(async () => {
        if (previewAudio) {
            disposePreviewAudio(previewAudio);
            setPreviewAudio(null);
            setIsPreviewPlaying(false);
            return;
        }

        setIsPreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/say/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.voiceLine', { voiceName: sayVoice }),
                    voice: sayVoice,
                    rate: Math.round(100 + (speechRate - 0.5) * 200),
                }),
            });

            if (!response.ok) throw new Error('Preview failed');

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            setPreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setPreviewAudio(null);
            setIsPreviewPlaying(false);
        }
    }, [sayVoice, speechRate, previewAudio, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(previewAudio);
        };
    }, [previewAudio]);

    const previewOpenAIVoice = useCallback(async () => {
        if (openaiPreviewAudio) {
            disposePreviewAudio(openaiPreviewAudio);
            setOpenaiPreviewAudio(null);
            setIsOpenAIPreviewPlaying(false);
            return;
        }

        setIsOpenAIPreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.voiceLine', { voiceName: openaiVoice }),
                    voice: openaiVoice,
                    speed: speechRate,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setOpenaiPreviewAudio(null);
                setIsOpenAIPreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setOpenaiPreviewAudio(null);
                setIsOpenAIPreviewPlaying(false);
            };

            setOpenaiPreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setOpenaiPreviewAudio(null);
            setIsOpenAIPreviewPlaying(false);
        }
    }, [openaiVoice, speechRate, openaiPreviewAudio, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(openaiPreviewAudio);
        };
    }, [openaiPreviewAudio]);

    const previewCompatibleVoice = useCallback(async () => {
        if (compatiblePreviewAudio) {
            disposePreviewAudio(compatiblePreviewAudio);
            setCompatiblePreviewAudio(null);
            setIsCompatiblePreviewPlaying(false);
            return;
        }

        if (!openaiCompatibleUrl.trim()) return;

        setIsCompatiblePreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.customServerLine'),
                    voice: openaiCompatibleVoice,
                    model: openaiCompatibleTtsModel || undefined,
                    speed: speechRate,
                    baseURL: openaiCompatibleUrl,
                    endpointPath: openaiCompatibleTtsEndpointPath || undefined,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setCompatiblePreviewAudio(null);
                setIsCompatiblePreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setCompatiblePreviewAudio(null);
                setIsCompatiblePreviewPlaying(false);
            };

            setCompatiblePreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setCompatiblePreviewAudio(null);
            setIsCompatiblePreviewPlaying(false);
        }
    }, [openaiCompatibleUrl, openaiCompatibleVoice, openaiCompatibleTtsModel, openaiCompatibleTtsEndpointPath, speechRate, compatiblePreviewAudio, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(compatiblePreviewAudio);
        };
    }, [compatiblePreviewAudio]);

    // A fixed-width slider with its value beside it, the same on every row,
    // so the three rows read as one column. Phones get a stepper instead.
    const sliderClass = "w-40 flex-none h-1.5 bg-[var(--interactive-border)] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:border-0 disabled:opacity-50";
    const sliderValueClass = 'typography-ui-label w-12 shrink-0 text-end tabular-nums text-muted-foreground';
    const previewIcon = (playing: boolean) => (playing ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />);

    return (
        <>
            <SettingsSection
                settingsItem="voice.playback"
                title={t('settings.voice.page.section.playbackAndSummary')}
                divider={false}
                contentClassName="space-y-3"
            >
                <SettingsCheckboxRow
                    checked={showMessageTTSButtons}
                    onChange={setShowMessageTTSButtons}
                    label={t('settings.voice.page.field.messageReadAloudButton')}
                    ariaLabel={t('settings.voice.page.field.messageReadAloudButtonAria')}
                />

                <SettingsCheckboxRow
                    checked={autoReadAloudEnabled}
                    onChange={setAutoReadAloudEnabled}
                    label={t('settings.voice.page.field.autoReadAloud')}
                    ariaLabel={t('settings.voice.page.field.autoReadAloudAria')}
                    info={t('settings.voice.page.tooltip.autoReadAloud')}
                    settingsItem="voice.auto-read-aloud"
                />

                {voicePlaybackEnabled && (
                    <>
                        <SettingsFieldRow
                            label={t('settings.voice.page.field.provider')}
                            info={(
                                <ul className="space-y-1">
                                    <li><strong>{t('settings.voice.page.provider.browser')}</strong> {t('settings.voice.page.tooltip.browser')}</li>
                                    <li><strong>{t('settings.voice.page.provider.local')}</strong> {t('settings.voice.page.tooltip.localTts')}</li>
                                    <li><strong>{t('settings.voice.page.provider.openai')}</strong> {t('settings.voice.page.tooltip.openai')}</li>
                                    <li><strong>{t('settings.voice.page.provider.custom')}</strong> {t('settings.voice.page.tooltip.custom')}</li>
                                    <li><strong>{t('settings.voice.page.provider.say')}</strong> {t('settings.voice.page.tooltip.say')}</li>
                                </ul>
                            )}
                        >
                            <SettingsChipGroup
                                value={voiceProvider}
                                onChange={setVoiceProvider}
                                aria-label={t('settings.voice.page.field.provider')}
                                options={[
                                    { value: 'browser', label: t('settings.voice.page.provider.browser') },
                                    { value: 'local', label: t('settings.voice.page.provider.local') },
                                    { value: 'openai', label: t('settings.voice.page.provider.openai') },
                                    { value: 'openai-compatible', label: t('settings.voice.page.provider.custom') },
                                    ...(isSayAvailable
                                        ? [{
                                            value: 'say' as const,
                                            label: (
                                                <>
                                                    <Icon name="apple" className="me-0.5 h-3.5 w-3.5" />
                                                    {t('settings.voice.page.provider.say')}
                                                </>
                                            ),
                                        }]
                                        : []),
                                ]}
                            />
                        </SettingsFieldRow>

                        {voiceEnterpriseMode && (voiceProvider === 'openai' || voiceProvider === 'openai-compatible') && (
                            <p className={SETTINGS_HELPER_CLASS}>{t('settings.voice.page.enterpriseMode')}</p>
                        )}

                        {voiceProvider === 'openai' && (
                            <SettingsStackedField
                                label={(
                                    <span className={cn(!isOpenAIAvailable && 'text-[var(--status-error)]')}>
                                        {t('settings.voice.page.field.apiKey')}
                                    </span>
                                )}
                                description={isOpenAIAvailable && !hasOpenaiApiKey
                                    ? t('settings.voice.page.field.apiKeyHintUsingConfig')
                                    : !isOpenAIAvailable
                                        ? t('settings.voice.page.field.apiKeyHintRequired')
                                        : t('settings.voice.page.field.apiKeyHintProvide')}
                            >
                                <VoiceApiKeyField kind="openai" />
                            </SettingsStackedField>
                        )}

                        {voiceProvider === 'openai-compatible' && (
                            <div className="space-y-3">
                                <SettingsStackedField
                                    label={(
                                        <span className={cn(!openaiCompatibleUrl.trim() && 'text-[var(--status-error)]')}>
                                            {t('settings.voice.page.field.serverUrl')}
                                        </span>
                                    )}
                                    info={t('settings.voice.page.field.serverUrlHint')}
                                >
                                    <div className="relative w-full">
                                        <input
                                            type="text"
                                            value={openaiCompatibleUrl}
                                            onChange={(e) => setOpenaiCompatibleUrl(e.target.value)}
                                            placeholder="http://localhost:8880/v1"
                                            className={VOICE_TEXT_INPUT_CLASS}
                                        />
                                        {openaiCompatibleUrl && (
                                            <button
                                                type="button"
                                                onClick={() => setOpenaiCompatibleUrl('')}
                                                className="absolute inset-e-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <Icon name="close" className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </SettingsStackedField>
                                <SettingsStackedField
                                    label={t('settings.voice.page.field.apiKey')}
                                    description={t('settings.voice.page.field.apiKeyOptional')}
                                >
                                    <VoiceApiKeyField kind="openaiCompatible" />
                                </SettingsStackedField>
                                <SettingsStackedField label={t('settings.voice.page.field.model')}>
                                    <input
                                        type="text"
                                        value={openaiCompatibleTtsModel}
                                        onChange={(e) => setOpenaiCompatibleTtsModel(e.target.value)}
                                        placeholder="speaches-ai/Kokoro-82M-v1.0-ONNX"
                                        className={VOICE_TEXT_INPUT_CLASS}
                                    />
                                </SettingsStackedField>
                                <SettingsStackedField
                                    settingsItem="voice.tts-endpoint-path"
                                    label={t('settings.voice.page.field.endpointPath')}
                                    info={t('settings.voice.page.field.endpointPathHint')}
                                >
                                    <input
                                        type="text"
                                        value={openaiCompatibleTtsEndpointPath}
                                        aria-label={t('settings.voice.page.field.endpointPath')}
                                        dir="ltr"
                                        onChange={(e) => setOpenaiCompatibleTtsEndpointPath(e.target.value)}
                                        placeholder="/audio/speech"
                                        className={VOICE_TEXT_INPUT_CLASS}
                                    />
                                </SettingsStackedField>
                                <SettingsStackedField
                                    label={t('settings.voice.page.field.voice')}
                                    info={t('settings.voice.page.field.voiceIdentifierHint')}
                                >
                                    <input
                                        type="text"
                                        value={openaiCompatibleVoice}
                                        onChange={(e) => setOpenaiCompatibleVoice(e.target.value)}
                                        placeholder="af_sky"
                                        className={VOICE_TEXT_INPUT_CLASS}
                                    />
                                    <Button size="sm" variant="ghost" className={SETTINGS_ICON_BUTTON_CLASS} onClick={previewCompatibleVoice} title={t('settings.voice.page.actions.preview')} aria-label={t('settings.voice.page.actions.preview')} disabled={!openaiCompatibleUrl.trim()}>
                                        {previewIcon(isCompatiblePreviewPlaying)}
                                    </Button>
                                </SettingsStackedField>
                            </div>
                        )}

                        {/* Local (Kokoro) TTS model status */}
                        {voiceProvider === 'local' && <LocalTtsModelStatus {...localTtsModels} />}

                        <div>
                            {voiceProvider === 'openai-compatible' ? null : (
                                <SettingsFieldRow label={t('settings.voice.page.field.voice')}>
                                    {voiceProvider === 'local' && (
                                        <>
                                            <Select
                                                value={localTtsVoiceKey(localTtsModelId, localTtsVoiceId)}
                                                onValueChange={(value) => {
                                                    const option = localTtsVoiceOptions.find((v) => localTtsVoiceKey(v.modelId, v.speakerId) === value);
                                                    if (!option) return;
                                                    setLocalTtsModelId(option.modelId);
                                                    setLocalTtsVoiceId(option.speakerId);
                                                }}
                                            >
                                                <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')}>
                                                        {(value) => localTtsVoiceOptions.find((v) => localTtsVoiceKey(v.modelId, v.speakerId) === value)?.label ?? value}
                                                    </SelectValue>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {localTtsVoiceOptions.map((v) => (
                                                        <SelectItem key={localTtsVoiceKey(v.modelId, v.speakerId)} value={localTtsVoiceKey(v.modelId, v.speakerId)}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="sm" variant="ghost" className={SETTINGS_ICON_BUTTON_CLASS} onClick={previewLocalVoice} title={t('settings.voice.page.actions.preview')} aria-label={t('settings.voice.page.actions.preview')}>
                                                {previewIcon(isLocalTtsPlaying)}
                                            </Button>
                                            {localTtsError ? (
                                                <span className="typography-meta text-[var(--status-error)]">{localTtsError}</span>
                                            ) : null}
                                        </>
                                    )}

                                    {voiceProvider === 'openai' && isOpenAIAvailable && (
                                        <>
                                            <Select value={openaiVoice} onValueChange={setOpenaiVoice}>
                                                <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')}>
                                                        {(value) => OPENAI_VOICE_OPTIONS.find((v) => v.value === value)?.label ?? value}
                                                    </SelectValue>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {OPENAI_VOICE_OPTIONS.map((v) => (
                                                        <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="sm" variant="ghost" className={SETTINGS_ICON_BUTTON_CLASS} onClick={previewOpenAIVoice} title={t('settings.voice.page.actions.preview')} aria-label={t('settings.voice.page.actions.preview')}>
                                                {previewIcon(isOpenAIPreviewPlaying)}
                                            </Button>
                                        </>
                                    )}

                                    {voiceProvider === 'say' && isSayAvailable && sayVoices.length > 0 && (
                                        <>
                                            <Select value={sayVoice} onValueChange={setSayVoice}>
                                                <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {sayVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="sm" variant="ghost" className={SETTINGS_ICON_BUTTON_CLASS} onClick={previewVoice} title={t('settings.voice.page.actions.preview')} aria-label={t('settings.voice.page.actions.preview')}>
                                                {previewIcon(isPreviewPlaying)}
                                            </Button>
                                        </>
                                    )}

                                    {voiceProvider === 'browser' && filteredBrowserVoices.length > 0 && (
                                        <>
                                            <Select value={browserVoice || '$auto'} onValueChange={(value) => setBrowserVoice(value === '$auto' ? '' : value)}>
                                                <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.auto')}>
                                                        {(value) => (value === '$auto' ? t('settings.voice.page.field.auto') : value)}
                                                    </SelectValue>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="$auto">{t('settings.voice.page.field.auto')}</SelectItem>
                                                    {filteredBrowserVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name} ({v.lang})</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="sm" variant="ghost" className={SETTINGS_ICON_BUTTON_CLASS} onClick={previewBrowserVoice} title={t('settings.voice.page.actions.preview')} aria-label={t('settings.voice.page.actions.preview')}>
                                                {previewIcon(isBrowserPreviewPlaying)}
                                            </Button>
                                        </>
                                    )}
                                </SettingsFieldRow>
                            )}

                            <SettingsFieldRow label={t('settings.voice.page.field.speechRate')}>
                                {isMobile ? (
                                    <NumberInput value={speechRate} onValueChange={setSpeechRate} min={0.5} max={2} step={0.1} className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')} />
                                ) : (
                                    <div className="flex h-8 items-center gap-2">
                                        <input type="range" min={0.5} max={2} step={0.1} value={speechRate} onChange={(e) => setSpeechRate(Number(e.target.value))} className={sliderClass} aria-label={t('settings.voice.page.field.speechRate')} />
                                        <span className={sliderValueClass}>{`${speechRate.toFixed(1)}×`}</span>
                                    </div>
                                )}
                            </SettingsFieldRow>

                            <SettingsFieldRow label={t('settings.voice.page.field.speechPitch')}>
                                {isMobile ? (
                                    <NumberInput value={speechPitch} onValueChange={setSpeechPitch} min={0.5} max={2} step={0.1} className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')} />
                                ) : (
                                    <div className="flex h-8 items-center gap-2">
                                        <input type="range" min={0.5} max={2} step={0.1} value={speechPitch} onChange={(e) => setSpeechPitch(Number(e.target.value))} className={sliderClass} aria-label={t('settings.voice.page.field.speechPitch')} />
                                        <span className={sliderValueClass}>{speechPitch.toFixed(1)}</span>
                                    </div>
                                )}
                            </SettingsFieldRow>

                            <SettingsFieldRow label={t('settings.voice.page.field.speechVolume')}>
                                {isMobile ? (
                                    <NumberInput value={Math.round(speechVolume * 100)} onValueChange={(v) => setSpeechVolume(v / 100)} min={0} max={100} step={10} className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')} />
                                ) : (
                                    <div className="flex h-8 items-center gap-2">
                                        <input type="range" min={0} max={1} step={0.1} value={speechVolume} onChange={(e) => setSpeechVolume(Number(e.target.value))} className={sliderClass} aria-label={t('settings.voice.page.field.speechVolume')} />
                                        <span className={sliderValueClass}>{`${Math.round(speechVolume * 100)}%`}</span>
                                    </div>
                                )}
                            </SettingsFieldRow>

                            <SettingsFieldRow label={t('settings.voice.page.field.ttsInputMode')}>
                                <SettingsChipGroup
                                    value={ttsInputMode}
                                    onChange={setTtsInputMode}
                                    aria-label={t('settings.voice.page.field.ttsInputMode')}
                                    options={[
                                        { value: 'sanitized', label: t('settings.voice.page.field.ttsInputModeSanitized') },
                                        { value: 'raw', label: t('settings.voice.page.field.ttsInputModeRaw') },
                                        { value: 'summarized', label: t('settings.voice.page.field.ttsInputModeSummarized') },
                                    ]}
                                />
                            </SettingsFieldRow>
                        </div>

                        {(voiceProvider === 'local' || voiceProvider === 'say' || voiceProvider === 'openai' || voiceProvider === 'openai-compatible') && (
                            <div className={SETTINGS_OPTION_STACK_CLASS}>
                                {(voiceProvider === 'local' || voiceProvider === 'say') && (
                                    <SettingsCheckboxRow
                                        checked={ttsFollowTextLanguage}
                                        onChange={setTtsFollowTextLanguage}
                                        label={t('settings.voice.page.field.followTextLanguage')}
                                        ariaLabel={t('settings.voice.page.field.followTextLanguageAria')}
                                        info={t('settings.voice.page.field.followTextLanguageInfo')}
                                    />
                                )}
                                {(voiceProvider === 'openai' || voiceProvider === 'openai-compatible') && (
                                    <SettingsCheckboxRow
                                        checked={ttsChunkedMode}
                                        onChange={setTtsChunkedMode}
                                        label={t('settings.voice.page.field.ttsChunkedMode')}
                                        ariaLabel={t('settings.voice.page.field.ttsChunkedModeAria')}
                                        info={t('settings.voice.page.tooltip.ttsChunked')}
                                    />
                                )}
                            </div>
                        )}
                    </>
                )}
            </SettingsSection>

            <SettingsSection
                settingsItem="voice.speech-recognition"
                title={t('settings.voice.page.section.speechRecognition')}
                contentClassName="space-y-3"
            >
                <SettingsCheckboxRow
                    checked={dictationEnabled}
                    onChange={setDictationEnabled}
                    label={t('settings.voice.page.field.enableVoiceInput')}
                    ariaLabel={t('settings.voice.page.field.enableVoiceInputAria')}
                />
                <SettingsCheckboxRow
                    checked={dictationAutoSend}
                    onChange={setDictationAutoSend}
                    label={t('settings.voice.page.field.dictationAutoSend')}
                    ariaLabel={t('settings.voice.page.field.dictationAutoSendAria')}
                    info={t('settings.voice.page.field.dictationAutoSendInfo')}
                    settingsItem="voice.dictation-auto-send"
                />

                {dictationEnabled && (
                    <>
                        <SettingsFieldRow
                            label={t('settings.voice.page.field.provider')}
                            info={(
                                <ul className="space-y-1">
                                    <li><strong>{t('settings.voice.page.provider.local')}</strong> {t('settings.voice.page.tooltip.sttLocal')}</li>
                                    <li><strong>{t('settings.voice.page.provider.server')}</strong> {t('settings.voice.page.tooltip.sttServer')}</li>
                                </ul>
                            )}
                        >
                            <SettingsChipGroup
                                value={sttProvider}
                                onChange={setSttProvider}
                                aria-label={t('settings.voice.page.field.provider')}
                                options={[
                                    { value: 'local', label: t('settings.voice.page.provider.local') },
                                    { value: 'openai-compatible', label: t('settings.voice.page.provider.server') },
                                ]}
                            />
                        </SettingsFieldRow>

                        {sttProvider === 'local' && (
                            <SettingsStackedField label={t('settings.voice.page.field.model')} controlClassName="max-w-none">
                                <LocalModelPicker savedModelId={sttLocalModel} onSelect={setSttLocalModel} />
                            </SettingsStackedField>
                        )}

                        {sttProvider === 'local' && LOCAL_STT_MODELS.find((entry) => entry.id === sttLocalModel)?.languageHint && (
                            <SettingsStackedField
                                label={t('settings.voice.page.field.language')}
                                info={t('settings.voice.page.field.sttLanguageHint')}
                                controlClassName="max-w-[8rem]"
                            >
                                <input
                                    type="text"
                                    value={sttLanguage}
                                    onChange={(e) => setSttLanguage(e.target.value)}
                                    placeholder="auto"
                                    className={VOICE_TEXT_INPUT_CLASS}
                                />
                            </SettingsStackedField>
                        )}

                        {sttProvider === 'openai-compatible' && (
                            <div className="space-y-3">
                                <SettingsStackedField
                                    label={(
                                        <span className={cn(!sttServerUrl.trim() && 'text-[var(--status-error)]')}>
                                            {t('settings.voice.page.field.serverUrl')}
                                        </span>
                                    )}
                                    info={t('settings.voice.page.field.sttServerUrlHint')}
                                >
                                    <div className="relative w-full">
                                        <input
                                            type="text"
                                            value={sttServerUrl}
                                            onChange={(e) => setSttServerUrl(e.target.value)}
                                            placeholder="http://localhost:8001/v1"
                                            className={VOICE_TEXT_INPUT_CLASS}
                                        />
                                        {sttServerUrl && (
                                            <button
                                                type="button"
                                                onClick={() => setSttServerUrl('')}
                                                className="absolute inset-e-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <Icon name="close" className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </SettingsStackedField>
                                <SettingsStackedField
                                    label={t('settings.voice.page.field.apiKey')}
                                    description={t('settings.voice.page.field.apiKeyOptional')}
                                >
                                    <VoiceApiKeyField kind="stt" />
                                </SettingsStackedField>
                                <SettingsStackedField label={t('settings.voice.page.field.model')}>
                                    <input
                                        type="text"
                                        value={sttModel}
                                        onChange={(e) => setSttModel(e.target.value)}
                                        placeholder="deepdml/faster-whisper-large-v3-turbo-ct2"
                                        className={VOICE_TEXT_INPUT_CLASS}
                                    />
                                </SettingsStackedField>
                                <SettingsStackedField
                                    settingsItem="voice.stt-endpoint-path"
                                    label={t('settings.voice.page.field.endpointPath')}
                                    info={t('settings.voice.page.field.endpointPathHint')}
                                >
                                    <input
                                        type="text"
                                        value={sttEndpointPath}
                                        aria-label={t('settings.voice.page.field.endpointPath')}
                                        dir="ltr"
                                        onChange={(e) => setSttEndpointPath(e.target.value)}
                                        placeholder="/audio/transcriptions"
                                        className={VOICE_TEXT_INPUT_CLASS}
                                    />
                                </SettingsStackedField>
                                <SettingsStackedField
                                    label={t('settings.voice.page.field.language')}
                                    info={t('settings.voice.page.field.sttLanguageHint')}
                                    controlClassName="max-w-[8rem]"
                                >
                                    <input
                                        type="text"
                                        value={sttLanguage}
                                        onChange={(e) => setSttLanguage(e.target.value)}
                                        placeholder="auto"
                                        className={VOICE_TEXT_INPUT_CLASS}
                                    />
                                </SettingsStackedField>
                            </div>
                        )}

                        <TranscriptCorrectionRow />
                    </>
                )}
            </SettingsSection>
        </>
    );
};
