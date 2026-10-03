import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function pickThemeFile({ showDialog, home = os.homedir() }) {
  const extensions = path.join(home, '.vscode', 'extensions');
  const exists = await fs.stat(extensions).then((stat) => stat.isDirectory(), () => false);
  const result = await showDialog({
    defaultPath: exists ? extensions : undefined,
    filters: [{ name: 'JSON / JSONC', extensions: ['json', 'jsonc'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const file = result.filePaths[0];
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('invalid');
    if (stat.size > 512 * 1024) return { name: path.basename(file), size: stat.size, text: '' };
    const buffer = Buffer.alloc(512 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    return { name: path.basename(file), size, text: size > 512 * 1024 ? '' : buffer.toString('utf8', 0, size) };
  } finally {
    await handle.close();
  }
}
