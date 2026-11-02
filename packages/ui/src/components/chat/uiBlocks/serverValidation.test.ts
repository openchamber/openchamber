import { expect, test } from 'bun:test';
import { closedUiBlocks, validateUiBlock } from './serverValidation';

const fence = '`'.repeat(3);
const source = 'root = Stack([missing])';

test('only explicit closed executable fences enter validation, including Markdown containers', () => {
  for (const prefix of ['', '> ', '  ']) {
    const text = `${prefix}${fence}openui-lang\n${prefix}${source}\n${prefix}${fence}\n`;
    expect(closedUiBlocks(text, false).map((block) => block.source)).toEqual([source]);
  }
  expect(closedUiBlocks(`- ${fence}openui-lang\n  ${source}\n  ${fence}\n`, false).map((block) => block.source)).toEqual([source]);
  expect(closedUiBlocks(`~~~openui-lang\r\n${source}\r\n~~~\r\n`, false).map((block) => block.source)).toEqual([source]);
  for (const text of [
    `${fence}openui-lang literal\n${source}\n${fence}\n`,
    `${fence}openui-lang\n${source}\n`,
    `${fence}openui-lang\n${source}\n${fence}suffix\n`,
    `${fence}\`markdown\n${fence}openui-lang\n${source}\n${fence}\n${fence}\`\n`,
  ]) expect(closedUiBlocks(text, true)).toEqual([]);
});

test('closure without a trailing newline waits for authoritative text end', () => {
  const text = `${fence}openui-lang\n${source}\n${fence}`;
  for (let offset = 0; offset <= text.length; offset++) expect(closedUiBlocks(text.slice(0, offset), false)).toEqual([]);
  expect(closedUiBlocks(text, true).map((block) => block.source)).toEqual([source]);
  expect(validateUiBlock(source)).toEqual(['Undefined names: missing']);
  expect(validateUiBlock('root = Stack([Text("ok")])')).toEqual([]);
});
