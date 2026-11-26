import type { SourceControlJsonObject } from '@openchamber/sdk';
import type { MutationContextInput } from '../source-control/binding-service-contracts.js';
import type { createGitLabResourceService } from './resources.js';

type Service = ReturnType<typeof createGitLabResourceService>;
type NumberedTarget = { projectId: string; number: number };
type NormalizedDismiss = { dismissed: boolean; digest: { dismissed: boolean } };

export const reviewDismissEntry = (invalidMutationContext: (message: string) => Error) => ({
  kind: 'change-request-review-dismiss',
  normalize: (input: SourceControlJsonObject, context: MutationContextInput): NormalizedDismiss => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
    if (input.reviewId !== undefined || input.message !== undefined) {
      throw invalidMutationContext('GitLab reviews are withdrawn without a review id or message');
    }
    if (input.dismissed === false) throw invalidMutationContext('GitLab reviews cannot be undismissed');
    return { dismissed: true, digest: { dismissed: true } };
  },
  perform: (service: Service, _normalized: NormalizedDismiss, resolved: { providerTarget: NumberedTarget }) =>
    service.dismissReview({ providerTarget: resolved.providerTarget }),
  reconcile: (service: Service, resolved: { providerTarget: NumberedTarget }) => service.reconcileReviewDismiss(resolved.providerTarget),
});

export const reviewDismissalEntries = <Entry extends {
  kind: string;
  normalize: (input: SourceControlJsonObject, context: MutationContextInput) => object;
}>(discard: Entry, invalidMutationContext: (message: string) => Error) => ({
  '/pr/review/discard': {
    ...discard,
    perform: (service: Service, _normalized: ReturnType<Entry['normalize']>, resolved: { providerTarget: NumberedTarget }) =>
      service.discardReview({ providerTarget: resolved.providerTarget }),
    reconcile: () => ({ state: 'outcome-unknown' }),
  },
  '/pr/review/dismiss': reviewDismissEntry(invalidMutationContext),
});
