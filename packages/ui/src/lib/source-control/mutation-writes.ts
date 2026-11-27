import type { SetStateInput, SourceControlExistingMutationTarget, SourceControlMutationContext } from './types';

export interface SetAssigneesInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  assignees: string[];
}

export type IssueCloseReason = 'completed' | 'not_planned' | 'duplicate';

export interface SetIssueStateInput extends SetStateInput {
  reason?: IssueCloseReason;
}
