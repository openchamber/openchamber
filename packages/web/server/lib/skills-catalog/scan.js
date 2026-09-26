import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';

import {
  assertGitAvailable,
  copyGitProcessMetadata,
  isProcessTreeCleanupBlocked,
  looksLikeAuthError,
  runGit,
  runWithGitCloneReservation,
} from './git.js';
import { parseSkillRepoSource } from './source.js';
import { runWithGitExecutionScope } from '../git/execution-scope.js';
import {
  chainGitProcessCleanupReconciliation,
  getGitProcessCleanupReconciliation,
} from '../git/execution-errors.js';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';

const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  throw signal.reason || new Error('Skills repository scan was cancelled');
};

function validateSkillName(skillName) {
  if (!isStringValue(skillName)) return false;
  if (skillName.length < 1 || skillName.length > 64) return false;
  return SKILL_NAME_PATTERN.test(skillName);
}

function parseSkillMd(content) {
  const text = isStringValue(content) ? content : '';
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return {
      ok: true,
      frontmatter: {},
      warnings: ['Invalid SKILL.md: missing YAML frontmatter delimiter'],
    };
  }

  try {
    const frontmatter = yaml.parse(match[1]) || {};
    return { ok: true, frontmatter, warnings: [] };
  } catch {
    return {
      ok: true,
      frontmatter: {},
      warnings: ['Invalid SKILL.md: failed to parse YAML frontmatter'],
    };
  }
}

async function safeRm(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function cloneRepo({ cloneUrl, identity, tempDir, runGitCommand, signal }) {
  const preferred = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', cloneUrl, tempDir];
  const fallback = ['clone', '--depth', '1', '--no-checkout', cloneUrl, tempDir];

  const result = await runGitCommand(preferred, { identity, timeoutMs: 60_000, signal });
  if (result.ok) return { ok: true };

  if (isProcessTreeCleanupBlocked(result)) {
    return { ok: false, error: result, cleanupBlocked: true };
  }

  await safeRm(tempDir);
  if (signal?.aborted) {
    return { ok: false, error: result };
  }
  const fallbackResult = await runGitCommand(fallback, { identity, timeoutMs: 60_000, signal });
  if (fallbackResult.ok) return { ok: true };

  return {
    ok: false,
    error: fallbackResult,
    cleanupBlocked: isProcessTreeCleanupBlocked(fallbackResult),
  };
}

function cleanupBlockedResult(result) {
  const metadata = copyGitProcessMetadata({}, result);
  return {
    ok: false,
    error: copyGitProcessMetadata({
      kind: 'networkError',
      message: 'Git process cleanup was not confirmed; temporary clone retained',
    }, result),
    cleanupBlocked: true,
    ...metadata,
  };
}

export async function scanSkillsRepository({
  source,
  subpath,
  defaultSubpath,
  identity,
  gitExecutionService,
  resolveGitBinaryForSpawn,
  runGit: runGitCommand = runGit,
  signal = undefined,
} = {}) {
  const runConfiguredGit = (args, options = {}) => {
    const command = args.find((arg) => ['clone', 'checkout', 'ls-files', 'ls-tree', 'show'].includes(arg));
    const readOnly = command === 'ls-files' || command === 'ls-tree' || command === 'show';
    const runOptions = signal && !options.signal ? { ...options, signal } : options;
    return runWithGitExecutionScope(readOnly, () => runGitCommand(
      args,
      resolveGitBinaryForSpawn
        ? { ...runOptions, resolveGitBinaryForSpawn }
        : runOptions,
    ));
  };
  const parsed = parseSkillRepoSource(source, { subpath });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const effectiveSubpath = parsed.effectiveSubpath || (isStringValue(defaultSubpath) && defaultSubpath.trim() ? defaultSubpath.trim() : null);
  const cloneUrl = identity?.sshKey ? parsed.cloneUrlSsh : parsed.cloneUrlHttps;

  throwIfAborted(signal);
  const tempBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-skills-scan-'));
  let cleaned = false;
  let cleanupBlocked = false;
  const cleanup = async () => {
    if (cleanupBlocked) return;
    if (cleaned) return;
    cleaned = true;
    await safeRm(tempBase);
  };
  const retainCleanupUntilProcessClose = (result) => {
    cleanupBlocked = true;
    const reconciliation = getGitProcessCleanupReconciliation(result);
    if (reconciliation) {
      const cleanupReconciliation = chainGitProcessCleanupReconciliation(reconciliation, async () => {
        cleanupBlocked = false;
        await cleanup();
      });
      const retained = copyGitProcessMetadata({}, result);
      retained.cleanupReconciliation = cleanupReconciliation;
      return cleanupBlockedResult(retained);
    }
    return cleanupBlockedResult(result);
  };

  const scanRepository = async () => {
    try {
      throwIfAborted(signal);
      const gitCheck = await assertGitAvailable(runConfiguredGit, { signal });
      if (!gitCheck.ok) {
        if (isProcessTreeCleanupBlocked(gitCheck)) {
          return retainCleanupUntilProcessClose(gitCheck);
        }
        return { ok: false, error: gitCheck.error };
      }

      const cloned = await cloneRepo({
        cloneUrl,
        identity,
        tempDir: tempBase,
        runGitCommand: runConfiguredGit,
        signal,
      });
      if (!cloned.ok) {
        if (cloned.cleanupBlocked) {
          return retainCleanupUntilProcessClose(cloned.error);
        }
        const msg = `${cloned.error?.stderr || ''}\n${cloned.error?.message || ''}`.trim();
        if (looksLikeAuthError(msg)) {
          return { ok: false, error: { kind: 'authRequired', message: 'Authentication required to access this repository', sshOnly: true } };
        }
        return { ok: false, error: { kind: 'networkError', message: msg || 'Failed to clone repository' } };
      }

      const toFsPath = (posixPath) => path.join(tempBase, ...String(posixPath || '').split('/').filter(Boolean));

      const patterns = effectiveSubpath
        ? [`${effectiveSubpath}/SKILL.md`, `${effectiveSubpath}/**/SKILL.md`]
        : ['SKILL.md', '**/SKILL.md'];

      let skillMdPaths = null;

      // Fast path: sparse checkout only SKILL.md files, then parse from disk.
      // This avoids one `git show` per skill.
      const sparseInit = await runConfiguredGit(['-C', tempBase, 'sparse-checkout', 'init', '--no-cone'], { identity, timeoutMs: 15_000 });
      if (isProcessTreeCleanupBlocked(sparseInit)) {
        return retainCleanupUntilProcessClose(sparseInit);
      }
      if (sparseInit.ok) {
        const sparseSet = await runConfiguredGit(['-C', tempBase, 'sparse-checkout', 'set', ...patterns], { identity, timeoutMs: 30_000 });
        if (isProcessTreeCleanupBlocked(sparseSet)) {
          return retainCleanupUntilProcessClose(sparseSet);
        }
        if (sparseSet.ok) {
          const checkout = await runConfiguredGit(['-C', tempBase, 'checkout', '--force', 'HEAD'], { identity, timeoutMs: 60_000 });
          if (isProcessTreeCleanupBlocked(checkout)) {
            return retainCleanupUntilProcessClose(checkout);
          }
          if (checkout.ok) {
            const lsFiles = await runConfiguredGit(['-C', tempBase, 'ls-files'], { identity, timeoutMs: 15_000 });
            if (isProcessTreeCleanupBlocked(lsFiles)) {
              return retainCleanupUntilProcessClose(lsFiles);
            }
            if (lsFiles.ok) {
              skillMdPaths = lsFiles.stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .filter((p) => p.endsWith('/SKILL.md') || p === 'SKILL.md');
            }
          }
        }
      }

      // Fallback: list tree and read SKILL.md blobs via git.
      if (!Array.isArray(skillMdPaths)) {
        const listArgs = ['-C', tempBase, 'ls-tree', '-r', '--name-only', 'HEAD'];
        if (effectiveSubpath) {
          listArgs.push('--', effectiveSubpath);
        }

        const listResult = await runConfiguredGit(listArgs, { identity, timeoutMs: 30_000 });
        if (!listResult.ok) {
          if (isProcessTreeCleanupBlocked(listResult)) {
            return retainCleanupUntilProcessClose(listResult);
          }
          const message = `${listResult.stderr || ''}\n${listResult.message || ''}`.trim();
          const authError = looksLikeAuthError(message);
          const error = {
            kind: authError ? 'authRequired' : 'networkError',
            message: message || 'Failed to inspect cloned repository',
          };
          if (authError) error.sshOnly = true;
          return {
            ok: false,
            error,
          };
        }

        skillMdPaths = listResult.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((p) => p.endsWith('/SKILL.md') || p === 'SKILL.md');
      }

      // Root-level SKILL.md doesn't map cleanly to OpenCode's "skill name == folder name" convention.
      const uniqueSkillDirs = Array.from(
        new Set(
          skillMdPaths
            .filter((p) => p !== 'SKILL.md')
            .map((p) => path.posix.dirname(p))
        )
      );

      const items = [];
      const maxParallel = 10;
      let idx = 0;

      const worker = async () => {
        while (idx < uniqueSkillDirs.length) {
          const skillDir = uniqueSkillDirs[idx++];
          const skillName = path.posix.basename(skillDir);
          const skillMdPath = path.posix.join(skillDir, 'SKILL.md');

          throwIfAborted(signal);

          const warnings = [];
          let skillMdContent = '';

          // Prefer filesystem reads when sparse checkout succeeded.
          const filePath = toFsPath(skillMdPath);
          try {
            throwIfAborted(signal);
            skillMdContent = await fs.promises.readFile(filePath, 'utf8');
          } catch (error) {
            if (signal?.aborted) throw error;
            const showResult = await runConfiguredGit(['-C', tempBase, 'show', `HEAD:${skillMdPath}`], { identity, timeoutMs: 15_000 });
            if (!showResult.ok) {
              if (isProcessTreeCleanupBlocked(showResult)) {
                return retainCleanupUntilProcessClose(showResult);
              }
              warnings.push('Failed to read SKILL.md');
            } else {
              skillMdContent = showResult.stdout;
            }
          }

          const parsedMd = parseSkillMd(skillMdContent);
          warnings.push(...(parsedMd.warnings || []));

          const description = isStringValue(parsedMd.frontmatter?.description) ? parsedMd.frontmatter.description : undefined;
          const frontmatterName = isStringValue(parsedMd.frontmatter?.name) ? parsedMd.frontmatter.name : undefined;

          const installable = validateSkillName(skillName);
          if (!installable) {
            warnings.push('Skill directory name is not a valid OpenCode skill name');
          }

          items.push({
            repoSource: source,
            repoSubpath: effectiveSubpath || undefined,
            skillDir,
            skillName,
            frontmatterName,
            description,
            installable,
            warnings: warnings.length ? warnings : undefined,
          });
        }
      };

      const workerResults = await Promise.allSettled(
        Array.from({ length: Math.min(maxParallel, uniqueSkillDirs.length || 1) }, () => worker()),
      );
      const failedWorker = workerResults.find((result) => result.status === 'rejected');
      if (failedWorker) {
        throw failedWorker.reason;
      }
      const blockedResult = workerResults
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value)
        .find((result) => result?.cleanupBlocked);
      if (blockedResult) return blockedResult;

      // Stable ordering for UX
      items.sort((a, b) => a.skillName.localeCompare(b.skillName));

      return {
        ok: true,
        normalizedRepo: parsed.normalizedRepo,
        effectiveSubpath,
        items,
      };
    } catch (error) {
      // A custom runner may surface the shared termination error directly
      // instead of returning runGit's structured result. Preserve the clone
      // until that owned process lifecycle is known to be closed.
      if (isProcessTreeCleanupBlocked(error)) retainCleanupUntilProcessClose(error);
      throw error;
    } finally {
      await cleanup();
    }
  };

  try {
    return await runWithGitCloneReservation({
      destination: tempBase,
      label: 'skills-catalog/clone-repository',
      queueTimeoutMs: 60_000,
      signal,
      gitExecutionService,
    }, scanRepository);
  } finally {
    await cleanup();
  }
}
