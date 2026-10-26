import { describe, expect, test } from 'bun:test';
import { guestMessageSchema, hostMessageSchema } from './protocol.ts';
import { parseManifestJson } from './parse.ts';
import { resolvePageEntry } from './manifest.ts';
import { GUEST_STORAGE_VALUE_BYTES } from './workspace.ts';

const envelope = { channel: 'openchamber.sdk', v: 1, id: 'test' };
describe('extension workspace contracts', () => {
  test('page shorthand and custom HTML require a panel entry', () => {
    const panel = { id: 'board', name: 'Board', icon: 'window', entry: 'panel/index.html' };
    const parse = (page: true | { entry: string; title?: string }, withEntry = true) => parseManifestJson(JSON.stringify({ apiVersion: 1,
      contributes: { panel: withEntry ? panel : { id: panel.id, name: panel.name, icon: panel.icon }, page } }));
    expect(parse(true).ok).toBe(true);
    expect(resolvePageEntry({ panel, page: true })).toBe(panel.entry);
    expect(parse({ entry: 'panel/page.html', title: 'Board' }).ok).toBe(true);
    expect(parse({ entry: '../page.html' }).ok).toBe(false);
    expect(parse({ entry: 'https://example.com' }).ok).toBe(false);
    expect(parse(true, false).ok).toBe(false);
  });
  test('worktree targets are exclusive and scoped', () => {
    const payload = { providerId: 'board', id: '1', title: 'Task', url: 'https://example.com/1', projectId: 'project-b' };
    for (const worktree of [true, false, { kind: 'existing', directory: '/worktree' }, { kind: 'new', name: 'fix-login', baseBranch: 'main' }]) {
      const message = { ...envelope, type: 'start-session', payload: { ...payload, worktree, navigation: 'preserve' } };
      expect(guestMessageSchema.parse(message)).toEqual(message);
    }
    expect(guestMessageSchema.safeParse({ ...envelope, type: 'start-session', payload: { ...payload, worktree: { kind: 'existing', directory: '/worktree', name: 'other' } } }).success).toBe(false);
  });
  test('storage counts UTF-8 bytes and distinguishes missing from JSON null', () => {
    expect(guestMessageSchema.safeParse({ ...envelope, type: 'storage', payload: { op: 'set', key: 'board', value: '界'.repeat(GUEST_STORAGE_VALUE_BYTES / 3) } }).success).toBe(false);
    for (const payload of [{ storage: true, op: 'get', found: false }, { storage: true, op: 'get', found: true, value: null }]) {
      expect(hostMessageSchema.parse({ ...envelope, type: 'result', ok: true, payload })).toMatchObject({ payload });
    }
  });
  test('partial worktree success survives the result envelope', () => {
    const payload = { sessionId: null, sent: 'skipped', directory: '/wt', worktree: { directory: '/wt', name: 'fix', branch: 'fix', status: 'invalid' }, failure: 'bootstrap-failed' };
    expect(hostMessageSchema.parse({ ...envelope, type: 'result', ok: true, payload })).toMatchObject({ payload });
  });
});
