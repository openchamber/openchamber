// Regression fixture for #2105: the root dead-code command must report
// an unused exported class method on an otherwise-used class. Runs knip
// against this isolated fixture with the SAME --include list as the
// root "dead-code" script (read live from package.json, so dropping
// classMembers from the command fails this check), and asserts the
// unused method is reported while the used one is not.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
const deadCode = rootPkg.scripts['dead-code'] ?? '';
const includeArg = /--include\s+(\S+)/.exec(deadCode)?.[1] ?? '';
if (!includeArg.split(',').includes('classMembers')) {
  console.error('FAIL: root dead-code command does not include classMembers');
  process.exit(1);
}

let output = '';
let status = 0;
try {
  output = execFileSync(
    'bunx',
    ['knip@5.80.0', '--config', 'knip.json', '--include', includeArg],
    { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  status = error.status ?? 1;
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}

if (status !== 1) {
  console.error(`FAIL: knip exited ${status}, expected 1 (findings present)\n${output}`);
  process.exit(1);
}
if (!output.includes('unusedMethod')) {
  console.error(`FAIL: unusedMethod not reported by the dead-code check\n${output}`);
  process.exit(1);
}
if (/\busedMethod\b/.test(output)) {
  console.error(`FAIL: usedMethod wrongly reported\n${output}`);
  process.exit(1);
}
console.log('ok: dead-code check reports the unused exported class method (classMembers enabled)');
