import React from 'react';

import { toast } from '@/components/ui';
import { useDictation } from '@/hooks/useDictation';
import { isContextWindow } from '@/lib/contextWindow/role';
import { isDesktopShell } from '@/lib/desktop';
import type { DictationClient } from '@/lib/dictation/dictation-client';
import {
  attachFieldRecording,
  deliverFieldText,
  finishAllFieldDictations,
  isWindowClosePending,
  publishFieldRecording,
  removeFieldRecording,
  setWindowClosePending,
  type FieldRecording,
  type FieldRecordingActions,
} from '@/lib/dictation/fieldDictation';
import { useI18n } from '@/lib/i18n';

let shownFailures = 0;

export const useFieldRecordingEngine = ({ id, insert, client, renderFailure }: {
  id: number;
  insert: FieldRecording['insert'];
  client?: DictationClient;
  renderFailure: (error: string | null, actions: FieldRecordingActions, hasPartial: boolean) => React.ReactNode;
}): void => {
  const { t } = useI18n();
  const dictation = useDictation({ onTranscript: (text) => void deliverFieldText(insert, text) }, client);
  const { status, duration, error, errorReason, partialTranscript } = dictation;
  const latest = React.useRef(dictation);
  latest.current = dictation;
  const [started, setStarted] = React.useState(false);
  const [actions] = React.useState<FieldRecordingActions>(() => ({
    startDictation: () => latest.current.startDictation().finally(() => setStarted(true)),
    confirmDictation: () => latest.current.confirmDictation(),
    cancelDictation: () => latest.current.cancelDictation(),
    retryFailedDictation: () => latest.current.retryFailedDictation(),
    acceptPartialTranscript: () => latest.current.acceptPartialTranscript(),
    discardFailedDictation: () => latest.current.discardFailedDictation(),
    subscribeLevel: (listener) => latest.current.subscribeLevel(listener),
  }));

  React.useLayoutEffect(() => attachFieldRecording(id, actions), [actions, id]);

  React.useLayoutEffect(() => {
    publishFieldRecording(id, { status, duration, error, errorReason, partialTranscript });
  }, [duration, error, errorReason, id, partialTranscript, status]);

  const seenActive = React.useRef(false);
  React.useEffect(() => {
    if (status !== 'idle') {
      seenActive.current = true;
      return;
    }
    if (!seenActive.current && !started) return;
    if (error && errorReason !== 'model_download_in_progress') {
      toast.error(t('chat.dictation.failed'), { description: error });
    }
    removeFieldRecording(id);
  }, [error, errorReason, id, started, status, t]);

  const hasPartial = partialTranscript.trim().length > 0;
  React.useEffect(() => {
    if (status !== 'failed') return;
    shownFailures += 1;
    const toastId = `field-dictation-${shownFailures}`;
    toast.error(t('chat.dictation.failed'), {
      id: toastId,
      description: renderFailure(error, actions, hasPartial),
      duration: Infinity,
      dismissible: false,
      closeButton: false,
      action: React.createElement(React.Fragment),
    });
    return () => { toast.dismiss(toastId); };
  }, [actions, error, hasPartial, renderFailure, status, t]);
};

export const useCloseWindowAfterRecordings = (busy: boolean): void => {
  React.useEffect(() => {
    if (!isContextWindow() || !isDesktopShell()) return;
    if (!busy) {
      if (isWindowClosePending()) window.close();
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      setWindowClosePending(true);
      finishAllFieldDictations();
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy]);
};
