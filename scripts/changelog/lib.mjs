// Source of truth for release notes: one Markdown file per release under
// `changelog/`, plus `changelog/unreleased.md` for what is not shipped yet.
// This module parses those files, validates their shape, and renders the
// generated outputs: `packages/vscode/CHANGELOG.md` (extension, read by the
// Marketplace as is) and `changelog/index.json` (website and update dialog).
// Only released versions are rendered; `unreleased.md` is read straight from
// the source by whoever needs it, so editing it never makes an output stale.
//
// `CHANGELOG.md` is legacy: app versions up to 1.22.1 fetch it from `main` for
// their update notes. It is refreshed only while it exists and is never
// recreated, so deleting it retires it for good.

import fs from 'node:fs';
import path from 'node:path';

export const GROUPS = ['New', 'Improvements', 'Fixes', 'Misc'];
const LEGACY_BANNER = '<!-- Legacy copy for app versions up to 1.22.1, which fetch this file for their update notes. Generated from changelog/*.md while it exists; delete it after 2026-09-19 and nothing will recreate it. -->';
export const SURFACES = ['App', 'VS Code'];

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{ [group: string]: string[] }} Groups  group name → bullet lines without the leading "- "
 * @typedef {{ version: string | null, date: string | null, title: string | null, intro: string[], app: Groups | null, vscode: Groups | null, file: string }} Release
 */

const fail = (file, line, message) => {
  throw new Error(`${file}:${line}: ${message}`);
};

/** Minimal front matter: `key: value` lines between `---` fences. */
const parseFrontMatter = (lines, file) => {
  if (lines[0] !== '---') return { meta: {}, bodyStart: 0 };
  const end = lines.indexOf('---', 1);
  if (end < 0) fail(file, 1, 'front matter is not closed');
  const meta = {};
  for (let index = 1; index < end; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const separator = raw.indexOf(':');
    if (separator < 0) fail(file, index + 1, `expected "key: value", got ${JSON.stringify(raw)}`);
    meta[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim();
  }
  return { meta, bodyStart: end + 1 };
};

/**
 * Parse one release file. Shape:
 *
 *   ---            (absent for unreleased.md)
 *   version: 1.2.3
 *   date: 2026-01-31
 *   title: optional
 *   ---
 *   optional intro paragraph(s)
 *   ## App
 *   ### New | Improvements | Fixes | Misc
 *   - bullet
 *   ## VS Code
 *   ### ...
 */
export const parseRelease = (text, file) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const { meta, bodyStart } = parseFrontMatter(lines, file);
  const release = {
    version: meta.version ?? null,
    date: meta.date ?? null,
    title: meta.title || null,
    intro: [],
    app: null,
    vscode: null,
    file,
  };
  if (release.version !== null && !VERSION_PATTERN.test(release.version)) fail(file, 1, `version ${JSON.stringify(release.version)} is not x.y.z`);
  if (release.date !== null && !DATE_PATTERN.test(release.date)) fail(file, 1, `date ${JSON.stringify(release.date)} is not YYYY-MM-DD`);

  let surface = null; // 'app' | 'vscode'
  let group = null;
  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index];
    const number = index + 1;
    if (line.startsWith('## ')) {
      const name = line.slice(3).trim();
      const position = SURFACES.indexOf(name);
      if (position < 0) fail(file, number, `unknown section ${JSON.stringify(name)}; expected one of ${SURFACES.join(', ')}`);
      surface = position === 0 ? 'app' : 'vscode';
      if (release[surface]) fail(file, number, `section ${name} appears twice`);
      release[surface] = {};
      group = null;
      continue;
    }
    if (line.startsWith('### ')) {
      const name = line.slice(4).trim();
      if (!surface) fail(file, number, `group ${JSON.stringify(name)} appears before any ## App or ## VS Code section`);
      if (!GROUPS.includes(name)) fail(file, number, `unknown group ${JSON.stringify(name)}; expected one of ${GROUPS.join(', ')}`);
      if (release[surface][name]) fail(file, number, `group ${name} appears twice in ${surface === 'app' ? 'App' : 'VS Code'}`);
      release[surface][name] = [];
      group = name;
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!surface || !group) fail(file, number, 'a bullet must sit under a ### group inside ## App or ## VS Code');
      const bullet = line.slice(2).trim();
      if (!bullet) fail(file, number, 'empty bullet');
      release[surface][group].push(bullet);
      continue;
    }
    if (!line.trim()) continue;
    if (surface === null) {
      release.intro.push(line.trimEnd());
      continue;
    }
    fail(file, number, `unexpected text inside a section; only "- " bullets belong under a group: ${JSON.stringify(line)}`);
  }
  return release;
};

const compareVersionsDesc = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (pa[index] !== pb[index]) return pb[index] - pa[index];
  }
  return 0;
};

/** Read `changelog/`: every `x.y.z.md` plus `unreleased.md`, newest first. */
export const loadReleases = (directory) => {
  const releases = [];
  let unreleased = null;
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.md') || name === 'README.md') continue;
    const file = path.join(directory, name);
    const release = parseRelease(fs.readFileSync(file, 'utf8'), path.relative(process.cwd(), file));
    if (name === 'unreleased.md') {
      if (release.version || release.date) fail(release.file, 1, 'unreleased.md carries no version or date');
      unreleased = release;
      continue;
    }
    const stem = name.slice(0, -3);
    if (!release.version || !release.date) fail(release.file, 1, 'a release file needs version and date in its front matter');
    if (!release.title) fail(release.file, 1, 'a release file needs a title in its front matter (two to six words naming its headline change)');
    if (release.version !== stem) fail(release.file, 1, `version ${release.version} does not match the file name ${stem}`);
    releases.push(release);
  }
  releases.sort((a, b) => compareVersionsDesc(a.version, b.version));
  const seen = new Set();
  for (const release of releases) {
    if (seen.has(release.version)) fail(release.file, 1, `version ${release.version} appears twice`);
    seen.add(release.version);
  }
  return { unreleased, releases };
};

const renderGroups = (groups) => {
  const blocks = [];
  for (const name of GROUPS) {
    const bullets = groups?.[name];
    if (!bullets || bullets.length === 0) continue;
    blocks.push(`### ${name}\n\n${bullets.map((bullet) => `- ${bullet}`).join('\n')}\n`);
  }
  return blocks.join('\n');
};

const renderHeader = (release) => (release.version ? `## [${release.version}] - ${release.date}` : '## [Unreleased]');

const renderSection = (release, groups, intro) => {
  const parts = [renderHeader(release), ''];
  if (intro.length > 0) parts.push(intro.join('\n'), '');
  const body = renderGroups(groups);
  if (body) parts.push(body);
  return parts.join('\n').replace(/\n+$/, '\n');
};

/** `CHANGELOG.md` (legacy): every released version's app notes. */
export const renderAppChangelog = ({ releases }) =>
  `# Changelog\n\n${LEGACY_BANNER}\n\n${releases.map((release) => renderSection(release, release.app, release.intro)).join('\n')}`;

/** `packages/vscode/CHANGELOG.md`: only releases that carry a VS Code section. */
export const renderVsCodeChangelog = ({ releases }) =>
  releases.filter((release) => release.vscode).map((release) => renderSection(release, release.vscode, [])).join('\n');

/** GitHub Release body for one release: intro and groups, no version header. */
export const renderReleaseNotes = (release) => {
  const parts = [];
  if (release.intro.length > 0) parts.push(release.intro.join('\n'), '');
  parts.push(renderGroups(release.app));
  return `${parts.join('\n').trim()}\n`;
};

const groupsToJson = (groups) => {
  if (!groups) return null;
  const out = {};
  for (const name of GROUPS) out[name.toLowerCase()] = groups[name] ?? [];
  return out;
};

/** `changelog/index.json`: released versions only, newest first. */
export const renderIndex = ({ releases }) => `${JSON.stringify(releases.map((release) => ({
  version: release.version,
  date: release.date,
  title: release.title,
  intro: release.intro.join('\n') || null,
  app: groupsToJson(release.app),
  vscode: groupsToJson(release.vscode),
})), null, 2)}\n`;

/**
 * Every generated file, keyed by path relative to the repo root. The legacy
 * `CHANGELOG.md` is included only on request (the build passes whether the
 * file still exists).
 */
export const renderOutputs = (loaded, { legacyAppChangelog = false } = {}) => {
  const outputs = {};
  if (legacyAppChangelog) outputs['CHANGELOG.md'] = renderAppChangelog(loaded);
  outputs['packages/vscode/CHANGELOG.md'] = renderVsCodeChangelog(loaded);
  outputs['changelog/index.json'] = renderIndex(loaded);
  return outputs;
};

export const UNRELEASED_TEMPLATE = `---
title:
---

## App

## VS Code
`;

/**
 * Turn `unreleased.md` into `<version>.md` dated `date`, keeping its title,
 * and reset `unreleased.md` to the empty template. Refuses an unreleased
 * file without bullets or without a title: a release with nothing to say,
 * or nothing to call it, is a mistake, not a release.
 */
export const promoteUnreleased = (directory, version, date) => {
  if (!VERSION_PATTERN.test(version)) throw new Error(`version ${JSON.stringify(version)} is not x.y.z`);
  if (!DATE_PATTERN.test(date)) throw new Error(`date ${JSON.stringify(date)} is not YYYY-MM-DD`);
  const source = path.join(directory, 'unreleased.md');
  const target = path.join(directory, `${version}.md`);
  if (fs.existsSync(target)) throw new Error(`${path.relative(process.cwd(), target)} already exists`);
  const text = fs.readFileSync(source, 'utf8');
  const release = parseRelease(text, path.relative(process.cwd(), source));
  const bullets = [...Object.values(release.app ?? {}), ...Object.values(release.vscode ?? {})].flat();
  if (bullets.length === 0) throw new Error('changelog/unreleased.md has no bullets; write the release notes before releasing');
  if (!release.title) throw new Error('changelog/unreleased.md has no title; add a `title:` line to its front matter before releasing');
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  fs.writeFileSync(target, `---\nversion: ${version}\ndate: ${date}\ntitle: ${release.title}\n---\n\n${body.replace(/^\n+/, '')}`);
  fs.writeFileSync(source, UNRELEASED_TEMPLATE);
  return target;
};
