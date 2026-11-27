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
import { useKeyProviders } from '@/hooks/useKeyProviders';
import { useI18n } from '@/lib/i18n';
import { approveKeyProvider, autoSelectedKeyProvider, markKeyProvidersStale, originOf } from '@/lib/voice/keyProviders';
import { useConfigStore } from '@/stores/useConfigStore';

const NONE_ITEM = 'none';
const PROVIDER_ITEM_PREFIX = 'provider:';

type KeyProviderFieldProps = {
    serverUrl: string;
    committedUrl: string;
    chosen: string | undefined;
    onChoose: (providerId: string) => void;
    typedKeySaved: boolean;
};

function KeyProviderField({ serverUrl, committedUrl, chosen, onChoose, typedKeySaved }: KeyProviderFieldProps) {
    const { t } = useI18n();
    const address = committedUrl.trim();
    const { providers, failed, settled, refresh, runtimeKey } = useKeyProviders(serverUrl, committedUrl);
    const [outcomes, setOutcomes] = React.useState<Record<string, 'refused' | 'failed'>>({});
    const record = (key: string, outcome?: 'refused' | 'failed') => setOutcomes((previous) => {
        const next = { ...previous };
        if (outcome) next[key] = outcome;
        else delete next[key];
        return next;
    });

    if (providers.length === 0 && !chosen && !failed) return null;

    const selectedId = typedKeySaved ? '' : (chosen ?? autoSelectedKeyProvider(providers)?.id ?? '');
    const selected = providers.find((provider) => provider.id === selectedId);
    const autoSelected = !typedKeySaved && chosen === undefined && selected !== undefined;
    const origin = originOf(address);
    const needsApproval = !typedKeySaved && settled && selected !== undefined && origin !== null && !selected.approved;
    const unavailable = !typedKeySaved && !failed && settled && selectedId !== '' && selected === undefined;
    const attempt = selected === undefined ? null : [runtimeKey, selected.id, origin].join('\n');
    const outcome = attempt === null ? undefined : outcomes[attempt];

    const approve = () => {
        if (selected === undefined || attempt === null) return;
        record(attempt);
        void approveKeyProvider(address, selected).then((result) => {
            record(attempt, result === 'refused' || result === 'failed' ? result : undefined);
            markKeyProvidersStale(result === 'added' || result === 'kept' ? origin : null);
        });
    };

    const line = typedKeySaved
        ? t('settings.voice.page.providerKey.typedKeyUsed')
        : failed
            ? t('settings.voice.page.providerKey.loadFailed')
            : needsApproval && outcome === 'refused'
                ? t('settings.voice.page.providerKey.changed', { provider: selected.name, server: origin })
                : needsApproval && outcome === 'failed'
                    ? t('settings.voice.page.providerKey.approveFailed')
                    : needsApproval
                        ? t('settings.voice.page.providerKey.needsApproval', { provider: selected.name, server: origin })
                        : unavailable
                            ? t('settings.voice.page.providerKey.unavailable', { provider: selectedId })
                            : autoSelected
                                ? t('settings.voice.page.providerKey.auto')
                                : null;
    const action = !typedKeySaved && failed
        ? { label: t('settings.voice.page.voiceList.retry'), run: refresh }
        : needsApproval
            ? { label: t('settings.voice.page.providerKey.approve'), run: approve }
            : null;

    return (
        <SettingsStackedField
            label={t('settings.voice.page.field.providerKey')}
            info={t('settings.voice.page.providerKey.info')}
            descriptionPlacement="after"
            description={(
                <span role="status" className="flex min-h-[1lh] items-start gap-2">
                    <span className="min-w-0 break-words">{line}</span>
                    {action ? (
                        <span className="shrink-0">
                            <SettingsInlineLink onClick={action.run}>{action.label}</SettingsInlineLink>
                        </span>
                    ) : null}
                </span>
            )}
        >
            <Select
                value={selectedId === '' ? NONE_ITEM : `${PROVIDER_ITEM_PREFIX}${selectedId}`}
                disabled={typedKeySaved}
                onValueChange={(item) => {
                    setOutcomes({});
                    onChoose(item === NONE_ITEM ? '' : item.slice(PROVIDER_ITEM_PREFIX.length));
                }}
            >
                <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.voice.page.field.providerKey')}>
                    <SelectValue>
                        {selectedId === '' ? t('settings.voice.page.providerKey.none') : (selected?.name ?? selectedId)}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={NONE_ITEM}>{t('settings.voice.page.providerKey.none')}</SelectItem>
                    <SelectSeparator />
                    {providers.map((provider) => (
                        <SelectItem key={provider.id} value={`${PROVIDER_ITEM_PREFIX}${provider.id}`}>{provider.name}</SelectItem>
                    ))}
                    {unavailable ? <SelectItem value={`${PROVIDER_ITEM_PREFIX}${selectedId}`}>{selectedId}</SelectItem> : null}
                </SelectContent>
            </Select>
        </SettingsStackedField>
    );
}

type AddressProps = { serverUrl: string; committedUrl: string };

export function CompatibleKeyProviderField({ serverUrl, committedUrl }: AddressProps) {
    const chosen = useConfigStore((state) => state.openaiCompatibleKeyProvider);
    const choose = useConfigStore((state) => state.setOpenaiCompatibleKeyProvider);
    const typedKeySaved = useConfigStore((state) => state.voiceApiKeys.openaiCompatible);
    return (
        <KeyProviderField
            serverUrl={serverUrl}
            committedUrl={committedUrl}
            chosen={chosen}
            onChoose={choose}
            typedKeySaved={typedKeySaved}
        />
    );
}

export function SttKeyProviderField({ serverUrl, committedUrl }: AddressProps) {
    const chosen = useConfigStore((state) => state.sttKeyProvider);
    const choose = useConfigStore((state) => state.setSttKeyProvider);
    const typedKeySaved = useConfigStore((state) => state.voiceApiKeys.stt);
    return (
        <KeyProviderField
            serverUrl={serverUrl}
            committedUrl={committedUrl}
            chosen={chosen}
            onChoose={choose}
            typedKeySaved={typedKeySaved}
        />
    );
}
