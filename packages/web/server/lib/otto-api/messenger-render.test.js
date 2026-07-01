import { describe, it, expect } from 'vitest';
import {
  renderPartForMessenger,
  renderToolPart,
  renderQuestionForMessenger,
  renderTodoListForMessenger,
  renderPermissionContext,
  renderUserShellResult,
  isUserShellMarkerText,
  USER_SHELL_MARKER,
  deriveThreadNameFromSessionTitle,
  extractLastAssistantTokens,
  computeTurnTokens,
  stripAnsi,
} from './messenger-render.js';

const toolPart = (overrides = {}) => ({
  type: 'tool',
  id: 'prt_1',
  tool: 'bash',
  state: {
    status: 'completed',
    input: { command: 'ls -la' },
    output: 'total 0\ndrwxr-xr-x  2 user staff   64 file',
    ...(overrides.state ?? {}),
  },
  ...overrides,
});

describe('renderPartForMessenger — verbosity gating', () => {
  it('quiet: returns only assistant text, hides reasoning + tools', () => {
    expect(renderPartForMessenger({ type: 'text', text: 'hello' }, 'quiet')).toBe('hello');
    expect(renderPartForMessenger({ type: 'reasoning', text: 'thinking…' }, 'quiet')).toBeNull();
    expect(renderPartForMessenger(toolPart(), 'quiet')).toBeNull();
  });

  it('normal: tool one-liner only — name + summary, no payloads', () => {
    expect(renderPartForMessenger({ type: 'text', text: 'hi' }, 'normal')).toBe('hi');

    const line = renderPartForMessenger(toolPart(), 'normal');
    expect(line).toContain('**bash**');
    expect(line).toContain('ls -la');        // compact command summary stays
    expect(line).not.toContain('total 0');   // output payload hidden at normal
    expect(line).not.toContain('```');       // no detail blocks at normal
    expect(line.split('\n')).toHaveLength(1); // single line per tool
  });

  it('normal: reasoning renders as a bare process marker without the thoughts', () => {
    const reasoning = renderPartForMessenger({ type: 'reasoning', text: 'deep thoughts' }, 'normal');
    expect(reasoning).toBe('┣ _thinking…_');
    expect(reasoning).not.toContain('deep thoughts');
  });

  it('normal: tool errors stay visible on the one-liner', () => {
    const line = renderPartForMessenger(
      toolPart({ state: { status: 'error', input: { command: 'boom' }, error: 'exit 1' } }),
      'normal',
    );
    expect(line.startsWith('✗ ')).toBe(true);
    expect(line).toContain('exit 1');
  });

  it('verbose: bash shows the output in a block (single-line command stays on the summary)', () => {
    const line = renderPartForMessenger(toolPart(), 'verbose');
    expect(line).toContain('⬦ **bash**');
    expect(line).toContain('`ls -la`');      // summary keeps the command
    expect(line).not.toContain('```bash');   // no redundant fence for one-liners
    expect(line).toContain('total 0');
    expect(line).not.toContain('"command"'); // no raw JSON dump for bash
  });

  it('verbose: multi-line bash commands get their own bash fence', () => {
    const line = renderPartForMessenger(
      toolPart({ state: { status: 'completed', input: { command: 'set -e\nnpm test' }, output: 'ok' } }),
      'verbose',
    );
    expect(line).toContain('```bash\nset -e\nnpm test\n```');
  });

  it('verbose: edits render as a real diff block', () => {
    const line = renderPartForMessenger(
      {
        type: 'tool',
        tool: 'edit',
        state: {
          status: 'completed',
          input: { filePath: 'src/auth.ts', oldString: 'const a = 1;', newString: 'const a = 2;\nconst b = 3;' },
        },
      },
      'verbose',
    );
    expect(line).toContain('◼︎ **edit**');
    expect(line).toContain('```diff');
    expect(line).toContain('- const a = 1;');
    expect(line).toContain('+ const a = 2;');
    expect(line).toContain('+ const b = 3;');
  });

  it('verbose: unknown tools fall back to pretty JSON input + output preview', () => {
    const line = renderPartForMessenger(
      {
        type: 'tool',
        tool: 'mcp_custom',
        state: { status: 'completed', input: { query: 'x' }, output: 'result-payload' },
      },
      'verbose',
    );
    expect(line).toContain('```json');
    expect(line).toContain('"query": "x"');
    expect(line).toContain('result-payload');
  });

  it('verbose: error tools close with a fenced error block', () => {
    const line = renderPartForMessenger(
      toolPart({ state: { status: 'error', input: { command: 'boom' }, error: 'exit 1' } }),
      'verbose',
    );
    expect(line.startsWith('✗ **bash**')).toBe(true);
    expect(line).toContain('⚠ **error**');
    expect(line).toContain('exit 1');
  });

  it('verbose: reasoning shows the thoughts as quoted text', () => {
    const out = renderPartForMessenger({ type: 'reasoning', text: 'deep thoughts\nsecond line' }, 'verbose');
    expect(out.startsWith('┣ **thinking**')).toBe(true);
    expect(out).toContain('> deep thoughts');
    expect(out).toContain('> second line');
  });

  it('defaults to normal when verbosity is omitted or invalid', () => {
    const line = renderPartForMessenger(toolPart(), 'bogus');
    expect(line).not.toContain('```'); // normal semantics: no detail blocks
  });
});

describe('stripAnsi', () => {
  it('removes SGR colour codes (the eza/ls --color noise)', () => {
    const colored = '\u001B[1;33mrz.exe\u001B[0m \u001B[34m 8 вер  2017\u001B[0m';
    expect(stripAnsi(colored)).toBe('rz.exe  8 вер  2017');
  });

  it('removes orphaned SGR codes whose ESC byte was already dropped', () => {
    // The exact garbage shape from the reported issue, ESC already stripped.
    const orphaned = '.[1;33mr[31mw[90m-[0m[33mr[1;90m--[0m  [1;32m189k[0m';
    expect(stripAnsi(orphaned)).toBe('.rw-r--  189k');
  });

  it('removes OSC hyperlinks and cursor-control sequences', () => {
    const osc = '\u001B]8;;https://x\u0007link\u001B]8;;\u0007\u001B[2K done';
    expect(stripAnsi(osc)).toBe('link done');
  });

  it('leaves plain text and lone brackets untouched', () => {
    expect(stripAnsi('arr[1,2,3] = foo[bar]')).toBe('arr[1,2,3] = foo[bar]');
    expect(stripAnsi('')).toBe('');
    expect(stripAnsi(null)).toBe('');
  });
});

describe('renderToolPart — ANSI stripping in tool results', () => {
  it('verbose: strips ANSI colour codes from bash output before fencing', () => {
    const line = renderToolPart(
      toolPart({
        state: {
          status: 'completed',
          input: { command: 'eza -l' },
          output: '\u001B[1;33mrz.exe\u001B[0m\n\u001B[34m358k\u001B[0m unarc.dll',
        },
      }),
      'verbose',
    );
    expect(line).toContain('rz.exe');
    expect(line).toContain('unarc.dll');
    expect(line).not.toContain('[1;33m');
    expect(line).not.toContain('[0m');
    expect(line).not.toContain('\u001B');
  });

  it('normal: strips ANSI from the bash command summary one-liner', () => {
    const line = renderToolPart(
      toolPart({ state: { status: 'completed', input: { command: '\u001B[32meza\u001B[0m -l' }, output: 'x' } }),
      'normal',
    );
    expect(line).toContain('`eza -l`');
    expect(line).not.toContain('[32m');
  });

  it('renderPermissionContext strips ANSI from the previewed command', () => {
    const out = renderPermissionContext({
      permission: 'bash',
      metadata: { command: '\u001B[1mrm -rf build\u001B[0m' },
    });
    expect(out).toContain('rm -rf build');
    expect(out).not.toContain('[1m');
  });
});

describe('renderToolPart — code fence safety', () => {
  it('neutralises embedded code fences so the inline block cannot break early', () => {
    const line = renderToolPart(
      {
        tool: 'write',
        state: {
          status: 'completed',
          input: { filePath: 'a.md', content: '```js\ncode\n```' },
          output: 'ok',
        },
      },
      'verbose',
    );
    // The only real fences are the inline block's own; embedded ``` is replaced.
    expect(line).not.toContain('```js');
    expect(line).toContain("'''js");
  });
});

describe('deriveThreadNameFromSessionTitle', () => {
  it('returns the trimmed title for a plain thread', () => {
    expect(
      deriveThreadNameFromSessionTitle({ sessionTitle: '  Fix auth bug  ', currentName: 'fix the auth' }),
    ).toBe('Fix auth bug');
  });

  it('preserves the worktree prefix from the current name', () => {
    expect(
      deriveThreadNameFromSessionTitle({ sessionTitle: 'Refactor queue', currentName: '⬦ refactor queue old' }),
    ).toBe('⬦ Refactor queue');
  });

  it('preserves Fork: and Resume: prefixes', () => {
    expect(
      deriveThreadNameFromSessionTitle({ sessionTitle: 'Auth flow', currentName: 'Fork: old name' }),
    ).toBe('Fork: Auth flow');
    expect(
      deriveThreadNameFromSessionTitle({ sessionTitle: 'Auth flow', currentName: 'Resume: old name' }),
    ).toBe('Resume: Auth flow');
  });

  it('ignores OpenCode placeholder titles', () => {
    expect(
      deriveThreadNameFromSessionTitle({ sessionTitle: 'New session - 2026-06-11T13:00:00Z', currentName: 'x' }),
    ).toBeUndefined();
    expect(
      deriveThreadNameFromSessionTitle({ sessionTitle: 'new session -abc', currentName: 'x' }),
    ).toBeUndefined();
  });

  it('returns undefined when nothing changes or the title is empty', () => {
    expect(
      deriveThreadNameFromSessionTitle({ sessionTitle: 'Fix auth bug', currentName: 'Fix auth bug' }),
    ).toBeUndefined();
    expect(deriveThreadNameFromSessionTitle({ sessionTitle: '   ', currentName: 'x' })).toBeUndefined();
    expect(deriveThreadNameFromSessionTitle({ sessionTitle: null, currentName: 'x' })).toBeUndefined();
  });

  it('caps at 100 chars including a preserved prefix', () => {
    const long = 'x'.repeat(200);
    const withPrefix = deriveThreadNameFromSessionTitle({ sessionTitle: long, currentName: '⬦ seed' });
    expect(withPrefix).toHaveLength(100);
    expect(withPrefix.startsWith('⬦ ')).toBe(true);
    const plain = deriveThreadNameFromSessionTitle({ sessionTitle: long, currentName: 'seed' });
    expect(plain).toHaveLength(100);
  });
});

describe('computeTurnTokens', () => {
  it('prefers the tokens.total field when present', () => {
    expect(
      computeTurnTokens({ total: 8715, input: 304, output: 62, reasoning: 29, cache: { read: 8320, write: 0 } }),
    ).toBe(8715);
  });

  it('falls back to summing components when total is missing', () => {
    expect(computeTurnTokens({ input: 304, output: 62, reasoning: 29, cache: { read: 8320, write: 0 } })).toBe(8715);
  });

  it('returns 0 for missing or empty tokens', () => {
    expect(computeTurnTokens(null)).toBe(0);
    expect(computeTurnTokens(undefined)).toBe(0);
    expect(computeTurnTokens({})).toBe(0);
    expect(computeTurnTokens({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).toBe(0);
  });
});

describe('extractLastAssistantTokens', () => {
  const turn = (tokens) => ({ info: { role: 'assistant', tokens } });

  it('returns the LAST assistant turn tokens, not the cumulative session total', () => {
    // Real shape from GET /session/{id}/message: two turns where each
    // re-reads the cached context. Session-level tokens would sum to 17,274
    // — the true context of the last turn is 8,715.
    const messages = [
      { info: { role: 'user' } },
      turn({ total: 8559, input: 8437, output: 86, reasoning: 36, cache: { read: 0, write: 0 } }),
      { info: { role: 'user' } },
      turn({ total: 8715, input: 304, output: 62, reasoning: 29, cache: { read: 8320, write: 0 } }),
    ];
    expect(computeTurnTokens(extractLastAssistantTokens(messages))).toBe(8715);
  });

  it('skips trailing assistant messages without token data', () => {
    const messages = [
      turn({ total: 5000, input: 5000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      turn(undefined),
      { info: { role: 'assistant', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } },
    ];
    expect(computeTurnTokens(extractLastAssistantTokens(messages))).toBe(5000);
  });

  it('supports flat message shape without an info wrapper', () => {
    const messages = [{ role: 'assistant', tokens: { total: 1234 } }];
    expect(computeTurnTokens(extractLastAssistantTokens(messages))).toBe(1234);
  });

  it('returns null when there are no assistant turns with tokens', () => {
    expect(extractLastAssistantTokens([])).toBeNull();
    expect(extractLastAssistantTokens(null)).toBeNull();
    expect(extractLastAssistantTokens([{ info: { role: 'user' } }])).toBeNull();
  });
});

describe('renderQuestionForMessenger', () => {
  it('renders header, question text and numbered options', () => {
    const out = renderQuestionForMessenger(
      {
        question: 'Which database should the service use?',
        header: 'Database',
        options: [
          { label: 'Postgres', description: 'relational, battle-tested' },
          { label: 'SQLite', description: '' },
        ],
      },
      { index: 0, total: 1 },
    );
    expect(out).toContain('❓ **Database**');
    expect(out).toContain('Which database should the service use?');
    expect(out).toContain('`1.` Postgres — relational, battle-tested');
    expect(out).toContain('`2.` SQLite');
    expect(out).toContain('reply with your own answer');
  });

  it('adds a counter for multi-question requests and survives missing fields', () => {
    const out = renderQuestionForMessenger(
      { question: 'Second question?', header: '', options: [] },
      { index: 1, total: 2 },
    );
    expect(out).toContain('(2/2)');
    expect(out).toContain('Second question?');
    expect(renderQuestionForMessenger(null)).toBeNull();
    expect(renderQuestionForMessenger({ question: '', header: '', options: [] })).toBeNull();
  });
});

describe('renderTodoListForMessenger', () => {
  it('renders a checklist with status icons, a done counter and progress bar', () => {
    const out = renderTodoListForMessenger([
      { content: 'Set up scaffolding', status: 'completed', priority: 'high' },
      { content: 'Implement API client', status: 'in_progress', priority: 'high' },
      { content: 'Write tests', status: 'pending', priority: 'medium' },
      { content: 'Old approach', status: 'cancelled', priority: 'low' },
    ]);
    expect(out).toContain('📋 **Plan** — 1/4 done');
    // Progress bar: 1 of 4 done → 25% → one filled segment of five.
    expect(out).toContain('`▰▱▱▱▱` 25%');
    expect(out).toContain('✅ ~~Set up scaffolding~~');
    // The in-progress item is bolded so the current focus stands out.
    expect(out).toContain('🔄 **Implement API client**');
    expect(out).toContain('⬜ Write tests');
    expect(out).toContain('🚫 ~~Old approach~~');
    // A blank separator sits between the header and the checklist.
    expect(out).toMatch(/done.*%\n\n✅/s);
  });

  it('returns null for empty or content-less lists', () => {
    expect(renderTodoListForMessenger([])).toBeNull();
    expect(renderTodoListForMessenger(null)).toBeNull();
    expect(renderTodoListForMessenger([{ content: '   ', status: 'pending' }])).toBeNull();
  });

  it('caps very long lists', () => {
    const todos = Array.from({ length: 40 }, (_, i) => ({
      content: `Task ${i + 1}`,
      status: 'pending',
      priority: 'low',
    }));
    const out = renderTodoListForMessenger(todos);
    expect(out).toContain('… 10 more');
    expect(out.length).toBeLessThanOrEqual(1900);
  });
});

describe('renderToolPart — question tool one-liner', () => {
  it('shows the first question text in the summary', () => {
    const line = renderToolPart(
      toolPart({
        tool: 'question',
        state: {
          status: 'completed',
          input: { questions: [{ question: 'Which approach should I take?', header: 'Approach', options: [] }] },
        },
      }),
      'normal',
    );
    expect(line).toContain('**question**');
    expect(line).toContain('Which approach should I take?');
  });
});

describe('isUserShellMarkerText', () => {
  it('matches the synthetic shell marker (with leading whitespace)', () => {
    expect(isUserShellMarkerText(USER_SHELL_MARKER)).toBe(true);
    expect(isUserShellMarkerText('  ' + USER_SHELL_MARKER + '\n\n⬦ bash pwd')).toBe(true);
  });

  it('does not match normal prompts', () => {
    expect(isUserShellMarkerText('please run the tests')).toBe(false);
    expect(isUserShellMarkerText('')).toBe(false);
    expect(isUserShellMarkerText(null)).toBe(false);
  });
});

describe('renderUserShellResult', () => {
  it('shows a single-line command inline plus its output, regardless of verbosity', () => {
    const out = renderUserShellResult({ command: 'pwd', output: '/home/me/project', status: 'completed' });
    expect(out).toContain('⬦ **shell** `pwd`');
    expect(out).toContain('```\n/home/me/project\n```');
  });

  it('fences a multi-line command as bash', () => {
    const out = renderUserShellResult({ command: 'cd /tmp\nls -la', output: 'total 0' });
    expect(out).toContain('```bash\ncd /tmp\nls -la\n```');
    expect(out).toContain('```\ntotal 0\n```');
  });

  it('strips ANSI noise from the output', () => {
    const out = renderUserShellResult({ command: 'ls', output: '\u001b[1;33myellow\u001b[0m' });
    expect(out).toContain('yellow');
    expect(out).not.toContain('[1;33m');
  });

  it('flags an error run and notes the missing output', () => {
    const out = renderUserShellResult({ command: 'false', output: '', status: 'error' });
    expect(out.startsWith('✗ **shell**')).toBe(true);
    expect(out).toContain('no output');
  });

  it('neutralises embedded code fences so the block cannot break out', () => {
    const out = renderUserShellResult({ command: 'echo hi', output: 'before ``` after' });
    expect(out).not.toContain("``` after");
    expect(out).toContain("'''");
  });

  it('returns null when there is nothing to show on a successful run', () => {
    expect(renderUserShellResult({ command: '', output: '', status: 'completed' })).toBeNull();
  });
});
