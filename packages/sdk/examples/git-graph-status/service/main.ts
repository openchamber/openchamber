// Runs under the app's Node runtime, on 127.0.0.1, only reachable through the host proxy.
// Reads the history of the project the section shows. Read-only: every git call
// runs with optional locks off, so it never blocks the user's own git commands.
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const LIMIT_DEFAULT = 40;
const LIMIT_MAX = 100;
const REFS_MAX = 200;
const FIELD = '\x1f';
const RECORD = '\x1e';
const SHA = /^[0-9a-f]{7,64}$/i;
// hash, parents, author, relative date, ISO date, decorations (full ref names), subject
const LOG_FORMAT = ['%H', '%P', '%an', '%ar', '%aI', '%D', '%s'].join('%x1f') + '%x1e';
const SHOW_FORMAT = ['%H', '%P', '%an', '%ae', '%ar', '%aI', '%s', '%b'].join('%x1f');

type RefKind = 'local' | 'remote' | 'tag';
type Ref = { name: string; kind: RefKind; head: boolean };
type Commit = { hash: string; parents: string[]; author: string; when: string; date: string; refs: Ref[]; subject: string };
type Refs = { branch: string | null; upstream: string | null; github: string | null; refs: { name: string; kind: RefKind }[] };
type CommitDetail = {
  hash: string; parents: string[]; author: string; email: string; when: string; date: string;
  subject: string; body: string; files: number; insertions: number; deletions: number;
};
type Failure = 'unauthorized' | 'not-found' | 'bad-request' | 'no-git' | 'not-a-repo' | 'unknown-commit' | 'git-failed';
type Answer =
  | { commits: Commit[]; uncommitted: number }
  | Refs
  | CommitDetail
  | { error: Failure }
  | { ok: true };
type GitResult = { ok: true; stdout: string } | { ok: false; failure: Failure };
type RefsResult = { ok: true; value: Refs } | { ok: false; failure: Failure };
type RevisionsResult = { ok: true; revisions: string[] } | { ok: false; failure: Failure };

const json = (res: http.ServerResponse, status: number, body: Answer): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const git = (directory: string, args: string[]): Promise<GitResult> => new Promise((resolve) => {
  execFile('git', ['-C', directory, ...args], {
    timeout: 8_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  }, (error, stdout, stderr) => {
    if (!error) { resolve({ ok: true, stdout }); return; }
    if ('code' in error && error.code === 'ENOENT') { resolve({ ok: false, failure: 'no-git' }); return; }
    if (/not a git repository/i.test(stderr)) { resolve({ ok: false, failure: 'not-a-repo' }); return; }
    if (/bad object|unknown revision|bad revision|ambiguous argument/i.test(stderr)) { resolve({ ok: false, failure: 'unknown-commit' }); return; }
    resolve({ ok: false, failure: 'git-failed' });
  });
});

const failureStatus = (failure: Failure): number => (failure === 'not-a-repo' || failure === 'unknown-commit' ? 422 : 500);

const refKind = (full: string): { name: string; kind: RefKind } | null => {
  if (full.startsWith('refs/heads/')) return { name: full.slice('refs/heads/'.length), kind: 'local' };
  if (full.startsWith('refs/remotes/')) {
    const name = full.slice('refs/remotes/'.length);
    return name.endsWith('/HEAD') ? null : { name, kind: 'remote' };
  }
  if (full.startsWith('refs/tags/')) return { name: full.slice('refs/tags/'.length), kind: 'tag' };
  return null;
};

// `%D` with --decorate=full: "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1".
const parseDecorations = (value: string): Ref[] => {
  const refs: Ref[] = [];
  for (const raw of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    if (raw === 'HEAD') continue;
    const head = raw.startsWith('HEAD -> ');
    const full = head ? raw.slice('HEAD -> '.length) : raw.startsWith('tag: ') ? raw.slice('tag: '.length) : raw;
    const ref = refKind(full);
    if (!ref) continue;
    // The checked-out branch leads its row.
    if (head) refs.unshift({ ...ref, head });
    else refs.push({ ...ref, head });
  }
  return refs;
};

const parseLog = (stdout: string): Commit[] => stdout.split(RECORD).map((record) => record.replace(/^\n/, '')).filter(Boolean).map((record) => {
  const [hash = '', parents = '', author = '', when = '', date = '', decorations = '', subject = ''] = record.split(FIELD);
  return { hash, parents: parents.split(' ').filter(Boolean), author, when, date, refs: parseDecorations(decorations), subject };
});

const githubWebUrl = (remote: string): string | null => {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
};

const readRefs = async (directory: string): Promise<RefsResult> => {
  const listed = await git(directory, ['for-each-ref', `--count=${REFS_MAX}`, '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
  if (!listed.ok) return listed;
  const branch = await git(directory, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const upstream = await git(directory, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const remote = await git(directory, ['remote', 'get-url', 'origin']);
  return { ok: true, value: {
    branch: branch.ok ? branch.stdout.trim() || null : null,
    upstream: upstream.ok ? upstream.stdout.trim() || null : null,
    github: remote.ok ? githubWebUrl(remote.stdout) : null,
    refs: listed.stdout.split('\n').map((line) => refKind(line.trim())).filter((ref): ref is { name: string; kind: RefKind } => ref !== null),
  } };
};

const fullRefName = (ref: { name: string; kind: RefKind }): string => (
  ref.kind === 'local' ? `refs/heads/${ref.name}` : ref.kind === 'remote' ? `refs/remotes/${ref.name}` : `refs/tags/${ref.name}`
);

/** Which history to walk. Manual names are matched against refs that really exist, never passed through as given. */
const revisions = async (directory: string, mode: string, picked: string[]): Promise<RevisionsResult> => {
  if (mode === 'all') return { ok: true, revisions: ['--branches', '--remotes', '--tags', 'HEAD'] };
  const listed = await readRefs(directory);
  if (!listed.ok) return listed;
  const refs = listed.value;
  if (mode === 'manual') {
    const wanted = new Set(picked);
    const chosen = refs.refs.filter((ref) => wanted.has(`${ref.kind}:${ref.name}`)).map(fullRefName);
    return { ok: true, revisions: chosen.length > 0 ? chosen : ['HEAD'] };
  }
  const upstream = refs.upstream ? refs.refs.find((ref) => ref.kind === 'remote' && ref.name === refs.upstream) : undefined;
  return { ok: true, revisions: upstream ? ['HEAD', fullRefName(upstream)] : ['HEAD'] };
};

const readLog = async (directory: string, mode: string, picked: string[], limit: number): Promise<{ status: number; body: Answer }> => {
  const revs = await revisions(directory, mode, picked);
  if (!revs.ok) return { status: failureStatus(revs.failure), body: { error: revs.failure } };
  const log = await git(directory, ['log', '--topo-order', '--decorate=full', `--max-count=${limit}`, `--format=${LOG_FORMAT}`, ...revs.revisions, '--']);
  if (!log.ok) {
    // A repository without commits has no HEAD yet; that is a real, empty history.
    return log.failure === 'unknown-commit' ? { status: 200, body: { commits: [], uncommitted: 0 } } : { status: failureStatus(log.failure), body: { error: log.failure } };
  }
  const status = await git(directory, ['status', '--porcelain=v1', '--untracked-files=no']);
  const uncommitted = status.ok ? status.stdout.split('\n').filter(Boolean).length : 0;
  return { status: 200, body: { commits: parseLog(log.stdout), uncommitted } };
};

type Stat = Pick<CommitDetail, 'files' | 'insertions' | 'deletions'>;

const shortstat = (value: string): Stat => ({
  files: Number(/(\d+) files? changed/.exec(value)?.[1] ?? 0),
  insertions: Number(/(\d+) insertions?\(\+\)/.exec(value)?.[1] ?? 0),
  deletions: Number(/(\d+) deletions?\(-\)/.exec(value)?.[1] ?? 0),
});

const readCommit = async (directory: string, sha: string): Promise<{ status: number; body: Answer }> => {
  const shown = await git(directory, ['show', '--no-patch', `--format=${SHOW_FORMAT}`, sha, '--']);
  if (!shown.ok) return { status: failureStatus(shown.failure), body: { error: shown.failure } };
  const [hash = '', parents = '', author = '', email = '', when = '', date = '', subject = '', body = ''] = shown.stdout.split(FIELD);
  const parentList = parents.split(' ').filter(Boolean);
  // Merges are measured against their first parent, the way a PR reads them.
  const firstParent = parentList[0];
  const stat = firstParent
    ? await git(directory, ['diff', '--shortstat', firstParent, hash, '--'])
    : await git(directory, ['show', '--shortstat', '--format=', hash, '--']);
  return {
    status: 200,
    body: { hash, parents: parentList, author, email, when, date, subject, body: body.trim(), ...shortstat(stat.ok ? stat.stdout : '') },
  };
};

const parseLimit = (value: string | null): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, LIMIT_MAX) : LIMIT_DEFAULT;
};

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }
  const directory = url.searchParams.get('directory') ?? '';
  if (req.method !== 'GET' || !['/log', '/refs', '/commit'].includes(url.pathname)) {
    json(res, 404, { error: 'not-found' });
    return;
  }
  if (!path.isAbsolute(directory)) {
    json(res, 400, { error: 'bad-request' });
    return;
  }
  const answer = async (): Promise<{ status: number; body: Answer }> => {
    if (url.pathname === '/refs') {
      const refs = await readRefs(directory);
      return refs.ok ? { status: 200, body: refs.value } : { status: failureStatus(refs.failure), body: { error: refs.failure } };
    }
    if (url.pathname === '/commit') {
      const sha = url.searchParams.get('sha') ?? '';
      return SHA.test(sha) ? readCommit(directory, sha) : { status: 400, body: { error: 'bad-request' } };
    }
    const picked = (url.searchParams.get('refs') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
    return readLog(directory, url.searchParams.get('mode') ?? 'auto', picked, parseLimit(url.searchParams.get('limit')));
  };
  void answer().then(({ status, body }) => json(res, status, body));
});

server.listen(port, '127.0.0.1');
