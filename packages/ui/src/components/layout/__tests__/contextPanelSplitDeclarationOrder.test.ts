import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextPanel.tsx'), 'utf-8');

describe('ContextPanel split declaration order', () => {
  test('initializes the panel ref before split width reads it during render', () => {
    const panelRefDeclaration = contextPanelSource.indexOf(
      'const panelRef = React.useRef<HTMLElement | null>(null);',
    );
    const splitWidthCalculation = contextPanelSource.indexOf(
      'const splitTotalWidth = React.useMemo(() => {',
    );

    expect(panelRefDeclaration).toBeGreaterThan(-1);
    expect(splitWidthCalculation).toBeGreaterThan(-1);
    expect(panelRefDeclaration).toBeLessThan(splitWidthCalculation);
  });
});
