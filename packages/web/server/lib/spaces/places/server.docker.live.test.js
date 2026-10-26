// The server inside a space, on a real Docker daemon. Runs only with OPENCHAMBER_TEST_DOCKER=1.
// The host reaches the server only through `exec`, as stage 1b does.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSpaceId, hashProjectDirectory, toolsKeyFromVolumeName } from '../labels.js';
import { SPACE_SERVER_PORT, SPACE_TOKEN_PATH, TOOLS_MOUNT_PATH } from '../layout.js';
import { createGatekeeperChannel } from '../gatekeeper-channel.js';
import { createSpaceServerChannel } from '../space-server.js';
import { createRegistryToolsSource, readHostToolVersions } from '../tools.js';
import { LIVE_DOCKER_ENABLED, createLiveDockerPlace } from './docker-live-support.js';

const CREATE_TIMEOUT_MS = 25 * 60_000;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Runs inside the space. It logs in with the token file, opens a terminal, types two
// commands into its WebSocket and prints one JSON line. `ws` comes out of the tools volume.
// The protocol is the one in server/lib/terminal: a cookie, an Origin whose host equals
// Host, and binary frames of 0x01 plus JSON.
const TERMINAL_PROBE = `
const fs = require('node:fs');
const WebSocket = require('${TOOLS_MOUNT_PATH}/node_modules/ws');
const [tokenPath, port, cwd] = process.argv.slice(2);
const base = 'http://127.0.0.1:' + port;
const frame = (payload) => Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(payload), 'utf8')]);
const finish = (result) => { console.log(JSON.stringify(result)); process.exit(0); };
setTimeout(() => finish({ error: 'timeout' }), 30000);
(async () => {
  const password = fs.readFileSync(tokenPath, 'utf8').trim();
  const login = await fetch(base + '/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const withoutCookie = await fetch(base + '/api/terminal/sessions');
  const created = await fetch(base + '/api/terminal/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ cwd, cols: 80, rows: 24 }) });
  const { sessionId } = await created.json();
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/api/terminal/ws', { headers: { Cookie: cookie, Origin: base } });
  let output = '';
  let backend = null;
  socket.on('open', () => socket.send(frame({ t: 'attach', v: 3, s: sessionId })));
  socket.on('error', (error) => finish({ error: String(error) }));
  socket.on('message', async (raw) => {
    const message = JSON.parse(raw.subarray(1).toString('utf8'));
    if (message.t === 'snapshot') {
      backend = message.ptyBackend;
      socket.send(frame({ t: 'write', v: 3, s: sessionId, d: 'echo space-$((40+2)); id -u\\r' }));
    }
    if (message.t === 'output') output += message.d;
    if (/space-42[\\s\\S]*\\n1000\\r?\\n/.test(output)) {
      await fetch(base + '/api/terminal/' + sessionId, { method: 'DELETE', headers: { Cookie: cookie } });
      finish({ loginStatus: login.status, withoutCookieStatus: withoutCookie.status, createStatus: created.status, backend, output });
    }
  });
})().catch((error) => finish({ error: String(error) }));
`;

// A project plugin in the form OpenCode 2 loads from `.opencode/plugins/`. It imports the
// plugin package, which is the import that needs the link above the projects.
const HELLO_PLUGIN = `import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "hello",
  setup: async () => {},
})
`;

describe.skipIf(!LIVE_DOCKER_ENABLED)('server inside a space: docker (live)', () => {
  const spec = {
    id: createSpaceId(),
    name: 'Server inside',
    project: hashProjectDirectory('/server/inside/project'),
    created: new Date().toISOString(),
    memoryBytes: 2 * 1024 * 1024 * 1024,
  };
  const repo = `/spaces/${spec.id}/repo`;
  const link = `/spaces/${spec.id}/link-to-repo`;
  const plugin = `${repo}/.opencode/plugins/hello.ts`;
  let place;
  let placeWith;
  let host;
  let owner;
  let server;
  let cookie;
  let dispose = async () => {};

  const shell = async (script, stdin = '') => {
    const result = await place.exec(spec.id, ['sh', '-c', script], { stdin });
    expect(result.code, `${script}: ${result.stderr}`).toBe(0);
    return result.stdout;
  };
  const logIn = async () => {
    const login = await server.request(spec.id, { method: 'POST', path: '/auth/session', headers: JSON_HEADERS, body: JSON.stringify({ password: await server.readToken(spec.id) }) });
    expect(login.status).toBe(200);
    return login.headers['set-cookie'][0].split(';')[0];
  };
  const health = async () => JSON.parse((await server.request(spec.id, { path: '/health' })).body);
  // OpenCode 2 answers with the record under `data`.
  const api = async (path, { method = 'GET', body } = {}) => {
    const answer = await server.request(spec.id, { method, path, headers: body === undefined ? { Cookie: cookie } : { ...JSON_HEADERS, Cookie: cookie }, body });
    expect(answer.status, `${method} ${path}: ${answer.body}`).toBe(200);
    return JSON.parse(answer.body).data;
  };
  const createSession = (directory) => api('/api/session', { method: 'POST', body: JSON.stringify({ location: { directory } }) });
  const listSessions = async (directory) => (await api(`/api/session?directory=${encodeURIComponent(directory)}`)).map((entry) => entry.id);

  beforeAll(async () => {
    ({ place, placeWith, host, owner, dispose } = createLiveDockerPlace());
    server = createSpaceServerChannel({ exec: place.exec });
    await place.create(spec);
    cookie = await logIn();
  }, CREATE_TIMEOUT_MS);

  afterAll(async () => {
    await dispose();
  });

  it('answers /health and reports OpenCode ready as soon as create resolves', async () => {
    expect(await health()).toMatchObject({ isOpenCodeReady: true, openCodeRunning: true });
  });

  it('refuses the API without the token, and the cookie name carries the port inside', async () => {
    expect((await server.request(spec.id, { path: '/api/terminal/sessions' })).status).toBe(401);
    expect(cookie).toMatch(new RegExp(`^oc_ui_session_${SPACE_SERVER_PORT}=`));
    expect((await server.request(spec.id, { path: '/api/terminal/sessions', headers: { Cookie: cookie } })).status).toBe(200);
  });

  it('keeps the token in a private file, and not in the container environment', async () => {
    expect(await shell(`stat -c '%a %u' ${SPACE_TOKEN_PATH} "$(dirname ${SPACE_TOKEN_PATH})"`)).toBe('600 1000\n700 1000\n');
    expect(await shell('tr "\\0" "\\n" < /proc/1/environ')).not.toContain('OPENCHAMBER_UI_PASSWORD');
  });

  // The open question of stage 0: does OpenCode report the space path unchanged? OpenCode 2
  // takes the directory from `location` in the body. It ignores `?directory=` on this route, and
  // such a session lands in HOME, so the dispatcher must never rely on the query here.
  it('reports the directory of a session byte for byte as the space path', async () => {
    await shell(`mkdir -p ${repo} && cd ${repo} && git init -q . && git -c user.email=space@example.invalid -c user.name=Space commit -q --allow-empty -m init`);

    const session = await createSession(repo);
    expect(session.location.directory).toBe(repo);
    expect((await api(`/api/session/${session.id}`)).location.directory).toBe(repo);
    expect(await listSessions(repo)).toEqual([session.id]);

    const byQuery = await api(`/api/session?directory=${encodeURIComponent(repo)}`, { method: 'POST', body: '{}' });
    expect(byQuery.location.directory).toBe('/home/space');
    expect(await listSessions(repo)).toEqual([session.id]);
  });

  // Recorded, not wished for. OpenCode 1.18.31 resolved a symlink and reported the real path.
  // OpenCode 2 keeps the link path, says how it relates to the project in `subpath`, and leaves
  // the session out of the list for the real path. OpenCode no longer normalises anything, so
  // handing it real paths only is the whole defence, and the dispatcher stage must do it.
  it('reports the link path for a directory that was reached through a symlink', async () => {
    await shell(`ln -sfn ${repo} ${link}`);
    const before = await listSessions(repo);

    const session = await createSession(link);
    expect(session.location.directory).toBe(link);
    expect(session.subpath).toBe('../link-to-repo');
    expect(await listSessions(repo)).toEqual(before);
  });

  // With no network, a project plugin that imports @opencode/plugin must load from the link above
  // the projects. OpenCode 2 does not download the package for a local plugin: without the link
  // the plugin fails at once with "Cannot find package". OpenCode 1 waited 131 seconds for a
  // background install instead. The state check is what turns red when the link goes.
  it('loads a project plugin that imports @opencode/plugin, without a download', async () => {
    await shell(`mkdir -p "$(dirname ${plugin})" && cat > ${plugin}`, HELLO_PLUGIN);
    const location = `location%5Bdirectory%5D=${encodeURIComponent(repo)}`;

    const started = Date.now();
    // The location of the earlier tests loaded before the plugin existed.
    const reload = await server.request(spec.id, { method: 'POST', path: '/api/location/reload', headers: { Cookie: cookie } });
    expect(reload.status).toBe(204);
    // OpenCode loads plugins in the background, so the list can show this one before it has
    // loaded, or not yet at all. Only `active` or `failed` is an answer.
    let entry;
    for (;;) {
      entry = (await api(`/api/plugin?${location}`)).find((candidate) => candidate.source?.path === plugin);
      if (['active', 'failed'].includes(entry?.state?.status) || Date.now() - started >= 15_000) break;
      await new Promise((resolve) => { setTimeout(resolve, 250); });
    }
    expect(entry, 'OpenCode never listed the project plugin').toBeDefined();
    // OpenCode answers a failure with a generic text and a ref. Its log has the cause under that ref.
    const cause = entry.state?.ref
      ? (await place.exec(spec.id, ['sh', '-c', 'grep -h -F -- "$1" "$HOME"/.local/share/opencode/log/*.log | tail -1', 'sh', entry.state.ref])).stdout.trim()
      : '';
    expect(entry.state, cause).toEqual({ status: 'active' });
    expect(Date.now() - started).toBeLessThan(15_000);

    // Nothing tried to fetch a package for it.
    const journal = await createGatekeeperChannel({ exec: place.exec }).readJournal(spec.id);
    expect(journal.records.filter((record) => /npm/i.test(record.host))).toEqual([]);

    // Only the plugin is linked above the projects, not the whole tools node_modules.
    expect(await shell(`ls /spaces/${spec.id}/node_modules /spaces/${spec.id}/node_modules/@opencode`)).toBe(`/spaces/${spec.id}/node_modules:\n@opencode\n\n/spaces/${spec.id}/node_modules/@opencode:\nplugin\n`);
  }, 60_000);

  it('runs commands in a terminal as uid 1000, through the terminal WebSocket', async () => {
    await shell('cat > /tmp/terminal-probe.cjs', TERMINAL_PROBE);
    const result = await place.exec(spec.id, ['node', '/tmp/terminal-probe.cjs', SPACE_TOKEN_PATH, String(SPACE_SERVER_PORT), `/spaces/${spec.id}`], { timeoutMs: 60_000 });

    expect(result.code, result.stderr).toBe(0);
    const probe = JSON.parse(result.stdout);
    expect(probe).toMatchObject({ loginStatus: 200, withoutCookieStatus: 401, createStatus: 200, backend: 'node-pty' });
    expect(probe.output).toMatch(/space-42\r?\n1000\r?\n/);
  }, 90_000);

  it('comes back healthy after stop and start, with the same token and the same files', async () => {
    const tokenBefore = await server.readToken(spec.id);
    await place.stop(spec.id);
    await place.start(spec.id);

    expect(await health()).toMatchObject({ isOpenCodeReady: true });
    expect(await server.readToken(spec.id)).toBe(tokenBefore);
    expect(await shell(`cat ${plugin}`)).toBe(HELLO_PLUGIN);
    expect(await place.verify(spec.id)).toEqual([]);
  }, 5 * 60_000);

  it('moves a stopped space to new tools at its next start, and drops the old tools volume', async () => {
    // The same packages under another key, as a host with other tools would ask for.
    const updatedPlace = placeWith(createRegistryToolsSource({ ...readHostToolVersions(), revision: 'live-test-second-fill' }));
    const toolsOf = async () => JSON.parse(await host.spaceMetadata(spec.id))[0].Mounts.find((mount) => mount.Destination === TOOLS_MOUNT_PATH).Name;
    const before = await toolsOf();
    const tokenBefore = await server.readToken(spec.id);

    // A running space is never touched.
    await updatedPlace.start(spec.id);
    expect(await toolsOf()).toBe(before);

    await place.stop(spec.id);
    await updatedPlace.start(spec.id);

    const after = await toolsOf();
    expect(after).not.toBe(before);
    expect(toolsKeyFromVolumeName(after, owner)).toMatch(/^[0-9a-f]{16}$/);
    expect(await updatedPlace.verify(spec.id)).toEqual([]);
    expect(await health()).toMatchObject({ isOpenCodeReady: true });
    expect(await server.readToken(spec.id)).toBe(tokenBefore);
    expect(await shell(`cat ${plugin}`)).toBe(HELLO_PLUGIN);
    expect(await updatedPlace.list()).toMatchObject([{ id: spec.id, state: 'running', damaged: false }]);
    // No container mounts the old tools volume any more, so it is gone.
    expect((await host.volumes()).filter((name) => name.startsWith('openchamber-tools-'))).toEqual([after]);
  }, CREATE_TIMEOUT_MS);
});

describe.skipIf(!LIVE_DOCKER_ENABLED)('failed tools fill: docker (live)', () => {
  it('rejects the create and leaves no container, network or volume', async () => {
    const neverPublished = createRegistryToolsSource({ ...readHostToolVersions(), webVersion: '0.0.0-never-published' });
    const { place, dispose, host } = createLiveDockerPlace({ toolsSource: neverPublished });
    const spec = { id: createSpaceId(), name: 'Failed fill', project: hashProjectDirectory('/failed/fill'), created: new Date().toISOString(), memoryBytes: 1024 * 1024 * 1024 };

    try {
      const error = await place.create(spec).catch((caught) => caught);
      expect(error.code).toBe('tools_fill_failed');
      expect(error.message).toMatch(/0\.0\.0-never-published/);
      expect(error.details).toMatchObject({ rollbackFailures: [], uncertain: false });
      expect(await place.list()).toEqual([]);
      expect(await host.volumes()).toEqual([]);
    } finally {
      // Asserts that nothing with this owner's label is left.
      await dispose();
    }
  }, CREATE_TIMEOUT_MS);
});
