const QUERY_BASE_URL = 'http://openchamber.local';
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/i;

const valueTag = (value) => {
  return Object.prototype.toString.call(value);
};

const isNumberValue = (value) => {
  return valueTag(value) === '[object Number]';
};

const isPlainObject = (value) => {
  return valueTag(value) === '[object Object]';
};

const isStringValue = (value) => {
  return valueTag(value) === '[object String]';
};

const readPlainObject = (value) => {
  return isPlainObject(value) ? value : null;
};

const readStringValue = (value) => {
  return isStringValue(value) ? value : null;
};

const readNullableStringValue = (value) => {
  if (value === null) {
    return null;
  }
  return readStringValue(value);
};

const readNumberValue = (value) => {
  return isNumberValue(value) ? value : null;
};

const parseCommitDetailsQuery = (requestUrl) => {
  const params = new URL(requestUrl, QUERY_BASE_URL).searchParams;
  const directory = params.get('directory')?.trim() ?? '';
  const hash = params.get('hash')?.trim() ?? '';
  const remote = params.get('remote')?.trim() ?? '';
  if (!directory) {
    return { ok: false, error: 'directory' };
  }
  if (!COMMIT_HASH_PATTERN.test(hash)) {
    return { ok: false, error: 'hash' };
  }
  return {
    ok: true,
    value: { directory, hash, remote },
  };
};

const parseCommitDetailsResult = (commit) => {
  const commitObject = readPlainObject(commit);
  const commitAuthorObject = commitObject ? readPlainObject(commitObject.commit) : null;
  const authorIdentityObject = commitAuthorObject ? readPlainObject(commitAuthorObject.author) : null;
  const authorObject = commitObject ? readPlainObject(commitObject.author) : null;

  const login = authorObject ? readStringValue(authorObject.login) : null;
  const id = authorObject ? readNumberValue(authorObject.id) : null;
  const avatarUrl = authorObject ? readStringValue(authorObject.avatar_url) : null;
  const name = authorIdentityObject ? readStringValue(authorIdentityObject.name) : null;
  const email = authorIdentityObject ? readStringValue(authorIdentityObject.email) : null;
  const url = commitObject ? readNullableStringValue(commitObject.html_url) : null;

  return {
    connected: true,
    url,
    author: login
      ? {
          login,
          id: id ?? undefined,
          avatarUrl: avatarUrl ?? undefined,
          name: name ?? undefined,
          email: email ?? undefined,
        }
      : null,
  };
};

export const createGitHubCommitDetailsRoute = ({
  getGitHubLibraries,
  isGitHubAuthInvalid,
}) => {
  return async (req, res) => {
    try {
      const parsedQuery = parseCommitDetailsQuery(req.originalUrl);
      if (!parsedQuery.ok) {
        if (parsedQuery.error === 'directory') {
          return res.status(400).json({ error: 'directory is required' });
        }
        return res.status(400).json({ error: 'hash must be 7 to 64 hexadecimal characters' });
      }
      const { directory, hash, remote } = parsedQuery.value;

      const { getOctokitOrNull, clearGitHubAuth, resolveGitHubRepoFromDirectory } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { repo } = await resolveGitHubRepoFromDirectory(directory, remote || undefined);
      if (!repo) {
        return res.json({ connected: true, url: null, author: null });
      }

      try {
        const commitResponse = await octokit.rest.repos.getCommit({
          owner: repo.owner,
          repo: repo.repo,
          ref: hash,
        });
        return res.json(parseCommitDetailsResult(commitResponse?.data));
      } catch (error) {
        if (isGitHubAuthInvalid(error)) {
          clearGitHubAuth();
          return res.json({ connected: false });
        }
        if (error?.status === 404) {
          return res.json({ connected: true, url: null, author: null });
        }
        throw error;
      }
    } catch (error) {
      console.error('Failed to load GitHub commit details:', error);
      return res.status(500).json({ error: error.message || 'Failed to load GitHub commit details' });
    }
  };
};
