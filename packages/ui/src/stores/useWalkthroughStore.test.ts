import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SourceControlReadContext } from '@/lib/api/types';
import type { WalkthroughResult, WalkthroughSource, WalkthroughTarget } from '@/lib/walkthrough/types';

const SOURCE = { source: { kind: 'working-tree', scope: 'all' } } satisfies WalkthroughTarget;
type WorkingTreeResult = WalkthroughResult & { source: typeof SOURCE.source };

const result = (overrides: Partial<WorkingTreeResult> = {}): WorkingTreeResult => ({
  source: SOURCE.source,
  walkthrough: null,
  hunks: [],
  hunkCount: 0,
  ...overrides,
});

const finished = result({
  walkthrough: {
    title: 'Change',
    focus: '',
    chapters: [{
      id: 'chapter-1',
      title: 'Data',
      icon: 'doc',
      blurb: '',
      stops: [{ id: 'stop-1-1', title: 'A', hunkIds: ['h'], importance: 'normal', prose: 'p' }],
    }],
  },
  generatedAt: '2026-08-02T00:00:00.000Z',
});

type PullRequestTarget = {
  source: { kind: 'pr'; number: number };
  context: Readonly<SourceControlReadContext>;
};
const PR_CONTEXT = {
  provider: 'github',
  instance: 'github.com',
  accountId: 'account-a',
  repositoryId: 'repo-1',
  bindingRevision: 3,
  directory: '/repo',
  primaryRemote: 'origin',
} satisfies SourceControlReadContext;
const PR_TARGET_A: PullRequestTarget = {
  source: { kind: 'pr', number: 17 },
  context: PR_CONTEXT,
};
const PR_TARGET_B: PullRequestTarget = {
  source: { kind: 'pr', number: 17 },
  context: { ...PR_CONTEXT, accountId: 'account-b' },
};
const prResult = (target: PullRequestTarget): WalkthroughResult => ({
  source: target.source,
  readContext: target.context,
  walkthrough: null,
  hunks: [],
  hunkCount: 0,
});

// Plain closures rather than mock helpers: bun's `mock()` is not typed with
// vitest's `mockResolvedValue` family, and the repo already prefers this style.
let readResult: WalkthroughResult = result();
let generateCalls = 0;
let releaseGeneration: (() => void) | undefined;
let lastReadModel: string | undefined;
let lastGenerateModel: string | undefined;
let lastReadLanguage: string | undefined;
let lastGenerateLanguage: string | undefined;
let lastGenerationSignal: AbortSignal | undefined;

mock.module('@/lib/walkthrough/api', () => ({
  fetchWalkthrough: async (
    _directory: string,
    _target: WalkthroughTarget,
    options: { model?: string; language?: string; signal?: AbortSignal } = {},
  ) => {
    lastReadModel = options.model;
    lastReadLanguage = options.language;
    return readResult;
  },
  generateWalkthrough: async (
    _directory: string,
    _target: WalkthroughTarget,
    options: { model?: string; language?: string; signal?: AbortSignal } = {},
  ) => {
    generateCalls += 1;
    lastGenerateModel = options.model;
    lastGenerateLanguage = options.language;
    lastGenerationSignal = options.signal;
    return new Promise<WalkthroughResult>((resolve) => {
      releaseGeneration = () => resolve(finished);
    });
  },
  cancelWalkthroughGeneration: async () => {},
  // The store imports this for its progress poller. Leaving it out of the mock
  // makes the whole module fail to load, which reads as an unrelated crash.
  fetchWalkthroughStage: async () => null,
}));
let runtimeKey = 'local';
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));

const { useWalkthroughStore, walkthroughSourceKey } = await import('./useWalkthroughStore');

test('PR cache and handoff identity include the selected repository', () => {
  const upstream: WalkthroughSource = { kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' } };
  const fork: WalkthroughSource = { kind: 'pr', number: 42, sourceRepo: { owner: 'fork', repo: 'project' } };
  expect(walkthroughSourceKey({ kind: 'pr', number: 42 })).toBe('pr:42');
  expect(walkthroughSourceKey(upstream)).toBe('pr:upstream/project:42');
  expect(walkthroughSourceKey(fork)).toBe('pr:fork/project:42');
  const context = {
    provider: 'github', instance: 'github.com', accountId: 'account-a', repositoryId: 'repo-1',
    bindingRevision: 3, directory: '/repo', primaryRemote: 'origin',
  } as const;
  useWalkthroughStore.getState().requestTarget('/repo', { source: upstream, context });
  expect(useWalkthroughStore.getState().getRequestedTarget('/repo')).toEqual({ source: upstream, context });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  runtimeKey = 'local';
  lastGenerationSignal = undefined;
});

describe('useWalkthroughStore — reattaching to a running generation', () => {
  beforeEach(() => {
    useWalkthroughStore.getState().reset();
    runtimeKey = 'local';
    readResult = result();
    generateCalls = 0;
    releaseGeneration = undefined;
  });

  afterEach(() => {
    useWalkthroughStore.getState().reset();
  });

  test('a reload that finds work in progress ends up showing the finished result', async () => {
    // What a refresh looks like: the read says a job is running, and the
    // generation the client re-attaches to finishes a moment later.
    readResult = result({ generating: true });

    await useWalkthroughStore.getState().load('/repo', SOURCE);
    await flush();

    expect(generateCalls).toBe(1);
    expect(useWalkthroughStore.getState().getEntry('/repo', SOURCE).status).toBe('generating');

    releaseGeneration?.();
    await flush();

    const entry = useWalkthroughStore.getState().getEntry('/repo', SOURCE);
    expect(entry.status).toBe('ready');
    expect(entry.result?.walkthrough?.title).toBe('Change');
  });

  test('does not re-attach when nothing is running', async () => {
    readResult = result({ generating: false });

    await useWalkthroughStore.getState().load('/repo', SOURCE);
    await flush();

    expect(generateCalls).toBe(0);
    expect(useWalkthroughStore.getState().getEntry('/repo', SOURCE).status).toBe('ready');
  });

  test('a load while generating does not overwrite the pending state', async () => {
    readResult = result({ generating: true });
    await useWalkthroughStore.getState().load('/repo', SOURCE);
    await flush();

    await useWalkthroughStore.getState().load('/repo', SOURCE);
    await flush();

    expect(generateCalls).toBe(1);
    expect(useWalkthroughStore.getState().getEntry('/repo', SOURCE).status).toBe('generating');
  });
});

describe('useWalkthroughStore — model selection', () => {
  beforeEach(() => {
    useWalkthroughStore.getState().reset();
    readResult = result();
    generateCalls = 0;
    lastReadModel = undefined;
    lastGenerateModel = undefined;
  });

  afterEach(() => {
    useWalkthroughStore.getState().reset();
  });

  test('sends the chosen model with both the read and the generation', async () => {
    useWalkthroughStore.getState().selectModel('/repo', SOURCE, 'anthropic/claude-haiku-4-5');

    await useWalkthroughStore.getState().load('/repo', SOURCE);
    await flush();
    expect(lastReadModel).toBe('anthropic/claude-haiku-4-5');

    void useWalkthroughStore.getState().generate('/repo', SOURCE);
    await flush();
    expect(lastGenerateModel).toBe('anthropic/claude-haiku-4-5');
    releaseGeneration?.();
    await flush();
  });

  test('clearing the choice falls back to whatever the server resolves', async () => {
    useWalkthroughStore.getState().selectModel('/repo', SOURCE, 'anthropic/claude-haiku-4-5');
    useWalkthroughStore.getState().selectModel('/repo', SOURCE, null);

    await useWalkthroughStore.getState().load('/repo', SOURCE);
    await flush();

    expect(lastReadModel).toBe(undefined);
  });

  test('keeps choices apart per source', async () => {
    const branch: WalkthroughTarget = { source: { kind: 'branch', baseRef: 'main', headRef: 'feature' } };
    useWalkthroughStore.getState().selectModel('/repo', SOURCE, 'anthropic/claude-haiku-4-5');

    expect(useWalkthroughStore.getState().getSelectedModel("/repo", branch)).toBe(undefined);
    expect(useWalkthroughStore.getState().getSelectedModel('/repo', SOURCE))
      .toBe('anthropic/claude-haiku-4-5');
  });

  test('keeps commit walkthroughs separate and selecting one does not generate', () => {
    const generatedBefore = generateCalls;
    const first: WalkthroughTarget = { source: { kind: 'commit', hash: 'a'.repeat(40) } };
    const second: WalkthroughTarget = { source: { kind: 'commit', hash: 'b'.repeat(40) } };
    useWalkthroughStore.getState().selectModel('/repo', first, 'anthropic/claude-haiku-4-5');
    useWalkthroughStore.getState().requestTarget('/repo', second);
    expect(useWalkthroughStore.getState().getSelectedModel('/repo', first)).toBe('anthropic/claude-haiku-4-5');
    expect(useWalkthroughStore.getState().getSelectedModel('/repo', second)).toBeUndefined();
    expect(useWalkthroughStore.getState().getRequestedTarget('/repo')).toEqual(second);
    expect(generateCalls).toBe(generatedBefore);
  });
});

describe('useWalkthroughStore — walkthrough language', () => {
  beforeEach(() => {
    useWalkthroughStore.getState().reset();
    readResult = result();
    generateCalls = 0;
    lastReadLanguage = undefined;
    lastGenerateLanguage = undefined;
  });

  afterEach(() => {
    useWalkthroughStore.getState().reset();
  });

  // The read carries it too: readiness is an answer about a specific request,
  // and the language instruction is part of that request.
  test('sends the resolved language with both the read and the generation', async () => {
    await useWalkthroughStore.getState().load('/repo', SOURCE, { language: 'uk' });
    await flush();
    expect(lastReadLanguage).toBe('uk');

    void useWalkthroughStore.getState().generate('/repo', SOURCE, { language: 'uk' });
    await flush();
    expect(lastGenerateLanguage).toBe('uk');
    releaseGeneration?.();
    await flush();
  });

  test('keeps an explicit choice apart per source', () => {
    const branch: WalkthroughTarget = { source: { kind: 'branch', baseRef: 'main', headRef: 'feature' } };
    useWalkthroughStore.getState().selectLanguage('/repo', SOURCE, 'ja');

    expect(useWalkthroughStore.getState().getSelectedLanguage('/repo', branch)).toBe(undefined);
    expect(useWalkthroughStore.getState().getSelectedLanguage('/repo', SOURCE)).toBe('ja');
  });

  test('clearing the choice returns to no explicit language', () => {
    useWalkthroughStore.getState().selectLanguage('/repo', SOURCE, 'ja');
    useWalkthroughStore.getState().selectLanguage('/repo', SOURCE, null);

    expect(useWalkthroughStore.getState().getSelectedLanguage('/repo', SOURCE)).toBe(undefined);
  });

  test('a re-attach after a reload still names the language it would ask for', async () => {
    readResult = result({ generating: true });

    await useWalkthroughStore.getState().load('/repo', SOURCE, { language: 'pl' });
    await flush();

    expect(lastGenerateLanguage).toBe('pl');
    releaseGeneration?.();
    await flush();
  });
});

describe('useWalkthroughStore — target authority', () => {
  beforeEach(() => {
    useWalkthroughStore.getState().reset();
    readResult = result();
  });

  afterEach(() => {
    useWalkthroughStore.getState().reset();
  });

  test('separates entries and selections for two accounts reviewing the same PR', async () => {
    useWalkthroughStore.getState().selectModel('/repo', PR_TARGET_A, 'anthropic/model-a');
    useWalkthroughStore.getState().selectLanguage('/repo', PR_TARGET_A, 'uk');

    readResult = prResult(PR_TARGET_A);
    await useWalkthroughStore.getState().load('/repo', PR_TARGET_A);
    readResult = prResult(PR_TARGET_B);
    await useWalkthroughStore.getState().load('/repo', PR_TARGET_B);

    expect(useWalkthroughStore.getState().getSelectedModel('/repo', PR_TARGET_B)).toBe(undefined);
    expect(useWalkthroughStore.getState().getSelectedLanguage('/repo', PR_TARGET_B)).toBe(undefined);
    expect(useWalkthroughStore.getState().getEntry('/repo', PR_TARGET_A).result?.readContext?.accountId).toBe('account-a');
    expect(useWalkthroughStore.getState().getEntry('/repo', PR_TARGET_B).result?.readContext?.accountId).toBe('account-b');
  });

  test('does not expose requested targets or selections to another runtime', () => {
    useWalkthroughStore.getState().requestTarget('/repo', PR_TARGET_A);
    useWalkthroughStore.getState().selectModel('/repo', PR_TARGET_A, 'anthropic/model-a');

    runtimeKey = 'remote';

    expect(useWalkthroughStore.getState().getRequestedTarget('/repo')).toBe(undefined);
    expect(useWalkthroughStore.getState().getSelectedModel('/repo', PR_TARGET_A)).toBe(undefined);
  });

  test('reset aborts active work and prevents its completion from restoring state', async () => {
    void useWalkthroughStore.getState().generate('/repo', SOURCE);
    await flush();

    useWalkthroughStore.getState().reset();
    expect(lastGenerationSignal?.aborted).toBe(true);

    releaseGeneration?.();
    await flush();
    expect(useWalkthroughStore.getState().getEntry('/repo', SOURCE).status).toBe('idle');
  });
});
