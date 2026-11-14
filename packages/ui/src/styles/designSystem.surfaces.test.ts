import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./design-system.css', import.meta.url), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`))?.[1] ?? '';
};

describe('surfaces pair their fill with its text', () => {
  test('a light composer on the canvas fill writes in the canvas foreground', () => {
    const light = rule('html:not(.dark) .oc-composer-surface');
    expect(light).toContain('background-color: var(--surface-background);');
    expect(light).toContain('--oc-composer-foreground: var(--surface-foreground);');
    expect(light).toContain('--foreground: var(--surface-foreground);');
  });

  test('the selected row fill rebinds the text colour to the selection foreground', () => {
    const selected = rule('.oc-selected');
    expect(selected).toContain('--foreground: var(--interactive-selection-foreground);');
    expect(selected).toContain('color: var(--foreground);');
  });

  test('the selected fill is one layer of the selection token, the layer its readable text is computed against', () => {
    expect(rule('.oc-selected').match(/linear-gradient/g)).toHaveLength(1);
    expect(/\.oc-selected \{[^}]*linear-gradient[^}]*linear-gradient/.test(css)).toBe(false);
    expect(css).not.toContain('html:not(.dark) .oc-selected');
  });
});
