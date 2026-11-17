import { z } from 'zod';

import type { JsonValue } from '@/lib/opencode/model';

export const SHARE_DOCUMENT_SOURCE = 'openchamber-share-document';
export const SHARE_VIEWER_SOURCE = 'openchamber-share-viewer';

export const viewerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    source: z.literal(SHARE_VIEWER_SOURCE),
    type: z.literal('init'),
    wantsAnswer: z.boolean().catch(false),
    locale: z.string().nullish().catch(null).transform((value) => value || null),
    answer: z.json().optional().catch(undefined),
  }),
  z.object({
    source: z.literal(SHARE_VIEWER_SOURCE),
    type: z.literal('submit-result'),
    ok: z.boolean().catch(false),
    error: z.string().nullish().catch(null).transform((value) => value || null),
  }),
]);

export type ViewerMessage = z.infer<typeof viewerMessageSchema>;
type ViewerInit = Extract<ViewerMessage, { type: 'init' }>;

export type ShareSubmitMessage = { source: typeof SHARE_DOCUMENT_SOURCE; type: 'submit'; data: JsonValue; summary: string };

export const shareSubmitMessageSchema = z.object({ source: z.literal(SHARE_DOCUMENT_SOURCE), type: z.literal('submit') });

export function createShareSubmitter({ post, listen, onInit }: {
  post: (message: ShareSubmitMessage) => void;
  listen: (handler: (message: ViewerMessage) => void) => void;
  onInit?: (init: ViewerInit) => void;
}) {
  let wantsAnswer: boolean | null = null;
  let sent = false;
  let pending: { resolve: () => void; reject: (error: Error) => void } | null = null;

  listen((message) => {
    if (message.type === 'init') {
      wantsAnswer = message.wantsAnswer;
      if (message.answer !== undefined && message.answer !== null) sent = true;
      onInit?.(message);
      return;
    }
    const waiting = pending;
    if (!waiting) return;
    pending = null;
    if (message.ok) {
      sent = true;
      waiting.resolve();
    } else {
      waiting.reject(new Error(message.error ?? 'The answer was not sent'));
    }
  });

  return (data: JsonValue, summary: string): Promise<void> => new Promise((resolve, reject) => {
    if (sent) return reject(new Error('The answer was already sent'));
    if (wantsAnswer === false) return reject(new Error('This page does not take an answer'));
    if (pending) return reject(new Error('An answer is already on its way'));
    if (!summary.trim()) return reject(new Error('summary is required: the choice in a few words'));
    pending = { resolve, reject };
    post({ source: SHARE_DOCUMENT_SOURCE, type: 'submit', data, summary: summary.trim() });
  });
}
