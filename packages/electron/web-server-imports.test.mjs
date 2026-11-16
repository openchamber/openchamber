import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards the Electron main process against dead-code cleanup breaking its
// imports from the web server package.
//
// packages/electron/*.mjs imports names from `@openchamber/web/server/...`
// (e.g. provideLoginShellEnvSnapshot in main.mjs). That specifier resolves
// through the workspace symlink, which the knip dead-code gate does not
// trace back to the source export — so knip can report such an export as
// unused and a cleanup PR (like #2296, which broke issue #2300) de-exports a
// symbol the desktop app needs at module-link time.
//
// This test parses every static named import (plus `} = await import()`
// destructures) of `@openchamber/web/server` modules in this package and
// asserts each imported name is still exported by the corresponding source
// file under packages/web. It fails on the pre-#2300-fix tree and passes
// with the export restored, independently of knip.

const ELECTRON_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(ELECTRON_DIR, '..', 'web');
const SERVER_SPECIFIER = /^@openchamber\/web\/server(\/.*)?$/;

const collectMjs = (dir, found = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMjs(full, found);
    } else if (
      entry.name.endsWith('.mjs') &&
      !/.(test|spec).mjs$/.test(entry.name)
    ) {
      found.push(full);
    }
  }
  return found;
};

const stripComments = (source) =>
  source
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

/** Static `import { a, b as c } from 'spec'` (an optional default binding before the braces is also matched) — returns [{ specifier, names }]. */
const staticImports = (source) => {
  const out = [];
  const re = /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const names = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const asMatch = part.match(/^(\S+)\s+as\s+(\S+)$/);
        return asMatch ? asMatch[1] : part;
      });
    out.push({ specifier: match[2], names });
  }
  return out;
};

/** `const { a, b } = await import('spec')` — returns [{ specifier, names }]. */
const dynamicDestructures = (source) => {
  const out = [];
  const re =
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const names = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const asMatch = part.match(/^(\S+)\s*:\s*(\S+)$/);
        return asMatch ? asMatch[1] : part;
      });
    out.push({ specifier: match[2], names });
  }
  return out;
};

const resolveServerFile = (specifier) => {
  const subpath = specifier.replace(
    '@openchamber/web/server',
    `${WEB_DIR}/server`,
  );
  const candidates = [subpath, `${subpath}.js`, `${subpath}/index.js`];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
};

/** Exported names of a source file, following relative re-exports. */
const sourceExports = (file, visited = new Set()) => {
  const real = path.resolve(file);
  if (visited.has(real)) return new Set();
  visited.add(real);
  const source = stripComments(readFileSync(real, 'utf8'));
  const names = new Set();

  for (const re of [
    /export\s+async\s+function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
  ]) {
    let match;
    while ((match = re.exec(source)) !== null) names.add(match[1]);
  }

  const blockRe = /export\s*{([\s\S]*?)}\s*(?:from\s*['"]([^'"]+)['"])?/g;
  let block;
  while ((block = blockRe.exec(source)) !== null) {
    const [, list, from] = block;
    if (from) {
      if (from.startsWith('.')) {
        // Resolve relative to the source file directly, then expose only
        // the bindings this re-export selects (under their declared
        // aliases) — not everything the target module exports.
        const relTarget = path.resolve(path.dirname(real), from);
        const relCandidates = [relTarget, `${relTarget}.js`, `${relTarget}/index.js`];
        for (const candidate of relCandidates) {
          try {
            if (statSync(candidate).isFile()) {
              const targetExports = sourceExports(candidate, visited);
              for (const part of list.split(',')) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                const asMatch = trimmed.match(/^(\S+)\s+as\s+(\S+)$/);
                const sourceName = asMatch ? asMatch[1] : trimmed.replace(/;$/, '');
                const exposedName = asMatch ? asMatch[2].replace(/;$/, '') : sourceName;
                if (targetExports.has(sourceName)) names.add(exposedName);
              }
              break;
            }
          } catch {
            // try next candidate
          }
        }
      }
      continue;
    }
    for (const part of list.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/^(\S+)\s+as\s+(\S+)$/);
      names.add(asMatch ? asMatch[2].replace(/;$/, '') : trimmed.replace(/;$/, ''));
    }
  }

  const starRe = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  let star;
  while ((star = starRe.exec(source)) !== null) {
    if (!star[1].startsWith('.')) continue;
    const relTarget = path.resolve(path.dirname(real), star[1]);
    const relCandidates = [relTarget, `${relTarget}.js`, `${relTarget}/index.js`];
    for (const candidate of relCandidates) {
      try {
        if (statSync(candidate).isFile()) {
          for (const name of sourceExports(candidate, visited)) names.add(name);
          break;
        }
      } catch {
        // try next candidate
      }
    }
  }

  return names;
};

test('every name Electron statically imports from @openchamber/web/server is still exported', () => {
  const checked = [];
  const missing = [];
  const unresolvable = [];

  for (const file of collectMjs(ELECTRON_DIR)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const imports = [...staticImports(source), ...dynamicDestructures(source)].filter(
      ({ specifier }) => SERVER_SPECIFIER.test(specifier),
    );
    for (const { specifier, names } of imports) {
      const target = resolveServerFile(specifier);
      if (!target) {
        unresolvable.push(`${path.basename(file)}: ${specifier}`);
        continue;
      }
      const exported = sourceExports(target);
      for (const name of names) {
        checked.push(`${path.basename(file)} -> ${specifier} :: ${name}`);
        if (!exported.has(name)) {
          missing.push(
            `${path.basename(file)} imports { ${name} } from ${specifier}, ` +
              `but ${path.relative(WEB_DIR, target)} does not export it`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    unresolvable,
    [],
    `could not resolve web-server specifiers to source files: ${unresolvable.join('; ')}`,
  );
  assert.ok(
    checked.length > 0,
    'expected to find at least one Electron import from @openchamber/web/server',
  );
  assert.deepEqual(missing, [], `broken Electron web-server imports:\n${missing.join('\n')}`);
});
