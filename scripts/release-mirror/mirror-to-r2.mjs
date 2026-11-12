#!/usr/bin/env node
// Mirrors a release's files to Cloudflare R2, where the desktop app reads its
// updates first (packages/electron/updater-feed.mjs) and the website links its
// downloads: Stable releases to `desktop/stable/`, Canary nights to
// `desktop/canary/`.
//
//   node scripts/release-mirror/mirror-to-r2.mjs --channel stable --dir <files> --version 2.7.1 --keep 2.7.0
//   node scripts/release-mirror/mirror-to-r2.mjs --channel canary --dir <files> --version 2.7.1-canary.20261108.12
//
// The directory holds the build's `OpenChamber-<version>-*` files and its
// `latest*.yml` manifests; for Canary also the files whose names never change
// (the Android APK the website links, `canary-notes.json`). Uploads go through
// the AWS CLI's S3 commands with R2's endpoint; it reads AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY and R2_ACCOUNT_ID from the environment.
//
// Order matters to the apps reading the mirror: every file a manifest names
// is uploaded before the manifests, so a manifest never points at a missing
// file. Next `files.json` names the build and its files, which the website
// API reads to link Canary downloads (its file names change every night).
// Then older builds' files are deleted: Stable keeps the previous release,
// which the website still links until it is rebuilt; Canary keeps only
// tonight. Their `.blockmap`s stay longer: a
// Windows update downloads only the changed blocks, and for that
// electron-updater fetches the installed version's blockmap from the feed.
// Stable keeps every release's blockmaps (kilobytes each); Canary keeps the
// nights `canary-notes.json` covers. An app that read the old manifest just
// before the swap gets a 404 for the old file and retries on GitHub
// (packages/electron, pickUpdaterSource). A version older than one already on
// the mirror is refused, so a re-run for an old build cannot turn the
// manifests back.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../../packages/web/server/lib/version-order.js';
import { NIGHTS_KEPT } from '../changelog/canary-notes.mjs';

const BUCKET = 'openchamber-releases';
const MANIFEST_PATTERN = /^latest.*\.yml$/;
const RELEASE_FILE_PATTERN = /^OpenChamber-(\d+\.\d+\.\d+(?:-canary\.\d+\.\d+)?)-/;

const CHANNELS = {
  stable: {
    prefix: 'desktop/stable/',
    version: /^\d+\.\d+\.\d+$/,
    fixedNames: [],
    // The website links the release's files by name and is rebuilt only after
    // the next release is published, so the previous release stays whole.
    buildsKept: 2,
    blockmapBuildsKept: Infinity,
  },
  canary: {
    prefix: 'desktop/canary/',
    version: /^\d+\.\d+\.\d+-canary\.\d+\.\d+$/,
    // Replaced every night under the same name.
    fixedNames: ['OpenChamber-canary-android.apk', 'canary-notes.json'],
    // The website reaches Canary through the API, which reads files.json.
    buildsKept: 1,
    blockmapBuildsKept: NIGHTS_KEPT,
  },
};

/** The file names a manifest lists under `url:` and `path:`. */
export const manifestFiles = (text) => [...text.matchAll(/^\s*(?:-\s*)?(?:url|path):\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1]);

export const releaseVersionOf = (name) => RELEASE_FILE_PATTERN.exec(name)?.[1] ?? null;

/**
 * What to do with the mirror's current keys for `version` on `channel`: the
 * keys to delete (other builds' files, and blockmaps beyond the builds the
 * channel keeps them for), or a refusal when the mirror already serves a
 * newer build. `keep` names builds whose files stay whatever their age: the
 * release the website links, which a release that never got published must
 * not push out.
 */
export const planMirror = (keys, version, channel = 'stable', keep = []) => {
  const { prefix, buildsKept, blockmapBuildsKept } = CHANNELS[channel];
  const versionOfKey = (key) => releaseVersionOf(key.slice(prefix.length));
  const versions = [...new Set(keys.map(versionOfKey).filter(Boolean))];
  const newer = versions.filter((other) => compareVersions(other, version) > 0).sort(compareVersions);
  if (newer.length > 0) return { refuse: `the mirror already serves ${newer.at(-1)}` };
  const newestFirst = [...new Set([version, ...versions])].sort((a, b) => compareVersions(b, a));
  const kept = new Set([...newestFirst.slice(0, buildsKept), ...keep]);
  const blockmapsKept = new Set(newestFirst.slice(0, blockmapBuildsKept));
  return {
    remove: keys.filter((key) => {
      const of = versionOfKey(key);
      if (of === null || kept.has(of)) return false;
      return !(key.endsWith('.blockmap') && blockmapsKept.has(of));
    }),
  };
};

const parseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index].replace(/^--/, '')] = argv[index + 1];
  return args;
};

const main = () => {
  const { dir, version, channel = 'stable', keep } = parseArgs(process.argv.slice(2));
  const config = CHANNELS[channel];
  if (!dir || !config || !config.version.test(version ?? '')) {
    throw new Error('usage: mirror-to-r2.mjs --channel stable|canary --dir <files> --version <version of that channel>');
  }
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) throw new Error('R2_ACCOUNT_ID is not set');
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const aws = (...args) => execFileSync('aws', [...args, '--endpoint-url', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const upload = (name, ...options) => uploadFrom(dir, name, ...options);
  const uploadFrom = (from, name, ...options) => {
    console.log(`upload ${name}`);
    aws('s3', 'cp', path.join(from, name), `s3://${BUCKET}/${config.prefix}${name}`, '--only-show-errors', ...options);
  };

  const names = readdirSync(dir);
  const manifests = names.filter((name) => MANIFEST_PATTERN.test(name));
  const files = names.filter((name) => releaseVersionOf(name) === version);
  const fixed = config.fixedNames.filter((name) => names.includes(name));
  if (manifests.length === 0 || files.length === 0) throw new Error(`no manifests or ${version} files in ${dir}`);
  for (const manifest of manifests) {
    const text = readFileSync(path.join(dir, manifest), 'utf8');
    if (!new RegExp(`^version:\\s*['"]?${version.replaceAll('.', '\\.')}['"]?\\s*$`, 'm').test(text)) throw new Error(`${manifest} is not for ${version}`);
    for (const named of manifestFiles(text)) {
      if (!files.includes(named)) throw new Error(`${manifest} names ${named}, which is not in ${dir}`);
    }
  }

  const listed = JSON.parse(aws('s3api', 'list-objects-v2', '--bucket', BUCKET, '--prefix', config.prefix, '--output', 'json') || '{}');
  const plan = planMirror((listed.Contents ?? []).map((object) => object.Key), version, channel, keep ? [keep] : []);
  if (plan.refuse) throw new Error(`not mirroring ${version}: ${plan.refuse}`);

  // A name that carries the version never changes once uploaded.
  for (const name of files) upload(name, '--cache-control', 'public, max-age=31536000, immutable');
  for (const name of fixed) upload(name, '--cache-control', 'no-cache');
  for (const name of manifests) upload(name, '--cache-control', 'no-cache', '--content-type', 'text/yaml');
  const indexDir = mkdtempSync(path.join(os.tmpdir(), 'mirror-index-'));
  writeFileSync(path.join(indexDir, 'files.json'), `${JSON.stringify({ version, files: [...files, ...fixed] }, null, 2)}\n`);
  uploadFrom(indexDir, 'files.json', '--cache-control', 'no-cache', '--content-type', 'application/json');
  for (const key of plan.remove) {
    console.log(`delete ${key}`);
    aws('s3', 'rm', `s3://${BUCKET}/${key}`, '--only-show-errors');
  }
  console.log(`Mirrored ${files.length + fixed.length} files and ${manifests.length} manifests of ${version} to ${config.prefix}.`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
