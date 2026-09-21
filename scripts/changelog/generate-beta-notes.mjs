#!/usr/bin/env node
// Generates hybrid release notes for Beta builds combining:
// 1. Curated highlights from `changelog/unreleased.md` (if any exist)
// 2. Commit log delta since the latest git tag / release
//
// Usage:
//   node scripts/changelog/generate-beta-notes.mjs [--version 1.23.3-beta.1] [--build 42] [--output file.md]

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRelease, renderReleaseNotes } from './lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const unreleasedPath = path.join(repoRoot, 'changelog', 'unreleased.md');

const args = process.argv.slice(2);
const readFlag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};

const versionName = readFlag('--version') ?? 'beta';
const buildNumber = readFlag('--build') ?? '1';
const outputPath = readFlag('--output');

export const getLatestTag = (cwd = repoRoot) => {
  try {
    const raw = execSync('git tag --sort=-v:refname', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const tags = raw.split('\n').map((t) => t.trim()).filter(Boolean);
    const releaseTag = tags.find((t) => /^v?\d+\.\d+\.\d+$/.test(t));
    return releaseTag ?? (tags[0] || null);
  } catch {
    return null;
  }
};

export const getCommitDelta = (sinceTag, maxCount = 30, cwd = repoRoot) => {
  try {
    const range = sinceTag ? `${sinceTag}..HEAD` : `-n ${maxCount}`;
    const cmd = `git log ${range} --oneline --no-merges -n ${maxCount}`;
    const raw = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(' ');
        if (space < 0) return `- \`${line}\``;
        const hash = line.slice(0, space);
        const msg = line.slice(space + 1);
        return `- \`${hash}\` ${msg}`;
      });
  } catch {
    return [];
  }
};

export const extractUnreleasedNotes = (filePath = unreleasedPath) => {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseRelease(content, 'changelog/unreleased.md');
    const notes = renderReleaseNotes(parsed).trim();
    return notes.length > 0 ? notes : null;
  } catch {
    return null;
  }
};

export const generateBetaNotes = ({ version = versionName, build = buildNumber, cwd = repoRoot, unreleasedFile = unreleasedPath } = {}) => {
  const parts = [];
  parts.push(`Automated beta build #${build} (${version}).\n`);

  const highlights = extractUnreleasedNotes(unreleasedFile);
  if (highlights) {
    parts.push(`### 🌟 Upcoming Release Highlights\n\n${highlights}\n`);
  }

  const latestTag = getLatestTag(cwd);
  const commits = getCommitDelta(latestTag, 30, cwd);

  if (commits.length > 0) {
    const tagInfo = latestTag ? ` (since ${latestTag})` : '';
    parts.push(`### 🔨 Recent Commits${tagInfo}\n\n${commits.join('\n')}\n`);
  }

  return parts.join('\n').trim();
};

// Main execution if called directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = generateBetaNotes({ version: versionName, build: buildNumber });
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), `${result}\n`);
    console.log(`Wrote beta release notes to ${outputPath}`);
  } else {
    console.log(result);
  }
}
