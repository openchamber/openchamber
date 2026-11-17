import React from 'react';
import { z } from 'zod';

import { toast } from '@/components/ui';
import { useDictation } from '@/hooks/useDictation';
import type { AnnotationAppMessage, AnnotationOverlayMessage } from '@/lib/browser/annotationOverlay';
import { useI18n } from '@/lib/i18n';

const LEVEL_INTERVAL_MS = 80;

const modelDownloadSchema = z.object({ reasonCode: z.literal('model_download_in_progress') });

export type AnnotationVoiceChannel = {
  readonly send: (message: AnnotationAppMessage) => Promise<void>;
  readonly subscribe: (listener: (message: AnnotationOverlayMessage) => void) => () => void;
};

export const AnnotationDictation: React.FC<{ channel: AnnotationVoiceChannel }> = ({ channel }) => {
  const { t } = useI18n();

  const queueRef = React.useRef<Promise<void>>(Promise.resolve());
  const post = React.useCallback((message: AnnotationAppMessage) => {
    queueRef.current = queueRef.current.then(() => channel.send(message)).catch(() => undefined);
  }, [channel]);

  const {
    status,
    errorReason,
    partialTranscript,
    subscribeLevel,
    startDictation,
    confirmDictation,
    cancelDictation,
    discardFailedDictation,
  } = useDictation({
    onTranscript: (text) => post({ type: 'insert', text }),
    onError: (error) => {
      if (modelDownloadSchema.safeParse(error).success) return;
      toast.error(t('chat.dictation.failed'), { description: error.message });
    },
  });

  React.useEffect(() => channel.subscribe((message) => {
    if (message.action === 'start') void startDictation();
    else if (message.action === 'finish') void confirmDictation();
    else void cancelDictation();
  }), [cancelDictation, channel, confirmDictation, startDictation]);

  const failedRef = React.useRef(false);
  React.useEffect(() => {
    if (status !== 'failed') return;
    const salvage = partialTranscript.trim();
    if (salvage) post({ type: 'insert', text: salvage });
    failedRef.current = true;
    discardFailedDictation();
  }, [discardFailedDictation, partialTranscript, post, status]);

  const note = status === 'recording' && errorReason === 'model_download_in_progress' ? t('chat.dictation.downloadingModel') : '';
  const phase = status === 'recording' ? 'recording' : status === 'uploading' ? 'processing' : status === 'idle' ? 'idle' : null;
  const postedRef = React.useRef({ phase: 'idle', note: '' });
  React.useEffect(() => {
    if (!phase) return;
    const last = postedRef.current;
    if (last.phase === phase && last.note === note) return;
    postedRef.current = { phase, note };
    if (phase === 'idle') {
      post({ type: 'voice', phase, failed: failedRef.current });
      failedRef.current = false;
      return;
    }
    post(note ? { type: 'voice', phase, note } : { type: 'voice', phase });
  }, [note, phase, post]);

  React.useEffect(() => {
    if (status !== 'recording') return;
    let peak = 0;
    let sending = false;
    const unsubscribe = subscribeLevel((level) => { peak = Math.max(peak, level); });
    const timer = setInterval(() => {
      if (sending) return;
      const level = peak;
      peak = 0;
      sending = true;
      void channel.send({ type: 'level', level }).catch(() => undefined).finally(() => { sending = false; });
    }, LEVEL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [channel, status, subscribeLevel]);

  return null;
};
