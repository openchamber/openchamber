import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import {
  parseCommandTokens,
  optionNamesForCommand,
  isKnownCommand,
  TUNNEL_SUBCOMMAND_NAMES,
  STARTUP_SUBCOMMAND_NAMES,
} from './cli-commander.js';

const DEFAULT_PORT = 3000;
const DEFAULT_TAIL_LINES = 200;

// Removed flags report their own migration errors regardless of command and
// are stripped before commander parsing so they are not also reported as
// unknown options.
const REMOVED_FLAG_MESSAGES = new Map([
  ['try-cf-tunnel', () => '`--try-cf-tunnel` was removed. Use: openchamber tunnel start --provider cloudflare --mode quick'],
  ['tunnel-qr', () => '`--tunnel-qr` was removed. Use: openchamber tunnel start ... --qr'],
  ['tunnel-password-url', () => '`--tunnel-password-url` was removed. Use UI password auth directly after tunnel start.'],
  ['tunnel-provider', (name) => `\`--${name}\` was removed from top-level serve flow. Use: openchamber tunnel start ...`],
  ['tunnel-mode', (name) => `\`--${name}\` was removed from top-level serve flow. Use: openchamber tunnel start ...`],
  ['tunnel-config', (name) => `\`--${name}\` was removed from top-level serve flow. Use: openchamber tunnel start ...`],
  ['tunnel-token', (name) => `\`--${name}\` was removed from top-level serve flow. Use: openchamber tunnel start ...`],
  ['tunnel-hostname', (name) => `\`--${name}\` was removed from top-level serve flow. Use: openchamber tunnel start ...`],
  ['tunnel', (name) => `\`--${name}\` was removed from top-level serve flow. Use: openchamber tunnel start ...`],
]);

// Options whose missing values fail with a stable usage error. Commander specs
// declare every value as optional so it never exits on a missing argument;
// these flags are validated here with the historical messages.
const REQUIRED_VALUE_FLAGS = new Map([
  ['port', 'port'],
  ['p', 'port'],
  ['host', 'host'],
  ['server', 'server'],
  ['server-url', 'server'],
]);

function collectUnknownOptionErrors(command, unknownFlags) {
  const allowed = optionNamesForCommand(command);
  const knownCommand = isKnownCommand(command);
  const errors = [];
  for (const token of unknownFlags) {
    const display = token.split('=')[0];
    const name = display.replace(/^--?/, '');
    if (allowed.has(name)) continue;
    const suggestion = display.startsWith('--') && name.length >= 3
      ? findClosestMatch(name, [...allowed].filter((candidate) => candidate.length >= 3))
      : null;
    const hint = suggestion ? ` Did you mean '--${suggestion}'?` : '';
    const scope = knownCommand ? ` for command '${command}'` : '';
    errors.push(`Unknown option '${display}'${scope}.${hint}`);
  }
  return errors;
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findClosestMatch(input, candidates, maxDistance = 3) {
  if (typeof input !== 'string' || input.length === 0 || !Array.isArray(candidates)) {
    return null;
  }
  const normalized = input.toLowerCase();
  let bestCandidate = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(normalized, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }
  return bestDistance <= maxDistance ? bestCandidate : null;
}

function splitOptionToken(arg) {
  if (!arg.startsWith('-')) return null;
  if (arg.startsWith('--')) {
    const eqIndex = arg.indexOf('=');
    return {
      name: eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2),
      inlineValue: eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined,
      long: true,
    };
  }
  return {
    name: arg.slice(1),
    inlineValue: undefined,
    long: false,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const removedFlagErrors = [];
  const positional = [];
  const seenFlags = [];
  const commanderTokens = [];
  let helpRequested = false;
  let versionRequested = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const parsedToken = splitOptionToken(arg);
    if (!parsedToken) {
      positional.push(arg);
      commanderTokens.push(arg);
      continue;
    }

    const { name, inlineValue, long } = parsedToken;
    if (REMOVED_FLAG_MESSAGES.has(name)) {
      removedFlagErrors.push(REMOVED_FLAG_MESSAGES.get(name)(name));
      continue;
    }
    seenFlags.push({ name, flag: long ? `--${name}` : `-${name}`, long });

    if (name === 'help' || name === 'h') helpRequested = true;
    if (name === 'version' || name === 'v') versionRequested = true;

    if (REQUIRED_VALUE_FLAGS.has(name)) {
      const canonical = REQUIRED_VALUE_FLAGS.get(name);
      const next = args[i + 1];
      const negativePort = canonical === 'port' && typeof inlineValue !== 'string' && typeof next === 'string' && /^-\d+$/.test(next);
      const hasValue = (typeof inlineValue === 'string' && inlineValue.length > 0)
        || (typeof next === 'string' && !next.startsWith('-'));
      if (!hasValue && !negativePort) {
        throw new TunnelCliError(`Missing value for --${canonical}.`, EXIT_CODE.USAGE_ERROR);
      }
      if (negativePort) {
        commanderTokens.push(`--port=${next}`);
        i += 1;
        continue;
      }
    }

    commanderTokens.push(arg);
  }

  const command = positional[0] || 'serve';
  const commandExplicit = positional.length > 0;
  const subcommand = command === 'tunnel' ? (positional[1] || 'help') : null;
  const tunnelAction = command === 'tunnel' ? (positional[2] || null) : null;
  const startupAction = command === 'startup' ? (positional[1] || 'status') : null;
  const scheduleAction = command === 'schedule' ? (positional[1] || 'help') : null;
  const sessionAction = command === 'session' ? (positional[1] || 'help') : null;
  const controlAction = command === 'control' ? (positional[1] || 'help') : null;

  // Tunnel validates options against the resolved subcommand's flag pool
  // (for example `tunnel start`), not the union pool. Startup does the same
  // (only 'enable' consumes its command-specific flags).
  let optionCommandKey = command;
  if (command === 'tunnel' && TUNNEL_SUBCOMMAND_NAMES.includes(subcommand)) {
    optionCommandKey = `tunnel ${subcommand}`;
  } else if (command === 'startup' && STARTUP_SUBCOMMAND_NAMES.includes(startupAction)) {
    optionCommandKey = `startup ${startupAction}`;
  }

  const seen = (name) => seenFlags.some((entry) => entry.name === name);
  const asValue = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined);

  const { opts, unknownFlags } = parseCommandTokens(optionCommandKey, commanderTokens);
  removedFlagErrors.push(...collectUnknownOptionErrors(optionCommandKey, unknownFlags));

  const options = {
    port: DEFAULT_PORT,
    host: undefined,
    uiPassword: process.env.OPENCHAMBER_UI_PASSWORD || undefined,
    json: false,
    all: false,
    follow: true,
    lines: DEFAULT_TAIL_LINES,
    limit: undefined,
    provider: undefined,
    mode: undefined,
    profile: undefined,
    name: undefined,
    title: undefined,
    configPath: undefined,
    token: undefined,
    tokenFile: undefined,
    tokenStdin: false,
    hostname: undefined,
    server: undefined,
    connectTtl: undefined,
    sessionTtl: undefined,
    qr: false,
    explicitQr: false,
    force: false,
    showSecrets: false,
    dryRun: false,
    plain: false,
    quiet: false,
    explicitPort: false,
    explicitUiPassword: false,
    envSnapshot: true,
    foreground: false,
    lan: false,
    apiOnly: false,
    project: undefined,
    task: undefined,
    session: undefined,
    message: undefined,
    prompt: undefined,
    model: undefined,
    daily: undefined,
    weekly: undefined,
    once: undefined,
    time: undefined,
    cron: undefined,
    timezone: undefined,
    agent: undefined,
    variant: undefined,
    disabled: false,
    goal: false,
    goalTokenBudget: undefined,
    directory: undefined,
    role: undefined,
    last: false,
    wait: false,
    timeout: undefined,
    lastAssistant: false,
    withStatus: false,
  };

  if (seen('port') || seen('p')) {
    options.explicitPort = true;
    const raw = asValue(opts.port);
    if (raw === undefined) {
      throw new TunnelCliError('Missing value for --port.', EXIT_CODE.USAGE_ERROR);
    }
    if (!/^-?\d+$/.test(raw.trim())) {
      throw new TunnelCliError(`Invalid port value: ${raw}`, EXIT_CODE.USAGE_ERROR);
    }
    const parsed = parseInt(raw, 10);
    if (parsed < 1 || parsed > 65535) {
      throw new TunnelCliError(`Invalid port value: ${parsed}`, EXIT_CODE.USAGE_ERROR);
    }
    options.port = parsed;
  }

  if (seen('host')) {
    const value = typeof opts.host === 'string' ? opts.host.trim() : '';
    if (value.length === 0) {
      throw new TunnelCliError('Missing value for --host.', EXIT_CODE.USAGE_ERROR);
    }
    options.host = value;
  }

  if (seen('ui-password')) {
    options.explicitUiPassword = true;
    options.uiPassword = typeof opts.uiPassword === 'string' ? opts.uiPassword : '';
  }

  if (seen('server') || seen('server-url')) {
    const raw = asValue(opts.serverUrl) ?? asValue(opts.server);
    if (raw === undefined) {
      throw new TunnelCliError('Missing value for --server.', EXIT_CODE.USAGE_ERROR);
    }
    options.server = raw.trim();
  }

  options.provider = asValue(opts.provider);
  options.mode = asValue(opts.mode);
  options.profile = asValue(opts.profile);
  options.name = asValue(opts.name);
  options.title = asValue(opts.title);
  options.worktree = asValue(opts.worktree);
  options.branch = asValue(opts.branch);
  options.startRef = asValue(opts.startRef) ?? asValue(opts.base);
  if (seen('upstream')) options.setUpstream = true;
  else if (seen('no-upstream')) options.setUpstream = false;
  options.project = asValue(opts.project);
  options.directory = asValue(opts.directory) ?? asValue(opts.dir);
  options.task = asValue(opts.task);
  options.session = asValue(opts.session);
  options.message = asValue(opts.message);
  options.prompt = asValue(opts.prompt);
  options.model = asValue(opts.model);
  options.daily = asValue(opts.daily);
  options.weekly = asValue(opts.weekly);
  options.once = asValue(opts.once);
  options.time = asValue(opts.time);
  options.cron = asValue(opts.cron);
  options.timezone = asValue(opts.timezone);
  options.agent = asValue(opts.agent);
  options.variant = asValue(opts.variant);
  options.disabled = seen('disabled');
  options.goal = seen('goal');
  options.goalTokenBudget = asValue(opts.goalTokenBudget);
  options.configPath = seen('config')
    ? (typeof opts.config === 'string' ? opts.config : null)
    : undefined;
  options.token = asValue(opts.token);
  options.tokenFile = asValue(opts.tokenFile);
  options.tokenStdin = seen('token-stdin');
  options.hostname = asValue(opts.hostname);
  options.connectTtl = asValue(opts.connectTtl);
  options.sessionTtl = asValue(opts.sessionTtl);
  options.json = seen('json');
  options.all = seen('all');
  options.last = seen('last');
  options.lastAssistant = seen('last-assistant');
  options.wait = seen('wait');
  options.timeout = asValue(opts.timeout);
  options.withStatus = seen('with-status');
  options.role = asValue(opts.role);
  options.follow = !seen('no-follow');
  options.envSnapshot = !seen('no-env-snapshot');
  options.lan = seen('lan');
  options.foreground = seen('foreground') || seen('no-daemon') || seen('daemon') || seen('d');
  options.apiOnly = seen('api-only');
  options.relay = seen('relay');
  if (seen('qr')) {
    options.qr = true;
    options.explicitQr = true;
  } else if (seen('no-qr')) {
    options.qr = false;
    options.explicitQr = true;
  }
  options.force = seen('force');
  options.showSecrets = seen('show-secrets');
  options.dryRun = seen('dry-run');
  options.plain = seen('plain');
  options.quiet = seen('quiet') || seen('q');

  if (seen('lines')) {
    const parsed = parseInt(asValue(opts.lines) ?? '', 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      options.lines = parsed;
    }
  }

  if (seen('limit')) {
    const parsed = parseInt(asValue(opts.limit) ?? '', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new TunnelCliError('Invalid limit value. Provide a positive integer.', EXIT_CODE.USAGE_ERROR);
    }
    options.limit = parsed;
  }

  if (options.lan && typeof options.host !== 'string') {
    options.host = '0.0.0.0';
  }

  if (command !== 'tunnel' && typeof options.hostname === 'string' && typeof options.host !== 'string') {
    options.host = options.hostname;
  }

  return {
    command,
    commandExplicit,
    subcommand,
    tunnelAction,
    startupAction,
    scheduleAction,
    sessionAction,
    controlAction,
    options,
    removedFlagErrors,
    helpRequested,
    versionRequested,
  };
}

function showHelp() {
  console.log(`
 OpenChamber - Web interface for the OpenCode AI coding agent

USAGE:
  openchamber [COMMAND] [OPTIONS]

COMMANDS:
  serve          Start the web server (daemon default)
  stop           Stop running instance(s)
  restart        Stop and start the server
  status         Show server status
  schedule       Manage scheduled tasks
  session        Create, inspect, and read OpenChamber sessions
  models         Show default and favorite models
  projects       Show configured projects and IDs
  control        Show OpenChamber control-plane commands
  tunnel         Tunnel lifecycle commands
  startup        Manage launch at system startup
  logs           Tail OpenChamber logs
  connect-url    Generate URL/QR for connecting another client
  update         Check for and install updates

OPTIONS:
  -p, --port              Web server port (default: ${DEFAULT_PORT})
  --host                  Bind address (default: 127.0.0.1)
  --hostname              Alias for --host (serve, connect-url)
  --lan                   Bind to 0.0.0.0 for LAN access
  --server <url>          Public/server URL for connect-url links
  --relay                 connect-url: also include the end-to-end-encrypted relay transport
  --ui-password [password] Protect browser UI with a password (generates one when omitted)
  --api-only              Start API routes only, without serving browser UI assets
  --foreground            Run server in foreground (use with systemd/process managers)
  --no-daemon             Alias for --foreground
  -h, --help              Show help
  -v, --version           Show version

ENVIRONMENT:
  OPENCHAMBER_HOST             Bind address (e.g. 0.0.0.0 for all interfaces)
  OPENCHAMBER_UI_PASSWORD      Alternative to --ui-password flag
  OPENCHAMBER_API_ONLY         Set to true/1 to start API routes only
  OPENCHAMBER_DATA_DIR         Override OpenChamber data directory
  OPENCODE_HOST               External OpenCode server base URL, e.g. http://hostname:4096
  OPENCODE_PORT               Port of external OpenCode server to connect to
  OPENCODE_SKIP_START          Skip starting OpenCode, use external server
  OPENCHAMBER_OPENCODE_HOSTNAME  Bind hostname for managed OpenCode server (default: 127.0.0.1)

EXAMPLES:
  openchamber                    # Start in daemon mode on default port 3000 (or free port)
  openchamber --port 8080        # Start on port 8080 (daemon)
  openchamber --lan --port 3002  # Start on LAN at 0.0.0.0:3002
  openchamber serve --foreground # Start in foreground (for systemd Type=simple)
  openchamber connect-url --port 3000 --qr
  openchamber connect-url --server https://openchamber.example.com
  openchamber control           # Show control-plane commands for agents/scripts
  openchamber startup enable     # Start OpenChamber at user login
  openchamber tunnel help        # Show tunnel lifecycle help
  openchamber logs               # Follow logs for latest running instance
`);
}

function showServeHelp() {
  console.log(`
 OpenChamber Serve

USAGE:
  openchamber serve [OPTIONS]

OPTIONS:
  -p, --port <port>        Web server port (default: ${DEFAULT_PORT})
  --host <address>         Bind address (default: 127.0.0.1)
  --hostname <address>     Alias for --host
  --lan                    Bind to 0.0.0.0 for LAN access
  --ui-password [password] Protect browser UI with a password (generates one when omitted)
  --api-only               Start API routes only, without serving browser UI assets
  --foreground             Run server in foreground (use with systemd/process managers)
  --no-daemon              Alias for --foreground
  -q, --quiet              Print minimal output
  --json                   Output machine-readable JSON
  -h, --help               Show this help

ENVIRONMENT:
  OPENCHAMBER_HOST             Bind address (e.g. 0.0.0.0 for all interfaces)
  OPENCHAMBER_UI_PASSWORD      Alternative to --ui-password flag
  OPENCHAMBER_API_ONLY         Set to true/1 to start API routes only
  OPENCHAMBER_DATA_DIR         Override OpenChamber data directory

EXAMPLES:
  openchamber serve --port 8080
  openchamber serve --lan --ui-password
  openchamber serve --foreground
`);
}

function showStopHelp() {
  console.log(`
 OpenChamber Stop

USAGE:
  openchamber stop [-p <port>] [OPTIONS]

Stops discovered OpenChamber instances, or only the instance on --port.

OPTIONS:
  -p, --port <port>        Stop the instance on this port
  --host <address>         Host used for shutdown requests
  --json                   Output machine-readable JSON
  -q, --quiet              Print minimal output
  -h, --help               Show this help

EXAMPLES:
  openchamber stop
  openchamber stop --port 3000
`);
}

function showRestartHelp() {
  console.log(`
 OpenChamber Restart

USAGE:
  openchamber restart [-p <port>] [OPTIONS]

Restarts discovered instances, or only the instance on --port, reusing the
stored launch options (host, UI password, API-only mode).

OPTIONS:
  -p, --port <port>        Restart the instance on this port
  --host <address>         Host used for shutdown requests
  --ui-password <password> Override the stored UI password
  --api-only               Restart in headless/API-only mode
  --json                   Output machine-readable JSON
  -q, --quiet              Print minimal output
  -h, --help               Show this help

EXAMPLES:
  openchamber restart
  openchamber restart --port 3000
`);
}

function showStatusHelp() {
  console.log(`
 OpenChamber Status

USAGE:
  openchamber status [-p <port>] [OPTIONS]

OPTIONS:
  -p, --port <port>        Check the instance on this port
  --json                   Output machine-readable JSON
  -q, --quiet              Print minimal output
  -h, --help               Show this help

EXAMPLES:
  openchamber status
  openchamber status --port 3000 --json
`);
}

function showLogsHelp() {
  console.log(`
 OpenChamber Logs

USAGE:
  openchamber logs [-p <port>] [OPTIONS]

Tails recent log lines and follows output. Without --port, uses the most
recent running instance; --all follows every discovered instance.

OPTIONS:
  -p, --port <port>        Follow logs for the instance on this port
  --all                    Follow all discovered instances
  --lines <count>          Initial lines to show (default: ${DEFAULT_TAIL_LINES})
  --no-follow              Print recent lines and exit
  -q, --quiet              Prefix lines with the port only
  -h, --help               Show this help

EXAMPLES:
  openchamber logs
  openchamber logs --port 3000 --lines 50
  openchamber logs --all --no-follow
`);
}

function showUpdateHelp() {
  console.log(`
 OpenChamber Update

USAGE:
  openchamber update [OPTIONS]

Checks for and installs OpenChamber updates, then offers to restart.

OPTIONS:
  --json                   Output machine-readable JSON
  -q, --quiet              Print minimal output
  -h, --help               Show this help

EXAMPLES:
  openchamber update
  openchamber update --json
`);
}

// Control-plane commands listed by `openchamber control`. They run as
// top-level commands; `control` itself only supports `help`. Keep in sync
// with showControlHelp().
const CONTROL_COMMAND_NAMES = ['status', 'session', 'models', 'projects', 'schedule', 'tunnel', 'logs'];

function showControlHelp() {
  console.log(`
 OpenChamber Control Commands

 Index of commands for agents and scripts. They run directly at the top
 level, not under 'control'.

USAGE:
  openchamber control            Show this index
  openchamber <COMMAND> [OPTIONS]  Run a control-plane command

COMMANDS:
  status                         Show running OpenChamber runtimes
  session                        Create, inspect, and read sessions
  models                         Show default and favorite models
  projects                       Show configured projects and IDs
  schedule                       Manage scheduled tasks
  tunnel                         Inspect tunnel status/readiness
  logs                           Tail logs for CLI-managed runtimes

DETAILED HELP:
  openchamber session --help     Show session command options
  openchamber models --help      Show model defaults and favorites help
  openchamber projects --help    Show project list help
  openchamber schedule --help    Show scheduled task command options
  openchamber tunnel help        Show tunnel lifecycle/status commands
  openchamber status --help      Show runtime status options

COMMON OPTIONS:
  --json                         Output machine-readable JSON
  -q, --quiet                    Print minimal output
  -p, --port <port>              Target a specific OpenChamber runtime
  --ui-password <password>       Authenticate to a password-protected runtime

EXAMPLES:
  openchamber status
  openchamber models
  openchamber projects
  openchamber session --help
  openchamber schedule --help
`);
}

const STARTUP_OUTPUT_OPTIONS = `OUTPUT OPTIONS:
  --json                  Output machine-readable JSON
  -q, --quiet             Suppress non-essential output`;

const STARTUP_ACTION_HELP = {
  status: `OpenChamber Startup Status

USAGE:
  openchamber startup status [OPTIONS]

Shows whether the native user startup integration is installed and active.

${STARTUP_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber startup status
  openchamber startup status --json`,

  enable: `OpenChamber Startup Enable

USAGE:
  openchamber startup enable [OPTIONS]

Installs and starts the native user startup integration. The service runs
'openchamber serve --foreground' with the options below; a snapshot of the
current environment is saved into the service unless --no-env-snapshot.

OPTIONS:
  -p, --port <port>        Web server port used by the startup service
  --host <address>         Bind address used by the startup service
  --ui-password [password] Protect browser UI with a password (generates one when omitted)
  --api-only               Start API routes only, without serving browser UI assets
  --no-env-snapshot        Do not save current environment for the startup service

${STARTUP_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber startup enable
  openchamber startup enable --port 3000
  openchamber startup enable --port 3000 --api-only --host 0.0.0.0`,

  disable: `OpenChamber Startup Disable

USAGE:
  openchamber startup disable [OPTIONS]

Stops and removes the native user startup integration.

${STARTUP_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber startup disable`,
};

function showStartupHelp(action) {
  const focused = typeof action === 'string' && Object.prototype.hasOwnProperty.call(STARTUP_ACTION_HELP, action)
    ? STARTUP_ACTION_HELP[action]
    : null;
  if (focused) {
    console.log(`\n${focused}\n`);
    return;
  }
  console.log(`
 OpenChamber Startup Commands

USAGE:
  openchamber startup <command> [OPTIONS]

COMMANDS:
  status      Show startup integration status
  enable      Install and start native user startup integration
  disable     Stop and remove native user startup integration

FOCUSED HELP:
  openchamber startup <command> --help   Show options for one command

${STARTUP_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber startup enable --port 3000
  openchamber startup status --json
`);
}

function showConnectUrlHelp() {
  console.log(`
 OpenChamber Connect URL

USAGE:
  openchamber connect-url [OPTIONS]

DESCRIPTION:
  Generate an openchamber:// connection link for adding this server to another
  OpenChamber app. If no server is running on the selected port, it starts one.

OPTIONS:
  -p, --port <port>       Server port to use or start (default: ${DEFAULT_PORT})
  --host <address>        Bind address when starting the server
  --hostname <address>    Alias for --host
  --lan                   Bind to 0.0.0.0 for LAN access when starting
  --server <url>          Public URL saved into the connection link
  --server-url <url>      Alias for --server
  --relay                 Also include the end-to-end-encrypted relay transport
                          so the link works away from the local network. The
                          device prefers the direct connection when reachable;
                          the instance brings the relay up on its own. Set
                          OPENCHAMBER_RELAY_URL to use a self-hosted relay.
  --name <label>          Label saved with the remote client token
  --ui-password <value>   Protect browser access when UI routes are enabled
  --api-only              Start in headless/API-only mode when starting
  --qr                    Print a QR code for the connection link
  --json                  Output machine-readable JSON
  -q, --quiet             Print only the connection link
  -h, --help              Show this help

EXAMPLES:
  openchamber connect-url --port 3000 --qr
  openchamber connect-url --port 3000 --api-only --lan --server http://workstation.local:3000 --qr
  openchamber connect-url --server https://openchamber.example.com --name Workstation
  openchamber connect-url --relay --name "My laptop"
`);
}

const TUNNEL_OUTPUT_OPTIONS = `TARGETING/OUTPUT OPTIONS:
  -p, --port <port>       Target OpenChamber instance port
  --host <address>        Host for shutdown/request calls
  --ui-password <password> Authenticate to a password-protected runtime
  --json                  Output machine-readable JSON
  -q, --quiet             Suppress non-essential output
  --plain                 Disable colors and decorations`;

const TUNNEL_SUBCOMMAND_HELP = {
  providers: `OpenChamber Tunnel Providers

USAGE:
  openchamber tunnel providers [OPTIONS]

Lists available tunnel providers and their modes/capabilities.

${TUNNEL_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber tunnel providers
  openchamber tunnel providers --json`,

  ready: `OpenChamber Tunnel Ready

USAGE:
  openchamber tunnel ready [--provider <id>] [OPTIONS]

Checks tunnel readiness for a provider on the target instance.

OPTIONS:
  --provider <id>         Tunnel provider id (default: cloudflare)

${TUNNEL_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber tunnel ready --provider cloudflare`,

  status: `OpenChamber Tunnel Status

USAGE:
  openchamber tunnel status [OPTIONS]

Shows tunnel status for discovered instances.

${TUNNEL_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber tunnel status
  openchamber tunnel status --port 3000`,

  doctor: `OpenChamber Tunnel Doctor

USAGE:
  openchamber tunnel doctor [--provider <id>] [--all] [OPTIONS]
  openchamber tunnel doctor --mode managed-remote --token-file <path> --hostname <host> [OPTIONS]
  openchamber tunnel doctor --mode managed-local --config <path> [OPTIONS]

Runs deep tunnel diagnostics. Without credentials, checks the quick tunnel
path; managed mode flags let doctor validate a specific configuration.
--all checks every discovered instance (doctor default).

OPTIONS:
  --provider <id>         Tunnel provider id (default: cloudflare)
  --mode <id>             Tunnel mode (quick, managed-remote, managed-local)
  --profile <name>        Check credentials from a saved profile
  --token <token>         Managed-remote token (visible in process list)
  --token-file <path>     Read token from file (recommended)
  --token-stdin           Read token from stdin
  --hostname <hostname>   Managed-remote hostname
  --config <path>         Managed-local config path
  --all                   Apply to all running instances

${TUNNEL_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber tunnel doctor --provider cloudflare
  openchamber tunnel doctor --all`,

  start: `OpenChamber Tunnel Start

USAGE:
  openchamber tunnel start [OPTIONS]

Starts a tunnel on the target instance, auto-starting one when needed.
Starting a different mode/provider replaces the current tunnel and revokes
old connect links/sessions. Connect links are one-time.

OPTIONS:
  --provider <id>         Tunnel provider id (default: cloudflare)
  --mode <id>             Tunnel mode (default: quick)
  --profile <name>        Start tunnel from saved profile name
  --config [path]         Managed-local config path (optional)
  --token <token>         Managed-remote token (visible in process list)
  --token-file <path>     Read token from file (recommended)
  --token-stdin           Read token from stdin
  --hostname <hostname>   Managed-remote hostname
  --connect-ttl <value>   Connect-link TTL (e.g. 30m, 24h, 1d)
  --session-ttl <value>   Session TTL (e.g. 8h, 24h, 1d)
  --qr                    Print QR code for resulting tunnel URL
  --no-qr                 Disable QR output
  --dry-run               Validate inputs without applying changes
  --lan                   Bind to 0.0.0.0 when auto-starting an instance
  --api-only              Start API routes only when auto-starting an instance

${TUNNEL_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber tunnel start --qr
  openchamber tunnel start --profile prod-main
  openchamber tunnel start --provider cloudflare --mode managed-remote --token-file ~/.secrets/cf-token --hostname app.example.com
  openchamber tunnel start --dry-run --mode managed-local --config ~/.cloudflared/config.yml`,

  stop: `OpenChamber Tunnel Stop

USAGE:
  openchamber tunnel stop [--all] [--force] [OPTIONS]

Stops the active tunnel, keeping the server running.

OPTIONS:
  --all                   Apply to all running instances
  --force                 Skip confirmation for multiple instances

${TUNNEL_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber tunnel stop --port 3000
  openchamber tunnel stop --all`,

  profile: `OpenChamber Tunnel Profile

USAGE:
  openchamber tunnel profile <command> [OPTIONS]

COMMANDS:
  list        List saved managed-remote profiles
  show        Show one profile
  add         Add a profile
  remove      Remove a profile

OPTIONS:
  --name <name>           Profile name (list/show/add/remove)
  --provider <id>         Tunnel provider id (default: cloudflare)
  --mode <id>             Tunnel mode for add (managed-remote)
  --hostname <hostname>   Managed-remote hostname for add
  --token <token>         Managed-remote token (visible in process list)
  --token-file <path>     Read token from file (recommended)
  --token-stdin           Read token from stdin
  --force                 Overwrite an existing profile on add
  --dry-run               Validate add inputs without saving
  --show-secrets          Show full tokens in output (default: redacted)

${TUNNEL_OUTPUT_OPTIONS}

EXAMPLES:
  openchamber tunnel profile list --provider cloudflare
  openchamber tunnel profile show --name prod-main
  openchamber tunnel profile add --provider cloudflare --mode managed-remote --name prod-main --hostname app.example.com --token-file ~/.secrets/cf-token
  openchamber tunnel profile remove --name prod-main`,

  completion: `OpenChamber Tunnel Completion

USAGE:
  openchamber tunnel completion <shell>

Generates a shell completion script for the openchamber CLI.

EXAMPLES:
  openchamber tunnel completion bash
  openchamber tunnel completion zsh
  openchamber tunnel completion fish`,
};

function showTunnelHelp(subcommand) {
  const focused = typeof subcommand === 'string' && Object.prototype.hasOwnProperty.call(TUNNEL_SUBCOMMAND_HELP, subcommand)
    ? TUNNEL_SUBCOMMAND_HELP[subcommand]
    : null;
  if (focused) {
    console.log(`\n${focused}\n`);
    return;
  }
  console.log(`
 Tunnel Lifecycle Commands

USAGE:
  openchamber tunnel <command> [OPTIONS]

COMMANDS:
  help        Show this tunnel help
  providers   Show available tunnel providers and capabilities
  ready       Check tunnel readiness for a provider
  doctor      Run deep tunnel diagnostics
  status      Show tunnel status
  start       Start a tunnel
  stop        Stop active tunnel (keep server running)
  profile     Manage saved managed-remote profiles

FOCUSED HELP:
  openchamber tunnel <command> --help   Show options for one command

COMMON OPTIONS:
  -p, --port              Target OpenChamber instance port
  --host <address>        Host for shutdown/request calls
  --ui-password <password> Authenticate to a password-protected runtime
  --json                  Output machine-readable JSON
  -q, --quiet             Suppress non-essential output
  --plain                 Disable colors and decorations

BEHAVIOR NOTES:
  - One active tunnel per OpenChamber instance.
  - Starting a different mode/provider replaces the current tunnel and revokes old connect links/sessions.
  - Connect links are one-time; generating a new link revokes the previous unused link.
  - 'tunnel start' auto-starts an instance when needed (run 'openchamber tunnel start --help' for its options).

SHELL COMPLETION:
  openchamber tunnel completion bash   Generate Bash completion script
  openchamber tunnel completion zsh    Generate Zsh completion script
  openchamber tunnel completion fish   Generate Fish completion script

EXAMPLES:
  openchamber tunnel providers
  openchamber tunnel ready --provider cloudflare
  openchamber tunnel doctor --provider cloudflare
  openchamber tunnel status
  openchamber tunnel start --qr
  openchamber tunnel start --profile prod-main
  openchamber tunnel start --provider cloudflare --mode managed-remote --token-file ~/.secrets/cf-token --hostname app.example.com
  openchamber tunnel start --provider cloudflare --mode managed-local --config ~/.cloudflared/config.yml
  openchamber tunnel start --dry-run --provider cloudflare --mode managed-remote --token-file ~/.secrets/cf-token --hostname app.example.com
  echo "$TOKEN" | openchamber tunnel profile add --provider cloudflare --mode managed-remote --name prod-main --hostname app.example.com --token-stdin
  openchamber tunnel profile list --provider cloudflare
  openchamber tunnel profile list --json --show-secrets
  openchamber tunnel stop --port 3000
`);
}

function generateCompletionScript(shell) {
  const normalized = typeof shell === 'string' ? shell.trim().toLowerCase() : '';

  if (normalized === 'bash') {
    return `# Bash completion for openchamber tunnel
# Add to ~/.bashrc: eval "$(openchamber tunnel completion bash)"
_openchamber_tunnel() {
  local cur prev commands tunnel_commands profile_commands common_flags start_flags
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

    commands="serve stop restart status schedule session models projects tunnel logs update"
  tunnel_commands="help providers ready doctor status start stop profile completion"
  profile_commands="list show add remove"
  common_flags="--port --foreground --no-daemon --json --all --help --version --plain --quiet"
  start_flags="--provider --mode --profile --config --token --token-file --token-stdin --hostname --connect-ttl --session-ttl --qr --no-qr --dry-run --show-secrets"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  if [[ "\${COMP_WORDS[1]}" == "tunnel" ]]; then
    if [[ \${COMP_CWORD} -eq 2 ]]; then
      COMPREPLY=( $(compgen -W "\${tunnel_commands}" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "profile" && \${COMP_CWORD} -eq 3 ]]; then
      COMPREPLY=( $(compgen -W "\${profile_commands}" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "completion" && \${COMP_CWORD} -eq 3 ]]; then
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "start" ]]; then
      COMPREPLY=( $(compgen -W "\${start_flags} \${common_flags}" -- "\${cur}") )
      return 0
    fi
    COMPREPLY=( $(compgen -W "\${common_flags}" -- "\${cur}") )
    return 0
  fi

  COMPREPLY=( $(compgen -W "\${common_flags}" -- "\${cur}") )
  return 0
}
complete -F _openchamber_tunnel openchamber
`;
  }

  if (normalized === 'zsh') {
    return `#compdef openchamber
# Zsh completion for openchamber tunnel
# Add to ~/.zshrc: eval "$(openchamber tunnel completion zsh)"

_openchamber() {
  local -a commands tunnel_commands profile_commands

  commands=(
    'serve:Start the web server'
    'stop:Stop running instance(s)'
    'restart:Stop and start the server'
    'status:Show server status'
    'schedule:Manage scheduled tasks'
    'session:Create sessions'
    'models:Show default and favorite models'
    'projects:Show configured projects and IDs'
    'tunnel:Tunnel lifecycle commands'
    'logs:Tail OpenChamber logs'
    'update:Check for and install updates'
  )

  tunnel_commands=(
    'help:Show tunnel help'
    'providers:Show available providers'
    'ready:Check tunnel readiness'
    'doctor:Run tunnel diagnostics'
    'status:Show tunnel status'
    'start:Start a tunnel'
    'stop:Stop active tunnel'
    'profile:Manage saved profiles'
    'completion:Generate shell completion'
  )

  profile_commands=(
    'list:List profiles'
    'show:Show profile details'
    'add:Add a profile'
    'remove:Remove a profile'
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case \$state in
    command)
      _describe 'command' commands
      ;;
    args)
      case \$words[1] in
        tunnel)
          if (( CURRENT == 2 )); then
            _describe 'tunnel command' tunnel_commands
          elif [[ \$words[2] == "profile" ]] && (( CURRENT == 3 )); then
            _describe 'profile action' profile_commands
          elif [[ \$words[2] == "completion" ]] && (( CURRENT == 3 )); then
            _values 'shell' bash zsh fish
          fi
          ;;
      esac
      ;;
  esac
}

compdef _openchamber openchamber
`;
  }

  if (normalized === 'fish') {
    return `# Fish completion for openchamber tunnel
# Save to ~/.config/fish/completions/openchamber.fish

complete -c openchamber -n '__fish_use_subcommand' -a 'serve' -d 'Start the web server'
complete -c openchamber -n '__fish_seen_subcommand_from serve' -l foreground -d 'Run in foreground (for systemd/process managers)'
complete -c openchamber -n '__fish_seen_subcommand_from serve' -l no-daemon -d 'Run in foreground (alias for --foreground)'
complete -c openchamber -n '__fish_use_subcommand' -a 'stop' -d 'Stop running instance(s)'
complete -c openchamber -n '__fish_use_subcommand' -a 'restart' -d 'Stop and start the server'
complete -c openchamber -n '__fish_use_subcommand' -a 'status' -d 'Show server status'
complete -c openchamber -n '__fish_use_subcommand' -a 'tunnel' -d 'Tunnel lifecycle commands'
complete -c openchamber -n '__fish_use_subcommand' -a 'logs' -d 'Tail logs'
complete -c openchamber -n '__fish_use_subcommand' -a 'update' -d 'Check for updates'

complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'help' -d 'Show tunnel help'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'providers' -d 'Show providers'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'ready' -d 'Check readiness'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'doctor' -d 'Run diagnostics'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'status' -d 'Show tunnel status'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'start' -d 'Start a tunnel'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'stop' -d 'Stop tunnel'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'profile' -d 'Manage profiles'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'completion' -d 'Generate completions'

complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l provider -d 'Provider id'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l mode -d 'Tunnel mode'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l profile -d 'Profile name'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l config -d 'Config path'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token -d 'Token'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token-file -d 'Token file path'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token-stdin -d 'Read token from stdin'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l hostname -d 'Hostname'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l dry-run -d 'Validate without applying'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l qr -d 'Show QR code'
`;
  }

  return null;
}


export {
  DEFAULT_PORT,
  parseArgs,
  showHelp,
  showServeHelp,
  showStopHelp,
  showRestartHelp,
  showStatusHelp,
  showLogsHelp,
  showUpdateHelp,
  showControlHelp,
  CONTROL_COMMAND_NAMES,
  showStartupHelp,
  showConnectUrlHelp,
  showTunnelHelp,
  generateCompletionScript,
  findClosestMatch,
};
