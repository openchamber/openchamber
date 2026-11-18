import { isPlainObject } from '../shared/guards.js';
import { z } from 'zod';
import type { TrackerRuntimeEvent, TrackerSessionStatusInput, TrackerSessionStatusResult } from './tracker-contract.js';

const isText = (value: unknown): value is string => typeof value === 'string';
const text = z.unknown().transform((value) => isText(value) ? value.trim() : '');
const fields = z.preprocess((value) => isPlainObject(value) ? value : {}, z.object({
  sessionID: text, sessionId: text, type: text, name: text,
}));
const event = z.preprocess((value) => isPlainObject(value) ? value : {}, z.object({
  properties: z.preprocess((value) => isPlainObject(value) ? value : {}, z.object({
    sessionID: text, sessionId: text, session: text,
    info: fields, status: fields, error: fields,
  })),
}));

type SessionStatusOptions = {
  post: (input: Pick<TrackerSessionStatusInput, 'sessionId'> & { kind: 'completed' | 'failure' }) => Promise<TrackerSessionStatusResult>;
  label: string;
  warn?: (...args: unknown[]) => void;
};

export function createSessionStatusRuntime({ post, label, warn = (...args) => console.warn(...args) }: SessionStatusOptions) {
  let stopped = false;
  const send = (kind: 'completed' | 'failure', sessionId: string) => {
    void post({ kind, sessionId }).catch((error) => {
      warn(`[trackers] ${label}: failed to post the session ${kind} comment:`, error?.message || error);
    });
  };
  return {
    processPayload: (payload: TrackerRuntimeEvent) => {
      if (stopped) return;
      const parsed = event.parse(payload);
      const props = parsed.properties;
      const sessionId = props.info.sessionID || props.info.sessionId || props.sessionID || props.sessionId || props.session;
      if (!sessionId || !isPlainObject(payload)) return;
      if (payload.type === 'session.error') {
        if (props.error.name === 'MessageAbortedError') return;
        send('failure', sessionId);
        return;
      }
      if (payload.type !== 'session.status') return;
      const status = props.status.type || props.info.type;
      if (status === 'idle') send('completed', sessionId);
    },
    stop: () => { stopped = true; },
  };
}
