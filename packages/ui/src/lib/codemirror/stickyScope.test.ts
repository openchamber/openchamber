import { describe, expect, test } from 'bun:test';
import { EditorState, type Extension } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';

import { enclosingScopeLines } from './stickyScope';

const scopesAtLine = (lines: string[], lineNumber: number, language: Extension = javascript({ typescript: true })) => {
  const state = EditorState.create({ doc: lines.join('\n'), extensions: [language] });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  const line = state.doc.line(lineNumber);
  return enclosingScopeLines(state, line.from, line.from).map((scope) => scope.number);
};

describe('enclosingScopeLines', () => {
  const source = [
    'class Store {',
    '  load() {',
    '    const run = () => {',
    '      return 1;',
    '    };',
    '    return run();',
    '  }',
    '}',
    'const after = 1;',
  ];

  test('lists the declarations around a line, outermost first', () => {
    expect(scopesAtLine(source, 4)).toEqual([1, 2, 3]);
    expect(scopesAtLine(source, 6)).toEqual([1, 2]);
  });

  test('a declaration whose own line is in view, or that has ended, is not pinned', () => {
    expect(scopesAtLine(source, 2)).toEqual([1]);
    expect(scopesAtLine(source, 9)).toEqual([]);
  });

  test('works from indentation-based grammars too', () => {
    expect(scopesAtLine(['class A:', '    def f(self):', '        x = 1', '        return x'], 4, python())).toEqual([1, 2]);
  });
});
