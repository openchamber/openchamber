const GITHUB_HOST = 'github.com';


function normalizeGitOwnerRepo(owner, repo) {
  const normalizedOwner = String(owner || '').trim();
  const normalizedRepo = String(repo || '').trim().replace(/\.git$/i, '');
  if (!normalizedOwner || !normalizedRepo) {
    return null;
  }
  return { owner: normalizedOwner, repo: normalizedRepo };
}


export function parseSkillRepoSource(input, options = {}) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Repository source is required' } };
  }
  const explicitSubpath = typeof options.subpath === 'string' && options.subpath.trim() ? options.subpath.trim() : null;
  
  const urlFormat = raw.startsWith('https://') ? 'https' : raw.startsWith('git@') ? 'ssh' : 'shorthand';
  const gitHost = urlFormat === 'https' ? raw.split('/')[2] : urlFormat === 'ssh' ? raw.split('@')[1].split(':')[0] : null;

  if (gitHost === null && urlFormat !== 'shorthand') {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid repository URL format' } };
  }

  const pathSegments = urlFormat === 'https'
    ? raw.split('/').slice(3).filter(Boolean)
    : urlFormat === 'ssh'
      ? (raw.split('@')[1].split(':')[1] ?? '').split('/').filter(Boolean)
      : null;

  const repoName = pathSegments && pathSegments.length > 0
    ? pathSegments[pathSegments.length - 1].replace(/\.git$/i, '')
    : null;

  const gitOwner = pathSegments && pathSegments.length > 1
    ? pathSegments.slice(0, -1).join('/')
    : (pathSegments && pathSegments.length === 1 ? pathSegments[0] : null);


  // SSH git@host:owner/repo(.git) or HTTPS https://host/owner/repo(.git)
  if (urlFormat === 'ssh' || urlFormat === 'https') {
    const parsed = normalizeGitOwnerRepo(gitOwner, repoName);
    if (!parsed) {
      return { ok: false, error: { kind: 'invalidSource', message: `Invalid ${urlFormat} repository URL` } };
    }

    return {
      ok: true,
      host: gitHost,
      owner: parsed.owner,
      repo: parsed.repo,
      cloneUrlSsh: `git@${gitHost}:${parsed.owner}/${parsed.repo}.git`,
      cloneUrlHttps: `https://${gitHost}/${parsed.owner}/${parsed.repo}.git`,
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
