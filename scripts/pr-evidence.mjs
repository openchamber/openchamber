#!/usr/bin/env node
// Uploads pull request evidence (screenshots, GIF recordings) to a secret gist
// and prints the Markdown to paste into the PR description. Evidence never goes
// into the repository: committed, it ships in every clone.
//
//   node scripts/pr-evidence.mjs --title "openchamber #123 evidence" before.png after.png
//
// Needs an authenticated `gh` and `git`. `gh gist create` refuses binary files,
// so the gist is created with a text file and the images are pushed with git.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const titleIndex = args.indexOf('--title');
const title = titleIndex === -1 ? 'openchamber PR evidence' : args[titleIndex + 1];
const files = (titleIndex === -1 ? args : args.filter((_, index) => index !== titleIndex && index !== titleIndex + 1)).map((file) => resolve(file));

if (files.length === 0) fail('Usage: node scripts/pr-evidence.mjs [--title "openchamber #123 evidence"] <image>...');
for (const file of files) {
  if (!existsSync(file)) fail(`No such file: ${file}`);
  if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) {
    fail(`${basename(file)}: only PNG, JPEG, GIF and WebP render from a gist. Record motion as a GIF.`);
  }
}
const names = files.map((file) => basename(file));
if (new Set(names).size !== names.length) fail('Two files share a name; rename one.');

const run = (command, commandArgs, options = {}) => execFileSync(command, commandArgs, { encoding: 'utf8', ...options }).trim();

const work = mkdtempSync(join(tmpdir(), 'pr-evidence-'));
try {
  const readme = join(work, 'README.md');
  writeFileSync(readme, `${title}\n`);
  const url = run('gh', ['gist', 'create', '--desc', title, readme]).split('\n').pop();
  const match = /gist\.github\.com\/([^/]+)\/([0-9a-f]+)/.exec(url);
  if (!match) fail(`Unexpected gist URL from gh: ${url}`);
  const [, user, id] = match;

  const clone = join(work, 'gist');
  run('gh', ['gist', 'clone', id, clone]);
  for (const file of files) copyFileSync(file, join(clone, basename(file)));
  run('git', ['-C', clone, 'add', '--', ...names]);
  run('git', ['-C', clone, 'commit', '--quiet', '-m', title]);
  // gh supplies the credentials for this push only; the user's git config is untouched.
  run('git', ['-C', clone, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '--quiet']);
  const sha = run('git', ['-C', clone, 'rev-parse', 'HEAD']);

  console.log(`Gist: ${url}\n`);
  for (const name of names) {
    const alt = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    console.log(`![${alt}](https://gist.githubusercontent.com/${user}/${id}/raw/${sha}/${encodeURIComponent(name)})`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
