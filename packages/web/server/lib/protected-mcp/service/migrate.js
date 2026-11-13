#!/usr/bin/env node
// Moves connections from another credential holder, such as dev-server's
// per-domain brokers, into the protected service. Run as root with the
// service stopped. Credentials come from files a person names on the command
// line and go straight into the service's state; nothing prints them.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlainObject, isString } from '../../shared/guards.js';
import { ProtectedMcpError, isConnectionId } from './contract.js';
import { destinationFingerprint, parseDefinition, secretSlots } from './definitions.js';
import { ensurePrivateDirectory, openStore, readDefinitions, writePrivateFile } from './store.js';

const SOURCE = /^[a-z0-9][a-z0-9_.:/-]{0,127}$/;
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const PROJECT_PATH = (value) => isString(value) && path.isAbsolute(value) && !value.includes('\0');

const fail = (code, message) => {
  throw new ProtectedMcpError(code, { status: 400, message: message ?? code });
};

/**
 * The plan: connections to create, where each credential comes from, and the
 * selections OpenChamber should get. It holds paths and names, never values.
 */
export function parseManifest(value) {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.connections)) fail('invalid_manifest', 'version 1 with a connections list');
  const ids = new Set();
  const names = new Set();
  const connections = value.connections.map((entry, index) => {
    if (!isPlainObject(entry)) fail('invalid_manifest', `connections.${index}`);
    if (!isConnectionId(entry.id) || ids.has(entry.id)) fail('invalid_manifest', `connections.${index}.id`);
    if (!SOURCE.test(entry.source ?? '')) fail('invalid_manifest', `connections.${index}.source`);
    const definition = parseDefinition(entry.definition);
    if (names.has(definition.name)) fail('invalid_manifest', `connections.${index}.definition.name`);
    ids.add(entry.id);
    names.add(definition.name);
    const slots = secretSlots(definition);
    const credentials = entry.credentials ?? {};
    if (!isPlainObject(credentials)) fail('invalid_manifest', `connections.${index}.credentials`);
    for (const slot of Object.keys(credentials)) if (!slots.includes(slot)) fail('invalid_manifest', `connections.${index}.credentials.${slot}`);
    for (const slot of slots) {
      const from = credentials[slot];
      const valid = isPlainObject(from) && (
        (isString(from.envFile) && path.isAbsolute(from.envFile) && isString(from.key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(from.key) && Object.keys(from).length === 2)
        || (isString(from.file) && path.isAbsolute(from.file) && Object.keys(from).length === 1));
      if (!valid) fail('invalid_manifest', `connections.${index}.credentials.${slot}`);
    }
    if (entry.expectedTools !== undefined && (!Array.isArray(entry.expectedTools) || !entry.expectedTools.every(isString))) {
      fail('invalid_manifest', `connections.${index}.expectedTools`);
    }
    // Token caches and grants the old holder keeps on disk, copied into the worker's private directory.
    const stateFiles = entry.stateFiles ?? [];
    if (!Array.isArray(stateFiles)) fail('invalid_manifest', `connections.${index}.stateFiles`);
    for (const [fileIndex, file] of stateFiles.entries()) {
      const target = isString(file?.to) ? path.posix.normalize(file.to) : '';
      if (!isPlainObject(file) || !isString(file.from) || !path.isAbsolute(file.from) || !target
        || path.posix.isAbsolute(target) || target === '..' || target.startsWith('../') || Object.keys(file).length !== 2) {
        fail('invalid_manifest', `connections.${index}.stateFiles.${fileIndex}`);
      }
    }
    return { id: entry.id, source: entry.source, definition, credentials, stateFiles, expectedTools: entry.expectedTools ?? null };
  });
  const selections = value.selections ?? [];
  if (!Array.isArray(selections)) fail('invalid_manifest', 'selections');
  for (const [index, selection] of selections.entries()) {
    if (!isPlainObject(selection) || !ids.has(selection.connection) || !isString(selection.name)) fail('invalid_manifest', `selections.${index}`);
    if (selection.scope === 'project' ? !PROJECT_PATH(selection.project) : selection.scope !== 'global') fail('invalid_manifest', `selections.${index}.scope`);
  }
  return { connections, selections };
}

/** The value of one `KEY=value` line, decoded the way systemd reads an EnvironmentFile it wrote with JSON quoting. */
export function readEnvironmentValue(text, key) {
  for (const line of text.split('\n')) {
    const match = ENV_LINE.exec(line.trim());
    if (!match || match[1] !== key) continue;
    const raw = match[2];
    if (raw.startsWith('"')) {
      try {
        return JSON.parse(raw);
      } catch {
        fail('credential_unreadable', `${key} is not a quoted value`);
      }
    }
    return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  }
  return null;
}

const readCredential = async (from) => {
  if (from.file) return (await fs.readFile(from.file, 'utf8')).replace(/\r?\n$/, '');
  return readEnvironmentValue(await fs.readFile(from.envFile, 'utf8'), from.key);
};

const fingerprintOf = (credential) => createHash('sha256').update(credential).digest('hex').slice(0, 12);

/**
 * Applies the manifest. Each connection's journal entry moves from `pending`
 * to `created` to `done`, so a run that stopped half way picks up where it
 * stopped, state files included, and `rollback` removes exactly what this
 * migration created. A connection the migration did not create is left as it
 * is when its definition matches, and refused otherwise.
 */
export async function migrate({ stateDir, manifest, dryRun = false, readCredentialValue = readCredential, readStateFile = (file) => fs.readFile(file) }) {
  const journalDir = path.join(stateDir, 'migrations');
  if (!dryRun) {
    await ensurePrivateDirectory(stateDir);
    await ensurePrivateDirectory(journalDir);
  }
  const journalFile = path.join(journalDir, 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8').catch(() => '{"version":1,"created":[]}'));
  const report = [];
  // Every credential is read before anything is written, so a missing one stops the run untouched.
  const values = new Map();
  for (const connection of manifest.connections) {
    for (const file of connection.stateFiles) {
      await fs.access(file.from).catch(() => fail('state_file_missing', `${connection.source}: ${file.from} is missing`));
    }
    const slots = {};
    for (const [slot, from] of Object.entries(connection.credentials)) {
      let value;
      try {
        value = await readCredentialValue(from);
      } catch (error) {
        if (error instanceof ProtectedMcpError) throw error;
        fail('credential_unreadable', `${connection.source}: credential ${slot} could not be read (${error.code ?? 'error'})`);
      }
      if (!isString(value) || value.length === 0) fail('credential_missing', `${connection.source}: credential ${slot} is empty or absent`);
      slots[slot] = value;
    }
    values.set(connection.id, slots);
  }
  // A dry run only reads: opening the store would take the lock, create
  // directories and delete orphan credential files.
  const store = dryRun ? null : await openStore({ stateDir });
  const stored = dryRun ? await readDefinitions(stateDir) : null;
  const existingOf = (id) => (store ? store.get(id) : stored.get(id));
  const saveJournal = () => writePrivateFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
  const copyStateFiles = async (connection) => {
    const directory = await store.connectionDirectory(connection.id);
    for (const file of connection.stateFiles) {
      const target = path.join(directory, file.to);
      await ensurePrivateDirectory(path.dirname(target));
      await writePrivateFile(target, await readStateFile(file.from));
    }
  };
  try {
    for (const connection of manifest.connections) {
      const existing = existingOf(connection.id);
      const entry = journal.created.find((item) => item.id === connection.id) ?? null;
      const secrets = values.get(connection.id);
      const line = { id: connection.id, source: connection.source, name: connection.definition.name, credentials: Object.keys(secrets).sort(), action: '' };
      // Lets a person match the source to the stored value without seeing either.
      line.fingerprints = Object.fromEntries(Object.entries(secrets).map(([slot, value]) => [slot, fingerprintOf(value)]));
      line.stateFiles = connection.stateFiles.map((file) => file.to);
      if (existing) {
        const same = destinationFingerprint(existing) === destinationFingerprint(connection.definition)
          && JSON.stringify(existing.policy) === JSON.stringify(connection.definition.policy);
        if (!same) fail('conflicting_connection', `${connection.id} exists with another destination or policy`);
        if (entry && entry.state !== 'done') {
          // Created by an earlier run that stopped before its state files were all copied.
          line.action = dryRun ? 'would-resume' : 'resumed';
          if (!dryRun) {
            await copyStateFiles(connection);
            entry.state = 'done';
            await saveJournal();
          }
        } else {
          line.action = 'present';
        }
        report.push(line);
        continue;
      }
      line.action = dryRun ? 'would-create' : 'created';
      if (!dryRun) {
        const record = entry ?? { id: connection.id, state: 'pending' };
        if (!entry) journal.created.push(record);
        record.state = 'pending';
        await saveJournal();
        await store.apply({ kind: 'create', definition: connection.definition, secrets }, { id: connection.id });
        record.state = 'created';
        await saveJournal();
        await copyStateFiles(connection);
        record.state = 'done';
        await saveJournal();
      }
      report.push(line);
    }
  } finally {
    await store?.close();
  }
  return { report, selections: manifest.selections };
}

/** Removes every connection this migration created, newest first, and nothing else. */
export async function rollbackMigration({ stateDir }) {
  const journalFile = path.join(stateDir, 'migrations', 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8').catch(() => '{"version":1,"created":[]}'));
  const store = await openStore({ stateDir });
  const removed = [];
  try {
    for (const entry of [...journal.created].reverse()) {
      const definition = store.get(entry.id);
      if (definition) await store.apply({ kind: 'remove', id: entry.id, expectedRevision: definition.revision });
      removed.push(entry.id);
    }
  } finally {
    await store.close();
  }
  await writePrivateFile(journalFile, `${JSON.stringify({ version: 1, created: [] }, null, 2)}\n`);
  return { removed };
}

/** Compares the tools a connection lists after migration with those the old holder listed. */
export function compareTools({ expected, actual }) {
  const want = new Set(expected);
  const have = new Set(actual);
  return {
    missing: [...want].filter((name) => !have.has(name)).sort(),
    added: [...have].filter((name) => !want.has(name)).sort(),
  };
}

const USAGE = `Usage: migrate.js <command> --state <dir> [--manifest <file>] [--dry-run]   (as root, service stopped)

Commands:
  apply      Create the manifest's connections with credentials read from the
             files it names. --dry-run checks everything and writes nothing.
  rollback   Remove the connections the last apply created.

The report lists each connection, the credential slots it filled and a short
fingerprint of each value to compare with the source, never the value.
The selections in the manifest are printed for OpenChamber; apply them with
PUT /api/protected-mcp/selections/<name> or in Settings.
`;

/** Gives everything under the state directory back to its owner: the tool runs as root, the service does not. */
async function restoreOwner(stateDir, { uid, gid }) {
  for (const entry of await fs.readdir(stateDir, { recursive: true })) await fs.lchown(path.join(stateDir, entry), uid, gid);
  await fs.lchown(stateDir, uid, gid);
}

/** The command line; `getuid` and `restore` are the parts of the host a test replaces. */
export async function cli(argv, { getuid = () => process.getuid(), restore = restoreOwner } = {}) {
  const [command, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const option = (name) => {
    const index = rest.indexOf(name);
    return index === -1 ? null : rest[index + 1] ?? null;
  };
  if (!command || command === '--help' || rest.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const stateDir = option('--state') ?? '/var/lib/openchamber-protected-mcp';
  const owner = await fs.stat(stateDir).then((stats) => ({ uid: stats.uid, gid: stats.gid }), () => null);
  if (!owner) fail('state_missing', `${stateDir} does not exist; install the service first`);
  try {
    if (command === 'apply') {
      const manifest = parseManifest(JSON.parse(await fs.readFile(option('--manifest') ?? '', 'utf8')));
      const result = await migrate({ stateDir, manifest, dryRun });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (command === 'rollback') {
      process.stdout.write(`${JSON.stringify(await rollbackMigration({ stateDir }), null, 2)}\n`);
      return 0;
    }
  } finally {
    // Root's writes go back to the service's account. A dry run wrote nothing, so it changes no owner.
    if (getuid() === 0 && !(command === 'apply' && dryRun)) await restore(stateDir, owner);
  }
  process.stderr.write(USAGE);
  return 64;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await fs.realpath(process.argv[1])) {
  cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error.code ?? 'error'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
