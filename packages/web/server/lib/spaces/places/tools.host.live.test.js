import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveHostPlace, LIVE_HOSTD_ENABLED, rootRun } from './host-live-support.js';
import { readHostToolVersions } from '../tools.js';

describe.skipIf(!LIVE_HOSTD_ENABLED)('host selected tools', () => {
  const id = crypto.randomBytes(6).toString('hex');
  let live;
  beforeAll(() => { live = createLiveHostPlace(); });
  afterAll(async () => { await live?.dispose(); });
  it('starts and executes the sealed programs when conflicting global programs exist', async () => {
    const program = `
      const fs=require('node:fs');
      for(const name of ['openchamber','opencode']){
        const file='/usr/local/bin/'+name,backup=file+'.hostd-bait-'+process.argv[1];
        if(process.argv[2]==='install'){
          if(fs.existsSync(file))fs.renameSync(file,backup);
          fs.writeFileSync(file,'#!/bin/sh\\nprintf global-bait\\nexit 91\\n',{mode:493});
        }else{fs.rmSync(file,{force:true});if(fs.existsSync(backup))fs.renameSync(backup,file);}
      }
    `;
    await rootRun('/usr/bin/node', ['-e', program, id, 'install']);
    try {
      expect((await rootRun('/bin/sh', ['-c', '/usr/local/bin/openchamber; test "$?" = 91'])).stdout).toBe('global-bait');
      const spec = { id, name: 'Selected tools', project: '1234567890abcdef', created: new Date().toISOString(), memoryBytes: 1024 ** 3 };
      await live.place.create(spec);
      const web = await live.place.exec(id, ['openchamber', '--version']);
      expect(web.code, web.stderr).toBe(0);
      expect(web.stdout).toMatch(/^2\.6\.3/);
      const opencode = await live.place.exec(id, ['opencode', '--version']);
      expect(opencode.code, opencode.stderr).toBe(0);
      expect(opencode.stdout).not.toContain('global-bait');
      expect(opencode.stdout).toBe(`opencode v${readHostToolVersions().openCodeVersion}\n`);
    } finally {
      await live.place.remove(id);
      await rootRun('/usr/bin/node', ['-e', program, id, 'restore']);
    }
  }, 180_000);
});
