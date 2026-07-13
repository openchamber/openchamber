import { describe, test, expect } from 'bun:test';
import rehypeMarkSearchMatches, { findSegmentMatchFragments } from './rehypeMarkSearchMatches';

// Minimal inline HAST types to avoid importing the 'hast' package
interface HastText { type: 'text'; value: string }
interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastChild[];
}
type HastChild = HastText | HastElement | { type: string };
interface HastRoot { type: 'root'; children: HastChild[] }

// Local aliases to match test code below
type Root = HastRoot;
type Text = HastText;
type Element = HastElement;

describe('findSegmentMatchFragments', () => {
  test('gives every fragment of one cross-boundary match the same occurrence', () => {
    const regex = /bold/gi;

    expect(findSegmentMatchFragments(['prefix ', 'bo', 'ld suffix'], regex)).toEqual([
      { segmentIndex: 1, start: 0, end: 2, occurrence: 0 },
      { segmentIndex: 2, start: 0, end: 2, occurrence: 0 },
    ]);
  });

  test('keeps cross-boundary matches when the same sequence has an ordinary match', () => {
    const regex = /foo/gi;

    expect(findSegmentMatchFragments(['foo then f', 'oo'], regex)).toEqual([
      { segmentIndex: 0, start: 0, end: 3, occurrence: 0 },
      { segmentIndex: 0, start: 9, end: 10, occurrence: 1 },
      { segmentIndex: 1, start: 0, end: 2, occurrence: 1 },
    ]);
  });

  test('applies a part-global occurrence offset to a later inline sequence', () => {
    expect(findSegmentMatchFragments(['foo'], /foo/gi, 1)).toEqual([
      { segmentIndex: 0, start: 0, end: 3, occurrence: 1 },
    ]);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Root HAST tree with a single paragraph containing text. */
function makeTree(text: string): Root {
  return {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'p',
        properties: {},
        children: [{ type: 'text', value: text }],
      } as Element,
    ],
  };
}

/** Run the plugin synchronously and return the transformed tree. */
function run(
  tree: Root,
  query: string,
  opts: { caseSensitive?: boolean; wholeWord?: boolean; isRegex?: boolean } = {},
): Root {
  const plugin = rehypeMarkSearchMatches({
    query,
    caseSensitive: opts.caseSensitive ?? false,
    wholeWord: opts.wholeWord ?? false,
    isRegex: opts.isRegex ?? false,
    messageId: 'test-msg-id',
  });
  // call the transformer returned by the plugin
  plugin(tree);
  return tree;
}

/** Collect all mark elements from the tree. */
function collectMarks(tree: Root): Element[] {
  const marks: Element[] = [];
  function walk(children: HastChild[]) {
    for (const node of children) {
      if (node.type === 'element') {
        const el = node as Element;
        if (el.tagName === 'mark') marks.push(el);
        walk(el.children);
      }
    }
  }
  walk(tree.children);
  return marks;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('rehypeMarkSearchMatches plugin', () => {
  test('numbers matches across block sequences within one part', () => {
    const tree: Root = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', children: [{ type: 'text', value: 'foo' }] } as Element,
        { type: 'element', tagName: 'p', children: [{ type: 'text', value: 'foo' }] } as Element,
      ],
    };

    const marks = collectMarks(run(tree, 'foo'));
    expect(marks.map((mark) => mark.properties?.['data-search-occurrence'])).toEqual([0, 1]);
  });

  test('wraps a matching word in <mark data-search-match>', () => {
    const tree = run(makeTree('hello world'), 'world');
    const marks = collectMarks(tree);
    expect(marks).toHaveLength(1);
    expect((marks[0].children[0] as Text).value).toBe('world');
    expect(marks[0].properties?.['data-search-match']).toBe(true);
  });

  test('does nothing when query is empty', () => {
    const tree = run(makeTree('hello world'), '');
    expect(collectMarks(tree)).toHaveLength(0);
  });

  test('is case-insensitive by default', () => {
    const tree = run(makeTree('Hello World'), 'hello');
    const marks = collectMarks(tree);
    expect(marks).toHaveLength(1);
    expect((marks[0].children[0] as Text).value).toBe('Hello');
  });

  test('is case-sensitive when flag is set', () => {
    const tree = run(makeTree('Hello hello'), 'hello', { caseSensitive: true });
    const marks = collectMarks(tree);
    // Only the lowercase 'hello' should match
    expect(marks).toHaveLength(1);
    expect((marks[0].children[0] as Text).value).toBe('hello');
  });

  test('handles multiple matches in one text node', () => {
    const tree = run(makeTree('foo bar foo'), 'foo');
    expect(collectMarks(tree)).toHaveLength(2);
  });

  test('preserves non-matching text around matches', () => {
    const tree = run(makeTree('aXXb'), 'XX');
    const p = (tree.children[0] as Element).children;
    expect(p).toHaveLength(3);
    expect((p[0] as Text).value).toBe('a');
    expect((p[1] as Element).tagName).toBe('mark');
    expect((p[2] as Text).value).toBe('b');
  });

  test('marks text inside inline <code> elements (inline code is searchable)', () => {
    // Inline code like `foo` IS highlighted — only <pre> subtrees (fenced
    // blocks rendered by SyntaxHighlighter) are excluded from highlighting.
    const codeTree: Root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            { type: 'text', value: 'use ' },
            {
              type: 'element',
              tagName: 'code',
              properties: {},
              children: [{ type: 'text', value: 'foo' }],
            } as Element,
            { type: 'text', value: ' here' },
          ],
        } as Element,
      ],
    };
    const result = run(codeTree, 'foo');
    expect(collectMarks(result)).toHaveLength(1);
    expect((collectMarks(result)[0].children[0] as Text).value).toBe('foo');
  });

  test('does not mark text inside <pre> elements', () => {
    const preTree: Root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'pre',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'code',
              properties: {},
              children: [{ type: 'text', value: 'foo bar' }],
            } as Element,
          ],
        } as Element,
      ],
    };
    const result = run(preTree, 'foo');
    expect(collectMarks(result)).toHaveLength(0);
  });

  test('whole-word flag does not match partial words', () => {
    const tree = run(makeTree('argument parser'), 'arg', { wholeWord: true });
    // 'arg' inside 'argument' should not match as a whole word
    expect(collectMarks(tree)).toHaveLength(0);
  });

  test('regex mode works', () => {
    const tree = run(makeTree('cat bat sat'), 'b.t', { isRegex: true });
    const marks = collectMarks(tree);
    expect(marks).toHaveLength(1);
    expect((marks[0].children[0] as Text).value).toBe('bat');
  });

  test('invalid regex produces no marks and does not throw', () => {
    let threw = false;
    try {
      run(makeTree('hello'), '[unclosed', { isRegex: true });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    const tree = run(makeTree('hello'), '[unclosed', { isRegex: true });
    expect(collectMarks(tree)).toHaveLength(0);
  });

  test('highlights cross-boundary matches spanning text and inline <code>', () => {
    // Query spans across a text node and an inline <code> element.
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            { type: 'text', value: 'the store but ' },
            {
              type: 'element',
              tagName: 'code',
              properties: {},
              children: [{ type: 'text', value: 'Header.tsx' }],
            } as Element,
            { type: 'text', value: ' never reads show' },
          ],
        } as Element,
      ],
    };
    const result = run(tree, 'the store but Header.tsx');
    const marks = collectMarks(result);
    // Tree-preserving: one mark per overlapping text node (text node + code text).
    expect(marks).toHaveLength(2);
    expect((marks[0].children[0] as Text).value).toBe('the store but ');
    expect((marks[1].children[0] as Text).value).toBe('Header.tsx');
  });

  test('highlights cross-boundary matches spanning inline <code> and trailing text', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            { type: 'text', value: 'use ' },
            {
              type: 'element',
              tagName: 'code',
              properties: {},
              children: [{ type: 'text', value: 'foo' }],
            } as Element,
            { type: 'text', value: ' and bar' },
          ],
        } as Element,
      ],
    };
    const result = run(tree, 'foo and');
    const marks = collectMarks(result);
    // Tree-preserving: one mark inside <code> for "foo", one text mark for " and".
    expect(marks).toHaveLength(2);
    expect((marks[0].children[0] as Text).value).toBe('foo');
    expect((marks[1].children[0] as Text).value).toBe(' and');
  });

  test('preserves per-node highlighting when no cross-boundary match exists', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            { type: 'text', value: 'use ' },
            {
              type: 'element',
              tagName: 'code',
              properties: {},
              children: [{ type: 'text', value: 'foo' }],
            } as Element,
            { type: 'text', value: ' here' },
          ],
        } as Element,
      ],
    };
    const result = run(tree, 'foo');
    const marks = collectMarks(result);
    expect(marks).toHaveLength(1);
    // The mark should be inside the <code> element, not flattening the whole paragraph
    expect((marks[0].children[0] as Text).value).toBe('foo');
  });
});

describe('cross-boundary match formatting preservation', () => {
  test('preserves plain-text prefix node when match spans element boundary', () => {
    // "hello <strong>world</strong> friend" — searching "world friend"
    // The "hello " prefix is NOT part of any match and should survive as a text node.
    const tree: Root = {
      type: 'root',
      children: [{
        type: 'element', tagName: 'p', properties: {},
        children: [
          { type: 'text', value: 'hello ' } as Text,
          {
            type: 'element', tagName: 'strong', properties: {},
            children: [{ type: 'text', value: 'world' } as Text],
          } as Element,
          { type: 'text', value: ' friend' } as Text,
        ],
      } as Element],
    };
    const result = run(tree, 'world friend');
    const marks = collectMarks(result);
    // Tree-preserving: one mark inside <strong> for "world", one for " friend".
    expect(marks).toHaveLength(2);
    // The "hello " prefix must still be a text node at the start of the paragraph
    const p = (result.children[0] as Element).children;
    // First child must be the "hello " text (not part of the mark)
    expect(p[0].type).toBe('text');
    expect((p[0] as Text).value).toBe('hello ');
  });

  test('preserves italic element before cross-boundary match region', () => {
    // "<em>prefix</em> fooBar" where "fooBar" spans text " foo" + code "Bar"
    const tree: Root = {
      type: 'root',
      children: [{
        type: 'element', tagName: 'p', properties: {},
        children: [
          {
            type: 'element', tagName: 'em', properties: {},
            children: [{ type: 'text', value: 'prefix' } as Text],
          } as Element,
          { type: 'text', value: ' foo' } as Text,
          {
            type: 'element', tagName: 'code', properties: {},
            children: [{ type: 'text', value: 'Bar' } as Text],
          } as Element,
        ],
      } as Element],
    };
    const result = run(tree, 'fooBar', { caseSensitive: false });
    const marks = collectMarks(result);
    // Tree-preserving: one mark for "foo" (in text node " foo"), one for "Bar" inside <code>.
    expect(marks).toHaveLength(2);
    // <em>prefix</em> must survive as an element
    const p = (result.children[0] as Element).children;
    expect(p[0].type).toBe('element');
    expect((p[0] as Element).tagName).toBe('em');
  });

  // NOTE (Greptile review PR#1434 P2c): Regression test for the formatting
  // preservation fix. The old flat-text approach stripped inline wrappers from
  // content inside the cross-boundary region even when that content was *part of
  // the match* (e.g. "bold" inside <strong> that matched the query). The new
  // tree-preserving walk keeps element wrappers intact.
  test('preserves inline element wrapper that contains matched text in cross-boundary region', () => {
    // "<strong>bold</strong> matching tail" — query "bold matching"
    // The match starts inside <strong>. With the old approach <strong> was flattened
    // to plain text. The fix keeps the wrapper and places the mark inside it.
    const tree: Root = {
      type: 'root',
      children: [{
        type: 'element', tagName: 'p', properties: {},
        children: [
          {
            type: 'element', tagName: 'strong', properties: {},
            children: [{ type: 'text', value: 'bold' } as Text],
          } as Element,
          { type: 'text', value: ' matching tail' } as Text,
        ],
      } as Element],
    };
    const result = run(tree, 'bold matching');
    const marks = collectMarks(result);
    // Two marks: "bold" inside <strong>, " matching" from the trailing text node.
    expect(marks).toHaveLength(2);
    expect((marks[0].children[0] as Text).value).toBe('bold');
    expect((marks[1].children[0] as Text).value).toBe(' matching');
    // The <strong> wrapper must survive — its first (and only) child is now a <mark>.
    const p = (result.children[0] as Element).children;
    expect(p[0].type).toBe('element');
    expect((p[0] as Element).tagName).toBe('strong');
    const strong = p[0] as Element;
    expect(strong.children[0].type).toBe('element');
    expect((strong.children[0] as Element).tagName).toBe('mark');
    // " tail" must remain as plain text, not wrapped in a mark.
    const lastChild = p[p.length - 1];
    expect(lastChild.type).toBe('text');
    expect((lastChild as Text).value).toBe(' tail');
  });
});
