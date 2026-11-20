// external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/vite.node.config.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const entry = path.join(electronRoot, 'opencode-server', 'serve.mjs');
const outputDir = path.join(electronRoot, 'resources', 'opencode-server');
const assetsDir = path.join(outputDir, 'assets');
const cacheRoot = path.join(electronRoot, '.cache', 'opencode-server');

const packageDir = (name, fromDir) => {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) throw new Error(`Cannot find installed package ${name} from ${fromDir}`);
  }
};

const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

const serverDir = packageDir('@opencode/server', electronRoot);
const coreDir = packageDir('@opencode/core', serverDir);
const pinnedVersion = readManifest(electronRoot).devDependencies['@opencode/server'];
const serverVersion = readManifest(serverDir).version;
if (serverVersion !== pinnedVersion) {
  throw new Error(`Installed @opencode/server ${serverVersion} does not match the pinned ${pinnedVersion}; run bun install.`);
}

const optionalVersion = (parentDir, name) => {
  const version = readManifest(parentDir).optionalDependencies?.[name];
  if (!version) throw new Error(`${readManifest(parentDir).name} has no optional dependency ${name}`);
  return version;
};

// external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/node/target.ts
const nativeTargets = (platform, arch) => {
  const linux = platform === 'linux';
  const win = platform === 'win32';
  const nodePtyDir = packageDir('@lydell/node-pty', coreDir);
  const watcherDir = packageDir('@parcel/watcher', coreDir);
  const fffNodeDir = packageDir('@ff-labs/fff-node', coreDir);
  const ffiDir = packageDir('ffi-rs', fffNodeDir);
  const ptyDir = packageDir('@opencode/pty', coreDir);
  const pick = (parentDir, name) => ({ name, version: optionalVersion(parentDir, name) });
  return {
    nodePty: { ...pick(nodePtyDir, `@lydell/node-pty-${platform}-${arch}`), whole: true, entry: 'lib/index.js' },
    parcelWatcher: { ...pick(watcherDir, `@parcel/watcher-${platform}-${arch}${linux ? '-glibc' : ''}`), files: ['watcher.node'] },
    fff: {
      ...pick(fffNodeDir, `@ff-labs/fff-bin-${platform}-${arch}${linux ? '-gnu' : ''}`),
      files: [platform === 'darwin' ? 'libfff_c.dylib' : win ? 'fff_c.dll' : 'libfff_c.so'],
    },
    fffFfi: {
      ...pick(ffiDir, `@yuuang/ffi-rs-${platform}-${arch}${linux ? '-gnu' : win ? '-msvc' : ''}`),
      files: [`ffi-rs.${platform}-${arch}${linux ? '-gnu' : win ? '-msvc' : ''}.node`],
    },
    persistentPty: {
      ...pick(ptyDir, `@opencode/pty-${platform}-${arch}${linux ? '-gnu' : ''}`),
      files: [win ? 'bin/opencode-pty.exe' : 'bin/opencode-pty'],
      executable: true,
    },
  };
};

const tarballUrl = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;

const fetchPackage = async ({ name, version }) => {
  const dir = path.join(cacheRoot, `${name.replace('/', '+')}@${version}`);
  const packageRoot = path.join(dir, 'package');
  if (fs.existsSync(path.join(packageRoot, 'package.json'))) return packageRoot;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const url = tarballUrl(name, version);
  console.log(`[electron] downloading ${name}@${version}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  const archive = path.join(dir, 'package.tgz');
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const result = spawnSync('tar', ['-xzf', 'package.tgz'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Failed to extract ${archive}: ${result.stderr || result.error?.message}`);
  fs.rmSync(archive, { force: true });
  return packageRoot;
};

const copy = (from, to, executable = false) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: (source) => !source.endsWith('.pdb') });
  if (executable && process.platform !== 'win32') fs.chmodSync(to, 0o755);
};

// external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/vite.node.config.ts
const claudeAgentSdkPlugin = (sdkEntry) => ({
  name: 'claude-agent-sdk',
  setup(build) {
    build.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({ path: sdkEntry }));
  },
});

const nativeLoaderPlugin = {
  name: 'opencode-native-loaders',
  setup(build) {
    build.onResolve({ filter: /^jsonc-parser$/ }, (args) => {
      const umd = Bun.resolveSync(args.path, path.dirname(args.importer));
      const esm = umd.replace(/([/\\])umd([/\\])main\.js$/, '$1esm$2main.js');
      if (esm === umd || !fs.existsSync(esm)) throw new Error(`Unexpected jsonc-parser entry: ${umd}`);
      return { path: esm };
    });
    build.onLoad({ filter: /[/\\]ffi-rs[/\\]index\.js$/ }, async (args) => {
      const code = await Bun.file(args.path).text();
      const start = code.indexOf('if (!nativeBinding) {');
      if (start === -1) throw new Error('Failed to rewrite the ffi-rs native binding loader');
      return {
        loader: 'js',
        contents: `const unavailable = () => { throw new Error("ffi-rs native binding unavailable") }
const nativeBinding = globalThis.__OPENCODE_FFF_FFI ?? {
  DataType: new Proxy({}, { get: (target, key) => target[key] ?? key }),
  PointerType: {}, FFITypeTag: {},
  open: unavailable, close: unavailable, load: unavailable, isNullPointer: unavailable, createPointer: unavailable,
  restorePointer: unavailable, unwrapPointer: unavailable, wrapPointer: unavailable, freePointer: unavailable,
}
const loadError = undefined
${code.slice(start)}`,
      };
    });
    build.onLoad({ filter: /[/\\]fff-node[/\\]dist[/\\]src[/\\]binary\.js$/ }, async (args) => {
      const code = await Bun.file(args.path).text();
      const contents = code.replace('export function findBinary() {', 'export function findBinary() { if (process.env.FFF_BINARY_PATH) return process.env.FFF_BINARY_PATH;');
      if (contents === code) throw new Error('Failed to rewrite the FFF binary loader');
      return { loader: 'js', contents };
    });
    build.onLoad({ filter: /[/\\]photon-node[/\\]photon_rs\.js$/ }, async (args) => {
      const code = await Bun.file(args.path).text();
      const original = "const path = require('path').join(__dirname, 'photon_rs_bg.wasm');";
      if (!code.includes(original)) throw new Error('Failed to rewrite the photon wasm loader');
      return { loader: 'js', contents: code.replace(original, `const path = globalThis.__OPENCODE_PHOTON_WASM_PATH || require('path').join(__dirname, 'photon_rs_bg.wasm');`) };
    });
    build.onLoad({ filter: /[/\\]turndown[/\\]lib[/\\]turndown\.es\.js$/ }, async (args) => {
      const code = await Bun.file(args.path).text();
      const contents = code.replace("    var domino = require('@mixmark-io/domino');", '');
      if (contents === code) throw new Error("Failed to rewrite Turndown's Domino require");
      return { loader: 'js', contents: `import domino from "@mixmark-io/domino"\n${contents}` };
    });
  },
};

const main = async () => {
  const platform = process.env.OPENCHAMBER_OPENCODE_SERVER_PLATFORM || process.platform;
  const { node: arch } = resolveTargetArchitecture();

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  const claudeAgentSdk = { name: '@anthropic-ai/claude-agent-sdk', version: readManifest(coreDir).peerDependencies?.['@anthropic-ai/claude-agent-sdk'] };
  if (!claudeAgentSdk.version) throw new Error('@opencode/core no longer names its Claude Agent SDK version');
  const claudeAgentSdkDir = await fetchPackage(claudeAgentSdk);
  const claudeAgentSdkEntry = path.join(claudeAgentSdkDir, readManifest(claudeAgentSdkDir).exports['.'].default);

  const result = await Bun.build({
    entrypoints: [entry],
    outdir: outputDir,
    target: 'node',
    format: 'esm',
    splitting: true,
    minify: true,
    sourcemap: 'none',
    naming: { entry: '[name].mjs', chunk: 'chunks/[name]-[hash].mjs', asset: 'chunks/[name]-[hash].[ext]' },
    conditions: ['node'],
    define: {
      __OPENCODE_SERVER_VERSION__: JSON.stringify(serverVersion),
      'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
    },
    plugins: [claudeAgentSdkPlugin(claudeAgentSdkEntry), nativeLoaderPlugin],
  });
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error('Bundling the OpenCode server failed');
  }

  const manifest = {};
  for (const [key, target] of Object.entries(nativeTargets(platform, arch))) {
    const source = await fetchPackage(target);
    const destination = path.join(assetsDir, ...target.name.split('/'));
    if (target.whole) {
      copy(source, destination);
      manifest[key] = path.posix.join(target.name, target.entry);
    } else {
      for (const file of target.files) copy(path.join(source, file), path.join(destination, file), target.executable);
      manifest[key] = path.posix.join(target.name, target.files[0]);
    }
  }
  const spawnHelper = path.join(assetsDir, '@lydell', `node-pty-${platform}-${arch}`, 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
  if (fs.existsSync(spawnHelper)) fs.chmodSync(spawnHelper, 0o755);

  const photonDir = packageDir('@silvia-odwyer/photon-node', coreDir);
  copy(path.join(photonDir, 'photon_rs_bg.wasm'), path.join(assetsDir, 'photon_rs_bg.wasm'));
  manifest.photonWasm = 'photon_rs_bg.wasm';

  fs.writeFileSync(path.join(assetsDir, 'manifest.json'), `${JSON.stringify({ version: serverVersion, platform, arch, ...manifest }, null, 2)}\n`);
  console.log(`[electron] prepared OpenCode server ${serverVersion} for ${platform}-${arch}: ${path.relative(electronRoot, outputDir)}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
