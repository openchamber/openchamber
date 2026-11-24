import type { SetAssigneesInput, SetIssueStateInput } from '@openchamber/ui/lib/api/types';
import type { SourceControlEmptyMutationResult, SourceControlMutationReceipt, SourceControlStateMutationResult } from '@openchamber/ui/lib/source-control/types';
import {
  mutationBody, normalizeIdentity, parseEmptyMutationResult, parseMutationReceipt, parseStateMutationResult, post,
  type MutationReceiptDTO, type SourceControlFetch,
} from './source-control';

type WriteFlags = { writeAccess?: boolean };

export const writeFlags = (payload: WriteFlags): WriteFlags => {
  const flags: WriteFlags = {};
  const value = payload.writeAccess;
  if (value === undefined) return flags;
  if (Object.prototype.toString.call(value) !== '[object Boolean]') {
    throw new Error('Source control response contained an invalid write access');
  }
  flags.writeAccess = value;
  return flags;
};

export const createItemWrites = (fetch: SourceControlFetch) => ({
  issueSetState: async (payload: SetIssueStateInput): Promise<SourceControlMutationReceipt<SourceControlStateMutationResult>> => {
    const identity = normalizeIdentity(payload);
    const body = { ...mutationBody(payload, identity, 'existing'), state: payload.state };
    const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/state', payload.reason === undefined ? body : { ...body, reason: payload.reason });
    return parseMutationReceipt(result, payload, identity, parseStateMutationResult);
  },
  issueSetAssignees: async (payload: SetAssigneesInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>> => {
    const identity = normalizeIdentity(payload);
    const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/assignees', {
      ...mutationBody(payload, identity, 'existing'), assignees: payload.assignees,
    });
    return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
  },
});
