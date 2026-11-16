// Synthetic service used by the host integration test. The file stands in for
// a CLI's own login state; it contains no credentials and never calls a forge.
import fs from 'node:fs/promises';
import http from 'node:http';
import { readSourceControlProviderRequest } from '@openchamber/sdk';

const stateUrl = new URL('./login-state.json', import.meta.url);
const sha = 'b'.repeat(40);
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.OPENCHAMBER_SERVICE_TOKEN}`) {
    res.writeHead(401).end();
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const call = readSourceControlProviderRequest(body);
  if (!call?.session) {
    res.writeHead(400).end('Invalid source-control request');
    return;
  }
  const state = JSON.parse(await fs.readFile(stateUrl, 'utf8'));
  const answer = (data) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, data }));
  const failure = (message, status, code) => res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ ok: false, error: { message, status, code } }));
  if (state.unreachable) {
    req.socket.destroy();
    return;
  }
  if (state.unavailable) return failure('The CLI could not answer', 503, 'CLI_UNAVAILABLE');
  if (call.method === 'auth.probe') return answer({ supported: true });
  if (call.method === 'auth.status') return answer({ user: call.session.instance === state.origin ? state.user : null });
  if (!state.user || !call.session.user || String(call.session.user.id) !== String(state.user.id) || state.changedDuringRead) {
    return failure('The CLI account changed', 409, 'ACCOUNT_CHANGED');
  }
  const identity = { provider: call.provider, instance: call.session.instance };
  const project = { ...identity, id: '1', owner: 'mona', name: 'teapot', url: `${state.origin}/mona/teapot` };
  const pull = {
    ...identity, id: '2', number: 2, project, title: 'Synthetic service login change',
    url: `${project.url}/pulls/2`, state: 'open', draft: false, head: 'feature', base: 'main', headSha: sha,
  };
  if (call.method === 'listChangeRequests') return answer({ items: [pull], page: 1, hasMore: false });
  if (call.method === 'changeRequestContext') {
    return answer({ identity, project, changeRequest: pull, issueComments: [], reviewComments: [], files: [], diff: '', ci: null });
  }
  if (call.method === 'readChangeRequestHead') return answer({ project: { id: project.id, owner: project.owner, name: project.name }, headSha: sha, headBranch: 'feature', headOwner: 'mona' });
  if (call.method === 'mutation.resolveTarget') {
    const { context } = call.input;
    return answer({ providerTarget: { number: context.target.number }, target: {
      repositoryId: context.repositoryId, bindingRevision: context.bindingRevision, primaryRemote: context.primaryRemote,
      project: { id: project.id, owner: project.owner, name: project.name }, number: context.target.number,
    } });
  }
  if (call.method === 'mutation.perform') return answer({});
  return failure('This fixture does not provide that operation', 501, 'UNSUPPORTED');
});
server.listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), '127.0.0.1');
