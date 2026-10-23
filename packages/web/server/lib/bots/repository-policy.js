import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const text = z.string().trim().min(1).max(20_000);
const relativePath = z.string().min(1).refine((value) => !value.includes('\\') && !value.includes('\0')
  && !path.posix.isAbsolute(value) && !value.split('/').some((part) => part === '..' || part === '.' || part === ''), 'expected a repository-relative path');
const areaSchema = z.object({ name: text, paths: z.array(relativePath).min(1), level: z.enum(['human', 'judgment']), owners: z.array(text).default([]) }).strict();
const personSchema = z.object({ id: text, name: text, roles: z.array(text), github: text.optional(), jira: text.optional(), discord: text.optional() }).strict();
const peopleSchema = z.array(personSchema).refine((people) => new Set(people.map((person) => person.id)).size === people.length, 'person ids must be unique');
const MAX_POLICY_BYTES = 1024 * 1024;
const fingerprintOf = (raw) => createHash('sha256').update(raw).digest('hex');
const inside = (root, file) => file === root || (!path.relative(root, file).startsWith(`..${path.sep}`) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));

// Reject links at every component, including links pointing back into the repo.
// Verify again around the opened handle so replacement never grants approval.
const checkedPath = async (root, relative) => {
  relativePath.parse(relative);
  let file = root;
  for (const component of relative.split('/')) {
    file = path.join(file, component);
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Repository policy cannot follow symlinks');
  }
  if (!inside(root, await fs.realpath(file))) throw new Error('Repository policy escaped the repository');
  return file;
};
const readTrustedPath = async (root, relative) => {
  const file = await checkedPath(root, relative);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) throw new Error('Invalid repository policy file size or kind');
    // Linux exposes the opened file's canonical path independently of pathname replacement.
    if (process.platform === 'linux' && !inside(root, await fs.realpath(`/proc/self/fd/${handle.fd}`))) throw new Error('Repository policy escaped the repository');
    await checkedPath(root, relative);
    const raw = await handle.readFile('utf8');
    const current = await fs.stat(await checkedPath(root, relative));
    const after = await handle.stat();
    if (current.dev !== stat.dev || current.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Repository policy changed while reading');
    if (Buffer.byteLength(raw) > MAX_POLICY_BYTES) throw new Error('Repository policy exceeds the size boundary');
    return raw;
  } finally { await handle.close(); }
};

const parseArea = (raw) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error('Area policy needs YAML frontmatter');
  return { ...areaSchema.parse(parseYaml(match[1])), body: match[2].trim() };
};

/** No repository file is written here. Missing previously approved rules remain blocking. */
export const readRepositoryPolicy = async (projectPath, approvals = {}) => {
  const root = await fs.realpath(projectPath);
  const areas = [];
  const issues = [];
  const files = new Set(Object.keys(approvals).filter((file) => file.startsWith('.agents/areas/')));
  try {
    const directory = await checkedPath(root, '.agents/areas');
    for (const name of await fs.readdir(directory)) if (name.endsWith('.md')) files.add(`.agents/areas/${name}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') issues.push({ file: '.agents/areas', error: error.message });
  }
  for (const file of [...files].sort()) {
    try {
      const raw = await readTrustedPath(root, file);
      const area = parseArea(raw);
      const fingerprint = fingerprintOf(raw);
      const status = approvals[file] === fingerprint ? 'approved' : (approvals[file] ? 'changed' : 'unapproved');
      areas.push({ file, fingerprint, status, ...area });
    } catch (error) { issues.push({ file, error: error.message }); }
  }
  const file = '.openchamber/people.json';
  let people = { file, status: 'missing', people: [] };
  try {
    const raw = await readTrustedPath(root, file);
    const entries = peopleSchema.parse(JSON.parse(raw));
    const fingerprint = fingerprintOf(raw);
    const status = approvals[file] === fingerprint ? 'approved' : (approvals[file] ? 'changed' : 'unapproved');
    // The person must review the exact bytes before approving them. Display
    // content never supplies routing identities until this fingerprint is trusted.
    people = { file, fingerprint, status, content: raw, people: status === 'approved' ? entries : [] };
  } catch (error) {
    if (error?.code !== 'ENOENT' || approvals[file]) people = { file, status: 'invalid', people: [], error: error.message };
  }
  const fingerprint = fingerprintOf(JSON.stringify({ areas, people, issues }));
  return { areas, people, issues, fingerprint };
};

/** Explicit machine approval must name the exact bytes the person reviewed. */
export const approveRepositoryPolicy = async ({ config, projectId, projectPath, file, fingerprint }) => {
  const policy = await readRepositoryPolicy(projectPath);
  const entry = file === policy.people.file ? policy.people : policy.areas.find((area) => area.file === file);
  if (!entry || !entry.fingerprint || entry.fingerprint !== fingerprint) throw new Error('Repository policy changed or is unreadable; review it again');
  await config.setApproval(projectId, file, fingerprint);
};

export const isFixedHumanPath = (file) => {
  relativePath.parse(file);
  return ['.agents/areas', '.openchamber', '.github'].some((directory) => file === directory || file.startsWith(`${directory}/`))
    || path.posix.basename(file) === 'CODEOWNERS';
};

/** Diff entries carry both paths. Missing newPath represents deletion. */
export const evaluateRepositoryPolicy = (policy, changes) => {
  const entries = z.array(z.object({ oldPath: relativePath.nullable().optional(), newPath: relativePath.nullable().optional() }).strict()
    .refine((entry) => Boolean(entry.oldPath || entry.newPath), 'diff entry needs a path')).parse(changes);
  const paths = [...new Set(entries.flatMap((entry) => [entry.oldPath, entry.newPath].filter(Boolean)))];
  const matched = policy.areas.filter((area) => paths.some((file) => area.paths.some((pattern) => path.matchesGlob(file, pattern))));
  const untrusted = policy.issues.length > 0 || policy.areas.some((area) => area.status !== 'approved');
  const fixed = paths.some(isFixedHumanPath);
  const human = fixed || untrusted || matched.some((area) => area.level === 'human');
  return {
    level: human ? 'human' : (matched.length ? 'judgment' : 'none'),
    reason: fixed ? 'Fixed human path' : untrusted ? 'Area policy requires approval or repair' : human ? 'Human area' : 'Area policy evaluated',
    areas: matched, owners: [...new Set(matched.flatMap((area) => area.owners))],
    peopleTrusted: policy.people.status === 'approved', policyFingerprint: policy.fingerprint,
  };
};

/** An unresolved person or service identity requires a question; blame is not identity authority. */
export const resolvePolicyPeople = (policy, { owners = [], role, service }) => {
  z.enum(['github', 'jira', 'discord']).parse(service);
  if (policy.people.status !== 'approved') return { status: 'ask', reason: 'People directory needs approval', people: [] };
  const people = policy.people.people;
  const selected = owners.length ? owners.map((id) => people.find((person) => person.id === id)) : people.filter((person) => role && person.roles.includes(role));
  if (!selected.length || selected.some((person) => !person || !person[service])) return { status: 'ask', reason: 'Person or service identity is unresolved', people: [] };
  return { status: 'resolved', people: selected };
};
