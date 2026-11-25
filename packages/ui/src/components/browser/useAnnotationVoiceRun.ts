import React from 'react';
import { z } from 'zod';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { AnnotationAppMessage, AnnotationOverlayMessage } from '@/lib/browser/annotationOverlay';
import type { DriveStep } from '@/lib/browser/pageDriver';
import { browserPanelKey, discardFieldDictations, useFieldPanelOpen } from '@/lib/dictation/fieldDictation';
import { readComposerDraftTarget } from '@/hooks/useComposerAddress';
import { useAnnotationTextKeeper } from './useAnnotationAttach';

const annotationMessageReplySchema = z.object({ ended: z.boolean().optional(), message: z.string().nullable().optional() });
const overlayMessageSchema = z.object({ type: z.literal('voice'), action: z.enum(['start', 'finish', 'cancel']) });
const deliverySchema = z.object({ delivered: z.boolean(), submitting: z.boolean().default(false) });
type AnnotationDelivery = z.infer<typeof deliverySchema>;
const LOST: AnnotationDelivery = { delivered: false, submitting: false };

export type AnnotationRun = { id: number; done: boolean; cancelled: boolean };

export type AnnotationVoiceChannel = {
  readonly fieldKey: string;
  readonly panelKey: string;
  readonly send: (message: AnnotationAppMessage) => Promise<AnnotationDelivery>;
  readonly attached: Promise<boolean>;
  readonly subscribe: (listener: (message: AnnotationOverlayMessage) => void) => () => void;
  readonly keep: (text: string) => boolean;
  readonly dropAttach: () => void;
};

let voiceRuns = 0;

export const useAnnotationVoiceRun = ({ driveStep, directory, tabID, panelOpen, pageUrl }: {
  driveStep: DriveStep;
  directory: string;
  tabID: string;
  panelOpen: boolean;
  pageUrl: string;
}) => {
  const { t } = useI18n();
  const [channel, setChannel] = React.useState<AnnotationVoiceChannel | null>(null);
  const channelRef = React.useRef(channel);
  channelRef.current = channel;
  const keepText = useAnnotationTextKeeper();
  const panelKey = browserPanelKey(directory, tabID);
  useFieldPanelOpen(panelKey, panelOpen);

  const listen = React.useCallback(async (listeners: Set<(message: AnnotationOverlayMessage) => void>, run: AnnotationRun) => {
    while (!run.done) {
      let reply: z.infer<typeof annotationMessageReplySchema>;
      try {
        reply = annotationMessageReplySchema.parse(await driveStep('annotationMessage', { sessionId: run.id, timeoutMs: 20_000 }));
      } catch {
        return;
      }
      if (reply.ended) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      if (!reply.message) continue;
      let parsed: z.infer<typeof overlayMessageSchema> | null = null;
      try {
        parsed = overlayMessageSchema.parse(JSON.parse(reply.message));
      } catch {
        continue;
      }
      for (const listener of [...listeners]) listener(parsed);
    }
  }, [driveStep]);

  const open = React.useCallback((run: AnnotationRun, attached: Promise<boolean>): (() => void) => {
    const listeners = new Set<(message: AnnotationOverlayMessage) => void>();
    const target = readComposerDraftTarget(directory);
    voiceRuns += 1;
    setChannel({
      fieldKey: `annotation:${voiceRuns}`,
      panelKey,
      send: async (message) => {
        if (run.done || run.cancelled) return LOST;
        const reply = deliverySchema.safeParse(await driveStep('annotationSend', { message }));
        return reply.success ? reply.data : LOST;
      },
      attached,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      keep: (text) => {
        if (run.cancelled || (target && keepText(target, { text, url: pageUrl }))) return true;
        toast.error(t('contextPanel.browser.annotate.noSession'), { description: text, duration: Infinity });
        return false;
      },
      dropAttach: () => { run.cancelled = true; },
    });
    return () => { void listen(listeners, run); };
  }, [directory, driveStep, keepText, listen, pageUrl, panelKey, t]);

  const close = React.useCallback(() => setChannel(null), []);
  const discard = React.useCallback(() => {
    if (channelRef.current) discardFieldDictations(channelRef.current.fieldKey);
    setChannel(null);
  }, []);

  return { channel, open, close, discard };
};
