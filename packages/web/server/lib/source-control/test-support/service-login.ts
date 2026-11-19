import fs from 'node:fs/promises';
import http from 'node:http';
import { readSourceControlProviderRequest } from '@openchamber/sdk';
import type { SourceControlJson, SourceControlJsonObject } from '@openchamber/sdk';

const isJsonObject = (value: SourceControlJson): value is SourceControlJsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type FixtureField = 'unreachable' | 'unavailable' | 'origin' | 'user' | 'id' | 'changedDuringRead'
  | 'target' | 'number' | 'repositoryId' | 'bindingRevision' | 'primaryRemote';

type FixtureResponseValue = SourceControlJson | undefined | { [key: string]: FixtureResponseValue };
type FixtureResponse = { [key: string]: FixtureResponseValue };

const readField = (value: SourceControlJson | undefined, field: FixtureField) => {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${field}')`);
  }
  return isJsonObject(value) ? value[field] : undefined;
};

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
  const state: SourceControlJson = JSON.parse(await fs.readFile(stateUrl, 'utf8'));
  const answer = (data: FixtureResponse) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, data }));
  const failure = (message: string, status: number, code: string) => res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ ok: false, error: { message, status, code } }));
  if (readField(state, 'unreachable')) {
    req.socket.destroy();
    return;
  }
  if (readField(state, 'unavailable')) return failure('The CLI could not answer', 503, 'CLI_UNAVAILABLE');
  if (call.method === 'auth.probe') return answer({ supported: true });
  const origin = readField(state, 'origin');
  const user = readField(state, 'user');
  if (call.method === 'auth.status') return answer({ user: call.session.instance === origin ? user : null });
  if (!user || !call.session.user || String(call.session.user.id) !== String(readField(user, 'id')) || readField(state, 'changedDuringRead')) {
    return failure('The CLI account changed', 409, 'ACCOUNT_CHANGED');
  }
  const identity = { provider: call.provider, instance: call.session.instance };
  const project = { ...identity, id: '1', owner: 'mona', name: 'teapot', url: `${origin}/mona/teapot` };
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
    const number = readField(readField(context, 'target'), 'number');
    return answer({ providerTarget: { number }, target: {
      repositoryId: readField(context, 'repositoryId'), bindingRevision: readField(context, 'bindingRevision'), primaryRemote: readField(context, 'primaryRemote'),
      project: { id: project.id, owner: project.owner, name: project.name }, number,
    } });
  }
  if (call.method === 'mutation.perform') return answer({});
  return failure('This fixture does not provide that operation', 501, 'UNSUPPORTED');
});
server.listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), '127.0.0.1');
