#!/usr/bin/env bun
// Proves that a change removed or edited comments and nothing else: for every
// changed source file, the code tokens at the base and now are the same.
//
// Types are erased before comparing, so a change to types alone passes here
// and is left to type-check.
//
// Usage: bun scripts/comments-only.mjs [--base <ref>] [paths...]
//        bun scripts/comments-only.mjs --files <before> <after>

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// The automatic JSX runtime refuses `key` after a spread; the classic one transpiles it, and both versions go through the same one.
const CLASSIC_JSX = { compilerOptions: { jsx: 'react' } };

const loaderOf = (file) => (/\.tsx$/.test(file) ? 'tsx' : /\.ts$/.test(file) ? 'ts' : 'jsx');

/**
 * The file's code as tokens with comments gone: Bun's transpiler drops
 * comments, types and the empty `{}` a JSX comment sat in, so two versions
 * that differ only in comments come out the same.
 */
export const codeTokens = (file, text) => new Bun.Transpiler({ loader: loaderOf(file), minifyWhitespace: true, trimUnusedImports: false, tsconfig: CLASSIC_JSX })
  .transformSync(text)
  .split(/(?<=[;{}(),])/);

/** Index of the first token that differs, or -1 when the code is the same. */
export const firstDifference = (before, after) => {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (before[index] !== after[index]) return index;
  }
  return -1;
};

const main = () => {
  const argv = process.argv.slice(2);
  if (argv[0] === '--files') {
    const [before, after] = [argv[1], argv[2]].map((file) => codeTokens(file, readFileSync(file, 'utf8')));
    process.exit(firstDifference(before, after) === -1 ? 0 : 1);
  }
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex === -1 ? git(['merge-base', 'HEAD', 'origin/main']).trim() : argv[baseIndex + 1];
  const paths = argv.filter((arg, index) => arg !== '--base' && index !== baseIndex + 1);
  const status = git(['diff', '--name-status', base, '--', ...paths]).split('\n').filter(Boolean);
  const failures = [];
  let checked = 0;
  for (const line of status) {
    const [kind, file] = line.split('\t');
    if (!SOURCE_FILE.test(file)) continue;
    if (kind !== 'M') {
      failures.push(`${file}: ${kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'renamed'}, which is more than a comment change`);
      continue;
    }
    if (!existsSync(path.join(REPO_ROOT, file))) continue;
    checked += 1;
    const before = codeTokens(file, git(['show', `${base}:${file}`]));
    const after = codeTokens(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const index = firstDifference(before, after);
    if (index !== -1) {
      const around = (tokens) => tokens.slice(Math.max(0, index - 2), index + 2).join('').slice(0, 200);
      failures.push(`${file}: code differs at token ${index}\n    before: ${around(before)}\n    after:  ${around(after)}`);
    }
  }
  for (const failure of failures) console.log(`✗ ${failure}`);
  console.log(failures.length === 0 ? `✓ ${checked} file(s): only comments changed.` : `\n${failures.length} file(s) changed code.`);
  process.exit(failures.length === 0 ? 0 : 1);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
