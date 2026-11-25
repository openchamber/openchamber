// external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/vite.node.config.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const webRoot = path.resolve(__dirname, '..');
export const opencodeServerEntry = path.join(webRoot, 'opencode-server', 'serve.mjs');
const defaultOutputDir = path.join(webRoot, 'build', 'opencode-server');
const defaultCacheRoot = path.join(webRoot, '.cache', 'opencode-server');

const WEB_NATIVE_DEPENDENCIES = [
  '@lydell/node-pty',
  '@parcel/watcher',
  '@ff-labs/fff-node',
  '@opencode/pty',
];

export const packageDir = (name, fromDir) => {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) throw new Error(`Cannot find installed package ${name} from ${fromDir}`);
  }
};

export const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

export const tarballUrl = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;

export const fetchPackage = async ({ name, version }, cacheRoot, fallbackCacheRoots = []) => {
  const folder = `${name.replace('/', '+')}@${version}`;
  for (const candidateRoot of [cacheRoot, ...fallbackCacheRoots]) {
    const cachedPackage = path.join(candidateRoot, folder, 'package');
    if (fs.existsSync(path.join(cachedPackage, 'package.json'))) return cachedPackage;
  }
  const dir = path.join(cacheRoot, folder);
  const packageRoot = path.join(dir, 'package');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const url = tarballUrl(name, version);
  console.log(`[opencode-server] downloading ${name}@${version}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  const archive = path.join(dir, 'package.tgz');
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const result = spawnSync('tar', ['-xzf', 'package.tgz'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Failed to extract ${archive}: ${result.stderr || result.error?.message}`);
  fs.rmSync(archive, { force: true });
  return packageRoot;
};

export const copy = (from, to, executable = false) => {
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

const headWatchPlugin = (rewritten) => ({
  name: 'opencode-head-watch',
  setup(build) {
    build.onLoad({ filter: /[/\\]@opencode[/\\]core[/\\]dist[/\\]chunks[/\\][^/\\]+\.js$/ }, async (args) => {
      const code = await Bun.file(args.path).text();
      const names = 'const names = new Set(input.type === "file" ? [path.basename(input.target)] : input.names);';
      const check = 'if (file && !names.has(file))';
      if (!code.includes(names) || !code.includes(check)) return { loader: 'js', contents: code };
      rewritten.add(args.path);
      return {
        loader: 'js',
        contents: code
          .replace(names, `${names} const headUnchanged = globalThis.__openchamberHeadGuard?.(input);`)
          .replace(check, 'if (file && (!names.has(file) || headUnchanged?.()))'),
      };
    });
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
      return { loader: 'js', contents: code.replace(original, 'const path = globalThis.__OPENCODE_PHOTON_WASM_PATH || require(\'path\').join(__dirname, \'photon_rs_bg.wasm\');') };
    });
    build.onLoad({ filter: /[/\\]turndown[/\\]lib[/\\]turndown\.es\.js$/ }, async (args) => {
      const code = await Bun.file(args.path).text();
      const contents = code.replace("    var domino = require('@mixmark-io/domino');", '');
      if (contents === code) throw new Error("Failed to rewrite Turndown's Domino require");
      return { loader: 'js', contents: `import domino from "@mixmark-io/domino"\n${contents}` };
    });
  },
};

export const bundleOpenCodeServer = async ({
  packageRoot = webRoot,
  outputDir = defaultOutputDir,
  cacheRoot = defaultCacheRoot,
  fallbackCacheRoots = [],
  entry = opencodeServerEntry,
} = {}) => {
  const serverDir = packageDir('@opencode/server', packageRoot);
  const coreDir = packageDir('@opencode/core', serverDir);
  const pinnedVersion = readManifest(packageRoot).devDependencies?.['@opencode/server'];
  const serverVersion = readManifest(serverDir).version;
  if (pinnedVersion && serverVersion !== pinnedVersion) {
    throw new Error(`Installed @opencode/server ${serverVersion} does not match the pinned ${pinnedVersion}; run bun install.`);
  }

  const assetsDir = path.join(outputDir, 'assets');
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  const claudeAgentSdk = { name: '@anthropic-ai/claude-agent-sdk', version: readManifest(coreDir).peerDependencies?.['@anthropic-ai/claude-agent-sdk'] };
  if (!claudeAgentSdk.version) throw new Error('@opencode/core no longer names its Claude Agent SDK version');
  const claudeAgentSdkDir = await fetchPackage(claudeAgentSdk, cacheRoot, fallbackCacheRoots);
  const claudeAgentSdkEntry = path.join(claudeAgentSdkDir, readManifest(claudeAgentSdkDir).exports['.'].default);

  const headWatches = new Set();
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
    plugins: [claudeAgentSdkPlugin(claudeAgentSdkEntry), headWatchPlugin(headWatches), nativeLoaderPlugin],
  });
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error('Bundling the OpenCode server failed');
  }
  if (headWatches.size === 0) throw new Error('Failed to rewrite the HEAD watch');

  const photonDir = packageDir('@silvia-odwyer/photon-node', coreDir);
  copy(path.join(photonDir, 'photon_rs_bg.wasm'), path.join(assetsDir, 'photon_rs_bg.wasm'));

  return { serverDir, coreDir, serverVersion, outputDir, assetsDir, photonWasm: 'photon_rs_bg.wasm' };
};

const assertWebNativeDependenciesMatch = (coreDir) => {
  const webManifest = readManifest(webRoot);
  const coreManifest = readManifest(coreDir);
  for (const name of WEB_NATIVE_DEPENDENCIES) {
    const expected = coreManifest.dependencies?.[name];
    const actual = webManifest.dependencies?.[name];
    if (!expected) throw new Error(`@opencode/core no longer lists ${name} in dependencies`);
    if (actual !== expected) {
      throw new Error(`packages/web/package.json must pin ${name} to ${expected} (matches @opencode/core), got ${actual ?? '(missing)'}`);
    }
  }
};

const prepareWebOpenCodeServer = async () => {
  if (process.env.OPENCHAMBER_SKIP_BUNDLED_OPENCODE_SERVER === '1') {
    console.log('[web] skipping bundled OpenCode server (OPENCHAMBER_SKIP_BUNDLED_OPENCODE_SERVER=1)');
    return;
  }
  const electronCacheRoot = path.resolve(webRoot, '..', 'electron', '.cache', 'opencode-server');
  const { coreDir, serverVersion, assetsDir, photonWasm } = await bundleOpenCodeServer({
    packageRoot: webRoot,
    outputDir: defaultOutputDir,
    cacheRoot: defaultCacheRoot,
    fallbackCacheRoots: [electronCacheRoot],
  });
  assertWebNativeDependenciesMatch(coreDir);
  fs.writeFileSync(
    path.join(assetsDir, 'manifest.json'),
    `${JSON.stringify({ version: serverVersion, mode: 'node_modules', photonWasm }, null, 2)}\n`,
  );
  console.log(`[web] prepared OpenCode server ${serverVersion}: ${path.relative(webRoot, defaultOutputDir)}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareWebOpenCodeServer().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
