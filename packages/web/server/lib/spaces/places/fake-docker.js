// Test support. A fake command runner that answers like the docker CLI for the
// few subcommands the Docker place uses, and records every call.

import { SpaceError } from '../errors.js';
import { GATEKEEPER_PROGRAM_PATH, IMAGE_CAT, IMAGE_CURL, IMAGE_SH, SPACE_HOME, SPACE_TOKEN_PATH, TOOLS_MOUNT_PATH } from '../layout.js';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const failed = (stderr, stdout = '') => ({ code: 1, stdout, stderr });

const NOT_FOUND_TEXT = {
  container: (name) => `Error response from daemon: No such container: ${name}`,
  network: (name) => `Error response from daemon: network ${name} not found`,
  volume: (name) => `Error response from daemon: get ${name}: no such volume`,
  image: (name) => `Error response from daemon: No such image: ${name}`,
};

const ISOLATED_GATEWAY_OPTION = 'com.docker.network.bridge.gateway_mode_ipv4';

const readPairs = (args, flag) => {
  const pairs = {};
  args.forEach((arg, index) => {
    if (arg === flag) {
      const pair = args[index + 1];
      pairs[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
    }
  });
  return pairs;
};

const readFlag = (args, flag) => args[args.indexOf(flag) + 1];

let nextContainerId = 1;
// Like a real id: hex, and never equal to a container name.
const newContainerId = () => (nextContainerId++).toString(16).padStart(64, 'f');

const volumeMountEntry = ({ volume, destination, readOnly = false }) => ({
  Type: 'volume',
  Name: volume,
  Source: `/var/lib/docker/volumes/${volume}/_data`,
  Destination: destination,
  RW: !readOnly,
});

/**
 * A `docker inspect` entry for a container that matches the requested hardening.
 * `volumes` are the volumes of the space, `toolsVolume` is mounted read-only at the tools path.
 * `mounts`, as `{ volume, destination, readOnly }`, replaces both when the test needs exact destinations.
 * `aliases` are the network aliases on `network`, as a gatekeeper has.
 */
export function hardenedContainerEntry({
  name,
  labels,
  network,
  volumes = [],
  toolsVolume = null,
  mounts = null,
  env = ['HOME=/home/space'],
  running = true,
  memoryBytes = 4294967296,
  tmpfs = '/tmp:rw,exec,nosuid,size=256m',
  aliases = [],
}) {
  const mountList = mounts ?? [
    ...volumes.map((volume) => ({ volume, destination: `/mnt/${volume}` })),
    ...(toolsVolume ? [{ volume: toolsVolume, destination: TOOLS_MOUNT_PATH, readOnly: true }] : []),
  ];
  const [tmpfsPath, tmpfsOptions] = String(tmpfs).split(':');
  return {
    Id: newContainerId(),
    Name: `/${name}`,
    State: { Running: running, Status: running ? 'running' : 'created' },
    Config: { User: '1000:1000', Labels: labels, Env: env },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: null,
      SecurityOpt: ['no-new-privileges'],
      Init: true,
      PidsLimit: 512,
      Memory: memoryBytes,
      MemorySwap: memoryBytes,
      ShmSize: 67108864,
      LogConfig: { Type: 'local', Config: { compress: 'false', 'max-file': '1', 'max-size': '10m' } },
      Tmpfs: { [tmpfsPath]: tmpfsOptions },
      Binds: null,
      VolumesFrom: null,
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
      UsernsMode: '',
      CgroupnsMode: 'private',
      NetworkMode: network,
      Runtime: 'runc',
      Devices: [],
      PortBindings: {},
    },
    Mounts: mountList.map(volumeMountEntry),
    // Like the real engine once the container runs: an address on its network. The fake gives it
    // from the start, and the place's tests hold it to reading the address after the start.
    NetworkSettings: { Networks: { [network]: { IPAddress: '172.19.0.2', ...(aliases.length > 0 ? { Aliases: aliases } : {}) } } },
  };
}

/** A `docker network inspect` entry for an internal network with no address on the host. */
export const internalNetworkEntry = ({ name, labels, options = { [ISOLATED_GATEWAY_OPTION]: 'isolated' } }) => ({
  Name: name,
  Internal: true,
  EnableIPv6: false,
  // Like the real engine: no gateway address in isolated mode.
  IPAM: { Config: [options[ISOLATED_GATEWAY_OPTION] === 'isolated' ? { Subnet: '172.19.0.0/16' } : { Subnet: '172.19.0.0/16', Gateway: '172.19.0.1' }] },
  Options: options,
  Labels: labels,
});

/** A `docker network inspect` entry for an ordinary bridge, as the outer network of a space is. */
export const bridgeNetworkEntry = ({ name, labels }) => ({
  Name: name,
  Internal: false,
  EnableIPv6: false,
  IPAM: { Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }] },
  Options: {},
  Labels: labels,
});

const HEALTHY_ANSWER = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"status":"ok","isOpenCodeReady":true}';
const jsonAnswer = (body) => `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${body}`;
const CONTROL_ANSWERS = {
  '/health': jsonAnswer('{"ready":true,"mode":"allowlist","domains":0,"grants":0}'),
  '/journal': jsonAnswer('{"records":[],"dropped":0}'),
  '/network': jsonAnswer('{"ok":true}'),
  '/grants': jsonAnswer('{"ok":true}'),
};

const roleOf = (args) => readPairs(args, '--label')['openchamber.space.role'];

const readMounts = (args) => args
  .filter((arg, index) => args[index - 1] === '--mount')
  .map((arg) => {
    const fields = arg.split(',');
    const field = (name) => fields.find((part) => part.startsWith(`${name}=`)).slice(name.length + 1);
    return { volume: field('src'), destination: field('dst'), readOnly: fields.includes('readonly') };
  });

/**
 * `failAt(args)` returns true for the call that must fail. `timeoutAt(args)` returns
 * true for the call whose CLI is killed by the timeout: the runner rejects, and the
 * daemon finishes the step later, when the place calls `wait`. `interruptionCode` is the
 * code of that rejection. `resources` seeds
 * existing containers, networks and volumes as `{ kind, name, entry }`. A seeded tools volume
 * with `filled: true` holds its fill marker, and a seeded home volume with `token` holds that server token.
 * `alterContainer(entry)` changes what inspect reports for a new space container.
 * `serverReady: false` makes the server inside every space refuse connections, and
 * `gatekeeperReady: false` does the same for every gatekeeper's control channel.
 * `start` is where the clock of `now()` begins. `wait(ms)` moves that clock, so nothing here sleeps.
 * `beforeFill()` runs before a tools fill ends, so a test can hold it open.
 */
export function createFakeDocker({
  failAt = () => false,
  timeoutAt = () => false,
  interruptionCode = 'command_timeout',
  resources = [],
  imagePresent = true,
  alterContainer = (entry) => entry,
  serverReady = true,
  gatekeeperReady = true,
  beforeFill = async () => {},
  start = new Date('2026-09-20T08:00:00.000Z'),
} = {}) {
  let clock = start.getTime();
  const calls = [];
  const late = [];
  const state = new Map(resources.map((resource) => [`${resource.kind}:${resource.name}`, resource]));
  // Volume name to the key in its fill marker. A tools volume name ends with its key.
  const filled = new Map(resources.filter((resource) => resource.filled).map((resource) => [resource.name, resource.name.slice(-16)]));
  // The token is a file in the home volume, so it outlives the container.
  const tokens = new Map(resources.filter((resource) => resource.token).map((resource) => [resource.name, resource.token]));
  // The gatekeeper's program is a file in its tmpfs, so it is gone when the container stops.
  const programs = new Map();
  const homeOf = (container) => state.get(`container:${container}`)?.entry.Mounts.find((mount) => mount.Destination === SPACE_HOME)?.Name ?? container;
  const add = (kind, name, entry) => state.set(`${kind}:${name}`, { kind, name, entry });
  // The docker CLI takes a container name or a container id.
  const containerKey = (nameOrId) => (state.has(`container:${nameOrId}`)
    ? `container:${nameOrId}`
    : Array.from(state.keys()).find((key) => key.startsWith('container:') && state.get(key).entry.Id === nameOrId));
  const nameConflict = (name) => failed(`Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${state.get(`container:${name}`).entry.Id}". You have to remove (or rename) that container to be able to reuse that name.`);
  const ofKind = (kind) => Array.from(state.values()).filter((resource) => resource.kind === kind);

  const matchesFilters = (resource, args) => {
    const labels = (resource.kind === 'container' ? resource.entry.Config?.Labels : resource.entry.Labels) ?? {};
    return args.every((arg, index) => {
      if (args[index - 1] !== '--filter') return true;
      const pair = arg.slice('label='.length);
      return labels[pair.slice(0, pair.indexOf('='))] === pair.slice(pair.indexOf('=') + 1);
    });
  };

  // Like the real CLI: entries that exist go to stdout even when another name is missing.
  const inspect = (kind, names) => {
    const keyOf = (name) => (kind === 'container' ? containerKey(name) : `${kind}:${name}`);
    const found = names.map((name) => state.get(keyOf(name))).filter(Boolean).map((resource) => resource.entry);
    const missing = names.filter((name) => !state.has(keyOf(name)));
    const stdout = JSON.stringify(found);
    return missing.length === 0 ? ok(stdout) : failed(missing.map(NOT_FOUND_TEXT[kind]).join('\n'), stdout);
  };

  const addContainer = (args, { running }) => {
    const name = readFlag(args, '--name');
    // Like the real engine: a name that is in use is refused, and nothing is made.
    if (state.has(`container:${name}`)) return nameConflict(name);
    const mounts = readMounts(args);
    // Like the real engine: a missing `src=` volume is created on the spot, without labels.
    for (const { volume } of mounts) {
      if (!state.has(`volume:${volume}`)) add('volume', volume, { Name: volume, Labels: null });
    }
    const entry = hardenedContainerEntry({
      name,
      labels: readPairs(args, '--label'),
      network: readFlag(args, '--network'),
      mounts,
      env: args.filter((arg, index) => args[index - 1] === '--env'),
      running,
      memoryBytes: Number(readFlag(args, '--memory')),
      tmpfs: args.includes('--tmpfs') ? readFlag(args, '--tmpfs') : undefined,
      aliases: args.includes('--network-alias') ? [readFlag(args, '--network-alias')] : [],
    });
    add('container', name, args[0] === 'create' ? alterContainer(entry) : entry);
    // `docker create` prints the id of the new container.
    return ok(`${entry.Id}\n`);
  };

  // What runs inside a space. The server inside answers once its token is there.
  // A gatekeeper answers on its control channel once its program is there.
  const execInside = (args, stdin) => {
    const container = args[args.indexOf('--user') + 2];
    const argv = args.slice(args.indexOf('--user') + 3);
    if (!state.get(`container:${container}`)?.entry.State.Running) return failed(`Error response from daemon: container ${container} is not running`);
    if (state.get(`container:${container}`).entry.Config.Labels?.['openchamber.space.role'] === 'gatekeeper') {
      if (argv[0] === IMAGE_SH && argv[2].includes(`${GATEKEEPER_PROGRAM_PATH}.new`)) {
        programs.set(container, String(stdin));
        return ok();
      }
      if (argv[0] !== IMAGE_CURL) return ok();
      if (!gatekeeperReady || !programs.has(container)) return { code: 7, stdout: '', stderr: 'curl: (7) Failed to connect' };
      const path = Object.keys(CONTROL_ANSWERS).find((candidate) => String(stdin).includes(`${candidate}"`));
      return path ? ok(CONTROL_ANSWERS[path]) : ok('HTTP/1.1 404 Not Found\r\n\r\n{"error":"no such control endpoint"}');
    }
    const home = homeOf(container);
    if (argv[0] === IMAGE_CURL) return serverReady && tokens.has(home) ? ok(HEALTHY_ANSWER) : { code: 7, stdout: '', stderr: 'curl: (7) Failed to connect' };
    if (argv[0] === IMAGE_SH && argv[2].includes(`${SPACE_TOKEN_PATH}.new`)) {
      tokens.set(home, String(stdin));
      return ok();
    }
    if (argv[0] === IMAGE_CAT && argv[1] === SPACE_TOKEN_PATH) return ok(`${tokens.get(home)}\n`);
    if (argv[0] === IMAGE_SH) return ok();
    return ok('1000\n');
  };

  // The three one-shots: volume ownership, the tools filler, and the fill marker check.
  const runOneShot = (args, { stuck, fails }) => {
    const role = roleOf(args);
    const [toolsMount] = readMounts(args);
    // Measured with CLI 29.3.0: a docker CLI that cannot reach the daemon exits with 1.
    if (role === 'tools-check' && fails) return failed('failed to connect to the docker API at tcp://127.0.0.1:1');
    if (role === 'tools-check') {
      // The check script exits with 42 for a missing marker, and prints the marker otherwise.
      const key = filled.get(toolsMount.volume);
      return key ? ok(key) : { code: 42, stdout: '', stderr: '' };
    }
    // The one-shot removes itself when it ends. A stuck one is still there.
    const result = addContainer(args, { running: true });
    if (result.code !== 0) return result;
    if (!stuck) state.delete(`container:${readFlag(args, '--name')}`);
    if (fails) return failed('Error response from daemon: simulated failure');
    if (role === 'tools-fill' && !stuck) filled.set(toolsMount.volume, readPairs(args, '--label')['openchamber.space.tools.key']);
    return result;
  };

  const answer = (args, { stuck = false, fails = false, stdin = '' } = {}) => {
    const [first, second] = args;
    if (first === 'run') return runOneShot(args, { stuck, fails });
    // A failed `docker create` can still leave the container behind.
    if (first === 'create') return fails ? (addContainer(args, { running: false }), failed('Error response from daemon: simulated failure')) : addContainer(args, { running: false });
    if (fails) return failed('Error response from daemon: simulated failure');
    if (first === 'inspect') return inspect('container', args.slice(3));
    if (first === 'image' && second === 'inspect') return imagePresent ? ok('[{}]') : failed(NOT_FOUND_TEXT.image(args[2]), '[]');
    if (first === 'pull') return ok();
    if (first === 'ps') return ok(ofKind('container').filter((resource) => matchesFilters(resource, args)).map((resource) => resource.name).join('\n'));
    if (first === 'rm') {
      const name = args[args.length - 1];
      // Like the real engine: without --force a running container stays.
      if (!args.includes('--force') && state.get(containerKey(name))?.entry.State.Running) {
        return failed(`Error response from daemon: cannot remove container "/${name}": container is running: stop the container before removing or force remove`);
      }
      return state.delete(containerKey(name)) ? ok(name) : failed(NOT_FOUND_TEXT.container(name));
    }
    if (first === 'stop' || first === 'start') {
      const resource = state.get(containerKey(second));
      if (!resource) return failed(NOT_FOUND_TEXT.container(second));
      resource.entry.State.Running = first === 'start';
      // A tmpfs is empty again after a stop, so the gatekeeper's program is gone with it.
      if (first === 'stop') programs.delete(resource.name);
      return ok(second);
    }
    if (first === 'rename') {
      const [, from, to] = args;
      const resource = state.get(`container:${from}`);
      if (!resource) return failed(NOT_FOUND_TEXT.container(from));
      if (state.has(`container:${to}`)) return nameConflict(to);
      state.delete(`container:${from}`);
      add('container', to, { ...resource.entry, Name: `/${to}` });
      return ok();
    }
    if (first === 'exec') return execInside(args, stdin);
    if (first === 'network' && second === 'connect') {
      const [, , network, container] = args;
      const resource = state.get(containerKey(container));
      if (!resource) return failed(NOT_FOUND_TEXT.container(container));
      if (!state.has(`network:${network}`)) return failed(NOT_FOUND_TEXT.network(network));
      resource.entry.NetworkSettings.Networks[network] = {};
      return ok();
    }
    if (first === 'network' || first === 'volume') {
      const name = args[args.length - 1];
      if (second === 'inspect') return inspect(first, args.slice(2));
      if (second === 'ls') return ok(ofKind(first).filter((resource) => matchesFilters(resource, args)).map((resource) => resource.name).join('\n'));
      if (second === 'rm') {
        // Like the real engine: a volume that a container mounts cannot go.
        const user = first === 'volume' && ofKind('container').find((resource) => resource.entry.Mounts.some((mount) => mount.Name === name));
        if (user) return failed(`Error response from daemon: remove ${name}: volume is in use - [${user.name}]`);
        filled.delete(name);
        tokens.delete(name);
        return state.delete(`${first}:${name}`) ? ok(name) : failed(NOT_FOUND_TEXT[first](name));
      }
      if (second === 'create') {
        const labels = readPairs(args, '--label');
        if (first === 'volume') {
          add(first, name, { Name: name, Labels: labels });
        } else {
          add(first, name, args.includes('--internal')
            ? internalNetworkEntry({ name, labels, options: readPairs(args, '--opt') })
            : bridgeNetworkEntry({ name, labels }));
        }
        return ok(name);
      }
    }
    throw new Error(`fake docker has no answer for: ${args.join(' ')}`);
  };

  const runCommand = async (file, args, options) => {
    calls.push({ file, args, options });
    if (timeoutAt(args)) {
      late.push(args);
      throw new SpaceError(interruptionCode, `docker ${args[0]} was stopped before it finished`);
    }
    if (args[0] === 'run' && roleOf(args) === 'tools-fill') await beforeFill();
    return answer(args, { fails: failAt(args), stdin: options?.stdin });
  };

  /** Give this to the place as `wait`. Time passes, the daemon finishes the timed-out steps, and a one-shot stays running. */
  const wait = async (milliseconds = 0) => {
    clock += milliseconds;
    for (const args of late.splice(0)) {
      answer(args, { stuck: true });
    }
  };

  return {
    runCommand,
    wait,
    /** Give this to the place as `now`. */
    now: () => new Date(clock),
    calls,
    names: () => Array.from(state.keys()),
    token: (container) => tokens.get(homeOf(container)),
  };
}
