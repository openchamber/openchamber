import { describe, expect, it } from 'vitest';

import { findHardeningViolations, requireMemoryBytes } from './hardening.js';
import { buildSpaceLabels, buildToolsLabels, hashProjectDirectory } from './labels.js';
import { hardenedContainerEntry, internalNetworkEntry } from './places/fake-docker.js';

const ID = 'a1b2c3d4e5f6';
const OWNER = 'install-a';
const NETWORK = `openchamber-space-${ID}-network`;
const WORK = `openchamber-space-${ID}-volume-work`;
const HOME = `openchamber-space-${ID}-volume-home`;
const GATEWAY_MODE = 'com.docker.network.bridge.gateway_mode_ipv4';
const KEY = '0123456789abcdef';
const TOOLS = `openchamber-tools-${OWNER}-${KEY}`;
const TOOLS_PATH = '/opt/openchamber-tools';

const labels = (role, change = {}) => buildSpaceLabels({
  id: ID,
  role,
  owner: OWNER,
  project: hashProjectDirectory('/home/me/project'),
  name: 'Fix login',
  created: '2026-09-19T10:00:00.000Z',
  ...change,
});

const toolsLabels = (change = {}) => buildToolsLabels({ role: 'tools', owner: OWNER, key: KEY, description: 'web 1.24.2, opencode 1.18.31', created: '2026-09-19T10:00:00.000Z', ...change });

const goodContainer = () => hardenedContainerEntry({ name: `openchamber-space-${ID}-space`, labels: labels('space'), network: NETWORK, volumes: [WORK, HOME], toolsVolume: TOOLS });
const goodNetwork = () => internalNetworkEntry({ name: NETWORK, labels: labels('network') });
const goodToolsVolume = () => ({ Name: TOOLS, Labels: toolsLabels() });

const withHost = (change) => {
  const container = goodContainer();
  return { ...container, HostConfig: { ...container.HostConfig, ...change } };
};

const withMount = (mount) => {
  const container = goodContainer();
  return { ...container, Mounts: [...container.Mounts, mount] };
};

const withLog = (change) => {
  const log = goodContainer().HostConfig.LogConfig;
  return withHost({ LogConfig: { ...log, ...change, Config: { ...log.Config, ...change.Config } } });
};

/** The good container with its tools mount changed, or replaced by `mounts`. */
const withToolsMount = (change) => {
  const container = goodContainer();
  return { ...container, Mounts: container.Mounts.map((mount) => (mount.Destination === TOOLS_PATH ? { ...mount, ...change } : mount)) };
};

const withEnv = (env) => {
  const container = goodContainer();
  return { ...container, Config: { ...container.Config, Env: [...container.Config.Env, ...env] } };
};

const checksFor = ({ container = goodContainer(), network = goodNetwork(), toolsVolume = goodToolsVolume() }) => (
  findHardeningViolations({ spaceId: ID, owner: OWNER, container, network, toolsVolume }).map((violation) => violation.check)
);

describe('findHardeningViolations', () => {
  it('finds nothing in a container created with the hardening flags', () => {
    expect(findHardeningViolations({ spaceId: ID, owner: OWNER, container: goodContainer(), network: goodNetwork(), toolsVolume: goodToolsVolume() })).toEqual([]);
  });

  it('accepts the long spelling of no-new-privileges', () => {
    expect(checksFor({ container: withHost({ SecurityOpt: ['no-new-privileges:true'] }) })).toEqual([]);
  });

  it('accepts an engine that reports no runtime, no namespace fields and empty maps', () => {
    const container = withHost({ Runtime: undefined, CgroupnsMode: undefined, UsernsMode: undefined, Sysctls: {}, VolumesFrom: [] });
    expect(checksFor({ container })).toEqual([]);
  });

  it.each([
    ['user', { ...goodContainer(), Config: { User: '' } }],
    ['user', { ...goodContainer(), Config: { User: '0:0' } }],
    ['environment', withEnv(['OPENCHAMBER_UI_PASSWORD=secret'])],
    ['environment', withEnv(['OPENCODE_AUTH_CONTENT={}'])],
    ['environment', withEnv(['OPENCHAMBER_UI_PASSWORD='])],
    ['read_only', withHost({ ReadonlyRootfs: false })],
    ['privileged', withHost({ Privileged: true })],
    ['cap_drop', withHost({ CapDrop: ['NET_RAW'] })],
    ['cap_drop', withHost({ CapDrop: null })],
    ['cap_add', withHost({ CapAdd: ['SYS_ADMIN'] })],
    ['no_new_privileges', withHost({ SecurityOpt: null })],
    ['security_options', withHost({ SecurityOpt: ['no-new-privileges', 'seccomp=unconfined'] })],
    ['security_options', withHost({ SecurityOpt: ['no-new-privileges', 'apparmor=unconfined'] })],
    ['security_options', withHost({ SecurityOpt: ['no-new-privileges', 'label=disable'] })],
    ['init', withHost({ Init: null })],
    ['pids_limit', withHost({ PidsLimit: null })],
    ['pids_limit', withHost({ PidsLimit: 0 })],
    ['pids_limit', withHost({ PidsLimit: -1 })],
    ['memory_swap', withHost({ MemorySwap: -1 })],
    ['memory_swap', withHost({ MemorySwap: 8589934592 })],
    ['shm_size', withHost({ ShmSize: 1073741824 })],
    ['shm_size', withHost({ ShmSize: undefined })],
    ['log_limit', withLog({ Type: 'json-file' })],
    ['log_limit', withLog({ Config: { 'max-size': '1g' } })],
    ['log_limit', withLog({ Config: { 'max-file': '100' } })],
    ['log_limit', withHost({ LogConfig: { Type: 'local', Config: {} } })],
    ['tmpfs', withHost({ Tmpfs: null })],
    ['tmpfs', withHost({ Tmpfs: { '/tmp': 'rw,exec,nosuid,size=256m', '/run': 'rw' } })],
    ['tmpfs', withHost({ Tmpfs: { '/tmp': 'rw,exec,size=256m' } })],
    ['tmpfs', withHost({ Tmpfs: { '/tmp': 'rw,exec,nosuid' } })],
    ['tmpfs', withHost({ Tmpfs: { '/tmp': 'rw,exec,nosuid,size=64g' } })],
    ['binds', withHost({ Binds: ['/Users/me:/host'] })],
    ['volumes_from', withHost({ VolumesFrom: ['some-other-container'] })],
    ['mounts', withMount({ Type: 'bind', Source: '/Users/me', Destination: '/host' })],
    ['mounts', withMount({ Type: 'volume', Name: 'someone-elses-volume', Source: '/var/lib/docker/volumes/x/_data', Destination: '/x' })],
    ['mounts', withMount({ Type: 'tmpfs', Source: '', Destination: '/run' })],
    ['namespace', withHost({ PidMode: 'host' })],
    ['namespace', withHost({ PidMode: 'container:abc123' })],
    ['namespace', withHost({ IpcMode: 'host' })],
    ['namespace', withHost({ IpcMode: 'shareable' })],
    ['namespace', withHost({ UTSMode: 'host' })],
    ['namespace', withHost({ UsernsMode: 'host' })],
    ['namespace', withHost({ CgroupnsMode: 'host' })],
    ['sysctls', withHost({ Sysctls: { 'net.ipv4.ip_forward': '1' } })],
    ['runtime', withHost({ Runtime: 'sysbox-runc' })],
    ['devices', withHost({ Devices: [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm' }] })],
    ['port_bindings', withHost({ PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3000' }] } })],
  ])('reports %s', (check, container) => {
    expect(checksFor({ container })).toEqual([check]);
  });

  it('reports a missing memory limit', () => {
    expect(checksFor({ container: withHost({ Memory: 0, MemorySwap: 0 }) })).toEqual(['memory']);
  });

  it('reports a missing no-new-privileges next to an extra security option', () => {
    expect(checksFor({ container: withHost({ SecurityOpt: ['no-new-privileges:false'] }) })).toEqual(['no_new_privileges', 'security_options']);
  });

  it('reports a mounted runtime socket by source and by destination', () => {
    const bySource = withMount({ Type: 'volume', Name: `${WORK}-x`, Source: '/var/run/docker.sock', Destination: '/x' });
    const byDestination = withMount({ Type: 'volume', Name: `${WORK}-x`, Source: '/x', Destination: '/run/docker.sock' });

    expect(checksFor({ container: bySource })).toEqual(['runtime_socket']);
    expect(checksFor({ container: byDestination })).toEqual(['runtime_socket']);
    expect(checksFor({ container: withHost({ Binds: ['/var/run/docker.sock:/var/run/docker.sock'] }) })).toEqual(['binds', 'runtime_socket']);
  });

  it('accepts harmless variables next to the ones a space gets', () => {
    expect(checksFor({ container: withEnv(['OPENCODE_DISABLE_AUTOUPDATE=1', 'NOT_OPENCHAMBER_UI_PASSWORD=x']) })).toEqual([]);
  });

  describe('tools mount', () => {
    it('reports a writable tools mount', () => {
      expect(checksFor({ container: withToolsMount({ RW: true }) })).toEqual(['tools_read_only']);
      expect(checksFor({ container: withToolsMount({ RW: undefined }) })).toEqual(['tools_read_only']);
    });

    it('reports a space without a tools mount', () => {
      const container = goodContainer();
      const withoutTools = { ...container, Mounts: container.Mounts.filter((mount) => mount.Destination !== TOOLS_PATH) };
      expect(checksFor({ container: withoutTools, toolsVolume: null })).toEqual(['tools_mount']);
    });

    it('gives a tools volume at another destination no exception, read-only or not', () => {
      expect(checksFor({ container: withToolsMount({ Destination: '/opt/other' }) })).toEqual(['mounts', 'tools_mount']);
    });

    it('reports a second tools mount', () => {
      const second = { Type: 'volume', Name: `openchamber-tools-${OWNER}-ffffffffffffffff`, Source: '/var/lib/docker/volumes/x/_data', Destination: '/opt/more-tools', RW: false };
      expect(checksFor({ container: withMount(second) })).toEqual(['mounts']);
      // Docker allows one mount per destination. An inspect result that shows two is not a space of ours.
      expect(checksFor({ container: withMount({ ...second, Destination: TOOLS_PATH }) })).toEqual(['tools_mount']);
    });

    it('reports the tools volume of another installation', () => {
      const name = `openchamber-tools-install-b-${KEY}`;
      const toolsVolume = { Name: name, Labels: toolsLabels({ owner: 'install-b' }) };
      expect(checksFor({ container: withToolsMount({ Name: name }), toolsVolume })).toEqual(['tools_mount', 'tools_labels']);
    });

    it('reports a bind mount or a volume of this space at the tools path', () => {
      expect(checksFor({ container: withToolsMount({ Type: 'bind', Name: undefined, Source: '/Users/me/tools' }), toolsVolume: null })).toEqual(['tools_mount', 'tools_labels']);
      expect(checksFor({ container: withToolsMount({ Name: `${WORK}-tools` }), toolsVolume: { Name: `${WORK}-tools`, Labels: labels('volume') } })).toEqual(['tools_mount', 'tools_labels']);
    });

    it.each([
      ['no labels', null],
      ['the labels of another installation', toolsLabels({ owner: 'install-b' })],
      ['another key than its name says', toolsLabels({ key: 'ffffffffffffffff' })],
      ['the role of a filler', toolsLabels({ role: 'tools-fill' })],
      ['the labels of a space volume', labels('volume')],
    ])('reports a volume with a matching name and %s', (title, volumeLabels) => {
      expect(checksFor({ toolsVolume: { Name: TOOLS, Labels: volumeLabels } })).toEqual(['tools_labels']);
    });

    it('reports a tools volume that was not inspected, or another volume than the mounted one', () => {
      expect(checksFor({ toolsVolume: null })).toEqual(['tools_labels']);
      expect(checksFor({ toolsVolume: { Name: `openchamber-tools-${OWNER}-ffffffffffffffff`, Labels: toolsLabels({ key: 'ffffffffffffffff' }) } })).toEqual(['tools_labels']);
    });

    it('still reports a read-only mount that is not the tools mount', () => {
      const mount = { Type: 'volume', Name: 'someone-elses-volume', Source: '/var/lib/docker/volumes/x/_data', Destination: '/x', RW: false };
      expect(checksFor({ container: withMount(mount) })).toEqual(['mounts']);
    });
  });

  it.each(['host', 'bridge', 'none', 'container:abc123', `${NETWORK}-other`])('reports NetworkMode %s', (mode) => {
    expect(checksFor({ container: withHost({ NetworkMode: mode }) })).toEqual(['network_mode']);
  });

  it('reports a second network, another network, and no network', () => {
    const attachedTo = (networks) => ({ ...goodContainer(), NetworkSettings: { Networks: networks } });

    expect(checksFor({ container: attachedTo({ [NETWORK]: {}, bridge: {} }) })).toEqual(['networks']);
    expect(checksFor({ container: attachedTo({ bridge: {} }) })).toEqual(['networks']);
    expect(checksFor({ container: attachedTo({}) })).toEqual(['networks']);
  });

  it('reports a network that is not internal', () => {
    expect(checksFor({ network: { ...goodNetwork(), Internal: false } })).toEqual(['network_internal']);
  });

  it('reports a network with IPv6', () => {
    expect(checksFor({ network: { ...goodNetwork(), EnableIPv6: true } })).toEqual(['network_ipv6']);
  });

  it('reports a network without the isolated gateway option', () => {
    expect(checksFor({ network: { ...goodNetwork(), Options: {} } })).toEqual(['network_host_isolation']);
    expect(checksFor({ network: { ...goodNetwork(), Options: { [GATEWAY_MODE]: 'nat' } } })).toEqual(['network_host_isolation']);
  });

  it('reports an engine that took the option but still gave the bridge a gateway address', () => {
    const network = { ...goodNetwork(), IPAM: { Config: [{ Subnet: '172.19.0.0/16', Gateway: '172.19.0.1' }] } };
    expect(checksFor({ network })).toEqual(['network_host_isolation']);
  });

  it.each([
    ['no labels', null],
    ['the labels of another space', labels('network', { id: 'ffffffffffff' })],
    ['the labels of another installation', labels('network', { owner: 'install-b' })],
    ['a different role', labels('volume')],
  ])('reports a network with %s', (title, networkLabels) => {
    expect(checksFor({ network: { ...goodNetwork(), Labels: networkLabels } })).toEqual(['network_labels']);
  });

  it('reports everything for an empty inspect result', () => {
    expect(checksFor({ container: {}, network: null })).toEqual([
      'user', 'read_only', 'privileged', 'cap_drop', 'no_new_privileges', 'init', 'pids_limit', 'memory',
      'shm_size', 'log_limit', 'tmpfs', 'tools_mount', 'network_mode',
      'networks', 'network_internal', 'network_host_isolation', 'network_labels',
    ]);
  });
});

describe('requireMemoryBytes', () => {
  it('accepts a whole number of bytes from 64 MiB up', () => {
    expect(requireMemoryBytes(64 * 1024 * 1024)).toBe(67108864);
  });

  it.each([0, -1, 1024, 1.5 * 1024 * 1024 * 1024 + 0.5, Number.NaN, undefined, null, '4g'])('rejects %j', (value) => {
    expect(() => requireMemoryBytes(value)).toThrow(expect.objectContaining({ code: 'invalid_memory_limit' }));
  });
});
