import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { webPackagePaths } from '../server/lib/web-package-paths.js';
import { isModuleCliExecution } from './cli-entry.js';
import { EXIT_CODE, TunnelCliError } from './lib/cli-errors.js';
import {
  resolveServeHost,
  hasUiPasswordConfigured,
  generateUiPassword,
  resolveServeUiPassword,
  assertAuthenticatedNetworkExposure,
} from './lib/cli-network.js';
import {
  maskToken,
  resolveToken,
  redactProfileForOutput,
  redactProfilesForOutput,
  warnIfUnsafeFilePermissions,
  ensureTunnelProfilesMigrated as ensureTunnelProfilesMigratedBase,
} from './lib/cli-tunnel-profiles.js';
import {
  parseArgs,
  showHelp,
  showControlHelp,
  showStartupHelp,
  showConnectUrlHelp,
  showTunnelHelp,
  generateCompletionScript,
  findClosestMatch,
} from './lib/cli-args.js';
import { readDesktopLocalPortFromSettings } from './lib/cli-paths.js';
import { resolveExplicitBinary, searchPathFor } from './lib/cli-executables.js';
import { startupCommand } from './lib/commands-startup.js';
import { logsCommand } from './lib/commands-logs.js';
import { statusCommand } from './lib/commands-status.js';
import { scheduleCommand } from './lib/commands-schedule.js';
import { sessionCommand } from './lib/commands-session.js';
import { modelsCommand } from './lib/commands-models.js';
import { projectsCommand } from './lib/commands-projects.js';
import { createUpdateCommand } from './lib/commands-update.js';
import { createConnectUrlCommand } from './lib/commands-connect-url.js';
import { createLifecycleCommands } from './lib/commands-lifecycle.js';
import { createServeCommand } from './lib/commands-serve.js';
import { createTunnelCommand, isValidTunnelDoctorResponse, shouldDisplayTunnelQr } from './lib/commands-tunnel.js';
import {
  discoverRunningInstances,
  discoverOpenChamberInstanceOnPort,
  discoverLifecycleInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
  resolveTunnelProviders,
} from './lib/cli-lifecycle.js';
import {
  fetchTunnelProvidersFromPort,
  fetchSystemInfoFromPort,
} from './lib/cli-http.js';
import {
  getPidFilePath,
  getInstanceFilePath,
  isProcessRunning,
  isOpenchamberCmdline,
  isOpenchamberProcessRunning,
  getOpenchamberProcessState,
} from './lib/cli-process.js';
import {
  intro as clackIntro, outro as clackOutro, cancel as clackCancel,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from './cli-output.js';
import { applyConnectAttemptTimeout } from '../server/lib/network-defaults.js';
import { createOpenCodeEnvRuntime } from '../server/lib/opencode/env-runtime.js';
import { bunVersionRunsBunPty } from '../server/lib/terminal/bun-pty-support.js';
import { isRecord, isString } from '../server/lib/shared/object-guards.js';
import type { JsonObject, JsonValue } from '../server/lib/shared/json-values.js';
import type { CliOptions } from './lib/cli-args.js';
import type { CliNotice } from './lib/cli-process.js';

// external: #3399 provider fetches need a longer connect-attempt timeout than undici's 250ms default.
applyConnectAttemptTimeout();

function isPackageManifest(value: JsonValue): value is JsonObject {
  return isRecord(value);
}

const PACKAGE_JSON: JsonValue = JSON.parse(fs.readFileSync(webPackagePaths.packageJson, 'utf8'));
const PACKAGE_VERSION = isPackageManifest(PACKAGE_JSON) ? PACKAGE_JSON.version : undefined;

let onCancelCleanup: (() => Promise<void>) | null = null;
let activeCommandOptions: CliOptions | null = null;
let foregroundServerActive = false;
let foregroundShutdown: ((signal?: string) => Promise<void>) | null = null;

function setCancelCleanup(handler: (() => Promise<void>) | null) {
  onCancelCleanup = handler;
}

function shouldWarnForTunnelProfileFile() {
  if (!activeCommandOptions) return false;
  return !isJsonMode(activeCommandOptions) && !isQuietMode(activeCommandOptions);
}

function ensureTunnelProfilesMigrated() {
  return ensureTunnelProfilesMigratedBase({ shouldWarn: shouldWarnForTunnelProfileFile() });
}

const HAS_PLAIN_FLAG = process.argv.includes('--plain');
const STYLE_ENABLED = process.stdout.isTTY && process.env.NO_COLOR !== '1' && !HAS_PLAIN_FLAG;
const ANSI = {
  bold: '\x1b[1m',
  unbold: '\x1b[22m',
};

function boldText(text: string) {
  if (!STYLE_ENABLED) return text;
  return `${ANSI.bold}${text}${ANSI.unbold}`;
}

function importFromFilePath(filePath: string) {
  return import(pathToFileURL(filePath).href);
}

function getBunBinary() {
  if (isString(process.env.BUN_BINARY) && process.env.BUN_BINARY.trim().length > 0) {
    return process.env.BUN_BINARY.trim();
  }
  if (isString(process.env.BUN_INSTALL) && process.env.BUN_INSTALL.trim().length > 0) {
    return path.join(process.env.BUN_INSTALL.trim(), 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  }
  return 'bun';
}

const BUN_BIN = getBunBinary();

function getInstalledBunVersion() {
  try {
    const result = spawnSync(BUN_BIN, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      env: process.env,
      windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

// external: #6322 Bun before the PTY fix cannot back a terminal, so the server runs on Node there.
function getServerRuntimeBinary() {
  if (bunVersionRunsBunPty(getInstalledBunVersion())) return BUN_BIN;
  const bun = globalThis.Bun;
  if (bun === undefined || bunVersionRunsBunPty(bun.version)) return process.execPath;
  return searchPathFor('node') ?? process.execPath;
}

function missingEnvDependency(name: string) {
  return (): never => {
    throw new TypeError(`${name} is not a function`);
  };
}

async function checkOpenCodeCLI(onNotice?: (notice: CliNotice) => void) {
  if (process.env.OPENCODE_BINARY) {
    const override = resolveExplicitBinary(process.env.OPENCODE_BINARY);
    if (override) {
      process.env.OPENCODE_BINARY = override;
      return override;
    }
    const message = `OPENCODE_BINARY="${process.env.OPENCODE_BINARY}" is not an executable file. Falling back to PATH lookup.`;
    if (onNotice !== undefined) {
      onNotice({ level: 'warning', code: 'OPENCODE_BINARY_INVALID', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }

  let resolvedFromPath = searchPathFor('opencode');
  if (!resolvedFromPath) {
    createOpenCodeEnvRuntime({
      state: {},
      normalizeDirectoryPath: missingEnvDependency('normalizeDirectoryPath'),
      readSettingsFromDiskMigrated: missingEnvDependency('readSettingsFromDiskMigrated'),
    }).applyLoginShellEnvSnapshot();
    resolvedFromPath = searchPathFor('opencode');
  }
  if (resolvedFromPath) {
    process.env.OPENCODE_BINARY = resolvedFromPath;
    return resolvedFromPath;
  }

  throw new Error(
    `Unable to locate the opencode CLI on PATH (${process.env.PATH || '<empty>'}). ` +
    'Ensure the CLI is installed and reachable, or set OPENCODE_BINARY to its full path.'
  );
}

const serveCommand = createServeCommand({
  serverPath: fileURLToPath(new URL('../server/index.js', import.meta.url)),
  checkOpenCodeCLI,
  getServerRuntimeBinary,
  setForegroundServerActive(value) { foregroundServerActive = value; },
  setForegroundShutdown(handler) { foregroundShutdown = handler; },
});

const lifecycleCommands = createLifecycleCommands({ serveCommand });

const tunnelCommand = createTunnelCommand({
  serveCommand,
  stopCommand: lifecycleCommands.stop,
  setCancelCleanup,
  boldText,
  ensureTunnelProfilesMigrated,
});

const connectUrlCommand = createConnectUrlCommand({
  serveCommand,
});

const updateCommand = createUpdateCommand({
  importFromFilePath,
  packageManagerPath: fileURLToPath(new URL('../server/lib/package-manager.js', import.meta.url)),
  serveCommand,
});

const commands = {
  serve: serveCommand,

  'connect-url': connectUrlCommand,

  stop: lifecycleCommands.stop,

  restart: lifecycleCommands.restart,

  status: statusCommand,

  schedule: scheduleCommand,

  session: sessionCommand,

  models: modelsCommand,

  projects: projectsCommand,

  logs: logsCommand,

  startup: startupCommand,

  update: updateCommand,

  tunnel: tunnelCommand,
};

function isCommandName(name: string): name is keyof typeof commands {
  return name in commands;
}

async function main() {
  const parsed = parseArgs();
  const { command, subcommand, tunnelAction, startupAction, scheduleAction, sessionAction, controlAction, options, removedFlagErrors, helpRequested, versionRequested } = parsed;
  activeCommandOptions = options;

  if (versionRequested) {
    if (isJsonMode(options)) {
      printJson({ version: PACKAGE_VERSION });
    } else {
      console.log(PACKAGE_VERSION);
    }
    return;
  }

  if (removedFlagErrors.length > 0) {
    if (isJsonMode(options)) {
      printJson({
        status: 'error',
        error: {
          message: removedFlagErrors[0],
          details: removedFlagErrors,
        },
      });
    } else {
      for (const error of removedFlagErrors) {
        console.error(`Error: ${error}`);
      }
    }
    process.exit(1);
  }

  if (helpRequested) {
    if (command === 'tunnel') {
      showTunnelHelp();
    } else if (command === 'startup') {
      showStartupHelp();
    } else if (command === 'connect-url') {
      showConnectUrlHelp();
    } else if (command === 'schedule') {
      await commands.schedule(options, 'help');
    } else if (command === 'session') {
      await commands.session(options, 'help');
    } else if (command === 'models') {
      await commands.models(options, 'help');
    } else if (command === 'projects') {
      await commands.projects(options, 'help');
    } else if (command === 'control') {
      showControlHelp();
    } else {
      showHelp();
    }
    return;
  }

  if (command === 'tunnel') {
    await commands.tunnel(options, subcommand, tunnelAction);
    return;
  }

  if (command === 'startup') {
    await commands.startup(options, startupAction);
    return;
  }

  if (command === 'schedule') {
    await commands.schedule(options, scheduleAction);
    return;
  }

  if (command === 'session') {
    await commands.session(options, sessionAction);
    return;
  }

  if (command === 'models') {
    await commands.models(options, 'show');
    return;
  }

  if (command === 'projects') {
    await commands.projects(options, 'list');
    return;
  }

  if (command === 'control') {
    if (controlAction !== 'help') {
      throw new TunnelCliError(`Unknown control command '${controlAction}'.`, EXIT_CODE.USAGE_ERROR);
    }
    showControlHelp();
    return;
  }

  if (!isCommandName(command) || !commands[command]) {
    const knownCommands = ['serve', 'stop', 'restart', 'status', 'schedule', 'session', 'models', 'projects', 'control', 'tunnel', 'startup', 'logs', 'update'];
    const suggestion = findClosestMatch(command, knownCommands);
    const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
    if (isJsonMode(options)) {
      printJson({
        status: 'error',
        error: {
          message: `Unknown command '${command}'.${hint}`,
        },
        messages: [{ level: 'info', code: 'USAGE_HELP', message: 'Use --help to see available commands' }],
      });
    } else {
      console.error(`Error: Unknown command '${command}'.${hint}`);
      console.error('Use --help to see available commands');
    }
    process.exit(EXIT_CODE.USAGE_ERROR);
  }

  await commands[command](options);
}

const isCliExecution = isModuleCliExecution(process.argv[1], new URL('./cli.js', import.meta.url).href, fs.realpathSync, 'openchamber')
  || isModuleCliExecution(process.argv[1], new URL('../../bin/cli.js', import.meta.url).href, fs.realpathSync);

if (isCliExecution) {
  let isHandlingSigint = false;
  process.on('SIGINT', () => {
    if (isHandlingSigint) {
      return;
    }
    if (foregroundServerActive) {
      if (foregroundShutdown !== null) {
        void foregroundShutdown('SIGINT');
      }
      return;
    }
    isHandlingSigint = true;
    (async () => {
      clackCancel('Operation cancelled.');
      if (onCancelCleanup) {
        try {
          await onCancelCleanup();
        } catch {
          void 0;
        } finally {
          setCancelCleanup(null);
        }
      }
      process.exit(130);
    })();
  });

  process.on('unhandledRejection', (reason, promise) => {
    if (isJsonMode(activeCommandOptions)) {
      printJson({
        status: 'error',
        error: {
          message: `Unhandled rejection: ${String(reason)}`,
        },
      });
    } else {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    }
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    if (isJsonMode(activeCommandOptions)) {
      printJson({
        status: 'error',
        error: {
          message: `Uncaught exception: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    } else {
      console.error('Uncaught Exception:', error);
    }
    process.exit(1);
  });

  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isJsonMode(activeCommandOptions)) {
      printJson({
        status: 'error',
        error: {
          message,
        },
      });
    } else if (process.stdout?.isTTY && !HAS_PLAIN_FLAG) {
      clackIntro(boldText('Error'));
      logStatus('error', message);
      clackOutro('failed');
    } else {
      console.error(`Error: ${message}`);
    }
    const exitCode = error instanceof TunnelCliError ? error.exitCode : EXIT_CODE.GENERAL_ERROR;
    process.exit(exitCode);
  });
}

export {
  main,
  commands,
  parseArgs,
  assertAuthenticatedNetworkExposure,
  resolveServeHost,
  hasUiPasswordConfigured,
  generateUiPassword,
  resolveServeUiPassword,
  shouldDisplayTunnelQr,
  isValidTunnelDoctorResponse,
  readDesktopLocalPortFromSettings,
  getPidFilePath,
  getInstanceFilePath,
  isProcessRunning,
  isOpenchamberProcessRunning,
  isOpenchamberCmdline,
  getOpenchamberProcessState,
  resolveTunnelProviders,
  fetchTunnelProvidersFromPort,
  fetchSystemInfoFromPort,
  discoverRunningInstances,
  discoverOpenChamberInstanceOnPort,
  discoverLifecycleInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
  ensureTunnelProfilesMigrated,
  resolveToken,
  redactProfileForOutput,
  redactProfilesForOutput,
  maskToken,
  findClosestMatch,
  generateCompletionScript,
  TunnelCliError,
  EXIT_CODE,
  warnIfUnsafeFilePermissions,
};
