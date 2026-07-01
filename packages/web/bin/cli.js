#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { isModuleCliExecution } from './cli-entry.js';
import { EXIT_CODE, TunnelCliError } from './lib/cli-errors.js';
import {
  resolveServeHost,
  hasUiPasswordConfigured,
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
  showStartupHelp,
  showConnectUrlHelp,
  showTunnelHelp,
  showResourceHelp,
  generateCompletionScript,
  findClosestMatch,
} from './lib/cli-args.js';
import { sessionCommand } from './lib/commands-session.js';
import {
  agentCommand,
  commandResourceCommand,
  skillCommand,
  mcpCommand,
  snippetCommand,
  providerCommand,
  projectCommand,
  configCommand,
} from './lib/commands-resources.js';
import { scheduleCommand } from './lib/commands-schedule.js';
import { readDesktopLocalPortFromSettings } from './lib/cli-paths.js';
import { resolveExplicitBinary, searchPathFor } from './lib/cli-executables.js';
import { startupCommand } from './lib/commands-startup.js';
import { logsCommand } from './lib/commands-logs.js';
import { statusCommand } from './lib/commands-status.js';
import { createUpdateCommand } from './lib/commands-update.js';
import { createConnectUrlCommand } from './lib/commands-connect-url.js';
import { createLifecycleCommands } from './lib/commands-lifecycle.js';
import { createServeCommand } from './lib/commands-serve.js';
import { createTunnelCommand, isValidTunnelDoctorResponse, shouldDisplayTunnelQr } from './lib/commands-tunnel.js';
import {
  resolveDoctorPortStatuses,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

let onCancelCleanup = null;
let activeCommandOptions = null;
let foregroundServerActive = false;
let foregroundShutdown = null;

function setCancelCleanup(handler) {
  onCancelCleanup = typeof handler === 'function' ? handler : null;
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

function boldText(text) {
  if (!STYLE_ENABLED) return text;
  return `${ANSI.bold}${text}${ANSI.unbold}`;
}

function importFromFilePath(filePath) {
  return import(pathToFileURL(filePath).href);
}

function getBunBinary() {
  if (typeof process.env.BUN_BINARY === 'string' && process.env.BUN_BINARY.trim().length > 0) {
    return process.env.BUN_BINARY.trim();
  }
  if (typeof process.env.BUN_INSTALL === 'string' && process.env.BUN_INSTALL.trim().length > 0) {
    return path.join(process.env.BUN_INSTALL.trim(), 'bin', 'bun');
  }
  return 'bun';
}

const BUN_BIN = getBunBinary();

function isBunRuntime() {
  return typeof globalThis.Bun !== 'undefined';
}

function isBunInstalled() {
  try {
    const result = spawnSync(BUN_BIN, ['--version'], {
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getPreferredServerRuntime() {
  return isBunInstalled() ? 'bun' : 'node';
}

async function checkOpenCodeCLI(onNotice) {
  if (process.env.OPENCODE_BINARY) {
    const override = resolveExplicitBinary(process.env.OPENCODE_BINARY);
    if (override) {
      process.env.OPENCODE_BINARY = override;
      return override;
    }
    const message = `OPENCODE_BINARY="${process.env.OPENCODE_BINARY}" is not an executable file. Falling back to PATH lookup.`;
    if (typeof onNotice === 'function') {
      onNotice({ level: 'warning', code: 'OPENCODE_BINARY_INVALID', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }

  const resolvedFromPath = searchPathFor('opencode');
  if (resolvedFromPath) {
    process.env.OPENCODE_BINARY = resolvedFromPath;
    return resolvedFromPath;
  }

  throw new Error(
    `Unable to locate the opencode CLI on PATH (${process.env.PATH || '<empty>'}). ` +
    'Ensure the CLI is installed and reachable, or set OPENCODE_BINARY to its full path.'
  );
}

const commands = {
  serve: null,

  'connect-url': null,

  stop: null,

  restart: null,

  status: statusCommand,


  logs: logsCommand,

  startup: startupCommand,

  update: null,
};

commands.serve = createServeCommand({
  serverPath: path.join(__dirname, '..', 'server', 'index.js'),
  bunBin: BUN_BIN,
  checkOpenCodeCLI,
  getPreferredServerRuntime,
  setForegroundServerActive(value) { foregroundServerActive = value; },
  setForegroundShutdown(handler) { foregroundShutdown = handler; },
});

{
  const lifecycleCommands = createLifecycleCommands({ serveCommand: commands.serve.bind(commands) });
  commands.stop = lifecycleCommands.stop;
  commands.restart = lifecycleCommands.restart;
}

commands.tunnel = createTunnelCommand({
  serveCommand: commands.serve.bind(commands),
  stopCommand: commands.stop.bind(commands),
  setCancelCleanup,
  boldText,
  ensureTunnelProfilesMigrated,
});

commands['connect-url'] = createConnectUrlCommand({
  serveCommand: commands.serve.bind(commands),
});

commands.update = createUpdateCommand({
  importFromFilePath,
  packageManagerPath: path.join(__dirname, '..', 'server', 'lib', 'package-manager.js'),
  serveCommand: commands.serve.bind(commands),
});

// Resource commands talk to a running instance over HTTP and mirror the
// app's menu functions. They take (options, action, args) instead of just
// (options), so they are dispatched separately from the lifecycle commands.
const RESOURCE_COMMANDS = {
  session: sessionCommand,
  agent: agentCommand,
  command: commandResourceCommand,
  skill: skillCommand,
  mcp: mcpCommand,
  snippet: snippetCommand,
  provider: providerCommand,
  project: projectCommand,
  schedule: scheduleCommand,
  config: configCommand,
};

async function main() {
  const parsed = parseArgs();
  const { command, subcommand, tunnelAction, startupAction, positionals, options, removedFlagErrors, helpRequested, versionRequested } = parsed;
  activeCommandOptions = options;

  if (versionRequested) {
    if (isJsonMode(options)) {
      printJson({ version: PACKAGE_JSON.version });
    } else {
      console.log(PACKAGE_JSON.version);
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
    } else if (RESOURCE_COMMANDS[command]) {
      showResourceHelp(command);
    } else {
      showHelp();
    }
    return;
  }

  if (RESOURCE_COMMANDS[command]) {
    const action = positionals[1];
    const args = positionals.slice(2);
    await RESOURCE_COMMANDS[command](options, action, args);
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

  if (!commands[command]) {
    const knownCommands = [
      'serve', 'stop', 'restart', 'status', 'tunnel', 'startup', 'logs', 'update',
      'session', 'agent', 'command', 'skill', 'mcp', 'snippet', 'provider', 'project', 'schedule', 'config',
    ];
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

const isCliExecution = isModuleCliExecution(process.argv[1], import.meta.url, fs.realpathSync, 'openchamber');

if (isCliExecution) {
  // Exit cleanly when a downstream consumer closes the pipe (e.g. `| head`).
  // Without this, writes to a closed stdout throw EPIPE and surface as an
  // uncaught exception with a stack trace.
  process.stdout.on('error', (error) => {
    if (error && error.code === 'EPIPE') {
      process.exit(0);
    }
  });
  process.stderr.on('error', () => {});

  let isHandlingSigint = false;
  process.on('SIGINT', () => {
    if (isHandlingSigint) {
      return;
    }
    if (foregroundServerActive) {
      if (typeof foregroundShutdown === 'function') {
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
  commands,
  parseArgs,
  assertAuthenticatedNetworkExposure,
  resolveServeHost,
  hasUiPasswordConfigured,
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
