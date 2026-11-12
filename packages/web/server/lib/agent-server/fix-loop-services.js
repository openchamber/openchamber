import { z } from 'zod';
import { readBoundedBody } from './agent-upstream.js';
import { FIX_LOOP_BYTES, FIX_LOOP_INPUT_BYTES, FIX_LOOP_OPERATIONS, FIX_LOOP_SERVICE_ROUTE, FIX_LOOP_TIMEOUT_MS,
  fixLoopServiceError, projectDirectorySchema } from './fix-loop-contract.js';

const codes = new Set(['agent_fix_loop_invalid_request', 'agent_fix_loop_invalid_response', 'agent_fix_loop_operation_failed',
  'agent_fix_loop_account_unavailable', 'agent_project_unregistered', 'agent_directory_invalid', 'agent_response_too_large',
  'agent_fix_loop_unrelated_result', 'agent_unreachable', 'agent_login_failed', 'agent_session_expired', 'agent_redirected']);
const hostSession = z.object({ data: z.object({ id: z.string().regex(/^ses_[A-Za-z0-9]{1,128}$/),
  location: z.object({ directory: projectDirectorySchema }) }) });
const coordinates = (loop) => ({ owner: loop.owner, repo: loop.repo, number: loop.number });
// A loop's GitHub account, which the agent server resolves to its own client.
const accountIdSchema = z.string().min(1);

/** Reconstruct every reply. No agent object is a loop, worker or publication authority. */
export function createAgentFixLoopServices(upstream) {
  const call = async (operation, value) => {
    const contract = FIX_LOOP_OPERATIONS[operation];
    const input = contract.input.safeParse(value);
    if (!input.success) throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    const body = JSON.stringify(input.data);
    if (Buffer.byteLength(body) > FIX_LOOP_INPUT_BYTES) throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    try {
      const response = await upstream.request({ path: `${FIX_LOOP_SERVICE_ROUTE}/${operation}`, method: 'POST', body,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        // A failed-checks read downloads up to five whole job logs on the agent.
        timeoutMs: ['fetch-head', 'publish', 'failed-checks'].includes(operation) ? 600_000 : FIX_LOOP_TIMEOUT_MS });
      let reply;
      try { reply = JSON.parse(await readBoundedBody(response, FIX_LOOP_BYTES)); }
      catch (error) { throw fixLoopServiceError(error.code === 'agent_response_too_large' ? error.code : 'agent_fix_loop_invalid_response'); }
      if (response.statusCode !== 200) throw fixLoopServiceError(codes.has(reply?.code) ? reply.code : 'agent_fix_loop_operation_failed',
        response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502,
        operation === 'review-operation' && reply?.reviewNotDispatched === true ? { fixLoopReviewNotDispatched: true } : {});
      const parsed = contract.reply.safeParse(reply);
      if (!parsed.success) throw fixLoopServiceError('agent_fix_loop_invalid_response');
      return parsed.data;
    } catch (error) {
      if (codes.has(error?.code)) throw error;
      throw fixLoopServiceError('agent_fix_loop_operation_failed');
    }
  };
  const requireIdentity = (valid) => { if (!valid) throw fixLoopServiceError('agent_fix_loop_invalid_response'); };
  const readInput = ({ octokit, ...input }) => ({ ...input, accountId: octokit?.accountId });
  return {
    // Handles carry no client, credential or token and cannot select ambient auth.
    getOctokit: async (accountId) => accountIdSchema.safeParse(accountId).success ? { accountId } : null,
    readFeedback: (input) => call('feedback', readInput(input)),
    readAuthorPermission: async (input) => (await call('author-permission', readInput(input))).permitted,
    readFailedChecks: (input) => call('failed-checks', readInput(input)),
    readBinding: (directory) => call('read-binding', { directory }),
    admit: async (input) => {
      const result = await call('admit', input);
      requireIdentity(JSON.stringify(result.context) === JSON.stringify(FIX_LOOP_OPERATIONS.admit.input.parse(input).context)
        && result.pull.owner.toLowerCase() === input.owner.toLowerCase() && result.pull.repo.toLowerCase() === input.repo.toLowerCase()
        && result.pull.number === input.number && result.pull.snapshot.state === 'open'
        && result.pull.branch === result.pull.snapshot.branch);
      return result;
    },
    fetchHead: async (loop, snapshot) => {
      const result = await call('fetch-head', { context: loop.readContext, ...coordinates(loop), head: snapshot.headSha });
      requireIdentity(result.head === snapshot.headSha);
    },
    captureRef: async (input) => {
      const result = await call('capture-ref', input);
      requireIdentity(result.commit === input.commit && result.localRef === input.localRef);
    },
    publish: (input, commit) => call('publish', { input, commit }),
    applyReviewOperation: ({ loop, receipt, operation, replayOnly = false }) => call('review-operation', {
      context: loop.readContext, ...coordinates(loop), commit: receipt.commit, ref: receipt.destination.ref, operation, replayOnly,
    }),
    readHead: async (input) => {
      const result = await call('head-metadata', input);
      requireIdentity(result.head === input.head);
      return result;
    },
    readHostSession: async (sessionId) => {
      if (!/^ses_[A-Za-z0-9]{1,128}$/.test(sessionId)) throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
      try {
        const result = hostSession.parse(await upstream.json(`/api/session/${encodeURIComponent(sessionId)}`)).data;
        requireIdentity(result.id === sessionId);
        return result;
      } catch (error) {
        if (codes.has(error?.code)) throw error;
        throw fixLoopServiceError('agent_fix_loop_invalid_response');
      }
    },
  };
}
