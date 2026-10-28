import { z } from 'zod';
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from '../openchamber-control/error.js';

const json = z.json();
const pageKey = (sessionId, callId) => `${sessionId}\0${callId}`;
const noLongerWaiting = () => new OpenChamberControlError('This page is no longer waiting for an answer', 404);

/** Page answers resolve their pending session/call once, as in the HTML tool. */
export const createOpenUIAnswers = ({ onWaitChange = () => {} } = {}) => {
  const waiting = new Map();
  const announce = (change) => {
    try {
      onWaitChange(change);
    } catch (error) {
      console.warn('[openui] wait listener failed:', error?.message ?? error);
    }
  };

  const wait = ({ sessionId, callId, directory, signal }) => new Promise((resolve, reject) => {
    const key = pageKey(sessionId, callId);
    if (waiting.has(key)) {
      reject(new OpenChamberControlError('This call already shows a page that waits for an answer', 409));
      return;
    }
    const stopped = () => new OpenChamberControlError('The page stopped waiting before the user answered', 499);
    if (signal?.aborted) { reject(stopped()); return; }
    const finish = (complete) => {
      if (waiting.get(key) !== entry) return false;
      waiting.delete(key);
      signal?.removeEventListener('abort', onAbort);
      announce({ type: 'settled', sessionId, callId });
      complete();
      return true;
    };
    const entry = {
      reject: (error) => finish(() => reject(error)),
      settle: (answer) => {
        if (!finish(() => resolve(answer))) throw noLongerWaiting();
        return { answered: true };
      },
    };
    const onAbort = () => entry.reject(stopped());
    waiting.set(key, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    announce({ type: 'waiting', sessionId, callId, title: 'OpenUI response', directory: directory || null });
  });

  const answer = (input = {}) => {
    const sessionId = asNonEmptyString(input.sessionId);
    const callId = asNonEmptyString(input.callId);
    if (!sessionId || !callId) throw new OpenChamberControlError('sessionId and callId are required', 400);
    const summary = asNonEmptyString(input.summary);
    if (!summary) throw new OpenChamberControlError('summary is required: what the user chose, in a few words', 400);
    if (summary.length > 500) throw new OpenChamberControlError(`summary is ${summary.length} characters; the limit is 500`, 400);
    let data;
    try {
      data = json.parse(input.data === undefined ? null : input.data);
    } catch {
      throw new OpenChamberControlError('data must be JSON-serializable', 400);
    }
    const length = JSON.stringify(data).length;
    if (length > 16_000) throw new OpenChamberControlError(`data is ${length} characters as JSON; the limit is 16000`, 413);
    const entry = waiting.get(pageKey(sessionId, callId));
    if (!entry) throw noLongerWaiting();
    const result = { answered: true, summary, data };
    return entry.settle(result);
  };

  return {
    wait,
    answer,
    cancel: (error) => {
      for (const entry of waiting.values()) entry.reject(error);
    },
  };
};
