import { describe, expect, test } from 'bun:test';

import { runChunkedTTSPlayback, splitSentencesForTTS } from './useServerTTS';

/** Minimum characters a standalone chunk must have; shorter fragments merge into neighbors. */
const MIN_CHUNK_LENGTH = 40;
/** Texts at or below this length skip splitting entirely (single fast-path request). */
const FAST_PATH_MAX_LENGTH = 200;

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

const longPlainSentences = [
  'The first sentence is long enough to exceed the forty character threshold.',
  'The second sentence describes the sentence-by-sentence speech pipeline.',
  'The third sentence verifies that chunk ordering stays stable end to end.',
  'The fourth sentence closes the sample and stays above the fragment floor.',
].join(' ');

describe('splitSentencesForTTS', () => {
  test('returns the trimmed text as a single chunk when it fits the fast path', () => {
    const text = 'Short text. With two sentences. Fast path.';
    expect(text.length).toBeLessThanOrEqual(FAST_PATH_MAX_LENGTH);
    expect(splitSentencesForTTS(text)).toEqual([text.trim()]);
  });

  test('returns an empty array for blank input', () => {
    expect(splitSentencesForTTS('')).toEqual([]);
    expect(splitSentencesForTTS('   \n\t  ')).toEqual([]);
  });

  test('splits plain long text into sentence chunks in order without losing text', () => {
    const chunks = splitSentencesForTTS(longPlainSentences);

    expect(chunks.length).toBe(4);
    expect(chunks).toEqual([
      'The first sentence is long enough to exceed the forty character threshold.',
      'The second sentence describes the sentence-by-sentence speech pipeline.',
      'The third sentence verifies that chunk ordering stays stable end to end.',
      'The fourth sentence closes the sample and stays above the fragment floor.',
    ]);
  });

  test('keeps sentence order and full text across chunks', () => {
    const chunks = splitSentencesForTTS(longPlainSentences);
    expect(collapseWhitespace(chunks.join(' '))).toBe(collapseWhitespace(longPlainSentences));
  });

  test('merges abbreviation fragments instead of emitting tiny chunks', () => {
    const text = [
      'The list includes keyboards, monitors, mice и т.д. for the office setup.',
      'The second sentence describes the specifications of every listed device.',
      'Next comes a section about routers, switches, cables и т.п. and their roles.',
      'Напр. such a paragraph splits into sentences without microscopic fragments.',
      'The final sentence completes the inventory and carries enough characters.',
    ].join(' ');
    expect(text.length).toBeGreaterThan(FAST_PATH_MAX_LENGTH);

    const chunks = splitSentencesForTTS(text);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(MIN_CHUNK_LENGTH);
    }
    expect(collapseWhitespace(chunks.join(' '))).toBe(collapseWhitespace(text));
  });

  test('does not split inside direct speech with quotes', () => {
    const text = [
      'He said: «Пойдём дальше. Тут ещё много работы.» And they went to work.',
      'A long narration follows about how they kept working all day without rest.',
      'Then night fell and morning arrived unnoticed by everyone in this story.',
      'The story ends when the sun sets behind the horizon and colors the sky.',
    ].join(' ');
    expect(text.length).toBeGreaterThan(FAST_PATH_MAX_LENGTH);

    const chunks = splitSentencesForTTS(text);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(MIN_CHUNK_LENGTH);
    }
    expect(collapseWhitespace(chunks.join(' '))).toBe(collapseWhitespace(text));
  });

  test('handles Russian sentences inside English text', () => {
    const text = [
      'Open the command line and run npm install to install the project dependencies.',
      'Потом проверь результаты тестов и запусти полную сборку проекта ещё раз.',
      'Another English sentence follows here to verify mixed language segmentation.',
      'Затем повтори прогон тестов чтобы убедиться что всё работает как надо.',
    ].join(' ');
    expect(text.length).toBeGreaterThan(FAST_PATH_MAX_LENGTH);

    const chunks = splitSentencesForTTS(text);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(MIN_CHUNK_LENGTH);
    }
    expect(collapseWhitespace(chunks.join(' '))).toBe(collapseWhitespace(text));
  });

  test('returns a single chunk for punctuation-free text longer than the fast path', () => {
    const text = 'a'.repeat(FAST_PATH_MAX_LENGTH + 50);
    expect(splitSentencesForTTS(text)).toEqual([text]);
  });

  test('merges a short trailing fragment into the previous chunk', () => {
    const text = [
      'The first sentence is long enough to exceed the forty character threshold.',
      'The second sentence describes the sentence-by-sentence speech pipeline.',
      'The third sentence verifies that chunk ordering stays stable end to end.',
      'That is all.',
    ].join(' ');
    expect(text.length).toBeGreaterThan(FAST_PATH_MAX_LENGTH);

    const chunks = splitSentencesForTTS(text);

    expect(chunks.length).toBe(3);
    expect(chunks[2]).toBe('The third sentence verifies that chunk ordering stays stable end to end. That is all.');
  });

  test('falls back to regex splitting when Intl.Segmenter is unavailable', () => {
    const chunks = withoutIntlSegmenter(() => splitSentencesForTTS(longPlainSentences));

    expect(chunks.length).toBe(4);
    expect(collapseWhitespace(chunks.join(' '))).toBe(collapseWhitespace(longPlainSentences));
  });
});

interface FakeAudioBuffer {
  duration: number;
}

interface FakeSource {
  handler: (() => void) | null;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
};

function makeDeferred<T>(): Deferred<T> {
  let settle: { resolve: Deferred<T>['resolve']; reject: Deferred<T>['reject'] } | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The Promise executor runs synchronously, so `settle` is assigned before this returns.
  return {
    promise,
    resolve: (value) => settle?.resolve(value),
    reject: (reason) => settle?.reject(reason),
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function networkError(): Error {
  return new Error('network unreachable');
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function withoutIntlSegmenter<T>(fn: () => T): T {
  const descriptor = Reflect.getOwnPropertyDescriptor(globalThis.Intl, 'Segmenter');
  Object.defineProperty(globalThis.Intl, 'Segmenter', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(globalThis.Intl, 'Segmenter', {
      value: descriptor?.value,
      configurable: true,
      writable: true,
    });
  }
}

function createPlaybackHarness(chunks: readonly string[]) {
  const controller = new AbortController();
  const fetches = chunks.map(() => makeDeferred<FakeAudioBuffer>());
  const sources: FakeSource[] = [];
  let fetchCalls = 0;
  let firstScheduledCount = 0;
  let allEndedCount = 0;

  const runPromise = runChunkedTTSPlayback(chunks, {
    signal: controller.signal,
    fetchChunk: () => {
      const request = fetches[fetchCalls];
      fetchCalls += 1;
      return request.promise;
    },
    scheduleChunk: (buffer, startAt) => {
      const source: FakeSource = { handler: null };
      return { source, endsAt: startAt + buffer.duration };
    },
    currentTime: () => 100,
    attachOnEnded: (source, handler) => {
      source.handler = handler;
    },
    onScheduled: (source) => {
      sources.push(source);
    },
    onFirstScheduled: () => {
      firstScheduledCount += 1;
    },
    onAllEnded: () => {
      allEndedCount += 1;
    },
  });

  return {
    controller,
    fetches,
    sources,
    get firstScheduledCount() {
      return firstScheduledCount;
    },
    get allEndedCount() {
      return allEndedCount;
    },
    runPromise,
  };
}

describe('runChunkedTTSPlayback', () => {
  test('completes playback when every remaining fetch fails after the last scheduled chunk ends', async () => {
    const harness = createPlaybackHarness(['chunk one', 'chunk two', 'chunk three']);

    await tick();
    harness.fetches[0].resolve({ duration: 5 });
    await tick();
    expect(harness.sources.length).toBe(1);

    // The only scheduled chunk finishes while later fetches are still pending.
    harness.sources[0].handler?.();
    await tick();

    harness.fetches[1].reject(networkError());
    harness.fetches[2].reject(networkError());
    const outcome = await harness.runPromise;

    expect(outcome).toEqual({ status: 'completed', scheduled: 1 });
    expect(harness.allEndedCount).toBe(1);
  });

  test('reports completion once all scheduled chunks have ended', async () => {
    const harness = createPlaybackHarness(['chunk one', 'chunk two']);

    await tick();
    harness.fetches[0].resolve({ duration: 5 });
    await tick();
    harness.fetches[1].resolve({ duration: 4 });
    const outcome = await harness.runPromise;

    expect(outcome).toEqual({ status: 'completed', scheduled: 2 });
    expect(harness.firstScheduledCount).toBe(1);

    harness.sources[0].handler?.();
    expect(harness.allEndedCount).toBe(0);
    harness.sources[1].handler?.();
    expect(harness.allEndedCount).toBe(1);
  });

  test('reports an aborted outcome without completing playback', async () => {
    const harness = createPlaybackHarness(['chunk one', 'chunk two']);

    await tick();
    harness.fetches[0].resolve({ duration: 5 });
    await tick();
    harness.controller.abort();
    harness.fetches[1].reject(abortError());

    const outcome = await harness.runPromise;
    expect(outcome).toEqual({ status: 'aborted', scheduled: 1 });

    harness.sources[0].handler?.();
    expect(harness.allEndedCount).toBe(0);
  });

  test('reports all-failed when every chunk fetch rejects without scheduling audio', async () => {
    const harness = createPlaybackHarness(['chunk one', 'chunk two']);

    await tick();
    harness.fetches[0].reject(networkError());
    harness.fetches[1].reject(networkError());

    const outcome = await harness.runPromise;
    expect(outcome).toEqual({ status: 'all-failed' });
    expect(harness.firstScheduledCount).toBe(0);
    expect(harness.allEndedCount).toBe(0);
  });
});
