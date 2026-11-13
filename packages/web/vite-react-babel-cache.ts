// A disk cache for the React Compiler pass of `@vitejs/plugin-react` in the dev server.
//
// The compiler runs through Babel on every UI module the browser asks for, and
// Vite keeps the result in memory only: each `bun run dev` paid it again, about
// 16 of the 21 seconds the first page load took (measured on ~1,700 modules).
// Babel's output depends only on its input and its setup, so it is keyed by the
// module's id, its code, the dev server's settings plugin-react reads and the
// versions of everything that shapes the output, and a restart reads it back.
// A changed file misses and is compiled again.
//
// One cache serves every checkout of the repository (the main one and each
// worktree): paths are keyed relative to the repository root, and the root is
// stored as a placeholder in the output, so a new worktree starts from what
// the others already compiled.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, PluginOption, SourceMapInput } from 'vite';
import { z } from 'zod';

const require = createRequire(import.meta.url);
// Stands for the checkout's root in stored output; never part of real code.
const ROOT_PLACEHOLDER = '@@openchamber-checkout-root@@';
// Entries unused this long are removed when a dev server starts.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const manifestSchema = z.object({ name: z.string().optional(), version: z.string().optional() });
const compiledSchema = z.object({ code: z.string(), map: z.unknown() });
const entrySchema = z.union([z.object({ skipped: z.literal(true) }), compiledSchema]);
type Entry = z.infer<typeof entrySchema>;

/**
 * A package's version, found from its entry point (`package.json` is not
 * always exported) as `from` resolves it; null when it cannot be read, and
 * then nothing is cached, since an update could not miss.
 */
const versionOf = (from: NodeRequire, name: string): { version: string; resolve: NodeRequire } | null => {
  try {
    let directory = path.dirname(from.resolve(name));
    while (directory !== path.dirname(directory)) {
      const manifestPath = path.join(directory, 'package.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = manifestSchema.safeParse(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
        if (manifest.success && manifest.data.name === name && manifest.data.version) {
          return { version: manifest.data.version, resolve: createRequire(manifestPath) };
        }
      }
      directory = path.dirname(directory);
    }
  } catch {
    // Not installed where `from` looks.
  }
  return null;
};

/** The versions Babel's output depends on: plugin-react, and the Babel it runs. */
const toolVersions = (): string | null => {
  const pluginReact = versionOf(require, '@vitejs/plugin-react');
  if (!pluginReact) return null;
  const babel = versionOf(pluginReact.resolve, '@babel/core');
  const refresh = versionOf(pluginReact.resolve, 'react-refresh');
  const compiler = versionOf(require, 'babel-plugin-react-compiler');
  if (!babel || !refresh || !compiler) return null;
  return [pluginReact.version, babel.version, refresh.version, compiler.version].join(':');
};

const pruneOld = (directory: string) => {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      // Another dev server removed it first.
    }
  }
};

const readEntry = (file: string) => {
  try {
    const entry = entrySchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return entry.success ? entry.data : null;
  } catch {
    // A miss, or an entry another server is still writing.
    return null;
  }
};

const writeEntry = (directory: string, file: string, value: Entry) => {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, file);
  } catch {
    // The cache is a speed-up; a failed write only costs the next start.
  }
};

/**
 * Wraps the `vite:react-babel` transform of the plugins `react()` returned,
 * in the dev server only; a build runs it as before. `setup` names the Babel
 * options passed to `react()`, so changing them misses every entry; `root` is
 * the checkout's root, the part of every path that differs between checkouts.
 */
export function cacheReactBabel(plugins: PluginOption[], { directory, root, setup }: { directory: string; root: string; setup: unknown }): PluginOption[] {
  // With the separator, so a sibling such as `<root>-other` stays as it is.
  const rootPrefix = `${root}${path.sep}`;
  const placeholderPrefix = `${ROOT_PLACEHOLDER}${path.sep}`;
  const toStored = (text: string) => text.split(rootPrefix).join(placeholderPrefix);
  const fromStored = (text: string) => text.split(placeholderPrefix).join(rootPrefix);
  const babelPlugin = plugins.flat().find((plugin) => plugin && 'name' in plugin && plugin.name === 'vite:react-babel');
  const transform = babelPlugin && 'name' in babelPlugin ? babelPlugin.transform : undefined;
  if (!transform || !('handler' in transform)) return plugins;
  const original = transform.handler;
  // Set once the dev server's config is known: null keeps the cache off.
  let salt: string | null = null;

  const cached: typeof original = async function cachedTransform(code, id, options) {
    // Code that names the checkout itself would have that path rewritten too:
    // only the paths Babel generates may be swapped, so such a module is not kept.
    if (salt === null || code.includes(root) || code.includes(ROOT_PLACEHOLDER)) return original.call(this, code, id, options);
    const key = createHash('sha256').update(salt).update('\0').update(toStored(id)).update('\0').update(String(options?.ssr === true)).update('\0').update(code).digest('hex');
    const file = path.join(directory, `${key}.json`);
    const hit = readEntry(file);
    if (hit) {
      const now = new Date();
      fs.utimes(file, now, now, () => {});
      if ('skipped' in hit) return undefined;
      const map = hit.map === null ? null : JSON.parse(fromStored(JSON.stringify(hit.map)));
      // SAFETY: entries are written below from plugin-react's own result, whose map is Babel's source map.
      return { code: fromStored(hit.code), map: map as SourceMapInput };
    }
    const result = await original.call(this, code, id, options);
    if (result === undefined || result === null) {
      writeEntry(directory, file, { skipped: true });
    } else {
      // plugin-react answers `{ code, map }`; any other shape is not kept.
      const compiled = compiledSchema.safeParse(result);
      if (compiled.success) {
        const map = compiled.data.map ?? null;
        writeEntry(directory, file, { code: toStored(compiled.data.code), map: map === null ? null : JSON.parse(toStored(JSON.stringify(map))) });
      }
    }
    return result;
  };
  transform.handler = cached;

  const enable: Plugin = {
    name: 'openchamber:react-babel-cache',
    apply: 'serve',
    configResolved(config) {
      const versions = toolVersions();
      if (!versions) return;
      // What plugin-react reads from the config to decide on Fast Refresh.
      salt = JSON.stringify({ setup, versions, root: toStored(`${config.root}${path.sep}`), production: config.isProduction, hmr: config.server.hmr !== false });
      pruneOld(directory);
    },
  };
  return [...plugins, enable];
}
