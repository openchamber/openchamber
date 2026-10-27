import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';

import { assessOpenCodeConfig } from './assessment.js';
import { createOpenCodeTrust, OPENCODE_TRUST_REQUIRED } from './index.js';

let root;
let home;
let repo;

const write = async (relative, content) => {
  const target = path.join(repo, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
};

const makeTrust = () => createOpenCodeTrust({ storePath: path.join(root, 'data', 'opencode-trust.json'), homeDirectory: home });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-trust-')));
  home = path.join(root, 'home');
  repo = path.join(home, 'projects', 'repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('assessOpenCodeConfig', () => {
  it('finds nothing to run in a folder without OpenCode configuration', async () => {
    await write('opencode.json', JSON.stringify({ model: 'anthropic/claude' }));
    const assessment = await assessOpenCodeConfig(repo, { homeDirectory: home });
    expect(assessment.fingerprint).toBeNull();
    expect(assessment.items).toEqual([]);
  });

  it('lists plugin files, configured plugins and every command the configuration starts', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    await write('.opencode/plugins/notes.md', 'not code');
    await write('.opencode/plugin/local/index.ts', 'export default {}');
    await write('tools/plugin/index.js', 'export default {}');
    await write('opencode.jsonc', `{
      // comments and trailing commas are fine
      "plugins": ["opencode-acme", "./tools/plugin", "-opencode-removed"],
      "mcp": { "files": { "type": "local", "command": ["node", "server.js"] }, "web": { "type": "remote", "url": "https://x" } },
      "lsp": { "custom": { "command": ["my-lsp", "--stdio"] } },
      "formatter": { "fmt": { "command": ["fmt", "$FILE"] } },
      "shell": "/bin/zsh",
    }`);

    const { items, fingerprint } = await assessOpenCodeConfig(repo, { homeDirectory: home });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(items.map(({ kind, source, name, detail }) => [kind, source, name, detail])).toEqual([
      ['plugin', '.opencode/plugin/local', '', ''],
      ['plugin', '.opencode/plugins/probe.js', '', ''],
      ['package', 'opencode.jsonc', 'opencode-acme', ''],
      ['plugin', 'opencode.jsonc', './tools/plugin', ''],
      ['mcp', 'opencode.jsonc', 'files', 'node server.js'],
      ['lsp', 'opencode.jsonc', 'custom', 'my-lsp --stdio'],
      ['formatter', 'opencode.jsonc', 'fmt', 'fmt $FILE'],
      ['shell', 'opencode.jsonc', '', '/bin/zsh'],
    ]);
  });

  it('reads configuration from parent folders below home, and none from home up', async () => {
    await mkdir(path.join(home, '.opencode', 'plugins'), { recursive: true });
    await writeFile(path.join(home, '.opencode', 'plugins', 'mine.js'), 'export default {}');
    await mkdir(path.join(home, 'projects', '.opencode', 'plugins'), { recursive: true });
    await writeFile(path.join(home, 'projects', '.opencode', 'plugins', 'shared.js'), 'export default {}');
    await mkdir(path.join(repo, 'packages', 'app'), { recursive: true });

    const { items } = await assessOpenCodeConfig(path.join(repo, 'packages', 'app'), { homeDirectory: home });
    expect(items.map((item) => item.source)).toEqual(['../../../.opencode/plugins/shared.js']);
  });

  it('changes the fingerprint when plugin code changes and keeps it otherwise', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    const first = await assessOpenCodeConfig(repo, { homeDirectory: home });
    expect((await assessOpenCodeConfig(repo, { homeDirectory: home })).fingerprint).toBe(first.fingerprint);
    await write('.opencode/plugins/probe.js', 'import "node:fs"; export default {}');
    expect((await assessOpenCodeConfig(repo, { homeDirectory: home })).fingerprint).not.toBe(first.fingerprint);
  });

  it('changes the fingerprint when a repository file a plugin imports changes', async () => {
    await write('.opencode/plugins/probe.ts', 'import { run } from "../../scripts/helper.js";\nexport default { run };');
    await write('scripts/helper.ts', 'export { deep } from "./deep";\nexport const run = 1;');
    await write('scripts/deep.ts', 'export const deep = 1;');
    const fingerprint = async () => (await assessOpenCodeConfig(repo, { homeDirectory: home })).fingerprint;
    const first = await fingerprint();

    await write('scripts/helper.ts', 'export { deep } from "./deep";\nexport const run = 2;');
    const second = await fingerprint();
    expect(second).not.toBe(first);

    await write('scripts/deep.ts', 'export const deep = 2;');
    expect(await fingerprint()).not.toBe(second);
  });

  it('follows imports from plugin folders and configured local plugins', async () => {
    await write('.opencode/plugins/folder/index.js', 'import "../../../lib/a.js";');
    await write('tools/plugin.js', 'const b = require("./b");');
    await write('opencode.json', JSON.stringify({ plugin: ['./tools/plugin.js'] }));
    await write('lib/a.js', 'one');
    await write('tools/b.js', 'one');
    const fingerprint = async () => (await assessOpenCodeConfig(repo, { homeDirectory: home })).fingerprint;
    const first = await fingerprint();

    await write('lib/a.js', 'two');
    const second = await fingerprint();
    expect(second).not.toBe(first);
    await write('tools/b.js', 'two');
    expect(await fingerprint()).not.toBe(second);
  });

  it('changes the fingerprint when a missing import appears, and ignores package imports', async () => {
    await write('.opencode/plugins/probe.js', 'import "zod"; import "../../lib/later.js";');
    const before = (await assessOpenCodeConfig(repo, { homeDirectory: home })).fingerprint;
    await write('lib/later.js', 'export {}');
    expect((await assessOpenCodeConfig(repo, { homeDirectory: home })).fingerprint).not.toBe(before);
  });

  it('keeps the fingerprint of a plugin that imports nothing local', async () => {
    await write('.opencode/plugins/probe.js', 'import { appendFileSync } from "node:fs"; export default {}');
    const { items } = await assessOpenCodeConfig(repo, { homeDirectory: home });
    expect(items[0].hash).toBe(createHash('sha256').update('import { appendFileSync } from "node:fs"; export default {}').digest('hex'));
  });

  it('reads nothing from OpenCode\'s global configuration directory', async () => {
    const globalConfig = path.join(home, '.config', 'opencode');
    await mkdir(path.join(globalConfig, 'agents'), { recursive: true });
    await writeFile(path.join(globalConfig, 'opencode.json'), JSON.stringify({ plugins: ['my-plugin'], shell: 'zsh' }));
    const options = { homeDirectory: home, globalConfigDirectories: [globalConfig] };

    expect((await assessOpenCodeConfig(globalConfig, options)).fingerprint).toBeNull();
    expect((await assessOpenCodeConfig(path.join(globalConfig, 'agents'), options)).fingerprint).toBeNull();
  });

  it('counts a configuration file it cannot parse as code', async () => {
    await write('opencode.json', '{ "plugins": [');
    const { items } = await assessOpenCodeConfig(repo, { homeDirectory: home });
    expect(items.map((item) => [item.kind, item.source])).toEqual([['config', 'opencode.json']]);
  });

  it('shares one repository key between a checkout and its linked worktree', async () => {
    const worktree = path.join(root, 'worktrees', 'feature');
    const gitDir = path.join(repo, '.git', 'worktrees', 'feature');
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, 'commondir'), '../..\n');
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);

    const main = await assessOpenCodeConfig(repo, { homeDirectory: home });
    const linked = await assessOpenCodeConfig(worktree, { homeDirectory: home });
    expect(linked.repositoryKey).toBe(main.repositoryKey);
  });
});

describe('createOpenCodeTrust', () => {
  it('opens a folder without code at once and refuses one with plugins until trusted', async () => {
    const trust = makeTrust();
    const request = { method: 'GET', path: '/api/agent', headers: { 'x-opencode-directory': encodeURIComponent(repo) } };
    expect(await trust.refusalFor(request)).toBeNull();

    await write('.opencode/plugins/probe.js', 'export default {}');
    const fresh = makeTrust();
    const refusal = await fresh.refusalFor(request);
    expect(refusal?.status).toBe(403);
    expect(refusal?.body).toMatchObject({ code: OPENCODE_TRUST_REQUIRED, directory: repo });

    const shown = await fresh.handleRoute({ method: 'GET', query: { directory: repo } });
    expect(shown.body).toMatchObject({ trusted: false, items: [{ kind: 'plugin', source: '.opencode/plugins/probe.js' }] });
    const answered = await fresh.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(answered).toMatchObject({ status: 200, body: { trusted: true } });
    expect(await fresh.refusalFor(request)).toBeNull();

    const stored = JSON.parse(await readFile(path.join(root, 'data', 'opencode-trust.json'), 'utf8'));
    expect(Object.values(stored.repositories)).toEqual([{ fingerprints: [shown.body.fingerprint] }]);
  });

  it('asks again when the configuration changes after it was trusted', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    const trust = makeTrust();
    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });

    await write('.opencode/plugins/probe.js', 'export default { changed: true }');
    expect((await makeTrust().handleRoute({ method: 'GET', query: { directory: repo } })).body.trusted).toBe(false);
  });

  it('records nothing when the configuration changed after it was shown', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    const trust = makeTrust();
    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await write('.opencode/plugins/second.js', 'export default {}');

    const answered = await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(answered.status).toBe(409);
    expect(answered.body.items).toHaveLength(2);
    expect((await trust.handleRoute({ method: 'GET', query: { directory: repo } })).body.trusted).toBe(false);
  });

  it('lets global session reads through and checks the folder a session runs in', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    const trust = makeTrust();
    const headers = { 'x-opencode-directory': encodeURIComponent(repo) };
    expect(await trust.refusalFor({ method: 'GET', path: '/api/session?limit=50', headers })).toBeNull();
    expect(await trust.refusalFor({ method: 'GET', path: '/api/session/ses_1/message', headers })).toBeNull();
    expect(await trust.refusalFor({ method: 'DELETE', path: '/api/debug/location', headers })).toBeNull();

    const resolveSessionDirectory = async () => repo;
    const prompt = { method: 'POST', path: '/api/session/ses_1/prompt', headers: {}, resolveSessionDirectory };
    expect((await trust.refusalFor(prompt))?.status).toBe(403);
    expect(await trust.refusalFor({ ...prompt, resolveSessionDirectory: async () => null })).toBeNull();
    expect((await trust.refusalFor({ ...prompt, resolveSessionDirectory: async () => { throw new Error('down'); } }))?.status).toBe(503);
  });

  it('reads the folder from the location query as well', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    const refusal = await makeTrust().refusalFor({
      method: 'GET',
      path: `/api/mcp?location%5Bdirectory%5D=${encodeURIComponent(repo)}`,
      headers: {},
    });
    expect(refusal?.status).toBe(403);
  });

  it('trusts the projects the user already had, once, and asks about everything after', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    const other = path.join(home, 'projects', 'other');
    await mkdir(path.join(other, '.opencode', 'plugins'), { recursive: true });
    await writeFile(path.join(other, '.opencode', 'plugins', 'probe.js'), 'export default {}');
    const withProjects = (directories) => createOpenCodeTrust({
      storePath: path.join(root, 'data', 'opencode-trust.json'),
      homeDirectory: home,
      listKnownDirectories: async () => directories,
    });

    const first = withProjects([repo]);
    expect(await first.isTrusted(repo)).toBe(true);
    expect(await first.isTrusted(other)).toBe(false);

    // A project added later is not trusted by a second start.
    expect(await withProjects([repo, other]).isTrusted(other)).toBe(false);

    await write('.opencode/plugins/probe.js', 'export default { changed: true }');
    expect(await withProjects([repo]).isTrusted(repo)).toBe(false);
  });

  it('seeds the other projects when one folder stops answering', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    const hung = path.join(root, 'network-share');
    const fsPromises = {
      ...(await import('fs')).promises,
      realpath: async (target) => (target === hung ? new Promise(() => {}) : realpath(target)),
    };
    const trust = createOpenCodeTrust({
      storePath: path.join(root, 'data', 'opencode-trust.json'),
      homeDirectory: home,
      fsPromises,
      listKnownDirectories: async () => [hung, repo],
    });
    const started = Date.now();
    expect(await trust.isTrusted(repo)).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);

  it('seeds nothing when the project list cannot be read', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    const failing = createOpenCodeTrust({
      storePath: path.join(root, 'data', 'opencode-trust.json'),
      homeDirectory: home,
      listKnownDirectories: async () => { throw new Error('settings unreadable'); },
    });
    expect(await failing.isTrusted(repo)).toBe(false);
    const later = createOpenCodeTrust({
      storePath: path.join(root, 'data', 'opencode-trust.json'),
      homeDirectory: home,
      listKnownDirectories: async () => [repo],
    });
    expect(await later.isTrusted(repo)).toBe(true);
  });

  it('checks a folder once per opening while OpenCode reports closings', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    let clock = 0;
    const trust = createOpenCodeTrust({ storePath: path.join(root, 'data', 'opencode-trust.json'), homeDirectory: home, now: () => clock });
    trust.followLocations(true);
    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(await trust.isTrusted(repo)).toBe(true);

    // The folder stays open: a changed plugin is OpenCode's to reload, the
    // answer holds however long it has been.
    await write('.opencode/plugins/probe.js', 'export default { changed: true }');
    clock += 60 * 60 * 1000;
    expect(await trust.isTrusted(repo)).toBe(true);

    // OpenCode closed the folder: the next opening reads it again.
    await trust.forget(repo);
    expect(await trust.isTrusted(repo)).toBe(false);
  });

  it('keeps answers short while closings go unreported', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    let clock = 0;
    const trust = createOpenCodeTrust({ storePath: path.join(root, 'data', 'opencode-trust.json'), homeDirectory: home, now: () => clock });
    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(await trust.isTrusted(repo)).toBe(true);

    await write('.opencode/plugins/probe.js', 'export default { changed: true }');
    clock += 1000;
    expect(await trust.isTrusted(repo)).toBe(true);
    clock += 2000;
    expect(await trust.isTrusted(repo)).toBe(false);
  });

  it('forgets every answer when it starts following closings', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    const trust = makeTrust();
    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(await trust.isTrusted(repo)).toBe(true);
    await write('.opencode/plugins/probe.js', 'export default { changed: true }');
    trust.followLocations(true);
    expect(await trust.isTrusted(repo)).toBe(false);
  });

  it('trusts nothing from a store it cannot read', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    await mkdir(path.join(root, 'data'), { recursive: true });
    await writeFile(path.join(root, 'data', 'opencode-trust.json'), '{ broken');
    expect(await makeTrust().isTrusted(repo)).toBe(false);
  });
});
