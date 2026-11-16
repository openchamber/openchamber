export const conversationEntries = (invalidMutationContext) => {
  const entries = {};
  for (const [route, kind] of [['/pr/lock', 'change-request-lock'], ['/issues/lock', 'issue-lock']]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        if (!context.target.number || Object.prototype.toString.call(input.locked) !== '[object Boolean]') {
          throw invalidMutationContext('target number and locked are required');
        }
        return { locked: input.locked, digest: { locked: input.locked } };
      },
      perform: (service, normalized, resolved) => service.setConversationLock({
        kind,
        locked: normalized.locked,
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }),
      reconcile: (service, resolved, normalized) => service.reconcileLockMutation(resolved.providerTarget, kind, normalized.locked),
    };
  }
  for (const [route, kind] of [['/pr/subscription', 'change-request-subscription'], ['/issues/subscription', 'issue-subscription']]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        if (!context.target.number || Object.prototype.toString.call(input.subscribed) !== '[object Boolean]') {
          throw invalidMutationContext('target number and subscribed are required');
        }
        return { subscribed: input.subscribed, digest: { subscribed: input.subscribed } };
      },
      perform: (service, normalized, resolved) => service.setConversationSubscription({
        kind,
        subscribed: normalized.subscribed,
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }),
      reconcile: (service, resolved, normalized) => service.reconcileSubscriptionMutation(resolved.providerTarget, kind, normalized.subscribed),
    };
  }
  return entries;
};
