import type { SourceControlExistingMutationTarget, SourceControlMutationContext } from './types';

declare module './types' {
  interface Issue {
    writeAccess?: boolean;
    locked?: boolean;
    subscribed?: boolean;
  }
  interface ChangeRequestContext {
    writeAccess?: boolean;
    locked?: boolean;
    subscribed?: boolean;
  }
}

export interface SetAssigneesInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  assignees: string[];
}

export interface SetConversationLockInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  locked: boolean;
}

export interface SetItemSubscriptionInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  subscribed: boolean;
}

export interface SetChangeRequestBaseInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  base: string;
}

export interface UpdateChangeRequestBranchInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  expectedHeadSha: string;
}

export type RebaseChangeRequestInput = SourceControlMutationContext<SourceControlExistingMutationTarget>;
