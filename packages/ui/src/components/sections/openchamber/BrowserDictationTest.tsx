import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DictationWaveform } from '@/components/dictation/DictationWaveform';
import { SettingsControlGroup, SETTINGS_FIELDS_STACK_CLASS, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useBrowserDictation, isBrowserDictationSupported } from '@/hooks/useBrowserDictation';
import { useI18n } from '@/lib/i18n';

/** A local preview. Results never enter a chat or persisted settings. */
export function BrowserDictationTest() {
    const { t } = useI18n();
    const [result, setResult] = useState('');
    const dictation = useBrowserDictation({ onTranscript: setResult });
    const active = dictation.isRecording || dictation.isProcessing;
    const supported = isBrowserDictationSupported();

    return (
        <SettingsControlGroup title={t('settings.voice.page.browserTest.title')}
            contentClassName={SETTINGS_FIELDS_STACK_CLASS}
            description={t('settings.voice.page.browserTest.description')}>
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.voice.page.field.browserMicrophonePermission')}</p>
            {!supported ? <p role="status" className={SETTINGS_HELPER_CLASS}>
                {t('settings.voice.page.browserTest.unavailable')}
            </p> : <>
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" disabled={dictation.isProcessing}
                        onClick={() => {
                            if (dictation.isRecording) {
                                void dictation.confirmDictation();
                            } else {
                                setResult('');
                                dictation.discardFailedDictation();
                                void dictation.startDictation();
                            }
                        }}>
                        {dictation.isRecording ? t('settings.voice.page.browserTest.stop') : t('settings.voice.page.browserTest.title')}
                    </Button>
                    {active && <Button size="sm" variant="ghost" onClick={() => {
                        setResult('');
                        void dictation.cancelDictation();
                    }}>{t('chat.dictation.cancel')}</Button>}
                    <span role="status" className={SETTINGS_HELPER_CLASS}>
                        {dictation.isRecording ? t('chat.dictation.listening')
                            : dictation.isProcessing ? t('chat.dictation.processing') : null}
                    </span>
                </div>
                {dictation.isRecording && <DictationWaveform subscribeLevel={dictation.subscribeLevel} className="block h-8 w-full max-w-[24rem]" />}
                <textarea readOnly rows={3} value={active || dictation.status === 'failed' ? dictation.partialTranscript : result}
                    aria-label={t('settings.voice.page.browserTest.transcript')}
                    placeholder={t('settings.voice.page.browserTest.transcript')}
                    className="block w-full max-w-[24rem] resize-y rounded-md border border-input bg-transparent px-3 py-2 typography-ui-label text-foreground placeholder:text-muted-foreground" />
                {dictation.error && <p role="alert" className="typography-meta text-[var(--status-error)]">{dictation.error}</p>}
            </>}
        </SettingsControlGroup>
    );
}
