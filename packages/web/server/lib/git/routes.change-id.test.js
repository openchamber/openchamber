import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGitRoutes } from './routes.js';

let directory;
const git = (...args) => execFileSync('git', args, {
  cwd: directory, encoding: 'utf8',
}).trim();
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('POST /api/git/change-id', () => {
  it('adds a Change-Id to HEAD and answers the new commit, refusing a stale head', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'change-id-route-'));
    git('init', '-q', '-b', 'main');
    // The route runs its own git, so the identity lives in the repo: CI
    // runners have no global one.
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.com');
    git('commit', '--allow-empty', '-q', '-m', 'Base');
    const head = git('rev-parse', 'HEAD');
    const app = express();
    app.use(express.json());
    const onBranchRewritten = vi.fn();
    registerGitRoutes(app, { onBranchRewritten });

    await request(app).post('/api/git/change-id').send({ expectedHead: head }).expect(400);
    const stale = await request(app).post('/api/git/change-id').query({ directory }).send({ expectedHead: 'f'.repeat(40) }).expect(409);
    expect(stale.body.code).toBe('STALE_HEAD');
    const response = await request(app).post('/api/git/change-id').query({ directory }).send({ expectedHead: head }).expect(200);
    expect(response.body).toEqual({ sha: git('rev-parse', 'HEAD'), changeId: expect.stringMatching(/^I[0-9a-f]{40}$/) });
    // The branch's cached host status was read for the old tip; only the rewrite reports it.
    expect(onBranchRewritten).toHaveBeenCalledTimes(1);
    expect(onBranchRewritten).toHaveBeenCalledWith({ directory, branch: 'main' });
  });
});
