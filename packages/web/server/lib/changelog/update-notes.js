// Release notes for the update dialog.
//
// The repo publishes `changelog/index.json` on `main`: one object per release,
// newest first, with the app notes grouped as New / Improvements / Fixes /
// SDK / Misc. The website API serves the same releases and keeps the last
// good copy through a GitHub outage, so it is read first and the file on
// GitHub only when the API fails. This module renders the releases between the installed
// version (exclusive) and the offered one (inclusive) as the Markdown the
// dialog already understands: a `## [x.y.z] - YYYY-MM-DD` header per release,
// the release title in bold, the intro, then the groups.
//
// A Canary build is offered with the nights of the `canary` pre-release's
// `canary-notes.json` instead (scripts/changelog/canary-notes.mjs), rendered
// the same way: one `## [version] - date` section per night.
//
// Any failure (network, 404, unexpected shape) yields null: the update is
// still offered, only without notes.
//
// Settings > About shows the same releases as data (`fetchReleaseNotes`):
// the installed version's own notes, or the ones an offered update brings.

const CHANGELOG_API_URL = 'https://api.openchamber.dev/v1/changelog/full';
const CHANGELOG_INDEX_URL = 'https://raw.githubusercontent.com/openchamber/openchamber/main/changelog/index.json';
// canary.yml writes the nights to the R2 mirror too; GitHub is the fallback.
const CANARY_NOTES_MIRROR_URL = 'https://downloads.openchamber.dev/desktop/canary/canary-notes.json';
const CANARY_NOTES_URL = 'https://github.com/openchamber/openchamber/releases/download/canary/canary-notes.json';
const PULL_URL = 'https://github.com/openchamber/openchamber/pull/';

const GROUPS = [
  ['new', 'New'],
  ['improvements', 'Improvements'],
  ['fixes', 'Fixes'],
  ['sdk', 'SDK'],
  ['misc', 'Misc'],
];

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const CANARY_VERSION_PATTERN = /^\d+\.\d+\.\d+-canary\.\d+\.\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// The file crosses a network boundary with no schema library on this side, so
// each field is coerced into its domain shape here; a release without a valid
// version and date is dropped.
const text = (value) => (value === null || value === undefined ? null : String(value).trim() || null);
const bulletList = (value) => (Array.isArray(value) ? value.map((item) => String(item)) : []);

const parseRelease = (entry) => {
  if (entry === null || entry === undefined) return null;
  const version = text(entry.version);
  const date = text(entry.date);
  if (!version || !VERSION_PATTERN.test(version) || !date || !DATE_PATTERN.test(date)) return null;
  const app = entry.app ?? {};
  return {
    version,
    date,
    title: text(entry.title),
    intro: text(entry.intro),
    groups: GROUPS.map(([key, heading]) => ({ key, heading, bullets: bulletList(app[key]) })),
  };
};

const renderRelease = (release) => {
  const lines = [`## [${release.version}] - ${release.date}`, ''];
  if (release.title) lines.push(`**${release.title}**`, '');
  if (release.intro) lines.push(release.intro, '');
  for (const { heading, bullets } of release.groups) {
    if (bullets.length === 0) continue;
    lines.push(`### ${heading}`, '', ...bullets.map((bullet) => `- ${bullet}`), '');
  }
  return lines.join('\n').trim();
};

// Commit scopes as people write the names.
const AREA_NAMES = { ui: 'UI', sdk: 'SDK', vscode: 'VS Code', mcp: 'MCP', ssh: 'SSH', ios: 'iOS', api: 'API', cli: 'CLI', pwa: 'PWA' };

const areaName = (area) => AREA_NAMES[area] ?? `${area.charAt(0).toUpperCase()}${area.slice(1).replaceAll('-', ' ')}`;

// "**Chat:** remember thinking level per model [#5505](…)" from one commit.
const canaryBullet = (change) => {
  const body = text(change?.text);
  if (!body) return null;
  const area = text(change.area);
  const label = area ? `**${areaName(area)}:** ` : '';
  const pr = /^\d+$/.test(String(change.pr ?? '')) ? ` [#${change.pr}](${PULL_URL}${change.pr})` : '';
  return `${label}${area ? body : `${body.charAt(0).toUpperCase()}${body.slice(1)}`}${pr}`;
};

const parseCanaryNight = (entry) => {
  if (entry === null || entry === undefined) return null;
  const version = text(entry.version);
  const date = text(entry.date);
  if (!version || !CANARY_VERSION_PATTERN.test(version) || !date || !DATE_PATTERN.test(date)) return null;
  const bullets = (value) => (Array.isArray(value) ? value.map(canaryBullet).filter(Boolean) : []);
  return {
    version,
    date,
    title: null,
    intro: null,
    groups: [
      { key: 'new', heading: 'New', bullets: bullets(entry.new) },
      { key: 'fixes', heading: 'Fixes', bullets: bullets(entry.fixes) },
    ],
  };
};

/** The parsed releases in (fromVersion, toVersion], newest first. */
const selectBetween = (entries, parse, fromVersion, toVersion, compareVersions) => entries
  .map(parse)
  .filter((release) => release !== null)
  .filter((release) => compareVersions(release.version, fromVersion) > 0 && compareVersions(release.version, toVersion) <= 0)
  .sort((a, b) => compareVersions(b.version, a.version));

const renderBetween = (entries, parse, fromVersion, toVersion, compareVersions) => {
  if (!Array.isArray(entries)) return null;
  const relevant = selectBetween(entries, parse, fromVersion, toVersion, compareVersions);
  if (relevant.length === 0) return null;
  return relevant.map(renderRelease).join('\n\n');
};

/**
 * Markdown for the releases in (fromVersion, toVersion], newest first, or
 * null when the index holds none of them.
 */
export function renderUpdateNotes(index, fromVersion, toVersion, compareVersions) {
  return renderBetween(index, parseRelease, fromVersion, toVersion, compareVersions);
}

/** The same for the Canary nights in (fromVersion, toVersion]. */
export function renderCanaryNotes(nights, fromVersion, toVersion, compareVersions) {
  return renderBetween(nights, parseCanaryNight, fromVersion, toVersion, compareVersions);
}

const fetchJson = async (url, options) => {
  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

// The API's feed entries in the index's shape. An entry the API took from a
// GitHub Release body has no groups and is left out.
const indexFromApiFeed = (feed) => {
  if (!Array.isArray(feed?.entries)) return null;
  const releases = feed.entries
    .filter((entry) => entry?.groups)
    .map(({ version, date, title, intro, groups }) => ({ version, date, title, intro, app: groups }));
  return releases.length > 0 ? releases : null;
};

const asArray = (value) => (Array.isArray(value) ? value : null);

/**
 * The release index, or the Canary nights for a Canary version; null on any
 * failure. The first source is ours, the website API or the R2 mirror, which
 * answers fast, so a slow answer means it is down and GitHub gets the rest of
 * the wait.
 */
const fetchEntries = async (canary, options) => {
  const first = { ...options, timeoutMs: options.timeoutMs ?? 5_000 };
  if (canary) return asArray(await fetchJson(CANARY_NOTES_MIRROR_URL, first)) ?? asArray(await fetchJson(CANARY_NOTES_URL, options));
  return indexFromApiFeed(await fetchJson(CHANGELOG_API_URL, first)) ?? asArray(await fetchJson(CHANGELOG_INDEX_URL, options));
};

/** Fetch the notes and render them for one update; null on any failure. */
export async function fetchUpdateNotes(fromVersion, toVersion, compareVersions, options = {}) {
  const canary = CANARY_VERSION_PATTERN.test(String(toVersion ?? ''));
  const entries = await fetchEntries(canary, options);
  if (!entries) return null;
  return (canary ? renderCanaryNotes : renderUpdateNotes)(entries, fromVersion, toVersion, compareVersions);
}

/**
 * The releases of `version` as data, newest first: those in (since, version]
 * when `since` is older, else `version` alone (the installed version, or the
 * way back from Canary to Stable). An empty list means the source has no
 * notes for it; null means the source could not be read.
 */
export async function fetchReleaseNotes(version, since, compareVersions, options = {}) {
  const canary = CANARY_VERSION_PATTERN.test(version);
  const entries = await fetchEntries(canary, options);
  if (!entries) return null;
  const parse = canary ? parseCanaryNight : parseRelease;
  const releases = since && compareVersions(version, since) > 0
    ? selectBetween(entries, parse, since, version, compareVersions)
    : entries.map(parse).filter((release) => release?.version === version);
  return releases.map(({ version: releaseVersion, date, title, intro, groups }) => ({
    version: releaseVersion,
    date,
    title,
    intro,
    groups: groups.filter(({ bullets }) => bullets.length > 0).map(({ key, bullets }) => ({ key, bullets })),
  }));
}
