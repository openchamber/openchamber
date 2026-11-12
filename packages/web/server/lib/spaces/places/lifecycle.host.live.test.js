import crypto from 'node:crypto';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostdClient } from '../../hostd/client.js';
import { createLiveHostPlace, harness, LIVE_HOSTD_ENABLED, rootRun, unitProperty } from './host-live-support.js';

describe.skipIf(!LIVE_HOSTD_ENABLED)('host idle-stop restart', () => {
  const spec = { id: crypto.randomBytes(6).toString('hex'), name: 'Idle restart', project: '1234567890abcdef', created: new Date().toISOString(), memoryBytes: 1024 ** 3 };
  let live;
  beforeAll(async () => { live = createLiveHostPlace(); await live.place.create(spec); }, 180_000);
  afterAll(async () => { await live?.dispose(); }, 60_000);
  it('records exit 75 and restarts with its still-live gatekeeper on the new namespace', async () => {
    const previous = await unitProperty(spec.id, 'gatekeeper', 'MainPID');
    const program = `
      const fs=await import('node:fs/promises');
      const {execFileSync}=await import('node:child_process');
      const name='openchamber-space-'+process.argv[1]+'.service';
      const file='/run/systemd/system/'+name;
      const before=await fs.readFile(file,'utf8');
      execFileSync('/usr/bin/systemctl',['stop',name]);
      try {
        await fs.writeFile(file,before.replace(/^ExecStart=.*$/m,'ExecStart=:/bin/sh -c "exit 75"'));
        execFileSync('/usr/bin/systemctl',['daemon-reload']);
        try{execFileSync('/usr/bin/systemctl',['start','--wait',name]);}catch(error){if(error.status!==1)throw error;}
      } finally {await fs.writeFile(file,before);execFileSync('/usr/bin/systemctl',['daemon-reload']);}
    `;
    await rootRun('/usr/bin/node', ['--input-type=module', '-e', program, spec.id]);
    const entry = (await live.place.list()).find((item) => item.id === spec.id);
    expect(entry).toMatchObject({ state: 'exited', stoppedIdle: true, gatekeeperRunning: true });
    await live.place.start(spec.id);
    expect(await unitProperty(spec.id, 'gatekeeper', 'MainPID')).not.toBe(previous);
    expect(await live.place.verify(spec.id)).toEqual([]);
    expect(await live.place.exec(spec.id, ['/usr/bin/printf', 'restarted'])).toMatchObject({ code: 0, stdout: 'restarted' });
  }, 120_000);
  it('refuses agent-selected symlink mount sources at the next start', async () => {
    const base = `/var/lib/private/openchamber-spaces/${spec.id}`;
    await live.place.stop(spec.id);
    // Simulate persisted state from before source parents were read-only. Current
    // main and exec units cannot perform this replacement while the space runs.
    await rootRun('/usr/bin/node', ['-e', 'const fs=require("node:fs");fs.renameSync(process.argv[1]+"/home",process.argv[1]+"/home-original");fs.symlinkSync(process.argv[1]+"/home-original",process.argv[1]+"/home");', base]);
    await rootRun('/usr/bin/node', ['-e', 'require("node:fs").writeFileSync("/run/hostd-mutation-active","")']);
    try {
      await expect(live.place.start(spec.id)).rejects.toMatchObject({ code: 'space_state_unsafe' });
    } finally {
      await rootRun('/usr/bin/node', ['-e', 'const fs=require("node:fs");fs.rmSync("/run/hostd-mutation-active",{force:true});fs.unlinkSync(process.argv[1]+"/home");fs.renameSync(process.argv[1]+"/home-original",process.argv[1]+"/home");', base]);
    }
    await live.place.start(spec.id);
    expect(await live.place.verify(spec.id)).toEqual([]);
  }, 120_000);
  it('stops an active exec with its target before releasing the space state', async () => {
    await rootRun('/usr/bin/node', ['-e', 'require("node:fs").writeFileSync("/run/hostd-mutation-active","")']);
    const stream = await createHostdClient().attach({ op: 'attach', place: 'host', id: spec.id, argv: ['/usr/bin/node', '-e', 'console.log(process.pid);process.stdin.resume();'] });
    try {
      const pid = (await once(stream, 'data'))[0].toString().trim();
      expect(pid).toMatch(/^[1-9]\d*$/);
      expect((await rootRun('/bin/kill', ['-0', pid])).code).toBe(0);
      await live.place.stop(spec.id);
      const stopped = await harness({ op: 'run', file: '/bin/kill', args: ['-0', pid] });
      expect(stopped.code).not.toBe(0);
    } finally {
      stream.destroy();
      await rootRun('/usr/bin/node', ['-e', 'require("node:fs").rmSync("/run/hostd-mutation-active",{force:true})']);
      await live.place.start(spec.id);
    }
  }, 120_000);
  it.each(['exec', 'attach'])('keeps %s on the running main unit mounts after the agent swaps a source symlink', async (operation) => {
    const base = `/var/lib/private/openchamber-spaces/${spec.id}`;
    const owner = `/home/dev/hostd-exec-owner-${spec.id}`;
    const pid = await unitProperty(spec.id, 'space', 'MainPID');
    await rootRun('/usr/bin/node', ['-e', 'const fs=require("node:fs");fs.mkdirSync(process.argv[1],{mode:493});fs.writeFileSync(process.argv[1]+"/public-bait","owner-public",{mode:420});', owner]);
    expect((await rootRun('/bin/cat', [`${owner}/public-bait`])).stdout).toBe('owner-public');
    try {
      await rootRun('/usr/bin/node', ['-e', 'require("node:fs").writeFileSync("/run/hostd-mutation-active","")']);
      const swapped = await live.place.exec(spec.id, ['/bin/sh', '-c', 'mv "$1/home" "$1/home-original" && ln -s "$2" "$1/home"', 'sh', base, owner]);
      let output;
      if (operation === 'exec') output = await live.place.exec(spec.id, ['/bin/cat', '/home/space/public-bait']);
      else {
        const stream = await createHostdClient().attach({ op: 'attach', place: 'host', id: spec.id, argv: ['/bin/cat', '/home/space/public-bait'] });
        const chunks = [];
        stream.end();
        for await (const chunk of stream) chunks.push(chunk);
        output = { code: stream.exitCode, stdout: Buffer.concat(chunks).toString() };
      }
      expect(output.stdout).toBe('');
      expect(output.code).not.toBe(0);
      expect(swapped.code, swapped.stderr).not.toBe(0);
      expect(await unitProperty(spec.id, 'space', 'MainPID')).toBe(pid);
    } finally {
      await rootRun('/usr/bin/node', ['-e', 'const fs=require("node:fs");fs.rmSync("/run/hostd-mutation-active",{force:true});if(fs.lstatSync(process.argv[1]+"/home").isSymbolicLink()){fs.unlinkSync(process.argv[1]+"/home");fs.renameSync(process.argv[1]+"/home-original",process.argv[1]+"/home");}fs.rmSync(process.argv[2],{recursive:true,force:true});', base, owner]);
    }
  }, 120_000);
});
