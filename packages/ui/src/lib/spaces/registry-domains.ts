// The package registries a project's own files say it installs from, offered as the first domains
// of a new space's allowlist: the setup commands install dependencies, and an empty list would
// refuse every download. The user sees them in the dialog and removes what they do not want
// (the maintainer's call of 2026-10-15). Only the runtimes a space has are read: node with npm,
// yarn, pnpm and bun, and python with uv.

const NODE_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'yarn.lock'];
const PYTHON_FILES = ['pyproject.toml', 'requirements.txt', 'uv.lock', 'Pipfile', 'Pipfile.lock', 'poetry.lock', 'setup.py', 'setup.cfg'];

/** The registry domains for the names of the files in a project's root folder, in a stable order. */
export const registryDomainsOf = (fileNames: readonly string[]): string[] => {
  const names = new Set(fileNames);
  const domains: string[] = [];
  if (NODE_FILES.some((name) => names.has(name))) domains.push('registry.npmjs.org');
  // Yarn 1 resolves from its own mirror of the npm registry.
  if (names.has('yarn.lock')) domains.push('registry.yarnpkg.com');
  if (PYTHON_FILES.some((name) => names.has(name))) domains.push('pypi.org', 'files.pythonhosted.org');
  return domains;
};
