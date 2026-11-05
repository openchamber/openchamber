import { SERVICE_EVENT_DATA_MAX, SERVICE_EVENT_RATE_MAX, SERVICE_HOST_PATH, isGuestApproved, requestedGuestCapabilities } from '@openchamber/sdk';
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
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) console.warn('[service-host] a session call failed:', error?.message ?? error);
  return fail(status, 'SESSION_FAILED', status >= 500 ? 'OpenChamber could not reach the session.' : String(error?.message ?? 'The call was refused.'));
};

const lastUserPrompt = async (control, sessionId) => {
  const { messages } = await control.execute('session.messages', { sessionId, role: 'user', limit: 1 });
  return messages?.[0]?.text ?? null;
};

/**
 * @param {{
 *   listGuests: () => Promise<object[]>,
 *   control: { execute: (action: string, input: object, directory?: string, options?: object) => Promise<any> },
 *   instructions: { set: (guestId: string, directory: string | null, text: string) => Promise<void> },
 *   readSettings: (guest: object) => Promise<Record<string, string>>,
 *   emitToFrames: (guestId: string, topic: string, data: unknown) => void,
 *   setConfigurationNote: (guestId: string, message: string | null) => void,
 *   guestIdOfToken?: (token: string) => string | null,
 *   now?: () => number,
 * }} deps
 */
export const createServiceHostApi = ({ listGuests, control, instructions, readSettings, emitToFrames, setConfigurationNote, guestIdOfToken = guestIdOfServiceToken, now = Date.now }) => {
  /** Per guest: the current one-second window of panel events. */
  const emitWindows = new Map();

  const underRateLimit = (guestId) => {
    const at = now();
    const window = emitWindows.get(guestId);
    if (!window || at - window.startedAt >= 1_000) {
      emitWindows.set(guestId, { startedAt: at, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= SERVICE_EVENT_RATE_MAX;
  };

  const needs = (guest, capability) => (guest.capabilityGrants?.includes(capability) === true
    ? null
    : fail(403, 'NOT_GRANTED', `This call needs the "${capability}" approval. Ask the user to approve the extension in Settings → Extensions.`));

  const run = async (guest, { method, input }) => {
    switch (method) {
      case 'sessions.start': {
        const refused = needs(guest, 'sessionControl');
        if (refused) return refused;
        const result = await control.execute('session.create', input);
        return ok({ sessionId: result.sessionId, directory: result.directory ?? null });
      }
      case 'sessions.send': {
        const refused = needs(guest, 'sessionControl');
        if (refused) return refused;
        await control.execute('session.send', input);
        return ok({ sent: true });
      }
      case 'sessions.retry': {
        const refused = needs(guest, 'sessionControl');
        if (refused) return refused;
        const prompt = await lastUserPrompt(control, input.sessionId);
        if (!prompt) return fail(409, 'NOTHING_TO_RETRY', 'The session has no message to send again.');
        await control.execute('session.send', { sessionId: input.sessionId, prompt });
        return ok({ sent: true });
      }
      case 'sessions.status': {
        const refused = needs(guest, 'sessionControl');
        if (refused) return refused;
        const { sessionStatus } = await control.execute('session.status', input);
        return ok({ status: sessionStatus?.type ?? 'idle' });
      }
      case 'sessions.lastReply': {
        // `transcript` also covers `sessionEvents.content`; reading replies is asked for here.
        const refused = needs(guest, 'sessionControl') ?? needs(guest, 'transcript');
        if (refused) return refused;
        if (guest.sessionControl?.content !== true) return fail(403, 'NOT_GRANTED', 'Reading a reply needs sessionControl.content in the manifest.');
        const { messages } = await control.execute('session.messages', { sessionId: input.sessionId, role: 'assistant', limit: 1 });
        return ok({ reply: messages?.[0]?.text ?? null });
      }
      case 'instructions.set': {
        const refused = needs(guest, 'instructions');
        if (refused) return refused;
        await instructions.set(guest.id, input.directory, input.text);
        return ok({ saved: true });
      }
      case 'panels.emit': {
        if (JSON.stringify(input.data ?? null).length > SERVICE_EVENT_DATA_MAX) {
          return fail(413, 'EVENT_TOO_LARGE', `An event carries at most ${SERVICE_EVENT_DATA_MAX} characters of JSON.`);
        }
        if (!underRateLimit(guest.id)) return fail(429, 'TOO_MANY_EVENTS', `A service sends at most ${SERVICE_EVENT_RATE_MAX} events a second.`);
        emitToFrames(guest.id, input.topic, input.data ?? null);
        return ok({ delivered: true });
      }
      case 'settings.read':
        return ok({ settings: await readSettings(guest) });
      case 'status.set':
        setConfigurationNote(guest.id, input.needsConfiguration);
        return ok({ saved: true });
    }
    return fail(400, 'BAD_REQUEST', 'Unknown call.');
  };

  const serve = async ({ bearer, body }) => {
    const parsed = serviceHostCallSchema.safeParse(body);
    if (!parsed.success) return fail(400, 'BAD_REQUEST', parsed.error.issues[0]?.message ?? 'The call does not parse.');
    const guestId = guestIdOfToken(bearer);
    if (!guestId) return fail(401, 'HANDLE_UNKNOWN', 'This service is no longer running.');
    const guests = await listGuests();
    const guest = guests.find((row) => row.id === guestId);
    if (!guest || guest.enabled === false || !isGuestApproved({ requested: requestedGuestCapabilities(guest), granted: guest.capabilityGrants ?? [] })) {
      return fail(403, 'DISABLED', 'The extension is paused or not approved.');
    }
    try {
      return await run(guest, parsed.data);
    } catch (error) {
      return controlFailure(error);
    }
  };

  const refusal = (bearer) => (guestIdOfToken(bearer) ? null : fail(401, 'HANDLE_UNKNOWN', 'This service is no longer running.'));

  /** Serves the route; returns the function that removes it again. */
  const register = () => setHostCallbackRoute(SERVICE_HOST_PATH, { refusal, serve });

  return { register, serve, refusal };
};
