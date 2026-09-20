import { describe, expect, it } from 'vitest';

import { findHardeningViolations, requireMemoryBytes } from './hardening.js';
import { buildSpaceLabels, hashProjectDirectory } from './labels.js';
import { hardenedContainerEntry, internalNetworkEntry } from './places/fake-docker.js';

const ID = 'a1b2c3d4e5f6';
const OWNER = 'install-a';
const NETWORK = `openchamber-space-${ID}-network`;
const WORK = `openchamber-space-${ID}-volume-work`;
const HOME = `openchamber-space-${ID}-volume-home`;
const GATEWAY_MODE = 'com.docker.network.bridge.gateway_mode_ipv4';

const labels = (role, change = {}) => buildSpaceLabels({
  id: ID,
  role,
  owner: OWNER,
  project: hashProjectDirectory('/home/me/project'),
  name: 'Fix login',
  created: '2026-09-19T10:00:00.000Z',
  ...change,
});

const goodContainer = () => hardenedContainerEntry({ name: `openchamber-space-${ID}-space`, labels: labels('space'), network: NETWORK, volumes: [WORK, HOME] });
const goodNetwork = () => internalNetworkEntry({ name: NETWORK, labels: labels('network') });

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

const checksFor = ({ container = goodContainer(), network = goodNetwork() }) => (
  findHardeningViolations({ spaceId: ID, owner: OWNER, container, network }).map((violation) => violation.check)
);

describe('findHardeningViolations', () => {
  it('finds nothing in a container created with the hardening flags', () => {
    expect(findHardeningViolations({ spaceId: ID, owner: OWNER, container: goodContainer(), network: goodNetwork() })).toEqual([]);
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
      'shm_size', 'log_limit', 'tmpfs', 'network_mode',
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
