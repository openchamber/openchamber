import { describe, expect, test } from 'bun:test';

import type { Link, Paragraph, Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { formatSelectionMarkdown, isolateMessageMarkdown } from './selectionMarkdown';

const firstLink = (markdown: string): Link => {
    const tree = unified().use(remarkParse).parse(markdown) as Root;
    return (tree.children[0] as Paragraph).children[0] as Link;
};
import type { SelectableUnit } from './selectableUnits';

const answer = (key: string, ...segments: string[]): SelectableUnit => ({
    kind: 'answer', key, messageId: key, segments, providerID: null, modelID: null,
});

describe('isolateMessageMarkdown', () => {
    test('inlines a reference whose label has escaped brackets', () => {
        const source = 'See the [first guide][a\\[b] now.\n\n[a\\[b]: https://example.com/one "One"';
        expect(isolateMessageMarkdown(source, 'm1-').trim()).toBe('See the [first guide](https://example.com/one "One") now.');
    });

    test('inlines collapsed, shortcut and image references', () => {
        const source = '[Docs][] and [Docs] and ![logo][img]\n\n[docs]: https://example.com/docs\n[img]: <https://example.com/a b.png>';
        expect(isolateMessageMarkdown(source, 'm1-').trim()).toBe(
            '[Docs](https://example.com/docs) and [Docs](https://example.com/docs) and ![logo](<https://example.com/a b.png>)',
        );
    });

    test('keeps escapes and nested images inside link text', () => {
        const source = '[![alt \\] x][img]][site]\n\n[img]: /i.png\n[site]: https://example.com/(x)';
        expect(isolateMessageMarkdown(source, 'm1-').trim()).toBe('[![alt \\] x](/i.png)](https://example.com/\\(x\\))');
    });

    test('leaves brackets without a definition and code alone', () => {
        const source = 'A literal [img] and `[x][y]`.\n\n```\n[x]: not a definition\n```';
        expect(isolateMessageMarkdown(source, 'm1-')).toBe(source);
    });

    test('prefixes footnote references and definitions', () => {
        const source = 'Text.[^1]\n\n[^1]: Note with [link][a].\n\n[a]: https://example.com';
        expect(isolateMessageMarkdown(source, 'm2-').trim()).toBe('Text.[^m2-1]\n\n[^m2-1]: Note with [link](https://example.com).');
    });

    test('keeps a destination and title that hold character references', () => {
        const source = '[x][a]\n\n[a]: /?x=&amp;copy; "T &amp;amp; U"';
        const original = firstLink('[x](/?x=&amp;copy; "T &amp;amp; U")');
        const link = firstLink(isolateMessageMarkdown(source, 'm1-'));
        expect([link.url, link.title]).toEqual(['/?x=&copy;', 'T &amp; U']);
        expect([link.url, link.title]).toEqual([original.url, original.title]);
    });

    test('closes a fence the message left open', () => {
        expect(isolateMessageMarkdown('Code:\n\n```js\nconst a = 1;', 'm1-')).toBe('Code:\n\n```js\nconst a = 1;\n```');
        expect(isolateMessageMarkdown('````\na\n````', 'm1-')).toBe('````\na\n````');
    });
});

describe('formatSelectionMarkdown', () => {
    test('keeps each message’s references and footnotes to itself', () => {
        const markdown = formatSelectionMarkdown([
            answer('a1', 'One [link][a\\[b].[^1]\n\n[a\\[b]: https://example.com/one\n[^1]: First.'),
            { kind: 'prompt', key: 'p2', messageId: 'p2', text: 'Literal [img] here.' },
            answer('a2', 'Two [link][a\\[b] and [img].[^1]\n\n[a\\[b]: https://example.com/two\n[^1]: Second.'),
        ]);
        expect(markdown).toBe([
            '**Assistant**\n\nOne [link](https://example.com/one).[^m1-1]\n\n[^m1-1]: First.',
            '**User**\n\nLiteral [img] here.',
            '**Assistant**\n\nTwo [link](https://example.com/two) and [img].[^m3-1]\n\n[^m3-1]: Second.',
        ].join('\n\n---\n\n'));
    });

    test('isolates the text parts of one answer from each other', () => {
        expect(formatSelectionMarkdown([answer('a1', '[x]\n\n[x]: https://a.example', 'Then [x].')]))
            .toBe('**Assistant**\n\n[x](https://a.example)\n\nThen [x].');
    });
});
