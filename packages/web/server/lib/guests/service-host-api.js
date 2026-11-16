import { OpenChamberControlError } from '../openchamber-control/error.js';
import { SERVICE_EVENT_DATA_MAX, SERVICE_EVENT_RATE_MAX, SERVICE_HOST_PATH, SERVICE_MARKS_MAX, SERVICE_MARK_RATE_MAX, isGuestApproved, requestedGuestCapabilities } from '@openchamber/sdk';
import { serviceHostCallSchema } from '@openchamber/sdk/schemas';

import { setHostCallbackRoute } from './host-callback.js';
import { guestIdOfServiceToken } from './service.js';

/**
 * What a running service may ask of OpenChamber on its own (`service-host.ts`
 * in the SDK). The bearer names the service; the catalog decides each call at
 * that moment, so a paused extension or a withdrawn approval is refused
 * whatever the process still holds.
 */

const fail = (status, code, message) => ({ status, body: { error: { message, code } } });
const ok = (result) => ({ status: 200, body: { result } });

/** Control errors already speak to the caller; anything else stays on the server. */
const controlFailure = (error) => {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.warn('[service-host] a session call failed:', error?.message ?? error);
  return fail(status, 'SESSION_FAILED', status >= 500 ? 'OpenChamber could not reach the session.' : String(error?.message ?? 'The call was refused.'));
};

/** A service names a session only; a read goes to the folder the session lives in. */
const readSession = async (control, action, input) => {
  const directory = await control.resolveSessionDirectory(input.sessionId);
  if (!directory) throw new OpenChamberControlError('Session not found', 404);
  return control.execute(action, input, directory);
};

const lastUserPrompt = async (control, sessionId) => {
  const { messages } = await readSession(control, 'session.messages', { sessionId, role: 'user', limit: 1 });
  return messages?.[0]?.text ?? null;
};

/** Every connected client gets every event, an idle phone over the paid relay too. */
const SERVICE_EVENT_CHARS_PER_SECOND = 256_000;
const SERVICE_PROMPTS_PER_HOUR = 60;
const SERVICE_STATUS_CHANGES_PER_MINUTE = 30;

/**
 * @param {{
 *   listGuests: () => Promise<object[]>,
 *   control: {
 *     execute: (action: string, input: object, directory?: string, options?: object) => Promise<any>,
 *     resolveSessionDirectory: (sessionId: string) => Promise<string | null>,
 *     stopSession: (sessionId: string) => Promise<boolean>,
 *     answerPermission: (input: { sessionID: string, requestID: string, decision: 'once' | 'reject', message?: string }) => Promise<void>,
 *     answerForm: (input: { sessionID: string, formID: string, answer: Record<string, unknown> | null, message?: string }) => Promise<void>,
 *     dismissOpenForms: (sessionId: string) => Promise<void>,
 *   },
 *   instructions: { set: (guestId: string, directory: string | null, text: string) => Promise<void> },
 *   readSettings: (guest: object) => Promise<Record<string, string>>,
 *   emitToFrames: (guestId: string, topic: string, data: unknown) => void,
 *   setConfigurationNote: (guestId: string, message: string | null) => void,
 *   marks: { set: (guestId: string, token: string, target: object, mark: object | null, mayChange: () => boolean) => 'changed' | 'unchanged' | 'full' | 'limited' | 'ended' },
 *   guestIdOfToken?: (token: string) => string | null,
 *   now?: () => number,
 * }} deps
 */
export const createServiceHostApi = ({ listGuests, control, instructions, readSettings, emitToFrames, setConfigurationNote, marks, guestIdOfToken = guestIdOfServiceToken, now = Date.now }) => {
  /** Per guest: the current one-second window of panel events. */
  const emitWindows = new Map();

  const underRateLimit = (guestId, chars) => {
    const at = now();
    const window = emitWindows.get(guestId);
    if (!window || at - window.startedAt >= 1_000) {
      emitWindows.set(guestId, { startedAt: at, count: 1, chars });
      return true;
    }
    window.count += 1;
    window.chars += chars;
    return window.count <= SERVICE_EVENT_RATE_MAX && window.chars <= SERVICE_EVENT_CHARS_PER_SECOND;
  };

  const needs = (guest, capability) => (guest.capabilityGrants?.includes(capability) === true
    ? null
    : fail(403, 'NOT_GRANTED', `This call needs the "${capability}" approval. Ask the user to approve the extension in Settings → Extensions.`));

  /**
   * Answering for the user is its own approval line. A grant left over from a
   * version that asked for it no longer counts once the manifest stops asking.
   */
  const mayAnswer = (guest) => {
    const refused = needs(guest, 'sessionControl') ?? needs(guest, 'sessionAnswers');
    if (refused) return refused;
    if (guest.sessionControl?.answers !== true) return fail(403, 'NOT_GRANTED', 'Answering the agent needs sessionControl.answers in the manifest.');
    return null;
  };

  /** A counter per guest over a sliding window; what it refuses does not count. */
  const budget = (limit, windowMs) => {
    const spent = new Map();
    return (guestId) => {
      const at = now();
      const recent = (spent.get(guestId) ?? []).filter((spentAt) => at - spentAt < windowMs);
      const allowed = recent.length < limit;
      spent.set(guestId, allowed ? [...recent, at] : recent);
      return allowed;
    };
  };

  /** A loop in a service cannot spend the user's tokens without end. */
  const mayPrompt = budget(SERVICE_PROMPTS_PER_HOUR, 60 * 60 * 1000);
  /** A changed note makes every client reload the catalog. */
  const mayChangeStatus = budget(SERVICE_STATUS_CHANGES_PER_MINUTE, 60 * 1000);
  /** A changed mark makes every client read the marks again; setting one to what it already is costs nothing. */
  const mayChangeMarks = budget(SERVICE_MARK_RATE_MAX, 60 * 1000);
  const serviceEnded = () => fail(401, 'HANDLE_UNKNOWN', 'This service is no longer running.');
  const tooManyPrompts = () => fail(429, 'TOO_MANY_PROMPTS', `A service sends at most ${SERVICE_PROMPTS_PER_HOUR} prompts an hour.`);

  const run = async (guest, { method, input }, bearer) => {
    switch (method) {
      case 'sessions.start': {
        const refused = needs(guest, 'sessionControl');
        if (refused) return refused;
        if (!mayPrompt(guest.id)) return tooManyPrompts();
        const result = await control.execute('session.create', input, undefined, { startedByExtension: guest.id });
        return ok({ sessionId: result.sessionId, directory: result.directory ?? null });
      }
      case 'sessions.send': {
        const refused = needs(guest, 'sessionControl');
        if (refused) return refused;
        if (!mayPrompt(guest.id)) return tooManyPrompts();
        await control.dismissOpenForms(input.sessionId);
        await control.execute('session.send', input);
        return ok({ sent: true });
      }
      case 'sessions.retry': {
        const refused = needs(guest, 'sessionControl');
        if (refused) return refused;
        const prompt = await lastUserPrompt(control, input.sessionId);
        if (!prompt) return fail(409, 'NOTHING_TO_RETRY', 'The session has no message to send again.');
        if (!mayPrompt(guest.id)) return tooManyPrompts();
        await control.execute('session.send', { sessionId: input.sessionId, prompt });
        return ok({ sent: true });
      }
      case 'sessions.status': {
        const refused = needs(guest, 'sessionControl');
        if (refused) return refused;
        const { sessionStatus } = await readSession(control, 'session.status', input);
        return ok({ status: sessionStatus?.type ?? 'idle' });
      }
      case 'sessions.lastReply': {
        // `transcript` also covers `sessionEvents.content`; reading replies is asked for here.
        const refused = needs(guest, 'sessionControl') ?? needs(guest, 'transcript');
        if (refused) return refused;
        if (guest.sessionControl?.content !== true) return fail(403, 'NOT_GRANTED', 'Reading a reply needs sessionControl.content in the manifest.');
        const { messages } = await readSession(control, 'session.messages', { sessionId: input.sessionId, role: 'assistant', limit: 1 });
        return ok({ reply: messages?.[0]?.text ?? null });
      }
      case 'sessions.stop': {
        const refused = needs(guest, 'sessionControl');
        if (refused) return refused;
        return ok({ stopped: await control.stopSession(input.sessionId) });
      }
      case 'sessions.answerPermission': {
        const refused = mayAnswer(guest);
        if (refused) return refused;
        await control.answerPermission({
          sessionID: input.sessionId,
          requestID: input.requestId,
          decision: input.decision === 'allow' ? 'once' : 'reject',
          message: input.decision === 'deny' ? input.message : undefined,
        });
        return ok({ answered: true });
      }
      case 'sessions.answerForm': {
        const refused = mayAnswer(guest);
        if (refused) return refused;
        await control.answerForm({ sessionID: input.sessionId, formID: input.formId, answer: input.values, message: input.message });
        return ok({ answered: true });
      }
      case 'instructions.set': {
        const refused = needs(guest, 'instructions');
        if (refused) return refused;
        await instructions.set(guest.id, input.directory, input.text);
        return ok({ saved: true });
      }
      case 'panels.emit': {
        const chars = JSON.stringify(input.data ?? null).length;
        if (chars > SERVICE_EVENT_DATA_MAX) {
          return fail(413, 'EVENT_TOO_LARGE', `An event carries at most ${SERVICE_EVENT_DATA_MAX} characters of JSON.`);
        }
        if (!underRateLimit(guest.id, chars)) return fail(429, 'TOO_MANY_EVENTS', `A service sends at most ${SERVICE_EVENT_RATE_MAX} events or ${SERVICE_EVENT_CHARS_PER_SECOND} characters a second.`);
        emitToFrames(guest.id, input.topic, input.data ?? null);
        return ok({ delivered: true });
      }
      case 'settings.read':
        return ok({ settings: await readSettings(guest) });
      case 'status.set':
        if (!mayChangeStatus(guest.id)) return fail(429, 'TOO_MANY_EVENTS', `A service sets its status at most ${SERVICE_STATUS_CHANGES_PER_MINUTE} times a minute.`);
        setConfigurationNote(guest.id, input.needsConfiguration);
        return ok({ saved: true });
      case 'marks.set': {
        const refused = needs(guest, 'marks');
        if (refused) return refused;
        // A grant left over from a version that asked for marks no longer counts once the manifest stops asking.
        if (guest.marks !== true) return fail(403, 'NOT_GRANTED', 'Setting a mark needs contributes.marks in the manifest.');
        // The catalog read above took time; the store writes only for the process the bearer still names.
        const outcome = marks.set(guest.id, bearer, input.target, input.mark, () => mayChangeMarks(guest.id));
        if (outcome === 'ended') return serviceEnded();
        if (outcome === 'limited') return fail(429, 'TOO_MANY_EVENTS', `A service changes its marks at most ${SERVICE_MARK_RATE_MAX} times a minute.`);
        if (outcome === 'full') return fail(409, 'TOO_MANY_MARKS', `A service holds at most ${SERVICE_MARKS_MAX} marks; remove one first.`);
        return ok({ saved: true });
      }
    }
    return fail(400, 'BAD_REQUEST', 'Unknown call.');
  };

  const serve = async ({ bearer, body }) => {
    const parsed = serviceHostCallSchema.safeParse(body);
    if (!parsed.success) return fail(400, 'BAD_REQUEST', parsed.error.issues[0]?.message ?? 'The call does not parse.');
    const guestId = guestIdOfToken(bearer);
    if (!guestId) return serviceEnded();
    const guests = await listGuests();
    const guest = guests.find((row) => row.id === guestId);
    if (!guest || guest.enabled === false || !isGuestApproved({ requested: requestedGuestCapabilities(guest), granted: guest.capabilityGrants ?? [] })) {
      return fail(403, 'DISABLED', 'The extension is paused or not approved.');
    }
    try {
      return await run(guest, parsed.data, bearer);
    } catch (error) {
      return controlFailure(error);
    }
  };

  const refusal = (bearer) => (guestIdOfToken(bearer) ? null : serviceEnded());

  /** Serves the route; returns the function that removes it again. */
  const register = () => setHostCallbackRoute(SERVICE_HOST_PATH, { refusal, serve });

  return { register, serve, refusal };
};
