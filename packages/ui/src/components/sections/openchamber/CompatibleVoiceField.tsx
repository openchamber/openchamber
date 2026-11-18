import React from 'react';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { SettingsStackedField, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';
import { useCustomServerVoices, type VoiceListFailure } from '@/hooks/useCustomServerVoices';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { cn } from '@/lib/utils';

export const VOICE_TEXT_INPUT_CLASS = 'oc-surface-elevated oc-raised oc-field w-full min-w-0 h-8 rounded-md bg-surface-elevated px-3 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none';

const CUSTOM_VOICE_ITEM = '$custom';

const VOICE_LIST_FAILURE_LINE = {
    invalid_base_url: { text: 'settings.voice.page.voiceList.invalidUrl', retry: false },
    remote_disabled: { text: 'settings.voice.page.voiceList.remoteDisabled', retry: false },
    enterprise_mode: null,
    rejected_key: { text: 'settings.voice.page.voiceList.keyRejected', retry: true },
    unreachable: { text: 'settings.voice.page.voiceList.unreachable', retry: true },
    upstream_error: { text: 'settings.voice.page.voiceList.failed', retry: true },
} satisfies Record<VoiceListFailure, { text: I18nKey; retry: boolean } | null>;

type CompatibleVoiceFieldProps = { committedUrl: string; keyRevision: number; children: React.ReactNode };

export function CompatibleVoiceField({ committedUrl, keyRevision, children }: CompatibleVoiceFieldProps) {
    const { t } = useI18n();
    const serverUrl = useConfigStore((state) => state.openaiCompatibleUrl);
    const voice = useConfigStore((state) => state.openaiCompatibleVoice);
    const setVoice = useConfigStore((state) => state.setOpenaiCompatibleVoice);
    const { list, retry } = useCustomServerVoices(serverUrl, committedUrl, keyRevision);
    const [customFor, setCustomFor] = React.useState<string | null>(null);
    const [inputFocused, setInputFocused] = React.useState(false);
    const controls = React.useRef<{ trigger: HTMLElement | null; input: HTMLInputElement | null }>({ trigger: null, input: null });

    const baseURL = serverUrl.trim();
    const voices = list.kind === 'listed' ? list.voices : null;
    const showInput = voices === null || customFor === baseURL || inputFocused || !voices.includes(voice);
    const failure = list.kind === 'failed' ? VOICE_LIST_FAILURE_LINE[list.code] : null;

    const keepFocusAfterRetry = React.useCallback((node: HTMLSpanElement | null) => {
        if (!node) return;
        return () => {
            if (!node.contains(document.activeElement)) return;
            queueMicrotask(() => (controls.current.trigger ?? controls.current.input)?.focus());
        };
    }, []);

    const pick = (value: string) => {
        if (value === CUSTOM_VOICE_ITEM) {
            setCustomFor(baseURL);
            return;
        }
        setCustomFor(null);
        setVoice(value);
    };

    return (
        <SettingsStackedField
            label={t('settings.voice.page.field.voice')}
            info={t('settings.voice.page.field.voiceIdentifierHint')}
            descriptionPlacement="after"
            description={(
                <span role="status" className="flex min-h-[1lh] items-start gap-2">
                    <span className="min-w-0 break-words">{failure ? t(failure.text) : null}</span>
                    {failure?.retry ? (
                        <span className="shrink-0" ref={keepFocusAfterRetry}>
                            <SettingsInlineLink onClick={retry}>{t('settings.voice.page.voiceList.retry')}</SettingsInlineLink>
                        </span>
                    ) : null}
                </span>
            )}
        >
            {voices ? (
                <Select value={showInput ? CUSTOM_VOICE_ITEM : voice} onValueChange={pick}>
                    <SelectTrigger
                        ref={(node: HTMLElement | null) => { controls.current.trigger = node; }}
                        className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'shrink-0')}
                        aria-label={t('settings.voice.page.field.voice')}>
                        <SelectValue>
                            {(value) => (value === CUSTOM_VOICE_ITEM ? t('settings.voice.page.field.voiceCustom') : value)}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {voices.map((id) => (
                            <SelectItem key={id} value={id}>{id}</SelectItem>
                        ))}
                        <SelectSeparator />
                        <SelectItem value={CUSTOM_VOICE_ITEM}>{t('settings.voice.page.field.voiceCustom')}</SelectItem>
                    </SelectContent>
                </Select>
            ) : null}
            {showInput ? (
                <input
                    ref={(node) => { controls.current.input = node; }}
                    type="text"
                    value={voice}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => {
                        setInputFocused(false);
                        if (voices !== null) setCustomFor(baseURL);
                    }}
                    onChange={(event) => {
                        setCustomFor(baseURL);
                        setVoice(event.target.value);
                    }}
                    placeholder="af_sky"
                    aria-label={t(voices ? 'settings.voice.page.field.voiceCustomInput' : 'settings.voice.page.field.voice')}
                    dir="ltr"
                    className={VOICE_TEXT_INPUT_CLASS}
                />
            ) : null}
            {children}
        </SettingsStackedField>
    );
}
