import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { approveRepositoryPolicy, evaluateRepositoryPolicy, isFixedHumanPath, readRepositoryPolicy, resolvePolicyPeople } from './repository-policy.js';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
const area = (paths = ['src/**'], level = 'judgment') => `---\nname: Core\npaths: ${JSON.stringify(paths)}\nlevel: ${level}\nowners: [lead]\n---\nReview carefully.\n`;
const setup = async () => {
  const directory = await fs.mkdtemp('/tmp/opencode/bots-policy-');
  directories.push(directory);
  await fs.mkdir(path.join(directory, '.agents/areas'), { recursive: true });
  await fs.mkdir(path.join(directory, '.openchamber'));
  await fs.writeFile(path.join(directory, '.agents/areas/core.md'), area());
  await fs.writeFile(path.join(directory, '.openchamber/people.json'), JSON.stringify([{ id: 'lead', name: 'Lead', roles: ['tech-lead'], github: 'lead-gh', jira: 'lead-jira', discord: 'lead-discord' }]));
  return directory;
};
const approvalsOf = (policy) => Object.fromEntries([...policy.areas.map((entry) => [entry.file, entry.fingerprint]), [policy.people.file, policy.people.fingerprint]]);

it('requires exact machine approval, preserves team files and rejects stale approval requests', async () => {
  const root = await setup();
  const unapproved = await readRepositoryPolicy(root);
  expect(evaluateRepositoryPolicy(unapproved, [{ newPath: 'unrelated.txt' }]).level).toBe('human');
  expect(resolvePolicyPeople(unapproved, { owners: ['lead'], service: 'github' }).status).toBe('ask');
  const approvals = {};
  const config = { setApproval: async (_project, file, fingerprint) => { approvals[file] = fingerprint; } };
  for (const entry of [...unapproved.areas, unapproved.people]) await approveRepositoryPolicy({ config, projectId: 'p', projectPath: root, file: entry.file, fingerprint: entry.fingerprint });
  const trusted = await readRepositoryPolicy(root, approvals);
  expect(evaluateRepositoryPolicy(trusted, [{ newPath: 'src/core.js' }])).toMatchObject({ level: 'judgment', owners: ['lead'], peopleTrusted: true });
  expect(resolvePolicyPeople(trusted, { owners: ['lead'], service: 'github' })).toMatchObject({ status: 'resolved', people: [{ github: 'lead-gh' }] });
  expect(resolvePolicyPeople(trusted, { role: 'tech-lead', service: 'discord' }).status).toBe('resolved');
  expect(resolvePolicyPeople(trusted, { owners: ['missing'], service: 'github' }).status).toBe('ask');
  expect(await fs.readFile(path.join(root, '.agents/areas/core.md'), 'utf8')).toBe(area());
  await fs.writeFile(path.join(root, '.agents/areas/core.md'), area(['other/**']));
  await expect(approveRepositoryPolicy({ config, projectId: 'p', projectPath: root, file: unapproved.areas[0].file, fingerprint: unapproved.areas[0].fingerprint })).rejects.toThrow('changed or is unreadable');
  const changed = await readRepositoryPolicy(root, approvals);
  expect(changed.areas[0].status).toBe('changed');
  expect(evaluateRepositoryPolicy(changed, [{ newPath: 'src/core.js' }]).level).toBe('human');
  expect(changed.fingerprint).not.toBe(trusted.fingerprint);
});

it('counts old and new rename paths and enforces fixed human paths independently of the judge', async () => {
  const root = await setup();
  await fs.writeFile(path.join(root, '.agents/areas/core.md'), area(['critical/**'], 'human'));
  const raw = await readRepositoryPolicy(root);
  const policy = await readRepositoryPolicy(root, approvalsOf(raw));
  expect(evaluateRepositoryPolicy(policy, [{ oldPath: 'critical/a.js', newPath: 'safe/a.js' }]).level).toBe('human');
  expect(evaluateRepositoryPolicy(policy, [{ oldPath: 'safe/a.js', newPath: 'critical/a.js' }]).level).toBe('human');
  expect(evaluateRepositoryPolicy(policy, [{ oldPath: 'critical/a.js' }]).level).toBe('human');
  for (const file of ['.agents/areas/a.md', '.openchamber/x', '.github/workflows/a.yml', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    expect(isFixedHumanPath(file)).toBe(true);
    expect(evaluateRepositoryPolicy(policy, [{ newPath: file }]).level).toBe('human');
  }
  expect(evaluateRepositoryPolicy(policy, [{ newPath: 'safe/a.js' }]).level).toBe('none');
  for (const file of ['../escape', '/absolute', 'a/../.github/x', 'a\\b']) expect(() => evaluateRepositoryPolicy(policy, [{ newPath: file }])).toThrow();
});

it('fails human after approved rule deletion, malformed rule, directory read failure or symlink replacement', async () => {
  const root = await setup();
  const raw = await readRepositoryPolicy(root);
  const approvals = approvalsOf(raw);
  const file = path.join(root, '.agents/areas/core.md');
  await fs.rm(file);
  expect(evaluateRepositoryPolicy(await readRepositoryPolicy(root, approvals), [{ newPath: 'safe.js' }]).level).toBe('human');
  await fs.writeFile(file, 'not frontmatter');
  expect((await readRepositoryPolicy(root, approvals)).issues).toHaveLength(1);
  await fs.rm(file);
  await fs.symlink(path.join(root, '.openchamber/people.json'), file);
  expect((await readRepositoryPolicy(root, approvals)).issues[0].error).toContain('symlinks');
  await fs.rm(path.join(root, '.agents'), { recursive: true });
  const outside = await setup();
  await fs.symlink(path.join(outside, '.agents'), path.join(root, '.agents'));
  const linked = await readRepositoryPolicy(root, approvals);
  expect(linked.issues.some((issue) => issue.error.includes('symlinks'))).toBe(true);
  expect(evaluateRepositoryPolicy(linked, [{ newPath: 'safe.js' }]).level).toBe('human');
});

it('never routes identities from changed or malformed people files; a missing new repo is distinct', async () => {
  const root = await setup();
  const approvals = approvalsOf(await readRepositoryPolicy(root));
  const file = path.join(root, '.openchamber/people.json');
  await fs.writeFile(file, JSON.stringify([{ id: 'lead', name: 'Attacker', roles: ['tech-lead'], github: 'attacker' }]));
  const changed = await readRepositoryPolicy(root, approvals);
  expect(changed.people).toMatchObject({ status: 'changed', people: [] });
  expect(changed.people.content).toBe(await fs.readFile(file, 'utf8'));
  expect(resolvePolicyPeople(changed, { owners: ['lead'], service: 'github' }).status).toBe('ask');
  await fs.writeFile(file, '{}');
  expect((await readRepositoryPolicy(root, approvals)).people.status).toBe('invalid');
  await fs.rm(file);
  expect((await readRepositoryPolicy(root, approvals)).people.status).toBe('invalid');
  expect((await readRepositoryPolicy(root)).people.status).toBe('missing');
  await fs.rm(path.join(root, '.agents'), { recursive: true });
  expect(evaluateRepositoryPolicy(await readRepositoryPolicy(root), [{ newPath: 'src/a.js' }]).level).toBe('none');
});
