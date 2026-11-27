import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { DictationStatusControls } from '@/components/dictation/DictationStatusControls';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import {
  cancelFieldDictation, finishFieldDictation, startFieldDictation, useFieldRecording, type DictationStatusActions,
} from '@/lib/dictation/fieldDictation';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
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
  const recordingActions = recording?.actions;
  const actions = React.useMemo<DictationStatusActions | null>(() => (recordingActions ? {
    finish: () => finishFieldDictation(fieldKey),
    cancel: () => cancelFieldDictation(fieldKey),
    retry: () => void recordingActions.retryFailedDictation(),
    discard: () => recordingActions.discardFailedDictation(),
    acceptPartial: () => { recordingActions.acceptPartialTranscript(); },
    subscribeLevel: recordingActions.subscribeLevel,
  } : null), [fieldKey, recordingActions]);

  if (!supported || (!dictationEnabled && !recording)) {
    return null;
  }

  if (recording && recording.view.status !== 'idle') {
    return (
      <DictationStatusControls
        view={recording.view}
        actions={actions}
        buttonClassName={buttonClassName}
        iconClassName={iconClassName}
      />
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
