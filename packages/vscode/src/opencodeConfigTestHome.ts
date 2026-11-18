import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-config-home-'));
delete process.env.OPENCODE_CONFIG_DIR;
process.env.XDG_CONFIG_HOME = root;

process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true });
});
