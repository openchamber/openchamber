import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { getStartupStatus, enableStartupService, disableStartupService } from './cli-startup.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';

async function startupCommand(options, action = 'status', dependencies = {}) {
  const getStatus = dependencies.getStartupStatus || getStartupStatus;
  const enableService = dependencies.enableStartupService || enableStartupService;
  const disableService = dependencies.disableStartupService || disableStartupService;
  const normalized = typeof action === 'string' ? action.trim().toLowerCase() : 'status';
  if (!['status', 'enable', 'disable'].includes(normalized)) {
    throw new TunnelCliError(
      `Unknown startup subcommand '${action}'. Use 'openchamber startup --help'.`,
      EXIT_CODE.USAGE_ERROR
    );
  }

  let status;
  if (normalized === 'enable') {
    status = enableService(options);
  } else if (normalized === 'disable') {
    status = disableService();
  } else {
    status = getStatus();
  }

  let result = { action: normalized, ...status };
  if (!result.supported) {
    throw new TunnelCliError(
      `Startup integration is not supported on ${result.platform}.`,
      EXIT_CODE.USAGE_ERROR
    );
  }
  if (normalized === 'enable' && result.activeState === 'failed') {
    throw new TunnelCliError(
      'Startup service was installed but failed to start. Run `journalctl --user -u openchamber.service -n 80 --no-pager` for details.',
      EXIT_CODE.GENERAL_ERROR
    );
  }
  if (result.platform === 'linux' && result.enabled && result.lingerEnabled !== true) {
    const user = result.lingerUser || '"$USER"';
    const disabled = result.lingerEnabled === false;
    result = {
      ...result,
      messages: [{
        level: 'warning',
        code: disabled ? 'LINGER_DISABLED' : 'LINGER_UNKNOWN',
        message: disabled
          ? `User lingering is disabled; the startup service may stop after logout. Run \`sudo loginctl enable-linger ${user}\` to keep it running.`
          : `Could not verify user lingering; the startup service may stop after logout. Check with \`loginctl show-user ${user} -p Linger\`.`,
      }],
    };
  }
  if (isJsonMode(options)) {
    printJson(result);
    return;
  }

  if (isQuietMode(options)) {
    const lingerToken = result.platform === 'linux'
      ? ` linger:${result.lingerEnabled === true ? 'yes' : result.lingerEnabled === false ? 'no' : 'unknown'}`
      : '';
    process.stdout.write(`startup ${result.enabled ? 'enabled' : 'disabled'} platform:${result.platform} supported:${result.supported ? 'yes' : 'no'}${result.servicePath ? ` path:${result.servicePath}` : ''}${lingerToken}\n`);
    return;
  }

  clackIntro('OpenChamber Startup');
  logStatus(result.enabled ? 'success' : 'info', `startup ${result.enabled ? 'enabled' : 'disabled'}`, result.servicePath || undefined);
  if (typeof result.activeState === 'string') {
    logStatus(result.active ? 'success' : result.activeState === 'failed' ? 'error' : 'warning', `service ${result.activeState}`);
  }
  if (normalized === 'enable') {
    logStatus('info', 'service command', 'openchamber serve --foreground');
  }
  if (result.platform === 'linux') {
    if (result.lingerEnabled === true) {
      logStatus('success', 'user lingering enabled');
    } else if (result.lingerEnabled === false) {
      logStatus(result.enabled ? 'warning' : 'info', `${result.enabled ? '[LINGER_DISABLED] ' : ''}user lingering is disabled`, result.enabled ? 'startup service may stop after logout' : undefined);
      if (result.enabled) {
        logStatus('info', '[ENABLE_LINGER]', `sudo loginctl enable-linger ${result.lingerUser || '"$USER"'}`);
      }
    } else {
      logStatus(result.enabled ? 'warning' : 'info', result.enabled ? '[LINGER_UNKNOWN] could not verify user lingering' : 'user lingering state is unknown', result.enabled ? 'startup service may stop after logout' : undefined);
      if (result.enabled) {
        logStatus('info', '[CHECK_LINGER]', `loginctl show-user ${result.lingerUser || '"$USER"'} -p Linger`);
      }
    }
  }
  clackOutro(normalized === 'status' ? 'status complete' : `${normalized} complete`);
}

export { startupCommand };
