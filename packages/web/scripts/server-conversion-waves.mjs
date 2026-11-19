import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseImports } from '../../../scripts/verify/changed.mjs';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const testFile = /(?:\.(?:test|spec|fixture|test-support|bench)\.|(?:^|[/\\])(?:tests?|__tests__|test-support)(?:[/\\]|$)|-live-support\.)/;
const implementation = (file) => /\.[jt]s$/.test(file) && !file.endsWith('.d.ts') && !testFile.test(file);

export function conversionFolders(root = webRoot) {
  const files = ['server/lib', 'bin'].flatMap((folder) => fs.readdirSync(path.join(root, folder), { recursive: true })
    .map((file) => path.join(folder, file).replaceAll(path.sep, '/')))
    .filter((file) => /\.[cm]?[jt]s$/.test(file));
  const sources = files.filter(implementation);
  const folders = new Map();
  for (const file of sources) {
    const folder = path.posix.dirname(file);
    if (!folders.has(folder)) folders.set(folder, { folder, js: 0, ts: 0, tests: 0, declarations: 0, dependencies: new Set() });
    folders.get(folder)[file.endsWith('.ts') ? 'ts' : 'js']++;
  }
  for (const file of files) {
    const owner = folders.get(path.posix.dirname(file));
    if (owner && testFile.test(file)) owner.tests++;
    else if (owner && file.endsWith('.d.ts')) owner.declarations++;
  }
  const sourceSet = new Set(sources);
  for (const file of sources) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const imported of parseImports(text)) {
      if (!imported.startsWith('.')) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), imported));
      const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`];
      const target = candidates.find((candidate) => sourceSet.has(candidate));
      if (!target) continue;
      const dependency = path.posix.dirname(target);
      const owner = folders.get(path.posix.dirname(file));
      if (dependency !== owner.folder && folders.get(dependency).js > 0) owner.dependencies.add(dependency);
    }
  }
  return [...folders.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

export function conversionWaves(folders) {
  const pending = new Map(folders.filter((folder) => folder.js > 0).map((folder) => [folder.folder, folder]));
  const completed = folders.filter((folder) => folder.js === 0);
  const waves = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((folder) => [...folder.dependencies].every((dependency) => !pending.has(dependency)));
    if (!ready.length) break;
    waves.push(ready);
    for (const folder of ready) pending.delete(folder.folder);
  }
  const cycles = [];
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  let index = 0;
  const visit = (name) => {
    indices.set(name, index);
    low.set(name, index++);
    stack.push(name);
    onStack.add(name);
    for (const dependency of pending.get(name).dependencies) {
      if (!pending.has(dependency)) continue;
      if (!indices.has(dependency)) {
        visit(dependency);
        low.set(name, Math.min(low.get(name), low.get(dependency)));
      } else if (onStack.has(dependency)) low.set(name, Math.min(low.get(name), indices.get(dependency)));
    }
    if (low.get(name) !== indices.get(name)) return;
    const group = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      group.push(pending.get(member));
    } while (member !== name);
    cycles.push(group.sort((a, b) => a.folder.localeCompare(b.folder)));
  };
  for (const name of pending.keys()) if (!indices.has(name)) visit(name);
  return { completed, waves, remaining: cycles };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const serialize = (folder) => ({ ...folder, dependencies: [...folder.dependencies].sort() });
  const result = conversionWaves(conversionFolders());
  console.log(JSON.stringify({
    completed: result.completed.map(serialize),
    waves: result.waves.map((wave) => wave.map(serialize)),
    remaining: result.remaining.map((group) => group.map(serialize)),
  }, null, 2));
}
