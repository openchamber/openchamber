import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProtectedMcpError } from './contract.js';

const ancestors = (target) => {
  const chain = [];
  let current = target;
  for (;;) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
};

const run = (command, args) => new Promise((resolve) => {
  execFile(command, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    resolve(error ? { ok: false, code: error.code } : { ok: true, stdout });
  });
});

/**
 * Named ACL entries that let the engine write, from `getfacl`. Null when the
 * tool is missing, which the caller reports as not inspected rather than clean.
 * A run that fails throws `acl_unreadable`: unknown, never a confirmed writer.
 */
async function readAclWriters(target, engine) {
  const result = await run('getfacl', ['-cpn', '--', target]);
  if (!result.ok) {
    if (result.code === 'ENOENT') return null;
    throw new ProtectedMcpError('acl_unreadable', { status: 500, message: `acl_unreadable: ${target}` });
  }
  const mask = /^mask::(\S+)$/m.exec(result.stdout)?.[1] ?? 'rwx';
  const writers = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^(user|group):(\d+):(\S+)/.exec(line.trim());
    if (!match || !match[3].includes('w') || !mask.includes('w')) continue;
    const id = Number(match[2]);
    if ((match[1] === 'user' && id === engine.uid) || (match[1] === 'group' && engine.gids.includes(id))) writers.push(line.trim());
  }
  return writers;
}

/**
 * Every entry resolving a path passes through, walked the way the kernel walks
 * it: from `/`, one component at a time, following a symbolic link wherever it
 * appears, in a directory component as much as in the last one. The engine
 * could repoint what runs through any link or directory on that way, such as an
 * `alternatives` hop or a linked `bin` directory, so every one of them counts.
 * `..` after a link climbs from where the link led, as the kernel does, so the
 * path is never normalized as text.
 */
async function resolutionPaths(target) {
  const visited = ['/'];
  let current = '/';
  const pending = (path.isAbsolute(target) ? target : `${process.cwd()}/${target}`).split('/');
  let hops = 0;
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === '' || name === '.') continue;
    if (name === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, name);
    visited.push(next);
    let link;
    try {
      link = await fs.readlink(next);
    } catch (error) {
      // Not a link: a directory on the way, or the file itself.
      if (error.code === 'EINVAL') {
        current = next;
        continue;
      }
      // Missing or unreadable: the caller's own check of this entry reports it.
      break;
    }
    hops += 1;
    if (hops > 40) break;
    if (path.isAbsolute(link)) current = '/';
    pending.unshift(...link.split('/'));
  }
  return visited;
}

/** The numeric identity of a local account, from the system's own `id`. */
export async function resolveIdentity(user) {
  const [uid, gids] = await Promise.all([run('id', ['-u', '--', user]), run('id', ['-G', '--', user])]);
  if (!uid.ok || !gids.ok) throw new ProtectedMcpError('unknown_account', { status: 500, message: `unknown_account: ${user}` });
  return { uid: Number(uid.stdout.trim()), gids: gids.stdout.trim().split(/\s+/).map(Number) };
}

/**
 * Checks that the engine identity cannot change a path: every directory and
 * link resolving it passes through, its real path and every ancestor of that
 * must belong to a trusted owner and be writable by nobody else, ACLs included.
 */
export function createIntegrity({ owners, groups = [0], engine, readAcl = readAclWriters }) {
  /**
   * One entry's ACL into `findings`. A failed read is the finding
   * `acl_unreadable`, which still refuses to run what sits there. Answers
   * false when this host cannot inspect ACLs at all.
   */
  const checkAcl = async (element, findings) => {
    let writers;
    try {
      writers = await readAcl(element, engine);
    } catch (error) {
      if (error?.code !== 'acl_unreadable') throw error;
      findings.push({ code: 'acl_unreadable', subject: element });
      return true;
    }
    if (writers === null) return false;
    if (writers.length > 0) findings.push({ code: 'acl_writable_by_engine', subject: element });
    return true;
  };

  /**
   * One existing entry into `findings`: its owner, and unless it is a link,
   * its mode bits and ACL. Answers false when this host cannot inspect ACLs.
   */
  const checkEntry = async (element, stats, findings, { acl = true } = {}) => {
    if (stats.uid === engine.uid) findings.push({ code: 'owned_by_engine', subject: element });
    else if (!owners.includes(stats.uid)) findings.push({ code: 'untrusted_owner', subject: element });
    if (stats.isSymbolicLink()) return true;
    if (stats.mode & 0o002) findings.push({ code: 'writable_by_others', subject: element });
    if (stats.mode & 0o020 && (engine.gids.includes(stats.gid) || !groups.includes(stats.gid))) {
      findings.push({ code: 'writable_by_group', subject: element });
    }
    return acl ? checkAcl(element, findings) : true;
  };

  /**
   * Findings for a path. With `allowMissing`, a path that does not exist is
   * judged by the entries on its way up to the first missing one: when nobody
   * else can write any of them, nobody else can create it later either. Any
   * other failure to resolve it, such as a directory the service may not
   * search, is a finding.
   */
  const inspect = async (target, { acl = true, allowMissing = false } = {}) => {
    const findings = [];
    let real = null;
    try {
      real = await fs.realpath(target);
    } catch (error) {
      const absent = error.code === 'ENOENT' || error.code === 'ENOTDIR';
      if (!allowMissing || !absent) return { findings: [{ code: 'path_missing', subject: target }], aclInspected: false, real: null };
    }
    let aclInspected = acl;
    const way = await resolutionPaths(target);
    for (const element of new Set(real ? [...way, ...ancestors(real)] : way)) {
      let stats;
      try {
        stats = await fs.lstat(element);
      } catch (error) {
        // The way to a missing path ends at its first missing entry.
        if (!real && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) break;
        findings.push({ code: 'path_missing', subject: element });
        continue;
      }
      if (!(await checkEntry(element, stats, findings, { acl }))) aclInspected = false;
    }
    return { findings, aclInspected, real };
  };

  /**
   * The path and its ancestors, then everything below it: one writable file or
   * directory inside the installed tree lets the engine change what runs.
   * Symbolic links are judged by their own owner and are not followed.
   */
  const inspectTree = async (root) => {
    const top = await inspect(root);
    const findings = [...top.findings];
    let aclInspected = top.aclInspected;
    if (!top.real) return { findings, aclInspected };
    const walk = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (!(await checkEntry(full, await fs.lstat(full), findings))) aclInspected = false;
        if (entry.isDirectory()) await walk(full);
      }
    };
    await walk(top.real);
    return { findings, aclInspected };
  };

  return {
    inspect,
    inspectTree,
    /** Named ACL entries that let the engine write to a path; null without `getfacl`; throws `acl_unreadable` when the read fails. */
    aclWriters: (target) => readAcl(target, engine),
    /**
     * Refuses a path argument the engine could change. A path that does not
     * exist passes only where the engine could not create it before the
     * worker reads it.
     */
    async checkArgument(target) {
      const { findings } = await inspect(target, { allowMissing: true });
      if (findings.length > 0) throw new ProtectedMcpError('untrusted_argument', { status: 500, message: `untrusted_argument: ${findings[0].code}` });
    },
    /** The real path of an executable the service may run with credentials, or a refusal. */
    async checkExecutable(target) {
      const { findings, real } = await inspect(target);
      if (findings.length > 0 || !real) throw new ProtectedMcpError('untrusted_executable', { status: 500, message: `untrusted_executable: ${findings[0]?.code ?? 'missing'}` });
      const stats = await fs.stat(real);
      if (!stats.isFile() || (stats.mode & 0o111) === 0) throw new ProtectedMcpError('untrusted_executable', { status: 500, message: 'untrusted_executable: not_executable' });
      return real;
    },
  };
}
