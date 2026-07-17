import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  GIT_NETWORK_USAGE,
  GIT_INTERNAL_OPERATION_CLASSIFICATION,
  GIT_OPERATION_PROFILE,
  GIT_RUNTIME_OWNER_CLASSIFICATION,
  GIT_RUNTIME_OWNER_KIND,
  GIT_SERVICE_OPERATION_CLASSIFICATION,
  getGitOperationClassification,
  getGitServiceOperationClassification,
} from './operation-classification.js';

const exportedServiceOperations = () => {
  const source = fs.readFileSync(new URL('./service.js', import.meta.url), 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^export\s+const\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1] || match[2]);
  }
  return [...names].sort();
};

describe('Git operation classification', () => {
  it('classifies every exported service operation exactly once', () => {
    expect(Object.keys(GIT_SERVICE_OPERATION_CLASSIFICATION).sort()).toEqual(exportedServiceOperations());
  });

  it('uses only closed, immutable profile and network values', () => {
    const profiles = new Set(Object.values(GIT_OPERATION_PROFILE));
    const networkValues = new Set(Object.values(GIT_NETWORK_USAGE));

    expect(Object.isFrozen(GIT_SERVICE_OPERATION_CLASSIFICATION)).toBe(true);
    for (const classification of Object.values(GIT_SERVICE_OPERATION_CLASSIFICATION)) {
      expect(Object.isFrozen(classification)).toBe(true);
      expect(profiles.has(classification.profile)).toBe(true);
      expect(networkValues.has(classification.network)).toBe(true);
    }
  });

  it('keeps local probes local and marks only real remote paths as network-capable', () => {
    expect(getGitServiceOperationClassification('getStatus')).toEqual({
      profile: GIT_OPERATION_PROFILE.READ,
      network: GIT_NETWORK_USAGE.NONE,
    });
    expect(getGitServiceOperationClassification('getRemoteUrl').network).toBe(GIT_NETWORK_USAGE.NONE);
    expect(getGitServiceOperationClassification('getBranches').network).toBe(GIT_NETWORK_USAGE.CONDITIONAL);
    expect(getGitServiceOperationClassification('fetch').network).toBe(GIT_NETWORK_USAGE.REQUIRED);
    expect(getGitServiceOperationClassification('pull').network).toBe(GIT_NETWORK_USAGE.REQUIRED);
    expect(getGitServiceOperationClassification('push').network).toBe(GIT_NETWORK_USAGE.REQUIRED);
  });

  it('makes compound, topology, bootstrap, memory, and pure ownership explicit', () => {
    expect(getGitServiceOperationClassification('commit').profile).toBe(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE);
    expect(getGitServiceOperationClassification('createWorktree').profile).toBe(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE);
    expect(getGitServiceOperationClassification('isGitRepository').profile).toBe(GIT_OPERATION_PROFILE.BOOTSTRAP);
    expect(getGitServiceOperationClassification('getWorktreeBootstrapStatus').profile).toBe(GIT_OPERATION_PROFILE.MEMORY);
    expect(getGitServiceOperationClassification('resolveBaseRefForLog').profile).toBe(GIT_OPERATION_PROFILE.PURE);
    expect(() => getGitServiceOperationClassification('futureOperation')).toThrow('Unclassified Git service operation');
  });

  it('classifies background Git work separately from user-authored start commands', () => {
    expect(GIT_INTERNAL_OPERATION_CLASSIFICATION.worktreeBootstrap).toEqual({
      profile: GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE,
      network: GIT_NETWORK_USAGE.CONDITIONAL,
    });
    expect(getGitOperationClassification('worktreeBootstrap')).toBe(
      GIT_INTERNAL_OPERATION_CLASSIFICATION.worktreeBootstrap,
    );
    expect(GIT_RUNTIME_OWNER_CLASSIFICATION['worktree/start-command'].kind)
      .toBe(GIT_RUNTIME_OWNER_KIND.USER_SHELL_BYPASS);
  });
});

describe('Git direct-runtime owner classification', () => {
  it('keeps migrated owners and intentional bypasses in a closed immutable inventory', () => {
    expect(Object.keys(GIT_RUNTIME_OWNER_CLASSIFICATION).sort()).toEqual([
      'external-git-processes',
      'fs/clone',
      'fs/exec',
      'fs/list-check-ignore',
      'fs/search-check-ignore',
      'git/context-discovery',
      'git/hooks-and-helpers',
      'git/service',
      'notifications/branch',
      'skills-catalog/clone-repository',
      'skills-catalog/git-version',
      'worktree/start-command',
    ]);
    expect(Object.isFrozen(GIT_RUNTIME_OWNER_CLASSIFICATION)).toBe(true);

    const kinds = new Set(Object.values(GIT_RUNTIME_OWNER_KIND));
    for (const classification of Object.values(GIT_RUNTIME_OWNER_CLASSIFICATION)) {
      expect(Object.isFrozen(classification)).toBe(true);
      expect(kinds.has(classification.kind)).toBe(true);
    }
  });

  it('keeps direct web-server Git owners delegated or explicitly reserved', () => {
    const fsRoutes = fs.readFileSync(new URL('../fs/routes.js', import.meta.url), 'utf8');
    const fsSearch = fs.readFileSync(new URL('../fs/search.js', import.meta.url), 'utf8');
    const skillsScan = fs.readFileSync(new URL('../skills-catalog/scan.js', import.meta.url), 'utf8');
    const skillsInstall = fs.readFileSync(new URL('../skills-catalog/install.js', import.meta.url), 'utf8');
    const notificationTemplate = fs.readFileSync(new URL('../notifications/template-runtime.js', import.meta.url), 'utf8');
    const featureRoutes = fs.readFileSync(new URL('../opencode/feature-routes-runtime.js', import.meta.url), 'utf8');
    const serverIndex = fs.readFileSync(new URL('../../index.js', import.meta.url), 'utf8');

    expect(fsRoutes).toContain('cloneRepository({');
    expect(fsRoutes).not.toContain('spawn(resolveGitBinaryForSpawn(), gitArgs');
    expect(fsRoutes).toContain('getIgnoredPaths(resolvedPath, pathsToCheck');
    expect(fsRoutes).not.toContain("['check-ignore'");
    expect(fsSearch).toContain('getIgnoredPaths(dir, pathsToCheck)');
    expect(fsSearch).not.toContain("['check-ignore'");
    expect(skillsScan).toContain('withGitCloneReservation(tempBase');
    expect(skillsInstall).toContain('withGitCloneReservation(tempBase');
    expect(skillsScan).toContain('lease.releaseNetwork()');
    expect(skillsInstall).toContain('lease.releaseNetwork()');
    expect(notificationTemplate).toContain("getGitStatus(worktreeDir, { mode: 'light'");
    expect(notificationTemplate).not.toContain("import('simple-git')");
    expect(featureRoutes).not.toContain('resolveGitBinaryForSpawn');
    expect(featureRoutes).toContain('registerFsRoutes(app, {');
    expect(featureRoutes).toContain('spawn,');
    expect(serverIndex).not.toContain('const resolveGitBinaryForSpawn');
  });
});
