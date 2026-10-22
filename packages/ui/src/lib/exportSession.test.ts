import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/opencode/model';
import { createContextPart, type ContextPartPayload } from '@/lib/messages/contextParts';
import { buildExportFromRecords } from '@/lib/export/pipeline';
import { renderExportDocument } from './exportSession';

const text = (messageID: string, content: string): Part => ({
  id: `${messageID}-text`, sessionID: 'session', messageID, type: 'text', text: content,
});

/** A text part that carries context metadata, as the app records it. */
const contextPart = (payload: ContextPartPayload): Part => ({
  ...text('c1', ''),
  ...createContextPart(payload),
});

type SessionRecord = { info: Message; parts: Part[] };

/** A child session below the root, as the session list names it. */
type ChildSession = {
  id: string;
  title: string;
  agent?: string;
  records: SessionRecord[];
};

const user = (): SessionRecord => ({
  info: { id: 'u1', sessionID: 'session', role: 'user', time: { created: 1 } },
  parts: [text('u1', 'Fix the build')],
});

const answer = (variant?: string): SessionRecord => ({
  info: {
    id: 'a1', sessionID: 'session', role: 'assistant', agent: 'build',
    providerID: 'anthropic', modelID: 'claude-opus-4-1', variant, time: { created: 2, completed: 3 },
  },
  parts: [text('a1', 'Fixed it')],
});

/** A user message with the parts the test hands it. */
const userWith = (parts: Part[]): SessionRecord => ({
  info: { id: 'u1', sessionID: 'session', role: 'user', time: { created: 1 } },
  parts,
});

/**
 * The document the app writes for one session.
 *
 * The Header and the Sidebar hand the pipeline the session and the records,
 * the pipeline builds the document, and the renderer writes it. The test
 * walks that path, so it reads what the user gets.
 */
const exportMarkdown = (
  records: SessionRecord[],
  options: { title?: string; children?: ChildSession[] } = {},
): string => {
  const title = options.title ?? 'Session';
  const children = options.children ?? [];
  const sessions = [
    { id: 'session', title },
    ...children.map((child) => ({
      id: child.id,
      parentID: 'session',
      title: child.title,
      agent: child.agent,
    })),
  ];
  const recordsBySession = new Map<string, SessionRecord[]>([['session', records]]);
  for (const child of children) {
    recordsBySession.set(child.id, child.records);
  }

  const result = buildExportFromRecords({
    root: { id: 'session', title },
    sessions,
    records: recordsBySession,
  }, 'readable');

  return renderExportDocument(result, 'markdown', 'readable', title);
};

/**
 * The model each assistant message ran with, in the order the document shows
 * them. The export names the model in the message's heading, and repeats it
 * only when the model changed. A sub-agent's messages carry their own
 * heading, so both kinds are read.
 */
const assistantModels = (markdown: string): string[] =>
  markdown
    .split('\n')
    // A heading that names a model carries the provider's id.
    .filter((line) => /^(?:#{2,3} |\*\*)/.test(line) && / — \S+\/\S+/.test(line))
    .map((line) => line.split(' — ')[1]?.replace(/\*+$/, '').trim())
    .filter((model): model is string => Boolean(model));

describe('session export', () => {
  test('exports attached context as context and drops server prompt plumbing', () => {
    const attached: SessionRecord = {
      info: {
        id: 's1', sessionID: 'session', role: 'synthetic', time: { created: 0 },
        ...createContextPart({ kind: 'chat-quote', quote: 'Earlier answer', text: 'Fix this detail' }),
      },
      parts: [],
    };
    const plumbing: SessionRecord = {
      info: { id: 's2', sessionID: 'session', role: 'synthetic', time: { created: 0 }, text: 'The user is returning after a break.' },
      parts: [],
    };

    const markdown = exportMarkdown([plumbing, attached, user(), answer()]);

    expect(markdown).toContain('Context');
    expect(markdown).toContain('Fix this detail');
    expect(markdown).not.toContain('returning after a break');
    expect(markdown).toContain('Fixed it');
  });

  test('names the thinking level next to the model for the main agent and sub-agents', () => {
    const markdown = exportMarkdown([user(), answer('high')], {
      children: [{ id: 'ses_child', title: 'Explore', agent: 'explore', records: [answer('max')] }],
    });

    expect(assistantModels(markdown)).toEqual([
      'anthropic/claude-opus-4-1, thinking: high',
      'anthropic/claude-opus-4-1, thinking: max',
    ]);
  });

  test('keeps the model alone when no thinking level was picked', () => {
    const markdown = [undefined, 'default', 'none']
      .map((variant) => exportMarkdown([answer(variant)]))
      .join('\n');

    expect(assistantModels(markdown)).toEqual([
      'anthropic/claude-opus-4-1',
      'anthropic/claude-opus-4-1',
      'anthropic/claude-opus-4-1',
    ]);
  });

  test('a child the call named joins the call and is not reported as missing', () => {
    const call: Part = {
      id: 'a1-call', sessionID: 'session', messageID: 'a1', type: 'tool',
      callID: 'a1-call', tool: 'subagent',
      state: {
        status: 'completed',
        input: { description: 'Review the change' },
        output: 'Done',
        metadata: { sessionID: 'ses_child' },
        time: { start: 2, end: 3 },
      },
    };
    const withCall: SessionRecord = {
      info: {
        id: 'a1', sessionID: 'session', role: 'assistant', agent: 'build',
        providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2, completed: 3 },
      },
      parts: [call],
    };

    // The call recorded the id of the session it started, so the child is
    // tied to the call and its transcript belongs in the document.
    const markdown = exportMarkdown([user(), withCall], {
      children: [{ id: 'ses_child', title: 'Review the change', records: [answer()] }],
    });

    expect(markdown).toContain('Fixed it');
    expect(markdown).not.toContain('was not tied to a call');
  });

  test('exports quote and reply exactly once with paragraph separation, including child sessions', () => {
    const record = userWith([
      text('u1', 'My request'),
      contextPart({ kind: 'file-quote', fileLabel: 'plan.md', startLine: 2, endLine: 4, quote: 'First line\n\nLast line', text: 'My comment' }),
    ]);
    const output = exportMarkdown([record], {
      title: 'Title',
      children: [{ id: 'ses_child', title: 'Child', records: [record] }],
    });

    expect(output).toContain('My request\n\nQuoted from `plan.md`, lines 2-4:');
    expect(output).toContain('> First line\n> \n> Last line\n\n**User comment:**\n\nMy comment');
    expect(output.match(/My comment/g)).toHaveLength(2);
    expect(output).not.toContain('Comment on this fragment');
  });
});
