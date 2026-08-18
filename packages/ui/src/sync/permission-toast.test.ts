import { describe, expect, test } from 'bun:test';
import type { PermissionRequest } from '@/types/permission';
import { showPermissionNeededToast } from './permission-toast';

const permission = {
  id: 'permission-1',
  sessionID: 'inactive-session',
  permission: 'bash',
} as PermissionRequest;

describe('permission needed toast', () => {
  test('shows for an inactive session and opens that session', () => {
    const shown: Array<{ title: string; options: Parameters<Parameters<typeof showPermissionNeededToast>[0]['show']>[1] }> = [];
    const opened: Array<[string, string]> = [];
    const show: Parameters<typeof showPermissionNeededToast>[0]['show'] = (title, options) => { shown.push({ title, options }); };
    const openSession = (sessionId: string, directory: string) => { opened.push([sessionId, directory]); };
    const pendingIds = new Set<string>();

    expect(showPermissionNeededToast({
      permission,
      directory: '/project',
      isViewed: false,
      pendingIds,
      show,
      openSession,
    })).toBe(true);

    expect(shown.length).toBe(1);
    const { options } = shown[0];
    expect(options.id).toBe('permission-inactive-session:permission-1');
    expect(options.description).toBe('bash');
    options.action.onClick();
    expect(opened).toEqual([['inactive-session', '/project']]);
  });

  test('does not show for the viewed session or duplicate a pending toast', () => {
    const shown: string[] = [];
    const show: Parameters<typeof showPermissionNeededToast>[0]['show'] = (title) => { shown.push(title); };
    const openSession: Parameters<typeof showPermissionNeededToast>[0]['openSession'] = () => {};
    const pendingIds = new Set<string>();
    const base = { permission, directory: '/project', pendingIds, show, openSession };

    expect(showPermissionNeededToast({ ...base, isViewed: true })).toBe(false);
    expect(showPermissionNeededToast({ ...base, isViewed: false })).toBe(true);
    expect(showPermissionNeededToast({ ...base, isViewed: false })).toBe(false);
    expect(shown.length).toBe(1);
  });
});
