export const createPeopleReader = ({ network, repoUsers, mapUser, identity }) => ({
  async listReviewerCandidates(directory, selector, remote, { role } = {}) {
    const { target } = await network(directory, selector, remote);
    return (await repoUsers(target.project, role === 'assignee' ? 'assignees' : 'collaborators')).flatMap((user) => {
      const mapped = mapUser(user, identity);
      if (!mapped) return [];
      return [mapped.avatarUrl ? { id: mapped.id, login: mapped.username, avatarUrl: mapped.avatarUrl } : { id: mapped.id, login: mapped.username }];
    });
  },
});
