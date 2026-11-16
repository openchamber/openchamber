const giteaWriteAccess = (raw) => {
  const push = raw?.permissions?.push;
  return push === true || push === false ? push : undefined;
};

export const withGiteaWriteAccess = (value, raw, itemRaw) => {
  const writeAccess = giteaWriteAccess(raw);
  const flags = { ...value };
  if (writeAccess !== undefined) flags.writeAccess = writeAccess;
  const locked = itemRaw?.is_locked ?? itemRaw?.locked;
  if (locked === true || locked === false) flags.locked = locked;
  return flags;
};

export const readGiteaSubscription = async (client, repoPath, isPlainObject, repo, number) => {
  try {
    const answer = await client.get(`${repoPath(repo)}/issues/${number}/subscriptions/check`);
    return isPlainObject(answer) && (answer.subscribed === true || answer.subscribed === false) ? answer.subscribed : null;
  } catch {
    return null;
  }
};

export const giteaItemWrites = ({
  client, targetRepo, repoPath, providerLabel, isString, requireIssue, requirePull, projectOfTarget, branchRepoId,
  malformed, requireExpected, readTargetPull, repoUsers, readCurrentLogin, isPlainObject,
}) => {
  const assigneeLogins = async (providerTarget, assignees) => {
    const repo = targetRepo(providerTarget);
    const raw = await client.get(`${repoPath(repo)}/issues/${providerTarget.number}`);
    const users = [...(Array.isArray(raw?.assignees) ? raw.assignees : []), ...(await repoUsers(repo)), ...(await repoUsers(repo, 'assignees'))]
      .filter((user) => Number.isInteger(user?.id) && isString(user?.login));
    const byId = new Map(users.map((user) => [String(user.id), user.login]));
    return assignees.map((entry) => {
      const login = byId.get(entry) ?? (/^\d+$/.test(entry) ? null : entry);
      if (!login) throw Object.assign(new Error(`${providerLabel} user ${entry} cannot be assigned in this repository`), { status: 422 });
      return login;
    });
  };

  return {
    async setSubscription({ providerTarget, subscribed }) {
      const login = await readCurrentLogin();
      const path = `${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}/subscriptions/${encodeURIComponent(login)}`;
      if (subscribed) await client.put(path);
      else await client.delete(path);
      return {};
    },

    async reconcileSubscription(providerTarget, subscribed) {
      const current = await readGiteaSubscription(client, repoPath, isPlainObject, targetRepo(providerTarget), providerTarget.number);
      return current !== null && current === subscribed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async setConversationLock({ providerTarget, locked }) {
      const path = `${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}/lock`;
      if (locked) await client.put(path, { lock: true });
      else await client.delete(path);
      return {};
    },

    async reconcileLockMutation(providerTarget, locked) {
      const issue = await client.get(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}`);
      const current = issue?.is_locked ?? issue?.locked;
      return current === locked ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },
    async setChangeRequestBase({ providerTarget, base, expectedTarget }) {
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}`, { base });
      if (branchRepoId(raw?.base) !== providerTarget.repoId) throw malformed(`${providerLabel} returned a pull request outside the resolved mutation target`);
      const request = requirePull(raw, projectOfTarget(providerTarget));
      const { base: _base, ...expected } = expectedTarget;
      requireExpected(expected, request);
      if (request.base !== base) throw malformed(`${providerLabel} returned an unexpected pull request base`);
      return {};
    },

    async reconcileChangeRequestBase(providerTarget, base) {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      return current.base === base ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async updateChangeRequestBranch({ providerTarget, expectedHeadSha, expectedTarget }) {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      requireExpected({ number: expectedTarget.number, headSha: expectedHeadSha }, current);
      await client.post(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}/update?style=merge`);
      return {};
    },

    async reconcileChangeRequestBranch(providerTarget, expectedHeadSha) {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      return current.headSha !== expectedHeadSha ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async setIssueAssignees({ providerTarget, assignees }) {
      const logins = await assigneeLogins(providerTarget, assignees);
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}`, { assignees: logins });
      const issue = requireIssue(raw, projectOfTarget(providerTarget));
      if (issue.number !== providerTarget.number) throw malformed(`${providerLabel} answered an issue outside the resolved mutation target`);
      const answered = (issue.assignees ?? []).map((user) => user.username);
      if (answered.length !== logins.length || !answered.every((login) => logins.includes(login))) {
        throw malformed(`${providerLabel} answered an unexpected assignee set`);
      }
      return {};
    },

    async reconcileIssueAssignees(providerTarget, assignees) {
      const logins = await assigneeLogins(providerTarget, assignees);
      const issue = requireIssue(
        await client.get(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}`),
        projectOfTarget(providerTarget),
      );
      const current = (issue.assignees ?? []).map((user) => user.username);
      if (current.length !== logins.length || !current.every((login) => logins.includes(login))) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: {} };
    },
  };
};
