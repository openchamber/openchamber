/**
 * The HTML export's own page.
 *
 * The page is a document a reader searches in, so a match has to stay on the
 * page: a counter that says "one match" while the match is hidden is a lie
 * the reader has to find out on their own.
 *
 * The tests run the page's own script in a DOM, so they read the page a
 * reader gets and not a description of it.
 */

import { describe, expect, test } from 'bun:test';
import { Window, type Element } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import { useI18nStore } from '@/lib/i18n';
import { buildExportFromRecords } from './pipeline';
import { renderExportHtml } from './html';
import { assistantMessage, subagentCall, subagentReport, type Record_ } from './fixtures';

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  projectID: 'proj_1',
  directory: '/repo',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  ...overrides,
});

/** The call a record holds, with the child session it started. */
const delegation = (messageID: string, childSessionID: string, sessionID: string): Record_ => ({
  info: {
    id: messageID, sessionID, role: 'assistant', agent: 'build',
    providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
  },
  parts: [subagentCall(messageID, { childSessionID, sessionID, prompt: 'Look at the change' })],
});

const rootRecords: Record_[] = [delegation('a1', 'ses_child', 'ses_root')];
const childRecords: Record_[] = [delegation('ca1', 'ses_grand', 'ses_child')];
const grandRecords: Record_[] = [assistantMessage('ses_grand', 'ga1', 2500, 'The needle is here')];

/** The page the export writes, as text. */
const pageHtml = (): string => {
  const result = buildExportFromRecords({
    root: session('ses_root', { title: 'Root' }),
    sessions: [
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      session('ses_grand', { title: 'Grand', parentID: 'ses_child', agent: 'explore' }),
    ],
    records: new Map([
      ['ses_root', rootRecords],
      ['ses_child', childRecords],
      ['ses_grand', grandRecords],
    ]),
  }, 'readable');

  return renderExportHtml(result.projection, {
    title: 'Root',
    mode: 'readable',
    findings: result.timeline.findings, excluded: result.timeline.excluded,
    sessionCount: result.timeline.sessions.size,
  });
};

/** The page the export writes, with its own script running in it. */
const openPage = (): Window => {
  const html = pageHtml();

  const dom = new Window({ url: 'https://localhost/' });
  dom.document.write(html);

  // The page's own script, run against the page's own document.
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!script) throw new Error('The export wrote no page script');
  new Function('document', script[1])(dom.document);

  return dom;
};

/** Searches the page for a word, the way a reader types it. */
const search = (dom: Window, term: string): void => {
  const input = dom.document.querySelector('input');
  if (!input) throw new Error('The page has no search box');
  input.value = term;
  input.dispatchEvent(new dom.Event('input'));
};

/**
 * Whether the entry is on the page.
 *
 * An entry is on the page when nothing hides it: not the entry itself, and
 * not a block above it. A hidden block takes its whole subtree with it. An
 * entry the page does not carry at all is not on the page either.
 */
const isOnPage = (entry: Element | null): boolean => {
  if (!entry) return false;
  if (entry.classList.contains('hidden')) return false;
  let parent = entry.parentElement;
  while (parent) {
    if (parent.classList.contains('hidden')) return false;
    parent = parent.parentElement;
  }
  return true;
};

/** The data the page's own script works with. */
const pageData = (dom: Window): { countLabel: string } => {
  const block = dom.document.getElementById('export-data')?.textContent;
  if (!block) throw new Error('The page has no data block');
  // SAFETY: the export writes the data block itself, so the text holds the
  // page's own data.
  return JSON.parse(block) as { countLabel: string };
};

describe('the HTML page keeps the match on the page', () => {
  test('a match inside a nested block keeps the blocks above it visible', () => {
    const dom = openPage();

    // The only match sits in the grandchild's block, which is nested in the
    // child's block.
    search(dom, 'needle');

    const sections = [...dom.document.querySelectorAll('.subagent')];
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section.classList.contains('hidden')).toBe(false);
    }

    const matches = [...dom.document.querySelectorAll('.entry')]
      .filter((entry) => (entry.textContent ?? '').includes('needle'));
    expect(matches).toHaveLength(1);
    expect(isOnPage(matches[0])).toBe(true);
  });

  test('the count agrees with the entries the page keeps', () => {
    const dom = openPage();

    search(dom, 'needle');

    const entries = [...dom.document.querySelectorAll('.entry')];
    const shown = entries.filter((entry) => isOnPage(entry));
    const count = dom.document.getElementById('count')?.textContent ?? '';
    const expected = pageData(dom).countLabel
      .replace('{visible}', String(shown.length))
      .replace('{total}', String(entries.length));

    // The counter names the entries the reader can see, and the one match
    // is one of them.
    expect(shown).toHaveLength(1);
    expect(count).toBe(expected);
  });

  test('a block with no match under it is hidden', () => {
    const dom = openPage();

    search(dom, 'a word that is nowhere in the export');

    // Nothing matches, so every block is empty and goes away.
    for (const section of dom.document.querySelectorAll('.subagent')) {
      expect(section.classList.contains('hidden')).toBe(true);
    }
    const count = dom.document.getElementById('count')?.textContent ?? '';
    expect(count).toContain('0');
  });
});

describe('the HTML page names the language it is written in', () => {
  test('the page declares the language of the document', () => {
    // The document's text is the reader's language, and the page says so:
    // a screen reader reads the text in the voice of the language the page
    // names, and the browser's spell checker follows it too.
    const previous = useI18nStore.getState().locale;
    try {
      useI18nStore.setState({ locale: 'de' });
      expect(pageHtml()).toContain('<html lang="de-DE">');

      useI18nStore.setState({ locale: 'ja' });
      expect(pageHtml()).toContain('<html lang="ja-JP">');
    } finally {
      useI18nStore.setState({ locale: previous });
    }
  });
});

/**
 * A prompt long enough for the readable view to cut it.
 *
 * The head of the prompt is what the page shows, the tail is what the cut
 * took away.
 */
const longPrompt = (head: string, tail: string): string => `${head} ${'a'.repeat(700)} ${tail}`;

const TASK_HEAD = 'taskheadmarker';
const TASK_TAIL = 'tasktailmarker';
const CALL_HEAD = 'callheadmarker';
const CALL_TAIL = 'calltailmarker';

/**
 * The page with two long prompts in it.
 *
 * One is the task of a sub-agent block: the call that started the child
 * carried it, and the child recorded no prompt of its own. The other is a
 * call that named no child, so it stays a row of the parent's own sequence.
 */
const longPromptPage = (): string => {
  const result = buildExportFromRecords({
    root: session('ses_root', { title: 'Root' }),
    sessions: [
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
    ],
    records: new Map([
      ['ses_root', [
        {
          info: {
            id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
          },
          parts: [subagentCall('a1', {
            childSessionID: 'ses_child',
            sessionID: 'ses_root',
            prompt: longPrompt(TASK_HEAD, TASK_TAIL),
            startedAt: 2000,
            endedAt: 3000,
          })],
        },
        {
          info: {
            id: 'a2', sessionID: 'ses_root', role: 'assistant', agent: 'build',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 4000 },
          },
          parts: [subagentCall('a2', {
            sessionID: 'ses_root',
            prompt: longPrompt(CALL_HEAD, CALL_TAIL),
            startedAt: 4000,
            endedAt: 5000,
          })],
        },
      ]],
      // The child recorded no prompt of its own, so the task of its block is
      // the prompt the call carried.
      ['ses_child', [assistantMessage('ses_child', 'ca1', 2500, 'The child work')]],
    ]),
  }, 'readable');

  return renderExportHtml(result.projection, {
    title: 'Root',
    mode: 'readable',
    findings: result.timeline.findings, excluded: result.timeline.excluded,
    sessionCount: result.timeline.sessions.size,
  });
};

/** The page with its own script running in it. */
const openLongPromptPage = (): Window => {
  const html = longPromptPage();
  const dom = new Window({ url: 'https://localhost/' });
  dom.document.write(html);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!script) throw new Error('The export wrote no page script');
  new Function('document', script[1])(dom.document);
  return dom;
};

/** The entries the reader can see after the search. */
const visibleEntries = (dom: Window): Element[] => (
  [...dom.document.querySelectorAll('.entry')].filter(isOnPage)
);

describe('the HTML page searches what it shows', () => {
  test('a word the page shows is found', () => {
    const dom = openLongPromptPage();

    // The head of the long prompt is on the page, in the task of the
    // sub-agent's block.
    search(dom, TASK_HEAD);

    const task = dom.document.querySelector('.entry.task');
    expect(task).toBeTruthy();
    expect(task?.textContent ?? '').toContain(TASK_HEAD);
    expect(isOnPage(task)).toBe(true);
  });

  test('a word the readable view cut away is not found', () => {
    const dom = openLongPromptPage();

    // The tail of the long prompt is not on the page: the readable view cut
    // it. A search must not find a word the reader cannot read.
    search(dom, TASK_TAIL);

    expect(visibleEntries(dom)).toHaveLength(0);
  });

  test('a word the readable view cut away of a tool prompt is not found', () => {
    const dom = openLongPromptPage();

    // The same holds for a call's own prompt: the page shows the cut, so
    // the index holds the cut.
    search(dom, CALL_TAIL);

    expect(visibleEntries(dom)).toHaveLength(0);
  });

  test('a word the page shows of a tool prompt is found', () => {
    const dom = openLongPromptPage();

    search(dom, CALL_HEAD);

    const tool = dom.document.querySelector('.entry.tool');
    expect(tool).toBeTruthy();
    expect(isOnPage(tool)).toBe(true);
  });
});

/**
 * A sub-agent's result long enough for the readable view to cut it.
 *
 * The head of the result is what the page shows, the tail is what the cut
 * took away.
 */
const RESULT_HEAD = 'resultheadmarker';
const RESULT_TAIL = 'resulttailmarker';
const longResult = `${RESULT_HEAD} ${'b'.repeat(900)} ${RESULT_TAIL}`;

/** The page with a long sub-agent result in it. */
const longResultPage = (): string => {
  const result = buildExportFromRecords({
    root: session('ses_root', { title: 'Root' }),
    sessions: [session('ses_root', { title: 'Root' })],
    records: new Map([
      ['ses_root', [
        subagentReport('ses_root', 'r1', 2100, { childSessionID: 'ses_child', output: longResult }),
      ]],
    ]),
  }, 'readable');

  return renderExportHtml(result.projection, {
    title: 'Root',
    mode: 'readable',
    findings: result.timeline.findings, excluded: result.timeline.excluded,
    sessionCount: result.timeline.sessions.size,
  });
};

/** The page with a long sub-agent result in it, with its own script running. */
const openLongResultPage = (): Window => {
  const html = longResultPage();
  const dom = new Window({ url: 'https://localhost/' });
  dom.document.write(html);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!script) throw new Error('The export wrote no page script');
  new Function('document', script[1])(dom.document);
  return dom;
};

describe('the HTML page searches what it shows of a sub-agent result', () => {
  test('a word the page shows of a sub-agent result is found', () => {
    const dom = openLongResultPage();

    search(dom, RESULT_HEAD);

    const result = dom.document.querySelector('.entry.result');
    expect(result).toBeTruthy();
    expect(isOnPage(result)).toBe(true);
  });

  test('a word the readable view cut away of a sub-agent result is not found', () => {
    const dom = openLongResultPage();

    // The tail of the sub-agent's result is not on the page: the readable
    // view cut it. A search must not find a word the reader cannot read.
    search(dom, RESULT_TAIL);

    expect(visibleEntries(dom)).toHaveLength(0);
  });
});
