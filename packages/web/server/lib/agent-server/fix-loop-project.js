import fs from 'node:fs/promises';
import path from 'node:path';
import { line } from '../spaces/code-transfer.js';
import { runCommand } from '../spaces/run-command.js';
import { transferCaps, withBundleDirectory, writeBundle } from '../spaces/transfer-bundle.js';
import { fixLoopServiceError, headMetadataSchema } from './fix-loop-contract.js';
import { trustedFolders } from './git-trust.js';

export const APPROVAL_HEAD_REF = 'refs/openchamber/approval-head';

/** Agent-side project plumbing. No service here can address a Space or loop. */
export function createAgentFixLoopProject({ dataDir, environment = process.env, resolveGitPath = () => 'git' }) {
  const caps = transferCaps(environment);
  const options = { caps, environment, temporaryDirectory: path.join(dataDir, 'fix-loop-transfer'),
    runCommand: (_file, args, request) => runCommand(resolveGitPath(), args, request) };
  // The isolated git, in a registered project another account owns: trusted by exact path.
  const inProject = async (directory, work) => withBundleDirectory({ ...options, trust: await trustedFolders(directory) }, work);
  const metadata = async (git, directory, head) => {
    if (line(await git.output(directory, ['cat-file', '-t', head])) !== 'commit') throw fixLoopServiceError('agent_fix_loop_invalid_head', 409);
    const objectFormat = line(await git.output(directory, ['rev-parse', '--show-object-format']));
    const shallowFile = path.resolve(directory, line(await git.output(directory, ['rev-parse', '--git-path', 'shallow'])));
    let shallow = [];
    try {
      const handle = await fs.open(shallowFile, 'r');
      try {
        if ((await handle.stat()).size > caps.metadataBytes) throw fixLoopServiceError('agent_response_too_large');
        const buffer = Buffer.alloc(caps.metadataBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > caps.metadataBytes) throw fixLoopServiceError('agent_response_too_large');
        shallow = buffer.subarray(0, bytesRead).toString('utf8').split('\n').filter(Boolean);
      } finally { await handle.close(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return headMetadataSchema.parse({ head, objectFormat, shallow });
  };
  return {
    caps,
    readHead: ({ directory, head }) => inProject(directory, ({ git }) => metadata(git, directory, head)),
    exportHead: ({ directory: project, head }, file) => inProject(project, async ({ directory, git }) => {
      const read = await metadata(git, project, head);
      const repository = path.join(directory, 'head.git');
      await git.output(directory, ['init', '--quiet', '--bare', '--template=', '--object-format=sha1', repository]);
      const objects = path.resolve(project, line(await git.output(project, ['rev-parse', '--git-path', 'objects'])));
      await fs.writeFile(path.join(repository, 'objects/info/alternates'), `${objects}\n`);
      if (read.shallow.length) await fs.writeFile(path.join(repository, 'shallow'), `${read.shallow.join('\n')}\n`);
      await git.output(repository, ['update-ref', APPROVAL_HEAD_REF, head]);
      await writeBundle(git, repository, file, { caps, revisions: [APPROVAL_HEAD_REF] });
    }),
    captureRef: ({ directory, commit, expectedHead, localRef }) => inProject(directory, async ({ git }) => {
      if ((await git.run(directory, ['merge-base', '--is-ancestor', expectedHead, commit])).code !== 0) {
        throw fixLoopServiceError('agent_fix_loop_unrelated_result', 409);
      }
      await git.output(directory, ['update-ref', localRef, commit, '0'.repeat(40)]);
      return { commit, localRef };
    }),
  };
}
