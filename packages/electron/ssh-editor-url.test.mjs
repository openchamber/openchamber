import { describe, expect, test } from 'bun:test';
import { openProjectInSshEditor, openWindowProjectInSshEditor, parseSshConfigDump, planSshEditorLaunch } from './ssh-editor-url.mjs';

const DEFAULT_IDENTITIES = ['~/.ssh/id_rsa', '~/.ssh/id_ed25519'];

// A small stand-in for `ssh -G`: command-line options win over the
// destination's user, which wins over the matching `Host` entry of the
// selected config file (`-F`, or the default one).
const fakeSsh = (configs) => {
  const calls = [];
  const resolveSsh = async (destination, args) => {
    calls.push([destination, ...args]);
    const cli = { identityfile: [] };
    let file = 'default';
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index].slice(0, 2);
      const value = args[index].length > 2 ? args[index].slice(2) : args[++index];
      if (flag === '-F') file = value;
      if (flag === '-l') cli.user ??= value;
      if (flag === '-p') cli.port ??= value;
      if (flag === '-i') cli.identityfile.push(value);
      if (flag === '-J') cli.proxyjump ??= value;
      if (flag === '-o') {
        const [key, optionValue] = value.split('=');
        cli[key.toLowerCase()] ??= optionValue;
      }
    }
    const at = destination.lastIndexOf('@');
    const host = destination.slice(at + 1);
    const entry = configs[file]?.[host] ?? {};
    const settings = [
      ['hostname', (cli.hostname ?? entry.hostname ?? host).replace('%h', host).toLowerCase()],
      ['user', cli.user ?? (at > 0 ? destination.slice(0, at) : undefined) ?? entry.user ?? 'me'],
      ['port', cli.port ?? entry.port ?? '22'],
      ...[...cli.identityfile, ...(entry.identityfile ?? []), ...DEFAULT_IDENTITIES].map((value) => ['identityfile', value]),
      ...((cli.proxyjump ?? entry.proxyjump) ? [['proxyjump', cli.proxyjump ?? entry.proxyjump]] : []),
      ['pubkeyauthentication', cli.pubkeyauthentication ?? 'true'],
    ];
    return `${settings.map(([key, value]) => `${key} ${value}`).join('\n')}\n`;
  };
  return { calls, resolveSsh };
};

const remoteAuthority = (url) => {
  const hex = /ssh-remote\+([0-9a-f]+)\//.exec(url)?.[1] ?? '';
  return JSON.parse(Buffer.from(hex, 'hex').toString());
};

describe('parseSshConfigDump', () => {
  test('keeps every value of a repeated key', () => {
    const settings = parseSshConfigDump('hostname box\nidentityfile ~/a\r\nidentityfile ~/b\n\nproxycommand ssh -W %h:%p jump\n');
    expect(settings.get('hostname')).toEqual(['box']);
    expect(settings.get('identityfile')).toEqual(['~/a', '~/b']);
    expect(settings.get('proxycommand')).toEqual(['ssh -W %h:%p jump']);
  });
});

describe('planSshEditorLaunch', () => {
  test('opens the folder in a new VS Code window as the user and port the instance connects with', async () => {
    const { resolveSsh } = fakeSsh({});
    const { url } = await planSshEditorLaunch('vscode-insiders', { destination: 'root@Build-Box', args: ['-p', '2222', '-l', 'Alice'] }, '/home/me/my project', resolveSsh);
    expect(url?.startsWith('vscode-insiders://vscode-remote/ssh-remote+')).toBe(true);
    expect(url?.endsWith('/home/me/my%20project?windowId=_blank')).toBe(true);
    expect(remoteAuthority(url)).toEqual({ hostName: 'Build-Box', user: 'Alice', port: 2222 });
  });

  test('builds the zed ssh link', async () => {
    const { resolveSsh } = fakeSsh({});
    expect((await planSshEditorLaunch('zed', { destination: 'me@159.195.233.79', args: ['-p5222'] }, '/home/me/a#b', resolveSsh)).url)
      .toBe('zed://ssh/me@159.195.233.79:5222/home/me/a%23b');
  });

  test('takes HostName with its tokens expanded the way ssh resolves it', async () => {
    const { resolveSsh } = fakeSsh({});
    const { url } = await planSshEditorLaunch('vscode', { destination: 'box', args: ['-o', 'HostName=%h.example.invalid'] }, '/w', resolveSsh);
    expect(remoteAuthority(url)).toEqual({ hostName: 'box.example.invalid', user: 'me', port: 22 });
  });

  test('gives VS Code a config alias without a port, so the config entry supplies it', async () => {
    const { resolveSsh } = fakeSsh({ default: { netcup: { hostname: '10.0.0.5', port: '2200', identityfile: ['~/.ssh/netcup'] } } });
    const vscode = await planSshEditorLaunch('vscode', { destination: 'netcup', args: [] }, '/w', resolveSsh);
    expect(remoteAuthority(vscode.url)).toEqual({ hostName: 'netcup', user: 'me' });
    const zed = await planSshEditorLaunch('zed', { destination: 'netcup', args: [] }, '/w', resolveSsh);
    expect(zed.url).toBe('zed://ssh/me@netcup:2200/w');
  });

  test('refuses VS Code when the saved command overrides the port of a config alias', async () => {
    const { resolveSsh } = fakeSsh({ default: { netcup: { hostname: '10.0.0.5', port: '2200', identityfile: ['~/.ssh/netcup'] } } });
    expect(await planSshEditorLaunch('vscode', { destination: 'netcup', args: ['-p', '2222'] }, '/w', resolveSsh))
      .toEqual({ url: null, settings: ['Port'] });
    expect((await planSshEditorLaunch('zed', { destination: 'netcup', args: ['-p', '2222'] }, '/w', resolveSsh)).url)
      .toBe('zed://ssh/me@netcup:2222/w');
  });

  test('refuses settings the editor cannot read: an alternate config, a key or a jump host on the command line', async () => {
    const { resolveSsh } = fakeSsh({ '/etc/alt': { a: { hostname: 'real.example', port: '2200', identityfile: ['~/k'] } } });
    expect(await planSshEditorLaunch('zed', { destination: 'a', args: ['-F', '/etc/alt'] }, '/w', resolveSsh))
      .toEqual({ url: null, settings: ['IdentityFile'] });
    expect(await planSshEditorLaunch('vscode', { destination: 'box', args: ['-i', '/keys/id'] }, '/w', resolveSsh))
      .toEqual({ url: null, settings: ['IdentityFile'] });
    expect(await planSshEditorLaunch('vscode', { destination: 'box', args: ['-J', 'bastion'] }, '/w', resolveSsh))
      .toEqual({ url: null, settings: ['ProxyJump'] });
    expect(await planSshEditorLaunch('zed', { destination: 'box', args: ['-o', 'PubkeyAuthentication=no'] }, '/w', resolveSsh))
      .toEqual({ url: null, settings: ['PubkeyAuthentication'] });
  });

  test('accepts a key and jump host the editor reads from the same config entry', async () => {
    const { resolveSsh } = fakeSsh({ default: { box: { identityfile: ['~/.ssh/box'], proxyjump: 'bastion' } } });
    const { url } = await planSshEditorLaunch('vscode', { destination: 'box', args: [] }, '/w', resolveSsh);
    expect(remoteAuthority(url)).toEqual({ hostName: 'box', user: 'me', port: 22 });
  });

  test('never passes a resolved host name that ssh would read as an option', async () => {
    const { calls, resolveSsh } = fakeSsh({ default: { box: { hostname: '-oProxyCommand=x', identityfile: ['~/k'] } } });
    expect((await planSshEditorLaunch('zed', { destination: 'box', args: [] }, '/w', resolveSsh)).url).toBe('zed://ssh/me@box:22/w');
    expect(calls.every(([destination]) => !destination.startsWith('-'))).toBe(true);
  });
});

describe('openProjectInSshEditor', () => {
  const connection = { destination: 'me@netcup', args: [] };
  const opener = () => {
    const opened = [];
    return { opened, openExternal: async (url) => { opened.push(url); } };
  };

  test('opens the link for the connection', async () => {
    const { opened, openExternal } = opener();
    const result = await openProjectInSshEditor({ appId: ' Zed ', projectPath: ' /srv/app ' }, connection, { resolveSsh: fakeSsh({}).resolveSsh, openExternal });
    expect(result).toEqual({ opened: true });
    expect(opened).toEqual(['zed://ssh/me@netcup:22/srv/app']);
  });

  test('tells a refused target apart from a launch the OS could not complete', async () => {
    const { resolveSsh } = fakeSsh({});
    const { opened, openExternal } = opener();
    const deps = { resolveSsh, openExternal };
    expect(await openProjectInSshEditor({ appId: 'zed', projectPath: '/srv' }, null, deps)).toEqual({ opened: false, reason: 'instance-changed' });
    expect(await openProjectInSshEditor({ appId: 'xcode', projectPath: '/srv' }, connection, deps)).toEqual({ opened: false, reason: 'unsupported' });
    expect(await openProjectInSshEditor({ appId: 'cursor', projectPath: '/srv' }, connection, deps)).toEqual({ opened: false, reason: 'unsupported' });
    expect(await openProjectInSshEditor({ appId: 'vscode', projectPath: 'C:\\work' }, connection, deps)).toEqual({ opened: false, reason: 'unsupported' });
    const jumped = { destination: 'me@netcup', args: ['-J', 'bastion'] };
    expect(await openProjectInSshEditor({ appId: 'vscode', projectPath: '/srv' }, jumped, deps)).toEqual({ opened: false, reason: 'settings-mismatch', settings: ['ProxyJump'] });
    const unresolved = { resolveSsh: async () => { throw new Error('ssh: not found'); }, openExternal };
    expect(await openProjectInSshEditor({ appId: 'vscode', projectPath: '/srv' }, connection, unresolved)).toEqual({ opened: false, reason: 'unresolved' });
    expect(opened).toEqual([]);

    const noHandler = { resolveSsh, openExternal: async () => { throw new Error('No application found to open URL'); } };
    expect(await openProjectInSshEditor({ appId: 'vscode', projectPath: '/srv' }, connection, noHandler)).toEqual({ opened: false, reason: 'launch-failed' });
  });
});

describe('openWindowProjectInSshEditor', () => {
  const connections = {
    'ssh-a': { destination: 'a', args: [] },
    'ssh-b': { destination: 'b', args: [] },
  };
  const context = { hosts: [{ id: 'ssh-a', url: 'http://127.0.0.1:4001' }, { id: 'ssh-b', url: 'http://127.0.0.1:4002' }], localUrl: 'http://127.0.0.1:3000', localClientToken: '' };
  const windowOn = (runtimeKey) => ({ __ocRuntimeKey: runtimeKey, __ocHostWindowId: 'ssh-a', isDestroyed: () => false });
  const open = async (requestedRuntimeKey, window, resolveSsh = fakeSsh({}).resolveSsh) => {
    const opened = [];
    const result = await openWindowProjectInSshEditor({ appId: 'zed', projectPath: '/srv/app', runtimeKey: requestedRuntimeKey }, {
      window,
      context,
      liveConnection: (id) => connections[id] ?? null,
      resolveSsh,
      openExternal: async (url) => { opened.push(url); },
    });
    return { result, opened };
  };

  test('opens on the instance the window shows when the page asked for that one', async () => {
    expect(await open('host:ssh-b', windowOn('host:ssh-b'))).toEqual({ result: { opened: true }, opened: ['zed://ssh/me@b:22/srv/app'] });
    expect(await open('url:http://127.0.0.1:4001', windowOn('host:ssh-a'))).toEqual({ result: { opened: true }, opened: ['zed://ssh/me@a:22/srv/app'] });
  });

  test('refuses a request made on one instance after the window switched to another', async () => {
    const refused = { result: { opened: false, reason: 'instance-changed' }, opened: [] };
    expect(await open('host:ssh-a', windowOn('host:ssh-b'))).toEqual(refused);
    expect(await open('', windowOn('host:ssh-b'))).toEqual(refused);
    expect(await open('local', windowOn('local'))).toEqual(refused);
  });

  test('refuses when the window switches instance while the SSH settings resolve', async () => {
    const window = windowOn('host:ssh-a');
    const { resolveSsh } = fakeSsh({});
    const switchingResolver = async (destination, args) => {
      window.__ocRuntimeKey = 'host:ssh-b';
      return resolveSsh(destination, args);
    };
    expect(await open('host:ssh-a', window, switchingResolver)).toEqual({ result: { opened: false, reason: 'instance-changed' }, opened: [] });
  });
});
