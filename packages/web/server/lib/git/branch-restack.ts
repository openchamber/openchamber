import type { SimpleGit } from 'simple-git';

export const BRANCH_CREATION_SOURCE_RE = /^branch: Created from (.+)$/;

const REBASE_ONTO_RE = /rebase(?: -i)? \(finish\): \S+ onto ([0-9a-f]{7,64})$/;

export async function isOwnRemoteCopy(git: SimpleGit, source: string, branchName: string) {
  const fullName = await git
    .raw(['rev-parse', '--symbolic-full-name', source])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  if (!fullName.startsWith('refs/remotes/')) return false;
  const upstream = await git
    .raw(['rev-parse', '--symbolic-full-name', `refs/heads/${branchName}@{upstream}`])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  if (upstream && fullName === upstream) return true;
  return fullName.slice('refs/remotes/'.length).split('/').slice(1).join('/') === branchName;
}

const readCommit = (git: SimpleGit, ref: string) => git
  .raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  .then((value) => String(value || '').trim())
  .catch(() => '');

async function commitsPointedAtSinceCreation(git: SimpleGit, refs: readonly string[]) {
  const pointed = new Map<string, Set<string>>();
  if (refs.length === 0) return pointed;
  const entries = String(await git.raw(['log', '--walk-reflogs', '--format=%gD%x00%H%x00%gs', ...refs]).catch(() => ''))
    .split('\n').filter(Boolean).map((entry) => entry.split('\0'));
  for (const [selector = '', commit = '', subject = ''] of entries) {
    const ref = selector.replace(/@\{\d+\}$/, '');
    const commits = pointed.get(ref) ?? new Set<string>();
    if (!BRANCH_CREATION_SOURCE_RE.test(subject)) commits.add(commit);
    pointed.set(ref, commits);
  }
  return pointed;
}

async function refsThatWereAt(git: SimpleGit, branchName: string, commit: string) {
  const tips = new Map<string, string>();
  const listed = String(await git.raw(['for-each-ref', '--format=%(refname)%00%(objectname)', '--contains', commit, 'refs/heads/', 'refs/remotes/']).catch(() => ''));
  for (const [ref = '', tip = ''] of listed.split('\n').filter(Boolean).map((line) => line.split('\0'))) {
    if (ref !== `refs/heads/${branchName}` && !ref.endsWith('/HEAD')) tips.set(ref, tip);
  }
  const pointed = await commitsPointedAtSinceCreation(git, [...tips.keys()]);
  return [...tips].filter(([ref, tip]) => pointed.get(ref)?.has(commit) ?? tip === commit).map(([ref]) => ref);
}

const parentName = (ref: string, localNames: ReadonlySet<string>) => {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  const remoteName = ref.slice('refs/remotes/'.length);
  const branch = remoteName.split('/').slice(1).join('/');
  return localNames.has(branch) ? branch : remoteName;
};

export async function findRestackedParent(git: SimpleGit, branchName: string, parentRefs: readonly string[]) {
  const subjects = String(await git.raw(['reflog', 'show', '--format=%gs', `refs/heads/${branchName}`]).catch(() => ''))
    .split('\n').map((line) => line.trim());
  for (const [, onto] of subjects.map((subject) => subject.match(REBASE_ONTO_RE)).filter((match) => match !== null)) {
    const commit = await readCommit(git, onto ?? '');
    const stillUnderBranch = commit
      && await git.raw(['merge-base', '--is-ancestor', commit, `refs/heads/${branchName}`]).then(() => true, () => false);
    if (!stillUnderBranch) continue;
    const parentHistory = [...(await commitsPointedAtSinceCreation(git, parentRefs)).values()];
    const parentTips = await Promise.all(parentRefs.map((ref) => readCommit(git, ref)));
    if (parentTips.includes(commit) || parentHistory.some((commits) => commits.has(commit))) return undefined;
    const refs = await refsThatWereAt(git, branchName, commit);
    const parents = [];
    for (const ref of refs) {
      if (!ref.startsWith('refs/remotes/') || !(await isOwnRemoteCopy(git, ref, branchName))) parents.push(ref);
    }
    const ontoOwnRemoteCopy = parents.length === 0 && refs.length > 0;
    if (ontoOwnRemoteCopy) continue;
    const localNames = new Set(parents.filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length)));
    const names = new Set(parents.map((ref) => parentName(ref, localNames)));
    const [only] = names;
    return names.size === 1 && only ? only : null;
  }
  return undefined;
}
