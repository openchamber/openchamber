import { describe, expect, test } from 'bun:test';
import { Lexer, Marked } from 'marked';
import { pinMarkedAnchoredRules } from './markedAnchoredRules';

// Markdown touching every block and inline rule the pin replaces: headings,
// setext headings, rules, quotes, lists, code, fences, tables, HTML, link
// definitions, links, autolinks, emphasis, strikethrough, escapes and breaks.
const CORPUS = [
  '# Title',
  'Setext heading\n==============',
  'Paragraph with **bold**, *em*, ~~gone~~, `code`, a [link](https://a.example "t"), <https://b.example>, www.c.example and \\*escaped\\*.  \nHard break above.',
  '---',
  '> quoted line\n> > nested quote\ncontinued lazily',
  '- item one\n- item two\n  - nested\n\n1. first\n2) second',
  '    indented code\n    more',
  '```ts\nconst x = 1;\n```',
  '| a | b |\n|---|:-:|\n| 1 | 2 |',
  '<div>\nraw html\n</div>',
  '[ref]: https://ref.example "Ref"\n\nUse [ref] and [text][ref] and ![img](pic.png).',
  'trailing <span>inline</span> tag and an email@example.com',
].join('\n\n');

const lexAll = () => [new Marked({ gfm: true }), new Marked({ gfm: true, breaks: true }), new Marked({ pedantic: true })]
  .map((marked) => JSON.stringify(marked.lexer(CORPUS)));

describe('pinMarkedAnchoredRules', () => {
  // Runs before the pin, so `before` comes from marked's own rules.
  const before = lexAll();
  const pinned = pinMarkedAnchoredRules();

  test('replaces the anchored rules, and only once', () => {
    expect(pinned).toBeGreaterThan(20);
    expect(Lexer.rules.block.gfm.hr.sticky).toBe(true);
    expect(Lexer.rules.inline.gfm.emStrongRDelimAst.sticky).toBe(false);
    expect(pinMarkedAnchoredRules()).toBe(0);
  });

  test('lexes the same tokens as before', () => {
    expect(lexAll()).toEqual(before);
  });

  test('a rule matches from the start of each input, whatever the last match left', () => {
    const { hr } = Lexer.rules.block.gfm;
    expect(hr.exec('---\nafter')?.[0]).toBe('---\n');
    expect(hr.lastIndex).toBeGreaterThan(0);
    expect(hr.exec('***\n')?.[0]).toBe('***\n');
    expect(hr.exec('text\n---\n')).toBeNull();
  });

  // No timing test: the engines CI and current Safari run (Bun 1.4.3, the
  // JavaScriptCore in macOS 27.0.1) no longer retry a failed ^ match at every
  // position, so a growth test passes with or without the pin and can only
  // fail on noise. Older JavaScriptCore (Bun 1.3.11, Safari and iOS WebKit
  // before that release) took 14 s for the hr rule over 16,000 paragraphs and
  // still benefits; 'replaces the anchored rules' above is the guard.
});
