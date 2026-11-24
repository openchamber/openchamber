import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installedWebCli, installedWebCliProbe } from './installed-web-cli.mjs';

for (const entry of ['bin/cli.js', 'build/bin/cli.js']) {
  test(`local and remote deployment find the installed ${entry}`, () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc installed cli ')));
    const root = path.join(directory, 'node_modules', '@openchamber', 'web');
    const cli = path.join(root, entry);
    try {
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, '');
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { openchamber: `./${entry}` } }));
      assert.equal(installedWebCli(directory), cli);
      assert.equal(execFileSync(process.execPath, ['-e', installedWebCliProbe], { cwd: directory, encoding: 'utf8' }), cli);
      fs.unlinkSync(path.join(root, 'package.json'));
      assert.equal(installedWebCli(directory), entry === 'bin/cli.js' ? cli : '');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('an absent install has no CLI', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-absent-cli-'));
  try {
    assert.equal(installedWebCli(directory), '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
