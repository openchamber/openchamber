export const normalizeChangeRequestWrite = (operation, body, context, digestOf, mutationError, requiredText, isProviderString) => {
  if (operation === 'base') {
    const base = requiredText(body.base, 'base');
    if (base.length > 256 || base.startsWith('refs/heads/')) throw mutationError('base is invalid');
    return { input: { base }, digest: (target) => digestOf({ target, base }) };
  }
  if (operation === 'update-branch') {
    const { expectedHeadSha } = body;
    if (!isProviderString(expectedHeadSha) || !/^[0-9a-f]{40}$/.test(expectedHeadSha)) {
      throw mutationError('expectedHeadSha is invalid');
    }
    if (context.target.headSha !== undefined && context.target.headSha !== expectedHeadSha) {
      throw mutationError('expectedHeadSha does not match the target head');
    }
    return { input: { expectedHeadSha }, digest: (target) => digestOf({ target, expectedHeadSha }) };
  }
  return undefined;
};

export const baseReconciled = (pr, input) => (pr.base.ref === input.base ? { state: 'succeeded', result: {} } : undefined);

export const performChangeRequestWrite = async (operation, octokit, project, target, input, deps) => {
  const { requireMutationPullRequest, sameProject, pullTargetProject, targetMatches, invalidProviderPayload, rejected } = deps;
  if (operation === 'base') {
    const updated = requireMutationPullRequest((await octokit.rest.pulls.update({
      owner: project.owner, repo: project.name, pull_number: target.number, base: input.base,
    }))?.data, 'GitHub returned an invalid updated pull request', octokit);
    if (!sameProject(pullTargetProject(updated), project)
      || !targetMatches({ ...target, base: input.base }, updated)) {
      throw invalidProviderPayload('GitHub returned an updated pull request with an unexpected base');
    }
    return {};
  }
  await rejected(() => octokit.rest.pulls.updateBranch({
    owner: project.owner, repo: project.name, pull_number: target.number, expected_head_sha: input.expectedHeadSha,
  }));
  return {};
};

export const reconcileUpdateBranch = async (octokit, target, input, deps) => {
  const { requireMutationPullRequest, unknownOutcome } = deps;
  const current = await octokit.rest.pulls.get({ owner: target.project.owner, repo: target.project.name, pull_number: target.number });
  const pr = requireMutationPullRequest(current?.data, 'GitHub returned an invalid pull request', octokit);
  return pr.head.sha === input.expectedHeadSha ? unknownOutcome() : { state: 'succeeded', result: {} };
};
