import { afterAll, expect, test } from 'bun:test';
import { createHighlighter } from 'shiki';
import { StreamdownCodeWorker } from './streamdownCodeWorker';
import type { StreamdownCodeRequest, StreamdownCodeResponse } from './streamdown-code-protocol';
import { MARKDOWN_SHIKI_THEME_DEFINITION } from './markdownShikiThemeDefinition';
import { packCodeTokens, unpackCodeTokens } from './streamdown-code-protocol';
import { sanitizeTemplateCallGrammar } from '@/lib/shiki/sanitizeTemplateCallGrammar';
import { bundledLanguages } from 'shiki';

const client = new StreamdownCodeWorker();
afterAll(() => client.dispose());

test('WASM worker transfers tokens matching source and theme', async () => {
  const code = '// Немає запису — 中文\nconst value: string = "Власник";';
  const result = await client.highlight(code, 'typescript', false);
  expect(result).not.toBeNull();
  expect(result?.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code);
  expect(structuredClone(result)).toEqual(result);
  expect(result).not.toHaveProperty('grammarState');
  expect(result?.tokens.flat().some((token) => token.color?.includes('--md-'))).toBe(true);
}, 15000);

// CoffeeScript has no Highlights lexer, so this covers the Oniguruma path.
test('incremental worker matches a full WASM pass through appends and edits', async () => {
  const grammar = await bundledLanguages.coffee();
  const native = await createHighlighter({ themes: [MARKDOWN_SHIKI_THEME_DEFINITION], langs: grammar.default.map(sanitizeTemplateCallGrammar) });
  for (const source of ['one = "中', 'one = "中文"\ntwo = 2', 'other = 3', 'a = 1\r\nb = 2']) {
    const result = await client.highlight(source, 'coffee', true);
    const expected = unpackCodeTokens(source, packCodeTokens(native.codeToTokensBase(source, { lang: 'coffee', theme: MARKDOWN_SHIKI_THEME_DEFINITION })));
    expect(result).toEqual(expected);
  }
  native.dispose();
}, 15000);

test('completed results retain identity on remount while recent streaming results can settle', async () => {
  const code = 'const cached = "重用";';
  const result = await client.highlight(code, 'coffee', false);
  expect(result).not.toBeNull();
  expect(client.cached(code, 'coffee')).toBe(result!);
  expect(await client.highlight(code, 'coffee', false)).toBe(result!);
  const prefix = 'let transient =';
  const transient = await client.highlight(prefix, 'coffee', true);
  expect(await client.highlight(prefix, 'coffee', false)).toBe(transient!);
  for (let index = 0; index < 70; index++) await client.highlight(`completed ${index}`, 'coffee', false);
  for (let index = 0; index < 6; index++) await client.highlight(`streaming ${index}`, 'coffee', true);
  expect(client.cached(code, 'coffee')).toBe(result!);
  expect(client.cached('streaming 0', 'coffee', true)).toBeUndefined();
});

test('stream appends reuse completed token rows and return the correct changed tail', async () => {
  const owner = new StreamdownCodeWorker();
  try {
    const first = await owner.highlight('/* open\n still open', 'coffee', true);
    const next = await owner.highlight('/* open\n still open */\nconst x = 1;', 'coffee', true);
    expect(next?.tokens[0]).toBe(first?.tokens[0]);
    expect(next?.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe('/* open\n still open */\nconst x = 1;');
    const edited = await owner.highlight('/* open\n closed */\nconst y = 2;', 'coffee', true);
    expect(edited?.tokens[0]).toBe(first?.tokens[0]);
    expect(edited?.tokens.map((line) => line.map((token) => token.content).join('')).join('\n'))
      .toBe('/* open\n closed */\nconst y = 2;');
  } finally { owner.dispose(); }
});

test('completed work coalesces and remains cached after recent streaming entries expire', async () => {
  const owner = new StreamdownCodeWorker();
  try {
    const code = 'const settled = 1;';
    const streaming = owner.highlight(code, 'coffee', true);
    const completed = owner.highlight(code, 'coffee', false);
    expect(owner.highlight(code, 'coffee', false)).toBe(completed);
    await streaming;
    const result = await completed;
    expect(result).not.toBeNull();
    for (let i = 0; i < 5; i++) await owner.highlight(`const other${i} = 2;`, 'coffee', true);
    expect(owner.cached(code, 'coffee', true)).toBe(result!);
  } finally { owner.dispose(); }
});

test('the real worker sends only requested suffix rows in transferable range buffers', async () => {
  const worker = new Worker(new URL('./streamdown-code.worker.ts', import.meta.url), { type: 'module' });
  try {
    const line = 'const value = "😀 中文";\n';
    const code = line.repeat(100) + 'const tail = 2;';
    const response = await new Promise<StreamdownCodeResponse>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<StreamdownCodeResponse>) => resolve(event.data);
      worker.onerror = reject;
      worker.postMessage({ id: 1, code, language: 'typescript', fromLine: 100 } satisfies StreamdownCodeRequest);
    });
    if ('error' in response) throw new Error('Highlight failed');
    expect(response.result.lines).toHaveLength(2);
    expect(response.result.spans.byteLength).toBeLessThan(256);
    expect(unpackCodeTokens(code, response.result).tokens[0].map((token) => token.content).join('')).toBe('const tail = 2;');
  } finally { worker.terminate(); }
});

test('disposed worker settles callers without reusing its lifecycle', async () => {
  const owner = new StreamdownCodeWorker();
  const pending = owner.highlight('const value = 1;', 'coffee', false);
  owner.dispose();
  expect(await pending).toBeNull();
  expect(await owner.highlight('next', 'text', false)).toBeNull();
});

test('one hung job terminates its worker, is not retried, and cannot poison queued work', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const messages: StreamdownCodeRequest[] = [];
  let created = 0;
  let terminated = 0;
  class WorkerBoundary {
    onmessage: ((event: MessageEvent<StreamdownCodeResponse>) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    private answers = ++created > 1;
    postMessage(request: StreamdownCodeRequest) {
      messages.push(request);
      if (this.answers) queueMicrotask(() => this.onmessage?.(new MessageEvent('message', {
        data: { id: request.id, result: packCodeTokens([[{ content: request.code, offset: 0 }]]) },
      })));
    }
    terminate() { terminated++; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerBoundary });
  const owner = new StreamdownCodeWorker();
  try {
    const first = owner.highlight('hung source', 'coffee', false);
    const same = owner.highlight('hung source', 'coffee', false);
    expect(first).toBe(same);
    const next = owner.highlight('healthy source', 'coffee', false);
    expect(await first).toBeNull();
    expect((await next)?.tokens[0]?.[0]?.content).toBe('healthy source');
    expect(terminated).toBe(1);
    expect(created).toBe(2);
    expect(messages).toHaveLength(3);
    expect(await owner.highlight('hung source', 'coffee', false)).toBeNull();
    expect(messages).toHaveLength(3);
  } finally {
    owner.dispose();
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor);
  }
}, 10000);

test('unsupported worker environments fail closed for Shiki languages; Highlights still runs inline', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
  const owner = new StreamdownCodeWorker();
  try {
    expect(await owner.highlight('value = 1', 'coffee', false)).toBeNull();
    expect((await owner.highlight('const value = 1;', 'typescript', false))?.tokens[0][0].content).toBe('const ');
  }
  finally {
    owner.dispose();
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor);
  }
});

test('late responses from a terminated worker cannot settle a replacement request', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const instances: WorkerBoundary[] = [];
  class WorkerBoundary {
    onmessage: ((event: MessageEvent<StreamdownCodeResponse>) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    request: StreamdownCodeRequest | undefined;
    constructor() { instances.push(this); }
    postMessage(request: StreamdownCodeRequest) { this.request = request; }
    terminate() {}
    answer(content: string) {
      if (!this.request) throw new Error('Worker has no request');
      this.onmessage?.(new MessageEvent('message', { data: { id: this.request.id, result: packCodeTokens([[{ content, offset: 0 }]]) } }));
    }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerBoundary });
  const owner = new StreamdownCodeWorker();
  try {
    const first = owner.highlight('first', 'coffee', false);
    const second = owner.highlight('second', 'coffee', false);
    while (!instances[0]?.request) await Promise.resolve();
    instances[0].onerror?.();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    const retry = owner.highlight('second', 'coffee', false);
    while (!instances[1]?.request) await Promise.resolve();
    instances[0].answer('stale');
    instances[1].answer('second');
    expect((await retry)?.tokens[0]?.[0]?.content).toBe('second');
  } finally {
    owner.dispose();
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor);
  }
});

test('dispatch preserves large pending requests and disposing releases every caller', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  class WorkerBoundary {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    postMessage(request: StreamdownCodeRequest) { messages.push(request); }
    terminate() {}
  }
  const messages: StreamdownCodeRequest[] = [];
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerBoundary });
  const owner = new StreamdownCodeWorker();
  try {
    const first = owner.highlight('active', 'coffee', false);
    const queued = owner.highlight('q'.repeat(1_000_000), 'coffee', false);
    const next = owner.highlight('next', 'coffee', false);
    while (messages.length < 3) await Promise.resolve();
    owner.dispose();
    expect(await first).toBeNull();
    expect(await queued).toBeNull();
    expect(await next).toBeNull();
  } finally {
    owner.dispose();
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor);
  }
});

test('VS Code owns blob worker URLs and revokes them when its owner ends', async () => {
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  let fetched = false;
  class WorkerBoundary {
    onmessage: ((event: MessageEvent<StreamdownCodeResponse>) => void) | null = null;
    onerror = null;
    onmessageerror = null;
    constructor(url: string) { expect(url).toBe('blob:streamdown-worker-test'); }
    postMessage(request: StreamdownCodeRequest) {
      queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: { id: request.id, result: packCodeTokens([[{ content: request.code, offset: 0 }]]) } })));
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerBoundary });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __VSCODE_CONFIG__: {} } });
  globalThis.fetch = async (_input, init) => { fetched = true; expect(init?.signal).toBeInstanceOf(AbortSignal); return new Response('worker module'); };
  URL.createObjectURL = () => 'blob:streamdown-worker-test';
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  const owner = new StreamdownCodeWorker();
  try {
    expect((await owner.highlight('const value = 1;', 'coffee', false))?.tokens[0]?.[0]?.content).toBe('const value = 1;');
    expect(fetched).toBe(true);
    owner.dispose();
    expect(revoked).toEqual(['blob:streamdown-worker-test']);
  } finally {
    owner.dispose(); globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor);
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('Highlights languages are ready on the first synchronous lookup once loaded', async () => {
  const owner = new StreamdownCodeWorker();
  try {
    await owner.highlight('warm', 'typescript', false);
    const code = 'const first = "paint";';
    const result = owner.cached(code, 'typescript');
    expect(result?.tokens.flat().map((token) => token.content).join('')).toBe(code);
    expect(result?.tokens[0][0].color).toBe('var(--md-token-storageModifier)');
    expect(owner.cached(code, 'typescript')).toBe(result!);
  } finally { owner.dispose(); }
});

test('streaming on the main thread keeps unchanged rows by identity', async () => {
  const owner = new StreamdownCodeWorker();
  try {
    await owner.highlight('warm', 'typescript', false);
    const first = owner.cached('const a = 1;\nconst b', 'typescript', true);
    const next = owner.cached('const a = 1;\nconst b = 2;\nconst c', 'typescript', true);
    expect(next?.tokens[0]).toBe(first?.tokens[0]);
    expect(next?.tokens[1]).not.toBe(first?.tokens[1]);
    const comment = owner.cached('/* const a = 1;\nconst b = 2;', 'typescript', true);
    expect(comment?.tokens[0]).not.toBe(next?.tokens[0]);
  } finally { owner.dispose(); }
});
