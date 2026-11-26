import { mutationBody, normalizeIdentity, parseMutationReceipt, post, type MutationReceiptDTO } from './source-control';
import { parseEmptyMutationResult } from './source-control-mutation-result';
import type { RebaseChangeRequestInput, SetChangeRequestBaseInput, UpdateChangeRequestBranchInput } from '@openchamber/ui/lib/source-control/branch-writes';
import type {
  SourceControlEmptyMutationResult,
  SourceControlExistingMutationTarget,
  SourceControlMutationContext,
  SourceControlMutationReceipt,
} from '@openchamber/ui/lib/source-control/types';

type Write = (
  fetch: Parameters<typeof post>[0],
  path: string,
  payload: SourceControlMutationContext<SourceControlExistingMutationTarget>,
  fields: Record<string, string>,
) => Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;

const write: Write = async (fetch, path, payload, fields) => {
  const identity = normalizeIdentity(payload);
  const result = await post<MutationReceiptDTO>(fetch, identity, path, { ...mutationBody(payload, identity, 'existing'), ...fields });
  return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
};

export const createBranchWrites = (fetch: Parameters<typeof post>[0]) => ({
  changeRequestSetBase: (payload: SetChangeRequestBaseInput) => write(fetch, '/pr/base', payload, { base: payload.base }),
  changeRequestUpdateBranch: (payload: UpdateChangeRequestBranchInput) => write(fetch, '/pr/update-branch', payload, { expectedHeadSha: payload.expectedHeadSha }),
  changeRequestRebase: (payload: RebaseChangeRequestInput) => write(fetch, '/pr/rebase', payload, { expectedHeadSha: payload.expectedHeadSha }),
});
