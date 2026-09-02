import { describe, expect, test } from 'bun:test';
import type { ProjectEntry } from '@/lib/api/types';
import {
  displaySessionNotificationBody,
  resolveNotificationProjectLabel,
  usableSessionNotificationTitle,
} from './notification-session-context';

const project = (overrides: Partial<ProjectEntry> & Pick<ProjectEntry, 'id' | 'path'>): ProjectEntry => overrides;

describe('resolveNotificationProjectLabel', () => {
  test('prefers an exact project path label', () => {
    expect(resolveNotificationProjectLabel('/Users/me/openchamber', [
      project({ id: 'p1', path: '/Users/me/openchamber', label: 'OpenChamber' }),
    ])).toBe('OpenChamber');
  });

  test('uses the longest matching project prefix for a worktree path', () => {
    expect(resolveNotificationProjectLabel('/Users/me/openchamber/packages/ui', [
      project({ id: 'root', path: '/Users/me', label: 'Home' }),
      project({ id: 'app', path: '/Users/me/openchamber', label: 'OpenChamber' }),
    ])).toBe('OpenChamber');
  });

  test('falls back to the directory name when no project matches', () => {
    expect(resolveNotificationProjectLabel('/tmp/scratch', [])).toBe('scratch');
    expect(resolveNotificationProjectLabel(undefined, [])).toBe('');
    expect(resolveNotificationProjectLabel(
      '/tmp/session-54b733e2-6a69-45d1-98a9-4666816d3f9e',
      [],
    )).toBe('');
  });
});

describe('usableSessionNotificationTitle', () => {
  test('rejects empty titles and raw session ids', () => {
    expect(usableSessionNotificationTitle(undefined, 'ses_1')).toBe(undefined);
    expect(usableSessionNotificationTitle('ses_1', 'ses_1')).toBe(undefined);
    expect(usableSessionNotificationTitle('ses_abc123', 'other')).toBe(undefined);
    expect(usableSessionNotificationTitle('session-54b733e2-6a69-45d1-98a9-4666816d3f9e', 'other')).toBe(undefined);
    expect(usableSessionNotificationTitle('Fix login', 'ses_1')).toBe('Fix login');
  });
});

describe('displaySessionNotificationBody', () => {
  test('replaces a stored session id with the live title', () => {
    expect(displaySessionNotificationBody(
      'ses_1 · openchamber',
      'ses_1',
      'Fix login',
      'Untitled session',
    )).toBe('Fix login · openchamber');
  });

  test('keeps a later error line when rewriting the name', () => {
    expect(displaySessionNotificationBody(
      'ses_1 · openchamber\nboom',
      'ses_1',
      'Fix login',
      'Untitled session',
    )).toBe('Fix login · openchamber\nboom');
  });

  test('falls back to untitled when only an id is stored', () => {
    expect(displaySessionNotificationBody(
      'ses_1',
      'ses_1',
      undefined,
      'Untitled session',
    )).toBe('Untitled session');
  });

  test('keeps a real stored title when no live title exists', () => {
    expect(displaySessionNotificationBody(
      'Fix login · openchamber',
      'ses_1',
      undefined,
      'Untitled session',
    )).toBe('Fix login · openchamber');
  });

  test('drops a session-id project suffix', () => {
    expect(displaySessionNotificationBody(
      'Можливості асистента · session-54b733e2-6a69-45d1-98a9-4666816d3f9e',
      'session-54b733e2-6a69-45d1-98a9-4666816d3f9e',
      undefined,
      'Untitled session',
    )).toBe('Можливості асистента');
  });
});
