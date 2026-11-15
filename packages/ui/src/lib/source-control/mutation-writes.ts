import type { SourceControlExistingMutationTarget, SourceControlMutationContext } from './types';

declare module './types' {
  interface Issue {
    writeAccess?: boolean;
  }
  interface ChangeRequestContext {
    writeAccess?: boolean;
  }
}

export interface SetAssigneesInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  assignees: string[];
}

export interface SetChangeRequestBaseInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  base: string;
}

export interface UpdateChangeRequestBranchInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  expectedHeadSha: string;
}

export type RebaseChangeRequestInput = SourceControlMutationContext<SourceControlExistingMutationTarget>;
