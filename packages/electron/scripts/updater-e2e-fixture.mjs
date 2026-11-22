#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ARCHITECTURES = new Map([
  ['x64', 'latest-linux.yml'],
  ['arm64', 'latest-linux-arm64.yml'],
]);

const usage = `Usage:
  updater-e2e-fixture.mjs stage --arch <x64|arm64> --next <N+1.AppImage> --version <N+1> --dir <feed-dir>
  updater-e2e-fixture.mjs serve --dir <feed-dir> [--port <port>]
  updater-e2e-fixture.mjs run --arch <x64|arm64> --current <N.AppImage> --next <N+1.AppImage> --version <N+1> --dir <feed-dir> [--port <port>]

Both AppImages must be packaged with OPENCHAMBER_UPDATER_E2E_BUILD=1 during bundle:main.
The run command stages N+1, serves it on 127.0.0.1, and launches N with only the two
runtime E2E gates. Use the Desktop update UI to check, download, apply, and restart.
Keep this process running until the restarted N+1 is verified, then press Ctrl-C.`;

// The options each command actually reads. Anything else is rejected:
// a lenient parser silently swallows a flag meant for another command
// (`stage --port 45678` exited 0 with the flag having zero effect) and
// typos (`--verison`) the same way (#2057).
const COMMAND_OPTIONS = new Map([
  ['stage', new Set(['arch', 'next', 'version', 'dir'])],
  ['serve', new Set(['dir', 'port'])],
  ['run', new Set(['arch', 'current', 'next', 'version', 'dir', 'port'])],
]);

export const parseArguments = (argv) => {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(usage);
    options[key.slice(2)] = value;
  }
  const allowed = COMMAND_OPTIONS.get(command);
  if (allowed) {
    for (const name of Object.keys(options)) {
      if (!allowed.has(name)) throw new Error(`Unknown option --${name} for ${command}\n\n${usage}`);
    }
  }
  return { command, options };
};

const requireOption = (options, name) => {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}\n\n${usage}`);
  return value;
};

const resolveArchitecture = (value) => {
  if (!ARCHITECTURES.has(value)) throw new Error(`Unsupported architecture: ${value || '(missing)'}`);
  return value;
};

const resolveExistingFile = (value, name) => {
  const filePath = path.resolve(value);
  if (!fs.statSync(filePath).isFile()) throw new Error(`--${name} must be a file: ${filePath}`);
  return filePath;
};

const sha512 = (filePath) => crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');

export const stageUpdaterFixture = ({ architecture, nextAppImage, version, directory }) => {
  const manifestName = ARCHITECTURES.get(resolveArchitecture(architecture));
  const sourcePath = resolveExistingFile(nextAppImage, 'next');
  const feedDirectory = path.resolve(directory);
  fs.mkdirSync(feedDirectory, { recursive: true });
  const artifactName = path.basename(sourcePath);
  const artifactPath = path.join(feedDirectory, artifactName);
  if (sourcePath !== artifactPath) fs.copyFileSync(sourcePath, artifactPath);
  const size = fs.statSync(artifactPath).size;
  const checksum = sha512(artifactPath);
  const manifest = [
    `version: ${version}`,
    'files:',
    `  - url: ${encodeURIComponent(artifactName)}`,
    `    sha512: ${checksum}`,
    `    size: ${size}`,
    `path: ${encodeURIComponent(artifactName)}`,
    `sha512: ${checksum}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(feedDirectory, manifestName), manifest, { mode: 0o644 });
  return { artifactPath, manifestName, size };
};

export const createFixtureServer = ({ directory, port = 0 }) => {
  const feedDirectory = path.resolve(directory);
  const files = new Map(fs.readdirSync(feedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => [`/${encodeURIComponent(entry.name)}`, path.join(feedDirectory, entry.name)]));
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const filePath = files.get(requestUrl.pathname);
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !filePath) {
      response.writeHead(404).end();
      return;
    }
    // The feed directory is snapshotted at startup, so a registered file
    // can disappear or become unreadable before a request arrives (#2078):
    // answer with an HTTP error instead of crashing the fixture process.
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      response.writeHead(error?.code === 'ENOENT' ? 404 : 500).end();
      return;
    }
    if (!stat.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': filePath.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    // A read failure after stat (file removed mid-request, permissions,
    // I/O error) must not take the server down either: headers are already
    // sent, so abort this response and keep serving the rest of the feed.
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
};

const waitForSignal = () => new Promise((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});

const main = async () => {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === '--help' || command === 'help' || !command) {
    console.log(usage);
    return;
  }
  const directory = requireOption(options, 'dir');
  if (command === 'stage' || command === 'run') {
    const result = stageUpdaterFixture({
      architecture: requireOption(options, 'arch'),
      nextAppImage: requireOption(options, 'next'),
      version: requireOption(options, 'version'),
      directory,
    });
    console.log(`[electron] staged ${result.manifestName} and ${path.basename(result.artifactPath)}`);
    if (command === 'stage') return;
  }
  if (command !== 'serve' && command !== 'run') throw new Error(usage);
  const { server, url } = await createFixtureServer({ directory, port: options.port || 0 });
  console.log(`[electron] updater E2E fixture listening at ${url}`);
  if (command === 'run') {
    const currentAppImage = resolveExistingFile(requireOption(options, 'current'), 'current');
    const child = spawn(currentAppImage, [], {
      env: {
        ...process.env,
        APPIMAGE: currentAppImage,
        OPENCHAMBER_E2E: '1',
        OPENCHAMBER_UPDATER_E2E_URL: url,
      },
      stdio: 'inherit',
    });
    child.once('error', (error) => console.error(`[electron] failed to launch N AppImage: ${error.message}`));
  }
  await waitForSignal();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
