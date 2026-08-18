import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WalkthroughResult, WalkthroughSource } from '@/lib/walkthrough/types';

const SOURCE: WalkthroughSource = { kind: 'working-tree', scope: 'all' };

const result = (overrides: Partial<WalkthroughResult> = {}): WalkthroughResult => ({
  source: SOURCE,
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

// Plain closures rather than mock helpers: bun's `mock()` is not typed with
// vitest's `mockResolvedValue` family, and the repo already prefers this style.
let readResult: WalkthroughResult = result();
let generateCalls = 0;
let releaseGeneration: (() => void) | undefined;
let lastReadModel: string | undefined;
let lastGenerateModel: string | undefined;
let lastReadLanguage: string | undefined;
let lastGenerateLanguage: string | undefined;

mock.module('@/lib/walkthrough/api', () => ({
  fetchWalkthrough: async (
    _directory: string,
    _source: WalkthroughSource,
    options: { model?: string; language?: string } = {},
  ) => {
    lastReadModel = options.model;
    lastReadLanguage = options.language;
    return readResult;
  },
  generateWalkthrough: async (
    _directory: string,
    _source: WalkthroughSource,
    options: { model?: string; language?: string } = {},
  ) => {
    generateCalls += 1;
    lastGenerateModel = options.model;
    lastGenerateLanguage = options.language;
    return new Promise<WalkthroughResult>((resolve) => {
      releaseGeneration = () => resolve(finished);
    });
  },
  cancelWalkthroughGeneration: async () => {},
  // The store imports this for its progress poller. Leaving it out of the mock
  // makes the whole module fail to load, which reads as an unrelated crash.
  fetchWalkthroughStage: async () => null,
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => 'local' }));

const { useWalkthroughStore } = await import('./useWalkthroughStore');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useWalkthroughStore — reattaching to a running generation', () => {
  beforeEach(() => {
    useWalkthroughStore.getState().reset();
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
    const branch: WalkthroughSource = { kind: 'branch', baseRef: 'main', headRef: 'feature' };
    useWalkthroughStore.getState().selectModel('/repo', SOURCE, 'anthropic/claude-haiku-4-5');

    expect(useWalkthroughStore.getState().getSelectedModel("/repo", branch)).toBe(undefined);
    expect(useWalkthroughStore.getState().getSelectedModel('/repo', SOURCE))
      .toBe('anthropic/claude-haiku-4-5');
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
    const branch: WalkthroughSource = { kind: 'branch', baseRef: 'main', headRef: 'feature' };
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
