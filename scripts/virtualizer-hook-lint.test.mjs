import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = 'no-virtualizer-return-from-hooks';
const IMPORT = "import { useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual';";
const CASES = [
  ['direct return', 'function useRows() { return useVirtualizer({}); }', 1],
  ['window virtualizer', 'function useRows() { return useWindowVirtualizer({}); }', 1],
  ['variable return', 'function useRows() { const v = useVirtualizer({}); return v; }', 1],
  ['shorthand property', 'function useRows() { const v = useVirtualizer({}); return { v }; }', 1],
  ['explicit property', 'function useRows() { const v = useVirtualizer({}); return { virtualizer: v }; }', 1],
  ['direct property', 'function useRows() { return { virtualizer: useWindowVirtualizer({}) }; }', 1],
  ['array', 'function useRows() { const v = useVirtualizer({}); return [v]; }', 1],
  ['direct array', 'function useRows() { return [useVirtualizer({})]; }', 1],
  ['nested container alias', 'function useRows() { const v = useVirtualizer({}); const result = { nested: [v] }; return result; }', 1],
  ['variable alias', 'const useRows = () => { const v = useVirtualizer({}); const alias = v; return alias; };', 1],
  ['assignment', 'function useRows() { let v; v = useVirtualizer({}); return v; }', 1],
  ['concise arrow', 'const useRows = () => useVirtualizer({});', 1],
  ['concise object', 'const useRows = () => ({ v: useVirtualizer({}) });', 1],
  ['function expression', 'const useRows = function() { return useVirtualizer({}); };', 1],
  ['named function expression', 'const useRows = function buildRows() { return useVirtualizer({}); };', 1],
  ['object spread', 'function useRows() { const v = useVirtualizer({}); const result = { v }; return { ...result }; }', 1],
  ['array spread', 'function useRows() { const v = useVirtualizer({}); const result = [v]; return [...result]; }', 1],
  ['copy followed by instance', 'function useRows() { const v = useVirtualizer({}); return [{ ...v }, v]; }', 1],
  ['destructured instance property', 'function useRows() { const { v } = { v: useVirtualizer({}) }; return v; }', 1],
  ['destructured instance element', 'function useRows() { const [v] = [useVirtualizer({})]; return { v }; }', 1],
  ['renamed nested destructuring', 'function useRows() { const { nested: [v] } = { nested: [useVirtualizer({})] }; return v; }', 1],
  ['object method', 'const hooks = { useRows() { return useVirtualizer({}); } };', 1],
  ['conditional', 'function useRows(ok) { const v = useVirtualizer({}); return ok ? v : null; }', 1],
  ['logical', 'function useRows(ok) { const v = useVirtualizer({}); return ok && v; }', 1],
  ['type wrapper', 'const useRows = () => [useVirtualizer({})] as const;', 1],
  ['aliased import', "import { useVirtualizer as virtual } from '@tanstack/react-virtual'; const useRows = () => virtual({});", 1],
  ['namespace import', "import * as Virtual from '@tanstack/react-virtual'; const useRows = () => Virtual.useWindowVirtualizer({});", 1],
  ['derived values', 'function useRows() { const v = useVirtualizer({}); return { rows: v.getVirtualItems(), size: v.getTotalSize(), measure: v.measureElement }; }', 0],
  ['derived array', 'function useRows() { const v = useVirtualizer({}); return [v.getVirtualItems(), v.getTotalSize(), v.measureElement]; }', 0],
  ['derived variables', 'function useRows() { const v = useVirtualizer({}); const rows = v.getVirtualItems(); return rows; }', 0],
  ['destructured measure', 'function useRows() { const { measureElement } = useVirtualizer({}); return { measureElement }; }', 0],
  ['destructured rows', 'function useRows() { const [row] = useVirtualizer({}).getVirtualItems(); return row; }', 0],
  ['copied instance', 'function useRows() { const v = useVirtualizer({}); return { ...v }; }', 0],
  ['component', 'function Rows() { const v = useVirtualizer({}); return v.getVirtualItems().map(row => row.index); }', 0],
  ['component return', 'const Rows = () => useVirtualizer({});', 0],
  ['nested callback return', 'function useRows() { const v = useVirtualizer({}); const callback = () => { return v; }; return { callback }; }', 0],
  ['unrelated function', 'function buildRows() { return useVirtualizer({}); }', 0],
  ['unrelated import', "import { useVirtualizer as other } from './other'; const useRows = () => other({});", 0],
  ['shadowed import', 'function useRows(useVirtualizer) { return useVirtualizer({}); }', 0],
  ['shadowed variable', 'function useRows() { const v = useVirtualizer({}); { const v = 1; return { v }; } }', 0],
  ['unreturned instance', 'function useRows() { const v = useVirtualizer({}); return { count: 0 }; }', 0],
  ['alias cycle', 'function useRows() { let a; let b; a = b; b = a; return a; }', 0],
];

let directory;
let diagnostics;

before(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'oc-virtualizer-lint-'));
  for (const [index, [, code]] of CASES.entries()) {
    writeFileSync(path.join(directory, `case-${index}.ts`), `${IMPORT}\n${code}\n`);
  }
  const config = path.join(directory, 'lint.config.json');
  writeFileSync(config, JSON.stringify({
    categories: { correctness: 'off' },
    jsPlugins: [{ name: 'openchamber', specifier: path.join(ROOT, 'tools/oxlint/openchamber/index.ts') }],
    rules: { [`openchamber/${RULE}`]: 'error' },
  }));
  const result = spawnSync(path.join(ROOT, 'node_modules/.bin/oxlint'), ['-c', config, '-f', 'json', directory], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  diagnostics = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))).diagnostics;
  assert.ok(diagnostics.every((diagnostic) => diagnostic.code === `openchamber(${RULE})`), result.stdout);
});

after(() => rmSync(directory, { recursive: true, force: true }));

for (const [index, [name, , count]] of CASES.entries()) {
  test(name, () => {
    const actual = diagnostics.filter((diagnostic) => path.basename(diagnostic.filename) === `case-${index}.ts`);
    assert.equal(actual.length, count);
    for (const diagnostic of actual) {
      assert.match(diagnostic.message, /stable reference.*React Compiler/);
      assert.match(diagnostic.message, /getVirtualItems\(\), getTotalSize\(\) and measure functions.*hook's body/);
    }
  });
}
