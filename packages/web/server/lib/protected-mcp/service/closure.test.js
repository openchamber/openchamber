import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const guards = path.resolve(here, '../../shared/guards.js');
const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

const installedFiles = () => fs.readdirSync(here)
  .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
  .map((name) => path.join(here, name));

describe('installed service import closure', () => {
  it('imports only Node built-ins, its own files and the shared guards the installer copies', () => {
    const outside = [];
    const pending = installedFiles();
    const seen = new Set();
    while (pending.length > 0) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const [, specifier] of fs.readFileSync(file, 'utf8').matchAll(specifierPattern)) {
        if (specifier.startsWith('node:')) continue;
        if (!specifier.startsWith('.')) {
          outside.push(`${path.basename(file)} -> ${specifier}`);
          continue;
        }
        const target = path.resolve(path.dirname(file), specifier);
        if (target === guards) continue;
        if (path.dirname(target) !== here || !fs.existsSync(target)) outside.push(`${path.basename(file)} -> ${specifier}`);
        else pending.push(target);
      }
    }
    expect(outside).toEqual([]);
    expect(seen.size).toBeGreaterThan(5);
  });
});
