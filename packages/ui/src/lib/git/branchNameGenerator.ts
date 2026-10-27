/**
 * Branch name generator utility for auto-generating friendly branch names.
 * Uses Ubuntu-style adjective-noun word pairs for memorable, collision-resistant naming.
 */

const ADJECTIVES = [
  'artful', 'bionic', 'cosmic', 'disco', 'focal', 'groovy', 'jammy', 'kinetic',
  'lunar', 'noble', 'bold', 'brave', 'calm', 'eager', 'gentle', 'happy', 'keen',
  'lively', 'merry', 'swift', 'warm', 'wise', 'bright', 'clever', 'daring',
  'agile', 'crisp', 'fresh', 'lucid', 'quick', 'sharp', 'vivid', 'zealous',
];

const NOUNS = [
  'aardvark', 'beaver', 'chipmunk', 'dolphin', 'falcon', 'gopher', 'hedgehog',
  'jackal', 'koala', 'lemur', 'mongoose', 'narwhal', 'otter', 'pangolin',
  'quokka', 'raccoon', 'salamander', 'toucan', 'walrus', 'yak', 'zebra',
  'badger', 'condor', 'dingo', 'egret', 'ferret', 'gecko', 'heron', 'iguana',
];

/**
 * Generate a random branch slug (e.g., "cosmic-dolphin", "noble-raccoon").
 */
export function generateBranchSlug(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}-${noun}`;
}

/**
 * Generate a branch name with optional prefix.
 * @param prefix - Optional prefix like "feature", "bugfix" (no trailing slash)
 * @returns Full branch name like "feature/cosmic-dolphin" or just "cosmic-dolphin"
 */
export function generateBranchName(prefix?: string): string {
  const slug = generateBranchSlug();
  if (prefix && prefix.trim()) {
    const cleanPrefix = prefix.trim().replace(/\/+$/, '');
    return `${cleanPrefix}/${slug}`;
  }
  return slug;
}

// The dialog names an issue's or discussion's branch `issue-180-` (Linear's
// `issue-ENG-12-`) plus a pair; that prefix is the part worth keeping.
const GENERATED_NAME = new RegExp(`^((?:issue|discussion)-[^\\s/]+-)?(?:${ADJECTIVES.join('|')})-(?:${NOUNS.join('|')})(?:-[a-z0-9]{4})?$`);

/**
 * When `name` is one this generator makes (`cosmic-dolphin`, with the
 * dialog's `-x1y2` suffix when the plain pair was taken, or after an item's
 * `issue-180-`), the prefix to keep (empty for a bare pair), so the server can
 * record that nobody chose the rest and the agent may rename it after the
 * task. Null for any other name.
 */
export function generatedBranchPrefix(name: string): string | null {
  const match = GENERATED_NAME.exec(name.trim());
  return match ? match[1] ?? '' : null;
}
