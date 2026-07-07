import { access, constants, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.resolve(mobileRoot, '../web');
const webDist = path.resolve(webRoot, 'dist');
const mobileDist = path.resolve(mobileRoot, 'dist');
const mobileHtml = path.join(mobileDist, 'mobile.html');
const indexHtml = path.join(mobileDist, 'index.html');

// Build web first if dist doesn't exist
try {
  await access(webDist, constants.F_OK);
} catch {
  execSync('bun run build', { cwd: webRoot, stdio: 'inherit' });
}

await rm(mobileDist, { recursive: true, force: true });
await mkdir(mobileDist, { recursive: true });
await cp(webDist, mobileDist, { recursive: true });

const html = await readFile(mobileHtml, 'utf8');
await writeFile(indexHtml, html);
