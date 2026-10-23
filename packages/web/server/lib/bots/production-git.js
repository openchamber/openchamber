import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createGitCredentialBroker } from '../git/credential-broker.js';
import { firstRedirectedFolder, nameNotAllowedHere } from '../spaces/code-out.js';
import { BotServiceError, sha } from './services/contracts.js';

/** Local Git with no ambient credential, hook, fsmonitor or lazy-fetch authority. */
export const botGit = (directory, args, input) => new Promise((resolve, reject) => {
  const child = execFile('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
    '-c', 'protocol.allow=never', ...args], {
    cwd: directory, shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_MASTER: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
  }, (error, stdout) => error
    ? reject(new BotServiceError('BOT_GIT_LOCAL_FAILED', 'The bot Git operation failed; retained work requires inspection.'))
    : resolve(stdout));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

/** Match the Git population owner's filter exclusion for imported attributes.
 * No value from .gitattributes can select a configured host program. */
export async function createBotCheckoutGit(directory) {
  const config = new Map((await botGit(directory, ['config', '--includes', '--null', '--list'])).split('\0').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('\n');
    return separator < 0 ? [entry, 'true'] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const options = ['-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false'];
  for (const key of config.keys()) {
    if (!/^filter\./i.test(key) || !/\.(?:process|smudge|clean|required)$/i.test(key)) continue;
    if (!/^filter\.[^\0\r\n=]+\.(?:process|smudge|clean|required)$/i.test(key)) {
      throw new BotServiceError('BOT_GIT_FILTER_CONFIG_INVALID', 'Git filters could not be safely disabled.');
    }
    options.push('-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`);
  }
  const setting = async (key) => config.has(key) && (await botGit(directory, ['config', '--type=bool', '--get', key])).trim() === 'true';
  return { run: (args, input) => botGit(directory, [...options, ...args], input),
    settings: { ignoreCase: await setting('core.ignorecase'), precompose: await setting('core.precomposeunicode'),
      longPaths: await setting('core.longpaths') } };
}

/** Guarded population updates files/index and detaches HEAD at the result.
 * The durable owner must CAS and reattach its branch afterwards. */
export async function advanceBotCheckout({ directory, fromSha, resultSha }) {
  sha.parse(fromSha); sha.parse(resultSha);
  const { run, settings } = await createBotCheckoutGit(directory);
  const raw = (await run(['diff-tree', '-r', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', fromSha, resultSha, '--'])).split('\0');
  const paths = []; const created = []; const deleted = []; const deletedLinks = [];
  for (let index = 0; index + 1 < raw.length && raw[index]; index += 2) {
    const metadata = /^:([0-9]{6}) ([0-9]{6}) [a-f0-9]{40} [a-f0-9]{40} ([A-Z])$/.exec(raw[index]);
    const name = raw[index + 1];
    if (!metadata || !name) throw new BotServiceError('BOT_GIT_DIFF_INVALID', 'The imported checkout paths could not be verified.');
    paths.push(name);
    if (metadata[3] === 'A') created.push(name);
    if (metadata[3] === 'D') {
      deleted.push(name);
      if (metadata[1] === '120000') deletedLinks.push(name);
    }
  }
  const all = (await run(['ls-tree', '-r', '-z', '--full-tree', resultSha])).split('\0').filter(Boolean).map((entry) => {
    const match = /^(?:100644|100755|120000) blob [a-f0-9]{40}\t([\s\S]+)$/.exec(entry);
    if (!match) throw new BotServiceError('BOT_ISOLATED_TREE_UNSUPPORTED', 'The imported checkout contains an unsupported file type.');
    return match[1];
  });
  if (nameNotAllowedHere(created, all, { ...settings, top: directory, deleted })
    || await firstRedirectedFolder(directory, paths, { ...settings, deletedLinks })) {
    throw new BotServiceError('BOT_ISOLATED_PATH_UNSAFE', 'The imported checkout cannot be safely written on this filesystem.');
  }
  // read-tree -m -u overwrote an ignored file arriving after admission in the
  // regression fixture. Checkout has an explicit ignored-file refusal switch.
  // No force, merge, reset, hooks, filters or recursive submodule operation.
  await run(['checkout', '--detach', '--no-guess', '--no-overwrite-ignore', '--no-recurse-submodules', resultSha]);
}

/** Existing credential broker owns fixed-endpoint authentication. No shared remote/config is changed. */
export async function fetchBotCommit({ directory, credential, target, commit }) {
  sha.parse(commit);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-bot-fetch-'));
  const broker = createGitCredentialBroker();
  let grant;
  try {
    await fs.chmod(temporary, 0o700);
    await botGit(temporary, ['init', '--bare', '--quiet']);
    await broker.start();
    await credential.assertCurrent();
    grant = broker.issue({ operationId: randomUUID(), credential: { mode: 'managed', transport: 'https',
      username: 'x-access-token', password: credential.gitToken,
      allowedEndpoint: { protocol: 'https', host: 'github.com', path: `${target.owner}/${target.repo}.git` } } });
    await new Promise((resolve, reject) => execFile('git', [...grant.gitConfigArgs, '-c', 'core.hooksPath=',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false', '-c', 'http.extraHeader=',
      'fetch', '--no-tags', '--no-recurse-submodules', `https://github.com/${target.owner}/${target.repo}.git`, commit], {
      cwd: temporary, shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...grant.env, HOME: temporary, USERPROFILE: temporary,
        GIT_MASTER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    }, (error) => error ? reject(new BotServiceError('BOT_GIT_FETCH_FAILED', 'The exact bot account could not fetch the required Git object.')) : resolve()));
    await botGit(directory, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-recurse-submodules', temporary, commit]);
  } finally {
    grant?.revoke();
    await broker.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
