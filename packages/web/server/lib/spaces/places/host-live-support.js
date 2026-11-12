// Test-only observations through the disposable harness's root fixture, never through hostd.
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { expect } from 'vitest';
import { createHostPlace } from './host.js';
import { createPackedToolsSource, readHostToolVersions } from '../tools.js';
import { addresses } from '../../hostd/state.js';
import { createHostdClient } from '../../hostd/client.js';
import { createSpaceServerChannel } from '../space-server.js';
import { unitQuote } from '../../hostd/units.js';

export const LIVE_HOSTD_ENABLED = process.env.OPENCHAMBER_TEST_HOSTD === '1';
export const harness = (request) => new Promise((resolve, reject) => {
  const socket = net.createConnection('/run/hostd-test.sock');
  let answer = '';
  socket.on('error', reject);
  socket.on('data', (chunk) => { answer += chunk; });
  socket.on('end', () => {
    try { const value = JSON.parse(answer); if (!value.ok) throw new Error(value.message); resolve(value.result); }
    catch (error) { reject(error); }
  });
  socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
});
export const rootRun = async (file, args, stdin = '') => {
  const result = await harness({ op: 'run', file, args, stdin });
  expect(result.code, result.stderr).toBe(0);
  return result;
};
export const unitProperty = async (id, target, property) => (await rootRun('/usr/bin/systemctl', ['show', `openchamber-${target === 'space' ? 'space' : target === 'gatekeeper' ? 'gk' : 'net'}-${id}.service`, '-p', property, '--value'])).stdout.trim();
export const liveHostUid = (id, target) => unitProperty(id, target, 'UID');

export function createLiveHostPlace() {
  const packed = fileURLToPath(new URL('../../../../../../.omo/harness/packed/', import.meta.url));
  const toolsSource = createPackedToolsSource({ webTarballPath: `${packed}/openchamber-web-2.6.3.tgz`, sdkTarballPath: `${packed}/openchamber-sdk-2.6.3.tgz`, openCodeVersion: readHostToolVersions().openCodeVersion });
  const place = createHostPlace({ toolsSource, clientScript: '/opt/openchamber-dev/server/lib/hostd/attach-client.js' });
  const made = new Set();
  const create = place.create;
  place.create = async (...args) => { made.add(args[0].id); return create(...args); };
  const helpers = new Set();
  const metadata = async (id) => JSON.parse((await rootRun('/bin/cat', [`/var/lib/openchamber-hostd/spaces/${id}.json`])).stdout);
  const namespace = (id) => `--net=/run/openchamber-hostd/ns/${id}/net`;
  const gkRun = (id, script) => rootRun('/usr/bin/nsenter', [namespace(id), '--', '/usr/bin/node', '-e', script]);
  const start = async (file, args) => {
    const result = await harness({ op: 'start', file, args });
    helpers.add(result.key);
    return { ...result, stop: async () => { helpers.delete(result.key); await harness({ op: 'stop', key: result.key }); } };
  };
  const host = {
    metadata,
    runUnrestricted: (script) => rootRun('/usr/bin/node', ['-e', script]),
    startHostListener: async () => {
      const helper = await start('/usr/bin/node', ['-e', 'const net=require("node:net"),os=require("node:os");const s=net.createServer(c=>{c.on("error",()=>{});c.end("host")});s.listen(0,"0.0.0.0",()=>console.log(JSON.stringify({port:s.address().port,candidates:Object.values(os.networkInterfaces()).flat().filter(a=>a.family==="IPv4"&&!a.internal).map(a=>a.address)})))']);
      return { ...JSON.parse(helper.first), stop: helper.stop };
    },
    // The host comparison removes the separate netns entirely. It is the unisolated control
    // corresponding to Docker's plain internal bridge, not a claim that a bridge exists here.
    createPlainInternalNetwork: async () => ({ run: host.runUnrestricted, remove: async () => {} }),
    spaceMetadata: async (id) => `${JSON.stringify(await metadata(id))}\n${(await rootRun('/usr/bin/systemctl', ['show', '--all', `openchamber-space-${id}.service`])).stdout}`,
    gatekeeperMetadata: async (id) => (await rootRun('/usr/bin/systemctl', ['show', '--all', `openchamber-gk-${id}.service`])).stdout,
    spaceAddress: async (id) => addresses((await metadata(id)).subnet).space,
    gatekeeperAddresses: async (id) => ({ inner: addresses((await metadata(id)).subnet).gatekeeper, outer: '10.0.2.100' }),
    // slirp's outer tap is inside the gatekeeper netns. A helper in that netns tests the
    // outer interface listener bindings. The upstream alias is fixture-owned, never public DNS.
    probeFromOuterNetwork: (id, script) => gkRun(id, script.replaceAll("'upstream'", "'10.0.2.100'")),
    startWindowUpstream: async (id) => {
      const program = 'const c=require("node:crypto");const hash=v=>v===undefined?"none":"sha256:"+c.createHash("sha256").update(String(v)).digest("hex");require("node:http").createServer((q,r)=>{const body={path:q.url,authorization:hash(q.headers.authorization),apiKey:hash(q.headers["x-api-key"]),headerNames:Object.keys(q.headers).sort()};q.resume();q.on("end",()=>r.end(JSON.stringify(body)))}).listen(9000,"10.0.2.100",()=>console.log("ready"));';
      const helper = await start('/usr/bin/nsenter', [namespace(id), '--', '/usr/bin/node', '-e', program]);
      return { url: 'http://10.0.2.100:9000/v1', stop: helper.stop };
    },
    startBlockedName: async (id) => {
      // Host places have no Docker embedded resolver. This root-owned hosts fixture establishes
      // the same deterministic private-address resolution without involving any public DNS.
      const file = `/run/openchamber-hostd/ns/${id}/gatekeeper-hosts`;
      await rootRun('/usr/bin/node', ['-e', `require("node:fs").appendFileSync(process.argv[1],${JSON.stringify('10.0.2.100 blocked-by-address.test\n')});`, file]);
      return { alias: 'blocked-by-address.test', address: '10.0.2.100', stop: async () => {} };
    },
    startCredentialProcess: async (id, decoy) => {
      const stream = await createHostdClient().attach({ op: 'attach', place: 'host', id, argv: ['/usr/bin/env', `DECOY_TOKEN=${decoy}`, '/usr/bin/node', '-e', 'console.log("ready"); process.stdin.resume();'] });
      const [ready] = await once(stream, 'data');
      expect(ready.toString()).toBe('ready\n');
      return { stop: async () => { const closed = once(stream, 'close'); stream.destroy(); await closed; } };
    },
    floodLogs: async (id) => {
      // The unit's quoting, done here: the root program takes the finished line as an argument.
      const execStart = `ExecStart=:${['/bin/sh', '-c', 'head -c 52428800 /dev/zero | tr "\\0" x | fold -w 1000'].map(unitQuote).join(' ')}`;
      const program = `
        const fs=await import('node:fs/promises');
        const {execFileSync}=await import('node:child_process');
        const unit='openchamber-space-'+process.argv[1]+'.service';
        const file='/run/systemd/system/'+unit;
        const before=await fs.readFile(file,'utf8');
        try {
          execFileSync('/usr/bin/systemctl',['stop',unit]);
          await fs.writeFile(file,before.replace(/^ExecStart=.*$/m,()=>process.argv[2]));
          execFileSync('/usr/bin/systemctl',['daemon-reload']);
          execFileSync('/usr/bin/systemctl',['start','--wait',unit]);
        } finally {
          await fs.writeFile(file,before);
          execFileSync('/usr/bin/systemctl',['daemon-reload']);
          execFileSync('/usr/bin/systemctl',['start',unit]);
        }
      `;
      const result = await rootRun('/usr/bin/node', ['--input-type=module', '-e', program, id, execStart]);
      await createSpaceServerChannel({ exec: place.exec }).waitUntilReady(id);
      return result;
    },
    logBytes: async (id) => Buffer.byteLength((await rootRun('/usr/bin/journalctl', ['-u', `openchamber-space-${id}.service`, '--no-pager', '-o', 'cat'])).stdout),
  };
  const dispose = async () => {
    for (const key of helpers) await harness({ op: 'stop', key });
    for (const id of made) expect((await place.remove(id)).failed).toEqual([]);
  };
  return { place, host, dispose };
}
