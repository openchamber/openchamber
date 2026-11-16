
const NODE_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'yarn.lock'];
const PYTHON_FILES = ['pyproject.toml', 'requirements.txt', 'uv.lock', 'Pipfile', 'Pipfile.lock', 'poetry.lock', 'setup.py', 'setup.cfg'];

export const registryDomainsOf = (fileNames: readonly string[]): string[] => {
  const names = new Set(fileNames);
  const domains: string[] = [];
  if (NODE_FILES.some((name) => names.has(name))) domains.push('registry.npmjs.org');
  // external: https://classic.yarnpkg.com/lang/en/docs/cli/config/ Yarn 1 uses its own npm registry mirror.
  if (names.has('yarn.lock')) domains.push('registry.yarnpkg.com');
  if (PYTHON_FILES.some((name) => names.has(name))) domains.push('pypi.org', 'files.pythonhosted.org');
  return domains;
};
