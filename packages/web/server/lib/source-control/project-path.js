/**
 * A provider's project path and its `{ owner, name }` selector. GitHub has
 * `owner/name`, GitLab and Gitea a namespace path for the owner; a provider
 * whose descriptor says `repositoryPath: 'path'` (Gerrit) also hosts
 * projects with no owner segment (`demo`), whose owner is the empty string.
 * The split is on the last slash, so `team/app/sub` is owner `team/app`,
 * name `sub`, and joining gives the path back.
 */

/** `owner ? owner + '/' + name : name`. */
export const joinProjectPath = (owner, name) => (owner ? `${owner}/${name}` : name);

/** Owner and name of a project path, split on its last slash. */
export const splitProjectPath = (path) => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { owner: '', name: path } : { owner: path.slice(0, slash), name: path.slice(slash + 1) };
};

/** Whether a provider's projects may have no owner segment. */
export const allowsTopLevelProjects = (descriptor) => descriptor?.repositoryPath === 'path';
