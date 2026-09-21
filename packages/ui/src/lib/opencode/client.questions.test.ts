import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { QuestionRequest } from '@/types/question';

type QuestionListResult = {
  data?: unknown[];
  error?: unknown;
  request?: Request;
  response?: Response;
};

const makeQuestion = (id: string, overrides?: Partial<QuestionRequest>): QuestionRequest => ({
  id,
  sessionID: `ses_${id}`,
  questions: [
    {
      question: `${id}: proceed with the plan?`,
      header: 'Build',
      options: [{ label: 'Yes', description: 'Proceed' }],
    },
  ],
  ...overrides,
});

const makeListResult = (items: unknown[]): QuestionListResult => ({
  data: items,
  error: undefined,
  request: new Request('http://test/'),
  response: new Response(null, { status: 200 }),
});

const makeListError = (status: number, message: string): QuestionListResult => ({
  data: undefined,
  error: new Error(message),
  request: new Request('http://test/'),
  response: new Response(null, { status }),
});

const questionListArgs: Array<{ directory?: string } | undefined> = [];
const questionListResults: QuestionListResult[] = [];

const questionListMock = mock((args?: { directory?: string }) => {
  questionListArgs.push(args);
  const result = questionListResults.shift() ?? makeListResult([]);
  return Promise.resolve(result);
});

const createOpencodeClientMock = mock(() => ({
  question: {
    list: questionListMock,
  },
}));

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: (path: string) => path,
  })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => 'test-runtime'),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify([]), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test-questions=${Date.now()}`);

beforeEach(() => {
  questionListArgs.length = 0;
  questionListResults.length = 0;
});

describe('opencodeClient.listPendingQuestions', () => {
  test('merges unscoped + per-directory results with id-dedupe, first occurrence wins', async () => {
    const globalQuestion = makeQuestion('q1');
    const duplicateQuestion = makeQuestion('q1', { sessionID: 'ses_dup' });
    const scopedQuestion = makeQuestion('q2');
    const otherQuestion = makeQuestion('q3');

    questionListResults.push(
      makeListResult([globalQuestion]),
      makeListResult([duplicateQuestion, scopedQuestion]),
      makeListResult([otherQuestion]),
      makeListResult([]),
    );

    const result = await opencodeClient.listPendingQuestions({
      directories: ['/repo', '  /repo  ', '/repo/', '/other', '   ', null, undefined, 'd:\\MyProject', 'D:/MyProject'],
    });

    expect(result).toEqual([globalQuestion, scopedQuestion, otherQuestion]);
    expect(questionListArgs).toEqual([
      undefined,
      { directory: '/repo' },
      { directory: '/other' },
      { directory: 'D:/MyProject' },
    ]);
  });

  test('rejects the whole call when question.list fails (no empty-success masquerade)', async () => {
    questionListResults.push(makeListError(500, 'boom'), makeListError(500, 'boom'));

    await expect(
      opencodeClient.listPendingQuestions({ directories: ['/repo'] }),
    ).rejects.toThrow('question.list failed');
  });

  test('ignores entries without a usable string id during the V1 merge', async () => {
    const valid = makeQuestion('q1');
    questionListResults.push(
      makeListResult([valid, null, { sessionID: 'ses_x' }, { id: 42 }, { id: '' }, 'not-an-object']),
      makeListResult([makeQuestion('q2')]),
    );

    const result = await opencodeClient.listPendingQuestions({ directories: ['/repo'] });

    expect(result).toEqual([valid, makeQuestion('q2')]);
  });

  test('returns an empty array when every list is empty (true empty success)', async () => {
    questionListResults.push(makeListResult([]), makeListResult([]));

    const result = await opencodeClient.listPendingQuestions({ directories: ['/repo'] });

    expect(result).toEqual([]);
    expect(questionListArgs).toEqual([undefined, { directory: '/repo' }]);
  });
});
