import { allowedInsecureGitOrigins } from '../enterprise-mode.js';

const GITHUB_HOST = 'github.com';

/** `options.policy` is the policy-reading options of `allowedInsecureGitOrigins` (tests inject files through it). */
function isAllowedPlainHttpOrigin(raw, options) {
  try {
    return allowedInsecureGitOrigins(options.policy).has(new URL(raw).origin);
  } catch {
    return false;
  }
}


function normalizeGitOwnerRepo(owner, repo) {
  const normalizedOwner = String(owner || '').trim();
  const normalizedRepo = String(repo || '').trim().replace(/\.git$/i, '');
  if (!normalizedOwner || !normalizedRepo) {
    return null;
  }
  return { owner: normalizedOwner, repo: normalizedRepo };
}


// A branch or tag after `#`: letters, digits and `._/-`, never starting with
// `-` (it becomes a git argument) and never with `..`.
const GIT_REF_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** `host` (no port), `port` ('' when none) and path segments of an http(s) source, or null. */
function readHttpSource(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    return {
      host: url.hostname.toLowerCase(),
      port: url.port,
      pathSegments: url.pathname.split('/').filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** `host` and `port` of a `git@host[:port]:path` source, or null. */
function readSshSource(raw) {
  const withoutUser = raw.split('@')[1];
  if (!withoutUser) return null;
  const hostPart = withoutUser.split(':')[0];
  const portPart = withoutUser.split(':')[1] ?? '';
  const port = portPart.match(/^\d+/)?.[0] ?? '';
  return hostPart ? { host: hostPart.toLowerCase(), port } : null;
}

/**
 * `owner/repo#ref`, `https://host/owner/repo.git#ref`: the source without the
 * fragment, and the branch or tag it names (null when none).
 */
function splitSourceRef(source) {
  const hashIndex = source.lastIndexOf('#');
  if (hashIndex < 0) return { base: source, ref: null };
  const ref = source.slice(hashIndex + 1).trim();
  return { base: source.slice(0, hashIndex).trim(), ref: ref || null };
}

export function parseSkillRepoSource(input, options = {}) {
  const parsed = parseSkillRepoBase(input, options);
  if (!parsed.ok) return parsed;
  const { ref } = splitSourceRef(typeof input === 'string' ? input.trim() : '');
  if (ref !== null && !GIT_REF_PATTERN.test(ref)) {
    return { ok: false, error: { kind: 'invalidSource', message: `Invalid branch or tag "${ref}"` } };
  }
  return { ...parsed, ref };
}

function parseSkillRepoBase(input, options) {
  const raw = splitSourceRef(typeof input === 'string' ? input.trim() : '').base;
  if (!raw) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Repository source is required' } };
  }
  const explicitSubpath = typeof options.subpath === 'string' && options.subpath.trim() ? options.subpath.trim() : null;

  // Plain HTTP is accepted only for a host the administrator (or the user, in
  // Settings → Git) listed in `allowedInsecureGitOrigins`; anything else keeps
  // being refused as before.
  const isPlainHttp = raw.slice(0, 7).toLowerCase() === 'http://';
  if (isPlainHttp && !isAllowedPlainHttpOrigin(raw, options)) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Plain HTTP sources must be listed in allowedInsecureGitOrigins' } };
  }

  const urlFormat = raw.startsWith('https://') || isPlainHttp ? 'https' : raw.startsWith('git@') ? 'ssh' : 'shorthand';
  const scheme = isPlainHttp ? 'http' : 'https';
  // For a URL source, host (no port), port, and path segments; null when the
  // URL can't be read. The SSH clone URL needs the host and port apart:
  // `git@host:port:path` is not a form git can resolve, so a port-bearing
  // source uses `ssh://git@host:port/path` instead.
  const urlParts = urlFormat === 'https' ? readHttpSource(raw) : null;
  const sshParts = urlFormat === 'ssh' ? readSshSource(raw) : null;
  const gitHost = urlParts ? urlParts.host : sshParts ? sshParts.host : null;

  if (gitHost === null && urlFormat !== 'shorthand') {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid repository URL format' } };
  }

  const pathSegments = urlParts
    ? urlParts.pathSegments
    : sshParts
      ? (raw.split('@')[1].split(':')[1] ?? '').split('/').filter(Boolean)
      : null;

  const repoName = pathSegments && pathSegments.length > 0
    ? pathSegments[pathSegments.length - 1].replace(/\.git$/i, '')
    : null;

  const gitOwner = pathSegments && pathSegments.length > 1
    ? pathSegments.slice(0, -1).join('/')
    : (pathSegments && pathSegments.length === 1 ? pathSegments[0] : null);


  // SSH git@host:owner/repo(.git) or HTTPS http(s)://host[:port]/owner/repo(.git)
  if (urlFormat === 'ssh' || urlFormat === 'https') {
    const parsed = normalizeGitOwnerRepo(gitOwner, repoName);
    if (!parsed) {
      return { ok: false, error: { kind: 'invalidSource', message: `Invalid ${urlFormat} repository URL` } };
    }

    // An explicit port only survives in the ssh:// URL form; the scp-style
    // `git@host:port:path` addresses a `port`-owned repo instead.
    const sourcePort = urlParts ? urlParts.port : sshParts ? sshParts.port : '';
    const sshCloneUrl = sourcePort
      ? `ssh://git@${gitHost}:${sourcePort}/${parsed.owner}/${parsed.repo}.git`
      : `git@${gitHost}:${parsed.owner}/${parsed.repo}.git`;

    return {
      ok: true,
      host: gitHost,
      owner: parsed.owner,
      repo: parsed.repo,
      cloneUrlSsh: sshCloneUrl,
      cloneUrlHttps: `${scheme}://${sourcePort ? `${gitHost}:${sourcePort}` : gitHost}/${parsed.owner}/${parsed.repo}.git`,
      // For SSH URLs, subpath is only accepted via options.subpath
      effectiveSubpath: explicitSubpath,
      normalizedRepo: `${parsed.owner}/${parsed.repo}`,
    };
  }

  // Shorthand: owner/repo[/subpath...]
  const shorthandMatch = raw.match(/^([^/\s]+)\/([^/\s]+)(?:\/(.+))?$/);
  if (shorthandMatch) {
    const parsed = normalizeGitOwnerRepo(shorthandMatch[1], shorthandMatch[2]);
    if (!parsed) {
      return { ok: false, error: { kind: 'invalidSource', message: 'Invalid repository source' } };
    }

    const shorthandSubpath = typeof shorthandMatch[3] === 'string' && shorthandMatch[3].trim() ? shorthandMatch[3].trim() : null;
    const effectiveSubpath = explicitSubpath || shorthandSubpath;

    return {
      ok: true,
      host: GITHUB_HOST,
      owner: parsed.owner,
      repo: parsed.repo,
      cloneUrlSsh: `git@github.com:${parsed.owner}/${parsed.repo}.git`,
      cloneUrlHttps: `https://github.com/${parsed.owner}/${parsed.repo}.git`,
      effectiveSubpath,
      normalizedRepo: `${parsed.owner}/${parsed.repo}`,
    };
  }

  return { ok: false, error: { kind: 'invalidSource', message: 'Unsupported repository source format' } };
}
