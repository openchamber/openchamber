import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspacePluginPackageName = '@openchamber/opencode-container-workspace';

const rootFiles = ['LICENSE', 'README.md', 'package.json'];
const includedDirectories = ['egress-image', 'runtime-image', 'src'];

const hashFile = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const collectFiles = (root, relativeDirectory, files, { releaseFilter = false } = {}) => {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Workspace plugin is missing required directory: ${relativeDirectory}`);
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Workspace plugin payload cannot contain symlinks: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      if (!releaseFilter || entry.name !== 'node_modules') {
        collectFiles(root, relativePath, files, { releaseFilter });
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (releaseFilter && (relativeDirectory === 'src' || relativeDirectory.startsWith('src/'))) {
      if (entry.name.endsWith('.test.js')) continue;
    }
    files.push(relativePath);
  }
};

const releaseFiles = (root) => {
  const files = [];
  for (const file of rootFiles) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Workspace plugin is missing required file: ${file}`);
    }
    files.push(file);
  }
  for (const directory of includedDirectories) collectFiles(root, directory, files, { releaseFilter: true });
  return files.sort();
};

const payloadFiles = (root) => {
  const files = [];
  collectFiles(root, '.', files);
  return files.map((file) => file.startsWith('./') ? file.slice(2) : file).sort();
};

const exportedTargets = (value) => {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportedTargets);
};

const validateInstalledPackage = (root, files) => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (packageJson.name !== workspacePluginPackageName) {
    throw new Error(`Workspace plugin package name mismatch: expected ${workspacePluginPackageName}, got ${packageJson.name || '(missing)'}`);
  }
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Workspace plugin package version is missing');
  }

  const targets = [packageJson.main, ...exportedTargets(packageJson.exports)].filter(Boolean);
  if (targets.length === 0) throw new Error('Workspace plugin does not declare an entrypoint');
  for (const target of targets) {
    const relativeTarget = typeof target === 'string' && target.startsWith('./') ? target.slice(2) : '';
    if (!relativeTarget || !files.includes(relativeTarget)) {
      throw new Error(`Workspace plugin entrypoint is missing from the release payload: ${target}`);
    }
  }
  if (!files.some((file) => file.startsWith('runtime-image/'))) {
    throw new Error('Workspace plugin runtime-image payload is empty');
  }
  if (!files.some((file) => file.startsWith('egress-image/'))) {
    throw new Error('Workspace plugin egress-image payload is empty');
  }
};

export const resolveInstalledWorkspacePlugin = () => {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.resolve(workspacePluginPackageName))), '..');
  } catch (error) {
    throw new Error(`Failed to resolve ${workspacePluginPackageName}. Run bun install before packaging.`, { cause: error });
  }
};

export const verifyWorkspacePluginPayload = ({ installedRoot, payloadRoot, label }) => {
  const expectedFiles = releaseFiles(installedRoot);
  validateInstalledPackage(installedRoot, expectedFiles);

  if (!fs.existsSync(payloadRoot) || !fs.statSync(payloadRoot).isDirectory()) {
    throw new Error(`${label} workspace plugin payload not found: ${payloadRoot}`);
  }
  const actualFiles = payloadFiles(payloadRoot);
  const missing = expectedFiles.filter((file) => !actualFiles.includes(file));
  const extra = actualFiles.filter((file) => !expectedFiles.includes(file));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${label} workspace plugin file set mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
  for (const file of expectedFiles) {
    if (hashFile(path.join(installedRoot, file)) !== hashFile(path.join(payloadRoot, file))) {
      throw new Error(`${label} workspace plugin content mismatch: ${file}`);
    }
  }

  return { fileCount: expectedFiles.length };
};

export const findPackagedWorkspacePlugins = (distRoot) => {
  if (!fs.existsSync(distRoot)) return [];
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.name === 'opencode-container-workspace' && ['resources', 'Resources'].includes(path.basename(directory))) {
        matches.push(entryPath);
      } else {
        visit(entryPath);
      }
    }
  };
  visit(distRoot);
  return matches.sort();
};

export const verifyStagedWorkspacePlugin = ({ electronRoot, installedRoot = resolveInstalledWorkspacePlugin() }) => {
  const payloadRoot = path.join(electronRoot, 'resources', 'opencode-container-workspace');
  return verifyWorkspacePluginPayload({ installedRoot, payloadRoot, label: 'Staged' });
};

export const verifyPackagedWorkspacePlugins = ({ electronRoot, installedRoot = resolveInstalledWorkspacePlugin() }) => {
  const payloads = findPackagedWorkspacePlugins(path.join(electronRoot, 'dist'));
  if (payloads.length === 0) {
    throw new Error('No packaged workspace plugin found under packages/electron/dist');
  }
  for (const payloadRoot of payloads) {
    verifyWorkspacePluginPayload({ installedRoot, payloadRoot, label: 'Packaged' });
  }
  return { payloadCount: payloads.length };
};
