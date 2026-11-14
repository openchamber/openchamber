import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import yaml from 'yaml';
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
const SCRIPT_SOURCE = /\.[cm]?[jt]sx?$/;
// `from '…'`, `import '…'`, `import('…')` and `require('…')`. A match in a
// comment or a string only hashes one more file.
const IMPORT_SPECIFIER = /\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`\n]+)\1/g;
const IMPORT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

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

const newBudget = () => ({ files: TREE_CONTENT_FILE_LIMIT, bytes: TREE_CONTENT_BYTE_LIMIT });

/** Takes one file of `size` bytes from `budget`; false once it is spent. */
const spend = (budget, size) => {
  if (budget.files <= 0 || budget.bytes < size) return false;
  budget.files -= 1;
  budget.bytes -= size;
  return true;
};

/** Hash of a plugin folder and the script files in it, whose imports are followed. */
const hashTree = async (fsPromises, root) => {
  const lines = [];
  const scripts = [];
  const budget = newBudget();
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
      if (spend(budget, info.size)) {
        lines.push(`${relative} ${await hashFile(fsPromises, target).catch(() => 'unreadable')}`);
        if (SCRIPT_SOURCE.test(entry.name)) scripts.push(target);
      } else {
        lines.push(`${relative} size:${info.size}`);
      }
    }
  };
  await visit(root);
  return { hash: sha256(lines.join('\n')), scripts };
};

const isFileAt = async (fsPromises, target) => Boolean((await statOrNull(fsPromises, target))?.isFile());

/** The file a local import names, the way Bun resolves it; null when there is none. */
const resolveImport = async (fsPromises, specifier, fromDirectory) => {
  const base = resolveLocalPluginReference(specifier, fromDirectory);
  if (!base) return null;
  const candidates = [
    base,
    // TypeScript sources import each other by their emitted `.js` names.
    base.replace(/\.([mc]?)js(x?)$/, '.$1ts$2'),
    ...IMPORT_EXTENSIONS.map((extension) => base + extension),
    ...IMPORT_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (await isFileAt(fsPromises, candidate)) return candidate;
  }
  return null;
};

/**
 * Lines naming every local file a plugin's scripts import, directly or
 * through each other, outside the plugin itself, each with its content hash,
 * plus every local import that names no file yet. Package imports are not
 * followed: a repository does not write `node_modules`.
 */
const importedFileLines = async (fsPromises, pluginRoot, base, scripts) => {
  const isOwn = (file) => file === pluginRoot || file.startsWith(pluginRoot + path.sep);
  const relative = (file) => toSlashes(path.relative(base, file));
  const budget = newBudget();
  const seen = new Set(scripts);
  const queue = [...scripts];
  const lines = [];
  while (queue.length > 0) {
    const file = queue.shift();
    const info = await statOrNull(fsPromises, file);
    if (!info) continue;
    if (!spend(budget, info.size)) {
      if (!isOwn(file)) lines.push(`${relative(file)} size:${info.size}`);
      continue;
    }
    const content = await fsPromises.readFile(file).catch(() => null);
    if (!content) continue;
    if (!isOwn(file)) lines.push(`${relative(file)} ${sha256(content)}`);
    if (!SCRIPT_SOURCE.test(file)) continue;
    for (const [, , specifier] of content.toString('utf8').matchAll(IMPORT_SPECIFIER)) {
      if (specifier.includes('${') || !isLocalPluginReference(specifier)) continue;
      const target = await resolveImport(fsPromises, specifier, path.dirname(file));
      if (!target) {
        lines.push(`${relative(file)} imports ${specifier}: missing`);
        continue;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return lines.sort();
};

/**
 * Content hash of a plugin file or folder and the local files it imports;
 * null when it is gone. A plugin that imports nothing local keeps the hash of
 * its own content, so answers given before imports were followed still hold.
 */
const hashPluginTarget = async (fsPromises, target) => {
  const info = await statOrNull(fsPromises, target);
  if (!info) return null;
  const own = info.isDirectory()
    ? await hashTree(fsPromises, target)
    : { hash: await hashFile(fsPromises, target).catch(() => null), scripts: [target] };
  if (own.hash === null) return null;
  const imports = await importedFileLines(fsPromises, target, info.isDirectory() ? target : path.dirname(target), own.scripts);
  return imports.length === 0 ? own.hash : sha256([own.hash, ...imports].join('\n'));
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

const recordSchema = z.record(z.string(), z.unknown()).catch({});

const documentSchema = z.object({
  plugin: listOf(pluginSpecSchema).optional(),
  plugins: listOf(pluginSpecSchema).optional(),
  mcp: namedOf(commandSchema).optional(),
  lsp: namedOf(commandSchema).optional(),
  formatter: namedOf(commandSchema).optional(),
  shell: z.string().trim().min(1).optional().catch(undefined),
  // Agent settings by name: V1 `agent` and `mode`, V2 `agents`.
  agent: recordSchema.optional(),
  agents: recordSchema.optional(),
  mode: recordSchema.optional(),
});

// V1 action names, as `v1/config/migrate.ts` `normalizeAction` maps them.
const V1_ACTIONS = { write: 'edit', patch: 'edit', apply_patch: 'edit', task: 'subagent', bash: 'shell' };
const normalizeAction = (action) => V1_ACTIONS[action] ?? action;

const effectSchema = z.enum(['allow', 'ask', 'deny']);
const v1PermissionSchema = z.union([
  effectSchema.transform((effect) => [['*', '*', effect]]),
  recordSchema.transform((record) => Object.entries(record).flatMap(([action, value]) => {
    const plain = effectSchema.safeParse(value);
    if (plain.success) return [[action, '*', plain.data]];
    return Object.entries(recordSchema.parse(value)).flatMap(([resource, effect]) => {
      const parsed = effectSchema.safeParse(effect);
      return parsed.success ? [[action, resource, parsed.data]] : [];
    });
  })),
]).catch([]);
const ruleSchema = z.object({
  action: z.string(),
  resource: z.string().catch('*'),
  effect: effectSchema,
}).transform((rule) => [rule.action, rule.resource, rule.effect]);
const rulesSchema = z.object({
  tools: recordSchema.optional(),
  permission: v1PermissionSchema.optional(),
  permissions: listOf(ruleSchema).optional(),
}).catch({});

/**
 * The `[action, resource, effect]` rules of a configuration or agent entry,
 * in every shape OpenCode reads (`config/normalize.ts`): V1 `tools` (`true`
 * allows, `false` denies), V1 `permission` (one effect for everything, or per
 * action, plain or per resource) and V2 `permissions` rules.
 */
const permissionRules = (entry) => {
  const rules = rulesSchema.parse(entry);
  return [
    ...Object.entries(rules.tools ?? {}).flatMap(([action, enabled]) => (
      enabled === true ? [[action, '*', 'allow']] : enabled === false ? [[action, '*', 'deny']] : []
    )),
    ...(rules.permission ?? []),
    ...(rules.permissions ?? []),
  ].map(([action, resource, effect]) => [normalizeAction(action), resource, effect]);
};

/** Whether two action patterns can name the same action; `*` and `?` as in OpenCode's `Wildcard`. */
const wildcardMatch = (value, pattern) => new RegExp(
  `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`,
  'is',
).test(value);
const actionsOverlap = (a, b) => a.includes('{') || b.includes('{') || wildcardMatch(a, b) || wildcardMatch(b, a);

/**
 * One item per rule in `entry` that allows an action one of the user's own
 * ask or deny rules restricts: OpenCode evaluates the folder's rules after
 * the user's, so that allow can win. Resources are not compared: shell text,
 * home-relative paths and substituted values make "these two never meet"
 * unprovable, so any allow for a restricted action counts. `agent` is '' for
 * rules every agent gets.
 */
const permissionItems = (entry, source, agent, restrictions) => permissionRules(entry)
  .filter(([action, , effect]) => effect === 'allow' && restrictions.some((restricted) => actionsOverlap(action, restricted)))
  .map(([action, resource]) => ({ kind: 'permission', source, name: agent, detail: `${action} ${resource}`, hash: null }));

// OpenCode replaces these in a configuration file's text before it parses it
// (`config/variable.ts`), wherever they stand, so the value can go to any
// address the file names: a remote MCP server, a provider, an instruction URL.
const SUBSTITUTION = /\{(env|file):([^}]+)\}/g;

/** One item per value a configuration file pulls from the user's machine. */
const substitutionItems = (text, source) => {
  const seen = new Set();
  const items = [];
  for (const match of text.matchAll(SUBSTITUTION)) {
    const [token, kind, name] = match;
    // OpenCode leaves a token on a `//` comment line alone.
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
    if (text.slice(lineStart, match.index).trimStart().startsWith('//')) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    items.push({ kind, source, name, detail: '', hash: null });
  }
  return items;
};

/**
 * The entries of one `opencode.json(c)` that the user has to trust: what
 * runs code (plugins, local MCP servers, language servers, formatters, the
 * shell), the values it reads from the machine, and the permissions it
 * allows. `source` is the document's path relative to the assessed folder.
 */
const readDocument = async (fsPromises, file) => {
  const text = await fsPromises.readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  const errors = [];
  const raw = parseJsonc(text, errors, { allowTrailingComma: true });
  return { text, raw, parsed: errors.length > 0 ? null : documentSchema.safeParse(raw) };
};

/** Every rule of a configuration document: its own and each agent's. */
const documentRules = (raw, document) => [
  ...permissionRules(raw),
  ...['agent', 'agents', 'mode'].flatMap((key) => Object.values(document[key] ?? {}).flatMap(permissionRules)),
];

const documentItems = async (fsPromises, file, source, restrictions) => {
  const read = await readDocument(fsPromises, file);
  if (!read) return [];
  const { text, raw, parsed } = read;
  if (!parsed?.success) {
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
  items.push(...substitutionItems(text, source));
  items.push(...permissionItems(raw, source, '', restrictions));
  for (const key of ['agent', 'agents', 'mode']) {
    for (const [name, entry] of Object.entries(document[key] ?? {})) {
      items.push(...permissionItems(entry, source, name, restrictions));
    }
  }
  return items;
};

// Agent files in a `.opencode/` directory, as `config/plugin/agent.ts`
// discovers them.
const AGENT_DIRECTORIES = [
  { name: 'agent', nested: true },
  { name: 'agents', nested: true },
  { name: 'mode', nested: false },
  { name: 'modes', nested: false },
];
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
// Folders OpenCode's scan skips (`FSUtil.ignoredDirectories`).
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);

/**
 * The `.md` files under `directory`, into subfolders when `nested`. A folder
 * whose real path is already being walked is skipped, so a link back up
 * cannot multiply the walk.
 */
const markdownFiles = async (fsPromises, directory, nested, ancestors = new Set()) => {
  const real = await fsPromises.realpath(directory).catch(() => null);
  if (!real || ancestors.has(real)) return [];
  const walking = new Set(ancestors).add(real);
  const files = [];
  const entries = (await readDirectoryOrEmpty(fsPromises, directory))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const info = entry.isSymbolicLink() ? await statOrNull(fsPromises, target) : entry;
    if (!info) continue;
    if (info.isDirectory()) {
      if (nested && !IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...await markdownFiles(fsPromises, target, nested, walking));
      }
      continue;
    }
    if (info.isFile() && entry.name.endsWith('.md')) files.push(target);
  }
  return files;
};

/**
 * OpenCode's retry for frontmatter YAML rejects (`config/markdown.ts`
 * `sanitize`): a top-level value holding a colon, such as a description
 * "Clean up: dead code", becomes a block scalar.
 */
const sanitizeFrontmatter = (frontmatter) => frontmatter.split(/\r?\n/).flatMap((line) => {
  if (line.trim().startsWith('#') || line.trim() === '' || /^\s+/.test(line)) return [line];
  const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
  if (!entry) return [line];
  const value = entry[2].trim();
  if (value === '' || value === '>' || value === '|' || value.startsWith('"') || value.startsWith("'")) return [line];
  if (!value.includes(':') && !/^[[{].*[\]}]\s*\S/.test(value)) return [line];
  return [`${entry[1]}: |-`, `  ${value}`];
}).join('\n');

// OpenCode's parser expands `<<` merge keys, so an allow can hide in one.
const parseFrontmatter = (frontmatter) => {
  try {
    return yaml.parse(frontmatter, { merge: true });
  } catch {
    return yaml.parse(sanitizeFrontmatter(frontmatter), { merge: true });
  }
};

/**
 * The agent files of one `.opencode/` directory: each with its path, agent
 * name and frontmatter, `data` undefined when neither parse reads it.
 */
const agentFiles = async (fsPromises, opencodeDirectory) => {
  const files = [];
  for (const { name, nested } of AGENT_DIRECTORIES) {
    const root = path.join(opencodeDirectory, name);
    for (const file of await markdownFiles(fsPromises, root, nested)) {
      const text = await fsPromises.readFile(file, 'utf8').catch(() => null);
      const frontmatter = text === null ? null : FRONTMATTER.exec(text)?.[1];
      if (!frontmatter) continue;
      let data;
      try {
        data = parseFrontmatter(frontmatter);
      } catch {
        data = undefined;
      }
      files.push({ file, agent: toSlashes(path.relative(root, file)).replace(/\.md$/, ''), text, frontmatter, data });
    }
  }
  return files;
};

/** The allows in the agent files of one `.opencode/` directory that override the user's rules. */
const agentFileItems = async (fsPromises, opencodeDirectory, directory, restrictions) => {
  if (restrictions.length === 0) return [];
  const items = [];
  for (const { file, agent, text, frontmatter, data } of await agentFiles(fsPromises, opencodeDirectory)) {
    const source = toSlashes(path.relative(directory, file));
    if (data === undefined) {
      // OpenCode may still read what neither parse does, so a file that may
      // name permissions counts until the user has seen it.
      if (/permission|tools/.test(frontmatter)) {
        items.push({ kind: 'config', source, name: '', detail: '', hash: sha256(text) });
      }
      continue;
    }
    items.push(...permissionItems(data, source, agent, restrictions));
  }
  return items;
};

/**
 * The user's own ask and deny rules, as `[action, resource]`: from OpenCode's
 * global configuration directories and the home folder, documents and agent
 * files alike. A folder's allow matters only where it overrides one of these.
 */
const userRestrictions = async (fsPromises, homeDirectory, globalDirectories) => {
  // Folders holding configuration files, and those that also hold agent folders.
  const home = homeDirectory ? path.resolve(homeDirectory) : null;
  const levels = [...globalDirectories, ...(home ? [home, path.join(home, '.opencode')] : [])];
  const rules = [];
  const addDocument = (read) => {
    if (read?.parsed?.success) rules.push(...documentRules(read.raw, read.parsed.data));
  };
  for (const level of levels) {
    for (const name of CONFIG_FILES) addDocument(await readDocument(fsPromises, path.join(level, name)));
    if (level === home) continue;
    for (const { data } of await agentFiles(fsPromises, level)) rules.push(...permissionRules(data));
  }
  // The explicit sources OpenCode loads before a folder's own (`config.ts`).
  if (process.env.OPENCODE_CONFIG) addDocument(await readDocument(fsPromises, process.env.OPENCODE_CONFIG));
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    const raw = parseJsonc(process.env.OPENCODE_CONFIG_CONTENT, [], { allowTrailingComma: true });
    addDocument({ raw, parsed: documentSchema.safeParse(raw) });
  }
  return [...new Set(rules.filter(([, , effect]) => effect !== 'allow').map(([action]) => action))];
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
  const restrictions = await userRestrictions(fsPromises, homeDirectory, globalDirectories);
  const items = [];
  for (const level of levelsToScan(directory, homeDirectory)) {
    if (globalDirectories.has(level)) continue;
    const opencodeDirectory = path.join(level, '.opencode');
    if (await isDirectoryAt(fsPromises, opencodeDirectory)) {
      items.push(...await pluginDirectoryItems(fsPromises, opencodeDirectory, directory));
      for (const name of CONFIG_FILES) {
        const file = path.join(opencodeDirectory, name);
        items.push(...await documentItems(fsPromises, file, toSlashes(path.relative(directory, file)), restrictions));
      }
      items.push(...await agentFileItems(fsPromises, opencodeDirectory, directory, restrictions));
    }
    for (const name of CONFIG_FILES) {
      const file = path.join(level, name);
      items.push(...await documentItems(fsPromises, file, toSlashes(path.relative(directory, file)), restrictions));
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
