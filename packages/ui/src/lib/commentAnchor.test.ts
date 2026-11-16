import { describe, expect, test } from 'bun:test';

import { anchorComment, commentContext, textLineSource, type CommentLineSource } from './commentAnchor';

const file = (...lines: string[]) => textLineSource(lines.join('\n'));

const original = ['import a', 'function run() {', '  const value = compute();', '  return value;', '}', 'export default run;'];
// The comment sits on `const value = compute();`, line 3.
const comment = { startLine: 3, endLine: 3, code: '  const value = compute();', contextBefore: 'function run() {', contextAfter: '  return value;' };

describe('anchorComment', () => {
  test('stays where the code still is', () => {
    expect(anchorComment(file(...original), comment)).toEqual({ startLine: 3, endLine: 3 });
  });

  test('follows the code when lines are removed or added above it', () => {
    expect(anchorComment(file(...original.slice(1)), comment)).toEqual({ startLine: 2, endLine: 2 });
    expect(anchorComment(file('// one', '// two', ...original), comment)).toEqual({ startLine: 5, endLine: 5 });
  });

  test('follows reindented code', () => {
    const moved = ['if (ready) {', '    function run() {', '        const value = compute();', '        return value;', '    }', '}'];
    expect(anchorComment(file('// header', ...moved), comment)).toEqual({ startLine: 4, endLine: 4 });
  });

  test('follows a range of lines', () => {
    const range = { startLine: 3, endLine: 4, code: '  const value = compute();\n  return value;', contextBefore: 'function run() {', contextAfter: '}' };
    expect(anchorComment(file('// new', ...original), range)).toEqual({ startLine: 4, endLine: 5 });
  });

  test('tells repeated code apart by the lines around it', () => {
    const before = ['if (a) {', '  one();', '}', 'if (b) {', '  two();', '}'];
    const brace = { startLine: 6, endLine: 6, code: '}', contextBefore: '  two();' };
    expect(anchorComment(file(...before), brace)).toEqual({ startLine: 6, endLine: 6 });
    // Three lines go above: another brace now stands on line 3, the commented one too.
    expect(anchorComment(file(...before.slice(3)), brace)).toEqual({ startLine: 3, endLine: 3 });
    // A brace slides onto the old number; the commented one moved down.
    expect(anchorComment(file('if (a) {', '  one();', '}', 'if (c) {', '  three();', '}', 'if (b) {', '  two();', '}'), brace))
      .toEqual({ startLine: 9, endLine: 9 });
  });

  test('takes the nearest match when a comment has no stored neighbours', () => {
    const old = { startLine: 2, endLine: 2, code: 'same();' };
    expect(anchorComment(file('x', 'y', 'same();', 'z', 'z', 'z', 'same();'), old)).toEqual({ startLine: 3, endLine: 3 });
  });

  test('marks a rewritten line and keeps the comment by its surviving neighbour', () => {
    const rewritten = ['// added', 'import a', 'function run() {', '  const value = await load();', '  return value;', '}'];
    expect(anchorComment(file(...rewritten), comment)).toEqual({ startLine: 4, endLine: 4, changedCode: '  const value = await load();' });
  });

  test('marks a removed line and stays where it was', () => {
    const removed = ['import a', 'function run() {', '  return value;', '}'];
    expect(anchorComment(file(...removed), comment)).toEqual({ startLine: 3, endLine: 3, changedCode: '  return value;' });
  });

  test('uses the line after the comment when the one before is gone too', () => {
    const result = anchorComment(file('other();', 'different();', '  return value;'), comment);
    expect(result).toEqual({ startLine: 2, endLine: 2, changedCode: 'different();' });
  });

  test('keeps the numbers inside the file when nothing survived', () => {
    const far = { startLine: 40, endLine: 41, code: 'gone();\nalso gone();' };
    expect(anchorComment(file('a', 'b'), far)).toEqual({ startLine: 2, endLine: 2, changedCode: 'b' });
  });

  test('anchoring the result again gives the same place', () => {
    const source = file('}', '}', '}', '}', 'end');
    const gone = { startLine: 2, endLine: 2, code: 'target();', contextBefore: '}', contextAfter: 'end' };
    const once = anchorComment(source, gone);
    expect(once).toEqual({ startLine: 2, endLine: 2, changedCode: '}' });
    expect(anchorComment(source, { ...gone, ...once })).toEqual(once);
  });

  test('finds the code again once it is back', () => {
    const marked = { ...comment, startLine: 4 };
    expect(anchorComment(file(...original), marked)).toEqual({ startLine: 3, endLine: 3 });
  });

  test('leaves a comment on blank lines alone', () => {
    expect(anchorComment(file('a', 'b', 'c'), { startLine: 2, endLine: 2, code: '  ' })).toEqual({ startLine: 2, endLine: 2 });
  });

  describe('in a patch', () => {
    // Holds lines 10-12 only.
    const patch = (lines: string[]): CommentLineSource => ({ first: 10, last: 12, partial: true, lineAt: (line) => lines[line - 10] });

    test('leaves a comment whose lines the patch does not hold', () => {
      const outside = { startLine: 30, endLine: 30, code: 'elsewhere();' };
      expect(anchorComment(patch(['a', 'b', 'c']), outside)).toEqual({ startLine: 30, endLine: 30 });
    });

    test('does not take a comment the patch does not hold to the same text in a hunk', () => {
      const brace = { startLine: 30, endLine: 30, code: '}', contextBefore: 'elsewhere();' };
      expect(anchorComment(patch(['a', '}', 'c']), brace)).toEqual({ startLine: 30, endLine: 30 });
      // With its stored neighbour beside the match, it is the same code.
      expect(anchorComment(patch(['elsewhere();', '}', 'c']), brace)).toEqual({ startLine: 11, endLine: 11 });
    });

    test('follows code inside the hunk and marks code that changed there', () => {
      const inside = { startLine: 10, endLine: 10, code: 'b', contextBefore: 'a' };
      expect(anchorComment(patch(['a', 'b', 'c']), inside)).toEqual({ startLine: 11, endLine: 11 });
      expect(anchorComment(patch(['a', 'B2', 'c']), inside)).toEqual({ startLine: 11, endLine: 11, changedCode: 'B2' });
    });
  });
});

describe('commentContext', () => {
  test('stores the lines around a range and skips blank or missing ones', () => {
    const source = file('first', '', 'third', 'fourth');
    expect(commentContext(source, 3, 3)).toEqual({ contextAfter: 'fourth' });
    expect(commentContext(source, 1, 1)).toEqual({});
    expect(commentContext(source, 4, 4)).toEqual({ contextBefore: 'third' });
  });
});
