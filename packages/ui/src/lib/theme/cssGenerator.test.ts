import { describe, expect, test } from 'bun:test';
import { getThemeById } from './themes';
import { CSSVariableGenerator } from './cssGenerator';

const openchamberLightTheme = getThemeById('openchamber-light');

if (!openchamberLightTheme) {
  throw new Error('Missing openchamber-light theme fixture');
}

describe('CSSVariableGenerator.generate', () => {
  test('fills all five git graph variables from syntax colors', () => {
    const css = new CSSVariableGenerator().generate(openchamberLightTheme);

    expect(css).toContain('  --git-graph-1: #15764e;');
    expect(css).toContain('  --git-graph-2: #c25f4b;');
    expect(css).toContain('  --git-graph-3: #177b8f;');
    expect(css).toContain('  --git-graph-4: #4e8b18;');
    expect(css).toContain('  --git-graph-5: #0e8294;');
  });

});
