import { describe, expect, test } from 'bun:test';

import { PIERRE_SEPARATOR_CSS } from './pierreDiffTint';

describe('PIERRE_SEPARATOR_CSS', () => {
  test('only the expand glyphs hang in the gutter; "Expand all" stays after the label', () => {
    const gutterRule = PIERRE_SEPARATOR_CSS.match(/([^{}]*)\{\s*position: absolute;\s*right: 100%;/)?.[1] ?? '';
    expect(gutterRule).toContain('[data-expand-button]');
    for (const selector of gutterRule.split(',').filter((part) => part.includes('[data-expand-button]'))) {
      expect(selector).toContain(':not([data-expand-all-button])');
    }
  });
});
