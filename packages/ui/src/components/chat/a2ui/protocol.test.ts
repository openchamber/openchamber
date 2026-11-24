import { describe, expect, test } from 'bun:test';
import {
  formatA2uiSummary,
  getByPointer,
  parseA2uiMessages,
  resolveActionContext,
  resolveDynamicValue,
  setByPointer,
} from './protocol';
import { describeA2uiReplyAnswer } from './answer';

describe('A2UI protocol parser & reactive data engine', () => {
  test('parses valid JSONL envelopes into a surface with components and data model', () => {
    const jsonl = [
      JSON.stringify({ createSurface: { surfaceId: 's1', title: 'Triage' } }),
      JSON.stringify({
        updateComponents: {
          surfaceId: 's1',
          components: [
            { id: 'root', component: 'Column', children: ['batch'] },
            { id: 'batch', component: 'QuestionBatch', items: { path: '/questions' } },
          ],
        },
      }),
      JSON.stringify({
        updateDataModel: {
          surfaceId: 's1',
          value: { questions: [{ id: 'q1', question: 'Pick one', options: ['A', 'B', 'C'] }], answers: {} },
        },
      }),
    ].join('\n');

    const result = parseA2uiMessages(jsonl, true);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.surface.surfaceId).toBe('s1');
    expect(result.surface.rootId).toBe('root');
    expect(result.surface.components.size).toBe(2);
    expect(getByPointer(result.surface.dataModel, '/questions/0/id')).toBe('q1');
  });

  test('supports JSON array format as well as streaming partial JSONL lines', () => {
    const arrayPayload = JSON.stringify([
      { createSurface: { surfaceId: 'arr' } },
      { updateComponents: { surfaceId: 'arr', components: [{ id: 'root', component: 'Text', text: 'Hello' }] } },
    ]);
    const parsedArray = parseA2uiMessages(arrayPayload, true);
    expect(parsedArray.kind).toBe('ready');

    const streamingPartial = [
      JSON.stringify({ createSurface: { surfaceId: 'stream' } }),
      JSON.stringify({ updateComponents: { surfaceId: 'stream', components: [{ id: 'root', component: 'Text', text: 'Live' }] } }),
      '{"updateDataModel":{"surfaceId":"stream","val',
    ].join('\n');

    // Incomplete trailing line is ignored while streaming, but flagged once complete.
    expect(parseA2uiMessages(streamingPartial, false).kind).toBe('ready');
    expect(parseA2uiMessages(streamingPartial, true).kind).toBe('invalid');
  });

  test('reports unknown components and missing root when complete', () => {
    const unknown = [
      JSON.stringify({ createSurface: { surfaceId: 'bad' } }),
      JSON.stringify({ updateComponents: { surfaceId: 'bad', components: [{ id: 'root', component: 'NonExistentWidget' }] } }),
    ].join('\n');

    const res = parseA2uiMessages(unknown, true);
    expect(res.kind).toBe('invalid');
    if (res.kind !== 'invalid') return;
    expect(res.errors.some((e) => e.includes('Unknown component "NonExistentWidget"'))).toBe(true);
  });

  test('evaluates JSON Pointer reads/writes, template interpolation, and safe functions', () => {
    let model = setByPointer({}, '/answers/q1', 'jwt');
    model = setByPointer(model, '/answers/q2', 'rest-sse');
    model = setByPointer(model, '/mode', 'cloud');

    expect(getByPointer(model, '/answers/q1')).toBe('jwt');
    expect(getByPointer(model, 'q2', '/answers')).toBe('rest-sse');

    expect(
      resolveDynamicValue(
        { call: 'equals', args: { left: { path: '/mode' }, right: 'cloud' } },
        model,
      ),
    ).toBe(true);

    expect(
      resolveDynamicValue(
        { call: 'countAnswered', args: { value: { path: '/answers' } } },
        model,
      ),
    ).toBe(2);

    expect(resolveDynamicValue('Mode is ${/mode}', model)).toBe('Mode is cloud');

    const resolvedCtx = resolveActionContext(
      { mode: { path: '/mode' }, answers: { path: '/answers' } },
      model,
    );
    expect(resolvedCtx).toEqual({ mode: 'cloud', answers: { q1: 'jwt', q2: 'rest-sse' } });
  });

  test('formats 30-question batch answers concisely under 500-char summary limit and preserves all answers in reply text', () => {
    const answers: Record<string, string> = {};
    for (let i = 1; i <= 30; i += 1) {
      answers[`q${String(i).padStart(2, '0')}`] = `opt_${(i % 3) + 1}`;
    }
    const context = { answers, notes: { q01: 'Need HTTP/2 proxy support' }, answeredCount: 30, totalCount: 30, unanswered: [] };

    const summary = formatA2uiSummary('submit_triage', context);
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary).toContain('Answered 30 of 30');

    const replyText = describeA2uiReplyAnswer({
      action: 'submit_triage',
      surfaceId: 'triage-30',
      context,
      note: 'Proceed with Phase 1',
    });
    expect(replyText).toContain('- q01: opt_2');
    expect(replyText).toContain('Note: Need HTTP/2 proxy support');
    expect(replyText).toContain('- q30: opt_1');
    expect(replyText).toContain('Overall note: Proceed with Phase 1');
  });

  test('safely repairs missing trailing closing braces, trailing commas, and shorthand objects', () => {
    // Regression: real LLM output dropped one trailing "}" at the end of a long updateDataModel line.
    const missingBrace = [
      '{"createSurface":{"surfaceId":"sp1","title":"Screenplay"}}',
      '{"updateComponents":{"surfaceId":"sp1","components":[{"id":"root","component":"Column","children":["batch"]},{"id":"batch","component":"QuestionBatch","items":{"path":"/questions"}}]}}',
      '{"updateDataModel":{"surfaceId":"sp1","value":{"answers":{},"questions":[{"id":"genre","question":"Genre?","options":[{"label":"Thriller","value":"thriller",}]}]}}',
    ].join('\n');

    const repaired = parseA2uiMessages(missingBrace, true);
    expect(repaired.kind).toBe('ready');
    if (repaired.kind !== 'ready') return;
    expect(getByPointer(repaired.surface.dataModel, '/questions/0/id')).toBe('genre');

    // Shorthand single-object surface format (for structured tool calls).
    const shorthand = JSON.stringify({
      surfaceId: 'short1',
      title: 'Quick',
      components: [{ id: 'root', component: 'Text', text: 'Hi ${/name}' }],
      data: { name: 'Ada' },
    });
    const parsedShort = parseA2uiMessages(shorthand, true);
    expect(parsedShort.kind).toBe('ready');
    if (parsedShort.kind !== 'ready') return;
    expect(getByPointer(parsedShort.surface.dataModel, '/name')).toBe('Ada');
  });

  test('splits merged multi-key envelopes inside JSON arrays instead of silently dropping updateDataModel', () => {
    // Regression: real model output merged updateComponents + updateDataModel into one array item.
    const mergedPayload = JSON.stringify([
      { createSurface: { surfaceId: 'setup', title: 'Screenplay Setup' } },
      {
        updateComponents: {
          surfaceId: 'setup',
          components: [
            { id: 'root', component: 'Column', children: ['batch'] },
            { id: 'batch', component: 'QuestionBatch', items: { path: '/questions' } },
          ],
        },
        updateDataModel: {
          surfaceId: 'setup',
          value: {
            questions: [
              { id: 'genre', question: 'Genre?', options: [{ label: 'Drama', value: 'drama' }] },
            ],
            answers: {},
          },
        },
      },
    ]);

    const parsed = parseA2uiMessages(mergedPayload, true);
    expect(parsed.kind).toBe('ready');
    if (parsed.kind !== 'ready') return;
    expect(parsed.surface.components.size).toBe(2);
    expect(getByPointer(parsed.surface.dataModel, '/questions/0/id')).toBe('genre');
  });

  test('recovers stray primitive entries in components and stray top-level component objects', () => {
    // Regression: real GPT-6 Luna output closed updateComponents before the last component, leaving its id string inside components and the component object as the next array item.
    const strayPayload = JSON.stringify([
      { createSurface: { surfaceId: 'db', title: 'DB Tradeoffs' } },
      {
        updateComponents: {
          surfaceId: 'db',
          components: [
            { id: 'root', component: 'Column', children: ['intro', 'notes'] },
            { id: 'intro', component: 'Text', text: 'Overview' },
            'notes',
          ],
        },
      },
      { id: 'notes', component: 'Callout', tone: 'info', title: 'Default', text: 'Use SQLite.' },
    ]);

    const parsed = parseA2uiMessages(strayPayload, true);
    expect(parsed.kind).toBe('ready');
    if (parsed.kind !== 'ready') return;
    expect(parsed.surface.components.size).toBe(3);
    expect(parsed.surface.components.get('notes')?.component).toBe('Callout');
  });
});
