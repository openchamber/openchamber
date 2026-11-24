import { isPlainObject, isString } from '../shared/guards.js';
import type { Application, Request } from '../shared/http-contracts.js';
import type { createBindingService } from '../source-control/binding-service.js';
import type { createNetworkOperations } from './network-operations.js';
import type { RemoteBranchFetcher } from './refresh-remote-ref.js';

type GitLibraries = typeof import('./index.js');

export interface GitRangeRouteDependencies {
  networkOperations?: ReturnType<typeof createNetworkOperations> | undefined;
  getSourceControlBinding?: ReturnType<typeof createBindingService>['get'] | undefined;
}

const resolveQueryString = (value: Request['query'][string]): string | null => {
  if (isString(value)) {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isString(item) && item.trim()) return item.trim();
    }
  }
  return null;
};

const formatErrorMessage = (fallback: string, error: Error | null): string =>
  error?.message || fallback;

const createBoundRemoteBranchFetcher = ({
  networkOperations,
  getSourceControlBinding,
}: GitRangeRouteDependencies): RemoteBranchFetcher | undefined => {
  if (!networkOperations || !(getSourceControlBinding instanceof Function)) {
    return undefined;
  }
  return async (directory, { remote, branch, fullRef }) => {
    const bindingRead = await getSourceControlBinding(directory);
    const remoteEntry = bindingRead.repository.remotes.find((entry) => entry.name === remote);
    if (!remoteEntry?.fetch) return false;
    const boundRemote = bindingRead.binding?.remotes.find((entry) => entry.name === remote);
    const transportMode = boundRemote?.mode ?? (bindingRead.binding ? null : 'system');
    if (!transportMode) return false;
    const planned = await networkOperations.plan({
      operation: 'fetch',
      directory,
      repositoryId: bindingRead.repository.repositoryId,
      bindingRevision: bindingRead.revision,
      configRevision: bindingRead.repository.configRevision,
      remote: {
        name: remote,
        endpoint: {
          displayUrl: remoteEntry.fetch.displayUrl,
          fingerprint: remoteEntry.fetch.fingerprint,
        },
      },
      transportMode,
      sourceRef: `refs/heads/${branch}`,
      destinationRef: fullRef,
    });
    const transfer = await networkOperations.execute(planned.operationId);
    return transfer.state === 'succeeded';
  };
};

export function registerGitRangeRoutes(
  app: Application,
  getGitLibraries: () => Promise<GitLibraries>,
  dependencies: GitRangeRouteDependencies = {},
): void {
  const fetchBranch = createBoundRemoteBranchFetcher(dependencies);

  app.get('/api/git/range-diff', async (req, res) => {
    const { getRangeDiff } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const base = req.query.base;
      const head = req.query.head;
      if (!base || !isString(base) || !head || !isString(head)) {
        return res.status(400).json({ error: 'base and head parameters are required' });
      }

      const pathParam = isString(req.query.path) && req.query.path ? req.query.path : undefined;
      const context = req.query.context ? parseInt(String(req.query.context), 10) : undefined;
      const previousPath = String(req.query.previousPath ?? '') || undefined;

      const diff = await getRangeDiff(directory, {
        base,
        head,
        includeWorkingTree: req.query.includeWorkingTree === 'true',
        path: pathParam,
        previousPath,
        contextLines: Number.isFinite(context) ? context : 3,
      });

      res.json({ diff });
    } catch (error) {
      console.error('Failed to get git range diff:', error);
      res.status(500).json({ error: formatErrorMessage('Failed to get git range diff', error instanceof Error ? error : null) });
    }
  });

  app.get('/api/git/range-file-versions', async (req, res) => {
    const { getRangeFileVersions } = await getGitLibraries();
    try {
      const directory = resolveQueryString(req.query.directory);
      const [base, head, filePath] = [req.query.base, req.query.head, req.query.path].map((value) => String(value ?? ''));
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      if (!base || !head || !filePath) {
        return res.status(400).json({ error: 'base, head and path parameters are required' });
      }
      const previousPath = String(req.query.previousPath ?? '') || undefined;
      res.json(await getRangeFileVersions(directory, { base, head, path: filePath, previousPath, includeWorkingTree: req.query.includeWorkingTree === 'true' }));
    } catch (error) {
      console.error('Failed to read file versions:', error);
      res.status(500).json({ error: formatErrorMessage('Failed to read file versions', error instanceof Error ? error : null) });
    }
  });

  app.get('/api/git/branch-base', async (req, res) => {
    const { getBranchBase } = await getGitLibraries();
    try {
      const directory = resolveQueryString(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const branch = resolveQueryString(req.query.branch);
      if (!branch) {
        return res.status(400).json({ error: 'branch parameter is required' });
      }

      const result = await getBranchBase(directory, branch);
      res.json(result);
    } catch (error) {
      console.error('Failed to get branch base:', error);
      res.status(500).json({ error: formatErrorMessage('Failed to get branch base', error instanceof Error ? error : null) });
    }
  });

  app.get('/api/git/range-files', async (req, res) => {
    const { getRangeFiles } = await getGitLibraries();
    try {
      const directory = resolveQueryString(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const base = resolveQueryString(req.query.base);
      const head = resolveQueryString(req.query.head);
      if (!base || !head) {
        return res.status(400).json({ error: 'base and head parameters are required' });
      }

      const files = await getRangeFiles(directory, { base, head, includeWorkingTree: req.query.includeWorkingTree === 'true' });
      res.json({ files });
    } catch (error) {
      console.error('Failed to get git range files:', error);
      res.status(500).json({ error: formatErrorMessage('Failed to get git range files', error instanceof Error ? error : null) });
    }
  });

  app.post('/api/git/refresh-remote-ref', async (req, res) => {
    const { refreshRemoteRef } = await getGitLibraries();
    try {
      const directory = resolveQueryString(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const body = isPlainObject(req.body) ? req.body : {};
      const ref = body.ref;
      if (!ref || !isString(ref)) {
        return res.status(400).json({ error: 'ref parameter is required' });
      }

      const result = await refreshRemoteRef(directory, ref, { force: body.force === true, fetchBranch });
      res.json(result);
    } catch (error) {
      console.error('Failed to refresh remote git ref:', error);
      res.status(500).json({ error: formatErrorMessage('Failed to refresh remote git ref', error instanceof Error ? error : null) });
    }
  });
}
