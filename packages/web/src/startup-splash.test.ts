import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('desktop startup splash', () => {
  it('lives outside the React root so startup progress survives the first commit', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const splashIndex = html.indexOf('<div id="initial-loading">');
    const rootIndex = html.indexOf('<div id="root" class="h-full"></div>');

    expect(splashIndex).toBeGreaterThan(-1);
    expect(rootIndex).toBeGreaterThan(splashIndex);
  });
});
