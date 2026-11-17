import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// This module imports `vscode`, which the isolated test runner cannot resolve,
// so the search ceiling is pinned on the source text like `webviewHtml.test.ts`
// pins the CSP, alongside its deliberate mirror in the web server.
const helpersSource = readFileSync(new URL('./bridge-fs-helpers-runtime.ts', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('./bridge-fs-runtime.ts', import.meta.url), 'utf8');
const webSearchSource = readFileSync(new URL('../../web/server/lib/fs/search.js', import.meta.url), 'utf8');

// The two copies enforce the ceilings differently: the VS Code copy counts
// locally, while the web copy moved to the shared traversal budget (#1393),
// whose counters own the stop conditions. Each copy is pinned on the pattern
// that actually enforces the ceiling in it.
describe('filesystem search inspected-file ceiling', () => {
  for (const [label, source, stopPattern] of [
    ['VS Code', helpersSource, /inspectedFiles >= FILE_SEARCH_MAX_VISITED_FILES/],
    ['web', webSearchSource, /budget\.visitedEntries >= FILE_SEARCH_MAX_VISITED_FILES/],
  ] as const) {
    test(`${label} query searches stop on inspected files, not the old candidate cap`, () => {
      assert.doesNotMatch(source, /Math\.max\(limit \* 3, 200\)/);
      assert.match(source, /FILE_SEARCH_MAX_VISITED_FILES = 10_000/);
      assert.match(source, stopPattern);
    });
  }
});

describe('filesystem search directory-visit ceiling', () => {
  for (const [label, source, stopPattern] of [
    ['VS Code', helpersSource, /visited\.size >= FILE_SEARCH_MAX_VISITED_DIRS/],
    ['web', webSearchSource, /maxDirs: FILE_SEARCH_MAX_VISITED_DIRS/],
  ] as const) {
    test(`${label} file search bounds directory visits at the named ceiling`, () => {
      assert.match(source, /FILE_SEARCH_MAX_VISITED_DIRS = 50_000/);
      assert.match(source, stopPattern);
    });
  }
});

describe('bridge fs env readers judge values by their whole text', () => {
  // The helpers module's reader cannot be imported here (see above), so it is
  // pinned on the source text; the identical runtime reader is covered
  // behaviourally in bridge-fs-runtime.test.js.
  for (const [label, source] of [['helpers', helpersSource], ['runtime', runtimeSource]] as const) {
    test(`${label} check-ignore timeout reader parses a plain decimal, never bare Number(...)`, () => {
      assert.doesNotMatch(source, /Number\(process\.env\.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS\)/);
      assert.match(source, /parsePlainDecimalInt\(process\.env\.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS\)/);
    });
  }

  for (const [label, source] of [['helpers', helpersSource], ['runtime', runtimeSource]] as const) {
    test(`${label} check-ignore timeout reader falls back above the timer maximum`, () => {
      assert.match(source, /raw <= 2_147_483_647/);
    });
  }

  test('runtime read-cache TTL reader parses a plain decimal, never bare Number(...)', () => {
    assert.doesNotMatch(runtimeSource, /Number\(process\.env\.OPENCHAMBER_GIT_READ_CACHE_TTL_MS\)/);
    assert.match(runtimeSource, /parsePlainDecimalInt\(process\.env\.OPENCHAMBER_GIT_READ_CACHE_TTL_MS\)/);
  });
});

const webModelsMetadataSource = readFileSync(new URL('../../web/server/lib/opencode/models-metadata.js', import.meta.url), 'utf8');

describe('models.dev catalog read ceiling', () => {
  // fetchModelsMetadata cannot be imported here (the module imports
  // `vscode`), so the bound is pinned on the source text like the search
  // ceiling above, alongside its deliberate mirror in the web server.
  for (const [label, source] of [['VS Code', helpersSource], ['web', webModelsMetadataSource]] as const) {
    test(`${label} catalog read is capped at the named 16 MiB bound`, () => {
      assert.match(source, /MODELS_DEV_CATALOG_MAX_BYTES = 16 \* 1024 \* 1024/);
      assert.match(source, /readBoundedResponseText\(response, MODELS_DEV_CATALOG_MAX_BYTES\)/);
    });
  }

  test('VS Code fetchModelsMetadata never buffers the body whole', () => {
    assert.doesNotMatch(helpersSource, /response\.json\(\)/);
    assert.match(helpersSource, /return JSON\.parse\(bounded\.text\)/);
  });

  test('VS Code bounded read rejects a declared over-cap length and cancels an over-cap stream', () => {
    assert.match(helpersSource, /declared > maxBytes/);
    assert.match(helpersSource, /size > maxBytes/);
    assert.match(helpersSource, /reader\.cancel\(\)/);
  });

  test('VS Code over-cap body throws the web copy’s error and a non-OK status still throws its own', () => {
    assert.match(helpersSource, /models\.dev response exceeded size limit/);
    assert.match(helpersSource, /models\.dev responded with \$\{response\.status\}/);
  });
});
