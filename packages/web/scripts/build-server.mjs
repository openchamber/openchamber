import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertServerProgramBoundary } from './server-program-boundary.mjs';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const compiler = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

const isTestFile = (name) => /\.(?:test|spec|test-support|fixture)\./.test(name);
const assetExtensions = new Set(['.json', '.txt', '.cjs']);

export async function buildServer(outputDirectory = path.join(webRoot, 'build')) {
  assertServerProgramBoundary();
  await fs.rm(outputDirectory, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [
    compiler, '--project', path.join(webRoot, 'tsconfig.server.json'), '--outDir', outputDirectory,
  ], { cwd: webRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Server compilation failed with exit code ${result.status}`);

  const copyAssets = async (relative) => {
    for (const entry of await fs.readdir(path.join(webRoot, relative), { withFileTypes: true })) {
      if (isTestFile(entry.name) || entry.name === 'test-support') continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (child === path.join('server', 'built-in-extensions')) {
          await fs.cp(path.join(webRoot, child), path.join(outputDirectory, child), { recursive: true });
        } else {
          await copyAssets(child);
        }
      } else {
        const declarationOnly = entry.name.endsWith('.d.ts') && await fs.stat(
          path.join(webRoot, relative, entry.name.replace(/\.d\.ts$/, '.js')),
        ).then(() => false, (error) => {
          if (error.code === 'ENOENT') return true;
          throw error;
        });
        if (!declarationOnly && !assetExtensions.has(path.extname(entry.name))) continue;
        await fs.mkdir(path.dirname(path.join(outputDirectory, child)), { recursive: true });
        await fs.copyFile(path.join(webRoot, child), path.join(outputDirectory, child));
      }
    }
  };
  await copyAssets('server');
  await copyAssets('bin');
  await fs.chmod(path.join(outputDirectory, 'bin', 'cli.js'), 0o755);
  console.log(`Server build ready: ${outputDirectory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await buildServer();
}
