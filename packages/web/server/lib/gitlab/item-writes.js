const DEVELOPER_ACCESS_LEVEL = 30;

const gitlabWriteAccess = (raw, isPlainObject) => {
  const permissions = raw?.permissions;
  if (!isPlainObject(permissions)) return undefined;
  return [permissions.project_access?.access_level, permissions.group_access?.access_level]
    .some((level) => Number.isInteger(level) && level >= DEVELOPER_ACCESS_LEVEL);
};

export const gitlabWithWriteAccess = (value, raw, isPlainObject) => {
  const writeAccess = gitlabWriteAccess(raw, isPlainObject);
  return writeAccess === undefined ? value : { ...value, writeAccess };
};

export const gitlabAssignees = (assignees, identity, mapUser) => assignees.flatMap((user) => {
  const mapped = mapUser(user, identity);
  if (!mapped) return [];
  const assignee = { id: mapped.id, login: mapped.username };
  if (mapped.avatarUrl) assignee.avatarUrl = mapped.avatarUrl;
  return [assignee];
});

export const gitlabItemWrites = ({
  client, isPlainObject, isString, showProject, requireIssue, requireMutationResponse, requireMutationMergeRequest,
}) => ({
  async setIssueAssignees(payload) {
    const { projectId, number } = payload.providerTarget;
    const ids = payload.assignees.map(Number);
    const issue = requireIssue(await client.Issues.edit(projectId, number, { assigneeIds: ids }), payload.targetProject);
    if (issue.number !== number) throw new Error('GitLab returned an unexpected issue');
    const answered = (issue.assignees ?? []).map((user) => Number(user.id));
    if (answered.length !== ids.length || !answered.every((id) => ids.includes(id))) {
      throw new Error('GitLab returned an unexpected assignee set');
    }
    return {};
  },

  async reconcileIssueAssignees(providerTarget, assignees) {
    const { projectId, number } = providerTarget;
    const project = (await showProject(projectId)).project;
    const issue = requireIssue(await client.Issues.show(number, { projectId }), project);
    const current = (issue.assignees ?? []).map((user) => user.id);
    const wanted = assignees.map(String);
    if (current.length !== wanted.length || !current.every((id) => wanted.includes(id))) return { state: 'outcome-unknown' };
    return { state: 'succeeded', result: {} };
  },

  async setChangeRequestBase(payload) {
    const { projectId, number } = payload.providerTarget;
    const raw = await client.MergeRequests.edit(projectId, number, { targetBranch: payload.base });
    const { base: _base, ...expected } = payload.expectedTarget;
    const request = requireMutationResponse(raw, payload.targetProject, payload.providerTarget, expected);
    if (request.base !== payload.base) throw new Error('GitLab returned an unexpected merge request base');
    return {};
  },

  async reconcileChangeRequestBase(providerTarget, base) {
    const { projectId, number } = providerTarget;
    const project = (await showProject(projectId)).project;
    const request = requireMutationMergeRequest(await client.MergeRequests.show(projectId, number), project);
    return request.base === base ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
  },

  async rebaseChangeRequest({ providerTarget }) {
    const raw = await client.MergeRequests.rebase(providerTarget.projectId, providerTarget.number);
    if (!isPlainObject(raw)) throw new Error('GitLab returned an invalid rebase answer');
    return {};
  },

  async reconcileRebaseMutation(providerTarget, expectedHeadSha) {
    const raw = await client.MergeRequests.show(providerTarget.projectId, providerTarget.number);
    const project = (await showProject(providerTarget.projectId)).project;
    const request = requireMutationMergeRequest(raw, project);
    if (raw?.rebase_in_progress === true) return { state: 'outcome-unknown' };
    return isString(expectedHeadSha) && request.headSha !== expectedHeadSha
      ? { state: 'succeeded', result: {} }
      : { state: 'outcome-unknown' };
  },
});
