export const changeRequestBaseEntry = (requestText, invalidMutationContext) => ({
  kind: 'change-request-base',
  normalize: (input, context) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
    const base = requestText(input.base);
    if (!base || base.length > 256) throw invalidMutationContext('base is required and must fit 256 characters');
    return { base, digest: { base } };
  },
  perform: (service, normalized, resolved) => service.setChangeRequestBase({
    base: normalized.base,
    providerTarget: resolved.providerTarget,
    targetProject: resolved.target.project,
    expectedTarget: resolved.target,
  }),
  reconcile: (service, resolved, normalized) => service.reconcileChangeRequestBase(resolved.providerTarget, normalized.base),
});

export const changeRequestRebaseEntry = (invalidMutationContext) => ({
  kind: 'change-request-rebase',
  normalize: (_input, context) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
    return { digest: {} };
  },
  perform: (service, _normalized, resolved) => service.rebaseChangeRequest({ providerTarget: resolved.providerTarget }),
  reconcile: (service, resolved) => service.reconcileRebaseMutation(resolved.providerTarget, resolved.target.headSha),
});

export const issueAssigneesEntry = (nameList, limit, reviewerId, invalidMutationContext) => ({
  kind: 'issue-assignees',
  normalize: (input, context) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
    const names = nameList(input.assignees, limit);
    if (names.some((id) => !reviewerId.test(id))) throw invalidMutationContext('assignees are invalid');
    return { names, digest: { assignees: names } };
  },
  perform: (service, normalized, resolved) => service.setIssueAssignees({
    assignees: normalized.names,
    providerTarget: resolved.providerTarget,
    targetProject: resolved.target.project,
    expectedTarget: resolved.target,
  }),
  reconcile: (service, resolved, normalized) => service.reconcileIssueAssignees(resolved.providerTarget, normalized.names),
});
