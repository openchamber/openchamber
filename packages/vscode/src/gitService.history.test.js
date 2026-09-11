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
  getGitLog,
  getCommitFiles,
  getCommitFileDiff,
} = await import('./gitService.ts?history-test');

const setGitResponse = (args, response) => {
  commandResponses.set(args.join('\u0000'), response);
};

const buildLegacyHistorySnapshot = (refs, current) => [...refs, ...(current ? [current] : [])]
  .map((ref) => `${ref.id}:${ref.revision || ''}`)
  .sort((left, right) => left.localeCompare(right))
  .join('|');

const encodeGitHistoryCursor = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64url');

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
    const legacySnapshot = buildLegacyHistorySnapshot([
      { id: 'refs/heads/main', revision: 'i1' },
      { id: 'refs/heads/feature', revision: 'm1' },
      { id: 'refs/remotes/origin/main', revision: 'i1' },
      { id: 'refs/remotes/origin/feature', revision: 'm1' },
      { id: 'refs/tags/v1.0.0', revision: 'i1' },
      { id: 'refs/tags/release/feature', revision: 'm1' },
    ], { id: 'HEAD', revision: 'm1' });
    expect(refs.snapshot).toMatch(/^[0-9a-f]{64}$/);
    expect(refs.snapshot).not.toBe(legacySnapshot);
  });

  it('keeps bounded history cursors with hundreds of refs and still loads page two', async () => {
    const manyRefs = Array.from({ length: 320 }, (_, index) => ({
      id: `refs/heads/branch-${String(index + 1).padStart(3, '0')}`,
      name: `branch-${String(index + 1).padStart(3, '0')}`,
      revision: `r${String(index + 1).padStart(3, '0')}`,
    }));
    setGitResponse(
      ['for-each-ref', '--format=%(refname)\t%(refname:short)\t%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'],
      {
        stdout: [
          'refs/heads/main\tmain\ti1',
          'refs/heads/feature\tfeature\tm1',
          ...manyRefs.map((ref) => `${ref.id}\t${ref.name}\t${ref.revision}`),
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    );
    setGitResponse(['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes'], { stdout: '', stderr: '', exitCode: 0 });
    setGitResponse(['symbolic-ref', '-q', 'HEAD'], { stdout: 'refs/heads/feature\n', stderr: '', exitCode: 0 });
    setGitResponse(['rev-parse', 'HEAD'], { stdout: 'm1\n', stderr: '', exitCode: 0 });
    setGitResponse(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { stdout: '', stderr: 'no upstream', exitCode: 1 });
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
          '\x1em1\x1ff1\x1fAlice\x1falice@example.com\x1f2024-01-03T00:00:00Z\x1fBounded page one\x1fHEAD -> feature\n 1 file changed, 3 insertions(+)',
          '\x1ef1\x1fi1\x1fAlice\x1falice@example.com\x1f2024-01-02T00:00:00Z\x1fBounded page one second\x1frefs/heads/feature\n 1 file changed, 2 insertions(+)',
          '\x1ei1\x1f\x1fAlice\x1falice@example.com\x1f2024-01-01T00:00:00Z\x1fBounded page one overflow\x1frefs/heads/main\n 1 file changed, 1 insertions(+)',
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
        stdout: '\x1ei1\x1f\x1fAlice\x1falice@example.com\x1f2024-01-01T00:00:00Z\x1fBounded page two\x1frefs/heads/main\n 1 file changed, 1 insertions(+)',
        stderr: '',
        exitCode: 0,
      },
    );

    const legacySnapshot = buildLegacyHistorySnapshot([
      { id: 'refs/heads/main', revision: 'i1' },
      { id: 'refs/heads/feature', revision: 'm1' },
      ...manyRefs,
    ], { id: 'HEAD', revision: 'm1' });
    const legacyCursor = encodeGitHistoryCursor({ offset: 2, snapshot: legacySnapshot });
    expect(legacyCursor.length).toBeGreaterThanOrEqual(256);

    const firstPage = await getGitHistory('/repo', { refs: ['HEAD'], limit: 2 });
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.nextCursor.length).toBeLessThan(256);

    const secondPage = await getGitHistory('/repo', { refs: ['HEAD'], limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.items.map((item) => item.id)).toEqual(['i1']);
    expect(secondPage.hasMore).toBe(false);
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

  it('preserves multiline commit bodies in legacy git log entries for all and ranged history', async () => {
    setGitResponse(
      [
        'log',
        '--max-count=5',
        '--all',
        '--topo-order',
        '--date=iso',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%b%x1d',
        '--shortstat',
      ],
      {
        stdout: [
          '\x1ec1\x1fp1 p2\x1fAlice\x1falice@example.com\x1f2024-01-04 00:00:00 +0000\x1fAll subject\x1frefs/heads/feature\x1fFirst body line',
          'Second body line\x1d',
          ' 2 files changed, 3 insertions(+), 1 deletions(-)',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    );
    setGitResponse(
      [
        'log',
        '--max-count=5',
        '--date=iso',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%b%x1d',
        '--shortstat',
        'main..HEAD',
      ],
      {
        stdout: [
          '\x1ec2\x1fp3\x1fBob\x1fbob@example.com\x1f2024-01-05 00:00:00 +0000\x1fRange subject\x1frefs/heads/feature, refs/remotes/origin/feature\x1fBody line one',
          'Body line two\x1d',
          ' 1 file changed, 2 insertions(+), 4 deletions(-)',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    );

    const allLog = await getGitLog('/repo', { maxCount: 5, all: true });
    expect(allLog.all).toEqual([
      expect.objectContaining({
        hash: 'c1',
        parents: ['p1', 'p2'],
        message: 'All subject',
        body: 'First body line\nSecond body line',
        filesChanged: 2,
        insertions: 3,
        deletions: 1,
      }),
    ]);

    const rangedLog = await getGitLog('/repo', { maxCount: 5, from: 'main' });
    expect(rangedLog.all).toEqual([
      expect.objectContaining({
        hash: 'c2',
        parents: ['p3'],
        message: 'Range subject',
        body: 'Body line one\nBody line two',
        filesChanged: 1,
        insertions: 2,
        deletions: 4,
      }),
    ]);
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

  it('parses normalized commit files from one explicit diff-tree comparison', async () => {
    setGitResponse(
      ['diff-tree', '-r', '--no-commit-id', '-M', '--raw', '--numstat', '--no-abbrev', '-z', 'parent123', 'commit456'],
      {
        stdout: [
          ':000000 100644 0000000000000000000000000000000000000000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa A\0added.txt\0',
          ':100644 100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc M\0modified.txt\0',
          ':100644 000000 dddddddddddddddddddddddddddddddddddddddd 0000000000000000000000000000000000000000 D\0deleted.txt\0',
          ':100644 100644 eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ffffffffffffffffffffffffffffffffffffffff R100\0old-name.ts\0new-name.ts\0',
          ':100644 120000 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 T\0link.txt\0',
          ':100644 160000 3333333333333333333333333333333333333333 4444444444444444444444444444444444444444 T\0submodule\0',
          ':100644 100644 5555555555555555555555555555555555555555 6666666666666666666666666666666666666666 M\0image.png\0',
          '3\t0\tadded.txt\0',
          '5\t2\tmodified.txt\0',
          '0\t7\tdeleted.txt\0',
          '1\t1\t\0old-name.ts\0new-name.ts\0',
          '1\t1\tlink.txt\0',
          '-\t-\tsubmodule\0',
          '-\t-\timage.png\0',
        ].join(''),
        stderr: '',
        exitCode: 0,
      },
    );

    await expect(getCommitFiles('/repo', { commitHash: 'commit456', parentHash: 'parent123' })).resolves.toEqual({
      files: [
        {
          path: 'added.txt',
          status: 'A',
          kind: 'file',
          objectId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          insertions: 3,
          deletions: 0,
          isBinary: false,
        },
        {
          path: 'modified.txt',
          status: 'M',
          kind: 'file',
          originalObjectId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          objectId: 'cccccccccccccccccccccccccccccccccccccccc',
          insertions: 5,
          deletions: 2,
          isBinary: false,
        },
        {
          path: 'deleted.txt',
          status: 'D',
          kind: 'file',
          originalObjectId: 'dddddddddddddddddddddddddddddddddddddddd',
          insertions: 0,
          deletions: 7,
          isBinary: false,
        },
        {
          path: 'new-name.ts',
          originalPath: 'old-name.ts',
          status: 'R',
          kind: 'file',
          originalObjectId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          objectId: 'ffffffffffffffffffffffffffffffffffffffff',
          insertions: 1,
          deletions: 1,
          isBinary: false,
        },
        {
          path: 'link.txt',
          status: 'M',
          kind: 'symlink',
          originalObjectId: '1111111111111111111111111111111111111111',
          objectId: '2222222222222222222222222222222222222222',
          insertions: 1,
          deletions: 1,
          isBinary: false,
        },
         {
           path: 'submodule',
           status: 'M',
           kind: 'gitlink',
           originalObjectId: '3333333333333333333333333333333333333333',
           objectId: '4444444444444444444444444444444444444444',
           insertions: 0,
           deletions: 0,
           isBinary: false,
         },
        {
          path: 'image.png',
          status: 'M',
          kind: 'file',
          originalObjectId: '5555555555555555555555555555555555555555',
          objectId: '6666666666666666666666666666666666666666',
          insertions: 0,
          deletions: 0,
          isBinary: true,
        },
      ],
    });
  });

  it('parses 64-char object ids from diff-tree and ls-tree output', async () => {
    const oldObjectId = 'a'.repeat(64);
    const newObjectId = 'b'.repeat(64);
    setGitResponse(
      ['diff-tree', '-r', '--no-commit-id', '-M', '--raw', '--numstat', '--no-abbrev', '-z', 'parent256', 'commit256'],
      {
        stdout: [
          `:100644 100644 ${oldObjectId} ${newObjectId} M\0sha256.txt\0`,
          '2\t1\tsha256.txt\0',
        ].join(''),
        stderr: '',
        exitCode: 0,
      },
    );
    setGitResponse(['ls-tree', '-z', 'parent256', '--', 'sha256.txt'], {
      stdout: `100644 blob ${oldObjectId}\tsha256.txt\0`,
      stderr: '',
      exitCode: 0,
    });
    setGitResponse(['ls-tree', '-z', 'commit256', '--', 'sha256.txt'], {
      stdout: `100644 blob ${newObjectId}\tsha256.txt\0`,
      stderr: '',
      exitCode: 0,
    });
    setGitResponse(['cat-file', '-s', oldObjectId], { stdout: '4\n', stderr: '', exitCode: 0 });
    setGitResponse(['cat-file', '-s', newObjectId], { stdout: '5\n', stderr: '', exitCode: 0 });
    setGitResponse(['cat-file', '-p', oldObjectId], { stdout: 'old\n', stderr: '', exitCode: 0 });
    setGitResponse(['cat-file', '-p', newObjectId], { stdout: 'new\n', stderr: '', exitCode: 0 });

    await expect(getCommitFiles('/repo', { commitHash: 'commit256', parentHash: 'parent256' })).resolves.toEqual({
      files: [
        {
          path: 'sha256.txt',
          status: 'M',
          kind: 'file',
          originalObjectId: oldObjectId,
          objectId: newObjectId,
          insertions: 2,
          deletions: 1,
          isBinary: false,
        },
      ],
    });

    await expect(getCommitFileDiff('/repo', {
      commitHash: 'commit256',
      parentHash: 'parent256',
      originalPath: 'sha256.txt',
      modifiedPath: 'sha256.txt',
    })).resolves.toEqual({
      status: 'ready',
      original: 'old\n',
      modified: 'new\n',
    });
  });

  it('uses --root comparisons for root commits and ignores malformed records', async () => {
    setGitResponse(
      ['diff-tree', '--root', '-r', '--no-commit-id', '-M', '--raw', '--numstat', '--no-abbrev', '-z', 'root123'],
      {
        stdout: [
          ':000000 100644 0000000000000000000000000000000000000000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa A\0valid.txt\0',
          ':100644 100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc M\0missing-numstat.txt\0',
          '4\t0\tvalid.txt\0',
          '2\t1\t\0dangling-old.txt\0',
        ].join(''),
        stderr: '',
        exitCode: 0,
      },
    );

    await expect(getCommitFiles('/repo', { commitHash: 'root123', parentHash: null })).resolves.toEqual({
      files: [
        {
          path: 'valid.txt',
          status: 'A',
          kind: 'file',
          objectId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          insertions: 4,
          deletions: 0,
          isBinary: false,
        },
      ],
    });
  });

  it('throws when the explicit parent diff-tree lookup fails', async () => {
    setGitResponse(
      ['diff-tree', '-r', '--no-commit-id', '-M', '--raw', '--numstat', '--no-abbrev', '-z', 'missing-parent', 'commit456'],
      {
        stdout: '',
        stderr: 'fatal: bad object missing-parent',
        exitCode: 128,
      },
    );

    await expect(getCommitFiles('/repo', { commitHash: 'commit456', parentHash: 'missing-parent' })).rejects.toThrow('fatal: bad object missing-parent');
  });

  it('returns an empty change list when diff-tree succeeds with no changed files', async () => {
    setGitResponse(
      ['diff-tree', '-r', '--no-commit-id', '-M', '--raw', '--numstat', '--no-abbrev', '-z', 'parent123', 'commit456'],
      {
        stdout: '',
        stderr: '',
        exitCode: 0,
      },
    );

    await expect(getCommitFiles('/repo', { commitHash: 'commit456', parentHash: 'parent123' })).resolves.toEqual({ files: [] });
  });

  it('returns ready previews for explicit rename comparisons', async () => {
    setGitResponse(['ls-tree', '-z', 'parent123', '--', 'old-name.ts'], {
      stdout: '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\told-name.ts\0',
      stderr: '',
      exitCode: 0,
    });
    setGitResponse(['ls-tree', '-z', 'commit456', '--', 'new-name.ts'], {
      stdout: '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tnew-name.ts\0',
      stderr: '',
      exitCode: 0,
    });
    setGitResponse(['cat-file', '-s', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], { stdout: '12\n', stderr: '', exitCode: 0 });
    setGitResponse(['cat-file', '-s', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'], { stdout: '16\n', stderr: '', exitCode: 0 });
    setGitResponse(['cat-file', '-p', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], { stdout: 'old contents\n', stderr: '', exitCode: 0 });
    setGitResponse(['cat-file', '-p', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'], { stdout: 'new contents\n', stderr: '', exitCode: 0 });

    await expect(
      getCommitFileDiff('/repo', {
        commitHash: 'commit456',
        parentHash: 'parent123',
        originalPath: 'old-name.ts',
        modifiedPath: 'new-name.ts',
      }),
    ).resolves.toEqual({
      status: 'ready',
      original: 'old contents\n',
      modified: 'new contents\n',
    });
  });

  it('returns nullable-side previews for additions without reading a missing parent blob', async () => {
    setGitResponse(['ls-tree', '-z', 'commit456', '--', 'added.txt'], {
      stdout: '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tadded.txt\0',
      stderr: '',
      exitCode: 0,
    });
    setGitResponse(['cat-file', '-s', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], { stdout: '6\n', stderr: '', exitCode: 0 });
    setGitResponse(['cat-file', '-p', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], { stdout: 'hello\n', stderr: '', exitCode: 0 });

    await expect(
      getCommitFileDiff('/repo', {
        commitHash: 'commit456',
        parentHash: null,
        originalPath: null,
        modifiedPath: 'added.txt',
      }),
    ).resolves.toEqual({
      status: 'ready',
      original: '',
      modified: 'hello\n',
    });
  });

  it('returns too-large before reading preview blobs', async () => {
    setGitResponse(['ls-tree', '-z', 'parent123', '--', 'big-old.ts'], {
      stdout: '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tbig-old.ts\0',
      stderr: '',
      exitCode: 0,
    });
    setGitResponse(['ls-tree', '-z', 'commit456', '--', 'big-new.ts'], {
      stdout: '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tbig-new.ts\0',
      stderr: '',
      exitCode: 0,
    });
    setGitResponse(['cat-file', '-s', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], { stdout: '4194304\n', stderr: '', exitCode: 0 });
    setGitResponse(['cat-file', '-s', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'], { stdout: '4194305\n', stderr: '', exitCode: 0 });

    const result = await getCommitFileDiff('/repo', {
      commitHash: 'commit456',
      parentHash: 'parent123',
      originalPath: 'big-old.ts',
      modifiedPath: 'big-new.ts',
    });

    expect(result).toEqual({
      status: 'too-large',
      totalBytes: 8388609,
      maxBytes: 8388608,
    });
    expect(spawnCalls.some((call) => call.args[0] === 'cat-file' && call.args[1] === '-p')).toBe(false);
  });
});
