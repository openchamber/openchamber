import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';

const spawnCalls = [];
const commandResponses = new Map();
const mockSpawn = mock((command, args, options) => {
  spawnCalls.push({ command, args: [...args], options });

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stderr = stderr;

  queueMicrotask(() => {
    const response = commandResponses.get(args.join('\u0000')) || { stdout: '', stderr: `Unexpected git command: ${args.join(' ')}`, exitCode: 1 };
    if (response.stdout) {
      stdout.emit('data', Buffer.from(response.stdout));
    }
    if (response.stderr) {
      stderr.emit('data', Buffer.from(response.stderr));
    }
    proc.emit('close', response.exitCode ?? 0);
  });

  return proc;
});

mock.module('child_process', () => ({
  spawn: mockSpawn,
  execFile: mock(() => {
    throw new Error('execFile should not be used in git history tests');
  }),
}));

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const {
  getGitHistoryRefs,
  getGitHistory,
  getGitHistoryMergeBase,
} = await import('./gitService.ts?history-test');

const setGitResponse = (args, response) => {
  commandResponses.set(args.join('\u0000'), response);
};

const registerHistoryRefs = ({
  featureRevision = 'm1',
  headRevision = featureRevision,
  headRef = 'refs/heads/feature\n',
  upstream = 'origin/feature\n',
  includeRemote = true,
} = {}) => {
  const refLines = [
    'refs/heads/main\tmain\ti1',
    `refs/heads/feature\tfeature\t${featureRevision}`,
  ];

  const remoteLines = includeRemote
    ? [
        'refs/remotes/origin/HEAD\torigin/HEAD\ti1',
        'refs/remotes/origin/main\torigin/main\ti1',
        `refs/remotes/origin/feature\torigin/feature\t${featureRevision}`,
      ]
    : [];

  setGitResponse(
    ['for-each-ref', '--format=%(refname)\t%(refname:short)\t%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'],
    {
      stdout: [...refLines, ...remoteLines, 'refs/tags/v1.0.0\tv1.0.0\ti1', `refs/tags/release/feature\trelease/feature\t${featureRevision}`].join('\n'),
      stderr: '',
      exitCode: 0,
    },
  );

  setGitResponse(
    ['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes'],
    {
      stdout: includeRemote ? 'refs/remotes/origin/HEAD refs/remotes/origin/main\nrefs/remotes/origin/main \nrefs/remotes/origin/feature \n' : '',
      stderr: '',
      exitCode: 0,
    },
  );

  setGitResponse(['symbolic-ref', '-q', 'HEAD'], { stdout: headRef, stderr: '', exitCode: headRef ? 0 : 1 });
  setGitResponse(['rev-parse', 'HEAD'], { stdout: `${headRevision}\n`, stderr: '', exitCode: 0 });
  setGitResponse(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { stdout: upstream, stderr: upstream ? '' : 'no upstream', exitCode: upstream ? 0 : 1 },
  );
};

describe('VS Code git history service parity', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    commandResponses.clear();
    process.env.SSH_AUTH_SOCK = '/tmp/openchamber-test.sock';
  });

  it('classifies refs and resolves HEAD, upstream, and base refs', async () => {
    registerHistoryRefs();

    const refs = await getGitHistoryRefs('/repo');

    expect(refs.current).toMatchObject({ id: 'HEAD', kind: 'head', name: 'feature', revision: 'm1' });
    expect(refs.upstream).toMatchObject({ id: 'refs/remotes/origin/feature', kind: 'remote', category: 'remote-branches' });
    expect(refs.base).toMatchObject({ id: 'refs/heads/main', kind: 'local', category: 'branches' });
    expect(refs.refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'refs/heads/main', name: 'main', kind: 'local', category: 'branches' }),
      expect.objectContaining({ id: 'refs/remotes/origin/main', name: 'origin/main', kind: 'remote', category: 'remote-branches' }),
      expect.objectContaining({ id: 'refs/tags/v1.0.0', name: 'v1.0.0', kind: 'tag', category: 'tags' }),
    ]));
    expect(refs.snapshot).toBe([
      'HEAD:m1',
      'refs/heads/feature:m1',
      'refs/heads/main:i1',
      'refs/remotes/origin/feature:m1',
      'refs/remotes/origin/main:i1',
      'refs/tags/release/feature:m1',
      'refs/tags/v1.0.0:i1',
    ].join('|'));
  });

  it('returns topological history pages, validates requests, and rejects stale cursors', async () => {
    registerHistoryRefs();
    setGitResponse(
      [
        'log',
        '--topo-order',
        '--decorate=full',
        '--date=iso-strict',
        '--skip=0',
        '--max-count=3',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
        '--shortstat',
        'HEAD',
      ],
      {
        stdout: [
          '\x1em1\x1ff1 t1\x1fAlice\x1falice@example.com\x1f2024-01-03T00:00:00Z\x1fMerge topic\x1fHEAD -> feature, origin/feature, tag: release/feature\n 2 files changed, 3 insertions(+), 1 deletions(-)',
          '\x1et1\x1fi1\x1fAlice\x1falice@example.com\x1f2024-01-02T00:00:00Z\x1fTopic commit\x1f\n 1 file changed, 2 insertions(+)',
          '\x1ef1\x1fi1\x1fAlice\x1falice@example.com\x1f2024-01-01T00:00:00Z\x1fFeature commit\x1frefs/heads/feature\n 1 file changed, 1 insertions(+)',
        ].join(''),
        stderr: '',
        exitCode: 0,
      },
    );
    setGitResponse(
      [
        'log',
        '--topo-order',
        '--decorate=full',
        '--date=iso-strict',
        '--skip=2',
        '--max-count=3',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
        '--shortstat',
        'HEAD',
      ],
      {
        stdout: [
          '\x1ef1\x1fi1\x1fAlice\x1falice@example.com\x1f2024-01-01T00:00:00Z\x1fFeature commit\x1frefs/heads/feature\n 1 file changed, 1 insertions(+)',
          '\x1ei1\x1f\x1fAlice\x1falice@example.com\x1f2023-12-31T00:00:00Z\x1fInitial commit\x1frefs/heads/main, origin/main, tag: v1.0.0\n 1 file changed, 1 insertions(+)',
        ].join(''),
        stderr: '',
        exitCode: 0,
      },
    );

    await expect(getGitHistory('/repo', { refs: ['HEAD'], limit: 0 })).rejects.toThrow('limit must be between 1 and 100');
    await expect(getGitHistory('/repo', { refs: ['refs/heads/missing'] })).rejects.toThrow('Unknown ref: refs/heads/missing');

    const firstPage = await getGitHistory('/repo', { refs: ['HEAD'], limit: 2 });
    expect(firstPage.items.map((item) => item.id)).toEqual(['m1', 't1']);
    expect(firstPage.items[0]).toMatchObject({
      parentIds: ['f1', 't1'],
      subject: 'Merge topic',
      statistics: { files: 2, insertions: 3, deletions: 1 },
    });
    expect(firstPage.items[0].references).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'HEAD', kind: 'head' }),
      expect.objectContaining({ id: 'refs/heads/feature', kind: 'local' }),
      expect.objectContaining({ id: 'refs/remotes/origin/feature', kind: 'remote' }),
      expect.objectContaining({ id: 'refs/tags/release/feature', kind: 'tag' }),
    ]));
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();

    const firstPageCursor = firstPage.nextCursor;
    await expect(getGitHistory('/repo', { refs: ['HEAD'], limit: 2, cursor: 'not-base64' })).rejects.toMatchObject({
      message: 'stale cursor',
      statusCode: 409,
      code: 'stale_git_history_cursor',
    });
    const secondPage = await getGitHistory('/repo', { refs: ['HEAD'], limit: 2, cursor: firstPageCursor });
    expect(secondPage.items.map((item) => item.id)).toEqual(['f1', 'i1']);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.refsSnapshot).toBe(firstPage.refsSnapshot);

    registerHistoryRefs({ featureRevision: 'm2', headRevision: 'm2' });
    await expect(getGitHistory('/repo', { refs: ['HEAD'], limit: 2, cursor: firstPageCursor })).rejects.toMatchObject({
      message: 'stale cursor',
      statusCode: 409,
      code: 'stale_git_history_cursor',
    });
  });

  it('returns merge bases and handles detached or no-remote repositories', async () => {
    registerHistoryRefs();
    setGitResponse(['merge-base', 'HEAD', 'refs/heads/main'], { stdout: 'i1\n', stderr: '', exitCode: 0 });

    await expect(getGitHistoryMergeBase('/repo', { refs: ['HEAD', 'refs/heads/main'] })).resolves.toEqual({ mergeBase: 'i1' });
    await expect(getGitHistoryMergeBase('/repo', { refs: ['HEAD'] })).resolves.toEqual({ mergeBase: null });

    registerHistoryRefs({ headRef: '', headRevision: 'i1' });
    const detachedRefs = await getGitHistoryRefs('/repo');
    expect(detachedRefs.current).toMatchObject({ id: 'HEAD', kind: 'head', revision: 'i1', name: 'HEAD' });

    registerHistoryRefs({ includeRemote: false, upstream: '' });
    const localOnlyRefs = await getGitHistoryRefs('/repo');
    expect(localOnlyRefs.upstream).toBeNull();
    expect(localOnlyRefs.base).toBeNull();
    expect(localOnlyRefs.refs.some((ref) => ref.kind === 'remote')).toBe(false);
  });

  it('supports all-ref history while retaining the explicit-ref bound', async () => {
    const refLines = Array.from({ length: 35 }, (_, index) => `refs/heads/branch-${index + 1}\tbranch-${index + 1}\tsha-${index + 1}`);
    setGitResponse(
      ['for-each-ref', '--format=%(refname)\t%(refname:short)\t%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'],
      {
        stdout: refLines.join('\n'),
        stderr: '',
        exitCode: 0,
      },
    );
    setGitResponse(['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes'], { stdout: '', stderr: '', exitCode: 0 });
    setGitResponse(['symbolic-ref', '-q', 'HEAD'], { stdout: 'refs/heads/branch-1\n', stderr: '', exitCode: 0 });
    setGitResponse(['rev-parse', 'HEAD'], { stdout: 'sha-1\n', stderr: '', exitCode: 0 });
    setGitResponse(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { stdout: '', stderr: 'no upstream', exitCode: 1 });
    setGitResponse(
      [
        'log',
        '--topo-order',
        '--decorate=full',
        '--date=iso-strict',
        '--skip=0',
        '--max-count=101',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
        '--shortstat',
        '--all',
      ],
      {
        stdout: '\x1esha-35\x1fsha-1\x1fAlice\x1falice@example.com\x1f2024-01-03T00:00:00Z\x1fBranch 35\x1frefs/heads/branch-35\n 1 file changed, 1 insertions(+)',
        stderr: '',
        exitCode: 0,
      },
    );

    const page = await getGitHistory('/repo', { all: true, limit: 100 });
    expect(page.items.map((item) => item.subject)).toEqual(['Branch 35']);
    expect(spawnCalls.some((call) => call.args.includes('--all'))).toBe(true);

    const refs = Array.from({ length: 33 }, (_, index) => `refs/heads/branch-${index + 1}`);
    await expect(getGitHistory('/repo', { refs })).rejects.toThrow('refs must contain at most 32 values');
  });

  it('rejects a detached-head cursor after HEAD moves even when named refs are unchanged', async () => {
    registerHistoryRefs({ headRef: '', headRevision: 'd1', includeRemote: false, upstream: '' });
    setGitResponse(
      [
        'log',
        '--topo-order',
        '--decorate=full',
        '--date=iso-strict',
        '--skip=0',
        '--max-count=2',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
        '--shortstat',
        'HEAD',
      ],
      {
        stdout: [
          '\x1ed1\x1fi1\x1fAlice\x1falice@example.com\x1f2024-01-03T00:00:00Z\x1fDetached head\x1fHEAD\n 1 file changed, 1 insertions(+)',
          '\x1ei1\x1f\x1fAlice\x1falice@example.com\x1f2023-12-31T00:00:00Z\x1fInitial commit\x1frefs/heads/main, tag: v1.0.0\n 1 file changed, 1 insertions(+)',
        ].join(''),
        stderr: '',
        exitCode: 0,
      },
    );
    setGitResponse(
      [
        'log',
        '--topo-order',
        '--decorate=full',
        '--date=iso-strict',
        '--skip=1',
        '--max-count=2',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
        '--shortstat',
        'HEAD',
      ],
      {
        stdout: '\x1ei1\x1f\x1fAlice\x1falice@example.com\x1f2023-12-31T00:00:00Z\x1fInitial commit\x1frefs/heads/main, tag: v1.0.0\n 1 file changed, 1 insertions(+)',
        stderr: '',
        exitCode: 0,
      },
    );

    const firstPage = await getGitHistory('/repo', { refs: ['HEAD'], limit: 1 });
    const detachedCursor = firstPage.nextCursor;
    expect(detachedCursor).not.toBeNull();

    registerHistoryRefs({ headRef: '', headRevision: 'd2', includeRemote: false, upstream: '' });

    await expect(getGitHistory('/repo', { refs: ['HEAD'], limit: 1, cursor: detachedCursor })).rejects.toMatchObject({
      message: 'stale cursor',
      statusCode: 409,
      code: 'stale_git_history_cursor',
    });
  });
});
