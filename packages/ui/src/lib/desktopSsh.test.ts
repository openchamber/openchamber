import { afterEach, describe, expect, test } from 'bun:test';

import { isDesktopSshRuntimeActive, openDesktopProjectInAppOverSsh } from './desktopSsh';
import { openAndRememberApp } from './openInApps';

type OpenArgs = { projectPath?: string; appId?: string; runtimeKey?: string };
type OpenCall = { command: string; args: OpenArgs };

const SSH_A = 'http://127.0.0.1:4001';
const SSH_B = 'http://127.0.0.1:4002';

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

type ShellReply = { opened: boolean; reason?: string; settings?: string[] } | null;

describe('opening a project in an editor over SSH', () => {
  const originalWindow = globalThis.window;
  afterEach(() => {
    globalThis.window = originalWindow;
  });

  const runtime = { apiBaseUrl: SSH_A, sshForwardApiUrl: SSH_A };

  const switchWindowTo = (apiBaseUrl: string) => {
    runtime.apiBaseUrl = apiBaseUrl;
    runtime.sshForwardApiUrl = apiBaseUrl;
  };

  const desktopWindow = (options: { sshForwardApiUrl: string; reply?: (args: OpenArgs) => Promise<ShellReply> }) => {
    const calls: OpenCall[] = [];
    runtime.apiBaseUrl = SSH_A;
    runtime.sshForwardApiUrl = options.sshForwardApiUrl;
    globalThis.window = Object.assign(Object.create(null), {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_DESKTOP__: {
        invoke: async (command: string, args: OpenArgs) => {
          calls.push({ command, args });
          return options.reply ? options.reply(args) : { opened: true };
        },
      },
    });
    Object.defineProperties(globalThis.window, {
      __OPENCHAMBER_API_BASE_URL__: { get: () => runtime.apiBaseUrl },
      __OPENCHAMBER_SSH_FORWARD_API_URL__: { get: () => runtime.sshForwardApiUrl },
    });
    return calls;
  };

  test('applies only to a window on an SSH-forwarded instance', () => {
    desktopWindow({ sshForwardApiUrl: SSH_A });
    expect(isDesktopSshRuntimeActive()).toBe(true);
    desktopWindow({ sshForwardApiUrl: '' });
    expect(isDesktopSshRuntimeActive()).toBe(false);
  });

  test('asks the shell to open the remote path in the chosen editor on the window\'s instance', async () => {
    const calls = desktopWindow({ sshForwardApiUrl: SSH_A });
    expect(await openDesktopProjectInAppOverSsh(' /home/me/my project ', 'zed')).toEqual({ opened: true });
    expect(calls).toEqual([{ command: 'desktop_open_in_app_over_ssh', args: { projectPath: '/home/me/my project', appId: 'zed', runtimeKey: `url:${SSH_A}` } }]);
  });

  test('never opens the first instance\'s path on the second when the window switches during a delayed save', async () => {
    const shellReply = deferred();
    const save = deferred();
    const launched: Array<{ projectPath?: string; instance: string }> = [];
    const calls = desktopWindow({
      sshForwardApiUrl: SSH_A,
      reply: async (args) => {
        await shellReply.promise;
        const windowRuntimeKey = `url:${runtime.apiBaseUrl}`;
        if (args.runtimeKey !== windowRuntimeKey) return { opened: false, reason: 'instance-changed' };
        launched.push({ projectPath: args.projectPath, instance: windowRuntimeKey });
        return { opened: true };
      },
    });

    const opening = openAndRememberApp(() => openDesktopProjectInAppOverSsh('/home/a/project', 'zed'), () => save.promise);
    switchWindowTo(SSH_B);
    shellReply.resolve();
    save.resolve();

    expect(await opening).toEqual({ opened: false, reason: 'instance-changed', settings: [] });
    expect(calls.map((call) => call.args)).toEqual([{ projectPath: '/home/a/project', appId: 'zed', runtimeKey: `url:${SSH_A}` }]);
    expect(launched).toEqual([]);
  });

  test('opens without waiting for the choice to save', async () => {
    const save = deferred();
    const calls = desktopWindow({ sshForwardApiUrl: SSH_A });
    const opening = openAndRememberApp(() => openDesktopProjectInAppOverSsh('/home/a/project', 'zed'), () => save.promise);
    expect(calls).toHaveLength(1);
    save.resolve();
    expect(await opening).toEqual({ opened: true });
  });

  test('passes on why the shell refused or could not launch the editor', async () => {
    desktopWindow({ sshForwardApiUrl: SSH_A, reply: async () => ({ opened: false, reason: 'settings-mismatch', settings: ['ProxyJump'] }) });
    expect(await openDesktopProjectInAppOverSsh('/srv/app', 'vscode')).toEqual({ opened: false, reason: 'settings-mismatch', settings: ['ProxyJump'] });
    desktopWindow({ sshForwardApiUrl: SSH_A, reply: async () => ({ opened: false, reason: 'launch-failed' }) });
    expect(await openDesktopProjectInAppOverSsh('/srv/app', 'vscode-insiders')).toEqual({ opened: false, reason: 'launch-failed', settings: [] });
  });

  test('never reports a failed request as a missing editor', async () => {
    desktopWindow({ sshForwardApiUrl: SSH_A, reply: async () => { throw new Error('IPC channel closed'); } });
    expect(await openDesktopProjectInAppOverSsh('/srv/app', 'vscode')).toEqual({ opened: false, reason: 'unresolved', settings: [] });
    desktopWindow({ sshForwardApiUrl: SSH_A, reply: async () => null });
    expect(await openDesktopProjectInAppOverSsh('/srv/app', 'vscode')).toEqual({ opened: false, reason: 'unresolved', settings: [] });
  });
});
