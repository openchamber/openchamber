import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { DictationWaveform } from '@/components/dictation/DictationWaveform';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { cancelFieldDictation, finishFieldDictation, startFieldDictation, useFieldRecording } from '@/lib/dictation/fieldDictation';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';

interface InlineDictationButtonProps {
  fieldKey: string;
  panelKey: string;
  onTranscript: (text: string) => void;
  disabled?: boolean;
  buttonClassName: string;
  iconClassName?: string;
}

export const InlineDictationButton: React.FC<InlineDictationButtonProps> = ({
  fieldKey,
  panelKey,
  onTranscript,
  disabled,
  buttonClassName,
  iconClassName = 'h-4 w-4',
}) => {
  const { t } = useI18n();
  const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
  const [supported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());

  const recording = useFieldRecording(fieldKey);
  const { status, error, errorReason, duration, partialTranscript } = recording?.view
    ?? { status: 'idle', error: null, errorReason: null, duration: 0, partialTranscript: '' };
  const actions = recording?.actions;

  const recordingBlink = useWaitingBlink(status === 'recording');

  if (!supported || (!dictationEnabled && !recording)) {
    return null;
  }

  if (status === 'uploading') {
    return (
      <span role="status" className="inline-flex min-w-0 items-center gap-1.5 typography-meta text-muted-foreground">
        <Icon name="loader-4" className={cn(iconClassName, 'shrink-0 animate-spin')} />
        <span className="truncate">{t('chat.dictation.processing')}</span>
      </span>
    );
  }

  if (status === 'recording') {
    const downloadingModel = errorReason === 'model_download_in_progress';
    return (
      <>
        <span role="status" aria-label={t('chat.dictation.listening')} className="inline-flex min-w-0 items-center gap-1.5">
          <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
            <span className={cn('relative inline-flex size-1.5 rounded-full bg-[var(--status-error)]', recordingBlink)} />
          </span>
          {downloadingModel ? (
            <span className="truncate typography-meta text-muted-foreground">{t('chat.dictation.downloadingModel')}</span>
          ) : (
            actions ? <DictationWaveform subscribeLevel={actions.subscribeLevel} className="block h-4 w-12 min-w-0" /> : null
          )}
          <span className="shrink-0 tabular-nums typography-meta text-muted-foreground">
            {`${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`}
          </span>
        </span>
        <ButtonTooltip label={t('chat.dictation.cancel')} className="shrink-0">
          <button
            type="button"
            onClick={() => cancelFieldDictation(fieldKey)}
            className={buttonClassName}
            aria-label={t('chat.dictation.cancel')}
          >
            <Icon name="close" className={iconClassName} />
          </button>
        </ButtonTooltip>
        <ButtonTooltip label={t('chat.dictation.insert')} className="shrink-0">
          <button
            type="button"
            onClick={() => finishFieldDictation(fieldKey)}
            className={cn(buttonClassName, 'text-primary hover:text-primary')}
            aria-label={t('chat.dictation.insert')}
          >
            <Icon name="check" className={iconClassName} />
          </button>
        </ButtonTooltip>
      </>
    );
  }

  if (status === 'failed') {
    const failedActions: Array<{ key: string; label: string; icon: IconName; run: () => void }> = [
      { key: 'discard', label: t('chat.dictation.discard'), icon: 'close', run: () => actions?.discardFailedDictation() },
      { key: 'retry', label: t('chat.dictation.retry'), icon: 'refresh', run: () => void actions?.retryFailedDictation() },
    ];
    if (partialTranscript.trim()) {
      failedActions.push({ key: 'insert', label: t('chat.dictation.insert'), icon: 'check', run: () => { actions?.acceptPartialTranscript(); } });
    }
    return (
      <>
        <span role="status" title={error ?? undefined} className="min-w-0 truncate typography-meta text-[var(--status-error-text)]">
          {t('chat.dictation.failed')}
        </span>
        {failedActions.map(({ key, label, icon, run }) => (
          <ButtonTooltip key={key} label={label} className="shrink-0">
            <button type="button" onClick={run} className={buttonClassName} aria-label={label}>
              <Icon name={icon} className={iconClassName} />
            </button>
          </ButtonTooltip>
        ))}
      </>
    );
  }

  return (
    <ButtonTooltip label={t('chat.dictation.start')} className="shrink-0">
      <button
        type="button"
        onClick={() => startFieldDictation({ fieldKey, panelKey, insert: onTranscript })}
        disabled={disabled}
        className={buttonClassName}
        aria-label={t('chat.dictation.start')}
      >
        <Icon name="mic" className={iconClassName} />
      </button>
    </ButtonTooltip>
  );
};
