import { describe, expect, test } from 'vitest';
import { A2UI_POINTER_GUIDANCE, buildA2uiSchemaReference } from './a2ui-schema.js';
import { createPageAnswers, createRenderPageAction, createRenderSchemaAction } from './render-page.js';
import { UI_BLOCKS_GUIDANCE } from '../session-knowledge/ui-blocks-guidance.js';

describe('A2UI on-demand schema & render.page integration', () => {
  test('static pointer guidance is far smaller than legacy always-on UI_BLOCKS_GUIDANCE', () => {
    expect(A2UI_POINTER_GUIDANCE.length).toBeLessThan(600);
    expect(A2UI_POINTER_GUIDANCE.length).toBeLessThan(UI_BLOCKS_GUIDANCE.length / 5);
    expect(A2UI_POINTER_GUIDANCE).toContain('render.schema');
  });

  test('render.schema loads full or topic-filtered A2UI catalog on demand', async () => {
    const schemaAction = createRenderSchemaAction({ isEnabled: async () => true });
    const all = await schemaAction({});
    expect(all.topic).toBe('all');
    expect(all.schema).toContain('QuestionBatch');
    expect(all.schema).toContain('LineChart');

    const forms = await schemaAction({ topic: 'forms' });
    expect(forms.topic).toBe('forms');
    expect(forms.schema).toContain('QuestionBatch');
    expect(forms.schema).not.toContain('LineChart:');

    const charts = await schemaAction({ topic: 'charts' });
    expect(charts.topic).toBe('charts');
    expect(charts.schema).toContain('LineChart');
    expect(charts.schema).not.toContain('QuestionBatch');

    const cogmap = await schemaAction({ topic: 'cogmap' });
    expect(cogmap.topic).toBe('cogmap');
    expect(cogmap.schema).toContain('CognitiveMap');
    expect(cogmap.schema).toContain('openchamber_cogmap');
  });

  test('render.page accepts a2ui, rejects conflicting inputs, and handles awaitAnswer with 30-question payload', async () => {
    let resolveWaiting;
    const waitingReady = new Promise((resolve) => { resolveWaiting = resolve; });
    const pageAnswers = createPageAnswers({
      onWaitChange: (change) => {
        if (change.type === 'waiting') resolveWaiting();
      },
    });
    const renderPage = createRenderPageAction({
      isEnabled: async () => true,
      pageAnswers,
      hasUnreadChat: async () => false,
    });

    const a2uiPayload = '{"createSurface":{"surfaceId":"q1"}}\n{"updateComponents":{"surfaceId":"q1","components":[{"id":"root","component":"Text","text":"Hi"}]}}';

    // Show-only A2UI page succeeds (both string JSONL and native JSON array)
    const shown = await renderPage({ a2ui: a2uiPayload, title: 'Quick chart' });
    expect(shown).toMatchObject({ shown: true, title: 'Quick chart' });
    const shownArray = await renderPage({
      a2ui: [
        { createSurface: { surfaceId: 'arr1' } },
        { updateComponents: { surfaceId: 'arr1', components: [{ id: 'root', component: 'Text', text: 'Array OK' }] } },
      ],
      title: 'Native JSON array',
    });
    expect(shownArray).toMatchObject({ shown: true, title: 'Native JSON array' });

    // Conflicting inputs rejected
    await expect(renderPage({ a2ui: a2uiPayload, html: '<p>x</p>' })).rejects.toThrow('Send only one of a2ui, ui, or html');

    // Blocking awaitAnswer with 30-question payload
    const pending = renderPage(
      { a2ui: a2uiPayload, title: '30 Questions', awaitAnswer: true },
      { sessionId: 'ses_a2ui', callId: 'call_30' },
    );
    await waitingReady;

    const answers = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`q${i + 1}`, `opt_${(i % 3) + 1}`]));
    pageAnswers.answer({
      sessionId: 'ses_a2ui',
      callId: 'call_30',
      summary: 'Answered 30 of 30',
      data: { action: 'submit', surfaceId: 'q1', context: { answers, answeredCount: 30, totalCount: 30 } },
    });

    const result = await pending;
    expect(result.answer).toMatchObject({
      answered: true,
      summary: 'Answered 30 of 30',
    });
    expect(Object.keys(result.answer.data.context.answers)).toHaveLength(30);
  });
});
