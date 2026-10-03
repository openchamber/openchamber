import { describe, expect, test } from 'bun:test';
import { EditorState, type Extension } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { go } from '@codemirror/lang-go';
import { rust } from '@codemirror/lang-rust';
import { markdown } from '@codemirror/lang-markdown';

import { readDocumentSymbols } from './documentSymbols';

const outline = (doc: string, language: Extension) => readDocumentSymbols(EditorState.create({ doc, extensions: [language] }), 5_000)
    .map(({ name, kind, line, depth }) => [name, kind, line, depth]);

describe('readDocumentSymbols', () => {
    test('lists TypeScript functions, arrow-function bindings, classes with their methods, and types', () => {
        const doc = [
            'export function foo() {}',
            'export const bar = async () => 2;',
            'const notAFunction = 3;',
            'class Baz {',
            '  method() {}',
            '  static helper = () => 1;',
            '}',
            'interface Shape { a: string }',
            'type Alias = string;',
            'enum Color { Red }',
        ].join('\n');
        expect(outline(doc, javascript({ typescript: true }))).toEqual([
            ['foo', 'function', 1, 0],
            ['bar', 'function', 2, 0],
            ['Baz', 'class', 4, 0],
            ['method', 'method', 5, 1],
            ['helper', 'method', 6, 1],
            ['Shape', 'class', 8, 0],
            ['Alias', 'type', 9, 0],
            ['Color', 'type', 10, 0],
        ]);
    });

    test('lists Python, Go and Rust declarations', () => {
        expect(outline('def foo():\n  pass\nclass Bar:\n  def m(self):\n    pass', python())).toEqual([
            ['foo', 'function', 1, 0],
            ['Bar', 'class', 3, 0],
            ['m', 'function', 4, 1],
        ]);
        expect(outline('package main\nfunc Foo() {}\nfunc (s *S) M() {}\ntype S struct {}', go())).toEqual([
            ['Foo', 'function', 2, 0],
            ['M', 'method', 3, 0],
            ['S', 'type', 4, 0],
        ]);
        expect(outline('fn foo() {}\nstruct S {}\nimpl S {\n  fn m(&self) {}\n}', rust())).toEqual([
            ['foo', 'function', 1, 0],
            ['S', 'class', 2, 0],
            ['S', 'class', 3, 0],
            ['m', 'function', 4, 1],
        ]);
    });

    test('lists Markdown headings indented by level', () => {
        expect(outline('# Title\ntext\n## Part one ##\nSetext\n---', markdown())).toEqual([
            ['Title', 'heading', 1, 0],
            ['Part one', 'heading', 3, 1],
            ['Setext', 'heading', 4, 1],
        ]);
    });

    test('lists nothing for a document without a parser', () => {
        expect(readDocumentSymbols(EditorState.create({ doc: 'plain text' }))).toEqual([]);
    });
});
