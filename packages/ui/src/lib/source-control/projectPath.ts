/**
 * A project's path as one string and as the `{ owner, name }` pair selectors
 * carry. Most providers name a project `owner/name` (`group/sub/name` where
 * namespaces nest); a path-style provider (`repository.pathStyle: 'path'`)
 * also has top-level projects, whose owner is the empty string. Keys and labels
 * use the joined path, so every other provider's keys read as they always did.
 */

/** `owner/name`, or the name alone for a top-level project. */
export const joinProjectPath = (owner: string, name: string): string => (owner ? `${owner}/${name}` : name);

/** A whole project path as owner and name, split on the last slash: `a/b/c` is `a/b` and `c`; `tools` has the empty owner. */
export const splitProjectPath = (path: string): { owner: string; repo: string } => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { owner: '', repo: path } : { owner: path.slice(0, slash), repo: path.slice(slash + 1) };
};
