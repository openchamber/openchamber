import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// `scripts/install.sh` runs main.js from the unpacked release, before npm installed anything: every
// module it loads statically must need Node alone. A root command may still import a package
// dynamically, since those run from the installed tree.
it('loads only Node built-ins and its own files from the unpacked package', () => {
  const seen = new Set();
  const packages = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.')) walk(path.resolve(path.dirname(file), specifier));
      else if (!specifier.startsWith('node:') && !builtinModules.includes(specifier)) packages.push(`${specifier} <- ${path.basename(file)}`);
    }
  };
  walk(fileURLToPath(new URL('./main.js', import.meta.url)));
  expect(seen.size).toBeGreaterThan(10);
  expect(packages).toEqual([]);
});
