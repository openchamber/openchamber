import { describe, expect, test } from 'bun:test';

import { markdownToPlainText } from './markdownText';

describe('markdownToPlainText', () => {
  test('keeps text the renderer shows literally', () => {
    const cases = [
      ['Rename snake_case_name and GRPC_METHOD_CONSTANT.', 'Rename snake_case_name and GRPC_METHOD_CONSTANT.'],
      ['glob **/*.ts and *.md', 'glob **/*.ts and *.md'],
      ['run 2*3*4 times', 'run 234 times'],
      ['__init__ runs first.', 'init runs first.'],
      ['**bold_with_underscore**', 'bold_with_underscore'],
      ['see [the_text](https://example.com/a_b_c)', 'see the_text'],
      ['![alt_text](img_x.png)', 'alt_text'],
    ];
    for (const [input, expected] of cases) {
      expect(markdownToPlainText(input)).toBe(expected);
    }
  });

  test('unwraps emphasis the renderer applies, including nested runs', () => {
    const cases = [
      ['An _italic_ and **bold** and ***both*** word, plus __strong__ text.', 'An italic and bold and both word, plus strong text.'],
      ['**Key: *reason* here**', 'Key: reason here'],
      ['*a **b** c*', 'a b c'],
      ['**a**_b_', 'ab'],
      ['_a_**b**', 'ab'],
    ];
    for (const [input, expected] of cases) {
      expect(markdownToPlainText(input)).toBe(expected);
    }
  });

  test('keeps code spans and fences verbatim', () => {
    const cases = [
      ['`run_task_x`', 'run_task_x'],
      ['``a`b``', 'a`b'],
      ['```ts\nconst snake_case = __init__; // <!-- keep -->\n```', 'const snake_case = __init__; // <!-- keep -->'],
      ['~~~\nraw_underscore\n~~~', 'raw_underscore'],
      ['code `<!-- hide -->` here', 'code <!-- hide --> here'],
      ['before ```a_b``` after', 'before a_b after'],
      ['````code````', 'code'],
    ];
    for (const [input, expected] of cases) {
      expect(markdownToPlainText(input)).toBe(expected);
    }
  });

  test('restores a fence nested inside another fence without leaking a placeholder', () => {
    const nested = '~~~md\n```js\ninner_b\n```\n~~~';
    const kept = markdownToPlainText(nested);
    expect(kept).toBe('inner_b');
    expect(kept).not.toContain('\uE000');
    expect(markdownToPlainText(nested, { code: 'drop' })).toBe('');
  });

  test('keeps the body of a fence the source bound cut open', () => {
    expect(markdownToPlainText('```ts\nconst a_b = 1; // <!-- keep -->')).toBe('const a_b = 1; // <!-- keep -->');
    expect(markdownToPlainText('intro\n```\nbody_x **bold**')).toBe('intro body_x **bold**');
    expect(markdownToPlainText('```ts\nconst a_b = 1;', { code: 'drop' })).toBe('');
  });

  test('drops block markers and keeps indented code lines', () => {
    expect(markdownToPlainText('* first step\n* second step\n- third_item\n1. ordered\n> quoted'))
      .toBe('first step second step third_item ordered quoted');
    expect(markdownToPlainText('    - indented code item')).toBe('- indented code item');
    expect(markdownToPlainText('* * *')).toBe('');
  });

  test('drops fenced code in drop mode and unwraps inline code', () => {
    expect(markdownToPlainText('```ts\nconst x = 1;\n```\nthen `a_b` stays', { code: 'drop' }))
      .toBe('then a_b stays');
    expect(markdownToPlainText('Use `snake_case` here', { code: 'drop' })).toBe('Use snake_case here');
  });

  test('keeps a private-use sentinel the text itself contains', () => {
    expect(markdownToPlainText('literal \uE0000\uE000 sentinel and `code_span`'))
      .toBe('literal \uE0000\uE000 sentinel and code_span');
  });

  test('does not stall on long delimiter runs', () => {
    const inputs = [
      '`'.repeat(4000),
      '~'.repeat(4000),
      '`'.repeat(1800) + 'a' + '`'.repeat(1100) + 'a' + '`'.repeat(900),
      'a' + '`'.repeat(4000) + 'b',
      '`'.repeat(2000) + 'a' + '`'.repeat(1999),
    ];
    for (const input of inputs) {
      const started = performance.now();
      markdownToPlainText(input);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});
