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
import { assistantMessage, subagentCall, type Record_ } from './fixtures';

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
    findings: result.timeline.findings,
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
 * not a block above it. A hidden block takes its whole subtree with it.
 */
const isOnPage = (entry: Element): boolean => {
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
