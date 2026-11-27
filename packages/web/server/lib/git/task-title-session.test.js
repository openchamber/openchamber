import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getWorktrees, setWorktreeTaskTitle } from './service.js';
import { followRenamedSession, followSessionTaskTitle, setLinkedTaskTitle } from './task-title-session.js';

const tempDirs = [];
const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-task-title-'));
  tempDirs.push(dir);
  return dir;
};
const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
beforeAll(() => {
  const config = path.join(createTempDir(), 'git-config');
  fs.writeFileSync(config, '');
  process.env.GIT_CONFIG_GLOBAL = config;
});
afterAll(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const createLinkedWorktree = () => {
  const repo = createTempDir();
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init']);
  const linked = path.join(createTempDir(), 'linked');
  runGit(repo, ['worktree', 'add', '-b', 'feature/task', linked]);
  const title = async () => (await getWorktrees(repo)).find((worktree) => fs.realpathSync(worktree.path) === fs.realpathSync(linked))?.title;
  return { repo, linked, title };
};

describe('a task title copied from a session', () => {
  it('follows that session renamed, and no other session or checkout', async () => {
    const { repo, linked, title } = createLinkedWorktree();
    await setLinkedTaskTitle(linked, { title: 'Login fix', by: 'agent', session: 'ses_a' });

    expect(await followSessionTaskTitle(linked, 'ses_other', 'Side question')).toBeNull();
    expect(await followSessionTaskTitle(repo, 'ses_a', 'Main checkout')).toBeNull();
    await followSessionTaskTitle(linked, 'ses_a', 'Session expiry on idle');
    await followSessionTaskTitle(linked, 'ses_a', 'Session expiry on idle, take two');
    expect(await title()).toBe('Session expiry on idle, take two');
  });

  it('stops following once the agent or the user names the task', async () => {
    const { linked, title } = createLinkedWorktree();
    await setLinkedTaskTitle(linked, { title: 'Login fix', by: 'agent', session: 'ses_a' });
    await setWorktreeTaskTitle(linked, { title: 'Idle timeout', by: 'agent' });
    expect(await followSessionTaskTitle(linked, 'ses_a', 'Renamed')).toBeNull();
    expect(await title()).toBe('Idle timeout');

    await setLinkedTaskTitle(linked, { title: 'Copied again', by: 'agent', session: 'ses_a' });
    await setLinkedTaskTitle(linked, { title: 'Copied again', by: 'user' });
    await followSessionTaskTitle(linked, 'ses_a', 'Renamed');
    expect(await title()).toBe('Copied again');

    await setLinkedTaskTitle(linked, { title: '', by: 'user' });
    expect(await followSessionTaskTitle(linked, 'ses_a', 'Renamed')).toBeNull();
    expect(await title()).toBeUndefined();
  });

  it('takes renames one at a time, with the title the session has now', async () => {
    const { linked, title } = createLinkedWorktree();
    await setLinkedTaskTitle(linked, { title: 'Login fix', by: 'agent', session: 'ses_a' });
    const readSession = vi.fn(async () => ({ title: 'Third name', location: { directory: linked } }));
    const renamed = (name) => ({ type: 'session.updated', properties: { sessionID: 'ses_a', info: { id: 'ses_a', title: name } } });

    followRenamedSession({ type: 'session.updated', properties: { sessionID: 'ses_a', info: { id: 'ses_a', cost: 1 } } }, readSession);
    followRenamedSession(renamed('Second name'), readSession);
    followRenamedSession(renamed('Third name'), readSession);

    await vi.waitFor(() => expect(readSession).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await title()).toBe('Third name'), { timeout: 10_000 });
  });
});
