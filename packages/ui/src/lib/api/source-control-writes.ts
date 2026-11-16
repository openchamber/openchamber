import type {
  RebaseChangeRequestInput,
  SetAssigneesInput,
  SetChangeRequestBaseInput,
  SetConversationLockInput,
  SetItemSubscriptionInput,
  UpdateChangeRequestBranchInput,
} from '../source-control/mutation-writes';
import type { SourceControlEmptyMutationResult, SourceControlMutationReceipt } from '../source-control/types';

export interface SourceControlWrites {
  changeRequestSetBase(payload: SetChangeRequestBaseInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestUpdateBranch(payload: UpdateChangeRequestBranchInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestRebase(payload: RebaseChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueSetAssignees(payload: SetAssigneesInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueSetLock(payload: SetConversationLockInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestSetLock(payload: SetConversationLockInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueSetSubscription(payload: SetItemSubscriptionInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestSetSubscription(payload: SetItemSubscriptionInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
}
