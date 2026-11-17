import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { questionPrompts, type QuestionAnswer } from '@/lib/opencode/question';
import { QuestionAnswerForm, QuestionToolDetailsView, type QuestionToolDetailsViewProps } from './QuestionToolDetailsView';

// Static renders, as in FormMarkdown.test.tsx: question text is Markdown,
// whose renderer loads lazily through a Vite worker import that `bun test`
// cannot resolve, so a mounted tree fails once that import settles. The one
// mounted test, which opens and closes the form, uses a call with no
// questions for that reason. Picking and sending are covered by the answer
// conversions in questionAnswers.test.ts and the send request in
// input-store.test.ts.

const prompts = questionPrompts({
  questions: [
    {
      header: 'Mode',
      question: 'Which mode should it use?',
      multiple: false,
      options: [
        { label: 'Fast (Recommended)', description: 'One model call' },
        { label: 'Careful', description: 'A forked session that reads files' },
      ],
    },
    {
      header: 'Checks',
      question: 'Which checks run?',
      multiple: true,
      options: [
        { label: 'Types', description: 'tsc' },
        { label: 'Lint', description: 'oxlint' },
      ],
    },
  ],
});

const noop = () => undefined;

// Stands in for the row's scroll box, so a test can tell what is in it.
const renderScrollBox = (questions: ReactNode) => <div data-scroll-box="">{questions}</div>;

const renderView = (props: Partial<QuestionToolDetailsViewProps>) => renderToStaticMarkup(
  <I18nProvider>
    <QuestionToolDetailsView
      prompts={prompts}
      answers={null}
      errorText={null}
      canAnswer
      startingAnswers={() => null}
      onKeep={noop}
      onSend={noop}
      isMobile={false}
      renderScrollBox={renderScrollBox}
      {...props}
    />
  </I18nProvider>,
);

const renderForm = (starting: QuestionAnswer[] | null) => renderToStaticMarkup(
  <I18nProvider>
    <QuestionAnswerForm prompts={prompts} starting={starting} isMobile={false} renderScrollBox={renderScrollBox} onCancel={noop} onSend={noop} />
  </I18nProvider>,
);

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const buttonLabels = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => textOf(match[1]).trim());

describe('QuestionToolDetailsView', () => {
  test('a dismissed question still shows every question, option and description, and why it went unanswered', () => {
    const html = renderView({ errorText: 'The user dismissed this question' });
    const text = textOf(html);

    for (const expected of ['Which mode should it use?', 'Fast', 'recommended', 'One model call', 'Careful', 'A forked session that reads files', 'Which checks run?', 'Types', 'tsc', 'Lint', 'oxlint']) {
      expect(text).toContain(expected);
    }
    expect(text).toContain('Not answered · The user dismissed this question');
    expect(buttonLabels(html)).toEqual(['Answer']);
  });

  test('an answered call marks what was chosen, shows a typed answer, and offers to answer again', () => {
    const html = renderView({ answers: [['Careful'], ['Types', 'also run the e2e suite']] });
    const text = textOf(html);

    expect(html.match(/class="sr-only"/g)?.length).toBe(2);
    expect(text).toContain('Your answer');
    expect(text).toContain('also run the e2e suite');
    expect(text).not.toContain('Not answered');
    expect(buttonLabels(html)).toEqual(['Answer again']);
  });

  test('a question the call left without an answer says so', () => {
    const text = textOf(renderView({ answers: [['Careful'], []] }));

    expect(text).toContain('Not answered');
  });

  test('without a chat that can send in its session there is no way to answer', () => {
    const html = renderView({ errorText: 'The user dismissed this question', canAnswer: false });

    expect(textOf(html)).toContain('Which mode should it use?');
    expect(buttonLabels(html)).toEqual([]);
  });

  test('the form opens on the answers given before', () => {
    const html = renderForm([['Careful'], ['Lint']]);
    // The control of each option row comes right before its label.
    const checkedState = (label: string) => {
      const at = html.indexOf(`>${label}<`);
      if (at < 0) throw new Error(`No option "${label}" in: ${textOf(html)}`);
      return [...html.slice(0, at).matchAll(/aria-checked="(true|false)"/g)].at(-1)?.[1];
    };

    expect(checkedState('Fast')).toBe('false');
    expect(checkedState('Careful')).toBe('true');
    expect(checkedState('Types')).toBe('false');
    expect(checkedState('Lint')).toBe('true');
    expect(/<button[^>]*disabled=""[^>]*>[\s\S]{0,200}Send answers/.test(html)).toBe(false);
  });

  test('the form with nothing answered cannot send yet', () => {
    expect(/<button[^>]*disabled=""[^>]*>[\s\S]{0,200}Send answers/.test(renderForm(null))).toBe(true);
  });
});

describe('QuestionToolDetailsView, buttons under the scroll box', () => {
  let page: Window;

  beforeEach(() => {
    page = new Window();
  });

  afterEach(async () => {
    await page.happyDOM.close();
  });

  // The row's scroll box stops growing at 60% of the window's height, which a
  // few questions fill on a phone. A button inside the box sits below that
  // fold until the reader scrolls inside the row, so every button goes under it.
  const layout = (html: string) => {
    page.document.body.innerHTML = html;
    const box = page.document.querySelector('[data-scroll-box]');
    if (!box) throw new Error(`No scroll box in: ${textOf(html)}`);
    const buttonsUnderBox = [...page.document.querySelectorAll('button')]
      .filter((button) => !box.contains(button))
      .map((button) => button.textContent?.trim());
    return { inBox: box.textContent ?? '', buttonsUnderBox };
  };

  test('the questions scroll in the box, and Answer sits under it', () => {
    const { inBox, buttonsUnderBox } = layout(renderView({ errorText: 'The user dismissed this question' }));

    expect(inBox).toContain('Which checks run?');
    expect(inBox).toContain('Not answered · The user dismissed this question');
    expect(buttonsUnderBox).toEqual(['Answer']);
  });

  test('the open form scrolls its questions in the box, and Cancel and Send answers sit under it', () => {
    const { inBox, buttonsUnderBox } = layout(renderForm(null));

    expect(inBox).toContain('Which checks run?');
    expect(inBox).toContain('The agent gets your answers as a new message.');
    expect(buttonsUnderBox).toEqual(['Cancel', 'Send answers']);
  });
});

describe('QuestionToolDetailsView, opened and closed', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await windowInstance.happyDOM.close();
  });

  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
    if (!button) throw new Error(`No "${label}" button in: ${host.textContent}`);
    await act(async () => button.click());
  };

  test('the answers to start from are read once each time the form opens, by the click that opens it', async () => {
    let reads = 0;
    const startingAnswers = () => {
      reads += 1;
      return null;
    };
    const kept: QuestionAnswer[][] = [];
    const onKeep = (answers: QuestionAnswer[]) => {
      kept.push(answers);
    };
    const render = () => act(async () => root.render(
      <I18nProvider>
        <QuestionToolDetailsView
          prompts={[]}
          answers={null}
          errorText={null}
          canAnswer
          startingAnswers={startingAnswers}
          onKeep={onKeep}
          onSend={noop}
          isMobile={false}
          renderScrollBox={renderScrollBox}
        />
      </I18nProvider>,
    ));

    await render();
    expect(reads).toBe(0);

    await click('Answer');
    expect(reads).toBe(1);

    // The row renders again while the form stays open, as it does whenever
    // the stores QuestionToolDetails reads change.
    await render();
    expect(reads).toBe(1);

    await click('Cancel');
    expect(kept).toEqual([[]]);
    expect(reads).toBe(1);

    await click('Answer');
    expect(reads).toBe(2);
  });
});
