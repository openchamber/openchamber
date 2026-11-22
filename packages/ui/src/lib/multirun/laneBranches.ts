/**
 * Git keeps branches as paths, so `run/model` cannot exist next to a branch
 * named `run` or `run/model/1`: each blocks the other.
 */
const branchesConflict = (name: string, branch: string): boolean => (
  name === branch || branch.startsWith(`${name}/`) || name.startsWith(`${branch}/`)
);

/**
 * The branch for one lane of an isolated run: its seed, or the seed with a
 * `-2`, `-3`… suffix on the segment that collides, so that it conflicts with
 * no branch in `taken`. Every lane needs a branch of its own: the server
 * refuses a branch that already exists, so a reused name would fail the lane
 * (an earlier run with the same title, or two models whose slugs match). A
 * collision with a branch above the name (`run` for `run/model`) is suffixed
 * on that segment, since a new last segment would still sit under it.
 */
export const uniqueLaneBranchName = (seed: string, taken: ReadonlySet<string>): string => {
  const base = seed.split('/');
  const segments = [...base];
  for (let suffix = 2; ; suffix += 1) {
    const name = segments.join('/');
    let blocker: string | undefined;
    for (const branch of taken) {
      if (branchesConflict(name, branch)) {
        blocker = branch;
        break;
      }
    }
    if (blocker === undefined) return name;
    const depth = name.startsWith(`${blocker}/`) ? blocker.split('/').length - 1 : segments.length - 1;
    segments[depth] = `${base[depth]}-${suffix}`;
  }
};
