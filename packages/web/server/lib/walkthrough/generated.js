// Files that are produced by a tool rather than written by a person. Their
// diffs are enormous, carry no intent, and are exactly the kind of content a
// reviewer scrolls past — but they are still part of the change, so they are
// never hidden: they are kept out of the model's input and shown in the
// uncovered tail instead.

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
  // Minified or bundled output committed to the repository.
  /\.min\.(js|css)$/i,
  /\.(js|css)\.map$/i,
  // Conventional "this file is generated" naming.
  /\.generated\.[^/]+$/i,
  /\.gen\.[^/]+$/i,
  /(^|\/)generated\//i,
  // Protocol buffers and similar codegen.
  /\.pb\.(go|ts|js)$/i,
  /_pb2(_grpc)?\.py$/i,
  /\.pb\.cc$|\.pb\.h$/i,
  // Test snapshots.
  /(^|\/)__snapshots__\//,
  /\.snap$/,
];

/**
 * Whether a path is a tool-produced artifact rather than authored source.
 *
 * Deliberately conservative: a false positive silently removes real code from
 * the review, which is the failure this whole feature exists to prevent. Only
 * unambiguous, conventional names qualify.
 */
export function isGeneratedArtifact(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  const name = filePath.split('/').pop() || '';
  if (LOCKFILES.has(name)) return true;
  return GENERATED_PATTERNS.some((pattern) => pattern.test(filePath));
}
