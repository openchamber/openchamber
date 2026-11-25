import { asNonEmptyString, isRecord, isString } from '../shared/guards.js';
import type { JsonValue } from '../shared/json-values.js';
import type { PendingPermission, PendingRequests, WaitingRequest } from './contracts.js';

interface WaitingOnDependencies {
  readPendingRequests: () => { [sessionID: string]: PendingRequests };
  isPermissionAutoAnswered: (sessionID: string, directory: PendingPermission['directory'], permissionID: PendingPermission['id']) => Promise<boolean>;
  isRunning: (sessionID: string) => Promise<boolean>;
}

interface DispatchedPrompt {
  promptDispatched: boolean;
  dispatchedAsCommand?: boolean;
}

type RequestIds = ReadonlySet<JsonValue | undefined>;

const PROMPT_WAITS_NOTE = 'The session is waiting for the user to answer what waitingOn lists, so your prompt waits in its inbox, and its agent reads it only after the user answers there. Send the user to that session to answer; don\'t report the prompt as delivered.';

const textOf = (value: JsonValue | undefined) => asNonEmptyString(value) ?? '';
const listOf = (value: JsonValue | undefined) => (Array.isArray(value) ? value : []);

const questionsOf = (fields: JsonValue | undefined) => listOf(fields).flatMap((field) => {
  if (!isRecord(field) || field.hidden === true) return [];
  const question = asNonEmptyString(field.description) ?? asNonEmptyString(field.title);
  return question ? [question] : [];
});

const pageOf = (page: PendingRequests['pages'][number]): WaitingRequest => ({ kind: 'page', title: textOf(page.title) });

const formOf = (form: PendingRequests['forms'][number]): WaitingRequest => ({ kind: 'form', title: textOf(form.title), questions: questionsOf(form.fields) });

const permissionOf = (permission: PendingPermission): WaitingRequest => ({
  kind: 'permission',
  action: textOf(permission.action),
  resources: listOf(permission.resources).filter(isString),
});

export const createWaitingOn = ({ readPendingRequests, isPermissionAutoAnswered, isRunning }: WaitingOnDependencies) => {
  const openRequests = async (sessionID: string) => {
    const pending = readPendingRequests()[sessionID];
    if (!pending) return [];
    const answered = await Promise.all(pending.permissions.map((permission) =>
      isPermissionAutoAnswered(sessionID, permission.directory, permission.id)));
    return [
      ...pending.pages.map((page) => ({ id: page.id, request: pageOf(page) })),
      ...pending.forms.map((form) => ({ id: form.id, request: formOf(form) })),
      ...pending.permissions.filter((_, index) => !answered[index]).map((permission) => ({ id: permission.id, request: permissionOf(permission) })),
    ];
  };

  const waitingOn = async (sessionID: string) => (await openRequests(sessionID)).map(({ request }) => request);

  const openBeforePrompt = async (sessionID: string): Promise<RequestIds> => {
    const pending = readPendingRequests()[sessionID];
    if (!pending) return new Set();
    try {
      if (!await isRunning(sessionID)) return new Set();
    } catch (error) {
      console.warn('[session.send] could not read whether the session waits for the user:', error instanceof Error ? error.message : error);
      return new Set();
    }
    return new Set([...pending.pages, ...pending.forms, ...pending.permissions].map(({ id }) => id));
  };

  const withPromptHold = async <Result extends DispatchedPrompt>(sessionID: string, openBefore: RequestIds, result: Result, promptedByAgent: boolean) => {
    if (openBefore.size === 0 || !result.promptDispatched) return result;
    const endsPageWaits = !promptedByAgent || result.dispatchedAsCommand === true;
    const held = (await openRequests(sessionID))
      .filter(({ id, request }) => openBefore.has(id) && (request.kind !== 'page' || !endsPageWaits))
      .map(({ request }) => request);
    return held.length > 0 ? { ...result, waitingOn: held, note: PROMPT_WAITS_NOTE } : result;
  };

  return { waitingOn, openBeforePrompt, withPromptHold };
};
