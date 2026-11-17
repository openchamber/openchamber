
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

export function generateBranchSlug(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}-${noun}`;
}

export function generateBranchName(prefix?: string): string {
  const slug = generateBranchSlug();
  if (prefix && prefix.trim()) {
    const cleanPrefix = prefix.trim().replace(/\/+$/, '');
    return `${cleanPrefix}/${slug}`;
  }
  return slug;
}

const GENERATED_NAME = new RegExp(`^((?:issue|discussion)-[^\\s/]+-)?(?:${ADJECTIVES.join('|')})-(?:${NOUNS.join('|')})(?:-[a-z0-9]{4})?$`);

export function generatedBranchPrefix(name: string): string | null {
  const match = GENERATED_NAME.exec(name.trim());
  return match ? match[1] ?? '' : null;
}
