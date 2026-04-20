import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LOCAL_HOST_ID = 'local';
const DEFAULT_CONNECTION_TIMEOUT_SEC = 60;
const DEFAULT_LOCAL_BIND_HOST = '127.0.0.1';
const DEFAULT_CONTROL_PERSIST_SEC = 300;
const DEFAULT_READY_TIMEOUT_SEC = 30;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 5;
const MAX_LOG_LINES_PER_INSTANCE = 1200;

const MONITOR_INITIAL_POLL_MS = 2000;
const MONITOR_STEADY_POLL_MS = 10000;
const MONITOR_STABILIZE_TICKS = 5;
const SSH_STATUS_EVENT = 'openchamber:ssh-instance-status';

const nowMillis = () => Date.now();

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const hasGlobWildcard = (value) => /[*?]/.test(value);

const expandSshIncludeToken = (token, baseDir) => {
  const trimmed = String(token || '').trim();
  if (!trimmed) return [];

  const expandedHome = trimmed.startsWith('~/')
    ? path.join(os.homedir(), trimmed.slice(2))
    : (trimmed === '~' ? os.homedir() : trimmed);
  const resolved = path.isAbsolute(expandedHome)
    ? expandedHome
    : path.resolve(baseDir, expandedHome);

  if (!hasGlobWildcard(resolved)) {
    return fs.existsSync(resolved) ? [resolved] : [];
  }

  const dir = path.dirname(resolved);
  const namePattern = path.basename(resolved);
  if (hasGlobWildcard(dir) || !fs.existsSync(dir)) {
    return [];
  }

  const matcher = new RegExp(`^${namePattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')}$`);

  try {
    return fs.readdirSync(dir)
      .filter((name) => matcher.test(name))
      .map((name) => path.join(dir, name))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
};

const readJsonRoot = (settingsFilePath) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const writeJsonRoot = async (settingsFilePath, root) => {
  await fsp.mkdir(path.dirname(settingsFilePath), { recursive: true });
  await fsp.writeFile(settingsFilePath, JSON.stringify(root, null, 2));
};

const defaultTrue = () => true;

const sanitizeBindHost = (raw) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return DEFAULT_LOCAL_BIND_HOST;
  return ['127.0.0.1', 'localhost', '0.0.0.0'].includes(trimmed) ? trimmed : DEFAULT_LOCAL_BIND_HOST;
};

const splitShellWords = (input) => {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  const chars = [...String(input)];

  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];
    if (ch === '\\' && !inSingle) {
      index += 1;
      if (index < chars.length) current += chars[index];
      continue;
    }
    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (inSingle || inDouble) {
    throw new Error('Unclosed quote in SSH command');
  }
  if (current) tokens.push(current);
  return tokens;
};

const isDisallowedPrimaryFlag = (token) => {
  return ['-M', '-S', '-O', '-N', '-t', '-T', '-f', '-G', '-W', '-v', '-V', '-q', '-n', '-s', '-e', '-E', '-g'].includes(token);
};

const hasDisallowedOOption = (value) => {
  const lower = String(value).trim().toLowerCase();
  return ['controlmaster', 'controlpath', 'controlpersist', 'batchmode', 'proxycommand'].some((prefix) => lower.startsWith(prefix));
};

const parseSshCommand = (raw) => {
  const tokens = splitShellWords(raw);
  if (tokens.length === 0) {
    throw new Error('SSH command is empty');
  }

  if (tokens[0] === 'ssh') {
    tokens.shift();
  }

  if (tokens.length === 0) {
    throw new Error('SSH command must include destination');
  }

  const allowedFlags = new Set(['-4', '-6', '-A', '-a', '-C', '-K', '-k', '-X', '-x', '-Y', '-y']);
  const allowedWithValues = ['-B', '-b', '-c', '-D', '-F', '-I', '-i', '-J', '-l', '-m', '-o', '-P', '-p', '-R'];

  const args = [];
  let destination = null;
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (destination) {
      throw new Error(`SSH command has unsupported trailing argument: ${token}`);
    }

    if (!token.startsWith('-')) {
      destination = token.trim();
      index += 1;
      continue;
    }

    if (isDisallowedPrimaryFlag(token)) {
      throw new Error(`SSH option ${token} is not allowed`);
    }

    if (allowedFlags.has(token)) {
      args.push(token);
      index += 1;
      continue;
    }

    let matched = false;
    for (const option of allowedWithValues) {
      if (token === option) {
        const value = tokens[index + 1];
        if (!value) {
          throw new Error(`SSH option ${option} requires a value`);
        }
        if (option === '-o' && hasDisallowedOOption(value)) {
          throw new Error(`SSH option -o ${value} is not allowed`);
        }
        args.push(token, value);
        index += 2;
        matched = true;
        break;
      }

      if (token.startsWith(option) && token.length > option.length) {
        const value = token.slice(option.length);
        if (option === '-o' && hasDisallowedOOption(value)) {
          throw new Error(`SSH option -o ${value} is not allowed`);
        }
        args.push(token);
        index += 1;
        matched = true;
        break;
      }
    }

    if (!matched) {
      throw new Error(`Unsupported SSH option: ${token}`);
    }
  }

  if (!destination) {
    throw new Error('SSH command must include destination');
  }

  return { destination, args };
};

const runOutput = async (command, args, options = {}) => {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr });
    });
  });
};

const buildSshArgs = (parsed, preDestinationArgs = [], remoteCommand = null) => {
  const args = [...parsed.args, ...preDestinationArgs, parsed.destination];
  if (remoteCommand) args.push(remoteCommand);
  return args;
};

const runRemoteCommand = async (parsed, controlPath, script, timeoutSec = DEFAULT_CONNECTION_TIMEOUT_SEC) => {
  const args = buildSshArgs(parsed, [
    '-o', 'ControlMaster=no',
    '-o', `ControlPath=${controlPath}`,
    '-o', `ConnectTimeout=${timeoutSec}`,
    '-T',
  ], `sh -lc ${shellQuote(script)}`);
  const { code, stdout, stderr } = await runOutput('ssh', args);
  if (code !== 0) {
    throw new Error((stderr || stdout || 'Remote command failed').trim());
  }
  return stdout;
};

const controlMasterOperation = async (parsed, controlPath, op) => {
  return await runOutput('ssh', buildSshArgs(parsed, [
    '-o', 'ControlMaster=no',
    '-o', `ControlPath=${controlPath}`,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=3',
    '-O', op,
  ]));
};

const isControlMasterAlive = async (parsed, controlPath) => {
  const { code } = await controlMasterOperation(parsed, controlPath, 'check');
  return code === 0;
};

const stopControlMasterBestEffort = async (parsed, controlPath) => {
  try {
    await controlMasterOperation(parsed, controlPath, 'exit');
  } catch {
  }
};

const askpassScriptContent = () => `#!/bin/bash
PROMPT="$1"

if [[ -n "$OPENCHAMBER_SSH_ASKPASS_VALUE" ]]; then
  if [[ "$PROMPT" == *"assword"* || "$PROMPT" == *"passphrase"* ]]; then
    printf '%s\\n' "$OPENCHAMBER_SSH_ASKPASS_VALUE"
    exit 0
  fi
fi

DEFAULT_ANSWER=""
HIDDEN_INPUT="true"

if [[ "$PROMPT" == *"yes/no"* ]]; then
  DEFAULT_ANSWER="yes"
  HIDDEN_INPUT="false"
fi

if command -v osascript >/dev/null 2>&1; then
  /usr/bin/osascript <<'APPLESCRIPT' "$PROMPT" "$DEFAULT_ANSWER" "$HIDDEN_INPUT"
on run argv
  set promptText to item 1 of argv
  set defaultAnswer to item 2 of argv
  set hiddenInput to item 3 of argv

  try
    if hiddenInput is "true" then
      set response to display dialog promptText default answer defaultAnswer with hidden answer buttons {"Cancel", "OK"} default button "OK"
    else
      set response to display dialog promptText default answer defaultAnswer buttons {"Cancel", "OK"} default button "OK"
    end if
    return text returned of response
  on error
    error number -128
  end try
end run
APPLESCRIPT
  exit $?
fi

printf '%s\\n' "$DEFAULT_ANSWER"
`;

const writeAskpassScript = async (scriptPath) => {
  await fsp.writeFile(scriptPath, askpassScriptContent(), { mode: 0o700 });
  await fsp.chmod(scriptPath, 0o700);
};

const randomPortCandidate = (seed) => {
  let hash = 0;
  const source = `${seed}:${Date.now()}`;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  const base = 20000;
  const span = 30000;
  return base + Math.abs(hash % span);
};

const pickUnusedLocalPort = async () => {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
};

const isLocalPortAvailable = async (bindHost, port) => {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, bindHost, () => {
      server.close(() => resolve(true));
    });
  });
};

const isLocalTunnelReachable = async (localPort) => {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: localPort });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
};

const waitLocalForwardReady = async (localPort) => {
  const deadline = Date.now() + (DEFAULT_READY_TIMEOUT_SEC * 1000);
  let pollMs = 250;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok || response.status === 401) {
        return;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    pollMs = Math.min(pollMs * 2, 2000);
  }
  throw new Error('Timed out waiting for forwarded OpenChamber health');
};

const parseVersionToken = (raw) => {
  for (const token of String(raw).split(/\s+/)) {
    let candidate = token.trim().replace(/^v/, '');
    candidate = candidate.replace(/[,)]+$/g, '');
    const parts = candidate.split('.');
    if (parts.length >= 2 && parts.every((part) => /^\d+$/.test(part))) {
      return candidate;
    }
  }
  return null;
};

const parseProbeStatusLine = (line, prefix) => {
  if (!line || !line.startsWith(prefix)) return null;
  const value = Number.parseInt(line.slice(prefix.length).trim(), 10);
  return Number.isFinite(value) ? value : null;
};

const isAuthHttpStatus = (status) => status === 401 || status === 403;
const isLivenessHttpStatus = (status) => (status >= 200 && status <= 299) || isAuthHttpStatus(status);

export class ElectronSshManager {
  constructor(options) {
    this.settingsFilePath = options.settingsFilePath;
    this.appVersion = options.appVersion;
    this.emit = options.emit;
    this.logs = new Map();
    this.statuses = new Map();
    this.sessions = new Map();
    this.monitorTimers = new Map();
    this.reconnectAttempts = new Map();
    this.connectAttempts = new Map();
    this.connecting = new Map();
  }

  appendLogWithLevel(id, level, message) {
    const line = `[${nowMillis()}] [${level}] ${message}`;
    const current = this.logs.get(id) || [];
    current.push(line);
    if (current.length > MAX_LOG_LINES_PER_INSTANCE) {
      current.splice(0, current.length - MAX_LOG_LINES_PER_INSTANCE);
    }
    this.logs.set(id, current);
  }

  appendLog(id, message) {
    this.appendLogWithLevel(id, 'INFO', message);
  }

  appendAttemptSeparator(id, connectAttempt, retryAttempt) {
    const scope = retryAttempt > 0 ? `retry ${retryAttempt}` : 'manual';
    this.appendLogWithLevel(id, 'INFO', `---------------- attempt #${connectAttempt} (${scope}) ----------------`);
  }

  statusSnapshotForInstance(id) {
    return this.statuses.get(id) || {
      id,
      phase: 'idle',
      detail: null,
      localUrl: null,
      localPort: null,
      remotePort: null,
      startedByUs: false,
      retryAttempt: 0,
      requiresUserAction: false,
      updatedAtMs: nowMillis(),
    };
  }

  setStatus(id, phase, detail = null, localUrl = null, localPort = null, remotePort = null, startedByUs = false, retryAttempt = 0, requiresUserAction = false) {
    const level = phase === 'error' ? 'ERROR' : (phase === 'degraded' ? 'WARN' : 'INFO');
    this.appendLogWithLevel(
      id,
      level,
      `phase=${JSON.stringify(phase)} detail=${detail || ''} retry=${retryAttempt} requires_user_action=${requiresUserAction}`,
    );

    const status = {
      id,
      phase,
      detail,
      localUrl,
      localPort,
      remotePort,
      startedByUs,
      retryAttempt,
      requiresUserAction,
      updatedAtMs: nowMillis(),
    };
    this.statuses.set(id, status);
    this.emit(SSH_STATUS_EVENT, status);
  }

  clearRetryAttempt(id) {
    this.reconnectAttempts.delete(id);
  }

  nextRetryAttempt(id) {
    const next = (this.reconnectAttempts.get(id) || 0) + 1;
    this.reconnectAttempts.set(id, next);
    return next;
  }

  currentRetryAttempt(id) {
    return this.reconnectAttempts.get(id) || 0;
  }

  nextConnectAttempt(id) {
    const next = (this.connectAttempts.get(id) || 0) + 1;
    this.connectAttempts.set(id, next);
    return next;
  }

  logsForInstance(id, limit = 200) {
    const lines = [...(this.logs.get(id) || [])];
    return limit > 0 && lines.length > limit ? lines.slice(-limit) : lines;
  }

  clearLogsForInstance(id) {
    this.logs.delete(id);
  }

  parseSshConfigCandidates(filePath, source, visited = new Set()) {
    const resolvedPath = path.resolve(filePath);
    if (visited.has(resolvedPath) || !fs.existsSync(resolvedPath)) return [];
    visited.add(resolvedPath);

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const candidates = [];
    const baseDir = path.dirname(resolvedPath);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = (line.split('#')[0] || '').trim();
      if (!trimmed) continue;

      if (/^include(?:\s|$)/i.test(trimmed)) {
        const includeExpr = trimmed.replace(/^include\s+/i, '').trim();
        if (!includeExpr) continue;
        let includeTokens = [];
        try {
          includeTokens = splitShellWords(includeExpr);
        } catch {
          includeTokens = includeExpr.split(/\s+/).filter(Boolean);
        }
        for (const includeToken of includeTokens) {
          const includePaths = expandSshIncludeToken(includeToken, baseDir);
          for (const includePath of includePaths) {
            candidates.push(...this.parseSshConfigCandidates(includePath, source, visited));
          }
        }
        continue;
      }

      if (!/^host(?:\s|$)/i.test(trimmed)) continue;
      const rest = trimmed.replace(/^host\s+/i, '').trim();
      if (!rest) continue;
      for (const token of rest.split(/\s+/)) {
        const host = token.trim();
        if (!host || host.startsWith('!') || host === '*') continue;
        candidates.push({
          host,
          pattern: /[*?]/.test(host),
          source,
          sshCommand: `ssh ${host}`,
        });
      }
    }
    return candidates;
  }

  async importHosts() {
    const candidates = [
      ...this.parseSshConfigCandidates(path.join(os.homedir(), '.ssh', 'config'), 'user'),
      ...this.parseSshConfigCandidates('/etc/ssh/ssh_config', 'global'),
    ];
    const seen = new Set();
    return candidates
      .filter((item) => !seen.has(item.host) && seen.add(item.host))
      .sort((left, right) => left.host.localeCompare(right.host));
  }

  readInstances() {
    const root = readJsonRoot(this.settingsFilePath);
    return { instances: Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [] };
  }

  async setInstances(config) {
    const root = readJsonRoot(this.settingsFilePath);
    const instances = Array.isArray(config?.instances) ? config.instances.map((instance) => this.sanitizeInstance(instance)) : [];
    root.desktopSshInstances = instances;

    const previousIds = new Set((Array.isArray(root.desktopHosts) ? root.desktopHosts : []).map((entry) => String(entry?.id || '').trim()).filter(Boolean));
    const hosts = Array.isArray(root.desktopHosts) ? root.desktopHosts.filter(Boolean) : [];
    const nextIds = new Set(instances.map((instance) => instance.id));

    const filteredHosts = hosts.filter((entry) => {
      const id = String(entry?.id || '').trim();
      return id && !(previousIds.has(id) && !nextIds.has(id));
    });

    for (const instance of instances) {
      const label = instance.nickname?.trim() || instance.sshParsed?.destination || instance.id;
      const existing = filteredHosts.find((entry) => entry?.id === instance.id);
      if (existing) {
        existing.label = label;
        if (!existing.url || !String(existing.url).trim()) {
          existing.url = 'http://127.0.0.1/';
        }
      } else {
        filteredHosts.push({ id: instance.id, label, url: 'http://127.0.0.1/' });
      }
    }

    root.desktopHosts = filteredHosts;
    if (typeof root.desktopDefaultHostId === 'string' && previousIds.has(root.desktopDefaultHostId) && !nextIds.has(root.desktopDefaultHostId)) {
      root.desktopDefaultHostId = LOCAL_HOST_ID;
    }

    await writeJsonRoot(this.settingsFilePath, root);
  }

  sanitizeStoredSecret(secret) {
    if (!secret || typeof secret !== 'object') return undefined;
    return {
      enabled: Boolean(secret.enabled),
      store: secret.store === 'settings' ? 'settings' : 'never',
      ...(typeof secret.value === 'string' && secret.value.trim() ? { value: secret.value } : {}),
    };
  }

  sanitizeForward(forward) {
    const id = typeof forward?.id === 'string' ? forward.id.trim() : '';
    if (!id) return null;
    const type = forward?.type === 'remote' || forward?.type === 'dynamic' ? forward.type : 'local';
    const normalized = {
      id,
      enabled: forward?.enabled !== false,
      type,
      ...(forward?.localHost ? { localHost: sanitizeBindHost(forward.localHost) } : {}),
      ...(Number.isFinite(forward?.localPort) ? { localPort: Number(forward.localPort) } : {}),
      ...(forward?.remoteHost ? { remoteHost: String(forward.remoteHost).trim() || '127.0.0.1' } : {}),
      ...(Number.isFinite(forward?.remotePort) ? { remotePort: Number(forward.remotePort) } : {}),
    };

    if (type === 'local' || type === 'remote') {
      if (!normalized.localPort || !normalized.remotePort) return null;
      normalized.remoteHost = normalized.remoteHost || '127.0.0.1';
      normalized.localHost = normalized.localHost || '127.0.0.1';
    }
    if (type === 'dynamic' && !normalized.localPort) {
      return null;
    }
    return normalized;
  }

  sanitizeInstance(instance) {
    const id = typeof instance?.id === 'string' ? instance.id.trim() : '';
    const sshCommand = typeof instance?.sshCommand === 'string' ? instance.sshCommand.trim() : '';
    if (!id || id === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }
    if (!sshCommand) {
      throw new Error('SSH command is required');
    }

    const parsed = parseSshCommand(sshCommand);
    const seen = new Set();
    const portForwards = Array.isArray(instance?.portForwards)
      ? instance.portForwards
          .map((forward) => this.sanitizeForward(forward))
          .filter((forward) => forward && !seen.has(forward.id) && seen.add(forward.id))
      : [];

    return {
      id,
      ...(typeof instance?.nickname === 'string' && instance.nickname.trim() ? { nickname: instance.nickname.trim() } : {}),
      sshCommand,
      sshParsed: parsed,
      connectionTimeoutSec: Number.isFinite(instance?.connectionTimeoutSec) && Number(instance.connectionTimeoutSec) > 0
        ? Number(instance.connectionTimeoutSec)
        : DEFAULT_CONNECTION_TIMEOUT_SEC,
      remoteOpenchamber: {
        mode: instance?.remoteOpenchamber?.mode === 'external' ? 'external' : 'managed',
        keepRunning: instance?.remoteOpenchamber?.keepRunning !== false,
        ...(Number.isFinite(instance?.remoteOpenchamber?.preferredPort) ? { preferredPort: Number(instance.remoteOpenchamber.preferredPort) } : {}),
        installMethod: ['npm', 'bun', 'download_release', 'upload_bundle'].includes(instance?.remoteOpenchamber?.installMethod)
          ? instance.remoteOpenchamber.installMethod
          : 'bun',
        uploadBundleOverSsh: Boolean(instance?.remoteOpenchamber?.uploadBundleOverSsh),
      },
      localForward: {
        bindHost: sanitizeBindHost(instance?.localForward?.bindHost),
        ...(Number.isFinite(instance?.localForward?.preferredLocalPort) ? { preferredLocalPort: Number(instance.localForward.preferredLocalPort) } : {}),
      },
      auth: {
        ...(this.sanitizeStoredSecret(instance?.auth?.sshPassword) ? { sshPassword: this.sanitizeStoredSecret(instance.auth.sshPassword) } : {}),
        ...(this.sanitizeStoredSecret(instance?.auth?.openchamberPassword) ? { openchamberPassword: this.sanitizeStoredSecret(instance.auth.openchamberPassword) } : {}),
      },
      portForwards,
    };
  }

  async updateHostUrl(instanceId, label, localUrl) {
    const root = readJsonRoot(this.settingsFilePath);
    const hosts = Array.isArray(root.desktopHosts) ? root.desktopHosts : [];
    const existing = hosts.find((entry) => entry?.id === instanceId);
    if (existing) {
      existing.label = label;
      existing.url = localUrl;
    } else {
      hosts.push({ id: instanceId, label, url: localUrl });
    }
    root.desktopHosts = hosts;
    await writeJsonRoot(this.settingsFilePath, root);
  }

  async persistLocalPort(instanceId, localPort) {
    const root = readJsonRoot(this.settingsFilePath);
    const instances = Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [];
    for (const instance of instances) {
      if (instance?.id !== instanceId) continue;
      instance.localForward = instance.localForward && typeof instance.localForward === 'object' ? instance.localForward : {};
      instance.localForward.preferredLocalPort = localPort;
    }
    root.desktopSshInstances = instances;
    await writeJsonRoot(this.settingsFilePath, root);
  }

  async resolveSshConfig(parsed) {
    const { code, stdout, stderr } = await runOutput('ssh', buildSshArgs(parsed, ['-G']));
    if (code !== 0) {
      throw new Error(stderr.trim() || 'Failed to resolve SSH config');
    }
    const map = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [key, ...rest] = trimmed.split(' ');
      if (!key || rest.length === 0) continue;
      map.set(key.toLowerCase(), rest.join(' ').trim());
    }
    return map;
  }

  ensureSessionDir(id) {
    const base = path.join(path.dirname(this.settingsFilePath), 'ssh', id);
    fs.mkdirSync(base, { recursive: true });
    return base;
  }

  controlPathForInstance(id) {
    let hash = 0;
    for (const char of id) {
      hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    }
    return path.join(os.tmpdir(), `ocssh-${Math.abs(hash).toString(16)}.sock`);
  }

  async spawnMasterProcess(parsed, controlPath, askpassPath, sshPassword) {
    const child = spawn('ssh', buildSshArgs(parsed, [
      '-o', 'ControlMaster=yes',
      '-o', `ControlPath=${controlPath}`,
      '-o', `ControlPersist=${DEFAULT_CONTROL_PERSIST_SEC}`,
      '-N',
    ]), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SSH_ASKPASS_REQUIRE: 'force',
        SSH_ASKPASS: askpassPath,
        DISPLAY: '1',
        ...(sshPassword ? { OPENCHAMBER_SSH_ASKPASS_VALUE: sshPassword.trim() } : {}),
      },
    });
    return child;
  }

  async waitForMasterReady(parsed, controlPath, timeoutSec, master) {
    const deadline = Date.now() + (timeoutSec * 1000);
    let pollMs = 250;
    while (Date.now() < deadline) {
      const { code } = await runOutput('ssh', buildSshArgs(parsed, [
        '-o', 'ControlMaster=no',
        '-o', `ControlPath=${controlPath}`,
        '-O', 'check',
      ]));
      if (code === 0) return;

      const exited = master.exitCode;
      if (typeof exited === 'number') {
        throw new Error('SSH master process exited before ready');
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      pollMs = Math.min(pollMs * 2, 2000);
    }
    throw new Error('SSH ControlMaster connection timed out');
  }

  configuredOpenChamberPassword(instance) {
    const secret = instance?.auth?.openchamberPassword;
    return secret?.enabled && typeof secret.value === 'string' && secret.value.trim() ? secret.value.trim() : null;
  }

  async remoteCommandExists(parsed, controlPath, commandName) {
    try {
      const output = await runRemoteCommand(parsed, controlPath, `command -v ${commandName} >/dev/null 2>&1 && echo yes || echo no`);
      return output.trim() === 'yes';
    } catch {
      return false;
    }
  }

  async currentRemoteOpenChamberVersion(parsed, controlPath) {
    try {
      const output = await runRemoteCommand(parsed, controlPath, 'openchamber --version 2>/dev/null || true');
      return parseVersionToken(output);
    } catch {
      return null;
    }
  }

  async installOpenChamberManaged(parsed, controlPath, version, preferred) {
    const hasBun = await this.remoteCommandExists(parsed, controlPath, 'bun');
    const hasNpm = await this.remoteCommandExists(parsed, controlPath, 'npm');
    const commands = [];

    if (preferred === 'bun') {
      if (hasBun) commands.push(`bun add -g @openchamber/web@${version}`);
      if (hasNpm) commands.push(`npm install -g @openchamber/web@${version}`);
    } else if (preferred === 'npm') {
      if (hasNpm) commands.push(`npm install -g @openchamber/web@${version}`);
      if (hasBun) commands.push(`bun add -g @openchamber/web@${version}`);
    } else {
      if (hasBun) commands.push(`bun add -g @openchamber/web@${version}`);
      if (hasNpm) commands.push(`npm install -g @openchamber/web@${version}`);
    }

    if (commands.length === 0) {
      throw new Error('Remote host has neither bun nor npm available');
    }

    let lastError = null;
    for (const command of commands) {
      try {
        await runRemoteCommand(parsed, controlPath, command);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Failed to install OpenChamber on remote host');
  }

  async probeRemoteSystemInfo(parsed, controlPath, port, openchamberPassword) {
    const authPayload = openchamberPassword ? JSON.stringify({ password: openchamberPassword }) : '{}';
    const authEnabled = openchamberPassword ? '1' : '0';
    const script = `AUTH_STATUS=0; INFO_STATUS=0; HEALTH_STATUS=0; BODY_FILE="$(mktemp)"; COOKIE_FILE="$(mktemp)"; cleanup(){ rm -f "$BODY_FILE" "$COOKIE_FILE"; }; trap cleanup EXIT; if command -v curl >/dev/null 2>&1; then if [ "${authEnabled}" = "1" ]; then AUTH_STATUS="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' -c "$COOKIE_FILE" -H 'content-type: application/json' --data ${shellQuote(authPayload)} http://127.0.0.1:${port}/auth/session || true)"; if [ "$AUTH_STATUS" = "200" ]; then INFO_STATUS="$(curl -sS --max-time 3 -b "$COOKIE_FILE" -o "$BODY_FILE" -w '%{http_code}' http://127.0.0.1:${port}/api/system/info || true)"; else INFO_STATUS="$(curl -sS --max-time 3 -o "$BODY_FILE" -w '%{http_code}' http://127.0.0.1:${port}/api/system/info || true)"; fi; else INFO_STATUS="$(curl -sS --max-time 3 -o "$BODY_FILE" -w '%{http_code}' http://127.0.0.1:${port}/api/system/info || true)"; fi; HEALTH_STATUS="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/health || true)"; elif command -v wget >/dev/null 2>&1; then wget -qO "$BODY_FILE" http://127.0.0.1:${port}/api/system/info >/dev/null 2>&1; if [ $? -eq 0 ]; then INFO_STATUS=200; fi; wget -qO- http://127.0.0.1:${port}/health >/dev/null 2>&1; if [ $? -eq 0 ]; then HEALTH_STATUS=200; fi; else exit 127; fi; printf 'INFO_STATUS=%s\\nAUTH_STATUS=%s\\nHEALTH_STATUS=%s\\n' "$INFO_STATUS" "$AUTH_STATUS" "$HEALTH_STATUS"; cat "$BODY_FILE" 2>/dev/null || true`;
    const output = await runRemoteCommand(parsed, controlPath, script);
    const lines = output.split(/\r?\n/);
    const infoStatus = parseProbeStatusLine(lines[0], 'INFO_STATUS=') || 0;
    const authStatus = parseProbeStatusLine(lines[1], 'AUTH_STATUS=') || 0;
    const healthStatus = parseProbeStatusLine(lines[2], 'HEALTH_STATUS=') || 0;
    const body = lines.slice(3).join('\n');

    if (isLivenessHttpStatus(infoStatus)) {
      if (isAuthHttpStatus(infoStatus)) {
        if (openchamberPassword && authStatus !== 200) {
          throw new Error(`Remote OpenChamber requires UI authentication and configured password was rejected (auth status ${authStatus})`);
        }
        if (isLivenessHttpStatus(healthStatus)) return {};
        throw new Error('Remote OpenChamber requires UI authentication on /api/system/info; configure OpenChamber UI password');
      }
    } else if (isLivenessHttpStatus(healthStatus)) {
      return {};
    } else {
      throw new Error(`Remote OpenChamber probe failed (info status ${infoStatus}, health status ${healthStatus})`);
    }

    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  async remoteServerRunning(parsed, controlPath, port, openchamberPassword) {
    try {
      await this.probeRemoteSystemInfo(parsed, controlPath, port, openchamberPassword);
      return true;
    } catch {
      return false;
    }
  }

  async startRemoteServerManaged(parsed, controlPath, instance, desiredPort) {
    let envPrefix = 'OPENCHAMBER_RUNTIME=ssh-remote';
    const secret = this.configuredOpenChamberPassword(instance);
    if (secret) {
      envPrefix += ` OPENCHAMBER_UI_PASSWORD=${shellQuote(secret)}`;
    }
    const output = await runRemoteCommand(parsed, controlPath, `${envPrefix} openchamber serve --daemon --hostname 127.0.0.1 --port ${desiredPort}`);
    const port = output.split(/\s+/).map((token) => Number.parseInt(token, 10)).find((value) => Number.isFinite(value));
    return port || desiredPort;
  }

  async stopRemoteServerBestEffort(parsed, controlPath, remotePort) {
    try {
      await runRemoteCommand(
        parsed,
        controlPath,
        `if command -v curl >/dev/null 2>&1; then curl -fsS -X POST http://127.0.0.1:${remotePort}/api/system/shutdown >/dev/null 2>&1 || true; elif command -v wget >/dev/null 2>&1; then wget -qO- --method=POST http://127.0.0.1:${remotePort}/api/system/shutdown >/dev/null 2>&1 || true; fi`,
      );
    } catch {
    }
  }

  async spawnMainForward(parsed, controlPath, bindHost, localPort, remotePort) {
    return spawn('ssh', buildSshArgs(parsed, [
      '-o', 'ControlMaster=no',
      '-o', `ControlPath=${controlPath}`,
      '-N',
      '-L', `${bindHost}:${localPort}:127.0.0.1:${remotePort}`,
    ]), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }

  async spawnExtraForward(parsed, controlPath, forward) {
    const args = [
      '-o', 'ControlMaster=no',
      '-o', `ControlPath=${controlPath}`,
      '-O', 'forward',
    ];
    if (forward.type === 'local') {
      args.push('-L', `${forward.localHost || '127.0.0.1'}:${forward.localPort}:${forward.remoteHost || '127.0.0.1'}:${forward.remotePort}`);
    } else if (forward.type === 'remote') {
      args.push('-R', `${forward.remoteHost || '127.0.0.1'}:${forward.remotePort}:${forward.localHost || '127.0.0.1'}:${forward.localPort}`);
    } else {
      args.push('-D', `${forward.localHost || '127.0.0.1'}:${forward.localPort}`);
    }
    const { code, stdout, stderr } = await runOutput('ssh', buildSshArgs(parsed, args));
    if (code !== 0) {
      throw new Error((stderr || stdout || `Failed to configure extra SSH forward ${forward.id}`).trim());
    }
  }

  async ensureRemoteServer(instance, parsed, controlPath) {
    if (instance.remoteOpenchamber.mode === 'external') {
      if (!instance.remoteOpenchamber.preferredPort) {
        throw new Error('External mode requires a preferred remote OpenChamber port');
      }
      const port = instance.remoteOpenchamber.preferredPort;
      this.setStatus(instance.id, 'server_detecting', 'Probing external OpenChamber server', null, null, port, false, 0, false);
      await this.probeRemoteSystemInfo(parsed, controlPath, port, this.configuredOpenChamberPassword(instance));
      return { remotePort: port, startedByUs: false };
    }

    this.setStatus(instance.id, 'remote_probe', 'Checking remote OpenChamber installation');
    const installedVersion = await this.currentRemoteOpenChamberVersion(parsed, controlPath);
    if (!installedVersion) {
      this.setStatus(instance.id, 'installing', 'Installing OpenChamber on remote host');
      await this.installOpenChamberManaged(parsed, controlPath, this.appVersion, instance.remoteOpenchamber.installMethod);
    } else if (installedVersion !== this.appVersion) {
      this.setStatus(instance.id, 'updating', `Updating remote OpenChamber from ${installedVersion} to ${this.appVersion}`);
      await this.installOpenChamberManaged(parsed, controlPath, this.appVersion, instance.remoteOpenchamber.installMethod);
    }

    this.setStatus(instance.id, 'server_detecting', 'Detecting managed OpenChamber server');
    let remotePort = instance.remoteOpenchamber.preferredPort || null;
    let startedByUs = false;
    if (remotePort && !(await this.remoteServerRunning(parsed, controlPath, remotePort, this.configuredOpenChamberPassword(instance)))) {
      remotePort = null;
    }
    if (!remotePort) {
      this.setStatus(instance.id, 'server_starting', 'Starting managed OpenChamber server');
      const desiredPort = instance.remoteOpenchamber.preferredPort || randomPortCandidate(instance.id);
      remotePort = await this.startRemoteServerManaged(parsed, controlPath, instance, desiredPort);
      startedByUs = true;
    }
    if (!(await this.remoteServerRunning(parsed, controlPath, remotePort, this.configuredOpenChamberPassword(instance)))) {
      throw new Error('Managed OpenChamber server failed to become reachable');
    }
    return { remotePort, startedByUs };
  }

  async disconnectInternal(id, reportIdle) {
    const timer = this.monitorTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.monitorTimers.delete(id);
    }

    const session = this.sessions.get(id);
    this.sessions.delete(id);

    if (session) {
      if (session.startedByUs && session.instance.remoteOpenchamber.mode === 'managed' && !session.instance.remoteOpenchamber.keepRunning) {
        await this.stopRemoteServerBestEffort(session.parsed, session.controlPath, session.remotePort);
      }
      await stopControlMasterBestEffort(session.parsed, session.controlPath);
      for (const child of [session.mainForward, session.master]) {
        try {
          child.kill('SIGTERM');
        } catch {
        }
      }
      try {
        await fsp.rm(session.controlPath, { force: true });
      } catch {
      }
      try {
        await fsp.rm(path.join(session.sessionDir, 'askpass.sh'), { force: true });
      } catch {
      }
    }

    this.clearRetryAttempt(id);
    if (reportIdle) {
      this.setStatus(id, 'idle', null, null, null, null, false, 0, false);
    }
  }

  async connectBlocking(instance) {
    const id = instance.id;
    this.setStatus(id, 'config_resolved', 'Resolving SSH command');
    const parsed = instance.sshParsed || parseSshCommand(instance.sshCommand);
    await this.resolveSshConfig(parsed);

    this.setStatus(id, 'auth_check', 'Checking SSH connectivity');
    const sessionDir = this.ensureSessionDir(id);
    const controlPath = this.controlPathForInstance(id);
    try { await fsp.rm(controlPath, { force: true }); } catch {}
    const askpassPath = path.join(sessionDir, 'askpass.sh');
    await writeAskpassScript(askpassPath);

    this.setStatus(id, 'master_connecting', 'Establishing SSH ControlMaster');
    const sshPassword = instance.auth?.sshPassword?.enabled ? instance.auth.sshPassword.value : null;
    const master = await this.spawnMasterProcess(parsed, controlPath, askpassPath, sshPassword);
    await this.waitForMasterReady(parsed, controlPath, instance.connectionTimeoutSec || DEFAULT_CONNECTION_TIMEOUT_SEC, master);

    this.setStatus(id, 'remote_probe', 'Probing remote platform');
    const remoteOs = (await runRemoteCommand(parsed, controlPath, 'uname -s', instance.connectionTimeoutSec || DEFAULT_CONNECTION_TIMEOUT_SEC)).trim().toLowerCase();
    if (!['linux', 'darwin'].includes(remoteOs)) {
      master.kill('SIGTERM');
      throw new Error(`Unsupported remote OS: ${remoteOs}`);
    }

    const { remotePort, startedByUs } = await this.ensureRemoteServer(instance, parsed, controlPath);
    this.setStatus(id, 'forwarding', 'Setting up port forwards', null, null, remotePort, startedByUs, 0, false);

    const bindHost = sanitizeBindHost(instance.localForward?.bindHost);
    let localPort = Number(instance.localForward?.preferredLocalPort) || 0;
    if (!localPort) {
      localPort = await pickUnusedLocalPort();
    }
    if (!(await isLocalPortAvailable(bindHost, localPort))) {
      localPort = await pickUnusedLocalPort();
    }

    const mainForward = await this.spawnMainForward(parsed, controlPath, bindHost, localPort, remotePort);
    let mainForwardDetached = false;
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (typeof mainForward.exitCode === 'number') {
      if (mainForward.exitCode === 0) {
        mainForwardDetached = true;
        this.appendLogWithLevel(id, 'INFO', 'Main tunnel helper exited after ControlMaster handoff');
      } else {
        master.kill('SIGTERM');
        throw new Error(`Failed to start main port forward (status: ${mainForward.exitCode})`);
      }
    }

    const extraErrors = [];
    for (const forward of instance.portForwards.filter((item) => item.enabled)) {
      try {
        await this.spawnExtraForward(parsed, controlPath, forward);
        if (forward.type === 'local' && forward.localPort) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!(await isLocalTunnelReachable(forward.localPort))) {
            extraErrors.push(`${forward.id}: local listener 127.0.0.1:${forward.localPort} is not reachable`);
          }
        }
      } catch (error) {
        extraErrors.push(`${forward.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await waitLocalForwardReady(localPort);

    const localUrl = `http://127.0.0.1:${localPort}`;
    const label = instance.nickname?.trim() || parsed.destination || id;
    await this.updateHostUrl(id, label, localUrl);
    if (instance.localForward?.preferredLocalPort !== localPort) {
      await this.persistLocalPort(id, localPort);
    }

    this.sessions.set(id, {
      instance,
      parsed,
      sessionDir,
      controlPath,
      localPort,
      remotePort,
      startedByUs,
      master,
      masterDetached: false,
      mainForward,
      mainForwardDetached,
    });

    this.clearRetryAttempt(id);
    this.setStatus(
      id,
      'ready',
      extraErrors.length === 0 ? 'SSH instance is ready' : `SSH instance is ready with forward warnings: ${extraErrors.join('; ')}`,
      localUrl,
      localPort,
      remotePort,
      startedByUs,
      0,
      false,
    );
    this.spawnMonitor(id);
  }

  spawnMonitor(id) {
    const existing = this.monitorTimers.get(id);
    if (existing) clearTimeout(existing);
    let healthyTicks = 0;
    const tick = async () => {
      const session = this.sessions.get(id);
      if (!session) {
        this.monitorTimers.delete(id);
        return;
      }

      let droppedReason = null;
      let detachedNotice = null;

      if (!session.mainForwardDetached) {
        if (typeof session.mainForward.exitCode === 'number') {
          if (session.mainForward.exitCode === 0) {
            session.mainForwardDetached = true;
            detachedNotice = 'Main tunnel helper exited after ControlMaster handoff';
          } else {
            droppedReason = `Main SSH forward exited (${session.mainForward.exitCode})`;
          }
        }
      }

      if (!droppedReason) {
        if (session.mainForwardDetached) {
          // Fast path: cheap TCP probe before expensive SSH subprocess
          if (await isLocalTunnelReachable(session.localPort)) {
            // Tunnel alive — skip SSH check
          } else if (!await isControlMasterAlive(session.parsed, session.controlPath)) {
            droppedReason = 'SSH ControlMaster is not reachable';
          } else {
            detachedNotice = 'Local tunnel unreachable but ControlMaster is alive';
          }
        }
      }

      if (detachedNotice) {
        this.appendLogWithLevel(id, 'INFO', detachedNotice);
      }
      if (!droppedReason) {
        healthyTicks++;
        const pollMs = healthyTicks >= MONITOR_STABILIZE_TICKS ? MONITOR_STEADY_POLL_MS : MONITOR_INITIAL_POLL_MS;
        this.monitorTimers.set(id, setTimeout(tick, pollMs));
        return;
      }

      this.appendLogWithLevel(id, 'WARN', droppedReason);
      await this.disconnectInternal(id, false);
      const attempt = this.nextRetryAttempt(id);
      if (attempt > DEFAULT_RECONNECT_MAX_ATTEMPTS) {
        this.setStatus(id, 'error', `${droppedReason}. Retry limit reached`, null, null, null, false, attempt, true);
        return;
      }

      this.setStatus(id, 'degraded', `${droppedReason}. Reconnecting`, null, null, null, false, attempt, false);
      const delayMs = Math.min((2 ** Math.max(attempt - 1, 0)) * 1000 + (nowMillis() % 700) + 100, 30000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        await this.connect(id);
      } catch (error) {
        this.setStatus(id, 'error', error instanceof Error ? error.message : String(error), null, null, null, false, attempt, true);
      }
    };
    this.monitorTimers.set(id, setTimeout(tick, MONITOR_INITIAL_POLL_MS));
  }

  async connect(id) {
    const trimmed = String(id || '').trim();
    if (!trimmed || trimmed === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }

    if (this.connecting.has(trimmed)) {
      this.appendLogWithLevel(trimmed, 'INFO', 'Connection already in progress');
      return this.connecting.get(trimmed);
    }

    const instance = this.readInstances().instances.find((entry) => entry?.id === trimmed);
    if (!instance) {
      throw new Error('SSH instance not found');
    }

    const retryAttempt = this.currentRetryAttempt(trimmed);
    const connectAttempt = this.nextConnectAttempt(trimmed);
    this.appendAttemptSeparator(trimmed, connectAttempt, retryAttempt);
    this.appendLog(trimmed, 'Starting SSH connection');
    await this.disconnectInternal(trimmed, false);

    const task = this.connectBlocking(this.sanitizeInstance(instance))
      .catch(async (error) => {
        this.setStatus(trimmed, 'error', error instanceof Error ? error.message : String(error), null, null, null, false, 0, true);
        await this.disconnectInternal(trimmed, false);
        throw error;
      })
      .finally(() => {
        this.connecting.delete(trimmed);
      });
    this.connecting.set(trimmed, task);
    return task;
  }

  async disconnect(id) {
    const trimmed = String(id || '').trim();
    if (!trimmed || trimmed === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }
    await this.disconnectInternal(trimmed, true);
  }

  async statusesWithDefaults(id) {
    if (id) {
      return [this.statusSnapshotForInstance(id)];
    }
    return this.readInstances().instances
      .map((instance) => this.statusSnapshotForInstance(instance.id))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async shutdownAll() {
    const ids = [...new Set([...this.sessions.keys(), ...this.connecting.keys(), ...this.monitorTimers.keys()])];
    for (const id of ids) {
      await this.disconnectInternal(id, false);
    }
  }
}
