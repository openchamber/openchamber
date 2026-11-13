import path from 'node:path';
import { localMcpReader } from './mcp-local-reader.js';
import { setupLocalMcpPlugin } from './mcp-local-plugin-runtime.js';
import { ensureLocalMcpDirectory, writeLocalMcpFile } from './mcp-local-files.js';
import { protectedSelectionReader } from '../protected-mcp/selections-reader.js';
import { resolveClientConfigPath } from '../protected-mcp/service-client.js';
import { asNonEmptyString, isBoolean, isPlainObject, isString } from '../shared/guards.js';

export async function materializeLocalMcpPlugin({ dataDir, protectedClientConfig = resolveClientConfigPath() }) {
  const root = path.join(dataDir, 'mcp-project-local');
  const directory = path.join(root, 'plugin');
  await ensureLocalMcpDirectory(root);
  await ensureLocalMcpDirectory(directory);
  const source = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { createHash } from 'node:crypto';",
    "import { homedir } from 'node:os';",
    `const asNonEmptyString = ${asNonEmptyString.toString()};`,
    `const isBoolean = ${isBoolean.toString()};`,
    `const isPlainObject = ${isPlainObject.toString()};`,
    `const isString = ${isString.toString()};`,
    `const createReader = ${localMcpReader.toString()};`,
    `const createProtectedReader = ${protectedSelectionReader.toString()};`,
    `const setup = ${setupLocalMcpPlugin.toString()};`,
    `export default { id: 'openchamber-project-local-mcp', setup: (ctx) => setup(ctx, { dataDir: ${JSON.stringify(dataDir)}, protectedClientConfig: ${JSON.stringify(protectedClientConfig)}, createReader, createProtectedReader, fs, path, createHash, homedir, asNonEmptyString, isBoolean, isPlainObject, isString }) };`,
  ].join('\n');
  await writeLocalMcpFile(path.join(directory, 'index.js'), source);
  await writeLocalMcpFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'openchamber-project-local-mcp', private: true, type: 'module', main: './index.js',
  }));
  return directory;
}
