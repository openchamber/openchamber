import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANTIGRAVITY_ACCOUNTS_PATHS } from '../../utils/index.js';
import { resolveAntigravityAuth } from './auth.js';

const originalPaths = [...ANTIGRAVITY_ACCOUNTS_PATHS];
let directory;
let firstPath;
let secondPath;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'antigravity-auth-'));
  firstPath = join(directory, 'first.json');
  secondPath = join(directory, 'second.json');
  ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, firstPath, secondPath);
});

afterEach(() => {
  ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, ...originalPaths);
  rmSync(directory, { recursive: true, force: true });
});

describe('Antigravity accounts file boundary', () => {
  it('skips absent, primitive and empty accounts files', () => {
    for (const value of [null, false, 3, 'text', [], {}, { accounts: [] }, { accounts: 'constructor' }]) {
      writeFileSync(firstPath, JSON.stringify(value));
      expect(resolveAntigravityAuth()).toBeNull();
    }
  });

  it('keeps active-account fallback and packed project context', () => {
    writeFileSync(firstPath, JSON.stringify({
      activeIndex: '99',
      accounts: [{ refreshToken: 'token|packed-project|managed-project', email: 42 }],
    }));
    expect(resolveAntigravityAuth()).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: 'token',
      projectId: 'packed-project',
      email: 42,
    });
  });

  it('keeps a truthy non-string refresh token configured with a null parsed token', () => {
    writeFileSync(firstPath, JSON.stringify({ accounts: [{ refreshToken: 42 }] }));
    expect(resolveAntigravityAuth()).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: null,
      projectId: null,
      email: undefined,
    });
  });

  it('continues to the next file when the selected account has no token', () => {
    writeFileSync(firstPath, JSON.stringify({ accounts: [null, { refreshToken: 'unused' }] }));
    writeFileSync(secondPath, JSON.stringify({ accounts: [{ refreshToken: 'selected', managedProjectId: 'managed' }] }));
    expect(resolveAntigravityAuth()?.projectId).toBe('managed');
  });
});
