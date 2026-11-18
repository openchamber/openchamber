import type { z } from 'zod';
import type { waitArgsSchema } from '@openchamber/sdk/schemas';

import { escapeAttribute } from '../dispatch-results/runtime.js';

export interface WaitSubject {
  title: string;
  label: string | null;
}

export interface WaitWake {
  outcome: 'fired' | 'ended';
  summary: string;
  messageID: string | null;
}

export interface WakingWait extends WaitSubject {
  id: string;
  guestId: string | null;
  type: string;
  args: WaitArgs;
  wake: WaitWake;
}

export type WaitArgs = z.output<ReturnType<typeof waitArgsSchema>>;

export const EXTENSION_WAIT_SOURCE = 'openchamber-wait';

const cleanText = (text: string) => text.replace(/[<>]/g, '').trim();

export const subjectOf = (wait: WaitSubject) => (wait.label ? `${cleanText(wait.title)} (${cleanText(wait.label)})` : cleanText(wait.title));

export const buildWakeMessage = (wait: WakingWait, source: string, timer: boolean) => {
  const subject = subjectOf(wait);
  const summary = cleanText(wait.wake.summary);
  const fired = wait.wake.outcome === 'fired';
  const report = timer
    ? [`${subject} fired: ${summary}`]
    : [`${subject} fired. What the extension "${wait.guestId}" reports, its own words and not the user's:`, summary];
  const lines = fired
    ? [...report, 'The wait is over. Act on it; call wait.start again when you need to wait once more.']
    : [
      `${subject} ended without firing: ${summary}.`,
      'Nothing will wake you for it any more. Go on without it, or start it again once the extension is back.',
    ];
  const firstLine = (summary.split('\n')[0] ?? '').slice(0, 160);
  return {
    text: `<openchamber-wait source="${escapeAttribute(source)}" wait="${escapeAttribute(wait.id)}" outcome="${wait.wake.outcome}">\n${lines.join('\n')}\n</openchamber-wait>`,
    description: fired ? `${subject}: ${firstLine}` : `${subject} ended: ${firstLine}`,
    metadata: {
      source: EXTENSION_WAIT_SOURCE,
      waitId: wait.id,
      extension: wait.guestId,
      type: wait.type,
      title: wait.title,
      label: wait.label,
      outcome: wait.wake.outcome,
      minutes: timer ? wait.args.minutes : null,
      subject,
      summary,
    },
  };
};
