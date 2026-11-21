import React from 'react';

import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { STT_PROMPT_MAX_LENGTH, selectTranscriptionPrompt, setTranscriptionPrompt, useTranscriptionPromptStore } from '@/stores/useTranscriptionPromptStore';

export const TranscriptionPromptField: React.FC = () => {
    const { t } = useI18n();
    const sttPrompt = useTranscriptionPromptStore(selectTranscriptionPrompt);
    const setSttPrompt = (prompt: string) => {
        setTranscriptionPrompt(prompt);
        updateDesktopSettings({ sttPrompt: prompt }).catch(() => {});
    };

    return (
        <SettingsStackedField
            settingsItem="voice.stt-prompt"
            label={t('settings.voice.page.field.sttPrompt')}
            info={t('settings.voice.page.field.sttPromptHint')}
        >
            <Textarea
                value={sttPrompt}
                aria-label={t('settings.voice.page.field.sttPrompt')}
                onChange={(e) => setSttPrompt(e.target.value)}
                placeholder={t('settings.voice.page.field.sttPromptPlaceholder')}
                maxLength={STT_PROMPT_MAX_LENGTH}
                rows={3}
            />
        </SettingsStackedField>
    );
};
