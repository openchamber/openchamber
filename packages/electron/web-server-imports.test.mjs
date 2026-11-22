import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
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
// This test parses every static named import, `} = await import()`
// destructure, and `import(...).then(({ ... }) => ...)` destructure of
// `@openchamber/web/server` modules in this package and asserts each
// imported name is still exported by the corresponding source file under
// packages/web. It fails on the pre-#2300-fix tree and passes with the
// export restored, independently of knip.

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

/**
 * `import('spec').then(({ a, b }) => ...)` — the shape main.mjs uses to
 * lazily load the dev-tunnel client (#2306). Returns [{ specifier, names }].
 */
const thenDestructures = (source) => {
  const out = [];
  const re =
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*then\s*\(\s*\(\s*\{([^}]*)\}\s*\)/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const names = match[2]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/[:=]/)[0].trim());
    out.push({ specifier: match[1], names });
  }
  return out;
};

const resolveServerFile = (specifier, webDir = WEB_DIR) => {
  const subpath = specifier.replace(
    '@openchamber/web/server',
    `${webDir}/server`,
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

/** Scan an Electron tree for web-server imports and compare each name against the web source tree. */
const analyzeImports = (electronDir, webDir) => {
  const checked = [];
  const missing = [];
  const unresolvable = [];

  for (const file of collectMjs(electronDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const imports = [
      ...staticImports(source),
      ...dynamicDestructures(source),
      ...thenDestructures(source),
    ].filter(({ specifier }) => SERVER_SPECIFIER.test(specifier));
    for (const { specifier, names } of imports) {
      const target = resolveServerFile(specifier, webDir);
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
              `but ${path.relative(webDir, target)} does not export it`,
          );
        }
      }
    }
  }

  return { checked, missing, unresolvable };
};

test('every name Electron imports from @openchamber/web/server is still exported', () => {
  const { checked, missing, unresolvable } = analyzeImports(ELECTRON_DIR, WEB_DIR);

  assert.deepEqual(
    unresolvable,
    [],
    `could not resolve web-server specifiers to source files: ${unresolvable.join('; ')}`,
  );
  assert.ok(
    checked.length > 0,
    'expected to find at least one Electron import from @openchamber/web/server',
  );
  // #2306: the `.then()` destructure in main.mjs must be checked, and adding
  // it must not drop any name the older parsers already covered.
  assert.ok(
    checked.includes(
      'main.mjs -> @openchamber/web/server/lib/dev-tunnel/client.js :: createDevTunnelClient',
    ),
    `expected the .then() destructure in main.mjs to be checked, got:\n${checked.join('\n')}`,
  );
  assert.ok(
    checked.some((entry) => entry.endsWith(':: provideLoginShellEnvSnapshot')) &&
      checked.some((entry) => entry.endsWith(':: startWebUiServer')),
    'expected the static and await-destructure shapes to stay checked',
  );
  assert.deepEqual(missing, [], `broken Electron web-server imports:\n${missing.join('\n')}`);
});

test('the guard catches a de-exported name reached through a .then() destructure (#2306 negative control)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'web-server-imports-'));
  const electronDir = path.join(root, 'electron');
  const webDir = path.join(root, 'web');
  const clientFile = path.join(webDir, 'server', 'lib', 'dev-tunnel', 'client.js');
  mkdirSync(path.dirname(clientFile), { recursive: true });
  mkdirSync(electronDir, { recursive: true });
  writeFileSync(
    path.join(electronDir, 'main.mjs'),
    [
      'const getDevTunnelClient = async () => {',
      "  devTunnelClientPromise = import('@openchamber/web/server/lib/dev-tunnel/client.js')",
      '    .then(({ createDevTunnelClient }) => createDevTunnelClient({ logger: log }));',
      '};',
      '',
    ].join('\n'),
  );

  try {
    writeFileSync(clientFile, 'export const createDevTunnelClient = () => {};\n');
    const healthy = analyzeImports(electronDir, webDir);
    assert.deepEqual(healthy.missing, []);
    assert.ok(
      healthy.checked.includes(
        'main.mjs -> @openchamber/web/server/lib/dev-tunnel/client.js :: createDevTunnelClient',
      ),
    );

    writeFileSync(clientFile, 'export const somethingElse = () => {};\n');
    const broken = analyzeImports(electronDir, webDir);
    assert.equal(broken.missing.length, 1);
    assert.match(broken.missing[0], /createDevTunnelClient/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
