const LOCKFILES = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'Cargo.lock',
  'go.sum',
  'mix.lock',
  'pubspec.lock',
  'flake.lock',
  'gradle.lockfile',
  'packages.lock.json',
  'deno.lock',
]);

const GENERATED_PATTERNS = [
  /\.min\.(js|css)$/i,
  /\.(js|css)\.map$/i,
  /\.generated\.[^/]+$/i,
  /\.gen\.[^/]+$/i,
  /(^|\/)generated\//i,
  /\.pb\.(go|ts|js)$/i,
  /_pb2(_grpc)?\.py$/i,
  /\.pb\.cc$|\.pb\.h$/i,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
];

export function isGeneratedArtifact(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  const name = filePath.split('/').pop() || '';
  if (LOCKFILES.has(name)) return true;
  return GENERATED_PATTERNS.some((pattern) => pattern.test(filePath));
}
