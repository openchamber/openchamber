import type { SourceControlExistingMutationTarget, SourceControlMutationContext } from './types';

export interface SetChangeRequestBaseInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  base: string;
}

export interface UpdateChangeRequestBranchInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  expectedHeadSha: string;
}

export interface RebaseChangeRequestInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  expectedHeadSha: string;
}
