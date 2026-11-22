#!/usr/bin/env node
// The ratchet for a merge of upstream into the fork.
//
// `check:changed` compares the tree with where the branch left origin/main, so
// on an upstream merge every finding upstream's own code carries counts as new.
// This check counts only what the merge itself adds:
//
//   rules: for each anti-slop rule, the total over every file either side
//   changed since the merge base must not exceed the sum of each file's
//   fork + upstream - base, clamped at 0. Totals over the whole set, not per
//   file, so upstream's moves and splits are not new.
//
//   length: a source file over the size limit may not exceed its larger parent
//   plus the lines the fork itself added to that path since the base. A file
//   over that carries merge glue or fork code moved into an upstream file.
//   Where upstream moved a file, or turned a server `.js` file into `.ts`, the
//   fork's side is read at the path the fork still uses.
//
// Each side is linted with a copy of the config at that side's own root. The
// config's path overrides (the server's comments, its parser allowances) match
// paths relative to the config file, so linting a side from a temporary
// directory with the repository's config would silently skip every override.
//
// Usage: node scripts/check-merge-ratchet.mjs --fork <ref> --upstream <ref> [--moved <new>=<old>]...
// The merged side is the working tree. The base is `git merge-base fork upstream`.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOxlintReport } from './check-changed.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OXLINT_CONFIG = path.join(REPO_ROOT, 'oxlint.anti-slop.config.ts');
const LINTABLE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SIZE_LIMIT = 800;
const SIZED_FILE = /^packages\/[^/]+\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SIZE_EXEMPT = /(\.(test|spec|vitest|fixture|test-support|bench)\.|\/(__tests__|tests?)\/|\/i18n\/messages\/|\.i18n\.ts$|\.d\.ts$|\.generated\.)/;
const OXLINT_BATCH = 2000;

const git = (args, input) => execFileSync('git', args, {
  cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
});

const readArg = (argv, name) => {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) throw new Error(`missing ${name} <ref>`);
  return value;
};

const changedPaths = (from, to) => git(['diff', '--name-only', '--no-renames', from, ...(to ? [to] : [])])
  .split('\n').filter((file) => LINTABLE_FILE.test(file));

const untrackedPaths = () => git(['ls-files', '--others', '--exclude-standard'])
  .split('\n').filter((file) => LINTABLE_FILE.test(file));

/** Contents of `files` at `ref`, through one `git cat-file --batch`; absent files are left out. */
export const readTree = (ref, files) => {
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: REPO_ROOT, input: files.map((file) => `${ref}:${file}`).join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024,
  });
  const contents = new Map();
  let offset = 0;
  for (const file of files) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, headerEnd).toString('utf8');
    offset = headerEnd + 1;
    if (header.endsWith(' missing')) continue;
    const size = Number(header.split(' ')[2]);
    contents.set(file, output.subarray(offset, offset + size).toString('utf8'));
    offset += size + 1;
  }
  return contents;
};

const countLines = (content) => (content === '' ? 0 : content.replace(/\n$/, '').split('\n').length);

const runOxlint = (files, cwd, config) => {
  const diagnostics = [];
  for (let index = 0; index < files.length; index += OXLINT_BATCH) {
    const batch = files.slice(index, index + OXLINT_BATCH);
    const result = spawnSync('bunx', ['oxlint', '-c', config, '-f', 'json', ...batch], {
      cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
    });
    if (!result.stdout) throw new Error(`oxlint produced no report: ${result.stderr}`);
    diagnostics.push(...parseOxlintReport(result.stdout));
  }
  return diagnostics;
};

/** Findings keyed `file\0rule`, over the files as they are at one side of the merge. */
const fileRuleCounts = (contents) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-merge-ratchet-'));
  try {
    for (const [file, content] of contents) {
      const target = path.join(dir, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    // The config's path overrides are relative to the config file, so every
    // side is linted by a copy at its own root, with the plugins it loads.
    const config = path.join(dir, path.basename(OXLINT_CONFIG));
    copyFileSync(OXLINT_CONFIG, config);
    for (const linked of ['tools', 'node_modules']) {
      if (!existsSync(path.join(dir, linked))) symlinkSync(path.join(REPO_ROOT, linked), path.join(dir, linked), 'dir');
    }
    const counts = new Map();
    for (const { code, filename } of runOxlint([...contents.keys()], dir, config)) {
      const key = `${path.relative(dir, path.resolve(dir, filename))}\0${code}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const ruleTotals = (counts) => {
  const totals = new Map();
  for (const [key, count] of counts) {
    const rule = key.split('\0')[1];
    totals.set(rule, (totals.get(rule) ?? 0) + count);
  }
  return totals;
};

/**
 * Per rule, the totals of each side and the allowance: each file's
 * fork + upstream - base, clamped at 0, summed. Unclamped, a path both sides
 * removed or moved (base had findings, neither side has them there) would
 * take its base findings off the allowance for every other file.
 */
export const findMergeRatchetViolations = ({ base, fork, upstream, merged }) => {
  const [baseTotals, forkTotals, upstreamTotals, mergedTotals] = [base, fork, upstream, merged].map(ruleTotals);
  const allowed = new Map();
  for (const key of new Set([...base.keys(), ...fork.keys(), ...upstream.keys()])) {
    const rule = key.split('\0')[1];
    const share = Math.max(0, (fork.get(key) ?? 0) + (upstream.get(key) ?? 0) - (base.get(key) ?? 0));
    allowed.set(rule, (allowed.get(rule) ?? 0) + share);
  }
  const rules = new Set([...baseTotals.keys(), ...forkTotals.keys(), ...upstreamTotals.keys(), ...mergedTotals.keys()]);
  return [...rules].sort().map((rule) => ({
    rule,
    base: baseTotals.get(rule) ?? 0,
    fork: forkTotals.get(rule) ?? 0,
    upstream: upstreamTotals.get(rule) ?? 0,
    allowed: allowed.get(rule) ?? 0,
    merged: mergedTotals.get(rule) ?? 0,
  }));
};

/** Lines each path gained on the fork since the base, from `git diff --numstat`. */
const forkAddedLines = (baseRef, forkRef) => {
  const added = new Map();
  for (const line of git(['diff', '--numstat', '--no-renames', baseRef, forkRef]).split('\n')) {
    const [count, , file] = line.split('\t');
    if (file && count !== '-') added.set(file, Number(count));
  }
  return added;
};

/** Sized files over the limit that exceed their larger parent plus the fork's own additions. */
export const findMergeLengthViolations = (sizes) => sizes.filter(({ file, merged, fork, upstream, forkAdded }) => (
  SIZED_FILE.test(file) && !SIZE_EXEMPT.test(file) && merged > SIZE_LIMIT
    && merged > Math.max(fork ?? 0, upstream ?? 0) + forkAdded
));

const SERVER_SOURCE = /^packages\/web\/(server|bin)\/.*\.ts$/;

/** Where upstream moved each file from since the base, keyed by its new path. */
const upstreamRenames = (baseRef, upstreamRef) => {
  const renames = new Map();
  for (const line of git(['diff', '--find-renames', '--name-status', baseRef, upstreamRef]).split('\n')) {
    const [status, from, to] = line.split('\t');
    if (status?.startsWith('R') && from && to) renames.set(to, from);
  }
  return renames;
};

/**
 * The path a merged file's fork side lives at: a `--moved new=old` given on
 * the command line, where git sees upstream moved it from (the fork kept the
 * old path), or the `.js` twin of a server or CLI `.ts` file; else the same
 * path. Upstream's server moves often rewrite a file past what git's rename
 * detection matches; those are named with `--moved`, and the output says
 * which fork path each over-limit file was measured against.
 */
const forkPathResolver = ({ moved, renames, forkHas }) => (file) => {
  const direct = moved.get(file) ?? renames.get(file);
  if (direct) return direct;
  if (forkHas(file)) return file;
  const twin = SERVER_SOURCE.test(file) ? file.replace(/\.ts$/, '.js') : null;
  return twin && forkHas(twin) ? twin : file;
};

const readMoves = (argv) => new Map(argv.flatMap((arg, index) => (
  argv[index - 1] === '--moved' && arg.includes('=') ? [arg.split('=', 2)] : []
)));

const main = () => {
  const argv = process.argv.slice(2);
  const forkRef = git(['rev-parse', readArg(argv, '--fork')]).trim();
  const upstreamRef = git(['rev-parse', readArg(argv, '--upstream')]).trim();
  const baseRef = git(['merge-base', forkRef, upstreamRef]).trim();
  console.log(`base ${baseRef}\nfork ${forkRef}\nupstream ${upstreamRef}\nmerged: working tree`);

  const files = [...new Set([
    ...changedPaths(baseRef, forkRef), ...changedPaths(baseRef, upstreamRef), ...changedPaths(baseRef), ...untrackedPaths(),
  ])].filter((file) => !file.startsWith('tools/oxlint/')).sort();
  const forkFiles = new Set(git(['ls-tree', '-r', '--name-only', forkRef, 'packages']).split('\n'));
  const forkPathOf = forkPathResolver({
    moved: readMoves(argv),
    renames: upstreamRenames(baseRef, upstreamRef),
    forkHas: (file) => forkFiles.has(file),
  });
  const forkElsewhere = readTree(forkRef, [...new Set(files.map(forkPathOf))]);
  const forkLinesElsewhere = (file) => {
    const content = forkElsewhere.get(forkPathOf(file));
    return content === undefined ? null : countLines(content);
  };
  console.log(`${files.length} lintable file(s) changed on either side.`);

  const sides = {
    base: readTree(baseRef, files),
    fork: readTree(forkRef, files),
    upstream: readTree(upstreamRef, files),
    merged: new Map(files.filter((file) => existsSync(path.join(REPO_ROOT, file)))
      .map((file) => [file, readFileSync(path.join(REPO_ROOT, file), 'utf8')])),
  };

  const counts = Object.fromEntries(Object.entries(sides).map(([side, contents]) => [side, fileRuleCounts(contents)]));
  const rows = findMergeRatchetViolations(counts);
  console.log('\n▶ rules (merged <= sum of each file\'s max(0, fork + upstream - base))');
  console.log('rule\tbase\tfork\tupstream\tallowed\tmerged');
  for (const row of rows) console.log(`${row.rule}\t${row.base}\t${row.fork}\t${row.upstream}\t${row.allowed}\t${row.merged}${row.merged > row.allowed ? '\tOVER' : ''}`);
  const ruleViolations = rows.filter((row) => row.merged > row.allowed);
  const detailIndex = argv.indexOf('--detail');
  if (detailIndex !== -1) {
    // A file's findings can come from either parent under another path, so
    // this lists where to look, not what is new.
    for (const { rule } of ruleViolations) {
      console.log(`\n  ${rule}: files over their own share`);
      for (const [key, merged] of counts.merged) {
        const [file, keyRule] = key.split('\0');
        if (keyRule !== rule) continue;
        const [forkCount, upstreamCount, baseCount] = [counts.fork, counts.upstream, counts.base].map((side) => side.get(key) ?? 0);
        const share = Math.max(0, forkCount + upstreamCount - baseCount);
        if (merged > share) console.log(`    ${file}: ${merged}, its share ${share} (base ${baseCount}, fork ${forkCount}, upstream ${upstreamCount})`);
      }
    }
  }

  const added = forkAddedLines(baseRef, forkRef);
  const lengthViolations = findMergeLengthViolations([...sides.merged].map(([file, content]) => ({
    file,
    merged: countLines(content),
    fork: sides.fork.has(file) ? countLines(sides.fork.get(file)) : forkLinesElsewhere(file),
    upstream: sides.upstream.has(file) ? countLines(sides.upstream.get(file)) : null,
    forkAdded: added.get(file) ?? added.get(forkPathOf(file)) ?? 0,
  })));
  console.log(`\n▶ length (files over ${SIZE_LIMIT} lines: merged <= max(fork, upstream) + fork's own additions)`);
  for (const { file, merged, fork, upstream, forkAdded } of lengthViolations) {
    const lineage = forkPathOf(file) === file ? '' : ` (fork side ${forkPathOf(file)})`;
    console.log(`  ${file}: ${merged} lines; fork ${fork ?? '-'}, upstream ${upstream ?? '-'}, fork added ${forkAdded}${lineage}`);
  }
  if (lengthViolations.length === 0) console.log('  No file over its allowance.');

  if (ruleViolations.length > 0 || lengthViolations.length > 0) {
    console.log(`\n✗ ${ruleViolations.length} rule(s) and ${lengthViolations.length} file(s) over.`);
    process.exit(1);
  }
  console.log('\n✓ The merge adds no findings and no length.');
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
