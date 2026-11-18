import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createCodeIn } from '../spaces/code-in.js';
import { createCodeOut } from '../spaces/code-out.js';
import { createHostGit } from '../spaces/host-git.js';
import { runCommand } from '../spaces/run-command.js';
import { IMAGE_ONLY_PATH } from '../spaces/layout.js';
import { botGit } from './production-git.js';
import { productionFixture, commitFiles } from './production-test-support.js';

const execFileAsync = promisify(execFile);
const spaceId = 'a1b2c3d4e5f6';
const spacePath = `/spaces/${spaceId}/repository`;

/** Real code-out quarantine with a controlled local upload-pack in place of Docker exec. */
export async function isolatedProductionFixture() {
  const f = await productionFixture();
  try {
    f.bot.isolated = true;
    const checkout = await f.makeWorktrees().create(f.request);
    Object.assign(f.item, { worktree: checkout.directory, branch: checkout.branch });
    const inside = path.join(f.root, 'inside');
    await fs.mkdir(inside);
    await botGit(inside, ['init', '--quiet', '--initial-branch=fixing']);
    await botGit(inside, ['-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', checkout.directory, 'HEAD:refs/openchamber/source']);
    await botGit(inside, ['checkout', '--quiet', '-B', 'fixing', 'refs/openchamber/source']);
    await botGit(inside, ['config', 'user.name', 'selected-bot']);
    await botGit(inside, ['config', 'user.email', '42+selected-bot@users.noreply.github.com']);
    const environment = { PATH: process.env.PATH, HOME: f.root, SystemRoot: process.env.SystemRoot,
      GIT_MASTER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
    const git = createHostGit({ runCommand, environment });
    await createCodeIn({ git, temporaryDirectory: f.root }).takeSnapshot({ repository: checkout.directory, spaceId, mode: 'clean' });
    const receiver = path.join(f.root, 'upload.cjs');
    await fs.writeFile(receiver, `const cp=require('node:child_process');
const [inside,...args]=process.argv.slice(2);
if(args.length!==7||args[0]!=='/usr/bin/timeout'||args[1]!=='-s'||args[2]!=='KILL'||!/^\\d+$/.test(args[3])||args[4]!=='/usr/bin/git'||args[5]!=='upload-pack'||args[6]!==${JSON.stringify(spacePath)})process.exit(2);
const result=cp.spawnSync('/usr/bin/git',['upload-pack',inside],{stdio:'inherit',shell:false});process.exit(result.status??1);`);
    const place = {
      execArgv: async (id) => {
        if (id !== spaceId) throw new Error('Wrong stand-in space');
        return [process.execPath, receiver, inside];
      },
      exec: async (id, argv, { timeoutMs }) => {
        if (id !== spaceId || argv[0] !== '/usr/bin/timeout' || argv[4] !== '/bin/sh' || argv[5] !== '-c'
          || !argv[6].startsWith(IMAGE_ONLY_PATH)) throw new Error('Unexpected stand-in command');
        const script = `PATH=${JSON.stringify(process.env.PATH)};${argv[6].slice(IMAGE_ONLY_PATH.length)}`;
        return runCommand('/bin/sh', ['-c', script, argv[7], ...argv.slice(8).map((arg) => arg === spacePath ? inside : arg)], { env: environment, timeoutMs });
      },
    };
    const codeOut = createCodeOut({ git, place, temporaryDirectory: f.root });
    return { ...f, checkout, inside, spaceId,
      async exportSnapshot() {
        const result = await codeOut.bringCodeOut({ repository: checkout.directory, spaceId, spacePath });
        return { ...result, spaceId, directory: spacePath, repository: checkout.directory, resultSha: result.result };
      },
      async correction() {
        const testSha = await commitFiles(inside, { 'regression.test.mjs': "import fs from 'node:fs';\nprocess.exit(fs.readFileSync('old.js','utf8').includes('value = 2') ? 0 : 1);\n" }, 'Isolated regression');
        const fixSha = await commitFiles(inside, { 'old.js': 'export const value = 2;\n' }, 'Isolated correction');
        return { testSha, fixSha };
      },
      async plantHostExecutionBait() {
        const marker = path.join(f.root, 'host-program-ran');
        const program = path.join(f.root, 'filter.sh');
        const hooks = path.join(f.root, 'hooks');
        await fs.mkdir(hooks);
        await fs.writeFile(program, `#!/bin/sh\nprintf ran >> '${marker}'\ncat\n`, { mode: 0o700 });
        for (const name of ['post-checkout', 'post-index-change', 'reference-transaction']) {
          await fs.writeFile(path.join(hooks, name), `#!/bin/sh\nprintf hook >> '${marker}'\n`, { mode: 0o700 });
        }
        await botGit(checkout.directory, ['config', 'core.hooksPath', hooks]);
        for (const kind of ['clean', 'smudge']) await botGit(checkout.directory, ['config', `filter.host-bait.${kind}`, `sh '${program}'`]);
        await botGit(checkout.directory, ['config', 'filter.host-bait.required', 'true']);
        // Ordinary Git is the positive control for a working host-side program.
        await fs.rm(path.join(inside, 'result.payload'));
        await execFileAsync('git', ['-C', inside, '-c', 'core.hooksPath=', '-c', `filter.host-bait.smudge=sh '${program}'`,
          'checkout-index', '--all', '--force'], { env: environment, shell: false, windowsHide: true });
        if (!(await fs.readFile(marker, 'utf8')).includes('ran')) throw new Error('Filter positive control did not execute');
        await fs.rm(marker);
        return marker;
      },
    };
  } catch (error) { await f.close(); throw error; }
}
