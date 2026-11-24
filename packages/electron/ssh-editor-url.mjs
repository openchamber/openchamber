import { readTrimmedString, resolveHostEntryForRuntimeKey, resolveWindowHostId } from './notification-host-routing.mjs';

const VSCODE_REMOTE_SCHEMES = {
  vscode: 'vscode',
  'vscode-insiders': 'vscode-insiders',
};

const SSH_EDITOR_APP_IDS = new Set(['vscode', 'vscode-insiders', 'zed']);

const CONNECTION_SETTINGS = {
  hostname: 'HostName',
  user: 'User',
  port: 'Port',
  identityfile: 'IdentityFile',
  certificatefile: 'CertificateFile',
  identitiesonly: 'IdentitiesOnly',
  identityagent: 'IdentityAgent',
  proxyjump: 'ProxyJump',
  proxycommand: 'ProxyCommand',
  hostkeyalias: 'HostKeyAlias',
  userknownhostsfile: 'UserKnownHostsFile',
  pubkeyauthentication: 'PubkeyAuthentication',
  preferredauthentications: 'PreferredAuthentications',
};

export const parseSshConfigDump = (stdout) => {
  const settings = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;
    const key = trimmed.slice(0, space).toLowerCase();
    const value = trimmed.slice(space + 1).trim();
    if (!value) continue;
    settings.set(key, [...(settings.get(key) ?? []), value]);
  }
  return settings;
};

const firstSetting = (settings, key) => settings.get(key)?.[0] ?? '';

const sameSetting = (key, left = [], right = []) => {
  if (key === 'hostname') return (left[0] ?? '').toLowerCase() === (right[0] ?? '').toLowerCase();
  return left.join('\n') === right.join('\n');
};

const differingSshSettings = (connection, editor) => Object.keys(CONNECTION_SETTINGS)
  .filter((key) => !sameSetting(key, connection.get(key), editor.get(key)))
  .map((key) => CONNECTION_SETTINGS[key]);

const destinationHost = (destination) => {
  if (/^ssh:\/\//i.test(destination)) {
    if (!URL.canParse(destination)) return '';
    return new URL(destination).hostname.replace(/^\[(.*)\]$/, '$1');
  }
  const at = destination.lastIndexOf('@');
  return at >= 0 ? destination.slice(at + 1) : destination;
};

const encodePath = (remotePath) => remotePath.split('/').map(encodeURIComponent).join('/');

const editorLink = (appId, { host, user, port }, remotePath) => {
  const path = encodePath(remotePath);
  if (appId === 'zed') {
    const authority = `${encodeURIComponent(user)}@${host.includes(':') ? `[${host}]` : host}`;
    return `zed://ssh/${authority}${port ? `:${port}` : ''}${path}`;
  }
  const remote = { hostName: host, user };
  if (port) remote.port = Number(port);
  const authority = Buffer.from(JSON.stringify(remote)).toString('hex');
  return `${VSCODE_REMOTE_SCHEMES[appId]}://vscode-remote/ssh-remote+${authority}${path}?windowId=_blank`;
};

export const planSshEditorLaunch = async (appId, sshParsed, remotePath, resolveSsh) => {
  const connection = parseSshConfigDump(await resolveSsh(sshParsed.destination, sshParsed.args));
  const user = firstSetting(connection, 'user');
  const port = firstSetting(connection, 'port');
  const candidates = [...new Set([destinationHost(sshParsed.destination), firstSetting(connection, 'hostname')]
    .filter((host) => host && !host.startsWith('-')))];

  let differing = [];
  for (const host of candidates) {
    let carriesPort = true;
    if (appId !== 'zed') {
      const plain = parseSshConfigDump(await resolveSsh(host, []));
      carriesPort = firstSetting(plain, 'hostname').toLowerCase() === host.toLowerCase();
    }
    const editorArgs = ['-l', user, ...(carriesPort ? ['-p', port] : [])];
    const editor = parseSshConfigDump(await resolveSsh(host, editorArgs));
    const mismatch = differingSshSettings(connection, editor);
    if (mismatch.length === 0) {
      return { url: editorLink(appId, { host, user, port: carriesPort ? port : '' }, remotePath) };
    }
    if (differing.length === 0 || mismatch.length < differing.length) differing = mismatch;
  }
  return { url: null, settings: differing };
};

const resolveSshEditorConnection = ({ requestedRuntimeKey, window, context, liveConnection }) => {
  const requested = resolveHostEntryForRuntimeKey(requestedRuntimeKey, context)?.id || null;
  const current = resolveWindowHostId(window, context);
  if (!requested || requested !== current) return null;
  return liveConnection(current) || null;
};

export const openProjectInSshEditor = async (args, sshParsed, { resolveSsh, openExternal, isStillTarget = () => true, log = () => {} }) => {
  if (!sshParsed) return { opened: false, reason: 'instance-changed' };
  const appId = readTrimmedString(args?.appId).toLowerCase();
  const projectPath = readTrimmedString(args?.projectPath);
  if (!SSH_EDITOR_APP_IDS.has(appId) || !projectPath.startsWith('/')) {
    return { opened: false, reason: 'unsupported' };
  }

  let plan;
  try {
    plan = await planSshEditorLaunch(appId, sshParsed, projectPath, resolveSsh);
  } catch (error) {
    log('resolve', error);
    return { opened: false, reason: 'unresolved' };
  }
  if (!plan.url) return { opened: false, reason: 'settings-mismatch', settings: plan.settings };
  if (!isStillTarget()) return { opened: false, reason: 'instance-changed' };

  try {
    await openExternal(plan.url);
  } catch (error) {
    log('launch', error);
    return { opened: false, reason: 'launch-failed' };
  }
  return { opened: true };
};

export const openWindowProjectInSshEditor = (args, { window, context, liveConnection, resolveSsh, openExternal, log }) => {
  const target = () => resolveSshEditorConnection({ requestedRuntimeKey: args?.runtimeKey, window, context, liveConnection });
  const sshParsed = target();
  return openProjectInSshEditor(args, sshParsed, { resolveSsh, openExternal, log, isStillTarget: () => target() === sshParsed });
};
