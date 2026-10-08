#!/usr/bin/env node
// The pre-commit gate for agent work: type-check, lint, dead code, and an
// anti-slop ratchet over the files the change touches.
//
// The anti-slop backlog predates the plugin, so a blanket oxlint run is never
// clean. The ratchet compares the changed files with their versions at the
// base and fails when a rule reports more findings across them than it did
// there: a change may leave old findings alone, but it cannot add new ones.
// Totals are per rule over the whole change, so code moved between files
// (ten private copies of a check folded into one shared helper) is not new.
//
// The base is where the branch left origin/main, so the comparison covers
// uncommitted edits and commits not yet in main alike.
//
// Usage: bun run check:changed [-- --base <ref>]

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OXLINT_CONFIG = path.join(REPO_ROOT, 'oxlint.config.ts');
const LINTABLE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const git = (args) => execFileSync('git', args, {
  cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

const readBase = (argv) => {
  const index = argv.indexOf('--base');
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  return git(['merge-base', 'HEAD', 'origin/main']).trim();
};

const listChangedFiles = (base) => {
  const tracked = git(['diff', '--name-only', '--diff-filter=AMR', base]).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...tracked, ...untracked])].filter((file) => LINTABLE_FILE.test(file));
};

/** Findings counted per file and rule, keyed `file\0rule`. */
const countFindings = (diagnostics, toRepoPath) => {
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    const key = `${toRepoPath(diagnostic.filename)}\0${diagnostic.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const totalsByRule = (counts) => {
  const totals = new Map();
  for (const [key, count] of counts) {
    const rule = key.split('\0')[1];
    totals.set(rule, (totals.get(rule) ?? 0) + count);
  }
  return totals;
};

/**
 * Every rule that reports more findings across the change than at the base,
 * with the files where it grew to show where to look.
 */
export const findRatchetViolations = (baseCounts, currentCounts) => {
  const baseTotals = totalsByRule(baseCounts);
  const violations = [];
  for (const [rule, current] of totalsByRule(currentCounts)) {
    const base = baseTotals.get(rule) ?? 0;
    if (current <= base) continue;
    const files = [];
    for (const [key, count] of currentCounts) {
      const [file, keyRule] = key.split('\0');
      if (keyRule === rule && count > (baseCounts.get(key) ?? 0)) files.push(file);
    }
    violations.push({ rule, base, current, files: files.sort() });
  }
  return violations.sort((left, right) => left.rule.localeCompare(right.rule));
};

const runOxlint = (files, cwd) => {
  if (files.length === 0) return [];
  const result = spawnSync('bunx', ['oxlint', '-c', OXLINT_CONFIG, '-f', 'json', ...files], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (!result.stdout) throw new Error(`oxlint produced no report: ${result.stderr}`);
  return JSON.parse(result.stdout).diagnostics;
};

const checkAntiSlopRatchet = (base, files) => {
  const current = countFindings(runOxlint(files, REPO_ROOT), (file) => path.relative(REPO_ROOT, path.resolve(REPO_ROOT, file)));

  const baseDir = mkdtempSync(path.join(tmpdir(), 'oc-check-changed-'));
  try {
    const baseFiles = [];
    for (const file of files) {
      let content;
      try {
        content = git(['show', `${base}:${file}`]);
      } catch {
        continue; // Added since the base: every finding in it is new.
      }
      const target = path.join(baseDir, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
      baseFiles.push(target);
    }
    const baseCounts = countFindings(runOxlint(baseFiles, baseDir), (file) => path.relative(baseDir, path.resolve(baseDir, file)));
    return findRatchetViolations(baseCounts, current);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
};

const runStep = (label, command, args) => {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  return result.status === 0;
};

const main = () => {
  const base = readBase(process.argv.slice(2));
  const files = listChangedFiles(base);
  console.log(`Base ${base.slice(0, 9)}; ${files.length} changed source file(s).`);

  const failed = [];
  if (!runStep('type-check', 'bun', ['run', 'type-check'])) failed.push('type-check');
  if (!runStep('lint', 'bun', ['run', 'lint'])) failed.push('lint');
  if (!runStep('dead code', 'bun', ['run', 'dead-code'])) failed.push('dead code');

  console.log('\n▶ anti-slop ratchet');
  const violations = checkAntiSlopRatchet(base, files);
  for (const { rule, base: before, current, files: grown } of violations) {
    console.log(`  ${rule}: ${before} → ${current} (grew in ${grown.join(', ')})`);
  }
  if (violations.length > 0) {
    console.log(`  Run \`bunx oxlint <file>\` for locations. Fix the new findings; the old ones may stay.`);
    failed.push('anti-slop ratchet');
  } else {
    console.log('  No new findings.');
  }

  if (failed.length > 0) {
    console.log(`\n✗ Failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('\n✓ All checks passed.');
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
