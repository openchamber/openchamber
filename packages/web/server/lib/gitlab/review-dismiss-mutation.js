export const reviewDismissEntry = (invalidMutationContext) => ({
  kind: 'change-request-review-dismiss',
  normalize: (input, context) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
    if (input.reviewId !== undefined || input.message !== undefined) {
      throw invalidMutationContext('GitLab reviews are withdrawn without a review id or message');
    }
    if (input.dismissed === false) throw invalidMutationContext('GitLab reviews cannot be undismissed');
    return { dismissed: true, digest: { dismissed: true } };
  },
  perform: (service, _normalized, resolved) => service.dismissReview({ providerTarget: resolved.providerTarget }),
  reconcile: (service, resolved) => service.reconcileReviewDismiss(resolved.providerTarget),
});
