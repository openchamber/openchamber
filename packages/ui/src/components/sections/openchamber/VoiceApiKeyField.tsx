import React, { useCallback, useState } from 'react';

import { Icon } from "@/components/icon/Icon";
import { SETTINGS_CONTROL_CLUSTER_CLASS } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import type { VoiceApiKeyKind } from '@/lib/voiceKeysApi';
import { VOICE_TEXT_INPUT_CLASS } from './CompatibleVoiceField';

export const VoiceApiKeyField: React.FC<{ kind: VoiceApiKeyKind; speechServer?: string | null; onSaved?: () => void }> = ({ kind, speechServer, onSaved }) => {
    const { t } = useI18n();
    const saved = useConfigStore((state) => state.voiceApiKeys[kind]);
    const setVoiceApiKey = useConfigStore((state) => state.setVoiceApiKey);
    const [draft, setDraft] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const save = useCallback(async (value: string | null) => {
        setIsSaving(true);
        const ok = await setVoiceApiKey(kind, value, speechServer);
        setIsSaving(false);
        if (ok) {
            setDraft('');
            onSaved?.();
        } else {
            toast.error(t('settings.voice.page.toast.apiKeySaveFailed'));
        }
    }, [kind, onSaved, setVoiceApiKey, speechServer, t]);

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
                    if (e.key === 'Enter' && draft.trim()) e.currentTarget.blur();
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
