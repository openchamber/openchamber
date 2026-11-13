import { z } from 'zod';

import type { JsonValue } from '@/lib/opencode/model';

/**
 * The frame protocol between a shared page and the relay's viewer (the
 * viewer's half is `apps/relay/src/share/viewer.ts` in the website repository;
 * change both together):
 *
 *   page -> viewer  { source: "openchamber-share-document", type: "submit", data, summary }
 *   viewer -> page  { source: "openchamber-share-viewer", type: "init", wantsAnswer, locale }
 *                   { source: "openchamber-share-viewer", type: "submit-result", ok, error? }
 *
 * The page runs in an opaque origin; the viewer is its only parent.
 */

export const SHARE_DOCUMENT_SOURCE = 'openchamber-share-document';
export const SHARE_VIEWER_SOURCE = 'openchamber-share-viewer';

/** What the viewer posts to the page; parse `MessageEvent.data` with it where the message arrives. */
export const viewerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    source: z.literal(SHARE_VIEWER_SOURCE),
    type: z.literal('init'),
    wantsAnswer: z.boolean().catch(false),
    locale: z.string().nullish().catch(null).transform((value) => value || null),
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

/** What the page posts to the viewer. */
export type ShareSubmitMessage = { source: typeof SHARE_DOCUMENT_SOURCE; type: 'submit'; data: JsonValue; summary: string };

/** The page's own submit message, read where the app plays the viewer (the author's preview). */
export const shareSubmitMessageSchema = z.object({ source: z.literal(SHARE_DOCUMENT_SOURCE), type: z.literal('submit') });

/**
 * The page's side of the protocol: `submit` posts one answer and settles when
 * the viewer says whether it was delivered. Only one answer is on its way at a
 * time, and none after one went through; a viewer that said the share takes
 * no answer refuses it here too (the viewer checks again).
 */
export function createShareSubmitter({ post, listen, onInit }: {
  post: (message: ShareSubmitMessage) => void;
  /** Subscribes to the viewer's messages, already parsed with `viewerMessageSchema`. */
  listen: (handler: (message: ViewerMessage) => void) => void;
  onInit?: (init: ViewerInit) => void;
}) {
  let wantsAnswer: boolean | null = null;
  let sent = false;
  let pending: { resolve: () => void; reject: (error: Error) => void } | null = null;

  listen((message) => {
    if (message.type === 'init') {
      wantsAnswer = message.wantsAnswer;
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
