import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('the VS Code bundler includes a converted server module behind a .js specifier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ts-server-bundle-'));
  try {
    const entry = path.join(root, 'entry.mjs');
    const output = path.join(root, 'bundle.cjs');
    const module = fileURLToPath(new URL('../server/lib/diagnostics/local-files.js', import.meta.url));
    fs.writeFileSync(entry, `
      import { classifyLogLine } from ${JSON.stringify(module)};
      console.log(JSON.stringify(classifyLogLine('2026-09-28T10:00:00Z [info] [electron] app starting', 'desktop')));
    `);
    const bundled = spawnSync(fileURLToPath(new URL('../../vscode/node_modules/.bin/esbuild', import.meta.url)), [
      entry, '--bundle', `--outfile=${output}`, '--external:vscode', '--format=cjs', '--platform=node', '--minify', '--main-fields=module,main',
    ], { encoding: 'utf8' });
    expect(bundled.status, bundled.stderr).toBe(0);
    const executed = spawnSync(process.execPath, [output], { encoding: 'utf8' });
    expect(executed.status, executed.stderr).toBe(0);
    expect(JSON.parse(executed.stdout)).toEqual({ at: 1790589600000, source: 'electron', action: 'info: app starting' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
