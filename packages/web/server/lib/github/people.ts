import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';

import type { DiscoveryRepository } from './contracts.js';
import { isProviderString, requireProviderArray } from './mappers.js';

type Person = RestEndpointMethodTypes['issues']['listAssignees']['response']['data'][number];

const PAGE_SIZE = 100;

export const readAssignablePeople = async (octokit: Octokit, repo: DiscoveryRepository, everyPage: boolean) => {
  const people: Person[] = [];
  for (let page = 1; ; page += 1) {
    const response = await octokit.rest.issues.listAssignees({ owner: repo.owner, repo: repo.repo, per_page: PAGE_SIZE, page });
    const listed = requireProviderArray<Person>(response?.data, 'GitHub returned an invalid user list');
    people.push(...listed);
    if (!everyPage || listed.length < PAGE_SIZE) break;
  }
  return people.flatMap((user) => {
    if (!isProviderString(user?.login) || !user.login) return [];
    return [isProviderString(user.avatar_url) && user.avatar_url
      ? { id: user.login, login: user.login, avatarUrl: user.avatar_url }
      : { id: user.login, login: user.login }];
  });
};
