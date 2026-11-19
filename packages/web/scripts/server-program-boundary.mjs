import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const compiler = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

export function assertServerProgramBoundary(root = webRoot) {
  const result = spawnSync(process.execPath, [
    compiler, '--project', path.join(root, 'tsconfig.server.json'),
    '--noEmit', '--listFilesOnly', '--pretty', 'false',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Cannot inspect the server compiler program:\n${result.stdout}${result.stderr}`);
  }
  const canonicalRoot = fs.realpathSync(root);
  const escaped = result.stdout.split(/\r?\n/)
    .filter((file) => file && !/\.d\.[cm]?ts$/i.test(file))
    .filter((file) => {
      const relative = path.relative(canonicalRoot, fs.realpathSync(file));
      return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    })
    .map((file) => file.replaceAll('\\', '/'));
  if (escaped.length) {
    throw new Error(`Server compiler sources escape packages/web:\n${escaped.join('\n')}\n`
      + 'Move server-owned contracts into packages/web/server, or import a shared package through its built declarations. '
      + 'Do not import other workspace sources, including with import type: TypeScript can emit beside those sources.');
  }
}
