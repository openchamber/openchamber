import fs from 'node:fs/promises';
import path from 'node:path';
import { buildExtUrl } from '../spaces/code-transfer.js';
import { IMAGE_GIT, IMAGE_TIMEOUT } from '../spaces/layout.js';
import { importBundle, receiveBundle, transferCaps, withBundleDirectory } from '../spaces/transfer-bundle.js';
import { APPROVAL_HEAD_REF } from '../agent-server/fix-loop-project.js';
import { FIX_LOOP_SERVICE_ROUTE, fixLoopServiceError } from '../agent-server/fix-loop-contract.js';

/** The front door sends only a checked, private mirror of the provider-reported head. */
export function createAgentHeadTransfer({ upstream, services, dataDir, environment, runCommand, gitPath }) {
  const caps = transferCaps(environment);
  return async (loop, snapshot, { manager, spaceId, spacePath }) => {
    await services.fetchHead(loop, snapshot);
    const input = { directory: loop.directory, head: snapshot.headSha };
    const metadata = await services.readHead(input);
    return withBundleDirectory({ caps, environment, runCommand, gitPath,
      temporaryDirectory: path.join(dataDir, 'spaces', 'transfers') }, async ({ directory, git }) => {
      const repository = path.join(directory, 'head');
      await git.output(directory, ['init', '--quiet', '--template=', '--object-format=sha1', repository]);
      if (metadata.shallow.length) await fs.writeFile(path.join(repository, '.git/shallow'), `${metadata.shallow.join('\n')}\n`);
      const file = path.join(directory, 'head.bundle');
      const response = await upstream.request({ path: `${FIX_LOOP_SERVICE_ROUTE}/head-bundle?${new URLSearchParams(input)}`,
        timeoutMs: caps.timeoutMs, headers: { accept: 'application/x-git-bundle' } });
      if (response.statusCode !== 200) { response.destroy(); throw fixLoopServiceError('agent_fix_loop_operation_failed'); }
      await receiveBundle(response, file, caps);
      await importBundle(git, repository, file, { caps, objectFormat: 'sha1', id: input.head, ref: APPROVAL_HEAD_REF });
      const url = buildExtUrl([...(await manager.execArgv(spaceId)), IMAGE_TIMEOUT, '-s', 'KILL', '305', IMAGE_GIT, 'receive-pack', spacePath]);
      await git.output(repository, ['-c', 'protocol.ext.allow=always', '-c', 'push.pushOption=', 'push', '--quiet',
        '--no-verify', '--no-signed', '--no-follow-tags', '--no-recurse-submodules', '--', url,
        `${input.head}:refs/heads/openchamber-fix-loop`], { timeoutMs: 300_000, killTree: true });
    });
  };
}
