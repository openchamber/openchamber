import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-packed-install-'));

const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const pack = (packageRoot) => {
  const output = run('bun', ['pm', 'pack', '--destination', root], packageRoot);
  const tarball = output.split('\n').map((line) => line.trim()).find((line) => line.endsWith('.tgz'));
  if (!tarball) throw new Error(`bun pm pack printed no .tgz for ${packageRoot}`);
  return path.resolve(root, tarball);
};

const checksFromInstalledPackage = {
  zod: ['node', ['--input-type=module', '-e', `
    const { z } = await import('zod');
    if (!z.object({ absent: z.unknown() }).safeParse({}).success) throw new Error('zod rejects an absent key: ' + import.meta.resolve('zod'));
  `]],
  'bun-pty': ['bun', ['-e', `
    const { spawn } = await import('bun-pty');
    // About 260 KB: more than the kernel PTY buffer, so the child blocks until
    // the native reader drains it, and less than the 512 KB the patch keeps.
    const pty = spawn('/bin/sh', ['-c', 'yes early-output | head -n 20000'], { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    // The read loop emits the bytes it read before the exit event, so once the
    // child has exited its output went out with no listener attached.
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10000);
      pty.onExit(() => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) throw new Error('bun-pty child did not exit within 10 seconds: ' + import.meta.resolve('bun-pty'));
    let output = '';
    pty.onData((data) => { output += data; });
    if (!output.includes('early-output')) throw new Error('bun-pty dropped output written before its first listener: ' + import.meta.resolve('bun-pty'));
  `]],
};

const installers = {
  bun: (tarball) => ['bun', ['add', '--ignore-scripts', tarball]],
  npm: (tarball) => ['npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball]],
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = readJson(path.join(webRoot, 'package.json'));
const patched = Object.keys(readJson(path.join(webRoot, '..', '..', 'package.json')).patchedDependencies ?? {})
  .map((key) => key.slice(0, key.lastIndexOf('@')));
const unbundled = patched.filter((name) => manifest.dependencies[name] && !manifest.bundleDependencies?.includes(name));

const failures = unbundled.map((name) => `${name} is patched in bun-patches/ but missing from bundleDependencies`);
try {
  const sdkTarball = pack(path.join(webRoot, '..', 'sdk'));
  const webTarball = pack(webRoot);
  for (const [installer, command] of Object.entries(installers)) {
    const project = path.join(root, installer);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, overrides: { '@openchamber/sdk': `file:${sdkTarball}` } }));
    run(...command(webTarball), project);
    const installed = path.join(project, 'node_modules', '@openchamber', 'web');
    for (const name of manifest.bundleDependencies ?? []) {
      if (!fs.existsSync(path.join(installed, 'node_modules', name, 'package.json'))) {
        failures.push(`${installer}: ${name} is not in the tarball packed by bun ${run('bun', ['--version'], webRoot).trim()}; bun 1.4.2 leaves symlinked bundleDependencies out`);
      }
    }
    for (const [name, [checkCommand, args]] of Object.entries(checksFromInstalledPackage)) {
      try {
        execFileSync(checkCommand, args, { cwd: installed, stdio: ['ignore', 'inherit', 'pipe'] });
        console.log(`${installer}: patched ${name} resolved from the installed package`);
      } catch (error) {
        const message = String(error.stderr ?? '').split('\n').map((line) => line.trim()).findLast((line) => /^\w*error:/i.test(line));
        failures.push(`${installer}: ${name}: ${message ?? error.message}`);
      }
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`Patched dependencies missing from the packed @openchamber/web:\n${failures.join('\n')}`);
  process.exit(1);
}
