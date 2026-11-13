import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TILE_TONES } from './visualKit';

describe('TILE_TONES', () => {
  test('a page gets the tile steps the app stylesheet sets for its theme', () => {
    const css = readFileSync(new URL('../../../styles/design-system.css', import.meta.url), 'utf8');
    const block = (selector: string) => css.match(new RegExp(`\\n  ${selector} \\{([^}]*)\\}`))?.[1] ?? '';
    for (const [variant, selector] of [['light', ':root'], ['dark', '\\.dark']] as const) {
      for (const [property, value] of Object.entries(TILE_TONES[variant])) {
        expect(block(selector)).toContain(`${property}: ${value};`);
      }
    }
  });
});
