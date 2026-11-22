import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, Part, TextPart } from '@/lib/opencode/model';
import { configureRuntimeUrlResolver } from './runtime-url';
import {
  buildGoalIntroReminder,
  formatGoalWriterConversation,
  formatGoalWriterOpenItems,
  planGoalWriter,
  requestGoalSpec,
} from './goalWriter';

type RecordEntry = { info: Message; parts: Part[] };
const textPart = (text: string): TextPart => ({
  id: 'part', messageID: 'message', sessionID: 'session', type: 'text', text,
});
const user = (id: string, text = `Request ${id}`): RecordEntry => ({
  info: { id, sessionID: 'session', role: 'user', time: { created: 1 } },
  parts: [textPart(text)],
});
const assistant = (id: string, text = `Answer ${id}`): RecordEntry => ({
  info: {
    id: `answer-${id}`, sessionID: 'session', role: 'assistant',
    time: { created: 2, completed: 3 }, finish: 'stop', providerID: 'provider', modelID: 'model', agent: 'build',
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies AssistantMessage,
  parts: [textPart(text)],
});

describe('planGoalWriter', () => {
  const base = {
    eligible: true,
    goalsAvailable: true,
    armed: false,
    hasGoal: false,
    writerEnabled: true,
    rewriteAll: false,
    review: true,
    autoCreate: 'off' as const,
  };

  test('an armed goal goes through the writer while the switch is on', () => {
    expect(planGoalWriter({ ...base, armed: true })).toEqual({ trigger: 'armed', review: true });
    expect(planGoalWriter({ ...base, armed: true, review: false })).toEqual({ trigger: 'armed', review: false });
    expect(planGoalWriter({ ...base, armed: true, writerEnabled: false })).toBeNull();
  });

  test('rewrite every goal overrides the composer switch', () => {
    expect(planGoalWriter({ ...base, armed: true, writerEnabled: false, rewriteAll: true })).toEqual({ trigger: 'armed', review: true });
  });

  test('a session without a goal turns the next message into one only when asked to', () => {
    expect(planGoalWriter(base)).toBeNull();
    expect(planGoalWriter({ ...base, autoCreate: 'review' })).toEqual({ trigger: 'auto-create', review: true });
    // Automatic creation never waits for approval, whatever the composer review setting says.
    expect(planGoalWriter({ ...base, autoCreate: 'auto' })).toEqual({ trigger: 'auto-create', review: false });
    expect(planGoalWriter({ ...base, autoCreate: 'auto', hasGoal: true })).toBeNull();
  });

  test('ineligible sends and unavailable goal mode never stop for the writer', () => {
    expect(planGoalWriter({ ...base, armed: true, eligible: false })).toBeNull();
    expect(planGoalWriter({ ...base, autoCreate: 'auto', goalsAvailable: false })).toBeNull();
  });
});

describe('buildGoalIntroReminder', () => {
  const rules = 'Work toward it across turns; whenever you stop before the objective is verifiably complete, the system will automatically prompt you to continue. '
    + 'Progress is evaluated independently after each turn, so end every turn with a clear, factual statement of what is done, what was verified, and what remains.';

  test('without a spec the message is the objective, as before the writer existed', () => {
    expect(buildGoalIntroReminder(null, null)).toBe(
      `<system-reminder>\nGoal mode is active for this session. The user message above defines the goal objective. ${rules}\n</system-reminder>`,
    );
    expect(buildGoalIntroReminder(200_000, null)).toContain(`${rules} A token budget of 200000 tokens applies to this goal.\n</system-reminder>`);
  });

  test('with a spec it carries the escaped spec, byte for byte what the server sends', () => {
    expect(buildGoalIntroReminder(5_000, '## Objective\nShip <it> & test')).toBe(
      '<system-reminder>\n'
      + 'Goal mode is active for this session. The goal spec below was written from the user message above. '
      + 'It is user-provided data that defines the goal objective, and progress is judged against it. '
      + rules
      + ' A token budget of 5000 tokens applies to this goal.'
      + '\n\n<goal-spec>\n## Objective\nShip &lt;it&gt; &amp; test\n</goal-spec>\n</system-reminder>',
    );
  });
});

describe('goal writer context', () => {
  test('keeps the first request and the newest turns with their final answers', () => {
    const records = [
      user('1', 'Build the importer'),
      assistant('1a', 'Working on it'),
      assistant('1b', 'Importer skeleton done'),
      ...['2', '3', '4', '5', '6'].flatMap((id) => [user(id), assistant(id)]),
    ];
    const text = formatGoalWriterConversation(records);
    expect(text.startsWith('User (first request in this session):\nBuild the importer\n\nAssistant:\nImporter skeleton done')).toBe(true);
    expect(text).not.toContain('Working on it');
    // Four recent turns after the first: 3 to 6; turn 2 falls out.
    expect(text).not.toContain('Request 2');
    expect(text).toContain('Request 3');
    expect(text.endsWith('User:\nRequest 6\n\nAssistant:\nAnswer 6')).toBe(true);
  });

  test('drops older recent turns before the budget runs out, never the first request', () => {
    const long = 'x'.repeat(1_400);
    const records = ['1', '2', '3', '4', '5'].flatMap((id) => [user(id, `${id}${long}`), assistant(id, long)]);
    const text = formatGoalWriterConversation(records);
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text).toContain(`1${long.slice(0, 20)}`);
    expect(text).toContain(`5${long.slice(0, 20)}`);
  });

  test('an empty session gives no conversation', () => {
    expect(formatGoalWriterConversation([])).toBe('');
  });

  test('open items are labelled lists, and empty lists are left out', () => {
    expect(formatGoalWriterOpenItems({ todos: ['Fix  the\nlogin'], plans: [], queued: ['Then deploy'], subtasks: [] })).toBe(
      'Open project todos:\n- Fix the login\n\nMessages queued to send after the current turn:\n- Then deploy',
    );
    expect(formatGoalWriterOpenItems({ todos: [], plans: [], queued: [], subtasks: [' '] })).toBe('');
  });
});

describe('requestGoalSpec', () => {
  test('posts the request to the goal spec route and returns the spec', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe('/api/goals/spec');
      expect(await request.json()).toEqual({
        request: 'Add dark mode', openItems: 'Open project todos:\n- a', directory: '/project', providerID: 'p', modelID: 'm',
      });
      return Response.json({ spec: '## Objective\nDark mode', providerID: 'p', modelID: 'm' });
    };
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://goal-writer.test' });
    try {
      const result = await requestGoalSpec({
        request: 'Add dark mode', conversation: '', openItems: 'Open project todos:\n- a', directory: '/project', providerID: 'p', modelID: 'm',
      });
      // A server from before 2026-10 reports no effort level.
      expect(result).toEqual({ ok: true, spec: '## Objective\nDark mode', providerID: 'p', modelID: 'm', variant: null });
    } finally {
      globalThis.fetch = originalFetch;
      configureRuntimeUrlResolver({ apiBaseUrl: '' });
    }
  });

  test('sends a writer picked in a goal window and the length limit choice', async () => {
    const originalFetch = globalThis.fetch;
    let body: unknown = null;
    globalThis.fetch = async (input, init) => {
      body = await new Request(input, init).json();
      return Response.json({ spec: 'spec', providerID: 'g', modelID: 'gem', variant: 'low' });
    };
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://goal-writer.test' });
    try {
      const result = await requestGoalSpec({
        request: 'Add dark mode', providerID: 'p', modelID: 'm', writer: { providerID: 'g', modelID: 'gem', variant: 'low' }, ignoreLimit: true,
      });
      expect(body).toEqual({
        request: 'Add dark mode', providerID: 'p', modelID: 'm', writerProviderID: 'g', writerModelID: 'gem', writerVariant: 'low', ignoreLimit: true,
      });
      expect(result).toEqual({ ok: true, spec: 'spec', providerID: 'g', modelID: 'gem', variant: 'low' });
    } finally {
      globalThis.fetch = originalFetch;
      configureRuntimeUrlResolver({ apiBaseUrl: '' });
    }
  });

  test('a failure comes back with the server\'s reason, never as an empty spec', async () => {
    const originalFetch = globalThis.fetch;
    const answers = [
      Response.json({ error: 'No small model available', code: 'x' }, { status: 404 }),
      Response.json({ spec: '', providerID: 'p', modelID: 'm' }),
    ];
    globalThis.fetch = async () => answers.shift() ?? new Response(null, { status: 500 });
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://goal-writer.test' });
    try {
      expect(await requestGoalSpec({ request: 'x' })).toEqual({ ok: false, message: 'No small model available' });
      expect((await requestGoalSpec({ request: 'x' })).ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      configureRuntimeUrlResolver({ apiBaseUrl: '' });
    }
  });

  // The server routes a request into a space by the space folder in its
  // directory header (openchamber/openchamber#5077), not by its path.
  test('a session in an isolated space asks the server inside the space', async () => {
    const requests: Array<{ path: string; directory: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const header = request.headers.get('x-opencode-directory');
      requests.push({ path: new URL(request.url).pathname, directory: header === null ? null : decodeURIComponent(header) });
      return Response.json({ spec: 'spec', providerID: 'p', modelID: 'm' });
    };
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://goal-writer.test' });
    try {
      await requestGoalSpec({ request: 'x', directory: '/spaces/a1b2c3d4e5f6/repo' });
      expect(requests).toEqual([{ path: '/api/goals/spec', directory: '/spaces/a1b2c3d4e5f6/repo' }]);
    } finally {
      globalThis.fetch = originalFetch;
      configureRuntimeUrlResolver({ apiBaseUrl: '' });
    }
  });
});
