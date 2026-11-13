import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAgentDisplayMetadata, registerDisplayMetadataRoute } from './display-metadata.js';

const folders = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

// The agent's git: it records the folder and arguments of each run, then prints the chosen branch
// or fails when none is chosen.
const fakeGit = (root) => {
  const binary = path.join(root, 'git');
  fs.writeFileSync(binary, '#!/bin/sh\nprintf \'%s|%s\\n\' "$(pwd -P)" "$*" >> "$0.log"\n[ -f "$0.branch" ] || exit 1\ncat "$0.branch"\n', { mode: 0o755 });
  return {
    binary,
    setBranch: (branch) => fs.writeFileSync(`${binary}.branch`, `${branch}\n`),
    clearBranch: () => fs.rmSync(`${binary}.branch`, { force: true }),
    runs: () => (fs.existsSync(`${binary}.log`) ? fs.readFileSync(`${binary}.log`, 'utf8').trim().split('\n') : []),
  };
};

const setup = ({ label = 'Project', primaryRoot = null, chatRoots = [] } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'display-metadata-'));
  folders.push(root);
  const project = path.join(root, 'project');
  const linked = path.join(root, 'linked');
  fs.mkdirSync(project);
  fs.mkdirSync(linked);
  const git = fakeGit(root);
  git.setBranch('feature');
  const readSettings = vi.fn(async () => ({ projects: [{ path: project, label }] }));
  const resolvePrimaryWorktreeRoot = vi.fn(async () => ({ root: primaryRoot ?? project }));
  const app = express();
  registerDisplayMetadataRoute(app, { readSettings, resolveGitBinaryForSpawn: () => git.binary, resolvePrimaryWorktreeRoot, chatRoots });
  return { app, readSettings, resolvePrimaryWorktreeRoot, git, project, linked };
};

describe('agent display metadata route', () => {
  it('uses the owning server account to resolve a worktree project and branch', async () => {
    const { app, resolvePrimaryWorktreeRoot, git, linked } = setup();
    const response = await request(app).get('/api/openchamber/display-metadata').query({ directory: linked });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ projectName: 'Project', branch: 'feature' });
    expect(resolvePrimaryWorktreeRoot).toHaveBeenCalledWith(linked);
    expect(git.runs()).toEqual([`${fs.realpathSync(linked)}|rev-parse --abbrev-ref HEAD`]);
  });

  it('keeps direct project labels, Chats and unknown folders compatible', async () => {
    const { app, resolvePrimaryWorktreeRoot, project } = setup({ primaryRoot: '/unregistered', chatRoots: ['/data/chats'] });
    for (const [directory, projectName] of [[project, 'Project'], ['/data/chats/generated', 'Chats'], ['/tmp/scratch', 'scratch']]) {
      const response = await request(app).get('/api/openchamber/display-metadata').query({ directory });
      expect(response.body.projectName).toBe(projectName);
    }
    expect(resolvePrimaryWorktreeRoot).toHaveBeenCalledExactlyOnceWith('/tmp/scratch');
  });

  it.each([
    '', '?directory=relative', '?directory=%00%2Fwork', `?directory=${encodeURIComponent(`/${'a'.repeat(4096)}`)}`,
    '?directory=%2Fone&directory=%2Ftwo', '?directory=%2Fone&directory%5B%5D=%2Ftwo',
  ])('refuses malformed and duplicate directory query %s before reading projects', async (query) => {
    const { app, readSettings, resolvePrimaryWorktreeRoot, git } = setup();
    const response = await request(app).get(`/api/openchamber/display-metadata${query}`);
    expect(response.status).toBe(400);
    expect(readSettings).not.toHaveBeenCalled();
    expect(resolvePrimaryWorktreeRoot).not.toHaveBeenCalled();
    expect(git.runs()).toEqual([]);
  });

  it('bounds labels and branch names and keeps unavailable git display-only', async () => {
    const { app, git, project } = setup({ label: 'p'.repeat(300) });
    git.setBranch('b'.repeat(300));
    const bounded = await request(app).get('/api/openchamber/display-metadata').query({ directory: project });
    expect(bounded.body).toEqual({ projectName: 'p'.repeat(256), branch: 'b'.repeat(256) });
    git.clearBranch();
    const failed = await request(app).get('/api/openchamber/display-metadata').query({ directory: project });
    expect(failed.body.branch).toBe('');
  });
});

describe('delegated display metadata', () => {
  // A recording git first on PATH: a local git run, with or without an explicit binary, shows in `runs()`.
  const localGit = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'display-metadata-path-'));
    folders.push(root);
    const git = fakeGit(root);
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
    return git;
  };
  afterEach(() => vi.unstubAllEnvs());

  it('uses authenticated bounded upstream JSON and returns only the checked fields', async () => {
    const git = localGit();
    const upstream = { json: vi.fn(async () => ({ projectName: 'Project', branch: 'main', spaceId: 'claim', private: 'dropped' })) };
    await expect(readAgentDisplayMetadata(upstream, '/work/with & spaces')).resolves.toEqual({ projectName: 'Project', branch: 'main' });
    const [route, options] = upstream.json.mock.calls[0];
    expect(new URL(route, 'http://agent').searchParams.get('directory')).toBe('/work/with & spaces');
    expect(options).toEqual({ timeoutMs: 5000 });
    expect(git.runs()).toEqual([]);
  });

  it('rejects bad replies and transport failures without local discovery', async () => {
    const git = localGit();
    const upstream = { json: vi.fn(async () => ({ projectName: 'p'.repeat(257), branch: 'main' })) };
    await expect(readAgentDisplayMetadata(upstream, '/work/project')).rejects.toThrow();
    upstream.json.mockRejectedValue(new Error('agent_unreachable'));
    await expect(readAgentDisplayMetadata(upstream, '/work/project')).rejects.toThrow('agent_unreachable');
    await expect(readAgentDisplayMetadata(upstream, 'relative')).rejects.toThrow();
    expect(git.runs()).toEqual([]);
  });
});
