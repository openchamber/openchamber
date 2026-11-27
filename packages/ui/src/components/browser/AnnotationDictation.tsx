import React from 'react';

import type { AnnotationAppMessage } from '@/lib/browser/annotationOverlay';
import {
  cancelFieldDictation,
  fieldDictationsEnded,
  finishFieldDictation,
  hasActiveFieldDictation,
  isWindowClosePending,
  setWindowClosePending,
  startFieldDictation,
  useFieldRecording,
} from '@/lib/dictation/fieldDictation';
import { useI18n } from '@/lib/i18n';
import { delay } from '@/lib/timing/delay';
import type { AnnotationVoiceChannel } from './useAnnotationVoiceRun';

const LEVEL_INTERVAL_MS = 80;
const ATTACH_WAIT_MS = 5_000;

const attachedBeforeClose = async (attached: Promise<boolean>): Promise<boolean> => {
  for (;;) {
    const settled = await Promise.race([attached, delay(ATTACH_WAIT_MS).then(() => null)]);
    if (settled !== null) return settled;
    if (isWindowClosePending()) return false;
  }
};

export const AnnotationDictation: React.FC<{ channel: AnnotationVoiceChannel }> = ({ channel }) => {
  const { t } = useI18n();
  const { fieldKey, panelKey } = channel;
  const recording = useFieldRecording(fieldKey);

  const queueRef = React.useRef<Promise<void>>(Promise.resolve());
  const heldRef = React.useRef<string[]>([]);
  const post = React.useCallback((message: AnnotationAppMessage) => {
    queueRef.current = queueRef.current.then(async () => { await channel.send(message); }).catch(() => undefined);
  }, [channel]);

  const insert = React.useCallback((text: string) => {
    const keep = (kept: string) => {
      if (!channel.keep(kept)) setWindowClosePending(false);
    };
    const ends = !hasActiveFieldDictation(fieldKey);
    if (!ends && isWindowClosePending()) {
      keep(text);
      return Promise.resolve();
    }
    const whole = [...(ends ? heldRef.current.splice(0) : []), text].join(' ');
    if (!ends) heldRef.current.push(text);
    const sent = queueRef.current.then(() => channel.send({ type: 'insert', text, ends })).catch(() => null);
    queueRef.current = sent.then(() => undefined);
    return sent.then(async (reply) => {
      if (!ends) {
        if (reply?.delivered) await fieldDictationsEnded(fieldKey);
        const held = heldRef.current.indexOf(text);
        if (held === -1) return;
        heldRef.current.splice(held, 1);
        if (!reply?.delivered || isWindowClosePending()) keep(text);
        return;
      }
      if (reply?.submitting) {
        if (await attachedBeforeClose(channel.attached)) return;
        keep(whole);
        channel.dropAttach();
        return;
      }
      if (!reply?.delivered || isWindowClosePending()) keep(whole);
    });
  }, [channel, fieldKey]);

  React.useEffect(() => channel.subscribe((message) => {
    if (message.action === 'start') startFieldDictation({ fieldKey, panelKey, insert });
    else if (message.action === 'finish') finishFieldDictation(fieldKey);
    else cancelFieldDictation(fieldKey);
  }), [channel, fieldKey, insert, panelKey]);

  React.useEffect(() => () => finishFieldDictation(fieldKey), [fieldKey]);

  const status = recording?.view.status ?? 'idle';
  const failed = status === 'failed';
  const note = status === 'recording' && recording?.view.errorReason === 'model_download_in_progress' ? t('chat.dictation.downloadingModel') : '';
  const phase = status === 'recording' ? 'recording' : status === 'uploading' ? 'processing' : 'idle';
  const postedRef = React.useRef({ phase: 'idle', note: '' });
  React.useEffect(() => {
    const last = postedRef.current;
    if (last.phase === phase && last.note === note) return;
    postedRef.current = { phase, note };
    if (phase === 'idle') post({ type: 'voice', phase, failed });
    else post(note ? { type: 'voice', phase, note } : { type: 'voice', phase });
  }, [failed, note, phase, post]);

  const subscribeLevel = recording?.actions?.subscribeLevel;
  React.useEffect(() => {
    if (status !== 'recording' || !subscribeLevel) return;
    let peak = 0;
    let sending = false;
    const unsubscribe = subscribeLevel((level) => { peak = Math.max(peak, level); });
    const timer = setInterval(() => {
      if (sending) return;
      const level = peak;
      peak = 0;
      sending = true;
      void channel.send({ type: 'level', level }).catch(() => false).finally(() => { sending = false; });
    }, LEVEL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [channel, status, subscribeLevel]);

  return null;
};
