import type {
  RebaseChangeRequestInput,
  SetAssigneesInput,
  SetChangeRequestBaseInput,
  UpdateChangeRequestBranchInput,
} from '../source-control/mutation-writes';
import type { SourceControlEmptyMutationResult, SourceControlMutationReceipt } from '../source-control/types';

export interface SourceControlWrites {
  changeRequestSetBase(payload: SetChangeRequestBaseInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestUpdateBranch(payload: UpdateChangeRequestBranchInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestRebase(payload: RebaseChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueSetAssignees(payload: SetAssigneesInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
}
