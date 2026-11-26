import type { RebaseChangeRequestInput, SetChangeRequestBaseInput, UpdateChangeRequestBranchInput } from '../source-control/branch-writes';
import type { SourceControlEmptyMutationResult, SourceControlMutationReceipt } from '../source-control/types';

export interface SourceControlBranchWrites {
  changeRequestSetBase(payload: SetChangeRequestBaseInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestUpdateBranch(payload: UpdateChangeRequestBranchInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestRebase(payload: RebaseChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
}
