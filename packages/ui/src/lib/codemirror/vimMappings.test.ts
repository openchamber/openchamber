import { describe, expect, test } from 'bun:test';

import { parseVimMappings } from './vimMappings';

describe('parseVimMappings', () => {
  test('reads mode-specific maps and skips comments and blank lines', () => {
    const parsed = parseVimMappings('" escape\ninoremap jk <Esc>\n\nnmap <silent> <Space>w :w<CR>');
    expect(parsed.invalidLines).toEqual([]);
    expect(parsed.mappings).toEqual([
      { context: 'insert', lhs: 'jk', rhs: '<Esc>', recursive: false },
      { context: 'normal', lhs: '<Space>w', rhs: ':w<CR>', recursive: true },
    ]);
  });

  test('a bare map covers normal, visual and operator-pending modes', () => {
    const contexts = parseVimMappings('noremap H ^').mappings.map((mapping) => mapping.context);
    expect(contexts).toEqual(['normal', 'visual', 'operatorPending']);
  });

  test('reports lines it cannot apply instead of guessing', () => {
    const parsed = parseVimMappings('set number\ninoremap jk\nnnoremap <expr> j v:count ? "j" : "gj"\ncnoremap :W :w\ninoremap jk <Esc>');
    expect(parsed.invalidLines).toEqual([1, 2, 3, 4]);
    expect(parsed.mappings).toHaveLength(1);
  });
});
