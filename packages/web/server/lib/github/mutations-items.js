const CLOSE_REASON_OF = Object.freeze({ completed: 'completed', not_planned: 'not_planned', duplicate: 'not_planned' });

export const normalizeStateOperation = (operation, body, digestOf, mutationError) => {
  if (body.state !== 'open' && body.state !== 'closed') throw mutationError('state is invalid');
  const { state } = body;
  if (body.reason !== undefined && (state === 'open' || operation !== 'issue-state')) throw mutationError('reason is invalid');
  if (body.reason === undefined) return { input: { state }, digest: (target) => digestOf({ target, state }) };
  if (body.reason !== 'completed' && body.reason !== 'not_planned') throw mutationError('reason is invalid');
  const { reason } = body;
  return { input: { state, reason }, digest: (target) => digestOf({ target, state, reason }) };
};

export const normalizeAssignees = (body, limits, digestOf, nameList) => {
  const assignees = nameList(body.assignees, 'assignees', limits.reviewersMax);
  return { input: { assignees }, digest: (target) => digestOf({ target, assignees }) };
};

export const performAssignees = async (octokit, project, target, input, deps) => {
  const { rejected, requireProviderArray, isProviderString, sameNames, invalidProviderPayload } = deps;
  const updated = (await rejected(() => octokit.rest.issues.update({
    owner: project.owner, repo: project.name, issue_number: target.number, assignees: input.assignees,
  })))?.data;
  const answered = requireProviderArray(updated?.assignees, 'GitHub returned invalid assignees').map((person) => person?.login);
  if (!answered.every(isProviderString) || !sameNames(answered, input.assignees)) {
    throw invalidProviderPayload('GitHub returned unexpected assignees');
  }
  return {};
};

export const reconcileAssignees = async (octokit, target, input, deps) => {
  const { requireProviderArray, isProviderString, sameNames, unknownOutcome } = deps;
  const current = await octokit.rest.issues.get({ owner: target.project.owner, repo: target.project.name, issue_number: target.number });
  const logins = requireProviderArray(current?.data?.assignees, 'GitHub returned invalid assignees').map((person) => person?.login);
  return logins.every(isProviderString) && sameNames(logins, input.assignees) ? { state: 'succeeded', result: {} } : unknownOutcome();
};

export const performIssueState = (setState, octokit, project, target, input) => setState(() => {
  const fields = { owner: project.owner, repo: project.name, issue_number: target.number, state: input.state };
  if (input.reason !== undefined) fields.state_reason = input.reason;
  return octokit.rest.issues.update(fields);
}, input.state);

export const reconcileIssueState = async (octokit, target, input, deps) => {
  const { unknownOutcome, definiteFailure } = deps;
  const current = await octokit.rest.issues.get({ owner: target.project.owner, repo: target.project.name, issue_number: target.number });
  const state = current?.data?.state;
  if (state !== 'open' && state !== 'closed') return unknownOutcome();
  if (state !== input.state) return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
  if (input.reason !== undefined && CLOSE_REASON_OF[current?.data?.state_reason] !== input.reason) return unknownOutcome();
  return { state: 'succeeded', result: { state } };
};
