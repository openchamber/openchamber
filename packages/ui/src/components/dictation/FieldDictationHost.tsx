import React from 'react';

import { Button } from '@/components/ui/button';
import { useCloseWindowAfterRecordings, useFieldRecordingEngine } from '@/hooks/useFieldRecordingEngine';
import type { DictationClient } from '@/lib/dictation/dictation-client';
import { useFieldDictationStore, type FieldRecording, type FieldRecordingActions } from '@/lib/dictation/fieldDictation';
import { useI18n } from '@/lib/i18n';

const FailureNotice: React.FC<{ error: string | null; actions: FieldRecordingActions; hasPartial: boolean }> = ({ error, actions, hasPartial }) => {
  const { t } = useI18n();
  return (
    <>
      {error}
      <span className="mt-2 flex flex-wrap gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            if (hasPartial) actions.acceptPartialTranscript();
            else actions.discardFailedDictation();
          }}
        >
          {t(hasPartial ? 'chat.dictation.insert' : 'chat.dictation.discard')}
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={() => void actions.retryFailedDictation()}>
          {t('chat.dictation.retry')}
        </Button>
      </span>
    </>
  );
};

const renderFailure = (error: string | null, actions: FieldRecordingActions, hasPartial: boolean) => (
  <FailureNotice error={error} actions={actions} hasPartial={hasPartial} />
);

const FieldRecordingEngine: React.FC<{ id: number; insert: FieldRecording['insert']; client?: DictationClient }> = ({ id, insert, client }) => {
  useFieldRecordingEngine({ id, insert, client, renderFailure });
  return null;
};

export const FieldDictationHost: React.FC<{ client?: DictationClient }> = ({ client }) => {
  const recordings = useFieldDictationStore((state) => state.recordings);
  useCloseWindowAfterRecordings(useFieldDictationStore((state) => state.recordings.length > 0 || state.deliveries > 0));
  return recordings.map(({ id, insert }) => <FieldRecordingEngine key={id} id={id} insert={insert} client={client} />);
};
