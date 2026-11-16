const DEVELOPER_ACCESS_LEVEL = 30;

const gitlabWriteAccess = (raw, isPlainObject) => {
  const permissions = raw?.permissions;
  if (!isPlainObject(permissions)) return undefined;
  const levels = [permissions.project_access?.access_level, permissions.group_access?.access_level].filter(Number.isInteger);
  if (!levels.length) return undefined;
  return levels.some((level) => level >= DEVELOPER_ACCESS_LEVEL);
};

const gitlabWithWriteAccess = (value, raw, isPlainObject) => {
  const writeAccess = gitlabWriteAccess(raw, isPlainObject);
  return writeAccess === undefined ? value : { ...value, writeAccess };
};

const gitlabLockFlag = (raw, isPlainObject) => {
  if (!isPlainObject(raw) || !Object.hasOwn(raw, 'discussion_locked')) return undefined;
  if (raw.discussion_locked === null) return false;
  return raw.discussion_locked === true || raw.discussion_locked === false ? raw.discussion_locked : undefined;
};

const gitlabSubscriptionFlag = (raw) => (raw?.subscribed === true || raw?.subscribed === false ? raw.subscribed : undefined);

export const gitlabItemFlags = (value, projectRaw, itemRaw, isPlainObject) => {
  const flags = { ...value, ...gitlabWithWriteAccess({}, projectRaw, isPlainObject) };
  const locked = gitlabLockFlag(itemRaw, isPlainObject);
  if (locked !== undefined) flags.locked = locked;
  const subscribed = gitlabSubscriptionFlag(itemRaw);
  if (subscribed !== undefined) flags.subscribed = subscribed;
  return flags;
};

export const gitlabAssignees = (assignees, identity, mapUser) => assignees.flatMap((user) => {
  const mapped = mapUser(user, identity);
  if (!mapped) return [];
  const assignee = { id: mapped.id, login: mapped.username };
  if (mapped.avatarUrl) assignee.avatarUrl = mapped.avatarUrl;
  return [assignee];
});

export const gitlabItemWrites = ({
  client, isPlainObject, isString, showProject, requireIssue, requireMutationResponse, requireMutationMergeRequest, requestStatus, mutationTargetInvalid,
}) => ({
  async setConversationLock(payload) {
    const { projectId, number } = payload.providerTarget;
    const raw = payload.kind === 'issue-lock'
      ? await client.Issues.edit(projectId, number, { discussionLocked: payload.locked })
      : await client.MergeRequests.edit(projectId, number, { discussionLocked: payload.locked });
    const target = payload.kind === 'issue-lock'
      ? requireIssue(raw, payload.targetProject)
      : requireMutationResponse(raw, payload.targetProject, payload.providerTarget, payload.expectedTarget);
    if (target.number !== number) throw mutationTargetInvalid('GitLab answered another target for the lock write');
    if (raw?.discussion_locked !== payload.locked) throw mutationTargetInvalid('GitLab returned an unexpected lock state');
    return {};
  },

  async reconcileLockMutation(providerTarget, kind, locked) {
    const { projectId, number } = providerTarget;
    const raw = kind === 'issue-lock'
      ? await client.Issues.show(number, { projectId })
      : await client.MergeRequests.show(projectId, number);
    return raw?.discussion_locked === locked ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
  },

  async setConversationSubscription(payload) {
    const { projectId, number } = payload.providerTarget;
    const write = payload.subscribed ? 'subscribe' : 'unsubscribe';
    const readBack = async () => (payload.kind === 'issue-subscription'
      ? client.Issues.show(number, { projectId })
      : client.MergeRequests.show(projectId, number));
    let raw;
    try {
      raw = payload.kind === 'issue-subscription'
        ? await client.Issues[write](projectId, number)
        : await client.MergeRequests[write](projectId, number);
    } catch (error) {
      if (requestStatus(error) !== 304) throw error;
      if ((await readBack())?.subscribed !== payload.subscribed) {
        throw mutationTargetInvalid('GitLab returned an unexpected subscription state');
      }
      return {};
    }
    const target = payload.kind === 'issue-subscription'
      ? requireIssue(raw, payload.targetProject)
      : requireMutationResponse(raw, payload.targetProject, payload.providerTarget, payload.expectedTarget);
    if (target.number !== number) throw mutationTargetInvalid('GitLab answered another target for the subscription write');
    if (raw?.subscribed !== payload.subscribed) throw mutationTargetInvalid('GitLab returned an unexpected subscription state');
    return {};
  },

  async reconcileSubscriptionMutation(providerTarget, kind, subscribed) {
    const { projectId, number } = providerTarget;
    const raw = kind === 'issue-subscription'
      ? await client.Issues.show(number, { projectId })
      : await client.MergeRequests.show(projectId, number);
    return raw?.subscribed === subscribed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
  },

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
