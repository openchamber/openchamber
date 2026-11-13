import express from 'express';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { registeredTransferDirectory } from './space-transfer-routes.js';
import { createAgentFixLoopProject } from './fix-loop-project.js';
import { fitFeedback } from './fix-loop-feedback-contract.js';
import { FIX_LOOP_BYTES, FIX_LOOP_INPUT_BYTES, FIX_LOOP_OPERATIONS, FIX_LOOP_SERVICE_ROUTE,
  fixLoopServiceError, headInputSchema } from './fix-loop-contract.js';
import { streamBundle, withBundleDirectory } from '../spaces/transfer-bundle.js';

/** Register after normal API authentication. Each request executes one bounded operation. */
export function registerFixLoopServiceRoutes(app, { agentServer, readSettings, gitServices, getOctokit,
  readFeedback, readAuthorPermission, readFailedChecks, dataDir, resolveGitPath, environment, projectServices }) {
  if (!agentServer) return;
  const project = projectServices ?? createAgentFixLoopProject({ dataDir, resolveGitPath, environment });
  const parse = express.json({ limit: FIX_LOOP_INPUT_BYTES });
  const directoryOf = (input) => input.directory ?? input.context?.directory ?? input.input?.directory;
  const registered = async (input) => {
    const directory = await registeredTransferDirectory(directoryOf(input), readSettings);
    if (input.context) return { ...input, context: { ...input.context, directory } };
    if (input.input) return { ...input, input: { ...input.input, directory } };
    return { ...input, directory };
  };
  const clientFor = async (accountId) => {
    const client = await getOctokit(accountId);
    if (!client) throw fixLoopServiceError('agent_fix_loop_account_unavailable', 403);
    return client;
  };
  const execute = async (operation, input) => {
    switch (operation) {
      case 'admit': return gitServices().admit(input);
      case 'feedback': {
        const fitted = fitFeedback(await readFeedback({ ...input, octokit: await clientFor(input.accountId) }),
          { mentionText: input.mentionText, cap: FIX_LOOP_BYTES });
        if (!fitted) throw fixLoopServiceError('agent_response_too_large');
        return fitted;
      }
      case 'author-permission': return { permitted: await readAuthorPermission({ ...input, octokit: await clientFor(input.accountId) }) };
      case 'failed-checks': return readFailedChecks({ ...input, octokit: await clientFor(input.accountId) });
      case 'read-binding': return gitServices().readBinding(input.directory);
      case 'fetch-head':
        await gitServices().fetchHead({ ...input, directory: input.context.directory, readContext: input.context }, { headSha: input.head });
        return { head: input.head };
      case 'capture-ref': return project.captureRef(input);
      case 'head-metadata': return project.readHead(input);
      case 'publish': {
        const result = await gitServices().publish(input.input, input.commit);
        if (result?.state !== 'succeeded') throw fixLoopServiceError('agent_fix_loop_operation_failed', 409);
        return { state: 'succeeded' };
      }
      case 'review-operation':
        await gitServices().applyReviewOperation({ loop: { owner: input.owner, repo: input.repo, number: input.number, readContext: input.context },
          receipt: { commit: input.commit, destination: { ref: input.ref } }, operation: input.operation, replayOnly: input.replayOnly });
        return { ok: true };
      default: throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    }
  };
  app.post(`${FIX_LOOP_SERVICE_ROUTE}/:operation`, (req, res, next) => {
    parse(req, res, (error) => error ? res.status(400).json({ code: 'agent_fix_loop_invalid_request' }) : next());
  }, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const contract = Object.hasOwn(FIX_LOOP_OPERATIONS, req.params.operation) ? FIX_LOOP_OPERATIONS[req.params.operation] : null;
    const input = contract?.input.safeParse(req.body);
    if (!input?.success || new URL(req.originalUrl, 'http://agent').search || Buffer.byteLength(JSON.stringify(req.body)) > FIX_LOOP_INPUT_BYTES) {
      return res.status(400).json({ code: 'agent_fix_loop_invalid_request' });
    }
    try {
      const canonical = await registered(input.data);
      const result = contract.reply.safeParse(await execute(req.params.operation, canonical));
      if (!result.success) throw fixLoopServiceError('agent_fix_loop_invalid_response');
      if (req.params.operation === 'admit') {
        if (result.data.context.directory !== canonical.context.directory) throw fixLoopServiceError('agent_fix_loop_invalid_response');
        // Keep the caller's registered alias as display/session identity. Project operations use the checked canonical path.
        result.data.context.directory = input.data.context.directory;
      }
      const body = JSON.stringify(result.data);
      if (Buffer.byteLength(body) > FIX_LOOP_BYTES) throw fixLoopServiceError('agent_response_too_large');
      return res.type('json').send(body);
    } catch (error) {
      const codes = ['agent_project_unregistered', 'agent_directory_invalid', 'agent_fix_loop_account_unavailable',
        'agent_fix_loop_invalid_response', 'agent_response_too_large', 'agent_fix_loop_unrelated_result'];
      const code = codes.includes(error?.code) ? error.code : 'agent_fix_loop_operation_failed';
      const status = error?.sourceControlResponse?.status ?? error?.statusCode ?? error?.status;
      const reply = { code };
      if (req.params.operation === 'review-operation' && error.fixLoopReviewNotDispatched === true) reply.reviewNotDispatched = true;
      return res.status(code === 'agent_project_unregistered' || status === 401 ? 403 : Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502)
        .json(reply);
    }
  });
  app.get(`${FIX_LOOP_SERVICE_ROUTE}/head-bundle`, async (req, res) => {
    const query = new URL(req.originalUrl, 'http://agent').searchParams;
    const input = headInputSchema.safeParse(Object.fromEntries(query));
    if (!input.success || [...query.keys()].some((key) => query.getAll(key).length !== 1)) return res.status(400).json({ code: 'agent_fix_loop_invalid_request' });
    try {
      const canonical = await registered(input.data);
      await withBundleDirectory({ caps: project.caps, temporaryDirectory: path.join(dataDir, 'fix-loop-transfer') }, async ({ directory }) => {
        const file = path.join(directory, 'head.bundle');
        await project.exportHead(canonical, file);
        res.type('application/x-git-bundle');
        await streamBundle(createReadStream(file), res, project.caps);
      });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return res.status(error?.code === 'agent_project_unregistered' ? 403 : 502)
        .json({ code: error?.code === 'agent_project_unregistered' ? error.code : 'agent_fix_loop_operation_failed' });
    }
  });
}
