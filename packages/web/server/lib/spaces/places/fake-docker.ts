import { SpaceError } from '../errors.js';
import { GATEKEEPER_PROGRAM_PATH, IMAGE_CAT, IMAGE_CURL, IMAGE_SH, SPACE_HOME, SPACE_TOKEN_PATH, TOOLS_MOUNT_PATH } from '../layout.js';
import { SPACE_BASE_IMAGE } from './docker.js';
import type { CommandOptions, CommandResult } from '../command-contracts.js';

interface MountSpec {
  volume: string;
  destination: string;
  readOnly?: boolean;
}

interface FakeNetworkAddresses {
  [network: string]: { IPAddress?: string; Aliases?: string[] };
}

export interface HardenedContainerOptions {
  name: string;
  labels: Record<string, string> | null;
  network: string;
  volumes?: string[];
  toolsVolume?: string | null;
  mounts?: MountSpec[] | null;
  env?: string[] | undefined;
  running?: boolean;
  memoryBytes?: number;
  tmpfs?: string | undefined;
  aliases?: string[];
  extraHosts?: string[];
  image?: string;
}

export type FakeContainerEntry = ReturnType<typeof hardenedContainerEntry>;
type FakeNetworkEntry = ReturnType<typeof internalNetworkEntry> | ReturnType<typeof bridgeNetworkEntry>;
interface FakeVolumeEntry {
  Name: string;
  Labels: Record<string, string> | null;
}
export type FakeResource = (
  | { kind: 'container'; entry: FakeContainerEntry }
  | { kind: 'network'; entry: FakeNetworkEntry }
  | { kind: 'volume'; entry: FakeVolumeEntry }
) & { name: string; filled?: boolean; token?: string };

export interface FakeDockerOptions {
  failAt?: (args: string[]) => boolean;
  timeoutAt?: (args: string[]) => boolean;
  interruptionCode?: string;
  resources?: FakeResource[];
  imagePresent?: boolean;
  imageBytes?: number;
  retiredImages?: { name: string; bytes: number; tags?: string[] }[];
  volumeSizes?: Record<string, string>;
  engineName?: string;
  colima?: (args: string[]) => CommandResult | Promise<CommandResult>;
  alterContainer?: (entry: FakeContainerEntry) => FakeContainerEntry;
  serverReady?: boolean;
  gatekeeperReady?: boolean;
  beforeFill?: () => Promise<void>;
  start?: Date;
}

const required = <Value>(value: Value | undefined): Value => {
  if (value === undefined) throw new TypeError('Missing fake Docker command argument or resource');
  return value;
};

const containerEntry = (resource: FakeResource): FakeContainerEntry => {
  if (resource.kind !== 'container') throw new TypeError('Expected fake Docker container');
  return resource.entry;
};

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string, stdout = '') => ({ code: 1, stdout, stderr });

const NOT_FOUND_TEXT = {
  container: (name: string) => `Error response from daemon: No such container: ${name}`,
  network: (name: string) => `Error response from daemon: network ${name} not found`,
  volume: (name: string) => `Error response from daemon: get ${name}: no such volume`,
  image: (name: string) => `Error response from daemon: No such image: ${name}`,
};

const ISOLATED_GATEWAY_OPTION = 'com.docker.network.bridge.gateway_mode_ipv4';

const FAKE_BASE_IMAGE = SPACE_BASE_IMAGE;

const readPairs = (args: string[], flag: string) => {
  const pairs: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (arg === flag) {
      const pair = required(args[index + 1]);
      pairs[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
    }
  });
  return pairs;
};

const readFlag = (args: string[], flag: string) => required(args[args.indexOf(flag) + 1]);

let nextContainerId = 1;
const newContainerId = () => (nextContainerId++).toString(16).padStart(64, 'f');

const volumeMountEntry = ({ volume, destination, readOnly = false }: MountSpec) => ({
  Type: 'volume',
  Name: volume,
  Source: `/var/lib/docker/volumes/${volume}/_data`,
  Destination: destination,
  RW: !readOnly,
});

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
  extraHosts = [],
  image = FAKE_BASE_IMAGE,
}: HardenedContainerOptions) {
  const mountList = mounts ?? [
    ...volumes.map((volume) => ({ volume, destination: `/mnt/${volume}` })),
    ...(toolsVolume ? [{ volume: toolsVolume, destination: TOOLS_MOUNT_PATH, readOnly: true }] : []),
  ];
  const [tmpfsPath, tmpfsOptions] = String(tmpfs).split(':');
  const address: FakeNetworkAddresses[string] = { IPAddress: '172.19.0.2' };
  if (aliases.length > 0) address.Aliases = aliases;
  const networks: FakeNetworkAddresses = { [network]: address };
  return {
    Id: newContainerId(),
    Name: `/${name}`,
    State: { Running: running, Status: running ? 'running' : 'created' },
    Config: { User: '1000:1000', Labels: labels, Env: env, Image: image },
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
      Tmpfs: { [required(tmpfsPath)]: tmpfsOptions },
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
      ExtraHosts: extraHosts,
    },
    Mounts: mountList.map(volumeMountEntry),
    NetworkSettings: { Networks: networks },
  };
}

export const internalNetworkEntry = ({ name, labels, options = { [ISOLATED_GATEWAY_OPTION]: 'isolated' } }: { name: string; labels: Record<string, string> | null; options?: Record<string, string> }) => ({
  Name: name,
  Internal: true,
  EnableIPv6: false,
  IPAM: { Config: [options[ISOLATED_GATEWAY_OPTION] === 'isolated' ? { Subnet: '172.19.0.0/16' } : { Subnet: '172.19.0.0/16', Gateway: '172.19.0.1' }] },
  Options: options,
  Labels: labels,
});

export const bridgeNetworkEntry = ({ name, labels }: { name: string; labels: Record<string, string> | null }) => ({
  Name: name,
  Internal: false,
  EnableIPv6: false,
  IPAM: { Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }] },
  Options: {},
  Labels: labels,
});

const HEALTHY_ANSWER = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"status":"ok","isOpenCodeReady":true}';
const jsonAnswer = (body: string) => `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${body}`;
const CONTROL_ANSWERS = {
  '/health': jsonAnswer('{"ready":true,"mode":"allowlist","domains":0,"grants":0}'),
  '/journal': jsonAnswer('{"records":[],"dropped":0}'),
  '/network': jsonAnswer('{"ok":true}'),
  '/grants': jsonAnswer('{"ok":true}'),
};

const roleOf = (args: string[]) => readPairs(args, '--label')['openchamber.space.role'];

const readMounts = (args: string[]) => args
  .filter((arg, index) => args[index - 1] === '--mount')
  .map((arg) => {
    const fields = arg.split(',');
    const field = (name: string) => required(fields.find((part) => part.startsWith(`${name}=`))).slice(name.length + 1);
    return { volume: field('src'), destination: field('dst'), readOnly: fields.includes('readonly') };
  });

export function createFakeDocker({
  failAt = () => false,
  timeoutAt = () => false,
  interruptionCode = 'command_timeout',
  resources = [],
  imagePresent = true,
  imageBytes = 1_632_000_000,
  retiredImages = [],
  volumeSizes = {},
  engineName = 'docker-desktop',
  colima = () => ok(),
  alterContainer = (entry) => entry,
  serverReady = true,
  gatekeeperReady = true,
  beforeFill = async () => {},
  start = new Date('2026-09-20T08:00:00.000Z'),
}: FakeDockerOptions = {}) {
  let clock = start.getTime();
  let image = imagePresent;
  const retired = new Map(retiredImages.map((entry, index) => [entry.name, { id: `sha256:4567${index}`, bytes: entry.bytes, tags: entry.tags ?? [entry.name] }]));
  const calls: { file: string; args: string[]; options: CommandOptions | undefined }[] = [];
  const late: string[][] = [];
  const state = new Map(resources.map((resource) => [`${resource.kind}:${resource.name}`, resource]));
  const filled = new Map(resources.filter((resource) => resource.filled).map((resource) => [resource.name, resource.name.slice(-16)]));
  const tokens = new Map(resources.filter((resource) => resource.token).map((resource) => [resource.name, resource.token]));
  const programs = new Map<string, string>();
  const homeOf = (container: string) => {
    const resource = state.get(`container:${container}`);
    return resource ? containerEntry(resource).Mounts.find((mount) => mount.Destination === SPACE_HOME)?.Name ?? container : container;
  };
  const add = (resource: FakeResource) => state.set(`${resource.kind}:${resource.name}`, resource);
  const containerKey = (nameOrId: string) => (state.has(`container:${nameOrId}`)
    ? `container:${nameOrId}`
    : Array.from(state.keys()).find((key) => key.startsWith('container:') && containerEntry(required(state.get(key))).Id === nameOrId));
  const nameConflict = (name: string) => failed(`Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${containerEntry(required(state.get(`container:${name}`))).Id}". You have to remove (or rename) that container to be able to reuse that name.`);
  const ofKind = <Kind extends FakeResource['kind']>(kind: Kind) => Array.from(state.values()).filter((resource): resource is Extract<FakeResource, { kind: Kind }> => resource.kind === kind);

  const matchesFilters = (resource: FakeResource, args: string[]) => {
    const labels = (resource.kind === 'container' ? resource.entry.Config?.Labels : resource.entry.Labels) ?? {};
    return args.every((arg, index) => {
      if (args[index - 1] !== '--filter') return true;
      if (arg.startsWith('ancestor=')) return (resource.kind === 'container' ? resource.entry.Config?.Image : undefined) === arg.slice('ancestor='.length);
      const pair = arg.slice('label='.length);
      return labels[pair.slice(0, pair.indexOf('='))] === pair.slice(pair.indexOf('=') + 1);
    });
  };

  const inspect = (kind: FakeResource['kind'], names: string[]) => {
    const keyOf = (name: string) => (kind === 'container' ? containerKey(name) : `${kind}:${name}`);
    const found = names.map((name) => { const key = keyOf(name); return key === undefined ? undefined : state.get(key); }).filter((resource) => Boolean(resource)).map((resource) => required(resource).entry);
    const missing = names.filter((name) => { const key = keyOf(name); return key === undefined || !state.has(key); });
    const stdout = JSON.stringify(found);
    return missing.length === 0 ? ok(stdout) : failed(missing.map(NOT_FOUND_TEXT[kind]).join('\n'), stdout);
  };

  const addContainer = (args: string[], { running }: { running: boolean }) => {
    const name = readFlag(args, '--name');
    if (state.has(`container:${name}`)) return nameConflict(name);
    const mounts = readMounts(args);
    for (const { volume } of mounts) {
      if (!state.has(`volume:${volume}`)) add({ kind: 'volume', name: volume, entry: { Name: volume, Labels: null } });
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
      extraHosts: args.filter((arg, index) => args[index - 1] === '--add-host'),
    });
    add({ kind: 'container', name, entry: args[0] === 'create' ? alterContainer(entry) : entry });
    return ok(`${entry.Id}\n`);
  };

  const execInside = (args: string[], stdin: CommandOptions['stdin']) => {
    const container = required(args[args.indexOf('--user') + 2]);
    const argv = args.slice(args.indexOf('--user') + 3);
    const resource = state.get(`container:${container}`);
    if (!resource || !containerEntry(resource).State.Running) return failed(`Error response from daemon: container ${container} is not running`);
    if (containerEntry(resource).Config.Labels?.['openchamber.space.role'] === 'gatekeeper') {
      if (argv[0] === IMAGE_SH && required(argv[2]).includes(`${GATEKEEPER_PROGRAM_PATH}.new`)) {
        programs.set(container, String(stdin));
        return ok();
      }
      if (argv[0] !== IMAGE_CURL) return ok();
      if (!gatekeeperReady || !programs.has(container)) return { code: 7, stdout: '', stderr: 'curl: (7) Failed to connect' };
      const answer = Object.entries(CONTROL_ANSWERS).find(([candidate]) => String(stdin).includes(`${candidate}"`));
      return answer ? ok(answer[1]) : ok('HTTP/1.1 404 Not Found\r\n\r\n{"error":"no such control endpoint"}');
    }
    const home = homeOf(container);
    if (argv[0] === IMAGE_CURL) return serverReady && tokens.has(home) ? ok(HEALTHY_ANSWER) : { code: 7, stdout: '', stderr: 'curl: (7) Failed to connect' };
    if (argv[0] === IMAGE_SH && required(argv[2]).includes(`${SPACE_TOKEN_PATH}.new`)) {
      tokens.set(home, String(stdin));
      return ok();
    }
    if (argv[0] === IMAGE_CAT && argv[1] === SPACE_TOKEN_PATH) return ok(`${tokens.get(home)}\n`);
    if (argv[0] === IMAGE_SH) return ok();
    return ok('1000\n');
  };

  const runOneShot = (args: string[], { stuck, fails }: { stuck: boolean; fails: boolean }) => {
    const role = roleOf(args);
    const [toolsMount] = readMounts(args);
    if (role === 'tools-check' && fails) return failed('failed to connect to the docker API at tcp://127.0.0.1:1');
    if (role === 'tools-check') {
      const key = filled.get(required(toolsMount).volume);
      return key ? ok(key) : { code: 42, stdout: '', stderr: '' };
    }
    const result = addContainer(args, { running: true });
    if (result.code !== 0) return result;
    if (!stuck) state.delete(`container:${readFlag(args, '--name')}`);
    if (fails) return failed('Error response from daemon: simulated failure');
    if (role === 'tools-fill' && !stuck) filled.set(required(toolsMount).volume, required(readPairs(args, '--label')['openchamber.space.tools.key']));
    return result;
  };

  const answer = (args: string[], { stuck = false, fails = false, stdin = '' }: { stuck?: boolean; fails?: boolean; stdin?: CommandOptions['stdin'] } = {}) => {
    const [first, second] = args;
    if (first === 'run') return runOneShot(args, { stuck, fails });
    if (first === 'create') return fails ? (addContainer(args, { running: false }), failed('Error response from daemon: simulated failure')) : addContainer(args, { running: false });
    if (fails) return failed('Error response from daemon: simulated failure');
    if (first === 'inspect') return inspect('container', args.slice(3));
    if (first === 'image' && second === 'inspect') {
      const old = retired.get(required(args[2]));
      if (old) return ok(JSON.stringify([{ Id: old.id, Size: Math.round(old.bytes / 4), RepoTags: old.tags }]));
      return image && args[2] === FAKE_BASE_IMAGE ? ok(JSON.stringify([{ Id: 'sha256:0123', Size: Math.round(imageBytes / 4), RepoTags: [FAKE_BASE_IMAGE] }])) : failed(NOT_FOUND_TEXT.image(required(args[2])), '[]');
    }
    if (first === 'image' && second === 'rm' && retired.has(required(args[args.length - 1]))) {
      const name = required(args[args.length - 1]);
      const user = ofKind('container').find((resource) => resource.entry.Config?.Image === name);
      if (user && !args.includes('--force')) return failed(`Error response from daemon: conflict: unable to delete ${required(retired.get(name)).id} (must be forced) - image is being used by stopped container ${user.entry.Id}`);
      retired.delete(name);
      return ok(`Deleted: ${name}`);
    }
    if (first === 'image' && second === 'rm') {
      if (!image || args[args.length - 1] !== FAKE_BASE_IMAGE) return failed(NOT_FOUND_TEXT.image(required(args[args.length - 1])));
      const user = ofKind('container').find((resource) => resource.entry.Config?.Image === FAKE_BASE_IMAGE);
      if (user && !args.includes('--force')) return failed(`Error response from daemon: conflict: unable to delete 0123 (must be forced) - image is being used by stopped container ${user.entry.Id}`);
      image = false;
      return ok(`Deleted: sha256:0123`);
    }
    if (first === 'system' && second === 'df') {
      const mountedBy = (name: string) => ofKind('container').filter((resource) => resource.entry.Mounts.some((mount) => mount.Name === name)).length;
      return ok(JSON.stringify({
        Images: [
          ...(image ? [{ ID: 'sha256:0123', Size: `${imageBytes / 1e9}GB`, UniqueSize: `${imageBytes / 1e9}GB` }] : []),
          ...Array.from(retired.values(), (old) => ({ ID: old.id, Size: `${old.bytes / 1e9}GB`, UniqueSize: `${old.bytes / 1e9}GB` })),
        ],
        Volumes: ofKind('volume').map((resource) => ({ Name: resource.name, Size: volumeSizes[resource.name] ?? '0B', Links: String(mountedBy(resource.name)) })),
      }));
    }
    if (first === 'info') return ok(`${JSON.stringify(engineName)}\n`);
    if (first === 'pull') return ok();
    if (first === 'ps') return ok(ofKind('container').filter((resource) => matchesFilters(resource, args)).map((resource) => resource.name).join('\n'));
    if (first === 'rm') {
      const name = required(args[args.length - 1]);
      const key = containerKey(name);
      const resource = key === undefined ? undefined : state.get(key);
      if (!args.includes('--force') && resource && containerEntry(resource).State.Running) {
        return failed(`Error response from daemon: cannot remove container "/${name}": container is running: stop the container before removing or force remove`);
      }
      return key !== undefined && state.delete(key) ? ok(name) : failed(NOT_FOUND_TEXT.container(name));
    }
    if (first === 'stop' || first === 'start') {
      const name = required(second);
      const key = containerKey(name);
      const resource = key === undefined ? undefined : state.get(key);
      if (!resource) return failed(NOT_FOUND_TEXT.container(name));
      containerEntry(resource).State.Running = first === 'start';
      if (first === 'stop') programs.delete(resource.name);
      return ok(name);
    }
    if (first === 'rename') {
      const [, from, to] = args;
      const resource = state.get(`container:${from}`);
      if (!resource) return failed(NOT_FOUND_TEXT.container(required(from)));
      if (state.has(`container:${to}`)) return nameConflict(required(to));
      state.delete(`container:${from}`);
      add({ kind: 'container', name: required(to), entry: { ...containerEntry(resource), Name: `/${to}` } });
      return ok();
    }
    if (first === 'exec') return execInside(args, stdin);
    if (first === 'network' && second === 'connect') {
      const [, , network, container] = args;
      const key = containerKey(required(container));
      const resource = key === undefined ? undefined : state.get(key);
      if (!resource) return failed(NOT_FOUND_TEXT.container(required(container)));
      if (!state.has(`network:${network}`)) return failed(NOT_FOUND_TEXT.network(required(network)));
      containerEntry(resource).NetworkSettings.Networks[required(network)] = {};
      return ok();
    }
    if (first === 'network' || first === 'volume') {
      const name = required(args[args.length - 1]);
      if (second === 'inspect') return inspect(first, args.slice(2));
      if (second === 'ls') return ok(ofKind(first).filter((resource) => matchesFilters(resource, args)).map((resource) => resource.name).join('\n'));
      if (second === 'rm') {
        const user = first === 'volume' && ofKind('container').find((resource) => resource.entry.Mounts.some((mount) => mount.Name === name));
        if (user) return failed(`Error response from daemon: remove ${name}: volume is in use - [${user.name}]`);
        filled.delete(name);
        tokens.delete(name);
        return state.delete(`${first}:${name}`) ? ok(name) : failed(NOT_FOUND_TEXT[first](name));
      }
      if (second === 'create') {
        const labels = readPairs(args, '--label');
        if (first === 'volume') {
          add({ kind: first, name, entry: { Name: name, Labels: labels } });
        } else {
          add({ kind: first, name, entry: args.includes('--internal')
            ? internalNetworkEntry({ name, labels, options: readPairs(args, '--opt') })
            : bridgeNetworkEntry({ name, labels }) });
        }
        return ok(name);
      }
    }
    throw new Error(`fake docker has no answer for: ${args.join(' ')}`);
  };

  const runCommand = async (file: string, args: string[], options?: CommandOptions) => {
    calls.push({ file, args, options });
    if (String(file).endsWith('colima')) return colima(args);
    if (timeoutAt(args)) {
      late.push(args);
      throw new SpaceError(interruptionCode, `docker ${args[0]} was stopped before it finished`);
    }
    if (args[0] === 'run' && roleOf(args) === 'tools-fill') await beforeFill();
    return answer(args, { fails: failAt(args), stdin: options?.stdin });
  };

  const wait = async (milliseconds = 0) => {
    clock += milliseconds;
    for (const args of late.splice(0)) {
      answer(args, { stuck: true });
    }
  };

  return {
    runCommand,
    wait,
    now: () => new Date(clock),
    calls,
    names: () => Array.from(state.keys()),
    imagePresent: () => image,
    retiredImagePresent: (name: string) => retired.has(name),
    token: (container: string) => tokens.get(homeOf(container)),
  };
}
