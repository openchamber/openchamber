import { describe, expect, test } from 'bun:test';

import { fillOpenUrlTemplate, hasOpenUrlTemplate, toHostnameLabel } from './projectActionOpenUrl';

const worktree = (branch: string | null) => ({ branch, linkedWorktree: true });
const mainCheckout = (branch: string | null) => ({ branch, linkedWorktree: false });

describe('action URL templates', () => {
  test('recognises only the known variables', () => {
    expect(hasOpenUrlTemplate('https://{worktree}.myapp.localhost')).toBe(true);
    expect(hasOpenUrlTemplate('http://localhost:3000/{branch}')).toBe(true);
    expect(hasOpenUrlTemplate('http://localhost:3000/{other}')).toBe(false);
    expect(hasOpenUrlTemplate(undefined)).toBe(false);
  });

  // The cases portless' own tests pin down (auto.test.ts, detectWorktreePrefix).
  test('names a linked worktree the way portless does', async () => {
    const template = 'https://{worktree}.myapp.localhost';
    expect(await fillOpenUrlTemplate(template, worktree('feature-auth'))).toBe('https://feature-auth.myapp.localhost');
    expect(await fillOpenUrlTemplate(template, worktree('feature/My_Branch'))).toBe('https://my-branch.myapp.localhost');
    expect(await fillOpenUrlTemplate(template, worktree('feature/main'))).toBe('https://main.myapp.localhost');
    expect(await fillOpenUrlTemplate(template, worktree('main'))).toBe('https://myapp.localhost');
    expect(await fillOpenUrlTemplate(template, worktree('master'))).toBe('https://myapp.localhost');
    expect(await fillOpenUrlTemplate(template, worktree('@@@'))).toBe('https://myapp.localhost');
    expect(await fillOpenUrlTemplate(template, worktree(null))).toBe('https://myapp.localhost');
  });

  test('leaves the main checkout unprefixed on any branch', async () => {
    expect(await fillOpenUrlTemplate('https://{worktree}.myapp.localhost', mainCheckout('feature/auth')))
      .toBe('https://myapp.localhost');
  });

  test('drops the separators an empty variable leaves behind', async () => {
    expect(await fillOpenUrlTemplate('http://app-{worktree}.localhost:3000/', mainCheckout('dev'))).toBe('http://app.localhost:3000/');
    expect(await fillOpenUrlTemplate('{worktree}.myapp.localhost', mainCheckout('dev'))).toBe('myapp.localhost');
  });

  test('puts the whole branch name wherever {branch} stands', async () => {
    expect(await fillOpenUrlTemplate('http://localhost:3000/{branch}', mainCheckout('feature/auth')))
      .toBe('http://localhost:3000/feature-auth');
    expect(await fillOpenUrlTemplate('https://{branch}.preview.localhost', worktree('bohdan/dev')))
      .toBe('https://bohdan-dev.preview.localhost');
  });

  test('keeps a long label unique within the DNS label limit', async () => {
    const long = 'a'.repeat(80);
    const label = await toHostnameLabel(long);
    expect(label.length).toBeLessThanOrEqual(63);
    expect(/^a+-[0-9a-f]{6}$/.test(label)).toBe(true);
    expect(await toHostnameLabel(long)).toBe(label);
  });
});
