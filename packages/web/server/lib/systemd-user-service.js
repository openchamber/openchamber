import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

export const OPENCHAMBER_SYSTEMD_USER_SERVICE = 'openchamber.service';

function getSpawnSyncBaseOptions() {
  return process.platform === 'win32' ? { windowsHide: true } : {};
}

export function getSystemdUserServicePath({ homedir = os.homedir() } = {}) {
  return path.join(homedir, '.config', 'systemd', 'user', OPENCHAMBER_SYSTEMD_USER_SERVICE);
}

function runSystemdUserCommand(args, { spawnSyncImpl = spawnSync, stdio = 'pipe' } = {}) {
  const result = spawnSyncImpl('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    stdio,
    ...getSpawnSyncBaseOptions(),
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function readConfiguredPortFromUnit(servicePath, { fsImpl = fs } = {}) {
  try {
    const content = fsImpl.readFileSync(servicePath, 'utf8');
    const match = content.match(/["']?--port["']?\s+["']?(\d+)["']?/);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getSystemdUserServiceStatus({
  platform = process.platform,
  homedir = os.homedir(),
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== 'linux') {
    return {
      supported: false,
      enabled: false,
      active: false,
      activeState: 'unsupported',
      configuredPort: null,
      servicePath: null,
    };
  }

  const servicePath = getSystemdUserServicePath({ homedir });
  const configuredPort = readConfiguredPortFromUnit(servicePath, { fsImpl });

  let enabledResult;
  let activeResult;
  try {
    enabledResult = runSystemdUserCommand(['is-enabled', OPENCHAMBER_SYSTEMD_USER_SERVICE], {
      spawnSyncImpl,
      stdio: 'pipe',
    });
    activeResult = runSystemdUserCommand(['is-active', OPENCHAMBER_SYSTEMD_USER_SERVICE], {
      spawnSyncImpl,
      stdio: 'pipe',
    });
  } catch {
    return {
      supported: true,
      enabled: fsImpl.existsSync(servicePath),
      active: false,
      activeState: 'unknown',
      configuredPort,
      servicePath,
    };
  }

  const activeState = (activeResult.stdout || '').trim() || 'inactive';

  return {
    supported: true,
    enabled: enabledResult.status === 0 || fsImpl.existsSync(servicePath),
    active: activeState === 'active',
    activeState,
    configuredPort,
    servicePath,
  };
}

export function getForegroundSystemdUserServiceController({
  launchMode,
  port,
  platform = process.platform,
  homedir = os.homedir(),
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (launchMode !== 'foreground' || platform !== 'linux') {
    return null;
  }

  const status = getSystemdUserServiceStatus({ platform, homedir, fsImpl, spawnSyncImpl });
  if (!status.supported || !status.enabled || !status.active) {
    return null;
  }

  if (
    Number.isFinite(port)
    && Number.isFinite(status.configuredPort)
    && status.configuredPort !== port
  ) {
    return null;
  }

  return {
    kind: 'systemd-user',
    label: 'systemd user service',
    serviceName: OPENCHAMBER_SYSTEMD_USER_SERVICE,
    servicePath: status.servicePath,
    configuredPort: status.configuredPort,
    stop: {
      command: 'systemctl',
      args: ['--user', 'stop', OPENCHAMBER_SYSTEMD_USER_SERVICE],
      shellCommand: `systemctl --user stop ${OPENCHAMBER_SYSTEMD_USER_SERVICE}`,
    },
    start: {
      command: 'systemctl',
      args: ['--user', 'start', OPENCHAMBER_SYSTEMD_USER_SERVICE],
      shellCommand: `systemctl --user start ${OPENCHAMBER_SYSTEMD_USER_SERVICE}`,
    },
  };
}

export function resolveUpdateRestartOwnerForInstance({
  launchMode,
  port,
  platform = process.platform,
  homedir = os.homedir(),
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  const controller = getForegroundSystemdUserServiceController({
    launchMode,
    port,
    platform,
    homedir,
    fsImpl,
    spawnSyncImpl,
  });

  if (controller) {
    return {
      kind: 'systemd-user-service',
      label: controller.label,
      controller,
    };
  }

  return {
    kind: 'cli',
    label: 'CLI',
    controller: null,
  };
}

export function partitionInstancesForUpdateRestart(instances = [], options = {}) {
  const cliManagedInstances = [];
  const serviceManagedInstances = [];
  let serviceManagerOwner = null;

  for (const instance of instances) {
    const owner = resolveUpdateRestartOwnerForInstance({
      launchMode: instance?.launchMode,
      port: instance?.port,
      platform: options.platform,
      homedir: options.homedir,
      fsImpl: options.fsImpl,
      spawnSyncImpl: options.spawnSyncImpl,
    });

    if (owner.controller) {
      serviceManagerOwner = serviceManagerOwner || owner;
      serviceManagedInstances.push(instance);
      continue;
    }

    cliManagedInstances.push(instance);
  }

  return {
    cliManagedInstances,
    serviceManagedInstances,
    serviceManagerOwner,
  };
}

export function runForegroundSystemdUserServiceControllerAction(
  controller,
  action,
  { spawnSyncImpl = spawnSync, stdio = 'pipe' } = {},
) {
  if (!controller || controller.kind !== 'systemd-user') {
    throw new Error('A systemd user service controller is required.');
  }

  const step = action === 'stop' ? controller.stop : action === 'start' ? controller.start : null;
  if (!step) {
    throw new Error(`Unsupported systemd user service action: ${action}`);
  }

  const result = spawnSyncImpl(step.command, step.args, {
    encoding: 'utf8',
    stdio,
    ...getSpawnSyncBaseOptions(),
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${step.command} ${step.args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }

  return result;
}
