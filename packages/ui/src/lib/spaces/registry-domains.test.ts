import { describe, expect, test } from 'bun:test';

import { registryDomainsOf } from './registry-domains';

describe('registryDomainsOf', () => {
  test('a node project installs from the npm registry, and a yarn 1 project from its mirror too', () => {
    expect(registryDomainsOf(['package.json', 'bun.lock', 'README.md'])).toEqual(['registry.npmjs.org']);
    expect(registryDomainsOf(['package.json', 'yarn.lock'])).toEqual(['registry.npmjs.org', 'registry.yarnpkg.com']);
  });

  test('a python project installs from PyPI and its file host', () => {
    expect(registryDomainsOf(['pyproject.toml', 'uv.lock'])).toEqual(['pypi.org', 'files.pythonhosted.org']);
    expect(registryDomainsOf(['requirements.txt'])).toEqual(['pypi.org', 'files.pythonhosted.org']);
  });

  test('a project with both gets both, and one with neither gets nothing', () => {
    expect(registryDomainsOf(['package.json', 'requirements.txt'])).toEqual(['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']);
    expect(registryDomainsOf(['go.mod', 'Cargo.toml', 'README.md'])).toEqual([]);
    expect(registryDomainsOf([])).toEqual([]);
  });
});
