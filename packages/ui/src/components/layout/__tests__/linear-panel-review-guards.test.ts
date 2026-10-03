/**
 * Guards from the OPE-296 review: stale Linear list pages must not land, and a
 * persisted Linear tab must survive reload until auth has actually resolved.
 * The reference picker's stale-page guard lives in references/referenceCache.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const railSource = readFileSync(join(__dirname, '..', 'ContextPanelRail.tsx'), 'utf-8');
const issuesViewSource = readFileSync(join(__dirname, '..', '..', 'views', 'LinearIssuesView.tsx'), 'utf-8');

const sliceFn = (source: string, marker: string, length: number) => {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, start + length);
};

describe('Linear panel review guards', () => {
  test('disconnect-close waits for Linear auth to resolve', () => {
    const effect = sliceFn(railSource, 'if (!directoryKey || !linearAuthChecked || linearConnected || activeMode !== \'linear\')', 240);
    expect(effect).toContain('closeContextPanel(directoryKey)');
    expect(railSource).toContain('state.hasChecked');
  });

  test('rail loadMore shares listRequestId with refresh', () => {
    const loadMore = sliceFn(issuesViewSource, 'const loadMore = React.useCallback(async () => {', 900);
    expect(loadMore).toContain('const requestId = listRequestId.current + 1');
    expect(loadMore).toContain('if (requestId !== listRequestId.current) return');
  });
});
