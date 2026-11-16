#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = process.env.LATEST_YML_DIR;
const repo = process.env.GH_REPO;
const version = process.env.OPENCHAMBER_VERSION;

if (!dir) throw new Error('LATEST_YML_DIR is required');
if (!repo) throw new Error('GH_REPO is required');
if (!version) throw new Error('OPENCHAMBER_VERSION is required');

const parse = (content) => {
  const lines = content.split('\n');
  let releaseDate = '';
  let parsedVersion = '';
  const files = [];
  let current;

  const flush = () => {
    if (current?.url && current?.sha512 && current?.size) {
      files.push(current);
    }
    current = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const indented = line.startsWith('    ') || line.startsWith('  -');
    if (line.startsWith('version:')) {
      parsedVersion = line.slice('version:'.length).trim();
    } else if (line.startsWith('releaseDate:')) {
      releaseDate = line.slice('releaseDate:'.length).trim().replace(/^'|'$/g, '');
    } else if (trimmed.startsWith('- url:')) {
      flush();
      current = { url: trimmed.slice('- url:'.length).trim() };
    } else if (indented && current && trimmed.startsWith('sha512:')) {
      current.sha512 = trimmed.slice('sha512:'.length).trim();
    } else if (indented && current && trimmed.startsWith('size:')) {
      current.size = Number(trimmed.slice('size:'.length).trim());
    } else if (indented && current && trimmed.startsWith('blockMapSize:')) {
      current.blockMapSize = Number(trimmed.slice('blockMapSize:'.length).trim());
    } else if (!indented && current) {
      flush();
    }
  }

  flush();
  return { version: parsedVersion, releaseDate, files };
};

// external: https://www.electron.build/auto-update.html#updateinfo minimumSystemVersion uses the Darwin kernel release, so Darwin 22 keeps unsupported Macs from updating to Electron 45.
const MAC_MINIMUM_DARWIN_VERSION = '22.0.0';

const serialize = (data) => {
  const lines = [`version: ${data.version}`];
  if (data.minimumSystemVersion) {
    lines.push(`minimumSystemVersion: ${data.minimumSystemVersion}`);
  }
  lines.push('files:');
  for (const file of data.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
    if (file.blockMapSize) {
      lines.push(`    blockMapSize: ${file.blockMapSize}`);
    }
  }
  lines.push(`releaseDate: '${data.releaseDate}'`);
  return `${lines.join('\n')}\n`;
};

const read = async (subdir, filename) => {
  const filePath = path.join(dir, subdir, filename);
  try {
    return parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const manifestFromReleaseAsset = async (assets, name, token) => {
  const asset = assets.find((entry) => entry.name === name);
  if (!asset) throw new Error(`Release asset ${name} is missing, so its update manifest cannot be built`);
  const response = await fetch(asset.url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
  });
  if (!response.ok) throw new Error(`Failed to download ${name}: ${response.status} ${await response.text()}`);
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  if (size !== asset.size) throw new Error(`Downloaded ${size} bytes of ${name}, the release lists ${asset.size}`);
  return { version, releaseDate: asset.updated_at, files: [{ url: name, sha512: hash.digest('base64'), size }] };
};

const output = {};

const windowsFromRelease = process.env.WINDOWS_FROM_RELEASE === '1';

if (windowsFromRelease) {
  const releaseId = process.env.RELEASE_ID;
  const token = process.env.GITHUB_TOKEN;
  if (!releaseId || !token) throw new Error('RELEASE_ID and GITHUB_TOKEN are required to read the Windows installers');
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/${releaseId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`Failed to read release ${releaseId}: ${response.status} ${await response.text()}`);
  const { assets } = await response.json();
  output['latest.yml'] = serialize(await manifestFromReleaseAsset(assets, `OpenChamber-${version}-win-x64.exe`, token));
  output['latest-arm64.yml'] = serialize(await manifestFromReleaseAsset(assets, `OpenChamber-${version}-win-arm64.exe`, token));
} else {
  const winX64 = await read('latest-yml-x86_64-pc-windows-msvc', 'latest.yml');
  const winArm64 = await read('latest-yml-aarch64-pc-windows-msvc', 'latest.yml');
  if (!winX64 || !winArm64) {
    throw new Error('Both x64 and arm64 Windows update manifests are required');
  }
  output['latest.yml'] = serialize(winX64);
  output['latest-arm64.yml'] = serialize(winArm64);
}

const macX64 = await read('latest-yml-x86_64-apple-darwin', 'latest-mac.yml');
const macArm64 = await read('latest-yml-aarch64-apple-darwin', 'latest-mac.yml');
if (!macX64 || !macArm64) {
  throw new Error('Both x64 and arm64 macOS update manifests are required');
}
output['latest-mac.yml'] = serialize({
  version: macArm64.version,
  minimumSystemVersion: MAC_MINIMUM_DARWIN_VERSION,
  files: [...macArm64.files, ...macX64.files],
  releaseDate: macArm64.releaseDate,
});

const tag = `v${version}`;
const tmp = process.env.RUNNER_TEMP || '/tmp';
for (const [filename, content] of Object.entries(output)) {
  const outputPath = path.join(tmp, filename);
  await fs.writeFile(outputPath, content);
  console.log(`prepared ${outputPath} for upload to ${repo} release ${tag}`);
}

console.log('finalized latest yml files');
