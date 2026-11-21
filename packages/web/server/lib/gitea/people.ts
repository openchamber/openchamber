import type { JsonValue } from '../shared/json-values.js';
import type { GiteaIdentity, GiteaUser } from './mappers.js';

type Repo = { owner: string; name: string };
type MapUser = (value: JsonValue | undefined, identity: GiteaIdentity) => GiteaUser | null;

interface PeopleReaderDeps {
  network(directory: string, selector: Repo | null | undefined, remote: string | null | undefined): Promise<{ target: { project: Repo } }>;
  repoUsers(repo: Repo, kind?: 'collaborators' | 'assignees'): Promise<JsonValue[]>;
  mapUser: MapUser;
  identity: GiteaIdentity;
}

export const createPeopleReader = ({ network, repoUsers, mapUser, identity }: PeopleReaderDeps) => ({
  async listReviewerCandidates(directory: string, selector: Repo | null | undefined, remote: string | null | undefined, { role }: { role?: 'assignee' | 'reviewer' } = {}) {
    const { target } = await network(directory, selector, remote);
    return (await repoUsers(target.project, role === 'assignee' ? 'assignees' : 'collaborators')).flatMap((user) => {
      const mapped = mapUser(user, identity);
      if (!mapped) return [];
      return [mapped.avatarUrl ? { id: mapped.id, login: mapped.username, avatarUrl: mapped.avatarUrl } : { id: mapped.id, login: mapped.username }];
    });
  },
});
