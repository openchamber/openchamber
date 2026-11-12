import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { FileContentSearchMatch } from '@/lib/api/types';
import { FileContentSearchResults } from './FileContentSearchResults';
import { fileContentMatchKey, type FileContentSearchState } from './useFileContentSearch';

const render = (state: FileContentSearchState, activeMatchKey: string | null = null) => renderToStaticMarkup(
  <I18nProvider>
    <FileContentSearchResults state={state} activeMatchKey={activeMatchKey} onOpen={() => {}} />
  </I18nProvider>,
);

describe('FileContentSearchResults', () => {
  test('says there are no matches only for a search that finished', () => {
    expect(render({ status: 'results', matches: [], stopped: null })).toContain('No matches.');
  });

  test('says the search stopped when the deadline came before any match', () => {
    const markup = render({ status: 'results', matches: [], stopped: 'deadline' });
    expect(markup).not.toContain('No matches.');
    expect(markup).toContain('stopped after 30 seconds');
  });

  test('marks only the opened line when one file matches on several lines', () => {
    const match = (line: number): FileContentSearchMatch => ({
      path: '/repo/a.md', relativePath: 'a.md', line, column: 1, text: 'agents', ranges: [[0, 6]], cutStart: false,
    });
    const matches = [match(3), match(7)];
    const markup = render({ status: 'results', matches, stopped: null }, fileContentMatchKey(matches[1]));
    expect(markup.match(/bg-interactive-selection /g)?.length).toBe(1);
  });
});
