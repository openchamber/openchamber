import { describe, expect, test } from 'bun:test';

import { languageByExtension } from './codemirror/languageByExtension';
import { getLanguageFromExtension } from './toolHelpers';

describe('drawio language mapping', () => {
  test('uses XML highlighting for Shiki-backed surfaces', () => {
    expect(getLanguageFromExtension('diagram.drawio')).toBe('xml');
    expect(getLanguageFromExtension('diagram.dio')).toBe('xml');
  });

  test('uses a CodeMirror XML-compatible language for source editing', () => {
    expect(languageByExtension('diagram.drawio')).not.toBeNull();
    expect(languageByExtension('diagram.dio')).not.toBeNull();
  });
});
