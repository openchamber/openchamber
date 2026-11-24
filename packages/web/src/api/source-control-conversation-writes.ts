import type {
  SetConversationLockInput,
  SetItemSubscriptionInput,
} from '@openchamber/ui/lib/source-control/mutation-writes';
import type {
  SourceControlEmptyMutationResult,
  SourceControlExistingMutationTarget,
  SourceControlMutationContext,
  SourceControlMutationReceipt,
  SourceControlReadContext,
} from '@openchamber/ui/lib/source-control/types';

import {
  boundReadQuery,
  mutationBody,
  normalizeIdentity,
  parseEmptyMutationResult,
  parseMutationReceipt,
  post,
  request,
  type ErrorResponse,
  type MutationReceiptDTO,
} from './source-control';

type ConversationFields = { locked: boolean } | { subscribed: boolean };

const write = async (
  fetch: Parameters<typeof post>[0],
  path: string,
  payload: SourceControlMutationContext<SourceControlExistingMutationTarget>,
  fields: ConversationFields,
): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>> => {
  const identity = normalizeIdentity(payload);
  const result = await post<MutationReceiptDTO>(fetch, identity, path, { ...mutationBody(payload, identity, 'existing'), ...fields });
  return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
};

export const createConversationWrites = (fetch: Parameters<typeof post>[0]) => ({
  issueSetLock: (payload: SetConversationLockInput) => write(fetch, '/issues/lock', payload, { locked: payload.locked }),
  changeRequestSetLock: (payload: SetConversationLockInput) => write(fetch, '/pr/lock', payload, { locked: payload.locked }),
  issueSetSubscription: (payload: SetItemSubscriptionInput) => write(fetch, '/issues/subscription', payload, { subscribed: payload.subscribed }),
  changeRequestSetSubscription: (payload: SetItemSubscriptionInput) => write(fetch, '/pr/subscription', payload, { subscribed: payload.subscribed }),
});

export const readCredentialScopes = async (
  fetch: Parameters<typeof request>[0],
  context: SourceControlReadContext,
): Promise<string[] | null> => {
  const identity = normalizeIdentity(context);
  const payload = await request<{ scopes: string[] | null } & ErrorResponse>(fetch, identity, '/repo/scopes', {}, boundReadQuery(context));
  const scopes = payload?.scopes;
  if (scopes === null) return null;
  if (!Array.isArray(scopes) || scopes.some((scope) => Object.prototype.toString.call(scope) !== '[object String]')) {
    throw new Error('Source control response contained invalid credential scopes');
  }
  return scopes;
};

export const readRepoCapabilities = async (
  fetch: Parameters<typeof request>[0],
  context: SourceControlReadContext,
): Promise<{ lock: boolean | null }> => {
  const payload = await request<{ lock?: boolean | null } & ErrorResponse>(fetch, normalizeIdentity(context), '/repo/capabilities', {}, boundReadQuery(context));
  const lock = payload?.lock;
  if (lock === null || lock === true || lock === false) return { lock };
  throw new Error('Source control response contained invalid capabilities');
};
