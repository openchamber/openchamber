import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
mock.module('../MarkdownRenderer', () => ({
  MarkdownContent: ({ content }: { content: string }) => <span>{content}</span>,
}));

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
const browser = new Window({ url: 'http://localhost/' });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  Text: browser.Text,
  SVGElement: browser.SVGElement,
  customElements: browser.customElements,
  MutationObserver: browser.MutationObserver,
  DOMParser: browser.DOMParser,
  CustomEvent: browser.CustomEvent,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  requestAnimationFrame: browser.requestAnimationFrame,
  cancelAnimationFrame: browser.cancelAnimationFrame,
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const { A2uiSurface } = await import('./A2uiSurface');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
const { getDefaultTheme } = await import('@/lib/theme/themes');

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => {
  await act(() => root.unmount());
  browser.happyDOM.abort();
  globalThis.fetch = realFetch;
});

const themeSystem = { currentTheme: getDefaultTheme(false) } as React.ContextType<typeof ThemeSystemContext>;
let renderSeq = 0;

const renderSurface = (source: string, surfaceHost: React.ComponentProps<typeof A2uiSurface>['host']) => {
  const key = ++renderSeq;
  return act(() =>
    root.render(
      <I18nProvider>
        <ThemeSystemContext.Provider value={themeSystem}>
          <A2uiSurface key={key} source={source} complete host={surfaceHost} />
        </ThemeSystemContext.Provider>
      </I18nProvider>,
    ),
  );
};

describe('A2uiSurface component rendering', () => {
  test('renders a 30-question QuestionBatch, expands local details, applies recommended, and submits in one payload', async () => {
    const questions = Array.from({ length: 30 }, (_, idx) => ({
      id: `q${idx + 1}`,
      question: `Decision ${idx + 1}`,
      detail: `Extra rationale for decision ${idx + 1}`,
      recommended: 'opt-b',
      options: [
        { label: 'Option A', value: 'opt-a', description: 'First choice' },
        { label: 'Option B', value: 'opt-b', description: 'Second choice' },
        { label: 'Option C', value: 'opt-c', description: 'Third choice' },
      ],
    }));

    const jsonl = [
      JSON.stringify({ createSurface: { surfaceId: 'batch-30' } }),
      JSON.stringify({
        updateComponents: {
          surfaceId: 'batch-30',
          components: [
            { id: 'root', component: 'Column', children: ['batch'] },
            { id: 'batch', component: 'QuestionBatch', title: '30 Decisions', items: { path: '/questions' }, pageSize: 5 },
          ],
        },
      }),
      JSON.stringify({ updateDataModel: { surfaceId: 'batch-30', value: { questions, answers: {}, notes: {} } } }),
    ].join('\n');

    const submitted: Array<{ summary: string; data: unknown }> = [];
    await renderSurface(jsonl, {
      kind: 'page',
      answered: null,
      submit: async (submission) => {
        submitted.push(submission);
      },
    });

    // Progress starts at 0 / 30 and page 1 shows first 5 questions
    expect(host.textContent).toContain('0 / 30 answered');
    expect(host.textContent).toContain('Decision 1');
    expect(host.textContent).not.toContain('Decision 6');

    // Expand client-side detail on Decision 1 without calling any model
    const detailBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Details'));
    expect(detailBtn).toBeDefined();
    await act(async () => detailBtn!.click());
    expect(host.textContent).toContain('Extra rationale for decision 1');

    // Manually pick Option A for Decision 1
    const firstOptionA = [...host.querySelectorAll('span')].find((el) => el.textContent === 'Option A');
    expect(firstOptionA).toBeDefined();
    await act(async () => firstOptionA!.click());
    expect(host.textContent).toContain('1 / 30 answered');

    // Apply recommended for the remaining 29 questions
    const applyRecBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Apply recommended (29)'));
    expect(applyRecBtn).toBeDefined();
    await act(async () => applyRecBtn!.click());
    expect(host.textContent).toContain('30 / 30 answered (100%)');

    // Submit once — manual pick for q1 stays opt-a, remaining 29 get opt-b
    const submitBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Submit selections (30/30)'));
    expect(submitBtn).toBeDefined();
    await act(async () => submitBtn!.click());

    expect(submitted).toHaveLength(1);
    expect(submitted[0].summary).toContain('Answered 30 of 30');
    const answers = (submitted[0].data as { context: { answers: Record<string, string> } }).context.answers;
    expect(answers.q1).toBe('opt-a');
    expect(answers.q2).toBe('opt-b');
    expect(answers.q30).toBe('opt-b');
    expect(Object.keys(answers)).toHaveLength(30);
  });

  test('evaluates reactive visibleWhen locally when ChoicePicker selection changes', async () => {
    const jsonl = [
      JSON.stringify({ createSurface: { surfaceId: 'react-1' } }),
      JSON.stringify({
        updateComponents: {
          surfaceId: 'react-1',
          components: [
            { id: 'root', component: 'Column', children: ['picker', 'cloud_note'] },
            {
              id: 'picker',
              component: 'ChoicePicker',
              label: 'Mode',
              value: { path: '/mode' },
              options: [
                { label: 'Local', value: 'local' },
                { label: 'Cloud', value: 'cloud' },
              ],
            },
            {
              id: 'cloud_note',
              component: 'Callout',
              title: 'Cloud selected',
              text: 'TLS required',
              visibleWhen: { call: 'equals', args: { left: { path: '/mode' }, right: 'cloud' } },
            },
          ],
        },
      }),
      JSON.stringify({ updateDataModel: { surfaceId: 'react-1', value: { mode: 'local' } } }),
    ].join('\n');

    await renderSurface(jsonl, { kind: 'demo', answered: null, submit: async () => {} });
    expect(host.textContent).not.toContain('Cloud selected');

    const cloudOpt = [...host.querySelectorAll('span')].find((el) => el.textContent === 'Cloud');
    await act(async () => cloudOpt!.click());
    expect(host.textContent).toContain('Cloud selected');
    expect(host.textContent).toContain('TLS required');
  });

  test('renders CognitiveMap from inline DSL and dispatches laddering action when clicked', async () => {
    const jsonl = [
      JSON.stringify({ createSurface: { surfaceId: 'cm-demo' } }),
      JSON.stringify({
        updateComponents: {
          surfaceId: 'cm-demo',
          components: [
            {
              id: 'root',
              component: 'CognitiveMap',
              title: 'Migration Strategy',
              focus: 'n2',
              dsl: [
                'n1: Zero-downtime cutover ... risky big-bang outage [goal]',
                'n2: Dual-write shadow traffic ... switch cold [option]',
                'n2 +> n1',
              ].join('\n'),
            },
          ],
        },
      }),
    ].join('\n');

    const submitted: Array<{ action: string; context: Record<string, unknown> }> = [];
    await renderSurface(jsonl, {
      kind: 'demo',
      answered: null,
      submit: async (answer) => {
        submitted.push({ action: answer.action, context: answer.context });
      },
    });

    expect(host.textContent).toContain('Migration Strategy');
    expect(host.textContent).toContain('Zero-downtime cutover');
    expect(host.textContent).toContain('Dual-write shadow traffic');

    const ladderUpBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Why?'));
    expect(ladderUpBtn).toBeDefined();
    await act(async () => ladderUpBtn!.click());

    expect(submitted).toHaveLength(1);
    expect(submitted[0].action).toBe('ladder_up');
    expect(submitted[0].context.nodeId).toBe('n2');
  });
});
