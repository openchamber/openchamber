import type { SourceControlExistingMutationTarget, SourceControlMutationContext } from './types';

export interface SetConversationLockInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  locked: boolean;
}

export interface SetItemSubscriptionInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  subscribed: boolean;
}
