#!/usr/bin/env node
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

const serialize = (data) => {
  const lines = [`version: ${data.version}`, 'files:'];
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

const output = {};

const winX64 = await read('latest-yml-x86_64-pc-windows-msvc', 'latest.yml');
const winArm64 = await read('latest-yml-aarch64-pc-windows-msvc', 'latest.yml');
if (winX64 || winArm64) {
  const base = winArm64 || winX64;
  output['latest.yml'] = serialize({
    version: base.version,
    files: [...(winArm64?.files || []), ...(winX64?.files || [])],
    releaseDate: base.releaseDate,
  });
}

const linuxX64 = await read('latest-yml-x86_64-unknown-linux-gnu', 'latest-linux.yml');
if (linuxX64) output['latest-linux.yml'] = serialize(linuxX64);

const linuxArm64 = await read('latest-yml-aarch64-unknown-linux-gnu', 'latest-linux-arm64.yml');
if (linuxArm64) output['latest-linux-arm64.yml'] = serialize(linuxArm64);

const macX64 = await read('latest-yml-x86_64-apple-darwin', 'latest-mac.yml');
const macArm64 = await read('latest-yml-aarch64-apple-darwin', 'latest-mac.yml');
if (macX64 || macArm64) {
  const base = macArm64 || macX64;
  output['latest-mac.yml'] = serialize({
    version: base.version,
    files: [...(macArm64?.files || []), ...(macX64?.files || [])],
    releaseDate: base.releaseDate,
  });
}

const tag = `v${version}`;
const tmp = process.env.RUNNER_TEMP || '/tmp';
for (const [filename, content] of Object.entries(output)) {
  const outputPath = path.join(tmp, filename);
  await fs.writeFile(outputPath, content);
  console.log(`prepared ${outputPath} for upload to ${repo} release ${tag}`);
}

console.log('finalized latest yml files');
