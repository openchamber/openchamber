import { OpenChamberControlError } from '../openchamber-control/error.js';
import { SERVICE_EVENT_DATA_MAX, SERVICE_EVENT_RATE_MAX, SERVICE_HOST_PATH, SERVICE_MARKS_MAX, SERVICE_MARK_RATE_MAX, isGuestApproved, requestedGuestCapabilities } from '@openchamber/sdk';
import { serviceHostCallSchema } from '@openchamber/sdk/schemas';

import { setHostCallbackRoute } from './host-callback.js';
import { guestIdOfServiceToken } from './service.js';
import type { GuestCapability } from '@openchamber/sdk';
import type { z } from 'zod';
import type { GuestRecord } from './contracts.js';
import type { HostCallbackRoute } from './host-callback.js';
import type { createOpenChamberControlService } from '../openchamber-control/service.js';
import type { SessionControlExecute, SessionReadAction } from '../openchamber-control/contracts.js';
import type { createGuestInstructions } from './instructions.js';
import type { createGuestMarks } from './marks.js';
import { hasErrorMessage } from './input-guards.js';

export type ServiceHostControl = Pick<ReturnType<typeof createOpenChamberControlService>,
  'resolveSessionDirectory' | 'stopSession' | 'answerPermission' | 'answerForm' | 'dismissOpenForms'> & { execute: SessionControlExecute };

export interface ServiceHostApiOptions {
  listGuests: () => Promise<GuestRecord[]>;
  control: ServiceHostControl;
  instructions: Pick<ReturnType<typeof createGuestInstructions>, 'set'>;
  readSettings: (guest: GuestRecord) => Promise<Record<string, string>>;
  emitToFrames: (guestId: string, topic: string, data: Extract<ServiceHostCall, { method: 'panels.emit' }>['input']['data']) => void;
  setConfigurationNote: (guestId: string, message: string | null) => void;
  marks: Pick<ReturnType<typeof createGuestMarks>, 'set'>;
  guestIdOfToken?: (token: string) => string | null;
  now?: () => number;
}

type ServiceHostCall = z.infer<typeof serviceHostCallSchema>;
type SessionQuery = { sessionId: string; role?: 'user' | 'assistant'; limit?: number };

const hasIntegerStatusCode = (value: unknown): value is { statusCode: number } => value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && 'statusCode' in value
  && Number.isInteger(value.statusCode);

const fail = (status: number, code: string, message: string) => ({ status, body: { error: { message, code } } });
const ok = <Result>(result: Result) => ({ status: 200, body: { result } });

const controlFailure = (cause: unknown) => {
  const status = hasIntegerStatusCode(cause) ? cause.statusCode : 500;
  const message = hasErrorMessage(cause) ? cause.message : undefined;
  if (status >= 500) console.warn('[service-host] a session call failed:', message ?? cause);
  return fail(status, 'SESSION_FAILED', status >= 500 ? 'OpenChamber could not reach the session.' : String(message ?? 'The call was refused.'));
};

const readSession = async <Action extends SessionReadAction>(control: ServiceHostControl, action: Action, input: SessionQuery) => {
  const directory = await control.resolveSessionDirectory(input.sessionId);
  if (!directory) throw new OpenChamberControlError('Session not found', 404);
  return control.execute(action, input, directory);
};

const lastUserPrompt = async (control: ServiceHostControl, sessionId: string) => {
  const { messages } = await readSession(control, 'session.messages', { sessionId, role: 'user', limit: 1 });
  return messages?.[0]?.text ?? null;
};

const SERVICE_EVENT_CHARS_PER_SECOND = 256_000;
const SERVICE_PROMPTS_PER_HOUR = 60;
const SERVICE_STATUS_CHANGES_PER_MINUTE = 30;

export const createServiceHostApi = ({ listGuests, control, instructions, readSettings, emitToFrames, setConfigurationNote, marks, guestIdOfToken = guestIdOfServiceToken, now = Date.now }: ServiceHostApiOptions) => {
  const emitWindows = new Map<string, { startedAt: number; count: number; chars: number }>();

  const underRateLimit = (guestId: string, chars: number) => {
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

  const needs = (guest: GuestRecord, capability: GuestCapability) => (guest.capabilityGrants?.includes(capability) === true
    ? null
    : fail(403, 'NOT_GRANTED', `This call needs the "${capability}" approval. Ask the user to approve the extension in Settings → Extensions.`));

  const mayAnswer = (guest: GuestRecord) => {
    const refused = needs(guest, 'sessionControl') ?? needs(guest, 'sessionAnswers');
    if (refused) return refused;
    if (guest.sessionControl?.answers !== true) return fail(403, 'NOT_GRANTED', 'Answering the agent needs sessionControl.answers in the manifest.');
    return null;
  };

  const budget = (limit: number, windowMs: number) => {
    const spent = new Map<string, number[]>();
    return (guestId: string) => {
      const at = now();
      const recent = (spent.get(guestId) ?? []).filter((spentAt) => at - spentAt < windowMs);
      const allowed = recent.length < limit;
      spent.set(guestId, allowed ? [...recent, at] : recent);
      return allowed;
    };
  };

  const mayPrompt = budget(SERVICE_PROMPTS_PER_HOUR, 60 * 60 * 1000);
  const mayChangeStatus = budget(SERVICE_STATUS_CHANGES_PER_MINUTE, 60 * 1000);
  const mayChangeMarks = budget(SERVICE_MARK_RATE_MAX, 60 * 1000);
  const serviceEnded = () => fail(401, 'HANDLE_UNKNOWN', 'This service is no longer running.');
  const tooManyPrompts = () => fail(429, 'TOO_MANY_PROMPTS', `A service sends at most ${SERVICE_PROMPTS_PER_HOUR} prompts an hour.`);

  const run = async (guest: GuestRecord, { method, input }: ServiceHostCall, bearer: string) => {
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
        if (guest.marks !== true) return fail(403, 'NOT_GRANTED', 'Setting a mark needs contributes.marks in the manifest.');
        const outcome = marks.set(guest.id, bearer, input.target, input.mark, () => mayChangeMarks(guest.id));
        if (outcome === 'ended') return serviceEnded();
        if (outcome === 'limited') return fail(429, 'TOO_MANY_EVENTS', `A service changes its marks at most ${SERVICE_MARK_RATE_MAX} times a minute.`);
        if (outcome === 'full') return fail(409, 'TOO_MANY_MARKS', `A service holds at most ${SERVICE_MARKS_MAX} marks; remove one first.`);
        return ok({ saved: true });
      }
    }
    return fail(400, 'BAD_REQUEST', 'Unknown call.');
  };

  const serve = async ({ bearer, body }: Parameters<HostCallbackRoute['serve']>[0]) => {
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

  const refusal = (bearer: string) => (guestIdOfToken(bearer) ? null : serviceEnded());

  const register = () => setHostCallbackRoute(SERVICE_HOST_PATH, { refusal, serve });

  return { register, serve, refusal };
};
