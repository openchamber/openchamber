import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDist = path.resolve(mobileRoot, '../web/dist');
const mobileDist = path.resolve(mobileRoot, 'dist');
const mobileHtml = path.join(mobileDist, 'mobile.html');
const indexHtml = path.join(mobileDist, 'index.html');

await rm(mobileDist, { recursive: true, force: true });
await mkdir(mobileDist, { recursive: true });
await cp(webDist, mobileDist, { recursive: true });

const html = await readFile(mobileHtml, 'utf8');
await writeFile(indexHtml, html);
