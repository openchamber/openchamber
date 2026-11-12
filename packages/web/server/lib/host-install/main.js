#!/usr/bin/env node
// Command line of the host installer and of the root updater unit.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { install, rollback, status, uninstall, update } from './host.js';
import { ROOT_COMMANDS, rootCommand } from './root-commands.js';
import { askNewPassword } from './tty-password.js';

const USAGE = `Usage: main.js <command> [options]

Commands (as root, except status):
  install      Install or reinstall OpenChamber for an account, with its units
  update       Install the newest release when it is newer than the running one
  rollback     Run the previous version again
  uninstall    Remove it; the env file and protected MCP credentials stay unless --purge
  status       Show what is installed and running
  approve-root-passkey, root-passkeys, revoke-root-passkey <id>
  share-project <path>, unshare-project <path>, repair-permissions
  backup-prepare --into <dir>, rotate-agent-token, setup-agent-docker, setup-front-docker

Options for install (left out: the value from the earlier install):
  --owner <account>        Human account that owns the projects
  --separation            Enable separate front-door and agent accounts
  --no-separation         Keep one account on a fresh install
  --agent-user <account>  Agent account (default <owner>-agent)
  --agent-port <port>      Agent loopback port (default 41890)
  --dry-run               Print migration without changing the host
  --repo <owner/name>      GitHub repository whose releases are installed
  --port <port>            Port OpenChamber listens on (default 3000)
  --host <address>         Address it listens on (default 127.0.0.1)
  --no-auto-update         Do not check for updates daily
  --no-protected-mcp       Do not install the protected MCP service
  --accept-unprotected     Install the protected MCP service even when the owner can reach root
  --tarball <file>         Install this verified package instead of downloading (with --version)
  --version <version>      Version of --tarball
  --ui-password-stdin      Read a new UI password from stdin; without it, a terminal asks for one
                           when OpenChamber has none (never with curl | bash, whose stdin is the script)

Common options:
  --json                   Print the result as JSON
  --quiet                  Print compact results without progress
  --confirm <fingerprint>  Confirm a proved, waiting root passkey without a TTY
  --purge --purge-accounts Remove the separate accounts and their homes
`;

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const flags = new Set();
  let argument;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) {
      if (argument || !['share-project', 'unshare-project', 'revoke-root-passkey'].includes(command)) throw Object.assign(new Error(`Unexpected argument ${arg}`), { code: 'usage' });
      argument = arg;
      continue;
    }
    const name = arg.slice(2);
    if (['json', 'quiet', 'separation', 'no-separation', 'dry-run', 'purge-accounts', 'no-auto-update', 'no-protected-mcp', 'accept-unprotected', 'purge', 'help', 'ui-password-stdin'].includes(name)) {
      flags.add(name);
      continue;
    }
    if (!['owner', 'repo', 'port', 'host', 'tarball', 'version', 'agent-user', 'agent-port', 'into', 'confirm'].includes(name) || rest[index + 1] === undefined || rest[index + 1].startsWith('--')) {
      throw Object.assign(new Error(`Unknown option ${arg}`), { code: 'usage' });
    }
    options[name] = rest[index + 1];
    index += 1;
  }
  if (flags.has('separation') && flags.has('no-separation')) throw Object.assign(new Error('Choose --separation or --no-separation'), { code: 'usage' });
  if (['share-project', 'unshare-project', 'revoke-root-passkey'].includes(command) && !argument) throw Object.assign(new Error('A path or passkey ID is required'), { code: 'usage' });
  return { command, options, flags, argument };
}

const readAll = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

export async function cli(argv, { out = process.stdout, err = process.stderr, input = process.stdin, askPassword = askNewPassword, commands = { install, update, rollback, uninstall, status, rootCommand } } = {}) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    if (argv.includes('--json')) out.write(`${JSON.stringify({ ok: false, code: 'usage', error: error.message })}\n`);
    else err.write(`${error.message}\n\n${USAGE}`);
    return 64;
  }
  const { command, options, flags, argument } = parsed;
  if (!command || command === '--help' || flags.has('help')) {
    out.write(USAGE);
    return 0;
  }
  const json = flags.has('json');
  const say = json || flags.has('quiet') ? () => {} : (text) => out.write(`${text}\n`);
  const run = {
    install: () => commands.install({
      say,
      owner: options.owner,
      repo: options.repo,
      port: options.port === undefined ? undefined : Number(options.port),
      host: options.host,
      autoUpdate: flags.has('no-auto-update') ? false : undefined,
      protectedMcp: flags.has('no-protected-mcp') ? false : undefined,
      acceptUnprotected: flags.has('accept-unprotected') ? true : undefined,
      tarball: options.tarball ?? null,
      version: options.version ?? null,
      separation: flags.has('separation') ? true : flags.has('no-separation') ? false : undefined,
      agentUser: options['agent-user'],
      agentPort: options['agent-port'] === undefined ? undefined : Number(options['agent-port']),
      dryRun: flags.has('dry-run'),
      readUiPassword: async () => {
        if (flags.has('ui-password-stdin')) return readAll(input);
        return json || flags.has('quiet') ? null : askPassword();
      },
    }),
    update: () => commands.update({ say, tarball: options.tarball ?? null, version: options.version ?? null }),
    rollback: () => commands.rollback({ say }),
    uninstall: () => commands.uninstall({ say, purge: flags.has('purge'), purgeAccounts: flags.has('purge-accounts') }),
    status: () => commands.status({}),
  }[command] ?? (ROOT_COMMANDS.includes(command) ? async () => {
    if (command === 'approve-root-passkey' && !options.confirm && (json || flags.has('quiet'))) throw Object.assign(new Error('Use --confirm <fingerprint> in JSON or quiet mode'), { code: 'confirmation_required' });
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Approval cancelled'));
    process.once('SIGINT', cancel);
    try { return await commands.rootCommand(command, { say, argument, into: options.into, confirm: options.confirm, input, output: out, signal: controller.signal }); }
    finally { process.off('SIGINT', cancel); }
  } : null);
  if (!run) {
    if (json) out.write(`${JSON.stringify({ ok: false, code: 'usage', error: `Unknown command ${command}` })}\n`);
    else err.write(`Unknown command ${command}\n\n${USAGE}`);
    return 64;
  }
  try {
    const result = await run();
    if (json) out.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    else if (command === 'status') out.write(formatStatus(result));
    else if (ROOT_COMMANDS.includes(command) || flags.has('quiet')) out.write(`${JSON.stringify(result)}\n`);
    return result?.protectedMcp?.status === 'failed' ? 2 : 0;
  } catch (error) {
    if (json) out.write(`${JSON.stringify({ ok: false, code: error.code ?? 'failed', error: error.message })}\n`);
    else err.write(`error: ${error.message}\n`);
    return error.code === 'root_required' ? 77 : 1;
  }
}

function formatStatus(result) {
  if (!result.installed) return 'OpenChamber is not installed on this host.\n';
  const { config, current, previous, units } = result;
  return [
    `version     ${current ?? 'none'}${previous ? ` (previous ${previous})` : ''}`,
    `owner       ${config.owner}`,
    `repository  ${config.repo}`,
    `listen      ${config.host}:${config.port}`,
    `auto update ${config.autoUpdate ? 'daily' : 'off'}`,
    `protected   ${config.protectedMcp ? 'on' : 'off'}`,
    ...Object.entries(units).map(([name, state]) => `${name.padEnd(30)} ${state}`),
    '',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await fs.realpath(process.argv[1])) {
  // Three accounts read the installed tree and /etc/openchamber. A root umask such as 027 or 077
  // would narrow what npm and mkdir create below the modes asked for; this only stops that.
  process.umask(0o022);
  process.exitCode = await cli(process.argv.slice(2));
}
