import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrivateRepositoryIdentityResolver, resolvePrivateRepositoryIdentity, resolveRepositoryIdentity } from './repository-identity.js';
import { createBindingService } from './binding-service.js';
import { parseBindingStore } from './binding-contract.js';
import { fingerprintRemoteUrl, redactRemoteUrl, redactSensitiveText } from './url-redaction.js';

const directories = [];
const makeDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-repository-'));
  directories.push(directory);
  return directory;
};
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeEach(() => {
  const globalConfig = path.join(makeDirectory(), 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('source-control repository identity', () => {
  it('uses one identity for the checkout, linked worktree, and symlink', async () => {
    const repository = makeDirectory();
    const worktree = makeDirectory();
    const symlink = path.join(makeDirectory(), 'repository-link');
    git(repository, ['init', '-b', 'main']);
    git(repository, ['config', 'user.email', 'test@example.com']);
    git(repository, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'Initial commit']);
    fs.rmSync(worktree, { recursive: true, force: true });
    git(repository, ['worktree', 'add', '-b', 'feature/test', worktree, 'HEAD']);
    fs.symlinkSync(repository, symlink, 'dir');

    const mainContext = await resolveRepositoryIdentity(repository);
    const worktreeContext = await resolveRepositoryIdentity(worktree);
    const symlinkContext = await resolveRepositoryIdentity(symlink);

    expect(mainContext.repositoryId).toBe(worktreeContext.repositoryId);
    expect(mainContext.repositoryId).toBe(symlinkContext.repositoryId);
    expect(mainContext.configRevision).toBe(worktreeContext.configRevision);
    expect(mainContext.configRevision).toBe(symlinkContext.configRevision);
  });

  it('validates one binding from main and linked worktree despite unrelated worktree config', async () => {
    const repository = makeDirectory();
    const worktree = makeDirectory();
    git(repository, ['init', '-b', 'main']);
    git(repository, ['config', 'user.email', 'test@example.com']);
    git(repository, ['config', 'user.name', 'Test User']);
    git(repository, ['config', 'extensions.worktreeConfig', 'true']);
    git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/repository.git']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'Initial commit']);
    fs.rmSync(worktree, { recursive: true, force: true });
    git(repository, ['worktree', 'add', '-b', 'feature/test', worktree, 'HEAD']);
    git(worktree, ['config', '--worktree', 'user.email', 'worktree@example.com']);

    const mainContext = await resolveRepositoryIdentity(repository);
    const worktreeContext = await resolveRepositoryIdentity(worktree);
    expect(worktreeContext.configRevision).toBe(mainContext.configRevision);

    let record = { revision: 0, binding: null };
    const store = {
      read: async () => record,
      compareAndSwap: async (repositoryId, expectedRevision, binding) => {
        expect(expectedRevision).toBe(record.revision);
        const revision = record.revision + 1;
        record = { revision, binding: { ...binding, repositoryId, revision } };
        return record;
      },
    };
    const service = createBindingService({ store, resolveRepository: resolveRepositoryIdentity });
    const saved = await service.set({
      directory: repository,
      expectedRepositoryId: mainContext.repositoryId,
      expectedRevision: 0,
      expectedConfigRevision: mainContext.configRevision,
      binding: {
        state: 'bound',
        providers: [{ provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin' }],
        remotes: [],
      },
    });

    git(repository, ['config', 'user.name', 'Changed Author']);
    git(repository, ['config', 'user.email', 'changed@example.com']);
    git(repository, ['config', 'branch.main.remote', 'origin']);
    git(repository, ['config', 'branch.main.merge', 'refs/heads/main']);
    git(worktree, ['config', '--worktree', 'branch.feature/test.remote', 'origin']);
    git(worktree, ['config', '--worktree', 'branch.feature/test.merge', 'refs/heads/feature/test']);
    expect((await resolveRepositoryIdentity(repository)).configRevision).toBe(mainContext.configRevision);
    expect((await resolveRepositoryIdentity(worktree)).configRevision).toBe(mainContext.configRevision);

    await expect(service.validateReadContext({
      directory: worktree,
      repositoryId: mainContext.repositoryId,
      provider: 'github',
      instance: 'github.com',
      accountId: 'github.com#7',
      bindingRevision: saved.revision,
      primaryRemote: 'origin',
    })).resolves.toMatchObject({ repositoryId: mainContext.repositoryId, bindingRevision: saved.revision });

    git(repository, ['remote', 'set-url', 'origin', 'https://github.com/other/repository.git']);
    await expect(service.validateReadContext({
      directory: worktree,
      repositoryId: mainContext.repositoryId,
      provider: 'github',
      instance: 'github.com',
      accountId: 'github.com#7',
      bindingRevision: saved.revision,
      primaryRemote: 'origin',
    })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE' });
  });

  it('rejects an old config-byte revision at the same path until a deliberate resave', async () => {
    const repository = makeDirectory();
    const remoteUrl = 'https://github.com/acme/repository.git';
    git(repository, ['init', '-b', 'main']);
    git(repository, ['remote', 'add', 'origin', remoteUrl]);
    const context = await resolveRepositoryIdentity(repository);
    const oldRevision = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(repository, '.git', 'config')))
      .update('\0')
      .update(JSON.stringify([{ name: 'origin', fetchUrl: remoteUrl, pushUrl: remoteUrl }]))
      .digest('base64url');
    expect(context.configRevision).not.toBe(oldRevision);

    const binding = {
      state: 'bound',
      providers: [{ provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin' }],
      remotes: [],
    };
    let record = parseBindingStore({ version: 2, repositories: { [context.repositoryId]: {
      revision: 1,
      binding: {
        ...binding,
        repositoryId: context.repositoryId,
        revision: 1,
        configRevision: oldRevision,
        providers: binding.providers.map((provider) => ({ ...provider, readiness: 'confirmation-required', endpoint: null })),
        auxiliary: [],
      },
    } } }).repositories[context.repositoryId];
    const service = createBindingService({
      resolveRepository: resolveRepositoryIdentity,
      store: {
        read: async () => record,
        compareAndSwap: async (repositoryId, expectedRevision, nextBinding) => {
          expect(repositoryId).toBe(context.repositoryId);
          expect(expectedRevision).toBe(record.revision);
          const revision = record.revision + 1;
          record = { revision, binding: { ...nextBinding, repositoryId, revision } };
          return record;
        },
      },
    });
    const readContext = {
      directory: repository, repositoryId: context.repositoryId, bindingRevision: 1,
      provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin',
    };
    await expect(service.validateReadContext(readContext)).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE' });
    expect((await service.get(repository)).binding.state).toBe('needs-attention');
    expect(record.binding.configRevision).toBe(oldRevision);
    expect(record.revision).toBe(1);

    const saved = await service.set({ directory: repository, expectedRepositoryId: context.repositoryId,
      expectedRevision: 1, expectedConfigRevision: context.configRevision, binding });
    expect(saved.binding.configRevision).toBe(context.configRevision);
    await expect(service.validateReadContext({ ...readContext, bindingRevision: saved.revision })).resolves.toMatchObject({
      repositoryId: context.repositoryId, bindingRevision: saved.revision,
    });
  });

  it('normalizes and sorts effective remote topology independently of config order', async () => {
    const repository = makeDirectory();
    git(repository, ['init', '-b', 'main']);
    git(repository, ['remote', 'add', 'upstream', 'git@EXAMPLE.NET:team/repository.git']);
    git(repository, ['remote', 'add', 'origin', 'https://EXAMPLE.COM/team/repository.git']);
    const first = await resolveRepositoryIdentity(repository);

    git(repository, ['remote', 'remove', 'upstream']);
    git(repository, ['remote', 'add', 'upstream', 'git@example.net:team/repository.git']);
    git(repository, ['remote', 'set-url', 'origin', 'https://example.com/team/repository.git']);
    git(repository, ['remote', 'set-url', '--push', 'origin', 'https://example.com/team/repository.git']);
    const second = await resolveRepositoryIdentity(repository);
    expect(second.remotes).toEqual(first.remotes);
    expect(second.configRevision).toBe(first.configRevision);

    git(repository, ['config', 'url.https://example.org/.insteadOf', 'https://example.com/']);
    const rewritten = await resolveRepositoryIdentity(repository);
    expect(rewritten.configRevision).not.toBe(second.configRevision);
    expect(rewritten.remotes[0].fetch.displayUrl).toBe('https://example.org/team/repository.git');
  });

  it('changes the revision for push-only changes and remote renames', async () => {
    const repository = makeDirectory();
    git(repository, ['init', '-b', 'main']);
    git(repository, ['remote', 'add', 'origin', 'https://example.com/team/repository.git']);
    const first = await resolveRepositoryIdentity(repository);
    git(repository, ['remote', 'set-url', '--push', 'origin', 'https://example.net/team/repository.git']);
    const second = await resolveRepositoryIdentity(repository);
    expect(second.remotes[0].fetch).toEqual(first.remotes[0].fetch);
    expect(second.configRevision).not.toBe(first.configRevision);
    git(repository, ['remote', 'rename', 'origin', 'upstream']);
    expect((await resolveRepositoryIdentity(repository)).configRevision).not.toBe(second.configRevision);
  });

  it('redacts URL credentials and changes config revision when remote topology changes', async () => {
    const repository = makeDirectory();
    git(repository, ['init', '-b', 'main']);
    git(repository, ['remote', 'add', 'origin', 'https://user:secret@example.com/owner/repository.git?access_token=query-secret#private']);

    const first = await resolveRepositoryIdentity(repository);
    const privateIdentity = await resolvePrivateRepositoryIdentity(repository);
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(JSON.stringify(first)).not.toContain('access_token');
    expect(JSON.stringify(first)).not.toContain('private');
    expect(privateIdentity.remotes[0].fetch.rawUrl).toBe('https://user:secret@example.com/owner/repository.git?access_token=query-secret#private');
    expect(first.remotes).toEqual([{
      name: 'origin',
      fetch: expect.objectContaining({ displayUrl: 'https://example.com/owner/repository.git' }),
      push: expect.objectContaining({ displayUrl: 'https://example.com/owner/repository.git' }),
    }]);

    git(repository, ['remote', 'set-url', 'origin', 'https://example.com/other/repository.git']);
    const second = await resolveRepositoryIdentity(repository);
    expect(second.repositoryId).toBe(first.repositoryId);
    expect(second.configRevision).not.toBe(first.configRevision);
  });

  it.each([
    ['credential helper', '[credential]\n\thelper = first-secret\n', '[credential]\n\thelper = second-secret\n'],
    ['SSH command', '[core]\n\tsshCommand = ssh -i /private/first-key\n', '[core]\n\tsshCommand = ssh -i /private/second-key\n'],
  ])('changes the private transport revision for an included %s change only', async (_label, first, second) => {
    const repository = makeDirectory();
    const includedConfig = path.join(makeDirectory(), 'transport.gitconfig');
    git(repository, ['init', '-b', 'main']);
    git(repository, ['remote', 'add', 'origin', 'https://example.com/owner/repository.git']);
    fs.writeFileSync(includedConfig, first);
    git(repository, ['config', '--local', 'include.path', includedConfig]);
    const commonConfigBefore = fs.readFileSync(path.join(repository, '.git', 'config'));

    const firstPublic = await resolveRepositoryIdentity(repository);
    const firstPrivate = await resolvePrivateRepositoryIdentity(repository);
    fs.writeFileSync(includedConfig, second);
    const secondPublic = await resolveRepositoryIdentity(repository);
    const secondPrivate = await resolvePrivateRepositoryIdentity(repository);

    expect(fs.readFileSync(path.join(repository, '.git', 'config'))).toEqual(commonConfigBefore);
    expect(secondPublic.configRevision).toBe(firstPublic.configRevision);
    expect(secondPublic.remotes).toEqual(firstPublic.remotes);
    expect(secondPublic).not.toHaveProperty('transportRevision');
    expect(secondPrivate.transportRevision).not.toBe(firstPrivate.transportRevision);
    expect(JSON.stringify(secondPublic)).not.toContain('second-secret');
    expect(JSON.stringify(secondPublic)).not.toContain(includedConfig);
  });

  it.each(['--local', '--global'])('keeps %s auth changes private without weakening transport validation', async (scope) => {
    const repository = makeDirectory();
    git(repository, ['init', '-b', 'main']);
    git(repository, ['remote', 'add', 'origin', 'https://example.com/team/repository.git']);
    const first = await resolvePrivateRepositoryIdentity(repository);
    git(repository, ['config', scope, 'credential.helper', 'fixture-helper']);
    git(repository, ['config', scope, 'core.sshCommand', 'ssh -i /fixture/key']);
    const second = await resolvePrivateRepositoryIdentity(repository);
    expect(second.configRevision).toBe(first.configRevision);
    expect(second.transportRevision).not.toBe(first.transportRevision);
    const publicContext = await resolveRepositoryIdentity(repository);
    expect(publicContext.configRevision).toBe(second.configRevision);
    expect(publicContext).not.toHaveProperty('transportRevision');
  });

  it('fails closed when private transport configuration cannot be read', async () => {
    const repository = makeDirectory();
    git(repository, ['init', '-b', 'main']);
    const resolve = createPrivateRepositoryIdentityResolver({
      getTransportRevision: async () => { throw new Error('Transport configuration unavailable'); },
    });
    await expect(resolve(repository)).rejects.toThrow('Transport configuration unavailable');
  });

  it('supports bare repositories and does not identify a replacement as the old repository', async () => {
    const repository = makeDirectory();
    git(repository, ['init', '--bare']);
    const bare = await resolveRepositoryIdentity(repository);
    expect(bare).toMatchObject({ supported: true, bare: true });

    fs.renameSync(repository, path.join(makeDirectory(), 'old-repository'));
    fs.mkdirSync(repository);
    git(repository, ['init', '--bare']);
    const replacement = await resolveRepositoryIdentity(repository);
    expect(replacement.repositoryId).not.toBe(bare.repositoryId);
    expect(replacement.configRevision).not.toBe(bare.configRevision);
  });

  it('redacts credentials in display URLs and error text', () => {
    expect(redactRemoteUrl('https://user:token@example.com/owner/repo.git')).toBe('https://example.com/owner/repo.git');
    expect(redactSensitiveText('failed https://user:token@example.com/repo authorization=Bearer-secret')).toBe(
      'failed https://example.com/repo authorization=[redacted]',
    );
    expect(redactSensitiveText('failed https://example.com/repo?access_token=query-secret#private')).toBe(
      'failed https://example.com/repo',
    );
  });
});
