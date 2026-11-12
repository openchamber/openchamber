import { describe, expect, it } from 'vitest';
import { buildUnits, execArguments, exitCode, targetProperties } from './units.js';
import { layout } from './state.js';

const record = { id: '123456abcdef', place: 'host', toolsKey: '1234567890abcdef', memoryBytes: 1024 ** 3, startConfig: null };
const paths = layout();
const expectedHardening = {
  ProtectSystem: 'strict', ProtectHome: 'tmpfs', PrivateTmp: 'yes',
  TemporaryFileSystem: '/run:rw,nosuid,nodev,noexec,size=16M /srv:ro /mnt:ro /media:ro /spaces:ro /opt:ro /dev/shm:rw,nosuid,nodev,noexec,size=64M,mode=1777',
  PrivateDevices: 'yes', PrivateIPC: 'yes', ProtectProc: 'invisible', ProcSubset: 'pid',
  ProtectKernelTunables: 'yes', ProtectKernelModules: 'yes', ProtectKernelLogs: 'yes', ProtectControlGroups: 'yes',
  ProtectClock: 'yes', ProtectHostname: 'yes', RestrictNamespaces: 'yes', RestrictSUIDSGID: 'yes', LockPersonality: 'yes',
  NoNewPrivileges: 'yes', CapabilityBoundingSet: '', AmbientCapabilities: '', SystemCallArchitectures: 'native',
  SystemCallFilter: '@system-service', RestrictAddressFamilies: 'AF_UNIX AF_INET AF_INET6 AF_NETLINK',
  KeyringMode: 'private', UMask: '0022', MemorySwapMax: '0', TasksMax: '512', OOMPolicy: 'continue',
};

describe('hostd unit builders', () => {
  it.each(['space', 'gatekeeper'])('confines %s exec with the full main-unit property list', (target) => {
    // Given an ordinary isolated space with a resource budget.
    const properties = targetProperties({ record, paths, target });
    // When the same target is used for a transient command.
    const argv = ['/bin/sh', '-c', 'echo "$HOME;$(id)"'];
    const args = execArguments({ record, paths, target, unit: 'openchamber-exec-test.service', argv });
    // Then every hardening property applies, including every address family separately.
    expect(Object.fromEntries(properties)).toMatchObject(expectedHardening);
    for (const [key, value] of Object.entries(expectedHardening)) {
      if (key === 'RestrictAddressFamilies') for (const family of value.split(' ')) expect(args).toContain(`--property=${key}=${family}`);
      else expect(args).toContain(`--property=${key}=${value}`);
    }
    for (const [key, value] of properties.filter(([key]) => key !== 'RestrictAddressFamilies')) expect(args).toContain(`--property=${key}=${value}`);
    expect(args).toContain(`--property=JoinsNamespaceOf=openchamber-${target === 'space' ? 'space' : 'gk'}-${record.id}.service`);
    for (const key of ['Requisite', 'After', 'PartOf']) expect(args).toContain(`--property=${key}=openchamber-${target === 'space' ? 'space' : 'gk'}-${record.id}.service`);
    expect(args).toContain('--property=Slice=openchamber-space-123456abcdef.slice');
    expect(args.slice(args.indexOf('--'))).toEqual(['--', '/usr/bin/env', '--', ...argv]);
    expect(args).not.toContain('--collect');
  });
  it('keeps state source parents immutable and selects sealed tools before global binaries', () => {
    expect(targetProperties({ record, paths, target: 'space' })).toContainEqual(['ReadOnlyPaths', `/var/lib/openchamber-spaces/${record.id} /var/lib/private/openchamber-spaces/${record.id}`]);
    const environment = targetProperties({ record, paths, target: 'space' }).filter(([key]) => key === 'Environment').map(([, value]) => value);
    expect(environment.find((value) => value.startsWith('PATH='))).toMatch(/^PATH=\/opt\/openchamber-tools\/node_modules\/\.bin:/);
  });
  it('binds the space\'s own protected MCP subject, and nothing of it into the gatekeeper', () => {
    const bind = ['BindReadOnlyPaths', `-/run/openchamber-protected-mcp/subjects/space-${record.id}:/run/openchamber-mcp`];
    expect(targetProperties({ record, paths, target: 'space' })).toContainEqual(bind);
    expect(JSON.stringify(targetProperties({ record, paths, target: 'gatekeeper' }))).not.toContain('openchamber-protected-mcp');
    // No other subject, the agent's included, and not the service's own engine socket.
    expect(JSON.stringify(targetProperties({ record, paths, target: 'space' }))).not.toMatch(/subjects\/(?!space-123456abcdef:)|engine\.sock/);
  });
  it('builds a capability-free slirp service with the exact probe7 security properties', () => {
    const units = buildUnits({ record, paths, ipPath: '/usr/bin/ip' });
    const net = units['openchamber-net-123456abcdef.service'];
    const properties = Object.fromEntries(net.split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    expect(properties).toEqual({
      Description: 'OpenChamber host space', Type: 'exec', Slice: 'openchamber-space-123456abcdef.slice',
      User: 'openchamber-net-123456abcdef', Group: 'openchamber-net-123456abcdef',
      RuntimeDirectory: 'openchamber-net-123456abcdef', RuntimeDirectoryMode: '0700',
      BindReadOnlyPaths: '/run/openchamber-hostd/ns/123456abcdef/user:/run/openchamber-net-123456abcdef/user /run/openchamber-hostd/ns/123456abcdef/net:/run/openchamber-net-123456abcdef/net',
      NoNewPrivileges: 'yes', CapabilityBoundingSet: '', AmbientCapabilities: '', ProtectSystem: 'strict', ProtectHome: 'yes', PrivateTmp: 'yes',
      ProtectKernelTunables: 'yes', ProtectKernelModules: 'yes', ProtectKernelLogs: 'yes', ProtectControlGroups: 'yes', ProtectClock: 'yes', ProtectHostname: 'yes',
      RestrictSUIDSGID: 'yes', LockPersonality: 'yes', MemoryDenyWriteExecute: 'yes', RestrictRealtime: 'yes', SystemCallArchitectures: 'native',
      MemoryMax: '134217728', MemorySwapMax: '0', TasksMax: '32', LogRateLimitIntervalSec: '30s', LogRateLimitBurst: '1000',
      ExecStart: ':"/usr/bin/slirp4netns" "--configure" "--mtu=65520" "--disable-host-loopback" "--enable-seccomp" "--userns-path=/run/openchamber-net-123456abcdef/user" "--netns-type=path" "/run/openchamber-net-123456abcdef/net" "tap0"',
      TimeoutStopSec: '15', KillMode: 'control-group',
    });
    expect(units['openchamber-space-123456abcdef.slice']).toContain('MemoryMax=1073741824\nMemorySwapMax=0\nTasksMax=512\n');
    expect(net).not.toMatch(/--enable-sandbox|IPAddressDeny|PrivatePIDs/);
  });
  it('keeps root execution unsandboxed while preserving the layout and slice', () => {
    const properties = Object.fromEntries(targetProperties({ record: { ...record, place: 'host-root' }, paths, target: 'space' }));
    // Without a DynamicUser, systemd's StateDirectory would be a plain empty folder: the binds name hostd's own.
    expect(properties).toMatchObject({ User: 'root', Slice: 'openchamber-space-123456abcdef.slice',
      BindPaths: `${paths.privateState}/123456abcdef/work:/spaces/123456abcdef ${paths.privateState}/123456abcdef/home:/home/space` });
    for (const key of ['DynamicUser', 'NoNewPrivileges', 'ProtectSystem', 'CapabilityBoundingSet', 'RestrictNamespaces', 'StateDirectory']) expect(properties).not.toHaveProperty(key);
  });
  it.each([
    [{ ExecMainCode: '1', ExecMainStatus: '75', Result: 'exit-code' }, 75],
    [{ ExecMainCode: '2', ExecMainStatus: '9', Result: 'signal' }, 137],
    [{ ExecMainCode: '3', ExecMainStatus: '6', Result: 'core-dump' }, 134],
    [{ ExecMainCode: '1', ExecMainStatus: '1', Result: 'oom-kill' }, 137],
  ])('maps interpreted service exit %j to %i', (properties, expected) => {
    expect(exitCode(properties)).toBe(expected);
  });
});
