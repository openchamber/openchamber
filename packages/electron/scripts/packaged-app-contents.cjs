// Checks what electron-builder put into app.asar against what the packaged
// runtime needs. The `files` exclusions in package.json keep unused files out;
// this check stops a pattern change from shipping the web build twice, or from
// cutting something the server loads at startup.
const fs = require('node:fs');
const path = require('node:path');

const WEB_PACKAGE = 'node_modules/@openchamber/web';

// Packaged builds serve the UI from Resources/web-dist (OPENCHAMBER_DIST_DIR),
// so the web package's own build output is dead weight inside the archive.
const FORBIDDEN_DIRECTORIES = [`${WEB_PACKAGE}/dist`];

// The app's own files, outside node_modules. Anything else there means the
// `files` patterns fell back to copying the whole package directory.
const APP_FILES = [
  'dist-bundle/entry.mjs',
  'dist-bundle/main.mjs',
  'dist-bundle/early-startup.mjs',
  'preload.mjs',
  // The browser panel session's preload, loaded from the app path.
  'browser-panel-preload.cjs',
  'package.json',
];

const REQUIRED_FILES = [
  ...APP_FILES,
  // server/index.js reads the version from the package manifest.
  `${WEB_PACKAGE}/package.json`,
  `${WEB_PACKAGE}/server/index.js`,
];

// ripgrep ships in Resources/ripgrep for the target architecture
// (prepare-ripgrep.mjs). The npm platform packages hold the build host's
// binary, so they stay out of the archive.
const RIPGREP_PLATFORM_PACKAGE = /(?:^|\/)node_modules\/@vscode\/ripgrep-[^/]+\//;
const RIPGREP_BINARY = process.platform === 'win32' ? 'rg.exe' : 'rg';

// Run by git and ssh as separate processes, so they must exist on disk.
const REQUIRED_UNPACKED_FILES = [
  `${WEB_PACKAGE}/server/lib/git/credential-helper.js`,
  `${WEB_PACKAGE}/server/lib/git/ssh-wrapper.js`,
  `${WEB_PACKAGE}/server/lib/git/repository-credential-helper.js`,
];

const requiredUnpackedFiles = ({ platform = process.platform, arch = process.arch } = {}) => (
  platform === 'win32'
    ? [...REQUIRED_UNPACKED_FILES, `node_modules/7zip-bin/win/${arch}/7za.exe`]
    : REQUIRED_UNPACKED_FILES
);

/**
 * Lists the files recorded in an asar header.
 * Layout: a pickle holding the header size, then a pickle holding the header
 * JSON string (payload size at offset 8, string length at 12, string at 16).
 */
const readAsarFiles = (asarPath) => {
  const descriptor = fs.openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(descriptor, prefix, 0, prefix.length, 0);
    const headerLength = prefix.readUInt32LE(12);
    const header = Buffer.alloc(headerLength);
    fs.readSync(descriptor, header, 0, headerLength, 16);
    const files = [];
    const visit = (node, prefixPath) => {
      for (const [name, entry] of Object.entries(node.files)) {
        const entryPath = prefixPath ? `${prefixPath}/${name}` : name;
        if (entry.files) {
          visit(entry, entryPath);
        } else {
          files.push({ path: entryPath, unpacked: entry.unpacked === true });
        }
      }
    };
    visit(JSON.parse(header.toString('utf8')), '');
    return files;
  } finally {
    fs.closeSync(descriptor);
  }
};

const findPackagedAppContentProblems = (files, target) => {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const problems = [];
  const strayAppFiles = files.filter((file) => !file.path.startsWith('node_modules/') && !APP_FILES.includes(file.path));
  if (strayAppFiles.length > 0) {
    const examples = strayAppFiles.slice(0, 5).map((file) => file.path).join(', ');
    problems.push(`${strayAppFiles.length} unexpected files outside node_modules (${examples})`);
  }
  for (const directory of FORBIDDEN_DIRECTORIES) {
    const count = files.filter((file) => file.path.startsWith(`${directory}/`)).length;
    if (count > 0) problems.push(`${directory} must not be packaged (${count} files found)`);
  }
  const platformPackageFiles = files.filter((file) => RIPGREP_PLATFORM_PACKAGE.test(file.path)).length;
  if (platformPackageFiles > 0) {
    problems.push(`@vscode/ripgrep platform packages must not be packaged (${platformPackageFiles} files found); the binary ships in Resources/ripgrep`);
  }
  for (const required of REQUIRED_FILES) {
    if (!byPath.has(required)) problems.push(`${required} is missing`);
  }
  for (const required of requiredUnpackedFiles(target)) {
    const file = byPath.get(required);
    if (!file) problems.push(`${required} is missing`);
    else if (!file.unpacked) problems.push(`${required} must be unpacked from the asar`);
  }
  return problems;
};

const verifyPackagedAppContents = (resourcesPath, target) => {
  const asarPath = path.join(resourcesPath, 'app.asar');
  const problems = findPackagedAppContentProblems(readAsarFiles(asarPath), target);
  for (const required of requiredUnpackedFiles(target)) {
    if (!fs.existsSync(path.join(`${asarPath}.unpacked`, required))) {
      problems.push(`${required} is missing from app.asar.unpacked`);
    }
  }
  const ripgrep = path.join(resourcesPath, 'ripgrep', RIPGREP_BINARY);
  if (!fs.existsSync(ripgrep)) {
    problems.push(`${ripgrep} is missing; run prepare:ripgrep before packaging`);
  }
  if (problems.length > 0) {
    throw new Error(`Packaged app contents check failed for ${asarPath}:\n- ${problems.join('\n- ')}`);
  }
};

module.exports = { readAsarFiles, findPackagedAppContentProblems, verifyPackagedAppContents };
