import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fetchCommandQuota, readUsageProviderCommands } from './quotaCommandProvider';

describe('command-backed quota provider', () => {
  it('maps account usage and uses the requested working directory', async () => {
    const directory = os.tmpdir();
    const script = `console.log(JSON.stringify({version:1,providerName:'Codex',accounts:[{label:process.cwd(),current:true,available:true,limits:[{windowMinutes:300,usedPercent:17}]}]}))`;
    const result = await fetchCommandQuota('codex', [process.execPath, '-e', script], directory);

    assert.equal(result.providerName, 'Codex');
    assert.equal(result.usage.accounts[0]?.label, fs.realpathSync(directory));
    assert.equal(result.usage.accounts[0]?.windows['5h']?.usedPercent, 17);
  });

  it('does not expose stderr when a command fails', async () => {
    await assert.rejects(
      fetchCommandQuota('codex', [process.execPath, '-e', 'console.error("secret"); process.exit(1)']),
      /Usage command failed/,
    );
  });

  it('names the config file when the config is malformed', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-config-'));
    fs.writeFileSync(path.join(directory, 'usage-providers.json'), '{ broken');
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = directory;
    try {
      assert.throws(() => readUsageProviderCommands(), /usage-providers\.json/);
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
