import { describe, expect, test } from 'bun:test';
import { marked } from 'marked';
import { formatSelectedConversationMarkdown, type SelectedConversationMessage } from './selectionMarkdown';

const labels = { user: '用户', assistant: '助手', attachment: '附件' };
const message = (segments: readonly string[], role: 'user' | 'assistant' = 'assistant'): SelectedConversationMessage => ({ key: 'same-key', role, segments });
const format = (...messages: SelectedConversationMessage[]) => formatSelectedConversationMarkdown(messages, labels);

describe('selected conversation Markdown', () => {
    test('preserves raw block structure and localized roles in selection order', () => {
        const source = '# Heading\n\n- first\n- second\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> quote\n\n[link](https://example.com)\n\n```ts\nconst a = 1;\n```';
        expect(format(message([source], 'user'), message(['answer']))).toBe(`**用户**\n\n${source}\n\n---\n\n**助手**\n\nanswer`);
        expect(format()).toBe('');
    });
    test('preserves initial indentation, blank lines, Unicode and segments', () => {
        const source = '    const value = "用户";\n\n    [ref]\n';
        expect(format(message([source, '尾段']))).toBe(`**助手**\n\n${source}\n\n尾段`);
    });
    test('isolates full, collapsed, shortcut and image references across segments', () => {
        const result = format(message(['[text][Docs] [Docs][] [Docs] ![image][Docs]', '[Docs]: https://one.example/docs "First"']), message(['[text][Docs] [Docs][] [Docs]\n\n[Docs]: https://two.example/docs "Second"']));
        expect(result).toContain('[text][oc-1-Docs] [Docs][oc-1-Docs] [Docs][oc-1-Docs] ![image][oc-1-Docs]');
        expect(result).toContain('[oc-1-Docs]: https://one.example/docs "First"');
        expect(result).toContain('[oc-2-Docs]: https://two.example/docs "Second"');
        expect(marked.parse(result)).toContain('href="https://one.example/docs"');
        expect(marked.parse(result)).toContain('href="https://two.example/docs"');
    });
    test('preserves nested reference images and multiline quote prefixes', () => {
        const source = '[![image][img]][page]\n\n> [a\n> b][page]\n\n[img]: https://example.com/image\n[page]: https://example.com/page';
        const result = format(message([source]));
        expect(result).toContain('[![image][oc-1-img]][oc-1-page]');
        expect(result).toContain('> [a\n> b][oc-1-page]');
        expect(marked.parse(result)).toContain('<img src="https://example.com/image"');
    });
    test('unresolved references cannot bind to another message', () => {
        const result = format(message(['Use [missing] literally.']), message(['[missing]: https://example.com']));
        expect(marked.parse(result)).toContain('<p>Use [missing] literally.</p>');
        expect(marked.parse(result)).not.toContain('<a href=');
    });
    test('isolates footnotes, undefined footnotes and multiline definitions', () => {
        const source = 'Text[^n] and [^missing].\n\n[^n]: First line\n    continuation';
        const result = format(message([source]), message([source]));
        expect(result).toContain('Text[^oc-1-n] and \\[^missing].');
        expect(result).toContain('[^oc-1-n]: First line\n    continuation');
        expect(result).toContain('[^oc-2-n]: First line');
        const unresolved = format(message(['Text[^missing].']), message(['[^missing]: Other message note']));
        expect(unresolved).toContain('Text\\[^missing].');
        expect(marked.parse(unresolved)).toContain('Text[^missing].');
    });
    test('leaves fenced, inline and indented code unchanged', () => {
        const code = '````md\n[x] [^n]\n```\n````\n\n~~~md\n[x] [^n]\n~~~\n\n    [x] [^n]\n\n`[x] [^n]` and `` `[x]` [^n] ``';
        const result = format(message([code, '[x] [^n]\n\n[x]: https://example.com\n[^n]: note']));
        expect(result).toContain(code);
        expect(result).toContain('[x][oc-1-x] [^oc-1-n]');
    });
    test('preserves CRLF and tab-indented code inside lists', () => {
        const source = '- item\r\n\r\n\t\t[^n]\r\n\r\n[^n]: note';
        const result = format(message([source]));
        expect(result).toContain('- item\r\n\r\n\t\t[^n]');
        expect(result).toContain('[^oc-1-n]: note');
    });
    test('preserves code containing escaped table pipes', () => {
        const source = '| x |\n| - |\n| `a \\| [^n]` |\n\n[^n]: note';
        expect(format(message([source]))).toContain('| `a \\| [^n]` |');
    });
    test('handles nested lists, blockquotes and tables', () => {
        const source = '> - ~~~~md\n>   [x] [^n]\n>   ~~~~\n>\n> [x] [^n]\n\n- outer\n  - inner\n\n        [x] [^n]\n\n| code | prose |\n| --- | --- |\n| `[x] [^n]` | [x] |\n\n[x]: https://example.com\n[^n]: note';
        const result = format(message([source]));
        expect(result).toContain('>   [x] [^n]\n>   ~~~~');
        expect(result).toContain('        [x] [^n]');
        expect(result).toContain('| `[x] [^n]` | [x][oc-1-x] |');
        expect(result).toContain('> [x][oc-1-x] [^oc-1-n]');
    });
    for (const opening of ['```ts', '~~~~~js', '> ```ts', '- ```ts', '> - ~~~~js']) test(`closes unfinished ${opening} before later segments`, () => {
        const prefix = opening.startsWith('> -') ? '>   ' : opening.startsWith('>') ? '> ' : opening.startsWith('-') ? '  ' : '';
        const fence = opening === '~~~~~js' ? '~~~~~' : opening.includes('~') ? '~~~~' : '```';
        const result = format(message([`${opening}\n${prefix}const value = 1;`, '# next']), message(['final']));
        expect(result).toContain(`const value = 1;\n${prefix}${fence}\n\n\n# next`);
        expect(marked.parse(result)).toContain('<h1>next</h1>');
        expect(marked.parse(result)).toContain('<p>final</p>');
    });
    test('preserves escaped syntax and inline destinations/titles', () => {
        const source = '\\[x] \\[^n] [label](https://example.com/[x] "[^n]")\n\n[x]: https://example.com "[x] [^n]"';
        const result = format(message([source]));
        expect(result).toContain('\\[x] \\[^n] [label](https://example.com/[x] "[^n]")');
        expect(result).toContain('[oc-1-x]: https://example.com "[x] [^n]"');
    });
    test('links public/data attachments and escapes filenames', () => {
        const result = format({ ...message([]), attachments: [{ name: 'a [b]*.png', url: 'https://example.com/image.png' }, { name: 'data.png', url: 'data:image/png;base64,AAAA' }] });
        expect(result).toContain('[a \\[b\\]\\*.png](<https://example.com/image.png>)');
        expect(result).toContain('[data.png](<data:image/png;base64,AAAA>)');
    });
    for (const url of ['blob:https://example.com/id', 'file:///private/image.png', '/api/fs/raw?token=secret', 'https://example.com/api/fs/raw', 'https://example.com/image?token=secret', 'https://user:secret@example.com/image', 'http://localhost/image', 'http://127.0.0.1/image', 'http://10.0.0.1/image', 'http://172.16.0.1/image', 'http://192.168.1.1/image', 'http://169.254.169.254/image', 'http://[::1]/image', 'http://[::ffff:127.0.0.1]/image', 'https://machine.internal/image', 'https://example.com/image#secret']) test(`omits inaccessible URL ${url}`, () => {
        expect(format({ ...message([]), attachments: [{ name: 'image.png', url }] })).toBe('**助手**\n\n附件: image.png');
    });
});
