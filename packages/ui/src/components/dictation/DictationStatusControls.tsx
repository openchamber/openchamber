import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { DictationWaveform } from '@/components/dictation/DictationWaveform';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import type { DictationStatusActions, FieldRecordingView } from '@/lib/dictation/fieldDictation';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface DictationStatusControlsProps {
  view: FieldRecordingView;
  actions: DictationStatusActions | null | undefined;
  buttonClassName: string;
  iconClassName?: string;
}

export const DictationStatusControls: React.FC<DictationStatusControlsProps> = ({
  view,
  actions,
  buttonClassName,
  iconClassName = 'h-4 w-4',
}) => {
  const { t } = useI18n();
  const { status, error, errorReason, duration, partialTranscript } = view;
  const recordingBlink = useWaitingBlink(status === 'recording');

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
            onClick={() => actions?.cancel()}
            className={buttonClassName}
            aria-label={t('chat.dictation.cancel')}
          >
            <Icon name="close" className={iconClassName} />
          </button>
        </ButtonTooltip>
        <ButtonTooltip label={t('chat.dictation.insert')} className="shrink-0">
          <button
            type="button"
            onClick={() => actions?.finish()}
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
      { key: 'discard', label: t('chat.dictation.discard'), icon: 'close', run: () => actions?.discard() },
      { key: 'retry', label: t('chat.dictation.retry'), icon: 'refresh', run: () => actions?.retry() },
    ];
    if (partialTranscript.trim()) {
      failedActions.push({ key: 'insert', label: t('chat.dictation.insert'), icon: 'check', run: () => actions?.acceptPartial() });
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

  return null;
};
