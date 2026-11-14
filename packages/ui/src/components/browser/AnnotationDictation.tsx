/**
 * Dictation into the comment of an annotation running in the browser panel.
 *
 * The comment box sits in the page, the microphone in the app. The overlay
 * asks for a recording through the desktop shell's channel into its own world
 * (`browser-panel-driver.mjs`), which the page cannot reach, and this component
 * records with the composer's own dictation, then hands the overlay its state
 * and the transcript. It lives only while an annotation runs, so ending the
 * annotation ends a recording with it.
 */
import React from 'react';
import { z } from 'zod';

import { toast } from '@/components/ui';
import { useDictation } from '@/hooks/useDictation';
import type { AnnotationAppMessage, AnnotationOverlayMessage } from '@/lib/browser/annotationOverlay';
import { useI18n } from '@/lib/i18n';

/** How often the overlay's wave moves; the composer's wave takes a sample every 60 ms. */
const LEVEL_INTERVAL_MS = 80;

/** The error of a recording that waits on its speech model, which the overlay shows instead. */
const modelDownloadSchema = z.object({ reasonCode: z.literal('model_download_in_progress') });

export type AnnotationVoiceChannel = {
  readonly send: (message: AnnotationAppMessage) => Promise<void>;
  readonly subscribe: (listener: (message: AnnotationOverlayMessage) => void) => () => void;
};

export const AnnotationDictation: React.FC<{ channel: AnnotationVoiceChannel }> = ({ channel }) => {
  const { t } = useI18n();

  // In order: a transcript goes in before the state that says the recording is over.
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
      // Shown in the overlay instead; the recording goes on meanwhile.
      if (modelDownloadSchema.safeParse(error).success) return;
      toast.error(t('chat.dictation.failed'), { description: error.message });
    },
  });

  React.useEffect(() => channel.subscribe((message) => {
    if (message.action === 'start') void startDictation();
    else if (message.action === 'finish') void confirmDictation();
    else void cancelDictation();
  }), [cancelDictation, channel, confirmDictation, startDictation]);

  // A failed recording keeps what was transcribed before it failed, and a
  // submit that waited on it stays unsent so the comment can be checked.
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

  // The microphone level for the overlay's wave, at the composer's pace. A
  // level still on its way is not queued behind: the next one replaces it.
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
