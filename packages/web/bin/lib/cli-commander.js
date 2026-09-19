/**
 * Commander-backed option definitions for the OpenChamber CLI.
 *
 * Single source of truth for which flags each command accepts. cli-args.js
 * consumes parseCommandTokens() for value extraction and unknown-flag
 * detection; value transforms and usage errors stay in cli-args.js.
 *
 * All value-taking options are declared with optional `[value]` syntax so
 * commander never exits for a missing argument: required-value semantics for
 * --port/--host/--server are enforced by cli-args.js with stable messages.
 */

import { Command } from 'commander';
import { TunnelCliError, EXIT_CODE } from './cli-errors.js';

const META_OPTION_NAMES = ['help', 'h', 'version', 'v'];

const GLOBAL_OPTION_FLAGS = [
  '-p, --port [port]',
  '--host [address]',
  '--ui-password [password]',
  '--json',
  '-q, --quiet',
  '--plain',
];

const COMMAND_OPTION_FLAGS = {
  serve: ['--lan', '--hostname [address]', '--api-only', '--foreground', '--no-daemon', '-d, --daemon'],
  stop: [],
  restart: ['--api-only'],
  status: [],
  logs: ['--all', '--lines [count]', '--no-follow'],
  schedule: [
    '--project [id]', '--task [taskId]', '--name [name]', '--prompt [text]',
    '--model [model]', '--agent [id]', '--variant [id]', '--daily [HH:mm]',
    '--weekly [days]', '--once [date]', '--time [HH:mm]', '--cron [expr]',
    '--timezone [zone]', '--disabled', '--goal', '--goal-token-budget [n]',
    '--dir [path]', '--directory [path]',
  ],
  session: [
    '--name [title]', '--title [title]', '--prompt [text]', '--model [model]',
    '--agent [id]', '--variant [id]', '--worktree [name]', '--branch [name]',
    '--start-ref [ref]', '--base [ref]', '--upstream', '--no-upstream',
    '--project [id]', '--dir [path]', '--directory [path]', '--session [id]',
    '--message [id]', '--last', '--last-assistant', '--wait',
    '--timeout [seconds]', '--with-status', '--limit [count]', '--role [role]',
    '--all', '--goal', '--goal-token-budget [n]',
  ],
  models: [],
  projects: [],
  control: [],
  tunnel: [
    '--lan', '--api-only', '--all', '--provider [id]', '--mode [id]',
    '--profile [name]', '--name [name]', '--config [path]', '--token [token]',
    '--token-file [path]', '--token-stdin', '--hostname [hostname]',
    '--connect-ttl [value]', '--session-ttl [value]', '--qr', '--no-qr',
    '--dry-run', '--force', '--show-secrets',
  ],
  startup: ['--api-only', '--no-env-snapshot'],  'connect-url': [
    '--lan', '--hostname [address]', '--server [url]', '--server-url [url]',
    '--relay', '--name [label]', '--qr', '--api-only',
  ],
  update: [],
  // Tunnel validates flags per subcommand. The base 'tunnel' key is the
  // union pool used for `tunnel help` and unknown subcommands.
  tunnel: [
    '--lan', '--api-only', '--all', '--provider [id]', '--mode [id]',
    '--profile [name]', '--name [name]', '--config [path]', '--token [token]',
    '--token-file [path]', '--token-stdin', '--hostname [hostname]',
    '--connect-ttl [value]', '--session-ttl [value]', '--qr', '--no-qr',
    '--dry-run', '--force', '--show-secrets',
  ],
  'tunnel providers': [],
  'tunnel ready': ['--provider [id]'],
  'tunnel status': [],
  'tunnel doctor': [
    '--provider [id]', '--mode [id]', '--profile [name]', '--token [token]',
    '--token-file [path]', '--token-stdin', '--hostname [hostname]',
    '--config [path]', '--all',
  ],
  'tunnel start': [
    '--provider [id]', '--mode [id]', '--profile [name]', '--config [path]',
    '--token [token]', '--token-file [path]', '--token-stdin',
    '--hostname [hostname]', '--connect-ttl [value]', '--session-ttl [value]',
    '--qr', '--no-qr', '--dry-run', '--lan', '--api-only',
  ],
  'tunnel stop': ['--all', '--force'],
  'tunnel profile': [
    '--name [name]', '--provider [id]', '--mode [id]',
    '--hostname [hostname]', '--token [token]', '--token-file [path]',
    '--token-stdin', '--force', '--show-secrets', '--dry-run',
  ],
  'tunnel completion': [],
  // Startup validates flags per command; only 'enable' consumes these.
  // The base 'startup' key is the union pool used for `startup --help`.
  'startup status': [],
  'startup enable': ['--api-only', '--no-env-snapshot'],
  'startup disable': [],
};

// Tunnel subcommands with dedicated flag pools ('help' falls back to the
// base 'tunnel' union pool).
const TUNNEL_SUBCOMMAND_NAMES = [
  'providers', 'ready', 'status', 'doctor', 'start', 'stop', 'profile', 'completion',
];

// Startup subcommands with dedicated flag pools.
const STARTUP_SUBCOMMAND_NAMES = ['status', 'enable', 'disable'];

const definedNamesByCommand = new Map();

function optionNamesForCommand(command) {
  if (definedNamesByCommand.has(command)) {
    return definedNamesByCommand.get(command);
  }
  const cmd = new Command(String(command)).exitOverride();
  for (const flags of [...GLOBAL_OPTION_FLAGS, ...(COMMAND_OPTION_FLAGS[command] ?? [])]) {
    cmd.option(flags);
  }
  const names = new Set(META_OPTION_NAMES);
  for (const option of cmd.options) {
    if (option.long) names.add(option.long.replace(/^--/, ''));
    if (option.short) names.add(option.short.replace(/^-/, ''));
  }
  definedNamesByCommand.set(command, names);
  return names;
}

function isKnownCommand(command) {
  return Object.prototype.hasOwnProperty.call(COMMAND_OPTION_FLAGS, command);
}

function parseCommandTokens(command, tokens) {
  const cmd = new Command(String(command)).exitOverride();
  for (const flags of [...GLOBAL_OPTION_FLAGS, ...(COMMAND_OPTION_FLAGS[command] ?? [])]) {
    cmd.option(flags);
  }
  let result;
  try {
    result = cmd.parseOptions(tokens);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TunnelCliError(message, EXIT_CODE.USAGE_ERROR);
  }
  const unknownFlags = (result.unknown ?? []).filter((token) => token.startsWith('-'));
  return { opts: cmd.opts(), unknownFlags };
}

export {
  parseCommandTokens,
  optionNamesForCommand,
  isKnownCommand,
  TUNNEL_SUBCOMMAND_NAMES,
  STARTUP_SUBCOMMAND_NAMES,
};
