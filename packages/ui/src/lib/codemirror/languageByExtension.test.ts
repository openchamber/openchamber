import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, highlightingFor } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { highlightTree, tags } from '@lezer/highlight';

import { languageByExtension, loadLanguageByExtension } from './languageByExtension';

function markdownState(doc: string) {
  const extension = languageByExtension('test.md');
  if (!extension) throw new Error('Missing Markdown extension');
  return EditorState.create({ doc, extensions: [extension] });
}

describe('Markdown code backgrounds', () => {
  test('keeps the code background translucent so interaction highlights can show through', () => {
    const state = markdownState('Plain text and `code`');
    const codeClass = highlightingFor(state, [tags.monospace]);
    expect(codeClass).not.toBeNull();

    const rules = state.facet(EditorView.styleModule).flatMap((module) => module.getRules().split('\n'));
    const codeRule = rules.find((rule) => rule.startsWith(`.${codeClass} {`));
    if (!codeRule) throw new Error('Missing Markdown code background rule');

    const opacity = codeRule.match(/background-color: color-mix\(in srgb, var\(--surface-muted\) (\d+)%, transparent\)/);
    expect(opacity).not.toBeNull();
    if (!opacity) throw new Error('Markdown code background must be translucent');
    const percentage = Number(opacity[1]);
    expect(percentage).toBeGreaterThan(0);
    expect(percentage).toBeLessThan(100);
  });

  const cases = [
    { doc: 'probe_word and `probe_word`', code: ['probe_word'] },
    { doc: 'before `prefix_probe_word_suffix` after', code: ['prefix_probe_word_suffix'] },
    { doc: 'probe_word\n```\nprobe_word\n```', code: ['probe_word'] },
    { doc: '', code: [] },
    { doc: 'An unmatched `backtick', code: [] },
  ];
  for (const { doc, code } of cases) {
    test(`applies the code background only to code in ${JSON.stringify(doc)}`, () => {
      const state = markdownState(doc);
      const tree = ensureSyntaxTree(state, state.doc.length, 100);
      if (!tree) throw new Error('Markdown parsing did not complete');
      const codeClass = highlightingFor(state, [tags.monospace]);
      const codeText: string[] = [];

      highlightTree(tree, { style: (styleTags) => highlightingFor(state, styleTags) }, (from, to, classes) => {
        if (codeClass && classes.split(' ').includes(codeClass)) {
          codeText.push(state.sliceDoc(from, to));
        }
      });

      expect(codeText).toEqual(code);
      expect(state.doc.toString()).toBe(doc);
    });
  }
});

describe('loadLanguageByExtension', () => {
  test('resolves extensions the CodeMirror catalog lacks through the shared extension map', async () => {
    expect(await loadLanguageByExtension('views/page.tpl')).not.toBeNull();
    expect(await loadLanguageByExtension('logs/events.jsonl')).not.toBeNull();
    expect(await loadLanguageByExtension('src/App.svelte')).not.toBeNull();
  });

  test('keeps plain text and unknown extensions unhighlighted', async () => {
    expect(await loadLanguageByExtension('notes/readme.txt')).toBeNull();
    expect(await loadLanguageByExtension('data/blob.zzqx')).toBeNull();
  });
});
