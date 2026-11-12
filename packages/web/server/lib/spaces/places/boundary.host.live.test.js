import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLiveHostPlace, harness, LIVE_HOSTD_ENABLED, rootRun, unitProperty } from './host-live-support.js';

const createSpec = () => ({ id: crypto.randomBytes(6).toString('hex'), name: 'Host boundary', project: '1234567890abcdef', created: new Date().toISOString(), memoryBytes: 1024 ** 3 });

describe.skipIf(!LIVE_HOSTD_ENABLED)('host kernel boundary', () => {
  const spec = createSpec();
  const other = createSpec();
  let live;
  const markers = [];
  const inside = (argv, options) => live.place.exec(spec.id, argv, options);
  // Only disposable mutated code copies read this root-owned fixture switch. Product code
  // has no switch. Activate after setup so a surviving startup check cannot hide sensitivity.
  const activateMutation = () => rootRun('/usr/bin/node', ['-e', 'require("node:fs").writeFileSync("/run/hostd-mutation-active","")']);
  afterEach(async () => { await rootRun('/usr/bin/node', ['-e', 'require("node:fs").rmSync("/run/hostd-mutation-active",{force:true})']); });

  beforeAll(async () => {
    live = createLiveHostPlace();
    await live.place.create(spec);
    await live.place.create(other);
  }, 180_000);

  afterAll(async () => {
    for (const file of markers) await rootRun('/usr/bin/node', ['-e', 'require("node:fs").rmSync(process.argv[1],{force:true})', file]);
    await live?.dispose();
  }, 60_000);

  it('pins a gatekeeper namespace owned by its dedicated non-root net user', async () => {
    // Given an independent disposable topology, without slirp. This isolates namespace
    // ownership from slirp's independent refusal to enter a root-owned user namespace.
    const id = crypto.randomBytes(6).toString('hex');
    const source = process.env.OPENCHAMBER_HOSTD_TEST_ROOT ?? '/opt/openchamber-dev/server/lib/hostd';
    const owner = 'open my $net,"<",$ARGV[0] or die $!; my $fd=ioctl($net,0xb701,0); defined($fd) or die $!; open my $user,"<&=$fd" or die $!; my $uid=pack("I",0); ioctl($user,0xb704,$uid) or die $!; print unpack("I",$uid);';
    const program = `
      const {createNetwork}=await import(${JSON.stringify(`${source}/network.js`)});
      const {createSystem}=await import(${JSON.stringify(`${source}/system.js`)});
      const {layout,createState}=await import(${JSON.stringify(`${source}/state.js`)});
      const {execFileSync}=await import('node:child_process');
      const paths=layout(),system=createSystem(),ipPath=await system.ipPath();
      await createState(paths).initialize();
      const network=createNetwork({system,paths,ipPath});
      try {
        await network.create({id:process.argv[1],subnet:16000});
        const expected=execFileSync('/usr/bin/getent',['passwd','openchamber-net-'+process.argv[1]],{encoding:'utf8'}).split(':')[2];
        const actual=execFileSync('/usr/bin/perl',['-e',${JSON.stringify(owner)},paths.pins+'/'+process.argv[1]+'/net'],{encoding:'utf8'});
        console.log(JSON.stringify({expected:Number(expected),actual:Number(actual)}));
      } finally {await network.destroy(process.argv[1]);await system.run('/usr/sbin/userdel',['openchamber-net-'+process.argv[1]]);}
    `;
    // When the kernel reports the owner through NS_GET_USERNS / NS_GET_OWNER_UID.
    await activateMutation();
    const result = JSON.parse((await rootRun('/usr/bin/node', ['--input-type=module', '-e', program, id])).stdout);
    // Then ownership belongs to the static non-root account, not host root.
    expect(result.expected).toBeGreaterThan(0);
    expect(result.actual).toBe(result.expected);
  });

  it('keeps the veth-confined executor away from a live host listener', async () => {
    const listener = await live.host.startHostListener();
    try {
      const script = `const net=require('node:net');Promise.all(${JSON.stringify(listener.candidates)}.map(host=>new Promise(resolve=>{const s=net.connect({host,port:${listener.port}});s.on('connect',()=>{s.destroy();resolve(true)});s.on('error',()=>resolve(false));s.setTimeout(2000,()=>{s.destroy();resolve(false)})}))).then(v=>console.log(JSON.stringify(v)));`;
      expect(JSON.parse((await live.host.runUnrestricted(script)).stdout)).toContain(true);
      await activateMutation();
      const result = await inside(['/usr/bin/node', '-e', script]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).not.toContain(true);
    } finally { await listener.stop(); }
  });

  it('runs internet-capable slirp without initial-user-namespace capabilities', async () => {
    await activateMutation();
    // Rebuild only slirp after the fixture is up, using the implementation under test.
    // Namespace pins and the gatekeeper remain, so a capability mutant can run normally.
    const source = process.env.OPENCHAMBER_HOSTD_TEST_ROOT ?? '/opt/openchamber-dev/server/lib/hostd';
    const rebuild = `const fs=await import('node:fs/promises');const {execFileSync}=await import('node:child_process');const {buildUnits,names}=await import(${JSON.stringify(`${source}/units.js`)});const {layout}=await import(${JSON.stringify(`${source}/state.js`)});const record=JSON.parse(await fs.readFile('/var/lib/openchamber-hostd/spaces/'+process.argv[1]+'.json','utf8'));const name=names(record.id).net;execFileSync('/usr/bin/systemctl',['stop',name]);await fs.writeFile('/run/systemd/system/'+name,buildUnits({record,paths:layout(),ipPath:'/usr/bin/ip'})[name]);execFileSync('/usr/bin/systemctl',['daemon-reload']);execFileSync('/usr/bin/systemctl',['start',name]);`;
    await rootRun('/usr/bin/node', ['--input-type=module', '-e', rebuild, spec.id]);
    const internet = await live.place.exec(spec.id, ['/usr/bin/curl', '--disable', '--noproxy', '*', '--silent', '--fail', '--max-time', '15', 'https://example.com/'], { target: 'gatekeeper' });
    expect(internet.code, internet.stderr).toBe(0);
    expect(internet.stdout).toContain('Example Domain');
    const pid = await unitProperty(spec.id, 'net', 'MainPID');
    const status = (await rootRun('/bin/cat', [`/proc/${pid}/status`])).stdout;
    const expected = (await rootRun('/usr/bin/getent', ['passwd', `openchamber-net-${spec.id}`])).stdout.split(':')[2];
    expect(status).toMatch(new RegExp(`^Uid:\\s+${expected}\\s+${expected}\\s+${expected}\\s+${expected}$`, 'm'));
    for (const key of ['CapEff', 'CapPrm', 'CapBnd', 'CapAmb']) expect(status).toMatch(new RegExp(`^${key}:\\s+0000000000000000$`, 'm'));
    expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
    expect(status).toMatch(/^Seccomp:\s+2$/m);
  });

  it('has writable private shared memory without seeing host shared memory', async () => {
    const file = `/dev/shm/hostd-bait-${spec.id}`;
    markers.push(file);
    await rootRun('/usr/bin/node', ['-e', 'require("node:fs").writeFileSync(process.argv[1],"host-only",{mode:420})', file]);
    expect((await rootRun('/bin/cat', [file])).stdout).toBe('host-only');
    await activateMutation();
    const result = await inside(['/bin/sh', '-c', 'printf own > /dev/shm/own && cat /dev/shm/own; cat "$1"', 'sh', file]);
    expect(result.stdout).toBe('own');
    expect(result.code).not.toBe(0);
  });

  it('cannot see another space state even when that space makes its files world-readable', async () => {
    const target = `/var/lib/private/openchamber-spaces/${other.id}/home/public-bait`;
    const planted = await live.place.exec(other.id, ['/bin/sh', '-c', 'chmod 755 /home/space; printf other-space > /home/space/public-bait; chmod 644 /home/space/public-bait; cat /home/space/public-bait']);
    expect(planted).toMatchObject({ code: 0, stdout: 'other-space' });
    await rootRun('/usr/bin/chmod', ['755', `/var/lib/private/openchamber-spaces/${other.id}`]);
    expect((await rootRun('/bin/cat', [target])).stdout).toBe('other-space');
    await activateMutation();
    const result = await inside(['/bin/cat', target]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('preserves the empty capability bounding set in exec units as in the main unit', async () => {
    const mainPid = await unitProperty(spec.id, 'space', 'MainPID');
    const main = (await rootRun('/bin/cat', [`/proc/${mainPid}/status`])).stdout;
    expect(main).toMatch(/^CapBnd:\s+0000000000000000$/m);
    await activateMutation();
    const result = await inside(['/bin/cat', '/proc/self/status']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^CapBnd:\s+0000000000000000$/m);
  });

  it('keeps exec in the same resource-limited slice as its main process', async () => {
    const mainPid = await unitProperty(spec.id, 'space', 'MainPID');
    const main = (await rootRun('/bin/cat', [`/proc/${mainPid}/cgroup`])).stdout;
    expect(main).toContain(`/openchamber-space-${spec.id}.slice/`);
    await activateMutation();
    const result = await inside(['/bin/cat', '/proc/self/cgroup']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`/openchamber-space-${spec.id}.slice/`);
  });

  it('hides the owner socket and owner home under the complete exec sandbox', async () => {
    const owner = `/home/dev/hostd-owner-${spec.id}`;
    markers.push(owner);
    await rootRun('/usr/bin/node', ['-e', 'require("node:fs").writeFileSync(process.argv[1],"owner-only",{mode:420})', owner]);
    // The file is intentionally public to isolate ProtectHome from ordinary DAC denial.
    await rootRun('/usr/bin/chmod', ['755', '/home/dev']);
    await activateMutation();
    const result = await inside(['/bin/sh', '-c', 'cat "$1"; test -S /run/openchamber-hostd/hostd.sock', 'sh', owner]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('stops an overlong command and all its descendants before rejecting', async () => {
    const file = `/home/space/timeout-pid`;
    await expect(inside(['/bin/sh', '-c', 'sleep 100 & echo $! > "$1"; wait', 'sh', file], { timeoutMs: 10000 })).rejects.toMatchObject({ code: 'command_timeout' });
    const pid = (await inside(['/bin/cat', file])).stdout.trim();
    expect(pid).toMatch(/^[1-9]\d*$/);
    const result = await harness({ op: 'run', file: '/bin/kill', args: ['-0', pid] });
    expect(result.code).not.toBe(0);
  });

  it('applies the output cap to command data without counting its startup acknowledgement', async () => {
    expect(await inside(['/usr/bin/printf', 'abc'], { maxOutputBytes: 3 })).toMatchObject({ code: 0, stdout: 'abc' });
    await expect(inside(['/usr/bin/printf', 'abcd'], { maxOutputBytes: 3 })).rejects.toMatchObject({ code: 'command_output_too_large' });
  });
});
