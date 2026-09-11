import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { describe, it } from 'node:test';
import { fetchCommandQuota } from './quotaCommandProvider';

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
});
