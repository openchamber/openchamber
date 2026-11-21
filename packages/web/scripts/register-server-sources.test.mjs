import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('Node source consumers resolve converted server modules through unchanged package imports', () => {
  const result = spawnSync(process.execPath, [
    '--import', fileURLToPath(new URL('./register-server-sources.mjs', import.meta.url)),
    '--conditions=openchamber-source', '--input-type=module', '-e', `
      const { collectSshBufferDiagnostics } = await import('@openchamber/web/server/lib/diagnostics/local-files.js');
      console.log(JSON.stringify(collectSshBufferDiagnostics({
        entries: [{ lines: ['[1781000000000] [INFO] Starting SSH connection'] }],
        omittedSources: 0,
      })));
    `,
  ], { cwd: fileURLToPath(new URL('../../electron', import.meta.url)), encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    events: [{ at: 1781000000000, source: 'SSH connection 1', action: 'info: connection started' }],
    coverage: [{ source: 'local SSH manager', status: 'read', omitted: 0, filtered: 0 }],
  });
});

test('the source resolver leaves unrelated missing imports unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-source-resolution-'));
  try {
    fs.writeFileSync(path.join(root, 'outside.ts'), 'export const outside = true;');
    const result = spawnSync(process.execPath, [
      '--import', fileURLToPath(new URL('./register-server-sources.mjs', import.meta.url)),
      '--input-type=module', '-e', "await import('./outside.js');",
    ], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the plain Node source entry initializes its own resolver before loading the runtime', () => {
  const entry = new URL('../server/index.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    await import(${JSON.stringify(entry)});
    const { createServerDiagnosticJournal } = await import(${JSON.stringify(new URL('../server/lib/diagnostics/server-journal.js', import.meta.url).href)});
    const journal = createServerDiagnosticJournal();
    journal.record('managed launch', { attempt: 1 });
    if (journal.snapshot().events[0].action !== 'managed launch') process.exit(1);
    console.log('source entry ready');
    process.exit(0);
  `], { encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('source entry ready');
});

test('the source CLI serves diagnostic routes under Node without Bun', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./smoke-server-build.mjs', import.meta.url)), '--source-cli',
  ], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('Node source CLI /health: 200');
  expect(result.stdout).toContain('Node source CLI /api/diagnostics/local-files: 200');
  expect(result.stdout).toContain('Server stopped; isolated data removed.');
}, 95_000);
