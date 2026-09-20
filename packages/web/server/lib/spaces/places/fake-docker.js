// Test support. A fake command runner that answers like the docker CLI for the
// few subcommands the Docker place uses, and records every call.

import { SpaceError } from '../errors.js';

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

/** A `docker inspect` entry for a container that matches the requested hardening. */
export function hardenedContainerEntry({ name, labels, network, volumes, running = true, memoryBytes = 4294967296 }) {
  return {
    Name: `/${name}`,
    State: { Running: running, Status: running ? 'running' : 'created' },
    Config: { User: '1000:1000', Labels: labels },
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
      Tmpfs: { '/tmp': 'rw,exec,nosuid,size=256m' },
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
    Mounts: volumes.map((volume) => ({
      Type: 'volume',
      Name: volume,
      Source: `/var/lib/docker/volumes/${volume}/_data`,
      Destination: `/mnt/${volume}`,
    })),
    NetworkSettings: { Networks: { [network]: {} } },
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

/**
 * `failAt(args)` returns true for the call that must fail. `timeoutAt(args)` returns
 * true for the call whose CLI is killed by the timeout: the runner rejects, and the
 * daemon finishes the step later, when the place calls `wait`. `interruptionCode` is the
 * code of that rejection. `resources` seeds
 * existing containers, networks and volumes as `{ kind, name, entry }`.
 * `alterContainer(entry)` changes what inspect reports for a new space container.
 */
export function createFakeDocker({ failAt = () => false, timeoutAt = () => false, interruptionCode = 'command_timeout', resources = [], imagePresent = true, alterContainer = (entry) => entry } = {}) {
  const calls = [];
  const late = [];
  const state = new Map(resources.map((resource) => [`${resource.kind}:${resource.name}`, resource]));
  const add = (kind, name, entry) => state.set(`${kind}:${name}`, { kind, name, entry });
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
    const found = names.map((name) => state.get(`${kind}:${name}`)).filter(Boolean).map((resource) => resource.entry);
    const missing = names.filter((name) => !state.has(`${kind}:${name}`));
    const stdout = JSON.stringify(found);
    return missing.length === 0 ? ok(stdout) : failed(missing.map(NOT_FOUND_TEXT[kind]).join('\n'), stdout);
  };

  const addContainer = (args, { running }) => {
    const name = readFlag(args, '--name');
    const volumes = args.filter((arg) => arg.startsWith('type=volume,')).map((arg) => arg.split(',')[1].slice('src='.length));
    // Like the real engine: a missing `src=` volume is created on the spot, without labels.
    for (const volume of volumes) {
      if (!state.has(`volume:${volume}`)) add('volume', volume, { Name: volume, Labels: null });
    }
    const entry = hardenedContainerEntry({
      name,
      labels: readPairs(args, '--label'),
      network: readFlag(args, '--network'),
      volumes,
      running,
      memoryBytes: Number(readFlag(args, '--memory')),
    });
    add('container', name, args[0] === 'create' ? alterContainer(entry) : entry);
    return ok(name);
  };

  const answer = (args, { stuck = false } = {}) => {
    const [first, second] = args;
    if (first === 'inspect') return inspect('container', args.slice(3));
    if (first === 'image' && second === 'inspect') return imagePresent ? ok('[{}]') : failed(NOT_FOUND_TEXT.image(args[2]), '[]');
    if (first === 'pull') return ok();
    if (first === 'ps') return ok(ofKind('container').filter((resource) => matchesFilters(resource, args)).map((resource) => resource.name).join('\n'));
    if (first === 'rm') {
      const name = args[args.length - 1];
      return state.delete(`container:${name}`) ? ok(name) : failed(NOT_FOUND_TEXT.container(name));
    }
    if (first === 'stop' || first === 'start') {
      state.get(`container:${second}`).entry.State.Running = first === 'start';
      return ok(second);
    }
    if (first === 'exec') return ok('1000\n');
    if (first === 'create') return addContainer(args, { running: false });
    if (first === 'run') {
      // The one-shot removes itself when it ends. A stuck one is still there.
      const result = addContainer(args, { running: true });
      if (!stuck) state.delete(`container:${readFlag(args, '--name')}`);
      return result;
    }
    if (first === 'network' || first === 'volume') {
      const name = args[args.length - 1];
      if (second === 'inspect') return inspect(first, args.slice(2));
      if (second === 'ls') return ok(ofKind(first).filter((resource) => matchesFilters(resource, args)).map((resource) => resource.name).join('\n'));
      if (second === 'rm') return state.delete(`${first}:${name}`) ? ok(name) : failed(NOT_FOUND_TEXT[first](name));
      if (second === 'create') {
        const labels = readPairs(args, '--label');
        add(first, name, first === 'network' ? internalNetworkEntry({ name, labels, options: readPairs(args, '--opt') }) : { Name: name, Labels: labels });
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
    if (failAt(args)) {
      // A failed `docker create` can still leave the container behind.
      if (args[0] === 'create') answer(args);
      return failed('Error response from daemon: simulated failure');
    }
    return answer(args);
  };

  /** Give this to the place as `wait`. The daemon finishes the timed-out steps here, and a one-shot stays running. */
  const wait = async () => {
    for (const args of late.splice(0)) {
      answer(args, { stuck: true });
    }
  };

  return {
    runCommand,
    wait,
    calls,
    names: () => Array.from(state.keys()),
  };
}
