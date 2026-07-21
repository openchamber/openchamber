import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const electronDir = path.resolve(__dirname, '..');
const destination = path.join(electronDir, 'resources', 'opencode-container-workspace');
const packageName = '@openchamber/opencode-container-workspace';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function removeDir(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await sleep(100 * (attempt + 1));
    }
  }
}

async function copyDir(src, dst, { skipTests = false } = {}) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    if (skipTests && entry.name.endsWith('.test.js')) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to, { skipTests });
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

function packageRootFromResolvedEntry(resolved) {
  const entryPath = fileURLToPath(resolved);
  return path.resolve(path.dirname(entryPath), '..');
}

let packageRoot;
try {
  packageRoot = packageRootFromResolvedEntry(import.meta.resolve(packageName));
} catch (error) {
  console.error(`[electron] failed to resolve ${packageName}. Run bun install before packaging.`);
  throw error;
}

await removeDir(destination);
await fs.mkdir(destination, { recursive: true });

await copyDir(path.join(packageRoot, 'src'), path.join(destination, 'src'), { skipTests: true });
await copyDir(path.join(packageRoot, 'runtime-image'), path.join(destination, 'runtime-image'));

for (const file of ['package.json', 'README.md', 'LICENSE']) {
  await fs.copyFile(path.join(packageRoot, file), path.join(destination, file));
}

console.log(`[electron] workspace plugin staged: ${destination}`);
