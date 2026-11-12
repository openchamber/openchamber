import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runOpenCodeCliUpgrade } from './cli-upgrade.js';

describe('OpenCode CLI upgrade process', () => {
  it('runs the resolved executable and wrapper arguments, with EOF and the supplied environment', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'oc upgrade '));
    try {
      const script = path.join(directory, 'cli fixture.cjs');
      const result = path.join(directory, 'result.json');
      await writeFile(script, `process.stdin.resume(); process.stdin.on('end', () => {
        require('node:fs').writeFileSync(process.env.RESULT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
      });`);
      await runOpenCodeCliUpgrade({ binary: process.execPath, args: [script] }, {
        cwd: directory, env: { ...process.env, RESULT: result },
      });
      expect(JSON.parse(await readFile(result, 'utf8'))).toEqual({ args: ['upgrade'], cwd: await realpath(directory) });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('reports nonzero exits without exposing installer output', async () => {
    await expect(runOpenCodeCliUpgrade({ binary: process.execPath, args: ['-e', 'console.error("private-registry-token"); process.exit(1)', '--'] }))
      .rejects.toThrow('OpenCode CLI upgrade failed. Run opencode upgrade in a terminal for details.');
  });

  it('reports spawn errors', async () => {
    await expect(runOpenCodeCliUpgrade({ binary: '/nonexistent/opencode-upgrade-fixture', args: [] })).rejects.toThrow('OpenCode CLI upgrade failed');
  });
  it('treats a signal exit as failure', async () => {
    await expect(runOpenCodeCliUpgrade({ binary: process.execPath, args: ['-e', 'process.kill(process.pid, "SIGTERM")', '--'] }))
      .rejects.toThrow('OpenCode CLI upgrade failed');
  });

});
