import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';

// What OpenCode runs from a folder's own configuration as soon as it opens
// that folder, found the way OpenCode 2.x discovers it
// (`packages/core/src/config/discovery.ts` and `config/plugin/source.ts`
// in the OpenCode repository): every level from the folder up to the
// filesystem root holds `.opencode/` and `opencode.json(c)`; a `.opencode/`
// directory contributes the files and folders in `plugin/` and `plugins/`
// plus its own `opencode.json(c)`.
//
// The walk stops below the user's home directory. Levels from home up hold
// the user's own setup, which no repository can write. OpenCode's global
// configuration directories are the user's too: a folder that is one of them
// reads no project configuration in OpenCode, and a level that is one of them
// is skipped, as OpenCode skips it.

/** OpenCode's global configuration directories, as `config/discovery.ts` finds them. */
const defaultGlobalConfigDirectories = () => {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  const system = process.platform === 'darwin'
    ? '/Library/Application Support/opencode'
    : process.platform === 'win32'
      ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'opencode')
      : '/etc/opencode';
  return [path.join(configHome, 'opencode'), process.env.OPENCODE_CONFIG_DIR?.trim(), system].filter(Boolean);
};

const CONFIG_FILES = ['opencode.json', 'opencode.jsonc'];
const PLUGIN_DIRECTORIES = ['plugin', 'plugins'];
const PLUGIN_SOURCE = /\.(ts|js)$/;

// A plugin folder is hashed file by file. Past these limits the remaining
// files count by path and size only, so a huge vendored tree cannot stall the
// check; a change in such a file that keeps its size goes unnoticed.
const TREE_CONTENT_FILE_LIMIT = 500;
const TREE_CONTENT_BYTE_LIMIT = 16 * 1024 * 1024;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const toSlashes = (value) => value.split(path.sep).join('/');

const statOrNull = (fsPromises, target) => fsPromises.stat(target).catch(() => null);

const readDirectoryOrEmpty = (fsPromises, directory) => (
  fsPromises.readdir(directory, { withFileTypes: true }).catch(() => [])
);

/** The levels OpenCode reads config from, nearest first, stopping below home. */
const levelsToScan = (directory, homeDirectory) => {
  const home = homeDirectory ? path.resolve(homeDirectory) : null;
  const levels = [];
  let current = directory;
  for (;;) {
    if (home && current === home) break;
    levels.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return levels;
};

const hashFile = async (fsPromises, file) => sha256(await fsPromises.readFile(file));

const hashTree = async (fsPromises, root) => {
  const lines = [];
  const budget = { files: TREE_CONTENT_FILE_LIMIT, bytes: TREE_CONTENT_BYTE_LIMIT };
  const visit = async (directory) => {
    const entries = (await readDirectoryOrEmpty(fsPromises, directory))
      .filter((entry) => entry.name !== '.git')
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = toSlashes(path.relative(root, target));
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      const info = await statOrNull(fsPromises, target);
      if (!info) continue;
      if (info.isDirectory()) {
        lines.push(`${relative}/ -> link`);
        continue;
      }
      if (budget.files > 0 && budget.bytes >= info.size) {
        budget.files -= 1;
        budget.bytes -= info.size;
        lines.push(`${relative} ${await hashFile(fsPromises, target).catch(() => 'unreadable')}`);
      } else {
        lines.push(`${relative} size:${info.size}`);
      }
    }
  };
  await visit(root);
  return sha256(lines.join('\n'));
};

/** Content hash of a plugin file or folder; null when it is gone. */
const hashPluginTarget = async (fsPromises, target) => {
  const info = await statOrNull(fsPromises, target);
  if (!info) return null;
  return info.isDirectory() ? hashTree(fsPromises, target) : hashFile(fsPromises, target).catch(() => null);
};

const isLocalPluginReference = (value) => (
  value.startsWith('./') || value.startsWith('../') || value.startsWith('file://') || path.isAbsolute(value)
);

const resolveLocalPluginReference = (value, documentDirectory) => {
  if (value.startsWith('file://')) {
    try {
      return new URL(value).pathname;
    } catch {
      return null;
    }
  }
  return path.resolve(documentDirectory, value);
};

// The parts of an OpenCode configuration document that run code. A value of
// another shape starts nothing, so it is skipped.
const pluginSpecSchema = z.union([
  z.string(),
  z.tuple([z.string()]).rest(z.unknown()).transform(([name]) => name),
  z.object({ package: z.string() }).transform((entry) => entry.package),
]);
const commandSchema = z.object({ command: z.array(z.string()) }).transform((entry) => entry.command.join(' '));

const listOf = (schema) => z.array(z.unknown()).catch([]).transform((values) => values.flatMap((value) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [parsed.data] : [];
}));
const namedOf = (schema) => z.record(z.string(), z.unknown()).catch({}).transform((record) => (
  Object.entries(record).flatMap(([name, value]) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? [[name, parsed.data]] : [];
  })
));

const documentSchema = z.object({
  plugin: listOf(pluginSpecSchema).optional(),
  plugins: listOf(pluginSpecSchema).optional(),
  mcp: namedOf(commandSchema).optional(),
  lsp: namedOf(commandSchema).optional(),
  formatter: namedOf(commandSchema).optional(),
  shell: z.string().trim().min(1).optional().catch(undefined),
});

/**
 * The entries of one `opencode.json(c)` that run code: plugins, local MCP
 * servers, language servers, formatters and the shell. `source` is the
 * document's path relative to the assessed folder.
 */
const documentItems = async (fsPromises, file, source) => {
  let text;
  try {
    text = await fsPromises.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const errors = [];
  const parsed = documentSchema.safeParse(parseJsonc(text, errors, { allowTrailingComma: true }));
  if (errors.length > 0 || !parsed.success) {
    // OpenCode may still read what this parser rejects, so an unreadable
    // document counts as code until the user has seen it.
    return [{ kind: 'config', source, name: '', detail: '', hash: sha256(text) }];
  }
  const document = parsed.data;

  const items = [];
  for (const spec of [...(document.plugin ?? []), ...(document.plugins ?? [])]) {
    if (!spec || spec.startsWith('-')) continue;
    if (isLocalPluginReference(spec)) {
      const target = resolveLocalPluginReference(spec, path.dirname(file));
      items.push({
        kind: 'plugin',
        source,
        name: spec,
        detail: '',
        hash: target ? await hashPluginTarget(fsPromises, target) : null,
      });
      continue;
    }
    items.push({ kind: 'package', source, name: spec, detail: '', hash: null });
  }

  for (const kind of ['mcp', 'lsp', 'formatter']) {
    for (const [name, command] of document[kind] ?? []) {
      items.push({ kind, source, name, detail: command, hash: null });
    }
  }
  if (document.shell) {
    items.push({ kind: 'shell', source, name: '', detail: document.shell, hash: null });
  }
  return items;
};

const pluginDirectoryItems = async (fsPromises, opencodeDirectory, directory) => {
  const items = [];
  for (const name of PLUGIN_DIRECTORIES) {
    const pluginDirectory = path.join(opencodeDirectory, name);
    const entries = (await readDirectoryOrEmpty(fsPromises, pluginDirectory))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const target = path.join(pluginDirectory, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        const info = await statOrNull(fsPromises, target);
        isDirectory = Boolean(info?.isDirectory());
        isFile = Boolean(info?.isFile());
      }
      if (!isDirectory && !(isFile && PLUGIN_SOURCE.test(entry.name))) continue;
      items.push({
        kind: 'plugin',
        source: toSlashes(path.relative(directory, target)),
        name: '',
        detail: '',
        hash: await hashPluginTarget(fsPromises, target),
      });
    }
  }
  return items;
};

const isDirectoryAt = async (fsPromises, target) => Boolean((await statOrNull(fsPromises, target))?.isDirectory());

const configItems = async (fsPromises, directory, homeDirectory, globalDirectories) => {
  if (globalDirectories.has(directory)) return [];
  const items = [];
  for (const level of levelsToScan(directory, homeDirectory)) {
    if (globalDirectories.has(level)) continue;
    const opencodeDirectory = path.join(level, '.opencode');
    if (await isDirectoryAt(fsPromises, opencodeDirectory)) {
      items.push(...await pluginDirectoryItems(fsPromises, opencodeDirectory, directory));
      for (const name of CONFIG_FILES) {
        const file = path.join(opencodeDirectory, name);
        items.push(...await documentItems(fsPromises, file, toSlashes(path.relative(directory, file))));
      }
    }
    for (const name of CONFIG_FILES) {
      const file = path.join(level, name);
      items.push(...await documentItems(fsPromises, file, toSlashes(path.relative(directory, file))));
    }
  }
  return items;
};

/**
 * The repository a folder belongs to, so every worktree of one repository
 * shares its trust answers: the common git dir for a checkout or a linked
 * worktree, the folder itself outside Git.
 */
const repositoryKey = async (fsPromises, directory) => {
  let current = directory;
  for (;;) {
    const dotGit = path.join(current, '.git');
    const info = await fsPromises.lstat(dotGit).catch(() => null);
    if (info?.isDirectory()) {
      return fsPromises.realpath(dotGit).catch(() => dotGit);
    }
    if (info?.isFile()) {
      const pointer = await fsPromises.readFile(dotGit, 'utf8').catch(() => '');
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (match) {
        const gitDir = path.resolve(current, match[1].trim());
        const common = (await fsPromises.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
        const commonDir = common ? path.resolve(gitDir, common) : gitDir;
        return fsPromises.realpath(commonDir).catch(() => commonDir);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return directory;
    current = parent;
  }
};

const fingerprintOf = (items) => (
  items.length === 0
    ? null
    : sha256(JSON.stringify(items.map(({ kind, source, name, detail, hash }) => [kind, source, name, detail, hash])))
);

/**
 * What OpenCode would run from `directory`'s configuration, with a
 * fingerprint of it and the repository it belongs to. `fingerprint` is null
 * when there is nothing to run. A folder that does not exist has nothing:
 * OpenCode cannot open it either.
 */
export const assessOpenCodeConfig = async (directory, {
  fsPromises = fs.promises,
  homeDirectory = os.homedir(),
  globalConfigDirectories = defaultGlobalConfigDirectories(),
} = {}) => {
  const resolved = await fsPromises.realpath(path.resolve(directory)).catch(() => null);
  if (!resolved) {
    return { directory, repositoryKey: path.resolve(directory), fingerprint: null, items: [] };
  }
  const globalDirectories = new Set(await Promise.all(globalConfigDirectories.map((candidate) => (
    fsPromises.realpath(path.resolve(candidate)).catch(() => path.resolve(candidate))
  ))));
  const items = await configItems(fsPromises, resolved, homeDirectory, globalDirectories);
  return {
    directory: resolved,
    repositoryKey: await repositoryKey(fsPromises, resolved),
    fingerprint: fingerprintOf(items),
    items,
  };
};
