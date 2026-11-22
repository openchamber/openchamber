#!/usr/bin/env node
// Notes for the nightly Canary build: the `feat` and `fix` commits of `main`
// since the previous Canary, written into `canary-notes.json` on the `canary`
// pre-release next to the builds. The update dialog shows the nights between
// the installed build and the offered one (server/lib/changelog/update-notes.js).
// No agent writes them: Stable keeps the hand-written changelog.
//
//   node scripts/changelog/canary-notes.mjs --previous previous.json --from <rev> --to <rev> --version 2.5.4-canary.20261031.5
//
// Prints the new notes file: this night first, then the earlier ones, at most
// NIGHTS_KEPT of them.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NIGHTS_KEPT = 30;

// Scopes that change nothing a user of the app sees.
const SKIPPED_SCOPES = new Set(['ci', 'dev', 'deps', 'test', 'tests', 'integration', 'release', 'triage']);

const SUBJECT_RE = /^(feat|fix)(?:\(([^)]+)\))?!?:\s*(.+)$/;
const PULL_RE = /\s*\(#(\d+)\)/g;
const CANARY_VERSION_RE = /^\d+\.\d+\.\d+-canary\.(\d{4})(\d{2})(\d{2})\.\d+$/;

/** One night's changes from commit subjects, newest first as `git log` prints them. */
export function collectChanges(subjects) {
  const changes = { new: [], fixes: [] };
  for (const subject of subjects) {
    const match = SUBJECT_RE.exec(subject.trim());
    if (!match) continue;
    const [, type, scope, rest] = match;
    if (scope && SKIPPED_SCOPES.has(scope)) continue;
    const pulls = [...rest.matchAll(PULL_RE)].map((pull) => pull[1]);
    const text = rest.replace(PULL_RE, '').trim();
    if (!text) continue;
    changes[type === 'feat' ? 'new' : 'fixes'].push({
      area: scope ?? null,
      text,
      pr: pulls.at(-1) ?? null,
    });
  }
  return changes;
}

/**
 * The notes with this night first. A re-run of the same version replaces its
 * night; a night without changes (a re-run after the notes were written)
 * leaves them as they are.
 */
export function addNight(previous, night) {
  const nights = Array.isArray(previous) ? previous : [];
  if (night.new.length === 0 && night.fixes.length === 0) return nights.slice(0, NIGHTS_KEPT);
  return [night, ...nights.filter((entry) => entry?.version !== night.version)].slice(0, NIGHTS_KEPT);
}

export function nightDate(version) {
  const match = CANARY_VERSION_RE.exec(version);
  if (!match) throw new Error(`Not a Canary version: ${version}`);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

const readArg = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};

// No file means no earlier nights; a file that does not parse stops the run,
// so a broken download never replaces them with this night alone.
const readPrevious = (file) => {
  if (!file || !fs.existsSync(file)) return [];
  const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(previous)) throw new Error(`${file} is not a list of nights`);
  return previous;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const from = readArg(args, '--from');
  const to = readArg(args, '--to');
  const version = readArg(args, '--version');
  if (!from || !to || !version) {
    console.error('Usage: canary-notes.mjs --previous <file> --from <rev> --to <rev> --version <canary version>');
    process.exit(1);
  }
  const subjects = execFileSync('git', ['log', '--no-merges', '--format=%s', `${from}..${to}`], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const night = { version, date: nightDate(version), sha: to, ...collectChanges(subjects) };
  process.stdout.write(`${JSON.stringify(addNight(readPrevious(readArg(args, '--previous')), night))}\n`);
}
