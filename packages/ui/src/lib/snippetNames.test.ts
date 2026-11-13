import { describe, expect, test } from 'bun:test';
import type { Snippet } from '@/types/snippet';
import { snippetNameProblem, suggestSnippetName, uniqueSnippetName, withoutSnippetToken } from './snippetNames';

const snippet = (name: string, aliases: string[] = []): Snippet => ({
  name,
  content: `${name} body`,
  aliases,
  filePath: `/snippets/${name}.md`,
  source: 'global',
});

describe('snippet names', () => {
  test('a name or alias in use is taken, except by the snippet that owns it', () => {
    const review = snippet('review', ['rev']);
    const snippets = [review, snippet('deploy')];

    expect(snippetNameProblem('Review', snippets)).toBe('taken');
    expect(snippetNameProblem('rev', snippets)).toBe('taken');
    expect(snippetNameProblem('rev', snippets, review)).toBeNull();
    expect(snippetNameProblem('-bad', snippets)).toBe('invalid');
    expect(snippetNameProblem('fresh', snippets)).toBeNull();
  });

  test('a free name counts past names and aliases in use', () => {
    expect(uniqueSnippetName('new-snippet', [snippet('new-snippet'), snippet('other', ['new-snippet-2'])])).toBe('new-snippet-3');
  });

  test('a suggestion takes the first words, in Latin letters', () => {
    expect(suggestSnippetName('Fix the failing CI checks, then push', [])).toBe('fix-the-failing');
    expect(suggestSnippetName('Добренько, я це змерджив вже', [])).toBe('dobrenko-ia-tse');
    expect(suggestSnippetName('!!!', [snippet('snippet')])).toBe('snippet-2');
  });

  test('the typed token leaves the draft with its space', () => {
    expect(withoutSnippetToken('Fix the build #deploy and push', 'deploy')).toBe('Fix the build and push');
    expect(withoutSnippetToken('Fix #deploy-now then #deploy', 'deploy')).toBe('Fix #deploy-now then ');
  });
});
