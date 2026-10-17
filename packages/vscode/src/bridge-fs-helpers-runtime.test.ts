import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// This module imports `vscode`, which the isolated test runner cannot resolve,
// so the search ceiling is pinned on the source text like `webviewHtml.test.ts`
// pins the CSP, alongside its deliberate mirror in the web server.
const helpersSource = readFileSync(new URL('./bridge-fs-helpers-runtime.ts', import.meta.url), 'utf8');
const webSearchSource = readFileSync(new URL('../../web/server/lib/fs/search.js', import.meta.url), 'utf8');

describe('filesystem search inspected-file ceiling', () => {
  for (const [label, source] of [['VS Code', helpersSource], ['web', webSearchSource]] as const) {
    test(`${label} query searches stop on inspected files, not the old candidate cap`, () => {
      assert.doesNotMatch(source, /Math\.max\(limit \* 3, 200\)/);
      assert.match(source, /FILE_SEARCH_MAX_VISITED_FILES = 10_000/);
      assert.match(source, /inspectedFiles >= FILE_SEARCH_MAX_VISITED_FILES/);
    });
  }
});
