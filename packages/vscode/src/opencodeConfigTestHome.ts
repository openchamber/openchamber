import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Test-only side-effect module. Import it BEFORE './opencodeConfig' or
// './opencodeConfigPaths': their user config paths freeze when they load, and
// without this they would read and write the real ~/.config/opencode.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-config-home-'));
delete process.env.OPENCODE_CONFIG_DIR;
process.env.XDG_CONFIG_HOME = root;

process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true });
});
