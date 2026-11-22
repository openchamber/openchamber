import { useEffect } from 'react';

import { SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';
import { SettingsCheckboxRow, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { selectSmallModelAvailability, useSmallModelStore } from '@/stores/useSmallModelStore';
import { useUIStore } from '@/stores/useUIStore';

const openSmallModelSettings = (): void => {
    useUIStore.getState().requestSettingsJump('sessions', 'sessions.small-model');
};

export const TranscriptCorrectionRow = () => {
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
